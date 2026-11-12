import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  addSpend,
  attachRun,
  countPending,
  countRunning,
  enqueue,
  finishJob,
  findCachedCheck,
  findWatchByMonitor,
  bumpFailStreak,
  resetFailStreak,
  setWatchTier,
  getCheck,
  getKey,
  getKeys,
  getSnapshot,
  getWatch,
  insertCanary,
  insertCheck,
  insertEvent,
  insertRawWebhook,
  insertSnapshot,
  insertWatch,
  latestCanaries,
  lifetimeSpend,
  listEvents,
  listWatches,
  markWebhookSeen,
  nextJobs,
  purgeOlderThan,
  requeue,
  softDeleteWatch,
  spentToday,
  staleRunning,
  startJob,
  updateCheck,
  updateWatchFields,
  upsertKey,
  wasWebhookSeen,
  type WatchInput,
} from '../src/store';
import type { Fields, Snapshot } from '../src/types';

const db = env.DB;
const OLD = new Date('2026-01-01T00:00:00.000Z');
const RECENT = new Date('2026-11-03T12:00:00.000Z');
const HOUR_MS = 3_600_000;

const fields = (over: Partial<Fields> = {}): Fields => ({
  name: 'SAMPLE, PERSON A',
  licence_number: 'ME000000',
  status_raw: 'Clear/Active',
  status: 'active',
  expires: '2028-01-31',
  issued: '2026-04-20',
  licence_type: 'Medical Doctor',
  discipline_flag: false,
  discipline_actions: [],
  data_as_of: '2026-11-03',
  city: 'SAMPLE CITY, AA 00000',
  other_names: [],
  ...over,
});

const snapshot = (over: Partial<Omit<Snapshot, 'snapshot_id'>> = {}): Omit<Snapshot, 'snapshot_id'> => ({
  check_id: null,
  watch_id: null,
  registry: 'fl-mqa',
  url: 'https://example.test/search',
  reader_input: 'fetch_html',
  content_sha256: 'deadbeef',
  body: '<p>hello</p>',
  run_id: null,
  step_id: null,
  created_at: RECENT.toISOString(),
  ...over,
});

const watchInput: WatchInput = {
  kind: 'record',
  registry: 'fl-mqa',
  licence_number: 'ME000000',
  name: 'SAMPLE, PERSON A',
  monitor_id: 'mon_1',
  caller_webhook: 'https://example.test/hook',
};

const job = { kind: 'verify', priority: 0, payload_json: '{}', bucket: 'public', reserved_cents: 5 };

const jobRow = (job_id: string) =>
  db
    .prepare('SELECT state, run_id, attempt, not_before, started_at, finished_at FROM queue WHERE job_id = ?')
    .bind(job_id)
    .first<{
      state: string;
      run_id: string | null;
      attempt: number;
      not_before: string | null;
      started_at: string | null;
      finished_at: string | null;
    }>();

describe('insertRawWebhook', () => {
  it('stores the body with a received_at time', async () => {
    await insertRawWebhook(db, 'monitor', '{"a":1}');
    const row = await db.prepare('SELECT source, body FROM raw_webhooks').first<{ source: string; body: string }>();
    expect(row).toEqual({ source: 'monitor', body: '{"a":1}' });
  });
});

