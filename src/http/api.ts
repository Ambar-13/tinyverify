/**
 * The REST routes and the two webhook receivers. app.ts mounts them.
 *
 * A caller with no key can run lookups, under an hourly limit for their address. Watches need a key.
 */

import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../env';
import { bucketFor, canStart, limitedRun, type Bucket, type RefusalCause } from '../queue/budget';
import { health as canaryHealth } from '../watch/canary';
import { refine, startCheck, watchTargetFor } from '../lookup/check';
import { registries, type RegistryInfo } from '../registries/catalog';
import {
  clientForRun,
  dispatch,
  enqueue as enqueueJob,
  onRunFinished,
  OWN_MAX_IN_FLIGHT,
  ownInFlight,
  pollOwnRuns,
  QueueFull,
} from '../queue/queue';
import { OWN_KEY_HEADER, canHoldOwnKeys, holdOwnKey, ownClient, readOwnKey } from '../queue/own-key';
import {
  getCheck,
  getSnapshot,
  listAdminWatches,
  getWatch,
  insertRawWebhook,
  lastEventAt,
  listEvents,
  setWatchOwner,
  spentToday,
  type WatchRow,
} from '../store';
import {
  countWatches,
  createRecordWatch,
  deleteWatch,
  effectiveTier,
  InvalidInput,
  InvalidWebhook,
  MONITOR_CEILING,
  onMonitorWebhook,
  WatchLimit,
} from '../watch/watch';
import { parseVerifyRequest, type RegistryId, type VerifyInput } from '../types';
import { tryGetAdapter } from '../registries/index';
import { TinyFishError, type RunResult, type TinyFish } from '../tinyfish/client';
import { clientFor, tinyfishState } from '../tinyfish/service-client';
import { parseKey, scopeFor, watchVisibleTo, type Scope } from './auth';
import { dispatchSoon, later } from './background';
import { countedLookup, limitMessage } from './limits';

const VERSION = '0.1.0';
const HOUR_MS = 3_600_000;
const RECHECK_WINDOW_MS = 20 * HOUR_MS;
const CHECK_NOW_GAP_MS = HOUR_MS;
/** How many of its latest events each demo watch shows. */
const PUBLIC_EVENTS = 20;

type Ctx = Context<{ Bindings: Env }>;
type App = Hono<{ Bindings: Env }>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bucketOf(c: Ctx): Bucket {
  return bucketFor(parseKey(c.req.raw.headers), c.env);
}

/**
 * Null when the caller may continue. Otherwise the refusal response.
 * Protected routes need any key.
 */
function refuse(c: Ctx, bucket: Bucket): Response | null {
  if (bucket === 'public') return failure(c, 401, 'unauthorised', 'Send an API key in the Authorization header');
  return null;
}

function failure(c: Ctx, status: ContentfulStatusCode, code: string, message: string): Response {
  return c.json({ error: { code, message } }, status);
}

function upstream(c: Ctx): Response {
  return failure(c, 502, 'tinyfish_unavailable', 'TinyFish did not answer. Try again shortly.');
}

async function jsonBody(c: Ctx): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await c.req.json();
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function infoFor(id: unknown): RegistryInfo | null {
  if (typeof id !== 'string') return null;
  return registries.find((r) => r.id === id) ?? null;
}

async function scopeOf(c: Ctx): Promise<Scope> {
  return scopeFor(parseKey(c.req.raw.headers), c.env);
}

/**
 * The queue job that serves a check: its streaming URL (when the payload has one) and, while it is
 * pending, its place in line.
 */
async function queueInfo(
  db: D1Database,
  check_id: string,
): Promise<{ streaming_url?: string; queue_position?: number }> {
  const job = await db
    .prepare(
      "SELECT state, priority, rowid AS rid, payload_json FROM queue WHERE json_extract(payload_json, '$.check_id') = ? ORDER BY rowid DESC LIMIT 1",
    )
    .bind(check_id)
    .first<{ state: string; priority: number; rid: number; payload_json: string | null }>();
  if (job === null) return {};
  const payload = JSON.parse(job.payload_json ?? 'null') as { streaming_url?: unknown } | null;
  const out: { streaming_url?: string; queue_position?: number } = {};
  if (typeof payload?.streaming_url === 'string') out.streaming_url = payload.streaming_url;
  if (job.state === 'pending') {
    // Same count as queue.enqueue: pending jobs of equal or higher priority that were queued first, plus one.
    const ahead = await db
      .prepare("SELECT COUNT(*) AS n FROM queue WHERE state = 'pending' AND priority <= ? AND rowid < ?")
      .bind(job.priority, job.rid)
      .first<{ n: number }>();
    out.queue_position = (ahead?.n ?? 0) + 1;
  }
  return out;
}

