/**
 * Watches: TinyFish Page Monitors on registry record links, scheduled re-checks, and the events they raise.
 *
 * Agent runs go through the queue. Free page reads (Monitor webhooks and the inline re-read of Florida watches) go
 * straight to the parsers. A reading changes stored fields only when the readers agree and the licence number on the
 * page is the watch's own.
 */

import type { Env } from '../env';
import type { Adapter } from '../registries/adapter';
import { getAdapter, tryGetAdapter } from '../registries/index';
import { judgeSearchAnswer, linkFinderRows, pageOf, searchRequest, type SearchQuery } from '../lookup/search-page';
import {
  lastCapture,
  readHtmlWhere,
  readLatestHtml,
  TinyFish,
  TinyFishError,
  type RunResult,
} from '../tinyfish/client';
import { agree, compareForWatch } from '../lookup/agree';
import { limitedRun } from '../queue/budget';
import { COMPLAINT_NOT_TIED, readComplaintPage, tiedToLicence } from '../lookup/complaint-page';
import { lineOnPage } from '../text';
import { enqueue, enqueueBatch, registerContinuation, type Job, type Outcome, type PlannedJob } from '../queue/queue';
import { formatCheck, normaliseLicenceNumber, registries, type RegistryInfo } from '../registries/catalog';
import {
  bumpFailStreak,
  findWatchByMonitor,
  getKey,
  getKeys,
  getWatch,
  insertEvent,
  insertEventStatement,
  insertSnapshot,
  insertWatch,
  listWatches,
  listWatchesStatement,
  markWebhookSeen,
  resetFailStreak,
  setLastComplaintsAtStatement,
  setLastRecheckAtStatement,
  setWatchTier,
  softDeleteWatch,
  unmarkWebhookSeen,
  updateWatchFields,
  upsertKey,
  wasWebhookSeen,
  type WatchRow,
} from '../store';
import type { Event, Fields, Reading, RegistryId, Snapshot } from '../types';

export const MONITOR_CEILING = 30;
const MONITOR_SCHEDULE = 'CRON_TZ=America/New_York 0 7 * * *';
const MONITOR_PURPOSE = 'The licence status, expiry date or discipline flag changes';
const CALLER_TIMEOUT_MS = 10_000;
const COMPLAINTS_STEPS = 20;
/** Re-checks are queued once a day even when the cron calls enqueueRechecks more than once. */
const RECENT_WINDOW_MS = 20 * 3_600_000;
/** Re-checks (agent runs and free re-reads) started by one call of enqueueRechecks. */
const RECHECKS_PER_RUN = 10;
/** Consecutive Monitor runs with errors before a watch gets the daily free re-read. */
const FAIL_STREAK_LIMIT = 2;

export class WatchLimit extends Error {
  constructor() {
    super(`The limit of ${MONITOR_CEILING} record watches is reached`);
    this.name = 'WatchLimit';
  }
}

export class InvalidWebhook extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidWebhook';
  }
}

export class InvalidInput extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidInput';
  }
}

/** What a reading comes to: the fields, or the note the check_failed event carries. */
type Verdict = { fields: Fields } | { note: string };
type EventDraft = Omit<Event, 'event_id' | 'created_at' | 'watch_id'>;

interface SnapshotDraft {
  watch_id: string;
  registry: RegistryId;
  url: string;
  reader_input: Snapshot['reader_input'];
  body: string;
  run_id: string | null;
  step_id: string | null;
}

interface MonitorBody {
  fetch_monitor_id: string;
  id: string;
  text: string | null;
  errors: unknown[];
  judgment: unknown;
}

function adapterFor(registry: string): Adapter {
  return getAdapter(registry as RegistryId);
}

function infoOf(registry: string): RegistryInfo {
  const info = registries.find((r) => r.id === registry);
  if (!info) throw new Error(`Unknown registry ${registry}`);
  return info;
}

const LICENCE_MISMATCH = 'licence_number_mismatch';
const isRun = (outcome: Outcome): outcome is RunResult => 'run_id' in outcome;
const failNote = (reason: string): string => `check failed: ${reason}`;

