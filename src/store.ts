/**
 * Every D1 query the service runs, grouped by table: checks, snapshots, record keys, watches, events, the run queue,
 * budgets and ledger, canaries, and the purge. Each function takes the database first. Those named ...Statement
 * return a prepared statement for db.batch instead of running it.
 */

import type { Event, Fields, RegistryId, Snapshot, VerifyResult } from './types';
import { normaliseLicenceNumber } from './registries/catalog';

export type WebhookSource = 'monitor' | 'run';

// Row shapes are the stored columns. JSON columns stay as strings except where
// a function's return type says otherwise (listEvents).

export interface CheckRow {
  check_id: string;
  created_at: string;
  state: string;
  query_json: string | null;
  result_json: string | null;
  cache_key: string | null;
}

export interface KeyRow {
  registry: string;
  licence_number: string;
  link_json: string | null;
  resolved_at: string | null;
}

export interface WatchInput {
  kind: 'record';
  registry: string;
  licence_number: string | null;
  name: string | null;
  monitor_id: string | null;
  caller_webhook: string | null;
  /** SHA-256 of the API key that created the watch. Null for admin-created watches. */
  owner_hash?: string | null;
}

export interface WatchRow extends WatchInput {
  watch_id: string;
  last_fields_json: string | null;
  created_at: string;
  deleted_at: string | null;
  /** 'recheck' once the Monitor has failed twice in a row with errors; null means the registry's tier. */
  tier: 'monitor' | 'recheck' | null;
  /** Consecutive Monitor runs that came back with errors. Reset by a successful reading. */
  fail_streak: number;
  /** When a re-check was last queued or run inline. Null until the first one. */
  last_recheck_at: string | null;
  /** When a DBPR complaint run was last queued for this watch. Null until the first one. */
  last_complaints_at: string | null;
}

export type EventInput = Omit<Event, 'event_id' | 'created_at'>;

export interface JobInput {
  kind: string;
  priority: number;
  payload_json: string | null;
  bucket: string | null;
  reserved_cents: number;
}