describe('checks', () => {
  it('generates chk_ ids and reads back what was inserted', async () => {
    const id = await insertCheck(db, { state: 'queued', query_json: '{"q":1}' }, RECENT);
    expect(id.startsWith('chk_')).toBe(true);
    const row = await getCheck(db, id);
    expect(row?.state).toBe('queued');
    expect(row?.query_json).toBe('{"q":1}');
    expect(row?.created_at).toBe(RECENT.toISOString());
  });

  it('returns null for an unknown check', async () => {
    expect(await getCheck(db, 'chk_missing')).toBeNull();
  });

  it('updateCheck patches state and result_json', async () => {
    const id = await insertCheck(db, { state: 'searching' }, RECENT);
    await updateCheck(db, id, { state: 'done', result_json: '{"outcome":"match"}' });
    const row = await getCheck(db, id);
    expect(row?.state).toBe('done');
    expect(row?.result_json).toBe('{"outcome":"match"}');
  });

  it('findCachedCheck returns the newest done check inside the window', async () => {
    await insertCheck(
      db,
      { state: 'done', cache_key: 'k1', result_json: '{"v":1}' },
      new Date(RECENT.getTime() - 60_000),
    );
    const newer = await insertCheck(db, { state: 'done', cache_key: 'k1', result_json: '{"v":2}' }, RECENT);
    const hit = await findCachedCheck(db, 'k1', 3600, RECENT);
    expect(hit?.check_id).toBe(newer);
  });

  it('findCachedCheck still finds a done check inside the window when it is not the newest by key', async () => {
    const inside = await insertCheck(db, { state: 'done', cache_key: 'k5' }, new Date(RECENT.getTime() - 1800_000));
    expect((await findCachedCheck(db, 'k5', 3600, RECENT))?.check_id).toBe(inside);
  });

  it('findCachedCheck ignores checks older than the window', async () => {
    await insertCheck(db, { state: 'done', cache_key: 'k2' }, new Date(RECENT.getTime() - 2 * HOUR_MS));
    expect(await findCachedCheck(db, 'k2', 3600, RECENT)).toBeNull();
  });

  it('findCachedCheck ignores checks that are not done', async () => {
    await insertCheck(db, { state: 'done', cache_key: 'k3' }, new Date(RECENT.getTime() - 60_000));
    await insertCheck(db, { state: 'reading', cache_key: 'k3' }, RECENT);
    expect((await findCachedCheck(db, 'k3', 3600, RECENT))?.state).toBe('done');
  });

  it('findCachedCheck returns null for an unknown key', async () => {
    expect(await findCachedCheck(db, 'nope', 3600, RECENT)).toBeNull();
  });
});

describe('snapshots', () => {
  it('generates snap_ ids and round-trips the row', async () => {
    const id = await insertSnapshot(db, snapshot({ run_id: 'run-1', step_id: 'step-1' }));
    expect(id.startsWith('snap_')).toBe(true);
    const row = await getSnapshot(db, id);
    expect(row?.body).toBe('<p>hello</p>');
    expect(row?.content_sha256).toBe('deadbeef');
    expect(row?.run_id).toBe('run-1');
    expect(row?.watch_id).toBeNull();
  });

  it('returns null for an unknown snapshot', async () => {
    expect(await getSnapshot(db, 'snap_missing')).toBeNull();
  });
});