/** A watch's own tier when it has one, else the registry's. */
export function effectiveTier(watch: WatchRow): 'monitor' | 'recheck' {
  if (watch.tier !== null) return watch.tier;
  return registries.find((r) => r.id === watch.registry)?.watch_tier ?? 'monitor';
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A missing discipline flag reads as false: no complaint and no discipline on file. */
function withFlag(fields: Fields): Fields {
  return { ...fields, discipline_flag: fields.discipline_flag ?? false };
}

function storedFields(json: string | null): Fields | null {
  if (json === null) return null;
  // Fields stored before discipline_actions existed have no list; treat that as none.
  const parsed = JSON.parse(json) as Partial<Fields>;
  return withFlag({
    ...parsed,
    discipline_actions: Array.isArray(parsed.discipline_actions) ? parsed.discipline_actions : [],
  } as Fields);
}

function pick(fields: Fields, keys: (keyof Fields)[]): Partial<Fields> {
  const out: Partial<Record<keyof Fields, unknown>> = {};
  for (const key of keys) out[key] = fields[key];
  return out as Partial<Fields>;
}

/** Leaves out the keys that have no value. The judgment, when a Monitor sent one, rides along as evidence.judgment. */
function evidence(parts: {
  snapshot_id?: string;
  line?: string;
  note?: string | null;
  judgment?: unknown;
}): Event['evidence'] {
  const out: Record<string, unknown> = {};
  if (parts.snapshot_id !== undefined) out.snapshot_id = parts.snapshot_id;
  if (parts.line !== undefined) out.line = parts.line;
  if (parts.note) out.note = parts.note;
  if (parts.judgment !== undefined && parts.judgment !== null) out.judgment = parts.judgment;
  return out as Event['evidence'];
}

async function writeEvent(db: D1Database, watch_id: string, draft: EventDraft, now: Date): Promise<Event> {
  const row = { watch_id, ...draft };
  const event_id = await insertEvent(db, row, now);
  return { event_id, created_at: now.toISOString(), ...row };
}

async function saveSnapshot(db: D1Database, draft: SnapshotDraft, now: Date): Promise<string> {
  return insertSnapshot(db, {
    check_id: null,
    watch_id: draft.watch_id,
    registry: draft.registry,
    url: draft.url,
    reader_input: draft.reader_input,
    content_sha256: await sha256Hex(draft.body),
    body: draft.body,
    run_id: draft.run_id,
    step_id: draft.step_id,
    created_at: now.toISOString(),
  });
}

function readersFor(adapter: Adapter, html: string): Reading[] {
  return [adapter.parseHtml(html), adapter.parseText(html)];
}

/**
 * A reading counts only when some reader finds a licence number, the readers agree, and the
 * licence number is the watch's own.
 */
function judge(readings: Reading[], licence: string): Verdict {
  if (!readings.some((r) => r.fields.licence_number !== null)) {
    return { note: failNote('no licence number on the page') };
  }
  const agreement = agree(readings);
  if (!agreement.agree || agreement.fields === null) {
    const reasons = [...agreement.warnings, ...agreement.differences.map((d) => `differs: ${d.field}`)];
    return { note: failNote(`the readers do not agree (${reasons.join('; ')})`) };
  }
  const found =
    agreement.fields.licence_number === null ? null : normaliseLicenceNumber(agreement.fields.licence_number);
  if (found !== licence) return { note: LICENCE_MISMATCH };
  return { fields: withFlag(agreement.fields) };
}

async function pageUrl(db: D1Database, adapter: Adapter, watch: WatchRow): Promise<string> {
  if (adapter.record.kind === 'agent') return adapter.record.start_url;
  if (watch.licence_number !== null) {
    const key = await getKey(db, adapter.id, watch.licence_number);
    if (key?.link_json) return adapter.record.url(JSON.parse(key.link_json) as Record<string, string>);
  }
  return adapter.info.url;
}

async function publish(events: Event[], caller_webhook: string | null): Promise<void> {
  for (const event of events) await forwardEvent(event, caller_webhook);
}

/** Live record watches of both tiers: the count the watch limit reports, the same as the ceiling counts. */
export async function countWatches(db: D1Database): Promise<number> {
  return (await listWatches(db, 'record')).length;
}

/** Every record watch counts toward the ceiling, pending and re-check tiers included, except the one named. */
async function recordCount(db: D1Database, exclude?: string): Promise<number> {
  const records = await listWatches(db, 'record');
  return records.filter((w) => w.watch_id !== exclude).length;
}

async function deleteMonitorIfPresent(client: TinyFish, monitor_id: string): Promise<void> {
  try {
    await client.deleteMonitor(monitor_id);
  } catch (err) {
    // A monitor that is already gone is what the caller wanted.
    if (err instanceof TinyFishError && err.code === 'not_found') return;
    throw err;
  }
}

// Validation

/**
 * Caller webhooks receive event data, so they must be public https endpoints.
 * Returns the reason when the URL is not acceptable, or null when it is.
 */
export function validateCallerWebhook(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'The caller webhook is not a valid URL';
  }
  if (parsed.protocol !== 'https:') return 'The caller webhook must use https';
  // WHATWG URL parsing already writes IPv4 in dotted form; IPv6 literals keep their brackets.
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) return 'The caller webhook must not be an IP address';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 'The caller webhook must not be an IP address';
  if (host === 'localhost' || /\.(local|internal|localhost)$/.test(host)) {
    return 'The caller webhook must not point at a local or internal host';
  }
  return null;
}

