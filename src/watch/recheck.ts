/**
 * Scheduled re-reads of watched records: an agent run where a record has no stable link, a free fetch where its
 * Monitor has failed, and the queueing of both, with the weekly complaint runs, from the daily cron tick.
 */

import type { Env } from '../env';
import { tryGetAdapter } from '../registries/index';
import { lastCapture, readLatestHtml, TinyFish, type RunResult } from '../tinyfish/client';
import { limitedRun } from '../queue/budget';
import { enqueueBatch, registerContinuation, type PlannedJob } from '../queue/queue';
import { normaliseLicenceNumber } from '../registries/catalog';
import {
  getKey,
  getKeys,
  getWatch,
  insertEventStatement,
  listWatchesStatement,
  setLastComplaintsAtStatement,
  setLastRecheckAtStatement,
  type WatchRow,
} from '../store';
import type { RegistryId } from '../types';
import {
  adapterFor,
  isRun,
  failNote,
  effectiveTier,
  evidence,
  readersFor,
  judge,
  pageUrl,
  publish,
  recordOutcome,
  failCheck,
  failById,
} from './outcome';
import { complaintsJob, hasComplaintRun } from './complaints';

/** Re-checks are queued once a day even when the cron calls enqueueRechecks more than once. */
const RECENT_WINDOW_MS = 20 * 3_600_000;

/** Re-checks (agent runs and free re-reads) started by one call of enqueueRechecks. */
const RECHECKS_PER_RUN = 10;

export async function onRecheckRun(
  env: Env,
  db: D1Database,
  client: TinyFish,
  watch_id: string,
  run: RunResult,
): Promise<void> {
  const watch = await getWatch(db, watch_id);
  if (!watch || watch.deleted_at !== null || watch.licence_number === null) return;
  const now = new Date();
  if (run.status !== 'COMPLETED') {
    await failCheck(env, db, watch, failNote(`the run ended ${run.status}`), now);
    return;
  }
  const adapter = adapterFor(watch.registry);
  // A run with no step marked as having a page is told apart from one whose pages could not be read.
  if (!lastCapture(run.steps, 'html')) {
    await failCheck(env, db, watch, failNote('the run captured no page'), now);
    return;
  }
  const step = await readLatestHtml(client, run.run_id, run.steps);
  if (!step) {
    console.warn(`Re-check page not captured for watch ${watch_id}`);
    await failCheck(env, db, watch, 'capture unavailable', now);
    return;
  }
  const html = step.html;
  const verdict = judge([...readersFor(adapter, html), adapter.fieldsFromAgent(run.result)], watch.licence_number);
  const events = await recordOutcome(
    db,
    watch,
    verdict,
    {
      watch_id,
      registry: watch.registry as RegistryId,
      url: await pageUrl(db, adapter, watch),
      reader_input: 'agent_html',
      body: html,
      run_id: run.run_id,
      step_id: step.step_id,
    },
    now,
  );
  await publish(events, watch.caller_webhook);
}

/** The free daily re-read of a link registry: fetch the record page, read it, compare. */
export async function recheckFetch(env: Env, db: D1Database, client: TinyFish, watch: WatchRow): Promise<void> {
  const now = new Date();
  if (watch.licence_number === null) return;
  const adapter = adapterFor(watch.registry);
  if (adapter.record.kind !== 'link') {
    await failCheck(env, db, watch, failNote('no record link to re-read'), now);
    return;
  }
  const key = await getKey(db, adapter.id, watch.licence_number);
  if (!key?.link_json) {
    await failCheck(env, db, watch, failNote('no record link is stored'), now);
    return;
  }
  const url = adapter.record.url(JSON.parse(key.link_json) as Record<string, string>);
  const fetched = await client.fetchPages([url], { format: 'html', ttl: 0 });
  const html = fetched.results[0]?.text;
  if (typeof html !== 'string') {
    await failCheck(env, db, watch, failNote('the record page could not be fetched'), now);
    return;
  }
  const verdict = judge(readersFor(adapter, html), watch.licence_number);
  const events = await recordOutcome(
    db,
    watch,
    verdict,
    {
      watch_id: watch.watch_id,
      registry: watch.registry as RegistryId,
      url,
      reader_input: 'fetch_html',
      body: html,
      run_id: null,
      step_id: null,
    },
    now,
  );
  await publish(events, watch.caller_webhook);
}