export interface JobRow extends JobInput {
  job_id: string;
  state: string;
  run_id: string | null;
  attempt: number;
  not_before: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface CanaryRow {
  registry: string;
  ran_at: string;
  ok: boolean;
  detail: string | null;
}

const newId = (prefix: string): string => `${prefix}${crypto.randomUUID()}`;
const toJson = (value: unknown): string | null =>
  value === null || value === undefined ? null : JSON.stringify(value);
const fromJson = <T>(text: string | null): T | null => (text === null ? null : (JSON.parse(text) as T));

export async function insertRawWebhook(db: D1Database, source: WebhookSource, body: string): Promise<void> {
  await db
    .prepare('INSERT INTO raw_webhooks (id, source, body, received_at) VALUES (?, ?, ?, ?)')
    .bind(crypto.randomUUID(), source, body, new Date().toISOString())
    .run();
}

// Checks

export async function insertCheck(
  db: D1Database,
  c: {
    state: VerifyResult['state'];
    query_json?: string | null;
    result_json?: string | null;
    cache_key?: string | null;
  },
  now: Date = new Date(),
): Promise<string> {
  const id = newId('chk_');
  await db
    .prepare(
      'INSERT INTO checks (check_id, created_at, state, query_json, result_json, cache_key) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(id, now.toISOString(), c.state, c.query_json ?? null, c.result_json ?? null, c.cache_key ?? null)
    .run();
  return id;
}

/** Only the fields given change. */
export async function updateCheck(
  db: D1Database,
  check_id: string,
  patch: Partial<{ state: VerifyResult['state']; result_json: string; uncache: boolean }>,
): Promise<void> {
  // uncache drops the cache key, so no later call is served this result.
  await db
    .prepare(
      'UPDATE checks SET state = COALESCE(?, state), result_json = COALESCE(?, result_json), cache_key = CASE WHEN ? = 1 THEN NULL ELSE cache_key END WHERE check_id = ?',
    )
    .bind(patch.state ?? null, patch.result_json ?? null, patch.uncache ? 1 : 0, check_id)
    .run();
}

export function getCheck(db: D1Database, check_id: string): Promise<CheckRow | null> {
  return db.prepare('SELECT * FROM checks WHERE check_id = ?').bind(check_id).first<CheckRow>();
}

/** Newest done check with this key, created within the last maxAgeSeconds. */
export function findCachedCheck(
  db: D1Database,
  cache_key: string,
  maxAgeSeconds: number,
  now: Date = new Date(),
): Promise<CheckRow | null> {
  const since = new Date(now.getTime() - maxAgeSeconds * 1000).toISOString();
  return db
    .prepare(
      "SELECT * FROM checks WHERE cache_key = ? AND state = 'done' AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .bind(cache_key, since)
    .first<CheckRow>();
}

// Snapshots

export async function insertSnapshot(db: D1Database, s: Omit<Snapshot, 'snapshot_id'>): Promise<string> {
  const id = newId('snap_');
  await db
    .prepare(
      'INSERT INTO snapshots (snapshot_id, check_id, watch_id, registry, url, reader_input, content_sha256, body, run_id, step_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      id,
      s.check_id,
      s.watch_id,
      s.registry,
      s.url,
      s.reader_input,
      s.content_sha256,
      s.body,
      s.run_id,
      s.step_id,
      s.created_at,
    )
    .run();
  return id;
}

export function getSnapshot(db: D1Database, snapshot_id: string): Promise<Snapshot | null> {
  return db.prepare('SELECT * FROM snapshots WHERE snapshot_id = ?').bind(snapshot_id).first<Snapshot>();
}

// Keys. Licence numbers are normalised on the way in and on the way out.

export async function upsertKey(
  db: D1Database,
  registry: RegistryId,
  licence_number: string,
  link: Record<string, string>,
  now: Date = new Date(),
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO keys (registry, licence_number, link_json, resolved_at) VALUES (?, ?, ?, ?) ON CONFLICT(registry, licence_number) DO UPDATE SET link_json = excluded.link_json, resolved_at = excluded.resolved_at',
    )
    .bind(registry, normaliseLicenceNumber(licence_number), JSON.stringify(link), now.toISOString())
    .run();
}

/** Several keys of one registry in one round trip. A number with no stored key is left out of the map. */
export async function getKeys(
  db: D1Database,
  registry: RegistryId,
  licence_numbers: string[],
): Promise<Map<string, KeyRow>> {
  const found = new Map<string, KeyRow>();
  if (licence_numbers.length === 0) return found;
  const wanted = [...new Set(licence_numbers.map(normaliseLicenceNumber))];
  const read = db.prepare('SELECT * FROM keys WHERE registry = ? AND licence_number = ?');
  const results = await db.batch<KeyRow>(wanted.map((n) => read.bind(registry, n)));
  for (const result of results) {
    for (const row of result.results) found.set(row.licence_number, row);
  }
  return found;
}

export function getKey(db: D1Database, registry: RegistryId, licence_number: string): Promise<KeyRow | null> {
  return db
    .prepare('SELECT * FROM keys WHERE registry = ? AND licence_number = ?')
    .bind(registry, normaliseLicenceNumber(licence_number))
    .first<KeyRow>();
}

// Watches

export async function insertWatch(db: D1Database, w: WatchInput, now: Date = new Date()): Promise<string> {
  const id = newId('w_');
  await db
    .prepare(
      'INSERT INTO watches (watch_id, kind, registry, licence_number, name, monitor_id, caller_webhook, created_at, owner_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      id,
      w.kind,
      w.registry,
      w.licence_number,
      w.name,
      w.monitor_id,
      w.caller_webhook,
      now.toISOString(),
      w.owner_hash ?? null,
    )
    .run();
  return id;
}

export function getWatch(db: D1Database, watch_id: string): Promise<WatchRow | null> {
  return db.prepare('SELECT * FROM watches WHERE watch_id = ?').bind(watch_id).first<WatchRow>();
}

/** The statement behind listWatches, for a caller that runs it inside a batch. */
export function listWatchesStatement(db: D1Database, kind?: WatchInput['kind']): D1PreparedStatement {
  return kind === undefined
    ? db.prepare('SELECT * FROM watches WHERE deleted_at IS NULL ORDER BY created_at ASC, rowid ASC')
    : db
        .prepare('SELECT * FROM watches WHERE deleted_at IS NULL AND kind = ? ORDER BY created_at ASC, rowid ASC')
        .bind(kind);
}

/** Live watches, oldest first. kind narrows the list to one kind. */
export async function listWatches(db: D1Database, kind?: WatchInput['kind']): Promise<WatchRow[]> {
  const { results } = await listWatchesStatement(db, kind).all<WatchRow>();
  return results;
}

/** Sets the owner of a watch that was created through a function which does not take one. */
export async function setWatchOwner(db: D1Database, watch_id: string, owner_hash: string): Promise<void> {
  await db.prepare('UPDATE watches SET owner_hash = ? WHERE watch_id = ?').bind(owner_hash, watch_id).run();
}

export async function updateWatchFields(db: D1Database, watch_id: string, fields: Fields): Promise<void> {
  await db
    .prepare('UPDATE watches SET last_fields_json = ? WHERE watch_id = ?')
    .bind(JSON.stringify(fields), watch_id)
    .run();
}

export async function setWatchTier(
  db: D1Database,
  watch_id: string,
  tier: 'monitor' | 'recheck' | null,
): Promise<void> {
  await db.prepare('UPDATE watches SET tier = ? WHERE watch_id = ?').bind(tier, watch_id).run();
}

export async function bumpFailStreak(db: D1Database, watch_id: string): Promise<number> {
  await db.prepare('UPDATE watches SET fail_streak = fail_streak + 1 WHERE watch_id = ?').bind(watch_id).run();
  const row = await db
    .prepare('SELECT fail_streak FROM watches WHERE watch_id = ?')
    .bind(watch_id)
    .first<{ fail_streak: number }>();
  return row?.fail_streak ?? 0;
}

export function setLastRecheckAtStatement(db: D1Database, watch_id: string, iso: string): D1PreparedStatement {
  return db.prepare('UPDATE watches SET last_recheck_at = ? WHERE watch_id = ?').bind(iso, watch_id);
}

export function setLastComplaintsAtStatement(db: D1Database, watch_id: string, iso: string): D1PreparedStatement {
  return db.prepare('UPDATE watches SET last_complaints_at = ? WHERE watch_id = ?').bind(iso, watch_id);
}

export async function resetFailStreak(db: D1Database, watch_id: string): Promise<void> {
  await db.prepare('UPDATE watches SET fail_streak = 0 WHERE watch_id = ?').bind(watch_id).run();
}

/** Marks the watch deleted. getWatch still returns it; the list and monitor lookups skip it. */
export async function softDeleteWatch(db: D1Database, watch_id: string, now: Date = new Date()): Promise<void> {
  await db
    .prepare('UPDATE watches SET deleted_at = COALESCE(deleted_at, ?) WHERE watch_id = ?')
    .bind(now.toISOString(), watch_id)
    .run();
}

/** Null for an empty id. Deleted watches are skipped, and the newest wins when several share a monitor. */
export async function findWatchByMonitor(db: D1Database, monitor_id: string): Promise<WatchRow | null> {
  if (monitor_id === '') return null;
  return db
    .prepare(
      'SELECT * FROM watches WHERE monitor_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1',
    )
    .bind(monitor_id)
    .first<WatchRow>();
}

// Events

interface EventRow {
  event_id: string;
  watch_id: string;
  kind: string;
  before_json: string | null;
  after_json: string | null;
  evidence_json: string | null;
  created_at: string;
}

/** The insert as a statement, for callers that write many events in one batch. */
export function insertEventStatement(
  db: D1Database,
  e: EventInput,
  now: Date = new Date(),
): { id: string; statement: D1PreparedStatement } {
  const id = newId('ev_');
  const statement = db
    .prepare(
      'INSERT INTO events (event_id, watch_id, kind, before_json, after_json, evidence_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(id, e.watch_id, e.kind, toJson(e.before), toJson(e.after), toJson(e.evidence), now.toISOString());
  return { id, statement };
}

export async function insertEvent(db: D1Database, e: EventInput, now: Date = new Date()): Promise<string> {
  const { id, statement } = insertEventStatement(db, e, now);
  await statement.run();
  return id;
}

const eventOfRow = (r: EventRow): Event => ({
  event_id: r.event_id,
  watch_id: r.watch_id,
  kind: r.kind as Event['kind'],
  before: fromJson<Partial<Fields>>(r.before_json),
  after: fromJson<Partial<Fields>>(r.after_json),
  evidence: fromJson<Event['evidence']>(r.evidence_json) ?? {},
  created_at: r.created_at,
});

/**
 * The live record watches that the admin key made (owner 'ops'), oldest first, each with its
 * latest events, newest first. Two queries however many watches there are.
 */
export async function listAdminWatches(
  db: D1Database,
  eventLimit: number,
): Promise<{ watch: WatchRow; events: Event[] }[]> {
  const adminWatches = "deleted_at IS NULL AND owner_hash = 'ops'";
  const { results: watches } = await db
    .prepare(`SELECT * FROM watches WHERE ${adminWatches} ORDER BY created_at ASC, rowid ASC`)
    .all<WatchRow>();
  if (watches.length === 0) return [];
  const { results: rows } = await db
    .prepare(
      `SELECT event_id, watch_id, kind, before_json, after_json, evidence_json, created_at FROM (
         SELECT e.*, ROW_NUMBER() OVER (PARTITION BY e.watch_id ORDER BY e.created_at DESC, e.rowid DESC) AS n
           FROM events e WHERE e.watch_id IN (SELECT watch_id FROM watches WHERE ${adminWatches})
       ) WHERE n <= ? ORDER BY watch_id, n`,
    )
    .bind(eventLimit)
    .all<EventRow>();
  return watches.map((watch) => ({
    watch,
    events: rows.filter((r) => r.watch_id === watch.watch_id).map(eventOfRow),
  }));
}

/** When the watch's latest event was written, or null when it has none. That is the time of its last run. */
export async function lastEventAt(db: D1Database, watch_id: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT MAX(created_at) AS at FROM events WHERE watch_id = ?')
    .bind(watch_id)
    .first<{ at: string | null }>();
  return row?.at ?? null;
}

/** Newest first. */
export async function listEvents(db: D1Database, watch_id: string): Promise<Event[]> {
  const { results } = await db
    .prepare('SELECT * FROM events WHERE watch_id = ? ORDER BY created_at DESC, rowid DESC')
    .bind(watch_id)
    .all<EventRow>();
  return results.map(eventOfRow);
}

// Queue
//
// Lifecycle: pending -> starting (claimed, paid run not yet started) -> running
// (run id attached) -> done | failed | budget. requeue sends a started job back
// to pending with a not_before time.

/** The insert behind enqueue, for a caller that runs several inserts in one batch. */
export function enqueueStatement(
  db: D1Database,
  job: JobInput,
  now: Date = new Date(),
): { id: string; statement: D1PreparedStatement } {
  const id = newId('job_');
  const statement = db
    .prepare(
      "INSERT INTO queue (job_id, kind, priority, payload_json, state, bucket, reserved_cents, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)",
    )
    .bind(id, job.kind, job.priority, job.payload_json, job.bucket, job.reserved_cents, now.toISOString());
  return { id, statement };
}

export async function enqueue(db: D1Database, job: JobInput, now: Date = new Date()): Promise<string> {
  const { id, statement } = enqueueStatement(db, job, now);
  await statement.run();
  return id;
}

/** Pending jobs whose not_before is unset or no later than now. */
export async function nextJobs(db: D1Database, limit: number, now: Date = new Date()): Promise<JobRow[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM queue WHERE state = 'pending' AND (not_before IS NULL OR not_before <= ?) ORDER BY priority ASC, created_at ASC, rowid ASC LIMIT ?",
    )
    .bind(now.toISOString(), limit)
    .all<JobRow>();
  return results;
}

/** Claims a pending job before any paid run starts. Returns true only when this call moved it. */
export async function startJob(db: D1Database, job_id: string, now: Date = new Date()): Promise<boolean> {
  const result = await db
    .prepare("UPDATE queue SET state = 'starting', started_at = ? WHERE job_id = ? AND state = 'pending'")
    .bind(now.toISOString(), job_id)
    .run();
  return result.meta.changes > 0;
}

/** Attaches the paid run's id to a starting job. Returns true only when this call moved it. */
export async function attachRun(
  db: D1Database,
  job_id: string,
  run_id: string,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE queue SET state = 'running', run_id = ?, started_at = ? WHERE job_id = ? AND state = 'starting'")
    .bind(run_id, now.toISOString(), job_id)
    .run();
  return result.meta.changes > 0;
}

/**
 * Sends a starting or running job back to pending, counts the attempt, and holds it until notBeforeIso.
 * countAttempt false leaves the attempt count alone, for holds that are not the job's fault.
 */
export async function requeue(
  db: D1Database,
  job_id: string,
  notBeforeIso: string,
  countAttempt = true,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE queue SET state = 'pending', attempt = attempt + ?, not_before = ?, run_id = NULL, started_at = NULL WHERE job_id = ? AND state IN ('starting', 'running')",
    )
    .bind(countAttempt ? 1 : 0, notBeforeIso, job_id)
    .run();
  return result.meta.changes > 0;
}

export async function finishJob(
  db: D1Database,
  job_id: string,
  state: 'done' | 'failed' | 'budget',
  now: Date = new Date(),
): Promise<void> {
  await db
    .prepare('UPDATE queue SET state = ?, finished_at = ? WHERE job_id = ?')
    .bind(state, now.toISOString(), job_id)
    .run();
}

/** Jobs holding a slot: starting or running. */
export async function countRunning(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM queue WHERE state IN ('starting', 'running')")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function countPending(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM queue WHERE state = 'pending'").first<{ n: number }>();
  return row?.n ?? 0;
}