function requireValidWebhook(url: string | undefined): void {
  if (url === undefined) return;
  const reason = validateCallerWebhook(url);
  if (reason !== null) throw new InvalidWebhook(reason);
}

/** Licence numbers go into agent goals, so they are checked before any use. */
const LICENCE_SHAPE = /^[A-Z0-9-]{1,20}$/;
function checkedLicence(registry: string, input: string): string {
  const licence = normaliseLicenceNumber(input);
  if (!LICENCE_SHAPE.test(licence)) {
    throw new InvalidInput('A licence number is 1 to 20 letters, digits or hyphens');
  }
  const message = formatCheck(registry as RegistryId, licence);
  if (message !== null) throw new InvalidInput(message);
  return licence;
}

// Watch creation

/** Throws InvalidInput, InvalidWebhook or WatchLimit before the watch is stored. */
export async function createRecordWatch(
  env: Env,
  db: D1Database,
  client: TinyFish,
  registry: RegistryId,
  licence_number: string,
  caller_webhook?: string,
): Promise<{ watch_id: string; tier: 'monitor' | 'recheck'; pending?: boolean }> {
  requireValidWebhook(caller_webhook);
  const licence = checkedLicence(registry, licence_number);
  const info = infoOf(registry);
  if ((await recordCount(db)) >= MONITOR_CEILING) throw new WatchLimit();

  const watch_id = await insertWatch(db, {
    kind: 'record',
    registry,
    licence_number: licence,
    name: null,
    monitor_id: null,
    caller_webhook: caller_webhook ?? null,
  });

  try {
    if (info.watch_tier === 'recheck') return { watch_id, tier: 'recheck' };

    const key = await getKey(db, registry, licence);
    if (key?.link_json) {
      await startMonitor(
        env,
        db,
        client,
        watch_id,
        registry,
        licence,
        JSON.parse(key.link_json) as Record<string, string>,
      );
      return { watch_id, tier: 'monitor' };
    }
    await enqueueKeySearch(env, db, watch_id, registry, licence);
    return { watch_id, tier: 'monitor', pending: true };
  } catch (err) {
    await softDeleteWatch(db, watch_id);
    throw err;
  }
}

/** The search query that asks for the record link of a licence number. copyRows asks for the row-copying goal. */
function keyQuery(registry: RegistryId, licence: string, copyRows: boolean): SearchQuery {
  return { licence_number: licence, type: infoOf(registry).types[0], ...(copyRows ? { copy_rows: true } : {}) };
}

/** Asks the registry for the record link by licence number. resolveWatchFromSearch finishes it. */
async function enqueueKeySearch(
  env: Env,
  db: D1Database,
  watch_id: string,
  registry: RegistryId,
  licence: string,
  copyRows = false,
): Promise<void> {
  const adapter = adapterFor(registry);
  const { request, max_steps } = searchRequest(adapter, keyQuery(registry, licence, copyRows));
  const limited = limitedRun(request, max_steps, env.AGENT_STEP_CAP);
  await enqueue(db, {
    kind: 'search',
    priority: 2,
    bucket: 'ops',
    reserved_cents: limited.reserved_cents,
    payload: { watch_id, registry, request: limited.request },
  });
}