/** Values of one payload field (watch_id or registry) in the rows of a queue read. */
function payloadValues(rows: { payload_json: string | null }[], field: 'watch_id' | 'registry'): Set<string> {
  const values = new Set<string>();
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json ?? 'null') as Record<string, unknown> | null;
    const value = payload?.[field];
    if (typeof value === 'string') values.add(value);
  }
  return values;
}

/** Never-checked first (null), then the oldest stamp first. */
function stampOrder(x: string | null, y: string | null): number {
  if (x === y) return 0;
  if (x === null) return -1;
  if (y === null) return 1;
  return x < y ? -1 : 1;
}

const recheckOrder = (a: WatchRow, b: WatchRow): number => stampOrder(a.last_recheck_at, b.last_recheck_at);

const complaintsOrder = (a: WatchRow, b: WatchRow): number => stampOrder(a.last_complaints_at, b.last_complaints_at);

const NO_LINK_NOTE = 'no record link yet';

/** A little under a week, so a Monday run a week later is not held back by the event the last one wrote. */
const NO_LINK_WINDOW_MS = 6 * 24 * 3_600_000;

/**
 * Linkless notices written by one call of enqueueRechecks. The rest wait for the next call, so a run with many
 * of them still has subrequests left for the real re-checks.
 */
const NO_LINK_PER_RUN = 5;

/**
 * The insert statements for the check_failed notes of this call: at most NO_LINK_PER_RUN, never-noted
 * watches first, then the oldest note first, and none for a watch noted inside the last week. One read.
 * The caller joins them to the plan's batch. They are not posted to caller webhooks.
 */
async function linklessNotes(db: D1Database, watches: WatchRow[], now: Date): Promise<D1PreparedStatement[]> {
  if (watches.length === 0) return [];
  const since = new Date(now.getTime() - NO_LINK_WINDOW_MS).toISOString();
  const { results } = await db
    .prepare(
      "SELECT watch_id, MAX(created_at) AS at FROM events WHERE kind = 'check_failed' AND json_extract(evidence_json, '$.note') = ? GROUP BY watch_id",
    )
    .bind(NO_LINK_NOTE)
    .all<{ watch_id: string; at: string }>();
  const last = new Map(results.map((r) => [r.watch_id, r.at]));
  return watches
    .filter((w) => (last.get(w.watch_id) ?? '') <= since)
    .sort((a, b) => stampOrder(last.get(a.watch_id) ?? null, last.get(b.watch_id) ?? null))
    .slice(0, NO_LINK_PER_RUN)
    .map(
      (watch) =>
        insertEventStatement(
          db,
          {
            watch_id: watch.watch_id,
            kind: 'check_failed',
            before: null,
            after: null,
            evidence: evidence({ note: NO_LINK_NOTE }),
          },
          now,
        ).statement,
    );
}

/**
 * Asks registries for their re-check once a day.
 * At most RECHECKS_PER_RUN jobs or reads start in one call, oldest watches first.
 *
 * A Worker invocation allows 50 subrequests, and every D1 call counts. So this reads everything it needs in
 * one batch, plans the work in memory, and writes every new job and watch stamp in one batch at the end.
 * The free inline re-reads of link registries fetch one page each.
 */