/** Starting or running jobs whose started_at is before the cut-off, the oldest first, at most limit of them. */
export async function staleRunning(db: D1Database, olderThanIso: string, limit: number): Promise<JobRow[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM queue WHERE state IN ('starting', 'running') AND started_at < ? ORDER BY started_at ASC LIMIT ?",
    )
    .bind(olderThanIso, limit)
    .all<JobRow>();
  return results;
}

/** The job holding this paid run, whatever its state. Null when no job holds the run. */
export function findJobByRun(db: D1Database, run_id: string): Promise<JobRow | null> {
  return db.prepare('SELECT * FROM queue WHERE run_id = ? LIMIT 1').bind(run_id).first<JobRow>();
}

// Budgets and ledger

/** Adds to the day's bucket and writes a ledger row in one batch, so the two stay in step. */
export async function addSpend(
  db: D1Database,
  day: string,
  bucket: string,
  cents: number,
  run_id: string | null = null,
  now: Date = new Date(),
): Promise<void> {
  // One batch, two statements. The ledger row is written only when this run id has no row yet.
  // The budget is bumped only when that row was written: changes() reads the statement before it.
  // Because the check and the write are one batch, two settles of the same run cannot both count.
  await db.batch([
    db
      .prepare(
        'INSERT INTO ledger (id, cents, run_id, created_at) SELECT ?, ?, ?, ? WHERE ? IS NULL OR NOT EXISTS (SELECT 1 FROM ledger WHERE run_id = ?)',
      )
      .bind(newId('led_'), cents, run_id, now.toISOString(), run_id, run_id),
    db
      .prepare(
        'INSERT INTO budgets (day, bucket, spent_cents) SELECT ?, ?, ? WHERE changes() > 0 ON CONFLICT(day, bucket) DO UPDATE SET spent_cents = budgets.spent_cents + excluded.spent_cents',
      )
      .bind(day, bucket, cents),
  ]);
}

