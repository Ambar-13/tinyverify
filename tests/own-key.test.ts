import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { canStart, reservation, settle } from '../src/queue/budget';
import {
  OWN_KEY_GONE,
  OWN_KEY_TTL_MS,
  dropOwnKeyIfDone,
  dropStaleOwnKeys,
  holdOwnKey,
  ownKeyFor,
  readOwnKey,
  setOwnClientFactory,
} from '../src/queue/own-key';
import {
  continuations,
  dispatch,
  enqueue,
  pollOwnRuns,
  QueueFull,
  registerContinuation,
  type Job,
  type Outcome,
} from '../src/queue/queue';
import { insertCheck, lifetimeSpend, spentToday } from '../src/store';
import type { RunResult, TinyFish } from '../src/tinyfish/client';

const db = env.DB;
const KEY = 'tf_test_visitor_key_000';
const held = async (): Promise<{ check_id: string; sealed: string }[]> =>
  (await db.prepare('SELECT check_id, sealed FROM own_keys').all<{ check_id: string; sealed: string }>()).results;
const newCheck = (state: 'queued' | 'searching' = 'queued'): Promise<string> =>
  insertCheck(db, { state, query_json: '{}' }, new Date());

function stub(name: string, runs = new Map<string, RunResult>()) {
  const calls = { runAsync: [] as Record<string, unknown>[], getRun: [] as string[], wallet: 0 };
  const client = {
    async runAsync(request: Record<string, unknown>) {
      calls.runAsync.push(request);
      return { run_id: `run_${name}_${calls.runAsync.length}` };
    },
    async getRun(id: string) {
      calls.getRun.push(id);
      const run = runs.get(id);
      if (!run) throw new Error(`${name} cannot read ${id}`);
      return run;
    },
    async wallet() {
      calls.wallet += 1;
      return { balance_cents: 10_000 };
    },
  };
  return { client: client as unknown as TinyFish, calls, runs };
}

const ownJob = (check_id: string): Omit<Job, 'job_id'> => ({
  kind: 'search',
  priority: 1,
  bucket: 'own',
  reserved_cents: reservation(30),
  payload: { check_id, registry: 'generic', request: { url: 'https://example.test/search', goal: 'Find the licence' } },
});

afterEach(() => {
  setOwnClientFactory(null);
  continuations.clear();
});

describe('reading the key from a request', () => {
  const read = (value?: string): ReturnType<typeof readOwnKey> =>
    readOwnKey(new Headers(value === undefined ? {} : { 'X-TinyFish-Key': value }));

  it('takes a key, trimmed, and treats a missing or empty header as no key', () => {
    expect(read(` ${KEY} `)).toBe(KEY);
    expect(read()).toBe(null);
    expect(read('   ')).toBe(null);
  });

  it('refuses a value with a space or a control character inside, or longer than 200 characters', () => {
    expect(read('two words')).toBe('invalid');
    expect(read('line\tbreak')).toBe('invalid');
    expect(read('k'.repeat(201))).toBe('invalid');
    expect(read('k'.repeat(200))).toBe('k'.repeat(200));
  });
});

