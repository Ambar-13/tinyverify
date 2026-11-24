/**
 * Creating and deleting a watch on one licence. A register with stable record links is watched by a TinyFish
 * Monitor; the others are read again by a scheduled agent run. The rest of this folder handles what happens after:
 * monitor.ts a Monitor's webhook, recheck.ts the scheduled re-reads, complaints.ts the weekly complaint runs.
 */

import type { Env } from '../env';
import type { Adapter } from '../registries/adapter';
import { judgeSearchAnswer, linkFinderRows, pageOf, searchRequest, type SearchQuery } from '../lookup/search-page';
import { readLatestHtml, TinyFish, TinyFishError, type RunResult } from '../tinyfish/client';
import { limitedRun } from '../queue/budget';
import { enqueue, type Job, type Outcome } from '../queue/queue';
import { formatCheck, normaliseLicenceNumber } from '../registries/catalog';
import { getKey, getWatch, insertWatch, listWatches, softDeleteWatch, updateWatchFields, upsertKey } from '../store';
import type { RegistryId } from '../types';
import {
  adapterFor,
  infoOf,
  LICENCE_MISMATCH,
  isRun,
  failNote,
  saveSnapshot,
  readersFor,
  judge,
  failCheck,
  deleteMonitorIfPresent,
} from './outcome';
import { validateCallerWebhook } from './forward';

export const MONITOR_CEILING = 30;

/** Mondays at 7:00 in New York. Each Monitor run is paid for, and a licence status rarely changes within a week. */
const MONITOR_SCHEDULE = 'CRON_TZ=America/New_York 0 7 * * 1';

const MONITOR_PURPOSE = 'The licence status, expiry date or discipline flag changes';

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

/** Live record watches of both tiers: the count the watch limit reports, the same as the ceiling counts. */
export async function countWatches(db: D1Database): Promise<number> {
  return (await listWatches(db, 'record')).length;
}

/** Every record watch counts toward the ceiling, pending and re-check tiers included, except the one named. */
async function recordCount(db: D1Database, exclude?: string): Promise<number> {
  const records = await listWatches(db, 'record');
  return records.filter((w) => w.watch_id !== exclude).length;
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
  await db
    .prepare('UPDATE watches SET monitor_id = ?, monitor_schedule = ? WHERE watch_id = ?')
    .bind(monitor_id, monitor_id === null ? null : MONITOR_SCHEDULE, watch_id)
    .run();
}

/**
 * Moves every Monitor that was made on another schedule to MONITOR_SCHEDULE, and returns how many it moved.
 * Without this, a change of schedule would reach new watches only. A Monitor that cannot be moved is logged
 * and tried again on the next call.
 */
export async function alignMonitorSchedules(db: D1Database, client: TinyFish): Promise<number> {
  const { results } = await db
    .prepare(
      'SELECT watch_id, monitor_id FROM watches WHERE deleted_at IS NULL AND monitor_id IS NOT NULL AND (monitor_schedule IS NULL OR monitor_schedule <> ?)',
    )
    .bind(MONITOR_SCHEDULE)
    .all<{ watch_id: string; monitor_id: string }>();

  let moved = 0;
  for (const watch of results) {
    try {
      await client.setMonitorSchedule(watch.monitor_id, MONITOR_SCHEDULE);
      await db
        .prepare('UPDATE watches SET monitor_schedule = ? WHERE watch_id = ? AND monitor_id = ?')
        .bind(MONITOR_SCHEDULE, watch.watch_id, watch.monitor_id)
        .run();
      moved += 1;
    } catch (err) {
      if (!(err instanceof TinyFishError)) throw err;
      console.warn(`Monitor schedule not moved for watch ${watch.watch_id}: ${err.code}`);
    }
  }
  return moved;
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