export async function enqueueRechecks(
  env: Env,
  db: D1Database,
  now: Date = new Date(),
  client?: TinyFish,
): Promise<number> {
  const fetcher = client ?? new TinyFish(env.TINYFISH_API_KEY);
  const stamp = now.toISOString();

  const since = new Date(now.getTime() - RECENT_WINDOW_MS).toISOString();
  const recent = db.prepare('SELECT payload_json FROM queue WHERE kind = ? AND created_at >= ?');
  const [rechecks, complaints, fetchedRows, recordRows] = await db.batch<Record<string, unknown>>([
    recent.bind('recheck', since),
    recent.bind('recheck_complaints', since),
    db
      .prepare(
        "SELECT DISTINCT watch_id FROM snapshots WHERE reader_input = 'fetch_html' AND watch_id IS NOT NULL AND created_at >= ?",
      )
      .bind(since),
    listWatchesStatement(db, 'record'),
  ]);
  const rows = (r: D1Result<Record<string, unknown>>) => r.results as unknown as { payload_json: string | null }[];
  const recentRechecks = payloadValues(rows(rechecks), 'watch_id');
  const recentComplaints = payloadValues(rows(complaints), 'watch_id');
  const fetchedSince = new Set((fetchedRows.results as unknown as { watch_id: string }[]).map((r) => r.watch_id));
  const records = (recordRows.results as unknown as WatchRow[]).sort(recheckOrder);

  const plan: PlannedJob[] = [];
  let budget = RECHECKS_PER_RUN;
  const notes: D1PreparedStatement[] = [];

  // Weekly complaint runs, for the registers that keep complaints behind a second run. Least recently run
  // first, Mondays only (UTC). Watches with no stored record link are taken out before the list is cut to the
  // budget, so they never use a place a linked watch could have. Each of them gets a check_failed event, at
  // most once a week.
  if (now.getUTCDay() === 1) {
    const eligible = records
      .filter((w) => hasComplaintRun(w.registry))
      .sort(complaintsOrder)
      .filter((w) => w.licence_number !== null && !recentComplaints.has(w.watch_id));
    // One read of stored links for each register that has such watches.
    const keys = new Map<string, Awaited<ReturnType<typeof getKeys>>>();
    for (const registry of new Set(eligible.map((w) => w.registry))) {
      const numbers = eligible.filter((w) => w.registry === registry).map((w) => w.licence_number as string);
      keys.set(registry, await getKeys(db, registry as RegistryId, numbers));
    }
    const keyOf = (w: WatchRow) => keys.get(w.registry)?.get(normaliseLicenceNumber(w.licence_number as string));
    const hasLink = (w: WatchRow): boolean => !!keyOf(w)?.link_json;
    notes.push(
      ...(await linklessNotes(
        db,
        eligible.filter((w) => !hasLink(w)),
        now,
      )),
    );
    const due = eligible.filter(hasLink).slice(0, budget);
    for (const watch of due) {
      if (budget === 0) break;
      try {
        const job = complaintsJob(env, watch, keyOf(watch));
        if (job !== null) {
          plan.push({ job, also: setLastComplaintsAtStatement(db, watch.watch_id, stamp) });
          budget -= 1;
        }
      } catch (err) {
        // One watch's failure must not stop the rest. Its stamp is not set, so the next Monday run tries it again.
        console.warn(
          `Complaint run skipped for watch ${watch.watch_id}: ${err instanceof Error ? err.message : 'error'}`,
        );
      }
    }
  }

  for (const watch of records) {
    if (budget === 0) break;
    if (watch.licence_number === null) continue;
    try {
      if (effectiveTier(watch) === 'recheck' && !recentRechecks.has(watch.watch_id)) {
        const adapter = tryGetAdapter(watch.registry as RegistryId);
        if (!adapter) {
          console.warn(`No adapter for ${watch.registry}; watch ${watch.watch_id} is not re-checked`);
        } else if (adapter.record.kind === 'agent') {
          const record = adapter.record;
          const limited = limitedRun(
            {
              url: record.start_url,
              goal: record.goal(watch.licence_number),
              output_schema: record.output_schema,
              capture_config: { html: true, screenshots: true },
            },
            record.max_steps,
            env.AGENT_STEP_CAP,
          );
          plan.push({
            job: {
              kind: 'recheck',
              priority: 3,
              bucket: 'ops',
              reserved_cents: limited.reserved_cents,
              payload: { watch_id: watch.watch_id, registry: watch.registry as RegistryId, request: limited.request },
            },
            also: setLastRecheckAtStatement(db, watch.watch_id, stamp),
          });
          budget -= 1;
        } else if (!fetchedSince.has(watch.watch_id)) {
          await recheckFetch(env, db, fetcher, watch);
          plan.push({ job: null, also: setLastRecheckAtStatement(db, watch.watch_id, stamp) });
          budget -= 1;
        }
      }
    } catch (err) {
      // One watch's failure must not stop the rest. Its stamp is not set, so the next run tries it again.
      console.warn(`Re-check skipped for watch ${watch.watch_id}: ${err instanceof Error ? err.message : 'error'}`);
    }
  }

  // The notes ride in the same batch as the plan. They carry no job and come last, so they never take a queue place.
  const { ran, full } = await enqueueBatch(db, [...plan, ...notes.map((also): PlannedJob => ({ job: null, also }))]);
  if (full) console.warn('The run queue is full; the rest of the re-checks are not queued');
  return ran - notes.length;
}

registerContinuation('recheck', async (env, db, client, job, outcome) => {
  const watch_id = job.payload.watch_id;
  if (watch_id === undefined) return;
  if (!isRun(outcome)) {
    await failById(env, db, watch_id, failNote(`the check did not run (${outcome.reason})`));
    return;
  }
  await onRecheckRun(env, db, client, watch_id, outcome);
});