describe('keys', () => {
  it('upsertKey updates in place when called twice', async () => {
    await upsertKey(db, 'fl-mqa', 'ME1', { a: 'https://x/1' }, OLD);
    await upsertKey(db, 'fl-mqa', 'ME1', { a: 'https://x/2' }, RECENT);
    const count = await db
      .prepare('SELECT COUNT(*) AS n FROM keys WHERE registry = ? AND licence_number = ?')
      .bind('fl-mqa', 'ME1')
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
    const key = await getKey(db, 'fl-mqa', 'ME1');
    expect(key?.link_json).toBe(JSON.stringify({ a: 'https://x/2' }));
    expect(key?.resolved_at).toBe(RECENT.toISOString());
  });

  it('getKey returns null for an unknown key', async () => {
    expect(await getKey(db, 'fl-mqa', 'NONE')).toBeNull();
  });

  it('upsertKey and getKey normalise the licence number', async () => {
    await upsertKey(db, 'fl-mqa', 'ME000000', { a: 'https://x/1' }, RECENT);
    const key = await getKey(db, 'fl-mqa', ' me 000000 ');
    expect(key?.licence_number).toBe('ME000000');
    expect(key?.link_json).toBe(JSON.stringify({ a: 'https://x/1' }));
    await upsertKey(db, 'fl-mqa', ' me 000000 ', { a: 'https://x/2' }, RECENT);
    const count = await db.prepare('SELECT COUNT(*) AS n FROM keys').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});

describe('watches', () => {
  it('insertWatch generates a w_ id and listWatches returns the watches of a kind', async () => {
    const a = await insertWatch(db, watchInput, RECENT);
    await insertWatch(db, { ...watchInput, monitor_id: 'mon_2' }, RECENT);
    expect(a.startsWith('w_')).toBe(true);
    expect(await listWatches(db)).toHaveLength(2);
    const record = await listWatches(db, 'record');
    expect(record).toHaveLength(2);
    expect(record[0].watch_id).toBe(a);
  });

  it('stores null watch fields as NULL', async () => {
    const id = await insertWatch(
      db,
      {
        kind: 'record',
        registry: 'fl-dbpr',
        licence_number: null,
        name: null,
        monitor_id: 'mon_n',
        caller_webhook: null,
      },
      RECENT,
    );
    const row = await getWatch(db, id);
    expect(row?.licence_number).toBeNull();
    expect(row?.name).toBeNull();
    expect(row?.caller_webhook).toBeNull();
    expect(row?.kind).toBe('record');
  });

  it('findWatchByMonitor returns null immediately for an empty monitor id', async () => {
    await insertWatch(db, { ...watchInput, monitor_id: '' }, RECENT);
    expect(await findWatchByMonitor(db, '')).toBeNull();
  });

  it('softDeleteWatch hides the watch from listWatches and findWatchByMonitor but keeps the row', async () => {
    const id = await insertWatch(db, watchInput, RECENT);
    expect((await findWatchByMonitor(db, 'mon_1'))?.watch_id).toBe(id);
    await softDeleteWatch(db, id, RECENT);
    expect(await listWatches(db)).toHaveLength(0);
    expect(await findWatchByMonitor(db, 'mon_1')).toBeNull();
    expect((await getWatch(db, id))?.deleted_at).toBe(RECENT.toISOString());
  });

  it('updateWatchFields stores the fields as JSON', async () => {
    const id = await insertWatch(db, watchInput, RECENT);
    const f = fields({ status: 'suspended', discipline_actions: ['Fine'] });
    await updateWatchFields(db, id, f);
    const row = await getWatch(db, id);
    expect(JSON.parse(row?.last_fields_json ?? 'null')).toEqual(f);
  });
});

describe('events', () => {
  it('insertEvent generates an ev_ id and listEvents returns newest first with parsed JSON', async () => {
    const w = await insertWatch(db, watchInput, RECENT);
    const older = await insertEvent(
      db,
      { watch_id: w, kind: 'unchanged', before: null, after: null, evidence: {} },
      OLD,
    );
    const newer = await insertEvent(
      db,
      {
        watch_id: w,
        kind: 'status_change',
        before: { status: 'active' },
        after: { status: 'suspended' },
        evidence: { snapshot_id: 'snap_1', line: 'Suspended 3 Nov' },
      },
      RECENT,
    );
    expect(older.startsWith('ev_')).toBe(true);
    const events = await listEvents(db, w);
    expect(events.map((e) => e.event_id)).toEqual([newer, older]);
    expect(events[0].before).toEqual({ status: 'active' });
    expect(events[0].after).toEqual({ status: 'suspended' });
    expect(events[0].evidence).toEqual({ snapshot_id: 'snap_1', line: 'Suspended 3 Nov' });
  });

  it('listEvents only returns events for the given watch', async () => {
    const w1 = await insertWatch(db, watchInput, RECENT);
    const w2 = await insertWatch(db, { ...watchInput, monitor_id: 'mon_2' }, RECENT);
    await insertEvent(db, { watch_id: w2, kind: 'check_failed', before: null, after: null, evidence: {} }, RECENT);
    expect(await listEvents(db, w1)).toHaveLength(0);
  });
});

describe('queue', () => {
  it('enqueue sets state pending and returns a job_ id', async () => {
    const id = await enqueue(db, job, RECENT);
    expect(id.startsWith('job_')).toBe(true);
    expect((await jobRow(id))?.state).toBe('pending');
    expect(await countPending(db)).toBe(1);
  });

  it('nextJobs orders by priority then created_at and skips started jobs', async () => {
    const a = await enqueue(db, { ...job, priority: 1 }, new Date('2026-11-03T10:00:02.000Z'));
    const b = await enqueue(db, { ...job, priority: 0 }, new Date('2026-11-03T10:00:03.000Z'));
    const c = await enqueue(db, { ...job, priority: 0 }, new Date('2026-11-03T10:00:01.000Z'));
    expect((await nextJobs(db, 10, RECENT)).map((j) => j.job_id)).toEqual([c, b, a]);
    await startJob(db, c, RECENT);
    expect((await nextJobs(db, 10, RECENT)).map((j) => j.job_id)).toEqual([b, a]);
    expect((await nextJobs(db, 1, RECENT)).map((j) => j.job_id)).toEqual([b]);
  });

  it('nextJobs skips a job whose not_before is after now', async () => {
    const id = await enqueue(db, job, OLD);
    await startJob(db, id, OLD);
    await attachRun(db, id, 'run-retry', OLD);
    await requeue(db, id, '2026-11-03T13:00:00.000Z');
    expect(await nextJobs(db, 10, new Date('2026-11-03T12:00:00.000Z'))).toEqual([]);
    expect((await nextJobs(db, 10, new Date('2026-11-03T13:00:00.000Z'))).map((j) => j.job_id)).toEqual([id]);
  });

  it('startJob moves pending to starting, returns true once, and refuses a job that is not pending', async () => {
    const id = await enqueue(db, job, RECENT);
    expect(await startJob(db, id, RECENT)).toBe(true);
    expect((await jobRow(id))?.state).toBe('starting');
    expect(await startJob(db, id, RECENT)).toBe(false);
    expect(await countPending(db)).toBe(0);
  });

  it('attachRun moves starting to running and sets run_id and started_at', async () => {
    const id = await enqueue(db, job, RECENT);
    await startJob(db, id, OLD);
    expect(await attachRun(db, id, 'run-1', RECENT)).toBe(true);
    const row = await jobRow(id);
    expect(row?.state).toBe('running');
    expect(row?.run_id).toBe('run-1');
    expect(row?.started_at).toBe(RECENT.toISOString());
  });

  it('attachRun refuses a job that was never started', async () => {
    const id = await enqueue(db, job, RECENT);
    expect(await attachRun(db, id, 'run-x', RECENT)).toBe(false);
    expect((await jobRow(id))?.state).toBe('pending');
    expect((await jobRow(id))?.run_id).toBeNull();
  });

  it('requeue moves a started job back to pending, increments attempt and sets not_before', async () => {
    const id = await enqueue(db, job, RECENT);
    await startJob(db, id, RECENT);
    await attachRun(db, id, 'run-1', RECENT);
    expect(await requeue(db, id, '2026-11-03T14:00:00.000Z')).toBe(true);
    const row = await jobRow(id);
    expect(row?.state).toBe('pending');
    expect(row?.attempt).toBe(1);
    expect(row?.not_before).toBe('2026-11-03T14:00:00.000Z');
    expect(await requeue(db, id, '2026-11-03T15:00:00.000Z')).toBe(false);
    await startJob(db, id, RECENT);
    await attachRun(db, id, 'run-2', RECENT);
    expect(await requeue(db, id, '2026-11-03T15:00:00.000Z')).toBe(true);
    expect((await jobRow(id))?.attempt).toBe(2);
  });

  it('requeue refuses a finished job', async () => {
    const id = await enqueue(db, job, RECENT);
    await startJob(db, id, RECENT);
    await finishJob(db, id, 'done', RECENT);
    expect(await requeue(db, id, '2026-11-03T14:00:00.000Z')).toBe(false);
    expect((await jobRow(id))?.state).toBe('done');
  });

  it('finishJob sets the state and finished_at, including budget', async () => {
    const id = await enqueue(db, job, RECENT);
    await startJob(db, id, RECENT);
    await attachRun(db, id, 'run-1', RECENT);
    await finishJob(db, id, 'budget', RECENT);
    const row = await jobRow(id);
    expect(row?.state).toBe('budget');
    expect(row?.finished_at).toBe(RECENT.toISOString());
  });

  it('countRunning counts both starting and running jobs', async () => {
    const a = await enqueue(db, job, RECENT);
    const b = await enqueue(db, job, RECENT);
    await enqueue(db, job, RECENT);
    expect(await countRunning(db)).toBe(0);
    await startJob(db, a, RECENT);
    expect(await countRunning(db)).toBe(1);
    await startJob(db, b, RECENT);
    await attachRun(db, b, 'run-b', RECENT);
    expect(await countRunning(db)).toBe(2);
    expect(await countPending(db)).toBe(1);
  });

  it('staleRunning includes starting and running rows started before the cut-off', async () => {
    const starting = await enqueue(db, job, OLD);
    await startJob(db, starting, OLD);
    const running = await enqueue(db, job, OLD);
    await startJob(db, running, OLD);
    await attachRun(db, running, 'run-old', OLD);
    const ids = (await staleRunning(db, '2026-06-01T00:00:00.000Z', 50)).map((j) => j.job_id).sort();
    expect(ids).toEqual([starting, running].sort());
    expect(await staleRunning(db, '2025-01-01T00:00:00.000Z', 50)).toEqual([]);
  });
});

describe('staleRunning limit', () => {
  it('returns at most the limit, the oldest first', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const at = new Date(OLD.getTime() + i * HOUR_MS);
      const id = await enqueue(db, job, at);
      await startJob(db, id, at);
      ids.push(id);
    }
    const some = await staleRunning(db, '2026-06-01T00:00:00.000Z', 5);
    expect(some.map((j) => j.job_id)).toEqual(ids.slice(0, 5));
    expect((await staleRunning(db, '2026-06-01T00:00:00.000Z', 2)).map((j) => j.job_id)).toEqual(ids.slice(0, 2));
  });
});