/** Cents spent in the bucket on the UTC day (YYYY-MM-DD). */
export async function spentToday(db: D1Database, day: string, bucket: string): Promise<number> {
  const row = await db
    .prepare('SELECT spent_cents FROM budgets WHERE day = ? AND bucket = ?')
    .bind(day, bucket)
    .first<{ spent_cents: number }>();
  return row?.spent_cents ?? 0;
}

/** Cents in the ledger, over every day and bucket. */
export async function lifetimeSpend(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COALESCE(SUM(cents), 0) AS total FROM ledger').first<{ total: number }>();
  return row?.total ?? 0;
}

// Canaries

export async function insertCanary(
  db: D1Database,
  registry: string,
  ok: boolean,
  detail: string | null,
  now: Date = new Date(),
): Promise<void> {
  await db
    .prepare('INSERT INTO canaries (registry, ran_at, ok, detail) VALUES (?, ?, ?, ?)')
    .bind(registry, now.toISOString(), ok ? 1 : 0, detail)
    .run();
}

/** Newest canary per registry. */
export async function latestCanaries(db: D1Database): Promise<CanaryRow[]> {
  const { results } = await db
    .prepare(
      'SELECT registry, ran_at, ok, detail FROM canaries c WHERE c.rowid = (SELECT c2.rowid FROM canaries c2 WHERE c2.registry = c.registry ORDER BY c2.ran_at DESC, c2.rowid DESC LIMIT 1)',
    )
    .all<{ registry: string; ran_at: string; ok: number; detail: string | null }>();
  return results.map((r) => ({ registry: r.registry, ran_at: r.ran_at, ok: r.ok === 1, detail: r.detail }));
}