/** Creates the Monitor on the record link and stores the baseline read from the page it returns. */
async function startMonitor(
  env: Env,
  db: D1Database,
  client: TinyFish,
  watch_id: string,
  registry: RegistryId,
  licence: string,
  link: Record<string, string>,
): Promise<void> {
  const adapter = adapterFor(registry);
  if (adapter.record.kind !== 'link') throw new Error(`${registry} has no record link to monitor`);
  const url = adapter.record.url(link);
  // Checked again here: other watches may have been created since this one was.
  if ((await recordCount(db, watch_id)) >= MONITOR_CEILING) {
    const watch = await getWatch(db, watch_id);
    if (watch)
      await failCheck(
        env,
        db,
        watch,
        failNote(`the limit of ${MONITOR_CEILING} record watches is reached`),
        new Date(),
      );
    await softDeleteWatch(db, watch_id);
    throw new WatchLimit();
  }
  const created = await client.createMonitor({
    type: 'fetch',
    name: `${registry} ${licence}`,
    config: { url, format: 'html' },
    schedule_cron: MONITOR_SCHEDULE,
    purpose: MONITOR_PURPOSE,
    webhook_url: `${env.BASE_URL}/hooks/tinyfish/monitor/${env.HOOK_SECRET}`,
  });
  await setMonitorId(db, watch_id, created.monitor.id);

  const html = created.run.results[0]?.text;
  if (typeof html !== 'string' || created.run.errors.length > 0) return;
  const verdict = judge(readersFor(adapter, html), licence);
  if ('note' in verdict) {
    if (verdict.note === LICENCE_MISMATCH) {
      // The event is written first. The Monitor would keep reading a page that is not this watch's,
      // so it is deleted next. A failed delete is a warning on the watch, not a failed creation.
      const watch = await getWatch(db, watch_id);
      if (watch) await failCheck(env, db, watch, verdict.note, new Date());
      try {
        await deleteMonitorIfPresent(client, created.monitor.id);
        await setMonitorId(db, watch_id, null);
      } catch (err) {
        // The Monitor id stays, so an admin can find and delete the Monitor.
        const current = await getWatch(db, watch_id);
        const reason = err instanceof Error ? err.name : 'error';
        if (current) {
          await failCheck(env, db, current, `warning: the mismatched monitor was not deleted (${reason})`, new Date());
        }
      }
    }
    return;
  }
  await updateWatchFields(db, watch_id, verdict.fields);
  await saveSnapshot(
    db,
    { watch_id, registry, url, reader_input: 'monitor_html', body: html, run_id: created.run.id, step_id: null },
    new Date(),
  );
}

async function setMonitorId(db: D1Database, watch_id: string, monitor_id: string | null): Promise<void> {
  await db.prepare('UPDATE watches SET monitor_id = ? WHERE watch_id = ?').bind(monitor_id, watch_id).run();
}

/** Returns the record link that the search run found for this licence number, or null. */
export function resolveLinkFromRun(
  adapter: Adapter,
  run: RunResult,
  licence_number: string,
): Record<string, string> | null {
  const want = normaliseLicenceNumber(licence_number);
  for (const row of adapter.rowsFromAgent(run.result)) {
    if (row.licence_number !== null && row.link !== null && normaliseLicenceNumber(row.licence_number) === want) {
      return row.link;
    }
  }
  return null;
}

/**
 * The record link a key search found, in the order a lookup reads an answer: the address of a record page (or a
 * found address), then the row of this number on the results list in the run's snapshot, then rows copied into the
 * answer. listShown is true when the snapshot was a results list, whether or not it held the number.
 */
async function linkFromKeySearch(
  adapter: Adapter,
  client: TinyFish,
  run: RunResult,
  licence: string,
): Promise<{ link: Record<string, string> | null; listShown: boolean }> {
  const direct = linkFinderRows(adapter, run.result, licence)?.[0]?.link ?? null;
  if (direct !== null) return { link: direct, listShown: false };
  let listShown = false;
  if (pageOf(run.result) === 'results' && adapter.rowsFromSnapshot !== undefined) {
    const found = await readLatestHtml(client, run.run_id, run.steps);
    const read = found === null ? null : adapter.rowsFromSnapshot(found.html);
    if (read !== null) {
      listShown = true;
      const want = normaliseLicenceNumber(licence);
      const row = read.rows.find(
        (r) => r.link !== null && r.licence_number !== null && normaliseLicenceNumber(r.licence_number) === want,
      );
      if (row?.link) return { link: row.link, listShown };
    }
  }
  return { link: resolveLinkFromRun(adapter, run, licence), listShown };
}

/**
 * Finishes a pending watch from its key search. The record is read first, and the key is stored
 * only when the page on the link is this licence number. A search row alone is never enough.
 */