describe('getKeys', () => {
  it('reads several keys of one registry in one call, normalising numbers, and leaves out the missing ones', async () => {
    await upsertKey(db, 'fl-dbpr', 'CCC0000001', { id: 'a' }, OLD);
    await upsertKey(db, 'fl-dbpr', 'CCC0000002', { id: 'b' }, OLD);
    await upsertKey(db, 'fl-mqa', 'CCC0000003', { id: 'other registry' }, OLD);
    const keys = await getKeys(db, 'fl-dbpr', ['ccc 0000001', 'CCC0000002', 'CCC0000003', 'CCC0000099']);
    expect([...keys.keys()].sort()).toEqual(['CCC0000001', 'CCC0000002']);
    expect(JSON.parse(keys.get('CCC0000001')?.link_json ?? 'null')).toEqual({ id: 'a' });
  });

  it('returns an empty map for no numbers, without a query', async () => {
    expect((await getKeys(db, 'fl-dbpr', [])).size).toBe(0);
  });
});

describe('webhook dedupe', () => {
  it('markWebhookSeen returns true only for the first insert, and wasWebhookSeen reads it', async () => {
    expect(await wasWebhookSeen(db, 'run-1')).toBe(false);
    expect(await markWebhookSeen(db, 'run-1', RECENT)).toBe(true);
    expect(await markWebhookSeen(db, 'run-1', RECENT)).toBe(false);
    expect(await wasWebhookSeen(db, 'run-1')).toBe(true);
    expect(await wasWebhookSeen(db, 'run-2')).toBe(false);
  });

  it('a run id carried by a queue job does not count as a seen webhook', async () => {
    const id = await enqueue(db, job, RECENT);
    await startJob(db, id, RECENT);
    await attachRun(db, id, 'run-q', RECENT);
    expect(await wasWebhookSeen(db, 'run-q')).toBe(false);
  });
});