// Purge

/**
 * Removes checks older than iso with their unwatched snapshots, snapshots of soft-deleted
 * watches (whatever their age), raw webhooks, seen runs and feed updates older than iso.
 * Live watches and their snapshots, keys, events, budgets, ledger and canaries are kept.
 */
export async function purgeOlderThan(
  db: D1Database,
  iso: string,
): Promise<{
  checks: number;
  snapshots: number;
  raw_webhooks: number;
  seen_runs: number;
  feed_updates: number;
  queue_rows: number;
}> {
  // Snapshots go first: their subquery reads the checks that the next statement deletes.
  const [snapshots, checks, raws, seen, feeds, queued] = await db.batch([
    db
      .prepare(
        `DELETE FROM snapshots
          WHERE (watch_id IS NULL AND check_id IN (SELECT check_id FROM checks WHERE created_at < ?))
             OR watch_id IN (SELECT watch_id FROM watches WHERE deleted_at IS NOT NULL)`,
      )
      .bind(iso),
    db.prepare('DELETE FROM checks WHERE created_at < ?').bind(iso),
    db.prepare('DELETE FROM raw_webhooks WHERE received_at < ?').bind(iso),
    db.prepare('DELETE FROM seen_runs WHERE seen_at < ?').bind(iso),
    db.prepare('DELETE FROM feed_updates WHERE created_at < ?').bind(iso),
    // Finished jobs hold typed names in their payloads, so they go once they are old.
    db
      .prepare(
        "DELETE FROM queue WHERE state IN ('done', 'failed', 'budget') AND COALESCE(finished_at, created_at) < ?",
      )
      .bind(iso),
  ]);
  return {
    checks: checks.meta.changes,
    snapshots: snapshots.meta.changes,
    raw_webhooks: raws.meta.changes,
    seen_runs: seen.meta.changes,
    feed_updates: feeds.meta.changes,
    queue_rows: queued.meta.changes,
  };
}