export async function resolveWatchFromSearch(
  env: Env,
  db: D1Database,
  client: TinyFish,
  job: Job,
  outcome: Outcome,
): Promise<void> {
  const watch_id = job.payload.watch_id;
  if (watch_id === undefined) return;
  const watch = await getWatch(db, watch_id);
  if (!watch || watch.deleted_at !== null || watch.monitor_id !== null || watch.licence_number === null) return;

  const registry = watch.registry as RegistryId;
  const licence = watch.licence_number;
  const now = new Date();
  if (!isRun(outcome) || outcome.status !== 'COMPLETED') {
    await failCheck(env, db, watch, failNote('the registry search did not complete'), now);
    return;
  }
  const adapter = adapterFor(registry);
  const { link, listShown } = await linkFromKeySearch(adapter, client, outcome, licence);
  if (link === null) {
    // A results list without this number gets one more run that copies the rows, unless the goal just run was that one.
    if (pageOf(outcome.result) === 'results' && adapter.search.kind === 'agent') {
      // The queued goal is the search goal followed by the run limits, so it is compared by its start.
      if (!job.payload.request.goal.startsWith(adapter.search.goal(keyQuery(registry, licence, true)))) {
        await enqueueKeySearch(env, db, watch.watch_id, registry, licence, true);
        return;
      }
      if (listShown) {
        await failCheck(env, db, watch, failNote('the registry search did not return this licence number'), now);
        return;
      }
    }
    // A registry that did not answer (an error page, a captcha, a sign-in, a page that could not be read) is
    // not the same as one that said the licence is not there.
    if (adapter.search.kind === 'agent' && adapter.search.reports_page) {
      const verdict = judgeSearchAnswer(outcome.result, adapter.rowsFromAgent(outcome.result).length);
      if (verdict.kind === 'unavailable') {
        await failCheck(env, db, watch, failNote(`the registry did not answer (${verdict.reason})`), now);
        return;
      }
    }
    await failCheck(env, db, watch, failNote('the registry search did not return this licence number'), now);
    return;
  }
  if (adapter.record.kind !== 'link') {
    await failCheck(env, db, watch, failNote(`${registry} has no record link to read`), now);
    return;
  }
  const url = adapter.record.url(link);
  const fetched = await client.fetchPages([url], { format: 'html', ttl: 0 });
  const html = fetched.results[0]?.text;
  if (typeof html !== 'string') {
    await failCheck(env, db, watch, failNote('the record page could not be read'), now);
    return;
  }
  const verdict = judge(readersFor(adapter, html), licence);
  if ('note' in verdict) {
    await failCheck(env, db, watch, verdict.note, now);
    return;
  }
  await upsertKey(db, registry, licence, link, now);
  try {
    await startMonitor(env, db, client, watch.watch_id, registry, licence, link);
  } catch (err) {
    // The limit is already written as a check_failed event on the watch.
    if (err instanceof WatchLimit) return;
    throw err;
  }
}

/** Deleting a watch that is missing or already deleted does nothing. */
export async function deleteWatch(db: D1Database, client: TinyFish, watch_id: string): Promise<void> {
  const watch = await getWatch(db, watch_id);
  if (!watch || watch.deleted_at !== null) return;
  if (watch.monitor_id !== null) await deleteMonitorIfPresent(client, watch.monitor_id);
  await softDeleteWatch(db, watch_id);
}

/** Run ids are claimed once, so a repeated webhook for the same run is a duplicate. */
async function claimRun(db: D1Database, run_id: string): Promise<boolean> {
  if (await wasWebhookSeen(db, run_id)) return false;
  return markWebhookSeen(db, run_id);
}

// Monitor webhooks

function parseMonitorBody(body: unknown): MonitorBody | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.fetch_monitor_id !== 'string' || typeof b.id !== 'string') return null;
  const results = Array.isArray(b.results) ? b.results : [];
  const first = results[0] as { text?: unknown } | null | undefined;
  return {
    fetch_monitor_id: b.fetch_monitor_id,
    id: b.id,
    text: typeof first?.text === 'string' ? first.text : null,
    errors: Array.isArray(b.errors) ? b.errors : [],
    judgment: b.judgment,
  };
}

/**
 * 'ignored' is a body that is not a monitor run or names no watch; 'duplicate' is a run already handled; 'failed' is a
 * run whose page could not be read, so a check_failed event was written instead of a comparison.
 * When processing throws, the run is released so a retry is handled.
 */
export async function onMonitorWebhook(
  env: Env,
  db: D1Database,
  client: TinyFish,
  body: unknown,
): Promise<'ignored' | 'duplicate' | 'processed' | 'failed'> {
  // An ignored webhook is logged with its reason and never its body, which anyone with the URL could fill.
  const parsed = parseMonitorBody(body);
  if (parsed === null) {
    console.warn('Monitor webhook ignored: the body is not a monitor run');
    return 'ignored';
  }
  const watch = await findWatchByMonitor(db, parsed.fetch_monitor_id);
  if (watch === null) {
    console.warn('Monitor webhook ignored: no watch has that monitor id');
    return 'ignored';
  }
  if (!(await claimRun(db, parsed.id))) return 'duplicate';

  try {
    return (await processMonitorRun(env, db, client, watch, parsed)) ? 'failed' : 'processed';
  } catch (err) {
    await unmarkWebhookSeen(db, parsed.id);
    throw err;
  }
}