describe('budgets', () => {
  it('addSpend adds to the day and bucket, and lifetimeSpend stays in step with the ledger', async () => {
    await addSpend(db, '2026-11-03', 'public', 50, 'run-1', RECENT);
    await addSpend(db, '2026-11-03', 'public', 25, 'run-2', RECENT);
    await addSpend(db, '2026-11-03', 'judge', 10, null, RECENT);
    await addSpend(db, '2026-11-02', 'public', 99, null, RECENT);
    expect(await spentToday(db, '2026-11-03', 'public')).toBe(75);
    expect(await spentToday(db, '2026-11-03', 'ops')).toBe(0);
    expect(await lifetimeSpend(db)).toBe(184);
    const ledgerRows = await db.prepare('SELECT COUNT(*) AS n FROM ledger').first<{ n: number }>();
    expect(ledgerRows?.n).toBe(4);
  });
});

describe('canaries', () => {
  it('latestCanaries returns the newest row per registry', async () => {
    await insertCanary(db, 'fl-mqa', true, 'fine', OLD);
    await insertCanary(db, 'fl-mqa', false, 'boom', RECENT);
    await insertCanary(db, 'ca-cslb', true, null, OLD);
    const latest = await latestCanaries(db);
    expect(latest).toHaveLength(2);
    const flMqa = latest.find((c) => c.registry === 'fl-mqa');
    expect(flMqa?.ok).toBe(false);
    expect(flMqa?.detail).toBe('boom');
    expect(flMqa?.ran_at).toBe(RECENT.toISOString());
  });
});