describe('holding a key for one check', () => {
  it('stores the key encrypted and gives it back only for its own check', async () => {
    const check_id = await newCheck();
    await holdOwnKey(env, db, check_id, KEY);
    const rows = await held();
    expect(rows).toHaveLength(1);
    expect(rows[0].sealed).not.toContain(KEY);
    expect(atob(rows[0].sealed)).not.toContain(KEY);
    expect(await ownKeyFor(env, db, check_id)).toBe(KEY);
    expect(await ownKeyFor(env, db, 'chk_other')).toBe(null);
  });

  it('seals the same key differently each time', async () => {
    const [a, b] = [await newCheck(), await newCheck()];
    await holdOwnKey(env, db, a, KEY);
    await holdOwnKey(env, db, b, KEY);
    const rows = await held();
    expect(rows[0].sealed).not.toBe(rows[1].sealed);
  });

  it('cannot be opened with another secret, or after the stored text was changed', async () => {
    const check_id = await newCheck();
    await holdOwnKey(env, db, check_id, KEY);
    expect(await ownKeyFor({ ...env, OWN_KEY_SECRET: 'another-secret' }, db, check_id)).toBe(null);
    // The webhook secret is in addresses TinyFish holds, so it must have no part in the sealing.
    expect(await ownKeyFor({ ...env, HOOK_SECRET: 'another-hook-secret' }, db, check_id)).toBe(KEY);
    const [{ sealed }] = await held();
    const changed = sealed.slice(0, -4) + (sealed.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    await db.prepare('UPDATE own_keys SET sealed = ?').bind(changed).run();
    expect(await ownKeyFor(env, db, check_id)).toBe(null);
  });

  it('cannot be opened once its stored text is moved to another check', async () => {
    const [mine, other] = [await newCheck(), await newCheck()];
    await holdOwnKey(env, db, mine, KEY);
    await db.prepare('UPDATE own_keys SET check_id = ? WHERE check_id = ?').bind(other, mine).run();
    expect(await ownKeyFor(env, db, other)).toBe(null);
  });

  it('refuses to hold a key when the sealing secret is not set', async () => {
    const check_id = await newCheck();
    await expect(holdOwnKey({ ...env, OWN_KEY_SECRET: '' }, db, check_id, KEY)).rejects.toThrow('OWN_KEY_SECRET');
    expect(await held()).toHaveLength(0);
  });

  it('keeps the key while the check runs and deletes it once the check is done', async () => {
    const check_id = await newCheck('searching');
    await holdOwnKey(env, db, check_id, KEY);
    await dropOwnKeyIfDone(db, check_id);
    expect(await held()).toHaveLength(1);
    await db.prepare("UPDATE checks SET state = 'done' WHERE check_id = ?").bind(check_id).run();
    await dropOwnKeyIfDone(db, check_id);
    expect(await held()).toHaveLength(0);
  });

  it('deletes a key whose check never finished after 30 minutes', async () => {
    const now = new Date('2026-11-13T12:00:00.000Z');
    const [old, fresh] = [await newCheck(), await newCheck()];
    await holdOwnKey(env, db, old, KEY, new Date(now.getTime() - OWN_KEY_TTL_MS - 1000));
    await holdOwnKey(env, db, fresh, KEY, new Date(now.getTime() - OWN_KEY_TTL_MS + 1000));
    await dropStaleOwnKeys(db, now);
    expect((await held()).map((row) => row.check_id)).toEqual([fresh]);
  });
});

describe("the budget for a lookup on the visitor's key", () => {
  it('is never refused, even when every limit of this service is zero, and reads no wallet', async () => {
    const broke = { ...env, PUBLIC_DAILY_CENTS: '0', CEILING_CENTS: '0', WALLET_FLOOR_CENTS: '999999' };
    const shared = stub('shared');
    expect(await canStart(broke, db, shared.client, 'own', 96)).toEqual({ ok: true });
    expect(shared.calls.wallet).toBe(0);
    expect((await canStart(broke, db, shared.client, 'public', 96)).ok).toBe(false);
  });

  it('leaves no line in the ledger and holds nothing against the other buckets', async () => {
    await settle(db, 'own', 96, 30, 'run_own_1');
    expect(await lifetimeSpend(db)).toBe(0);
    expect(await spentToday(db, new Date().toISOString().slice(0, 10), 'own')).toBe(0);
    const check_id = await newCheck();
    await holdOwnKey(env, db, check_id, KEY);
    const shared = stub('shared');
    setOwnClientFactory(() => stub('own').client);
    await enqueue(db, ownJob(check_id));
    await dispatch(env, db, shared.client);
    const tight = { ...env, CEILING_CENTS: '96' };
    expect(await canStart(tight, db, shared.client, 'public', 96)).toEqual({ ok: true });
  });
});

describe("a queued job on the visitor's key", () => {
  it('starts on a client made from that key, with no webhook address, and never on the shared client', async () => {
    const check_id = await newCheck();
    await holdOwnKey(env, db, check_id, KEY);
    const shared = stub('shared');
    const own = stub('own');
    const keysUsed: string[] = [];
    setOwnClientFactory((key) => (keysUsed.push(key), own.client));
    await enqueue(db, ownJob(check_id));

    expect(await dispatch(env, db, shared.client)).toBe(1);

    expect(keysUsed).toEqual([KEY]);
    expect(shared.calls.runAsync).toHaveLength(0);
    expect(own.calls.runAsync).toHaveLength(1);
    expect(own.calls.runAsync[0]).not.toHaveProperty('webhook_url');
    expect(JSON.stringify(own.calls.runAsync[0])).not.toContain(env.HOOK_SECRET);
  });

  it('gives a job of this service its webhook address as before', async () => {
    const shared = stub('shared');
    await enqueue(db, { ...ownJob(await newCheck()), bucket: 'judge' });
    await dispatch(env, db, shared.client);
    expect(shared.calls.runAsync[0].webhook_url).toContain('/hooks/tinyfish/run/');
  });

  it('takes none of the two run slots of this service, and has two of its own', async () => {
    const shared = stub('shared');
    const own = stub('own');
    setOwnClientFactory(() => own.client);
    for (let i = 0; i < 3; i++) {
      const check_id = await newCheck();
      await holdOwnKey(env, db, check_id, KEY);
      await enqueue(db, ownJob(check_id));
    }
    for (let i = 0; i < 3; i++) await enqueue(db, { ...ownJob(await newCheck()), bucket: 'judge' });

    expect(await dispatch(env, db, shared.client)).toBe(4);

    expect(own.calls.runAsync).toHaveLength(2);
    expect(shared.calls.runAsync).toHaveLength(2);
    const waiting = await db
      .prepare("SELECT bucket, COUNT(*) AS n FROM queue WHERE state = 'pending' GROUP BY bucket ORDER BY bucket")
      .all<{ bucket: string; n: number }>();
    expect(waiting.results).toEqual([
      { bucket: 'judge', n: 1 },
      { bucket: 'own', n: 1 },
    ]);
  });

  it('is never queued past eight, however many arrive at the same moment', async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 14 }, async () => enqueue(db, ownJob(await newCheck()))),
    );

    const queued =
      (await db.prepare("SELECT COUNT(*) AS n FROM queue WHERE bucket = 'own'").first<{ n: number }>())?.n ?? 0;
    expect(queued).toBeLessThanOrEqual(8);
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(queued);
    for (const a of attempts) if (a.status === 'rejected') expect(a.reason).toBeInstanceOf(QueueFull);

    // One at a time, the queue takes exactly eight, and a job of this service is still let in after that.
    await db.prepare('DELETE FROM queue').run();
    for (let i = 0; i < 8; i++) await enqueue(db, ownJob(await newCheck()));
    await expect(enqueue(db, ownJob(await newCheck()))).rejects.toBeInstanceOf(QueueFull);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM queue WHERE bucket = 'own'").first<{ n: number }>())?.n).toBe(
      8,
    );
    await expect(enqueue(db, { ...ownJob(await newCheck()), bucket: 'public' })).resolves.toBeDefined();
  });

  it('waits for a key that is not stored yet, then starts once it is', async () => {
    const check_id = await newCheck();
    const shared = stub('shared');
    const own = stub('own');
    setOwnClientFactory(() => own.client);
    const { job_id } = await enqueue(db, ownJob(check_id));

    expect(await dispatch(env, db, shared.client)).toBe(0);
    const waiting = await db
      .prepare('SELECT state, attempt FROM queue WHERE job_id = ?')
      .bind(job_id)
      .first<{ state: string; attempt: number }>();
    expect(waiting).toEqual({ state: 'pending', attempt: 0 });
    expect(shared.calls.runAsync).toHaveLength(0);

    await holdOwnKey(env, db, check_id, KEY);
    await db.prepare('UPDATE queue SET not_before = NULL WHERE job_id = ?').bind(job_id).run();
    expect(await dispatch(env, db, shared.client)).toBe(1);
    expect(own.calls.runAsync).toHaveLength(1);
  });

  it('ends a job whose key never arrived, says why, and spends nothing', async () => {
    const check_id = await newCheck();
    const shared = stub('shared');
    const heard: Outcome[] = [];
    registerContinuation('search', async (_env, _db, _client, _job, outcome) => void heard.push(outcome));
    const { job_id } = await enqueue(db, ownJob(check_id));
    await db.prepare("UPDATE queue SET created_at = '2026-01-01T00:00:00.000Z' WHERE job_id = ?").bind(job_id).run();

    await dispatch(env, db, shared.client);

    expect(heard).toEqual([{ reason: 'timeout', message: OWN_KEY_GONE }]);
    expect(shared.calls.runAsync).toHaveLength(0);
    expect(
      (await db.prepare('SELECT state FROM queue WHERE job_id = ?').bind(job_id).first<{ state: string }>())?.state,
    ).toBe('failed');
  });

  it("is found finished by polling with the visitor's key, and the key is deleted when its check is done", async () => {
    const check_id = await newCheck('searching');
    await holdOwnKey(env, db, check_id, KEY);
    const shared = stub('shared');
    const own = stub('own');
    setOwnClientFactory(() => own.client);
    const seen: { outcome: Outcome; client: TinyFish }[] = [];
    registerContinuation('search', async (_env, d1, client, job, outcome) => {
      seen.push({ outcome, client });
      await d1.prepare("UPDATE checks SET state = 'done' WHERE check_id = ?").bind(job.payload.check_id).run();
    });
    await enqueue(db, ownJob(check_id));
    await dispatch(env, db, shared.client);

    expect(await pollOwnRuns(env, db, shared.client, check_id)).toBe(0);
    expect(await held()).toHaveLength(1);

    own.runs.set('run_own_1', {
      run_id: 'run_own_1',
      status: 'COMPLETED',
      result: { rows: [] },
      steps: [],
      steps_used: 4,
      error: null,
    });
    expect(await pollOwnRuns(env, db, shared.client, check_id)).toBe(1);

    expect(shared.calls.getRun).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(seen[0].client).toBe(own.client);
    expect(seen[0].outcome).toMatchObject({ status: 'COMPLETED', steps_used: 4 });
    expect(await held()).toHaveLength(0);
    expect(await lifetimeSpend(db)).toBe(0);
  });

  it('polls only the check asked about', async () => {
    const [mine, theirs] = [await newCheck('searching'), await newCheck('searching')];
    const shared = stub('shared');
    const own = stub('own');
    setOwnClientFactory(() => own.client);
    for (const check_id of [mine, theirs]) {
      await holdOwnKey(env, db, check_id, KEY);
      await enqueue(db, ownJob(check_id));
    }
    await dispatch(env, db, shared.client);
    own.calls.getRun.length = 0;
    await pollOwnRuns(env, db, shared.client, mine);
    expect(own.calls.getRun).toHaveLength(1);
  });
});