/** True when the run ended as a failed check (a check_failed event) and not as a comparison. */
async function processMonitorRun(
  env: Env,
  db: D1Database,
  client: TinyFish,
  watch: WatchRow,
  body: MonitorBody,
): Promise<boolean> {
  const now = new Date();
  const adapter = adapterFor(watch.registry);
  const licence = watch.licence_number ?? '';
  let verdict: Verdict;
  if (body.errors.length > 0) {
    // Only errors count toward the streak. A maintenance or layout page is a failed check, not an error.
    verdict = { note: failNote('the monitor reported errors') };
    const streak = await bumpFailStreak(db, watch.watch_id);
    if (streak >= FAIL_STREAK_LIMIT) await setWatchTier(db, watch.watch_id, 'recheck');
  } else if (body.text === null) {
    verdict = { note: failNote('the monitor returned no page') };
  } else {
    verdict = judge(readersFor(adapter, body.text), licence);
  }
  if ('fields' in verdict) await resetFailStreak(db, watch.watch_id);

  const snapshot: SnapshotDraft | null =
    body.text === null
      ? null
      : {
          watch_id: watch.watch_id,
          registry: watch.registry as RegistryId,
          url: await pageUrl(db, adapter, watch),
          reader_input: 'monitor_html',
          body: body.text,
          run_id: body.id,
          step_id: null,
        };
  const events = await recordOutcome(db, watch, verdict, snapshot, now, body.judgment);
  await publish(events, watch.caller_webhook);
  return 'note' in verdict;
}

/** The DBPR Monitor does not own the discipline fields; complaint runs do. */
function monitorFields(watch: WatchRow, previous: Fields | null, fields: Fields): Fields {
  if (watch.registry !== 'fl-dbpr') return fields;
  return {
    ...fields,
    discipline_flag: previous?.discipline_flag ?? false,
    discipline_actions: previous?.discipline_actions ?? [],
  };
}

/** Writes the snapshot, then the event for this check. A failed check never changes stored fields. */
async function recordOutcome(
  db: D1Database,
  watch: WatchRow,
  verdict: Verdict,
  snapshot: SnapshotDraft | null,
  now: Date,
  judgment?: unknown,
): Promise<Event[]> {
  const snapshot_id = snapshot === null ? undefined : await saveSnapshot(db, snapshot, now);

  if ('note' in verdict) {
    return [await raiseFailure(db, watch, verdict.note, snapshot_id, judgment, now)];
  }

  const previous = storedFields(watch.last_fields_json);
  const next = monitorFields(watch, previous, verdict.fields);
  await updateWatchFields(db, watch.watch_id, next);
  if (previous === null) return [];

  const cmp = compareForWatch(previous, next);
  if (cmp.changed) {
    const keys = cmp.changes.map((c) => c.field);
    if (keys.includes('status')) keys.push('status_raw');
    return [
      await writeEvent(
        db,
        watch.watch_id,
        {
          kind: 'status_change',
          before: pick(previous, keys),
          after: pick(next, keys),
          evidence: evidence({ snapshot_id, note: cmp.note, judgment }),
        },
        now,
      ),
    ];
  }
  // Nothing that counts changed. The run still leaves a trace, so the history shows the watch is being read.
  // The note names what moved without counting, when something did; the Monitor's judgment rides along.
  return [
    await writeEvent(
      db,
      watch.watch_id,
      {
        kind: 'unchanged',
        before: null,
        after: null,
        evidence: evidence({ snapshot_id, note: cmp.note, judgment }),
      },
      now,
    ),
  ];
}

async function raiseFailure(
  db: D1Database,
  watch: WatchRow,
  note: string,
  snapshot_id: string | undefined,
  judgment: unknown,
  now: Date,
): Promise<Event> {
  return writeEvent(
    db,
    watch.watch_id,
    { kind: 'check_failed', before: null, after: null, evidence: evidence({ snapshot_id, note, judgment }) },
    now,
  );
}

async function failCheck(env: Env, db: D1Database, watch: WatchRow, note: string, now: Date): Promise<void> {
  const event = await raiseFailure(db, watch, note, undefined, undefined, now);
  await publish([event], watch.caller_webhook);
}

async function failById(env: Env, db: D1Database, watch_id: string, note: string): Promise<void> {
  const watch = await getWatch(db, watch_id);
  if (!watch || watch.deleted_at !== null) return;
  await failCheck(env, db, watch, note, new Date());
}

// Re-checks

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

interface Complaint {
  case_number: string;
  status: string;
  date: string;
}

/** Fields with no value, for a DBPR watch that has no stored fields yet. */
function blankFields(licence_number: string): Fields {
  return {
    name: null,
    licence_number,
    status_raw: null,
    status: null,
    expires: null,
    issued: null,
    licence_type: null,
    discipline_flag: false,
    discipline_actions: [],
    data_as_of: null,
    city: null,
    other_names: [],
  };
}

const QUOTE_UNVERIFIED = 'complaint_quote_unverified';
const AGENT_ANSWER_DIFFERS = 'agent_answer_differs';