/** Last accepted monitor check-now per watch, in ms. Per isolate, like the lookup counts. */
const lastCheckNow = new Map<string, number>();

// Verify

/** What each refusal cause says to a caller who asked for a check now. */
const REFUSAL_MESSAGES: Record<RefusalCause, string> = {
  daily: 'The daily budget for this key is spent. It resets at midnight UTC.',
  ceiling: 'The lifetime spending ceiling is reached.',
  wallet_floor: 'The provider wallet is below its floor.',
  wallet_unreadable: 'The service could not confirm it can pay for this check. Try again in a minute.',
  bad_limit: 'A spending limit is not set correctly.',
};

/** True when TinyFish takes the key. Any other failure of the call is not the key's fault and is thrown on. */
async function acceptsKey(client: TinyFish): Promise<boolean> {
  try {
    await client.wallet();
    return true;
  } catch (err) {
    if (err instanceof TinyFishError && err.code === 'unauthorised') return false;
    throw err;
  }
}

function statusFor(state: string): 200 | 202 {
  return state === 'done' ? 200 : 202;
}

export function mountApi(app: App): void {
  app.get('/health', (c) => c.json({ ok: true, version: VERSION }));

  app.post('/verify', async (c) => {
    // A visitor's own TinyFish key runs the lookup on their account, outside the budget and the hourly limit.
    const ownKey = readOwnKey(c.req.raw.headers);
    if (ownKey === 'invalid') return failure(c, 400, 'invalid_input', `${OWN_KEY_HEADER} is not a TinyFish key`);
    if (ownKey !== null && !canHoldOwnKeys(c.env)) {
      return failure(
        c,
        503,
        'own_key_unavailable',
        'This service is not set up to take your own TinyFish key. Leave the key out.',
      );
    }
    const bucket = ownKey === null ? bucketOf(c) : 'own';
    const body = await jsonBody(c);
    if (body === null) return failure(c, 400, 'invalid_input', 'The request body must be a JSON object');

    const { check_id, candidate_id, ...rest } = body;
    if (check_id !== undefined && candidate_id === undefined) {
      return failure(c, 400, 'invalid_input', 'A refinement needs candidate_id as well as check_id');
    }
    if (check_id === undefined && candidate_id !== undefined) {
      return failure(c, 400, 'invalid_input', 'candidate_id needs the check_id it came from');
    }
    if (check_id !== undefined && (typeof check_id !== 'string' || typeof candidate_id !== 'string')) {
      return failure(c, 400, 'invalid_input', 'check_id and candidate_id must be text');
    }

    // A lookup is parsed before it counts against the visitor, so a malformed body costs nothing.
    let plan: { refine: { check_id: string; candidate_id: string } } | { input: VerifyInput };
    if (typeof check_id === 'string' && typeof candidate_id === 'string') {
      plan = { refine: { check_id, candidate_id } };
    } else {
      const parsed = parseVerifyRequest(rest);
      if (!parsed.ok) return failure(c, 400, 'invalid_input', parsed.message);
      plan = { input: parsed.input };
    }

    const client = ownKey === null ? clientFor(c.env) : ownClient(ownKey);
    try {
      if (ownKey !== null && (await ownInFlight(c.env.DB)) >= OWN_MAX_IN_FLIGHT) {
        const retry = new Date(Date.now() + 60_000).toISOString();
        return c.json(
          {
            error: {
              code: 'rate_limited',
              message: "Too many lookups on visitors' own keys are under way. Try again in a minute.",
            },
            resets_at: retry,
          },
          429,
        );
      }
      // The key is tried on a call that costs nothing, so a wrong key is refused before any lookup starts.
      if (ownKey !== null && !(await acceptsKey(client))) {
        return failure(c, 400, 'tinyfish_key_refused', 'TinyFish did not accept this key. Check it and try again.');
      }
      const counted = await countedLookup(c, bucket, () =>
        'refine' in plan
          ? refine(c.env, c.env.DB, client, plan.refine.check_id, plan.refine.candidate_id, bucket)
          : startCheck(c.env, c.env.DB, client, plan.input, bucket),
      );
      if ('limit' in counted) {
        return c.json(
          { error: { code: 'rate_limited', message: limitMessage(counted.limit) }, resets_at: counted.resets_at },
          429,
        );
      }
      const verifyResult = counted.result;
      // Held only while the lookup is still running; a lookup answered at once never stores the key.
      if (ownKey !== null && verifyResult.state !== 'done')
        await holdOwnKey(c.env, c.env.DB, verifyResult.check_id, ownKey);
      await dispatchSoon(c, c.env, clientFor(c.env), verifyResult);
      // A check that was refused for its input is the caller's mistake: 400, with the result as the body.
      return c.json(verifyResult, verifyResult.outcome === 'invalid_input' ? 400 : statusFor(verifyResult.state));
    } catch (err) {
      if (err instanceof TinyFishError) return upstream(c);
      throw err;
    }
  });

  app.get('/verify/:id', async (c) => {
    const row = await getCheck(c.env.DB, c.req.param('id'));
    if (row === null) return failure(c, 404, 'not_found', 'No check has that id');
    if (row.state === 'done' && row.result_json !== null) return c.json(JSON.parse(row.result_json) as unknown, 200);
    // A run on a visitor's key sends no webhook, so asking about the check is what looks for its end.
    await later(c, () => pollOwnRuns(c.env, c.env.DB, clientFor(c.env), row.check_id).then(() => undefined));
    // In progress: add the streaming URL and the queue position when the job has them.
    const info = await queueInfo(c.env.DB, row.check_id);
    const stored =
      row.result_json === null ? { check_id: row.check_id, state: row.state } : (JSON.parse(row.result_json) as object);
    return c.json({ ...stored, ...info }, 202);
  });

  // Watches

  app.post('/watch', async (c) => {
    const scope = await scopeOf(c);
    const denied = refuse(c, scope.bucket);
    if (denied) return denied;
    const body = await jsonBody(c);
    if (body === null) return failure(c, 400, 'invalid_input', 'The request body must be a JSON object');

    // A registry is named by id, or found from record_type and jurisdiction the way POST /verify routes a lookup.
    let registryInfo: RegistryInfo | null;
    if (body.registry === undefined && body.record_type !== undefined && body.jurisdiction !== undefined) {
      const target = watchTargetFor(body.record_type, body.jurisdiction);
      if (!target.ok) return failure(c, 400, target.code, target.message);
      registryInfo = target.registry;
    } else {
      registryInfo = infoFor(body.registry);
      if (registryInfo === null)
        return failure(c, 400, 'invalid_input', 'Name a registry this service knows, for example fl-mqa');
      if (!registryInfo.connected) return failure(c, 400, 'unsupported', 'This registry is not connected yet');
    }
    const registry = registryInfo.id;
    const caller = optionalText(body.caller_webhook);
    if (caller === undefined) return failure(c, 400, 'invalid_input', 'caller_webhook must be text when sent');
    const licence = optionalText(body.licence_number);
    if (optionalText(body.name) === undefined || licence === undefined) {
      return failure(c, 400, 'invalid_input', 'name and licence_number must be text when sent');
    }

    // No kind and a licence number: a record watch, as a lookup by licence number reads a record.
    const kind = body.kind === undefined && licence !== null ? 'record' : body.kind;
    const client = clientFor(c.env);
    try {
      if (kind === 'record') {
        if (licence === null) return failure(c, 400, 'invalid_input', 'A record watch needs a licence_number');
        const made = await createRecordWatch(c.env, c.env.DB, client, registry, licence, caller ?? undefined);
        if (scope.owner !== null) await setWatchOwner(c.env.DB, made.watch_id, scope.owner);
        return c.json(made, 201);
      }
      return failure(c, 400, 'invalid_input', 'kind must be "record"');
    } catch (err) {
      return await watchError(c, err);
    }
  });

  // The demo watches: every live watch the admin key made, with its latest events. No key is needed, so
  // anyone can see a watch at work. It carries no caller webhook, owner, monitor id or typed name.
  app.get('/watches/public', async (c) => {
    const watches = await listAdminWatches(c.env.DB, PUBLIC_EVENTS);
    return c.json({
      watches: watches.map(({ watch, events }) => ({
        watch_id: watch.watch_id,
        registry: watch.registry,
        licence_number: watch.licence_number,
        tier: effectiveTier(watch),
        created_at: watch.created_at,
        last_event_at: events[0]?.created_at ?? null,
        events: events.map((e) => ({
          event_id: e.event_id,
          kind: e.kind,
          created_at: e.created_at,
          before: e.before,
          after: e.after,
          evidence: e.evidence,
        })),
      })),
    });
  });

  app.get('/watch/:id', async (c) => {
    const scope = await scopeOf(c);
    const denied = refuse(c, scope.bucket);
    if (denied) return denied;
    const watch = await visibleWatch(c, scope);
    if (watch === null) return failure(c, 404, 'not_found', 'No watch has that id');
    return c.json({
      watch_id: watch.watch_id,
      kind: watch.kind,
      registry: watch.registry,
      licence_number: watch.licence_number,
      name: watch.name,
      created_at: watch.created_at,
      tier: (watch as WatchRow & { tier?: string | null }).tier ?? null,
      // The time of the latest event. A Monitor run or an agent re-check leaves one each time (unchanged when
      // nothing moved), except the first read, which only sets the baseline. A weekly complaint run leaves one
      // only when the complaints changed, the run failed or it has a note, so after a quiet week this is older.
      last_run_at: await lastEventAt(c.env.DB, watch.watch_id),
      fields: watch.last_fields_json === null ? null : (JSON.parse(watch.last_fields_json) as unknown),
    });
  });

  app.get('/watch/:id/events', async (c) => {
    const scope = await scopeOf(c);
    const denied = refuse(c, scope.bucket);
    if (denied) return denied;
    const watch = await visibleWatch(c, scope);
    if (watch === null) return failure(c, 404, 'not_found', 'No watch has that id');
    return c.json({ events: await listEvents(c.env.DB, watch.watch_id) });
  });

  app.delete('/watch/:id', async (c) => {
    const scope = await scopeOf(c);
    const denied = refuse(c, scope.bucket);
    if (denied) return denied;
    const watch = await visibleWatch(c, scope);
    if (watch === null) return failure(c, 404, 'not_found', 'No watch has that id');
    try {
      await deleteWatch(c.env.DB, clientFor(c.env), watch.watch_id);
    } catch (err) {
      if (err instanceof TinyFishError) return upstream(c);
      throw err;
    }
    return c.json({ ok: true });
  });

  app.post('/watch/:id/check-now', async (c) => {
    const scope = await scopeOf(c);
    const denied = refuse(c, scope.bucket);
    if (denied) return denied;
    const watch = await visibleWatch(c, scope);
    if (watch === null) return failure(c, 404, 'not_found', 'No watch has that id');
    if (watch.kind !== 'record') return failure(c, 400, 'invalid_input', 'Only record watches can be checked now');
    const registryInfo = infoFor(watch.registry);
    if (registryInfo === null) return failure(c, 409, 'no_route', 'This watch has no registry route to check');

    const client = clientFor(c.env);
    if (registryInfo.watch_tier === 'monitor') {
      if (watch.monitor_id === null) {
        return failure(c, 409, 'not_ready', 'The record link for this watch is still being found');
      }
      const last = lastCheckNow.get(watch.watch_id);
      const now = Date.now();
      if (last !== undefined && now - last < CHECK_NOW_GAP_MS) {
        return c.json(
          {
            error: {
              code: 'rate_limited',
              message: 'This watch was checked in the last hour. Try again after the reset time.',
            },
            resets_at: new Date(last + CHECK_NOW_GAP_MS).toISOString(),
          },
          429,
        );
      }
      const budget = await canStart(c.env, c.env.DB, client, scope.bucket, 1);
      if (!budget.ok && budget.cause === 'wallet_unreadable') {
        return c.json(
          {
            error: { code: 'wallet_unreadable', message: REFUSAL_MESSAGES.wallet_unreadable },
            resets_at: budget.resets_at,
          },
          503,
        );
      }
      if (!budget.ok) {
        return c.json(
          { error: { code: 'budget', message: REFUSAL_MESSAGES[budget.cause] }, resets_at: budget.resets_at },
          429,
        );
      }
      // Recorded before the run, so a second press cannot start a second run while the first is out.
      lastCheckNow.set(watch.watch_id, now);
      try {
        const run = await client.runMonitorNow(watch.monitor_id);
        const outcome = await onMonitorWebhook(c.env, c.env.DB, client, {
          fetch_monitor_id: watch.monitor_id,
          id: run.id,
          results: run.results,
          errors: run.errors,
        });
        // A run the webhook recorded first is recorded. 'ignored' made no comparison, and 'failed' compared nothing:
        // the page could not be read. Neither may be reported as a watch that was checked.
        if (outcome === 'duplicate') return c.json({ ok: true, outcome: 'already_recorded' });
        if (outcome === 'failed') {
          return failure(c, 502, 'not_checked', 'The registry page could not be read. The failed check was recorded.');
        }
        if (outcome === 'ignored') {
          return failure(
            c,
            502,
            'not_checked',
            'The check ran but its result could not be read. Nothing was recorded.',
          );
        }
        return c.json({ ok: true, outcome });
      } catch (err) {
        if (err instanceof TinyFishError && err.code === 'not_found') {
          return failure(c, 409, 'no_monitor', 'The monitor for this watch no longer exists');
        }
        if (err instanceof TinyFishError) return upstream(c);
        throw err;
      }
    }

    return queueRecheck(c, watch, registryInfo.id, scope.bucket);
  });

  // Registries, status, admin

  app.get('/registries', async (c) => {
    const health = await canaryHealth(c.env.DB);
    // Only registries with an adapter are listed. The table keeps the others, flagged not connected.
    return c.json({
      registries: registries
        .filter((r) => r.connected)
        .map((r) => ({
          id: r.id,
          name: r.name,
          jurisdiction: r.jurisdiction,
          types: r.types,
          url: r.url,
          read_route: r.read_route,
          watch_tier: r.watch_tier,
          health: health[r.id],
        })),
    });
  });

  app.get('/status', async (c) => {
    const now = new Date();
    const health = await canaryHealth(c.env.DB);
    return c.json({
      registries: registries.map((r) => ({ id: r.id, health: r.connected ? health[r.id] : 'not_connected' })),
      tinyfish: tinyfishState(),
      budget: {
        public: await budgetState(c.env, 'public', now),
        judge: await budgetState(c.env, 'judge', now),
        ops: await budgetState(c.env, 'ops', now),
      },
    });
  });

  // Evidence

  app.get('/evidence/:id', async (c) => {
    const snap = await getSnapshot(c.env.DB, c.req.param('id'));
    if (snap === null) return failure(c, 404, 'not_found', 'No evidence has that id');
    return c.json({
      snapshot_id: snap.snapshot_id,
      registry: snap.registry,
      url: snap.url,
      reader_input: snap.reader_input,
      content_sha256: snap.content_sha256,
      created_at: snap.created_at,
      body: snap.body,
    });
  });

  app.get('/evidence/:id/screenshot', async (c) => {
    const snap = await getSnapshot(c.env.DB, c.req.param('id'));
    if (snap === null || snap.run_id === null || snap.step_id === null) {
      return failure(c, 404, 'not_found', 'No screenshot is held for this evidence');
    }
    try {
      return await clientFor(c.env).stepScreenshot(snap.run_id, snap.step_id);
    } catch (err) {
      if (err instanceof TinyFishError) return upstream(c);
      throw err;
    }
  });

  // Hooks. Both answer 200 quickly. Processing failures are logged, never sent back.

  app.post('/hooks/tinyfish/monitor/:secret', async (c) => {
    const stored = await receiveWebhook(c, 'monitor');
    if (typeof stored !== 'string') return stored;
    await later(c, async () => {
      const body = parseStored(stored);
      if (body === undefined) {
        console.warn('Monitor webhook ignored: the body is not JSON');
        return;
      }
      try {
        // onMonitorWebhook dedupes by run id.
        await onMonitorWebhook(c.env, c.env.DB, clientFor(c.env), body);
      } catch (err) {
        console.error('monitor webhook not processed', err);
      }
    });
    return c.json({ ok: true }, 200);
  });

  app.post('/hooks/tinyfish/run/:secret', async (c) => {
    const stored = await receiveWebhook(c, 'run');
    if (typeof stored !== 'string') return stored;
    await later(c, async () => {
      const body = parseStored(stored);
      if (body === undefined) {
        console.warn('Run webhook ignored: the body is not JSON');
        return;
      }
      try {
        const runId = runIdFromWebhook(body);
        if (runId === null) {
          console.warn('Run webhook ignored: the body has no run id');
          return;
        }
        const client = await clientForRun(c.env, c.env.DB, clientFor(c.env), runId);
        // The body is a wake-up. The run is read from TinyFish, and if that fails the sweep settles it.
        let run: RunResult;
        try {
          run = await client.getRun(runId);
        } catch (err) {
          console.warn(
            `Run webhook left to the sweep: GET run failed (${err instanceof TinyFishError ? err.code : 'error'})`,
          );
          return;
        }
        if (!TERMINAL_RUN_STATUSES.has(run.status)) {
          // The notice can beat the run record. One more read after 2 seconds, never a loop; if the run still is not
          // finished, or the read fails, the sweep settles it.
          await new Promise((r) => setTimeout(r, 2000));
          try {
            run = await client.getRun(runId);
          } catch (err) {
            console.warn(
              `Run webhook left to the sweep: second GET run failed (${err instanceof TinyFishError ? err.code : 'error'})`,
            );
            return;
          }
          if (!TERMINAL_RUN_STATUSES.has(run.status)) return;
        }
        try {
          await onRunFinished(c.env, c.env.DB, clientFor(c.env), { ...run, run_id: runId });
        } finally {
          // A run that ended frees a slot, whether or not its processing succeeded.
          await dispatch(c.env, c.env.DB, clientFor(c.env)).catch((err: unknown) =>
            console.error('dispatch after run webhook failed', err),
          );
        }
      } catch (err) {
        console.error('run webhook not processed', err);
      }
    });
    return c.json({ ok: true }, 200);
  });
}