// Webhook dedupe

/** True when a webhook for this run has already been marked. */
export async function wasWebhookSeen(db: D1Database, run_id: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT EXISTS (SELECT 1 FROM seen_runs WHERE run_id = ?) AS seen')
    .bind(run_id)
    .first<{ seen: number }>();
  return row?.seen === 1;
}

/** When this run id was claimed, or null when it is not claimed. */
export async function webhookSeenAt(db: D1Database, run_id: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT seen_at FROM seen_runs WHERE run_id = ?')
    .bind(run_id)
    .first<{ seen_at: string }>();
  return row?.seen_at ?? null;
}

/** Releases a run id claimed by markWebhookSeen, so a retry of a failed call can process it again. */
export async function unmarkWebhookSeen(db: D1Database, run_id: string): Promise<void> {
  await db.prepare('DELETE FROM seen_runs WHERE run_id = ?').bind(run_id).run();
}

/** Returns true only for the call that inserted the run id, so claiming it is atomic. */
export async function markWebhookSeen(db: D1Database, run_id: string, now: Date = new Date()): Promise<boolean> {
  const result = await db
    .prepare('INSERT OR IGNORE INTO seen_runs (run_id, seen_at) VALUES (?, ?)')
    .bind(run_id, now.toISOString())
    .run();
  return result.meta.changes > 0;
}