/** Notes joined into one sentence list, leaving out the ones that are empty. */
function joinNotes(...notes: (string | null | undefined)[]): string | null {
  const kept = notes.filter((n): n is string => typeof n === 'string' && n !== '');
  return kept.length === 0 ? null : kept.join('. ');
}

/**
 * The weekly complaint comparison. It owns discipline_actions and discipline_flag only, so a
 * quiet week raises nothing. Every other stored field is carried over unchanged.
 */
export async function onComplaintsRun(
  env: Env,
  db: D1Database,
  client: TinyFish,
  watch_id: string,
  run: RunResult,
): Promise<void> {
  const watch = await getWatch(db, watch_id);
  if (!watch || watch.deleted_at !== null || watch.licence_number === null) return;
  const now = new Date();

  const complaintLine = (c: Complaint): string => `${c.case_number} ${c.status} ${c.date}`.trim();
  const previous = storedFields(watch.last_fields_json);

  // The complaint view is the newest of the last 4 snapshots that both readers take for it: the agent may have
  // clicked away after reading. When there is none, the page the run ended on is kept as the snapshot, or the
  // run's own JSON result when no page could be captured, and the event for this run says so.
  const adapter = tryGetAdapter(watch.registry as RegistryId);
  const step = await readHtmlWhere(
    client,
    run.run_id,
    run.steps,
    (candidate) => readComplaintPage(adapter, candidate) !== null,
  );
  if (!step) console.warn(`Complaint page not captured for watch ${watch_id}`);
  // A view that both readers accept but that the run does not tie to this licence may be another record's:
  // nothing from it is kept.
  const untied =
    step?.accepted === true &&
    !(await tiedToLicence(client, run.run_id, run.steps, step, adapter, watch.licence_number));
  const kept = untied ? null : step;
  const html: string | null = kept?.html ?? null;
  const notCaptured = html === null ? 'page not captured; the snapshot holds the run result' : null;
  const snapshot_id = await saveSnapshot(
    db,
    {
      watch_id,
      registry: watch.registry as RegistryId,
      url: infoOf(watch.registry).url,
      reader_input: 'agent_html',
      body: html ?? JSON.stringify(run.result ?? null),
      run_id: run.run_id,
      step_id: kept?.step_id ?? null,
    },
    now,
  );

  // The captured page decides, and the run's answer only adds a note. When no page is accepted by both
  // readers, or they disagree, the stored fields stay as they were.
  const refuse = async (reason: string): Promise<void> => {
    const note = failNote(`${reason} (complaints_not_checked)`);
    const event = await raiseFailure(db, watch, joinNotes(note, notCaptured) ?? note, snapshot_id, undefined, now);
    await publish([event], watch.caller_webhook);
  };
  if (untied) return refuse(COMPLAINT_NOT_TIED);
  const read = kept?.accepted ? readComplaintPage(adapter, kept.html) : null;
  if (read === null) return refuse('complaint page not captured');
  if (!read.agree) return refuse('the two readers of the complaint page disagree (complaint_readers_disagree)');
  const actions = read.rows.map(complaintLine);
  const view = (run.result ?? {}) as { complaints?: unknown; complaint_view_opened?: unknown; evidence_line?: unknown };
  const differs =
    view.complaint_view_opened !== true || !Array.isArray(view.complaints) || view.complaints.length !== actions.length;
  const next: Fields = {
    ...(previous ?? blankFields(watch.licence_number)),
    discipline_flag: actions.length > 0,
    discipline_actions: actions,
  };
  // The evidence line is kept only when it appears on the captured page. Otherwise it is dropped and the event says so.
  const claimed = typeof view.evidence_line === 'string' ? view.evidence_line.trim() : '';
  const line = lineOnPage(claimed, html) ? claimed : '';
  const unverified = claimed !== '' && line === '' ? QUOTE_UNVERIFIED : null;
  const notes = [differs ? AGENT_ANSWER_DIFFERS : null, unverified];

  await updateWatchFields(db, watch_id, next);
  if (previous === null) return;

  const cmp = compareForWatch(previous, next);
  let events: Event[];
  if (cmp.changed) {
    events = [
      await writeEvent(
        db,
        watch_id,
        {
          kind: 'status_change',
          before: pick(previous, ['discipline_flag', 'discipline_actions']),
          after: pick(next, ['discipline_flag', 'discipline_actions']),
          evidence: evidence({
            snapshot_id,
            line: line === '' ? undefined : line,
            note: joinNotes(cmp.note, notCaptured, ...notes),
          }),
        },
        now,
      ),
    ];
  } else {
    events = [
      await writeEvent(
        db,
        watch_id,
        {
          kind: 'unchanged',
          before: null,
          after: null,
          evidence: evidence({ snapshot_id, note: joinNotes(cmp.note, notCaptured, ...notes) }),
        },
        now,
      ),
    ];
  }
  await publish(events, watch.caller_webhook);
}