describe('purgeOlderThan', () => {
  it('purges a snapshot of a soft-deleted watch and keeps one of a live watch, whatever their age', async () => {
    const live = await insertWatch(db, watchInput, RECENT);
    const gone = await insertWatch(db, { ...watchInput, monitor_id: 'mon_gone' }, RECENT);
    await softDeleteWatch(db, gone, RECENT);
    const goneSnap = await insertSnapshot(db, snapshot({ watch_id: gone, created_at: RECENT.toISOString() }));
    const liveSnap = await insertSnapshot(db, snapshot({ watch_id: live, created_at: RECENT.toISOString() }));

    const result = await purgeOlderThan(db, '2026-06-01T00:00:00.000Z');
    expect(result.snapshots).toBe(1);
    expect(await getSnapshot(db, goneSnap)).toBeNull();
    expect(await getSnapshot(db, liveSnap)).not.toBeNull();
    expect(await getWatch(db, gone)).not.toBeNull();
  });

  it('purges old checks, old seen runs and old feed updates, and spares everything else', async () => {
    const oldCheck = await insertCheck(db, { state: 'done', cache_key: 'k' }, OLD);
    const recentCheck = await insertCheck(db, { state: 'done', cache_key: 'k2' }, RECENT);
    const w = await insertWatch(db, watchInput, OLD);
    const deleted = await insertWatch(db, { ...watchInput, monitor_id: 'mon_del' }, OLD);
    await softDeleteWatch(db, deleted, RECENT);

    const unwatched = await insertSnapshot(db, snapshot({ check_id: oldCheck, created_at: OLD.toISOString() }));
    const watched = await insertSnapshot(
      db,
      snapshot({ check_id: oldCheck, watch_id: w, created_at: OLD.toISOString() }),
    );
    const kept = await insertSnapshot(db, snapshot({ check_id: recentCheck, created_at: RECENT.toISOString() }));

    await upsertKey(db, 'fl-mqa', 'ME1', { a: 'https://x/1' }, OLD);
    const ev = await insertEvent(db, { watch_id: w, kind: 'unchanged', before: null, after: null, evidence: {} }, OLD);
    await addSpend(db, '2026-01-01', 'public', 40, null, OLD);
    await insertCanary(db, 'fl-mqa', true, null, OLD);
    await db
      .prepare('INSERT INTO raw_webhooks (id, source, body, received_at) VALUES (?, ?, ?, ?)')
      .bind('rw_old', 'monitor', '{}', OLD.toISOString())
      .run();
    await db
      .prepare('INSERT INTO raw_webhooks (id, source, body, received_at) VALUES (?, ?, ?, ?)')
      .bind('rw_new', 'run', '{}', RECENT.toISOString())
      .run();
    await markWebhookSeen(db, 'run-old', OLD);
    await markWebhookSeen(db, 'run-new', RECENT);
    const addFeedUpdate = (id: string, at: Date) =>
      db
        .prepare('INSERT INTO feed_updates (id, registry, run_id, added_lines, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(id, 'fl-mqa', `run-${id}`, '[]', at.toISOString())
        .run();
    await addFeedUpdate('fu_old', OLD);
    await addFeedUpdate('fu_new', RECENT);

    const result = await purgeOlderThan(db, '2026-06-01T00:00:00.000Z');
    expect(result).toEqual({ checks: 1, snapshots: 1, raw_webhooks: 1, seen_runs: 1, feed_updates: 1, queue_rows: 0 });

    expect(await getCheck(db, oldCheck)).toBeNull();
    expect(await getCheck(db, recentCheck)).not.toBeNull();
    expect(await getSnapshot(db, unwatched)).toBeNull();
    expect(await getSnapshot(db, watched)).not.toBeNull();
    expect(await getSnapshot(db, kept)).not.toBeNull();
    expect(await getKey(db, 'fl-mqa', 'ME1')).not.toBeNull();
    expect(await getWatch(db, w)).not.toBeNull();
    expect((await listEvents(db, w)).map((e) => e.event_id)).toEqual([ev]);
    expect(await spentToday(db, '2026-01-01', 'public')).toBe(40);
    expect(await lifetimeSpend(db)).toBe(40);
    expect(await latestCanaries(db)).toHaveLength(1);
    const remaining = await db.prepare('SELECT id FROM raw_webhooks').all<{ id: string }>();
    expect(remaining.results.map((r) => r.id)).toEqual(['rw_new']);
    expect(await wasWebhookSeen(db, 'run-old')).toBe(false);
    expect(await wasWebhookSeen(db, 'run-new')).toBe(true);
    const feeds = await db.prepare('SELECT id FROM feed_updates').all<{ id: string }>();
    expect(feeds.results.map((r) => r.id)).toEqual(['fu_new']);
  });
});

describe('watch tier and failure streak', () => {
  it('stores the tier and reads it back from getWatch', async () => {
    const w = await insertWatch(db, watchInput);
    expect((await getWatch(db, w))?.tier).toBeNull();
    await setWatchTier(db, w, 'recheck');
    expect((await getWatch(db, w))?.tier).toBe('recheck');
    await setWatchTier(db, w, null);
    expect((await getWatch(db, w))?.tier).toBeNull();
  });

  it('counts the streak up and resets it to zero', async () => {
    const w = await insertWatch(db, watchInput);
    expect((await getWatch(db, w))?.fail_streak).toBe(0);
    expect(await bumpFailStreak(db, w)).toBe(1);
    expect(await bumpFailStreak(db, w)).toBe(2);
    await resetFailStreak(db, w);
    expect((await getWatch(db, w))?.fail_streak).toBe(0);
  });
});

describe('purgeOlderThan queue rows', () => {
  it('deletes finished jobs older than the cut-off and keeps pending and recent ones', async () => {
    const oldDone = await enqueue(
      db,
      { kind: 'search', priority: 2, payload_json: '{"name":"A"}', bucket: 'ops', reserved_cents: 0 },
      OLD,
    );
    await finishJob(db, oldDone, 'done', OLD);
    const oldFailed = await enqueue(
      db,
      { kind: 'search', priority: 2, payload_json: '{}', bucket: 'ops', reserved_cents: 0 },
      OLD,
    );
    await finishJob(db, oldFailed, 'failed', OLD);
    const recentDone = await enqueue(
      db,
      { kind: 'search', priority: 2, payload_json: '{}', bucket: 'ops', reserved_cents: 0 },
      RECENT,
    );
    await finishJob(db, recentDone, 'done', RECENT);
    const pending = await enqueue(
      db,
      { kind: 'search', priority: 2, payload_json: '{}', bucket: 'ops', reserved_cents: 0 },
      OLD,
    );

    const result = await purgeOlderThan(db, '2026-06-01T00:00:00.000Z');
    expect(result.queue_rows).toBe(2);
    const left = await db.prepare('SELECT job_id FROM queue ORDER BY job_id').all<{ job_id: string }>();
    expect(left.results.map((r) => r.job_id).sort()).toEqual([recentDone, pending].sort());
  });
});