/**
 * The stored webhook body as JSON, or undefined when it is not JSON. The parse error is dropped: its message
 * can quote part of the body, and a body is never written to the log.
 */
function parseStored(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Stores the raw body, after checking the secret. Returns the body text or the 404 response. */
async function receiveWebhook(c: Ctx, source: 'monitor' | 'run'): Promise<string | Response> {
  const expected = c.env.HOOK_SECRET;
  const given = c.req.param('secret') ?? '';
  // An empty configured secret fails closed.
  if (!expected || !(await secretMatches(given, expected))) {
    return failure(c, 404, 'not_found', 'Not found');
  }
  const body = await c.req.text();
  await insertRawWebhook(c.env.DB, source, body);
  return body;
}

async function secretMatches(given: string, expected: string): Promise<boolean> {
  const left = new TextEncoder().encode(given);
  const right = new TextEncoder().encode(expected);
  if (left.byteLength !== right.byteLength) return false;
  return crypto.subtle.timingSafeEqual(left, right);
}

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

/**
 * The run id of a run webhook, from data.run_id or run_id at the top. Nothing else in the body is used:
 * its status, result and steps are not trusted, and GET run is the record. Null when there is no id.
 */
export function runIdFromWebhook(body: unknown): string | null {
  if (!isObject(body)) return null;
  const data = isObject(body.data) ? body.data : body;
  return typeof data.run_id === 'string' && data.run_id !== '' ? data.run_id : null;
}

/** Text fields may be left out. A present value must be text, or the result is undefined. */
function optionalText(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

/**
 * A watch the caller may see: live, and owned by the caller, or NULL or 'ops' (admin only). Admin sees every live
 * watch. Anything else is reported as not found, so ids do not leak.
 */
async function visibleWatch(c: Ctx, scope: Scope): Promise<WatchRow | null> {
  const watch = await liveWatch(c);
  if (watch === null) return null;
  return watchVisibleTo(watch, scope) ? watch : null;
}

async function liveWatch(c: Ctx): Promise<WatchRow | null> {
  const watch = await getWatch(c.env.DB, c.req.param('id') ?? '');
  return watch === null || watch.deleted_at !== null ? null : watch;
}

async function watchError(c: Ctx, err: unknown): Promise<Response> {
  if (err instanceof InvalidInput || err instanceof InvalidWebhook) {
    return failure(c, 400, 'invalid_input', err.message);
  }
  if (err instanceof WatchLimit) {
    const count = await countWatches(c.env.DB);
    return c.json({ error: { code: 'watch_limit', message: err.message }, count, limit: MONITOR_CEILING }, 409);
  }
  if (err instanceof QueueFull) {
    return failure(c, 503, 'queue_full', 'The run queue is full. Try again shortly.');
  }
  throw err;
}

/**
 * Queues one re-check for a recheck-tier watch. The cost guard matches the daily cron:
 * a watch with a re-check queued in the last 20 hours is not queued again. The run is held against the budget of
 * the key that asked, so a key holder cannot use up the budget the daily re-checks and the canaries run on.
 */
async function queueRecheck(c: Ctx, watch: WatchRow, registry: RegistryId, bucket: Bucket): Promise<Response> {
  const adapter = tryGetAdapter(registry);
  const record = adapter?.record;
  if (!adapter || record?.kind !== 'agent' || watch.licence_number === null) {
    return failure(c, 409, 'no_route', 'This watch has no agent route to re-check');
  }

  const since = new Date(Date.now() - RECHECK_WINDOW_MS).toISOString();
  const recent = await c.env.DB.prepare("SELECT payload_json FROM queue WHERE kind = 'recheck' AND created_at >= ?")
    .bind(since)
    .all<{ payload_json: string | null }>();
  const queuedAlready = recent.results.some((row) => {
    const payload = JSON.parse(row.payload_json ?? 'null') as { watch_id?: unknown } | null;
    return payload?.watch_id === watch.watch_id;
  });
  if (queuedAlready) {
    return c.json(
      { queued: false, reason: 'checked_recently', message: 'This watch was re-checked in the last 20 hours' },
      202,
    );
  }

  try {
    const limited = limitedRun(
      {
        url: record.start_url,
        goal: record.goal(watch.licence_number),
        output_schema: record.output_schema,
        capture_config: { html: true, screenshots: true },
      },
      record.max_steps,
      c.env.AGENT_STEP_CAP,
    );
    const { job_id, position } = await enqueueJob(c.env.DB, {
      kind: 'recheck',
      priority: 3,
      bucket,
      reserved_cents: limited.reserved_cents,
      payload: { watch_id: watch.watch_id, registry, request: limited.request },
    });
    return c.json({ queued: true, job_id, position }, 202);
  } catch (err) {
    if (err instanceof QueueFull) return failure(c, 503, 'queue_full', 'The run queue is full. Try again shortly.');
    throw err;
  }
}

/** A bucket is 'ok' until today's spend passes 80 percent of its daily limit. An unreadable limit is 'low'. */
async function budgetState(env: Env, bucket: Bucket, now: Date): Promise<'ok' | 'low'> {
  const text =
    bucket === 'ops' ? env.OPS_DAILY_CENTS : bucket === 'judge' ? env.JUDGE_DAILY_CENTS : env.PUBLIC_DAILY_CENTS;
  // Env values are set at deploy time, so a missing one reaches here as undefined.
  if (typeof text !== 'string' || !/^\d+$/.test(text)) return 'low';
  const limit = Number(text);
  const spent = await spentToday(env.DB, now.toISOString().slice(0, 10), bucket);
  return limit <= 0 || spent > limit * 0.8 ? 'low' : 'ok';
}