/**
 * The DBPR complaint run, built from the adapter's own discipline goal and schema. Null, with the reason
 * logged, when the watch has no stored record link to open.
 */
function complaintsJob(
  env: Env,
  watch: WatchRow,
  key: { link_json: string | null } | undefined,
): Omit<Job, 'job_id'> | null {
  const dbpr = tryGetAdapter('fl-dbpr');
  if (!dbpr || !key?.link_json || dbpr.record.kind !== 'link') {
    console.warn(`No DBPR record link for watch ${watch.watch_id}; complaints not checked`);
    return null;
  }
  const discipline = dbpr.discipline;
  if (discipline.kind !== 'agent_second_run') {
    console.warn('The DBPR adapter has no complaint run; complaints not checked');
    return null;
  }
  const link = JSON.parse(key.link_json) as Record<string, string>;
  const limited = limitedRun(
    {
      url: dbpr.record.url(link),
      goal: discipline.goal(link),
      output_schema: discipline.output_schema,
      capture_config: { html: true, screenshots: true },
    },
    COMPLAINTS_STEPS,
    env.AGENT_STEP_CAP,
  );
  return {
    kind: 'recheck_complaints',
    priority: 3,
    bucket: 'ops',
    reserved_cents: limited.reserved_cents,
    payload: { watch_id: watch.watch_id, registry: 'fl-dbpr', request: limited.request },
  };
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

  // Weekly DBPR complaint runs, least recently run first. Mondays only (UTC). Watches with no stored record
  // link are taken out before the list is cut to the budget, so they never use a place a linked watch could
  // have. Each of them gets a check_failed event, at most once a week.
  if (now.getUTCDay() === 1) {
    const dbpr = records.filter((w) => w.registry === 'fl-dbpr').sort(complaintsOrder);
    const eligible = dbpr.filter((w) => w.licence_number !== null && !recentComplaints.has(w.watch_id));
    const keys = await getKeys(
      db,
      'fl-dbpr',
      eligible.map((w) => w.licence_number as string),
    );
    const hasLink = (w: WatchRow): boolean => !!keys.get(normaliseLicenceNumber(w.licence_number as string))?.link_json;
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
        const job = complaintsJob(env, watch, keys.get(normaliseLicenceNumber(watch.licence_number as string)));
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

// Forwarding

const FORWARDED_KINDS: Event['kind'][] = ['status_change', 'check_failed'];

/**
 * Posts one event to the caller. Only changes go out: status_change and check_failed. An unchanged
 * event is stored and never posted, since every Monitor run writes one. The URL is checked again before sending,
 * and a redirect is never followed, since its target was not checked. Failures are logged and never thrown.
 */
export async function forwardEvent(event: Event, caller_webhook: string | null): Promise<void> {
  if (caller_webhook === null) return;
  if (!FORWARDED_KINDS.includes(event.kind)) return;
  const reason = validateCallerWebhook(caller_webhook);
  if (reason !== null) {
    console.warn(`Caller webhook not used for event ${event.event_id}: ${reason}`);
    return;
  }
  try {
    const res = await fetch(caller_webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      redirect: 'manual',
      signal: AbortSignal.timeout(CALLER_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) {
      console.warn(`Caller webhook answered ${res.status} for event ${event.event_id}; redirect not followed`);
      return;
    }
    if (!res.ok) console.warn(`Caller webhook answered ${res.status} for event ${event.event_id}`);
  } catch (err) {
    console.warn(`Caller webhook failed for event ${event.event_id}: ${err instanceof Error ? err.name : 'error'}`);
  }
}

// Continuations

registerContinuation('recheck', async (env, db, client, job, outcome) => {
  const watch_id = job.payload.watch_id;
  if (watch_id === undefined) return;
  if (!isRun(outcome)) {
    await failById(env, db, watch_id, failNote(`the check did not run (${outcome.reason})`));
    return;
  }
  await onRecheckRun(env, db, client, watch_id, outcome);
});

registerContinuation('recheck_complaints', async (env, db, client, job, outcome) => {
  const watch_id = job.payload.watch_id;
  if (watch_id === undefined) return;
  if (!isRun(outcome)) {
    await failById(env, db, watch_id, failNote(`the complaint check did not run (${outcome.reason})`));
    return;
  }
  if (outcome.status !== 'COMPLETED') {
    await failById(env, db, watch_id, failNote(`the complaint check ended ${outcome.status}`));
    return;
  }
  await onComplaintsRun(env, db, client, watch_id, outcome);
});
