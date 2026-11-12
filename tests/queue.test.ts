import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CENTS_PER_STEP, reservation, resetWalletCache, settle } from '../src/queue/budget';
import {
  continuations,
  dispatch,
  enqueue,
  enqueueBatch,
  onRunFinished,
  QueueFull,
  registerContinuation,
  safeDetail,
  sweep,
  type Job,
} from '../src/queue/queue';
import {
  attachRun,
  countPending,
  countRunning,
  finishJob,
  markWebhookSeen,
  requeue,
  spentToday,
  startJob,
  wasWebhookSeen,
} from '../src/store';
import type { RegistryId } from '../src/types';
import { TinyFishError, type RunResult, type TinyFish } from '../src/tinyfish/client';

const db = env.DB;
const OLD = new Date('2026-01-01T00:00:00.000Z');
const HOUR_MS = 3_600_000;
const today = () => new Date().toISOString().slice(0, 10);

const request = { url: 'https://example.test/search', goal: 'Find the licence' };

function job(over: Partial<Omit<Job, 'job_id'>> = {}): Omit<Job, 'job_id'> {
  return {
    kind: 'search',
    priority: 2,
    bucket: 'public',
    reserved_cents: reservation(10),
    payload: { registry: 'fl-mqa' as RegistryId, request },
    ...over,
  };
}

function result(over: Partial<RunResult> = {}): RunResult {
  return {
    run_id: 'run_x',
    status: 'COMPLETED',
    result: {},
    steps: [],
    steps_used: 0,
    error: null,
    ...over,
  };
}

function stubClient() {
  const calls = {
    runAsync: [] as Parameters<TinyFish['runAsync']>[0][],
    getRun: [] as string[],
  };
  const state = {
    walletFails: false,
    runCount: 0,
    fail: null as Error | null,
    runs: new Map<string, RunResult>(),
    streamingUrl: undefined as string | undefined,
  };
  const stub = {
    async runAsync(req: Parameters<TinyFish['runAsync']>[0]) {
      calls.runAsync.push(req);
      if (state.fail) throw state.fail;
      state.runCount += 1;
      return { run_id: `run_${state.runCount}`, streaming_url: state.streamingUrl };
    },
    async getRun(id: string) {
      calls.getRun.push(id);
      const found = state.runs.get(id);
      if (!found) throw new Error(`no stub run ${id}`);
      return found;
    },
    async wallet() {
      if (state.walletFails) throw new TinyFishError('network', 0, 'no wallet');
      return { balance_cents: 10_000 };
    },
  };
  return { client: stub as unknown as TinyFish, calls, state };
}

async function stateOf(job_id: string) {
  return db
    .prepare('SELECT state, attempt, not_before, run_id FROM queue WHERE job_id = ?')
    .bind(job_id)
    .first<{ state: string; attempt: number; not_before: string | null; run_id: string | null }>();
}

// Enqueues a job and claims it with a run, as dispatch would.
async function runningJob(over: Partial<Omit<Job, 'job_id'>>, run_id: string, at?: Date): Promise<string> {
  const { job_id } = await enqueue(db, job(over));
  await startJob(db, job_id, at);
  await attachRun(db, job_id, run_id, at);
  return job_id;
}

beforeEach(() => {
  resetWalletCache();
  continuations.clear();
});

describe('enqueue', () => {
  it('returns the job id and its position among pending jobs of equal or higher priority', async () => {
    const a = await enqueue(db, job({ priority: 2 }));
    const b = await enqueue(db, job({ priority: 1 }));
    const c = await enqueue(db, job({ priority: 3 }));
    expect(a.job_id).toMatch(/^job_/);
    expect(a.position).toBe(1);
    expect(b.position).toBe(1);
    expect(c.position).toBe(3);
  });

  it('throws QueueFull once 50 jobs are pending', async () => {
    for (let i = 0; i < 50; i += 1) await enqueue(db, job());
    expect(await countPending(db)).toBe(50);
    await expect(enqueue(db, job())).rejects.toBeInstanceOf(QueueFull);
    expect(await countPending(db)).toBe(50);
  });
});

describe('dispatch', () => {
  it('starts nothing while two runs are already running', async () => {
    const { client, calls } = stubClient();
    await runningJob({}, 'run_a');
    await runningJob({}, 'run_b');
    const { job_id } = await enqueue(db, job());

    expect(await dispatch(env, db, client)).toBe(0);
    expect(calls.runAsync).toHaveLength(0);
    expect((await stateOf(job_id))?.state).toBe('pending');
  });

  it('starts a priority 1 job before an older priority 3 job', async () => {
    const { client, calls } = stubClient();
    await runningJob({}, 'run_a');
    await enqueue(
      db,
      job({ priority: 3, payload: { registry: 'fl-mqa', request: { ...request, url: 'https://example.test/old' } } }),
    );
    await enqueue(
      db,
      job({ priority: 1, payload: { registry: 'fl-mqa', request: { ...request, url: 'https://example.test/new' } } }),
    );

    expect(await dispatch(env, db, client)).toBe(1);
    expect(calls.runAsync[0]?.url).toBe('https://example.test/new');
  });

  it('sends the run request with the webhook url built from BASE_URL and HOOK_SECRET', async () => {
    const { client, calls } = stubClient();
    await enqueue(db, job());

    await dispatch(env, db, client);
    expect(calls.runAsync[0]?.webhook_url).toBe(`${env.BASE_URL}/hooks/tinyfish/run/${env.HOOK_SECRET}`);
    expect(calls.runAsync[0]?.goal).toBe(request.goal);
  });

  it('finishes a job refused by canStart as budget and calls its continuation with reason budget', async () => {
    const { client, calls } = stubClient();
    const seen: unknown[] = [];
    registerContinuation('search', async (_env, _db, _client, j, outcome) => {
      seen.push([j.job_id, outcome]);
    });
    // A reservation above the 200 cent public daily limit is refused.
    const { job_id } = await enqueue(db, job({ reserved_cents: 10_000 }));

    expect(await dispatch(env, db, client)).toBe(0);
    expect(calls.runAsync).toHaveLength(0);
    expect((await stateOf(job_id))?.state).toBe('budget');
    expect(seen).toEqual([[job_id, expect.objectContaining({ reason: 'budget' })]]);
  });

  it('marks a refused job budget even when its kind has no continuation', async () => {
    const { client } = stubClient();
    const { job_id } = await enqueue(db, job({ kind: 'canary', reserved_cents: 10_000 }));

    await expect(dispatch(env, db, client)).resolves.toBe(0);
    expect((await stateOf(job_id))?.state).toBe('budget');
  });

  it('requeues a job for 30 seconds after a first TinyFishError from runAsync', async () => {
    const { client, state } = stubClient();
    state.fail = new TinyFishError('rate_limited', 429, 'busy');
    const { job_id } = await enqueue(db, job());
    const before = Date.now();

    expect(await dispatch(env, db, client)).toBe(0);
    const row = await stateOf(job_id);
    expect(row?.state).toBe('pending');
    expect(row?.attempt).toBe(1);
    const notBefore = Date.parse(row?.not_before ?? '');
    expect(notBefore).toBeGreaterThanOrEqual(before + 29_000);
    expect(notBefore).toBeLessThanOrEqual(Date.now() + 31_000);
  });

  it('finishes a job failed at once, with reason source_unavailable, when the step cap is refused', async () => {
    const { client, state, calls } = stubClient();
    state.fail = new TinyFishError('step_cap_unavailable', 403, 'The account has no custom step cap');
    const seen: unknown[] = [];
    registerContinuation('search', async (_env, _db, _client, _job, outcome) => {
      seen.push(outcome);
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { job_id } = await enqueue(db, job());

    expect(await dispatch(env, db, client)).toBe(0);

    expect(calls.runAsync).toHaveLength(1);
    expect((await stateOf(job_id))?.state).toBe('failed');
    expect(seen).toEqual([{ reason: 'source_unavailable' }]);
    const logged = error.mock.calls.filter((c) => String(c[0]).includes('AGENT_STEP_CAP'));
    expect(logged).toHaveLength(1);
    expect(String(logged[0][0])).toContain('"off"');
    error.mockRestore();
  });

  describe('a refused start', () => {
    const refusal = (status: number, code: string, detail?: string): TinyFishError => {
      const err = new TinyFishError(code, status, `TinyFish returned HTTP ${status}`);
      err.detail = detail;
      return err;
    };

    it('is not retried on a 400: the job fails at once, the continuation hears start_refused, and one line says what TinyFish said', async () => {
      const { client, state, calls } = stubClient();
      state.fail = refusal(400, 'INVALID_INPUT', 'goal is too long');
      const seen: unknown[] = [];
      registerContinuation('discipline', async (_env, _db, _client, _job, outcome) => {
        seen.push(outcome);
      });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { job_id } = await enqueue(
        db,
        job({
          kind: 'discipline',
          payload: { registry: 'fl-dbpr' as RegistryId, request: { ...request, goal: 'SECRET GOAL TEXT' } },
        }),
      );

      expect(await dispatch(env, db, client)).toBe(0);

      expect(calls.runAsync).toHaveLength(1);
      const row = await stateOf(job_id);
      expect(row?.state).toBe('failed');
      expect(seen).toEqual([{ reason: 'start_refused' }]);
      expect(error).toHaveBeenCalledTimes(1);
      const line = String(error.mock.calls[0][0]);
      for (const part of ['discipline', 'fl-dbpr', '400', 'INVALID_INPUT', 'goal is too long'])
        expect(line).toContain(part);
      expect(line).not.toMatch(/https?:\/\//);
      expect(line).not.toContain('SECRET GOAL TEXT');
      error.mockRestore();
    });

    it('is not retried on a 422 either', async () => {
      const { client, state } = stubClient();
      state.fail = refusal(422, 'INVALID_INPUT');
      const seen: unknown[] = [];
      registerContinuation('search', async (_env, _db, _client, _job, outcome) => {
        seen.push(outcome);
      });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { job_id } = await enqueue(db, job());
      await dispatch(env, db, client);
      expect((await stateOf(job_id))?.state).toBe('failed');
      expect(seen).toEqual([{ reason: 'start_refused' }]);
      error.mockRestore();
    });

    it.each([408, 409, 425])(
      'retries a %i like a 500: the job goes back to pending, nothing is logged and no continuation is called',
      async (status) => {
        const { client, state } = stubClient();
        state.fail = refusal(status, 'http_error');
        const seen: unknown[] = [];
        registerContinuation('search', async (_env, _db, _client, _job, outcome) => {
          seen.push(outcome);
        });
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { job_id } = await enqueue(db, job());
        await dispatch(env, db, client);
        const row = await stateOf(job_id);
        expect(row?.state).toBe('pending');
        expect(row?.attempt).toBe(1);
        expect(seen).toEqual([]);
        expect(error).not.toHaveBeenCalled();
        error.mockRestore();
      },
    );

    it.each([400, 401, 402, 403, 422])(
      'refuses the start on a %i: the job fails at once and the continuation hears start_refused',
      async (status) => {
        const { client, state } = stubClient();
        state.fail = refusal(status, 'http_error');
        const seen: unknown[] = [];
        registerContinuation('search', async (_env, _db, _client, _job, outcome) => {
          seen.push(outcome);
        });
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { job_id } = await enqueue(db, job());
        await dispatch(env, db, client);
        expect((await stateOf(job_id))?.state).toBe('failed');
        expect(seen).toEqual([{ reason: 'start_refused' }]);
        error.mockRestore();
      },
    );

    it('still retries a 500 once, with nothing logged and no continuation call', async () => {
      const { client, state } = stubClient();
      state.fail = refusal(500, 'http_error');
      const seen: unknown[] = [];
      registerContinuation('search', async (_env, _db, _client, _job, outcome) => {
        seen.push(outcome);
      });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { job_id } = await enqueue(db, job());
      await dispatch(env, db, client);
      const row = await stateOf(job_id);
      expect(row?.state).toBe('pending');
      expect(row?.attempt).toBe(1);
      expect(seen).toEqual([]);
      expect(error).not.toHaveBeenCalled();
      error.mockRestore();
    });

    it('still retries a network error once', async () => {
      const { client, state } = stubClient();
      state.fail = new TinyFishError('network', 0, 'Could not reach TinyFish');
      const { job_id } = await enqueue(db, job());
      await dispatch(env, db, client);
      expect((await stateOf(job_id))?.state).toBe('pending');
    });

    it('ends a 500 that repeats with reason timeout, as before', async () => {
      const { client, state } = stubClient();
      state.fail = refusal(500, 'http_error');
      const seen: unknown[] = [];
      registerContinuation('search', async (_env, _db, _client, _job, outcome) => {
        seen.push(outcome);
      });
      const { job_id } = await enqueue(db, job());
      await dispatch(env, db, client);
      await db.prepare('UPDATE queue SET not_before = NULL WHERE job_id = ?').bind(job_id).run();
      await dispatch(env, db, client);
      expect(seen).toEqual([{ reason: 'timeout' }]);
    });
  });

  it('finishes failed and calls the continuation with reason timeout after a second TinyFishError', async () => {
    const { client, state } = stubClient();
    const seen: unknown[] = [];
    registerContinuation('search', async (_env, _db, _client, _job, outcome) => {
      seen.push(outcome);
    });
    state.fail = new TinyFishError('rate_limited', 429, 'busy');
    const { job_id } = await enqueue(db, job());

    await dispatch(env, db, client);
    // Lift the 30 second hold so the retry is picked up now.
    await db.prepare('UPDATE queue SET not_before = NULL WHERE job_id = ?').bind(job_id).run();
    await dispatch(env, db, client);

    expect((await stateOf(job_id))?.state).toBe('failed');
    expect(seen).toEqual([{ reason: 'timeout' }]);
  });

  it('never claims a third slot when a second dispatcher claims between the check and the re-count', async () => {
    const { client, calls } = stubClient();
    await runningJob({}, 'run_a');
    const { job_id: first } = await enqueue(db, job());
    const { job_id: second } = await enqueue(db, job());

    // The second count query is the re-count after this dispatcher claims its job.
    // Before answering it, another caller claims the second job, so three slots are held.
    let counts = 0;
    const racing = {
      prepare(sql: string) {
        const statement = db.prepare(sql);
        const isCount = sql.startsWith('SELECT COUNT(*) AS n FROM queue WHERE state IN');
        if (!isCount) return statement;
        return {
          async first<T>() {
            counts += 1;
            if (counts === 2) await startJob(db, second);
            return statement.first<T>();
          },
        };
      },
    } as unknown as D1Database;

    expect(await dispatch(env, racing, client)).toBe(0);
    expect(calls.runAsync).toHaveLength(0);
    expect(await countRunning(db)).toBe(2);
    const row = await stateOf(first);
    expect(row?.state).toBe('pending');
    // The slot overflow is not the job's fault, so the attempt is not counted.
    expect(row?.attempt).toBe(0);
    expect(row?.not_before).not.toBeNull();
  });

  it('keeps the retry for a job bounced on slot overflow: its next TinyFishError is still requeued, not failed', async () => {
    const { client, state } = stubClient();
    await runningJob({}, 'run_a');
    const { job_id } = await enqueue(db, job());
    const { job_id: other } = await enqueue(db, job());
    let counts = 0;
    const racing = {
      prepare(sql: string) {
        const statement = db.prepare(sql);
        if (!sql.startsWith('SELECT COUNT(*) AS n FROM queue WHERE state IN')) return statement;
        return {
          async first<T>() {
            counts += 1;
            // Another caller claims the second job between the claim and the re-count.
            if (counts === 2) await startJob(db, other);
            return statement.first<T>();
          },
        };
      },
    } as unknown as D1Database;
    await dispatch(env, racing, client);
    expect((await stateOf(job_id))?.attempt).toBe(0);
    // The other caller's claim is released, so the next dispatch has a free slot.
    await finishJob(db, other, 'done');

    // The next real attempt fails: attempt 0 means the job is requeued, not finished.
    await db.prepare('UPDATE queue SET not_before = NULL WHERE job_id = ?').bind(job_id).run();
    state.fail = new TinyFishError('rate_limited', 429, 'busy');
    await dispatch(env, db, client);
    const row = await stateOf(job_id);
    expect(row?.state).toBe('pending');
    expect(row?.attempt).toBe(1);
  });

  it('keeps at most two runs when two dispatchers run at the same time', async () => {
    const { client, calls } = stubClient();
    await enqueue(db, job());
    await enqueue(db, job());
    await enqueue(db, job());

    await Promise.all([dispatch(env, db, client), dispatch(env, db, client)]);
    expect(calls.runAsync.length).toBeLessThanOrEqual(2);
    expect(await countRunning(db)).toBeLessThanOrEqual(2);
  });
});

describe('onRunFinished', () => {
  it('settles the spend and marks a completed job done, then calls its continuation', async () => {
    const { client } = stubClient();
    const seen: unknown[] = [];
    registerContinuation('search', async (_env, _db, _client, _job, outcome) => {
      seen.push(outcome);
    });
    const job_id = await runningJob({}, 'run_a');
    const run = result({ run_id: 'run_a', status: 'COMPLETED', steps_used: 5 });

    await onRunFinished(env, db, client, run);
    expect((await stateOf(job_id))?.state).toBe('done');
    expect(await spentToday(db, today(), 'public')).toBe(Math.ceil(5 * 1.6));
    expect(seen).toEqual([run]);
  });

  it('settles the real steps and warns once when a run used more steps than were held', async () => {
    const { client } = stubClient();
    registerContinuation('search', async () => {});
    // reservation(10) is 16 cents: 10 held steps. The run used 13.
    await runningJob({}, 'run_over');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await onRunFinished(env, db, client, result({ run_id: 'run_over', steps_used: 13 }));

    expect(await spentToday(db, today(), 'public')).toBe(Math.ceil(13 * 1.6));
    const logged = warn.mock.calls.filter((c) => String(c[0]).includes('run used more steps than were held'));
    expect(logged).toHaveLength(1);
    expect(String(logged[0][0])).toContain('run_over');
    expect(String(logged[0][0])).toContain('13');
    expect(String(logged[0][0])).toContain('10');
    warn.mockRestore();
  });

  it('does not warn when the run stays within the steps held', async () => {
    const { client } = stubClient();
    registerContinuation('search', async () => {});
    await runningJob({}, 'run_ok');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await onRunFinished(env, db, client, result({ run_id: 'run_ok', steps_used: 10 }));

    expect(warn.mock.calls.filter((c) => String(c[0]).includes('more steps than were held'))).toHaveLength(0);
    warn.mockRestore();
  });

  it('is idempotent by run id: a repeated webhook changes nothing', async () => {
    const { client } = stubClient();
    let calls = 0;
    registerContinuation('search', async () => {
      calls += 1;
    });
    await runningJob({}, 'run_a');
    const run = result({ run_id: 'run_a', steps_used: 5 });

    await onRunFinished(env, db, client, run);
    await onRunFinished(env, db, client, run);
    expect(calls).toBe(1);
    expect(await spentToday(db, today(), 'public')).toBe(Math.ceil(5 * 1.6));
    expect(await wasWebhookSeen(db, 'run_a')).toBe(true);
  });

  it('releases the claim for a run no job holds, and spends nothing', async () => {
    const { client } = stubClient();
    let calls = 0;
    registerContinuation('search', async () => {
      calls += 1;
    });
    const run = result({ run_id: 'run_unknown', steps_used: 3 });
    await onRunFinished(env, db, client, run);
    expect(await wasWebhookSeen(db, 'run_unknown')).toBe(false);
    expect(calls).toBe(0);
    expect(await spentToday(db, today(), 'ops')).toBe(0);
    expect(await spentToday(db, today(), 'public')).toBe(0);
  });

  it('a webhook before attachRun is released, and a later sweep settles the run once against the job bucket', async () => {
    const { client, state } = stubClient();
    const seen: unknown[] = [];
    registerContinuation('search', async (_env, _db, _client, _job, outcome) => {
      seen.push(outcome);
    });
    state.runs.set('run_early', result({ run_id: 'run_early', status: 'COMPLETED', steps_used: 3 }));

    // The webhook arrives before attachRun: no job holds the run, so it is released, not settled.
    await onRunFinished(env, db, client, result({ run_id: 'run_early', steps_used: 3 }));
    expect(await wasWebhookSeen(db, 'run_early')).toBe(false);
    expect(await spentToday(db, today(), 'public')).toBe(0);
    expect(await spentToday(db, today(), 'ops')).toBe(0);

    // The run is attached afterwards, and sweep finds it terminal.
    const job_id = await runningJob({}, 'run_early', OLD);
    expect(await sweep(env, db, client)).toBe(1);
    expect((await stateOf(job_id))?.state).toBe('done');
    expect(seen).toHaveLength(1);
    expect(await spentToday(db, today(), 'public')).toBe(Math.ceil(3 * 1.6));
    expect(await spentToday(db, today(), 'ops')).toBe(0);
  });

  it.each(['SYSTEM_FAILURE', 'UNKNOWN'])(
    're-enqueues a %s failure once, without the continuation, then reaches it as timeout',
    async (code) => {
      const { client } = stubClient();
      const seen: unknown[] = [];
      registerContinuation('search', async (_env, _db, _client, _job, outcome) => {
        seen.push(outcome);
      });
      const job_id = await runningJob({}, 'run_a');
      const before = Date.now();

      await onRunFinished(
        env,
        db,
        client,
        result({ run_id: 'run_a', status: 'FAILED', error: { code, message: 'x' } }),
      );
      const row = await stateOf(job_id);
      expect(row?.state).toBe('pending');
      expect(row?.attempt).toBe(1);
      expect(Date.parse(row?.not_before ?? '')).toBeGreaterThanOrEqual(before + 29_000);
      expect(seen).toHaveLength(0);

      await startJob(db, job_id);
      await attachRun(db, job_id, 'run_b');
      await onRunFinished(
        env,
        db,
        client,
        result({ run_id: 'run_b', status: 'FAILED', error: { code, message: 'x' } }),
      );
      expect((await stateOf(job_id))?.state).toBe('failed');
      expect(seen).toEqual([{ reason: 'timeout' }]);
    },
  );

  it('passes other failures to the continuation as the run, without a retry', async () => {
    const { client } = stubClient();
    const seen: unknown[] = [];
    registerContinuation('search', async (_env, _db, _client, _job, outcome) => {
      seen.push(outcome);
    });
    const job_id = await runningJob({}, 'run_a');
    const run = result({ run_id: 'run_a', status: 'FAILED', error: { code: 'AGENT_FAILURE', message: 'x' } });

    await onRunFinished(env, db, client, run);
    expect((await stateOf(job_id))?.state).toBe('failed');
    expect(seen).toEqual([run]);
  });

  it('ignores a late webhook for a job that was requeued, and for its new run', async () => {
    const { client } = stubClient();
    let calls = 0;
    registerContinuation('search', async () => {
      calls += 1;
    });
    const job_id = await runningJob({}, 'run_old');
    await requeue(db, job_id, new Date(Date.now() + HOUR_MS).toISOString());

    await onRunFinished(env, db, client, result({ run_id: 'run_old', steps_used: 4 }));
    expect((await stateOf(job_id))?.state).toBe('pending');
    expect(calls).toBe(0);
    expect(await spentToday(db, today(), 'public')).toBe(0);

    await startJob(db, job_id);
    await attachRun(db, job_id, 'run_new');
    await onRunFinished(env, db, client, result({ run_id: 'run_old', steps_used: 4 }));
    expect((await stateOf(job_id))?.state).toBe('running');
    expect(calls).toBe(0);
  });

  it('marks the run only after processing, so a call that throws can be retried', async () => {
    const { client } = stubClient();
    let calls = 0;
    registerContinuation('search', async () => {
      calls += 1;
      if (calls === 1) throw new Error('continuation broke');
    });
    const job_id = await runningJob({}, 'run_a');
    const run = result({ run_id: 'run_a', steps_used: 5 });

    await expect(onRunFinished(env, db, client, run)).rejects.toThrow('continuation broke');
    expect(await wasWebhookSeen(db, 'run_a')).toBe(false);

    await onRunFinished(env, db, client, run);
    expect(await wasWebhookSeen(db, 'run_a')).toBe(true);
    expect((await stateOf(job_id))?.state).toBe('done');
    // The spend was recorded once, by the first call; the retry is not settled again.
    expect(await spentToday(db, today(), 'public')).toBe(Math.ceil(5 * 1.6));
  });

  it('marks a job done without error when its kind has no continuation', async () => {
    const { client } = stubClient();
    const job_id = await runningJob({ kind: 'canary' }, 'run_a');

    await expect(onRunFinished(env, db, client, result({ run_id: 'run_a' }))).resolves.toBeUndefined();
    expect((await stateOf(job_id))?.state).toBe('done');
  });
});

describe('requeue attempt counting', () => {
  it('leaves the attempt count alone when countAttempt is false', async () => {
    const { job_id } = await enqueue(db, job());
    await startJob(db, job_id);
    await requeue(db, job_id, new Date().toISOString(), false);
    expect((await stateOf(job_id))?.attempt).toBe(0);
    expect((await stateOf(job_id))?.state).toBe('pending');
  });
});

describe('idempotent settling per run id', () => {
  it('adds the cents of a run once when the same run is settled twice', async () => {
    await settle(db, 'public', 10, 5, 'run_dup');
    await settle(db, 'public', 10, 5, 'run_dup');
    expect(await spentToday(db, today(), 'public')).toBe(Math.ceil(5 * 1.6));
    const ledger = await db
      .prepare('SELECT COUNT(*) AS n FROM ledger WHERE run_id = ?')
      .bind('run_dup')
      .first<{ n: number }>();
    expect(ledger?.n).toBe(1);
  });

  it('adds the cents once when two settles of the same run are in flight together', async () => {
    await Promise.all([settle(db, 'public', 10, 5, 'run_race'), settle(db, 'public', 10, 5, 'run_race')]);
    expect(await spentToday(db, today(), 'public')).toBe(Math.ceil(5 * 1.6));
  });

  it('spends once when onRunFinished and sweep handle the same completed run at the same time', async () => {
    const { client, state } = stubClient();
    await runningJob({}, 'run_w', OLD);
    const run = result({ run_id: 'run_w', status: 'COMPLETED', steps_used: 5 });
    state.runs.set('run_w', run);

    await Promise.all([onRunFinished(env, db, client, run), sweep(env, db, client)]);
    expect(await spentToday(db, today(), 'public')).toBe(Math.ceil(5 * 1.6));
  });

  it('spends once when sweep polls a run that onRunFinished already settled', async () => {
    const { client, state } = stubClient();
    const job_id = await runningJob({}, 'run_w2', OLD);
    const run = result({ run_id: 'run_w2', status: 'COMPLETED', steps_used: 5 });
    state.runs.set('run_w2', run);

    await onRunFinished(env, db, client, run);
    // Put the job back to running, as a sweep that read the row earlier would have seen it.
    await db.prepare("UPDATE queue SET state = 'running' WHERE job_id = ?").bind(job_id).run();
    await sweep(env, db, client);
    expect(await spentToday(db, today(), 'public')).toBe(Math.ceil(5 * 1.6));
  });
});

describe('claim-first processing', () => {
  it('a second call with the same run returns without settling or calling the continuation again', async () => {
    const { client } = stubClient();
    let calls = 0;
    registerContinuation('search', async () => {
      calls += 1;
    });
    await runningJob({}, 'run_c');
    const run = result({ run_id: 'run_c', steps_used: 5 });

    await onRunFinished(env, db, client, run);
    await onRunFinished(env, db, client, run);
    expect(calls).toBe(1);
    expect(await spentToday(db, today(), 'public')).toBe(Math.ceil(5 * 1.6));
  });

  it('a processing error releases the claim, so a later call processes the run', async () => {
    const { client } = stubClient();
    let calls = 0;
    registerContinuation('search', async () => {
      calls += 1;
      if (calls === 1) throw new Error('continuation broke');
    });
    const job_id = await runningJob({}, 'run_e');
    const run = result({ run_id: 'run_e', steps_used: 5 });

    await expect(onRunFinished(env, db, client, run)).rejects.toThrow('continuation broke');
    expect((await stateOf(job_id))?.state).toBe('running');

    await onRunFinished(env, db, client, run);
    expect(calls).toBe(2);
    expect((await stateOf(job_id))?.state).toBe('done');
    expect(await spentToday(db, today(), 'public')).toBe(Math.ceil(5 * 1.6));

    await onRunFinished(env, db, client, run);
    expect(calls).toBe(2);
  });
});

describe('orphaned paid runs', () => {
  it('counts the cost from the reservation when attachRun fails in dispatch', async () => {
    const { client } = stubClient();
    const { job_id } = await enqueue(db, job({ reserved_cents: reservation(10) }));
    // Make attachRun lose its claim: the first attach statement sees the job already moved.
    const losing = {
      prepare(sql: string) {
        if (!sql.startsWith("UPDATE queue SET state = 'running'")) return db.prepare(sql);
        return {
          bind: (...args: unknown[]) => ({
            run: async () => {
              await db.prepare("UPDATE queue SET state = 'pending' WHERE job_id = ?").bind(job_id).run();
              return db
                .prepare(sql)
                .bind(...args)
                .run();
            },
          }),
        };
      },
      batch: (statements: D1PreparedStatement[]) => db.batch(statements),
    } as unknown as D1Database;

    await dispatch(env, losing, client);
    const steps = Math.ceil(reservation(10) / CENTS_PER_STEP);
    expect(await spentToday(db, today(), 'public')).toBe(Math.ceil(steps * CENTS_PER_STEP));
    const ledger = await db
      .prepare('SELECT COUNT(*) AS n FROM ledger WHERE run_id = ?')
      .bind('run_1')
      .first<{ n: number }>();
    expect(ledger?.n).toBe(1);
  });
});

describe('retry cap', () => {
  it('settles from the reservation when attachRun throws, then rethrows', async () => {
    const { client } = stubClient();
    const { job_id } = await enqueue(db, job({ reserved_cents: reservation(10) }));
    // The first attach statement throws once, as a store failure would, then works.
    let thrown = false;
    const failing = {
      prepare(sql: string) {
        if (!sql.startsWith("UPDATE queue SET state = 'running'") || thrown) return db.prepare(sql);
        return {
          bind: (...args: unknown[]) => ({
            run: async () => {
              thrown = true;
              throw new Error('store unavailable');
            },
          }),
        };
      },
      batch: (statements: D1PreparedStatement[]) => db.batch(statements),
    } as unknown as D1Database;

    await expect(dispatch(env, failing, client)).rejects.toThrow('store unavailable');
    const steps = Math.ceil(reservation(10) / CENTS_PER_STEP);
    expect(await spentToday(db, today(), 'public')).toBe(Math.ceil(steps * CENTS_PER_STEP));
    const ledger = await db
      .prepare('SELECT COUNT(*) AS n FROM ledger WHERE run_id = ?')
      .bind('run_1')
      .first<{ n: number }>();
    expect(ledger?.n).toBe(1);
    // The job is still starting, so sweep requeues it later; the spend is not counted twice.
    expect((await stateOf(job_id))?.state).toBe('starting');
  });

  it('a non-TinyFish error from runAsync requeues counting an attempt, then rethrows', async () => {
    const { client, state } = stubClient();
    state.fail = new Error('socket reset');
    const { job_id } = await enqueue(db, job());

    await expect(dispatch(env, db, client)).rejects.toThrow('socket reset');
    const row = await stateOf(job_id);
    expect(row?.state).toBe('pending');
    expect(row?.attempt).toBe(1);
  });

  it('a non-TinyFish error on a job that has used its attempt finishes it failed as timeout, then rethrows', async () => {
    const { client, state } = stubClient();
    const seen: unknown[] = [];
    registerContinuation('search', async (_env, _db, _client, _job, outcome) => {
      seen.push(outcome);
    });
    state.fail = new Error('socket reset');
    const { job_id } = await enqueue(db, job());
    await db.prepare('UPDATE queue SET attempt = 1 WHERE job_id = ?').bind(job_id).run();

    await expect(dispatch(env, db, client)).rejects.toThrow('socket reset');
    expect((await stateOf(job_id))?.state).toBe('failed');
    expect(seen).toEqual([{ reason: 'timeout' }]);
  });

  it('sweep finishes a starting job that has used its attempt as timeout instead of requeuing it', async () => {
    const { client } = stubClient();
    const seen: unknown[] = [];
    registerContinuation('search', async (_env, _db, _client, _job, outcome) => {
      seen.push(outcome);
    });
    const { job_id } = await enqueue(db, job());
    await startJob(db, job_id, OLD);
    await db.prepare('UPDATE queue SET attempt = 1 WHERE job_id = ?').bind(job_id).run();

    expect(await sweep(env, db, client)).toBe(1);
    expect((await stateOf(job_id))?.state).toBe('failed');
    expect(seen).toEqual([{ reason: 'timeout' }]);
  });
});

describe('dispatch per-call limits', () => {
  it('considers at most 10 pending jobs in one call', async () => {
    const { client, calls } = stubClient();
    // Ten jobs the ops bucket refuses come first; the judge job is eleventh and is not considered.
    for (let i = 0; i < 10; i += 1) await enqueue(db, job({ priority: 1, bucket: 'ops', reserved_cents: 10_000 }));
    const { job_id: judge } = await enqueue(db, job({ priority: 2, bucket: 'judge' }));

    expect(await dispatch(env, db, client)).toBe(0);
    expect(calls.runAsync).toHaveLength(0);
    expect((await stateOf(judge))?.state).toBe('pending');
  });

  it('after canStart refuses a bucket, skips the rest of that bucket but starts other buckets', async () => {
    const { client, calls } = stubClient();
    const { job_id: refusedA } = await enqueue(db, job({ priority: 1, bucket: 'ops', reserved_cents: 10_000 }));
    const { job_id: refusedB } = await enqueue(db, job({ priority: 1, bucket: 'ops', reserved_cents: 10_000 }));
    const { job_id: publicJob } = await enqueue(db, job({ priority: 2, bucket: 'public' }));

    expect(await dispatch(env, db, client)).toBe(1);
    expect(calls.runAsync).toHaveLength(1);
    expect((await stateOf(refusedA))?.state).toBe('budget');
    expect((await stateOf(refusedB))?.state).toBe('pending');
    expect((await stateOf(publicJob))?.state).toBe('running');
  });

  it('stops after two failed starts in one call', async () => {
    const { client, calls, state } = stubClient();
    state.fail = new TinyFishError('rate_limited', 429, 'busy');
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push((await enqueue(db, job())).job_id);

    expect(await dispatch(env, db, client)).toBe(0);
    expect(calls.runAsync).toHaveLength(2);
    expect((await stateOf(ids[2]!))?.attempt).toBe(0);
    expect((await stateOf(ids[2]!))?.state).toBe('pending');
  });
});

describe('streaming url', () => {
  it('is kept in the job payload when runAsync returns one', async () => {
    const { client, state } = stubClient();
    state.streamingUrl = 'https://stream.example/run';
    const { job_id } = await enqueue(db, job());

    await dispatch(env, db, client);
    const row = await db
      .prepare('SELECT payload_json FROM queue WHERE job_id = ?')
      .bind(job_id)
      .first<{ payload_json: string }>();
    expect(JSON.parse(row?.payload_json ?? '{}').streaming_url).toBe('https://stream.example/run');
    expect(JSON.parse(row?.payload_json ?? '{}').registry).toBe('fl-mqa');
  });
});

describe('steps when the run carries none', () => {
  const bare = (run_id: string) =>
    ({ run_id, status: 'COMPLETED', result: {}, steps_used: 0, error: null }) as unknown as RunResult;

  it('looks the run up once and charges its steps', async () => {
    const { client, state, calls } = stubClient();
    state.runs.set('run_bare', result({ run_id: 'run_bare', status: 'COMPLETED', steps_used: 4 }));
    await runningJob({}, 'run_bare');
    const lookups = calls.getRun.length;

    await onRunFinished(env, db, client, bare('run_bare'));
    expect(calls.getRun.length - lookups).toBe(1);
    expect(await spentToday(db, today(), 'public')).toBe(Math.ceil(4 * 1.6));
  });

  it('charges the reservation when the lookup fails', async () => {
    const { client } = stubClient();
    await runningJob({}, 'run_gone');

    await onRunFinished(env, db, client, bare('run_gone'));
    // reservation(10) is 16 cents, which is 10 steps at 1.6 cents each.
    expect(await spentToday(db, today(), 'public')).toBe(
      Math.ceil(Math.ceil(reservation(10) / CENTS_PER_STEP) * CENTS_PER_STEP),
    );
  });
});

describe('abandon and webhooks', () => {
  it('a webhook for a run that abandon already claimed does not process it again', async () => {
    const { client, state } = stubClient();
    let calls = 0;
    registerContinuation('search', async () => {
      calls += 1;
    });
    await runningJob({}, 'run_cap', new Date(Date.now() - 130 * 60_000));
    state.runs.set('run_cap', result({ run_id: 'run_cap', status: 'RUNNING' }));
    await sweep(env, db, client);
    expect(calls).toBe(1);

    // The run completes late and its webhook arrives after the cap.
    await onRunFinished(env, db, client, result({ run_id: 'run_cap', status: 'COMPLETED', steps_used: 9 }));
    expect(calls).toBe(1);
    // Only the reservation (16 cents) is charged: the late webhook's 9 steps are not added.
    expect(await spentToday(db, today(), 'public')).toBe(16);
  });

  it('a run whose claim is already held at the cap is left alone by sweep', async () => {
    const { client, state } = stubClient();
    let calls = 0;
    registerContinuation('search', async () => {
      calls += 1;
    });
    const job_id = await runningJob({}, 'run_held', new Date(Date.now() - 130 * 60_000));
    state.runs.set('run_held', result({ run_id: 'run_held', status: 'RUNNING' }));
    expect(await markWebhookSeen(db, 'run_held')).toBe(true);

    await sweep(env, db, client);
    expect((await stateOf(job_id))?.state).toBe('running');
    expect(calls).toBe(0);
    expect(await spentToday(db, today(), 'public')).toBe(0);
  });
});

describe('sweep row cap', () => {
  it('handles at most 5 stale rows in one call, the oldest first, and the rest in the next', async () => {
    const { client, state } = stubClient();
    const seen: string[] = [];
    registerContinuation('search', async (_env, _db, _client, j) => {
      seen.push(j.job_id);
    });
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const run_id = `run_cap_${i}`;
      ids.push(await runningJob({}, run_id, new Date(Date.now() - (60 - i) * 60_000)));
      state.runs.set(run_id, result({ run_id, status: 'COMPLETED', steps_used: 1 }));
    }

    expect(await sweep(env, db, client)).toBe(5);
    expect(seen).toEqual(ids.slice(0, 5));
    expect(await countRunning(db)).toBe(2);

    expect(await sweep(env, db, client)).toBe(2);
    expect(seen).toEqual(ids);
    expect(await countRunning(db)).toBe(0);
  });
});

describe('enqueueBatch', () => {
  const plan = (n: number) => Array.from({ length: n }, () => ({ job: job() }));

  it('adds every job in one call and leaves each pending', async () => {
    expect(await enqueueBatch(db, plan(4))).toEqual({ ran: 4, full: false });
    expect(await countPending(db)).toBe(4);
  });

  it('runs a companion statement with its job, and an item with no job still runs', async () => {
    await db
      .prepare("INSERT INTO watches (watch_id, kind, created_at) VALUES ('w1', 'record', 'x'), ('w2', 'record', 'x')")
      .run();
    const stamp = (id: string) =>
      db.prepare('UPDATE watches SET last_recheck_at = ? WHERE watch_id = ?').bind('stamped', id);
    await enqueueBatch(db, [
      { job: job(), also: stamp('w1') },
      { job: null, also: stamp('w2') },
    ]);
    expect(await countPending(db)).toBe(1);
    const rows = await db
      .prepare('SELECT watch_id, last_recheck_at FROM watches ORDER BY watch_id')
      .all<{ watch_id: string; last_recheck_at: string | null }>();
    expect(rows.results).toEqual([
      { watch_id: 'w1', last_recheck_at: 'stamped' },
      { watch_id: 'w2', last_recheck_at: 'stamped' },
    ]);
  });

  it('stops adding at 50 pending jobs and leaves out the companion statement of a job it did not add', async () => {
    for (let i = 0; i < 48; i++) await enqueue(db, job());
    await db
      .prepare(
        "INSERT INTO watches (watch_id, kind, created_at) VALUES ('w1', 'record', 'x'), ('w2', 'record', 'x'), ('w3', 'record', 'x')",
      )
      .run();
    const stamp = (id: string) =>
      db.prepare('UPDATE watches SET last_recheck_at = ? WHERE watch_id = ?').bind('stamped', id);
    const out = await enqueueBatch(db, [
      { job: job(), also: stamp('w1') },
      { job: job(), also: stamp('w2') },
      { job: job(), also: stamp('w3') },
    ]);
    expect(out).toEqual({ ran: 2, full: true });
    expect(await countPending(db)).toBe(50);
    const rows = await db
      .prepare('SELECT watch_id, last_recheck_at FROM watches ORDER BY watch_id')
      .all<{ watch_id: string; last_recheck_at: string | null }>();
    expect(rows.results.map((r) => r.last_recheck_at)).toEqual(['stamped', 'stamped', null]);
  });

  it('does nothing for an empty plan', async () => {
    expect(await enqueueBatch(db, [])).toEqual({ ran: 0, full: false });
  });
});

describe('stale run claims', () => {
  const MINUTE_MS = 60_000;
  const minutesAgo = (n: number): Date => new Date(Date.now() - n * MINUTE_MS);

  it('finishes a run whose webhook claimed it more than 10 minutes ago and then never finished', async () => {
    const { client, state } = stubClient();
    const seen: unknown[] = [];
    registerContinuation('search', async (_env, _db, _client, _job, outcome) => {
      seen.push(outcome);
    });
    const job_id = await runningJob({}, 'run_cut', minutesAgo(30));
    expect(await markWebhookSeen(db, 'run_cut', minutesAgo(15))).toBe(true);
    state.runs.set('run_cut', result({ run_id: 'run_cut', status: 'COMPLETED', steps_used: 3 }));

    expect(await sweep(env, db, client)).toBe(1);
    expect(seen).toHaveLength(1);
    expect((await stateOf(job_id))?.state).toBe('done');
    // The slot is free again and the run is charged once.
    expect(await countRunning(db)).toBe(0);
    expect(await spentToday(db, today(), 'public')).toBe(Math.round(3 * CENTS_PER_STEP));
    // The run is claimed again by the call that finished it, so a late webhook changes nothing.
    expect(await wasWebhookSeen(db, 'run_cut')).toBe(true);
    await onRunFinished(env, db, client, result({ run_id: 'run_cut', steps_used: 9 }));
    expect(seen).toHaveLength(1);
  });

  it('leaves a claim younger than 10 minutes alone: another call may still be processing the run', async () => {
    const { client, state } = stubClient();
    let calls = 0;
    registerContinuation('search', async () => {
      calls += 1;
    });
    const job_id = await runningJob({}, 'run_live', minutesAgo(30));
    expect(await markWebhookSeen(db, 'run_live', minutesAgo(5))).toBe(true);
    state.runs.set('run_live', result({ run_id: 'run_live', status: 'COMPLETED', steps_used: 3 }));

    await sweep(env, db, client);
    expect(calls).toBe(0);
    expect((await stateOf(job_id))?.state).toBe('running');
    expect(await spentToday(db, today(), 'public')).toBe(0);
  });

  it('abandons a stale claimed job whose run is still reported running once it is past the 120 minute cap', async () => {
    const { client, state } = stubClient();
    const seen: unknown[] = [];
    registerContinuation('search', async (_env, _db, _client, _job, outcome) => {
      seen.push(outcome);
    });
    const job_id = await runningJob({}, 'run_cap_stale', minutesAgo(130));
    await markWebhookSeen(db, 'run_cap_stale', minutesAgo(60));
    state.runs.set('run_cap_stale', result({ run_id: 'run_cap_stale', status: 'RUNNING' }));

    expect(await sweep(env, db, client)).toBe(1);
    expect((await stateOf(job_id))?.state).toBe('failed');
    expect(seen).toEqual([{ reason: 'timeout' }]);
    expect(await spentToday(db, today(), 'public')).toBe(16);
  });

  it('releases the stale claim even when the poll fails, so the next sweep can try again', async () => {
    const { client, state } = stubClient();
    let calls = 0;
    registerContinuation('search', async () => {
      calls += 1;
    });
    const job_id = await runningJob({}, 'run_poll', minutesAgo(30));
    await markWebhookSeen(db, 'run_poll', minutesAgo(20));

    expect(await sweep(env, db, client)).toBe(0);
    expect(await wasWebhookSeen(db, 'run_poll')).toBe(false);
    expect((await stateOf(job_id))?.state).toBe('running');

    state.runs.set('run_poll', result({ run_id: 'run_poll', status: 'COMPLETED', steps_used: 1 }));
    expect(await sweep(env, db, client)).toBe(1);
    expect(calls).toBe(1);
    expect((await stateOf(job_id))?.state).toBe('done');
  });

  it('does not touch the claim of a finished job', async () => {
    const { client } = stubClient();
    const job_id = await runningJob({}, 'run_done', minutesAgo(30));
    await markWebhookSeen(db, 'run_done', minutesAgo(20));
    await finishJob(db, job_id, 'done');

    expect(await sweep(env, db, client)).toBe(0);
    expect(await wasWebhookSeen(db, 'run_done')).toBe(true);
  });
});

describe('wallet refusals', () => {
  it('a wallet that cannot be read puts the job back to pending for a minute, with no attempt used and no continuation call', async () => {
    const { client, state, calls } = stubClient();
    const seen: unknown[] = [];
    registerContinuation('search', async (_env, _db, _client, _job, outcome) => {
      seen.push(outcome);
    });
    state.walletFails = true;
    const before = Date.now();
    const { job_id } = await enqueue(db, job());

    expect(await dispatch(env, db, client)).toBe(0);
    expect(seen).toEqual([]);
    expect(calls.runAsync).toHaveLength(0);
    const row = await stateOf(job_id);
    expect(row?.state).toBe('pending');
    expect(row?.attempt).toBe(0);
    expect(row?.run_id).toBeNull();
    const holds = Date.parse(row?.not_before ?? '') - before;
    expect(holds).toBeGreaterThanOrEqual(55_000);
    expect(holds).toBeLessThanOrEqual(65_000);
  });

  it('leaves the job alone inside that minute, then starts it once the wallet reads and the minute is up', async () => {
    const { client, state, calls } = stubClient();
    state.walletFails = true;
    const { job_id } = await enqueue(db, job());
    await dispatch(env, db, client);

    // Inside the minute the job is not even considered.
    state.walletFails = false;
    resetWalletCache();
    expect(await dispatch(env, db, client)).toBe(0);
    expect(calls.runAsync).toHaveLength(0);
    expect((await stateOf(job_id))?.state).toBe('pending');

    // The minute is up.
    await db
      .prepare('UPDATE queue SET not_before = ? WHERE job_id = ?')
      .bind(new Date(Date.now() - 1000).toISOString(), job_id)
      .run();
    expect(await dispatch(env, db, client)).toBe(1);
    expect((await stateOf(job_id))?.state).toBe('running');
  });

  it('requeues a job ten times for an unreadable wallet, then fails it and calls its continuation with timeout', async () => {
    const { client, state, calls } = stubClient();
    const seen: unknown[] = [];
    registerContinuation('search', async (_env, _db, _client, _job, outcome) => {
      seen.push(outcome);
    });
    state.walletFails = true;
    const { job_id } = await enqueue(db, job());
    const due = () =>
      db
        .prepare('UPDATE queue SET not_before = ? WHERE job_id = ?')
        .bind(new Date(Date.now() - 1000).toISOString(), job_id)
        .run();
    const count = async () =>
      (
        await db
          .prepare("SELECT json_extract(payload_json, '$.wallet_requeues') AS n FROM queue WHERE job_id = ?")
          .bind(job_id)
          .first<{ n: number | null }>()
      )?.n;

    for (let i = 1; i <= 10; i += 1) {
      resetWalletCache();
      await due();
      await dispatch(env, db, client);
      expect((await stateOf(job_id))?.state, `round ${i}`).toBe('pending');
      expect(await count()).toBe(i);
    }
    expect(seen).toEqual([]);

    resetWalletCache();
    await due();
    await dispatch(env, db, client);
    expect((await stateOf(job_id))?.state).toBe('failed');
    expect(seen).toEqual([{ reason: 'timeout' }]);
    expect(calls.runAsync).toHaveLength(0);
  });

  it('counts only wallet requeues in a row: a job that starts has its count cleared', async () => {
    const { client, state } = stubClient();
    state.walletFails = true;
    const { job_id } = await enqueue(db, job());
    const due = () =>
      db
        .prepare('UPDATE queue SET not_before = ? WHERE job_id = ?')
        .bind(new Date(Date.now() - 1000).toISOString(), job_id)
        .run();
    for (let i = 0; i < 3; i += 1) {
      resetWalletCache();
      await due();
      await dispatch(env, db, client);
    }
    state.walletFails = false;
    resetWalletCache();
    await due();
    expect(await dispatch(env, db, client)).toBe(1);
    const row = await db
      .prepare("SELECT json_extract(payload_json, '$.wallet_requeues') AS n FROM queue WHERE job_id = ?")
      .bind(job_id)
      .first<{ n: number | null }>();
    expect(row?.n ?? 0).toBe(0);
  });

  it('ends the round on an unreadable wallet: the next job is not claimed', async () => {
    const { client, state } = stubClient();
    state.walletFails = true;
    const first = await enqueue(db, job());
    const second = await enqueue(db, job());

    await dispatch(env, db, client);
    expect((await stateOf(first.job_id))?.state).toBe('pending');
    expect((await stateOf(first.job_id))?.not_before).not.toBeNull();
    const untouched = await stateOf(second.job_id);
    expect(untouched?.state).toBe('pending');
    expect(untouched?.not_before).toBeNull();
    expect(untouched?.attempt).toBe(0);
  });

  it('a daily-limit refusal keeps the midnight reset, names its cause and carries no wallet message', async () => {
    const { client } = stubClient();
    const seen: unknown[] = [];
    registerContinuation('search', async (_env, _db, _client, _job, outcome) => {
      seen.push(outcome);
    });
    await enqueue(db, job({ reserved_cents: 10_000 }));

    await dispatch(env, db, client);
    const outcome = seen[0] as { reason: string; resets_at: string; message?: string; cause?: string };
    expect(outcome.message).toBeUndefined();
    expect(outcome.cause).toBe('daily');
    expect(outcome.resets_at).toMatch(/T00:00:00\.000Z$/);
  });
});

describe('sweep caps and isolation', () => {
  it('gives up on a running job older than 120 minutes: charges the reservation, fails it as timeout', async () => {
    const { client, state } = stubClient();
    const seen: unknown[] = [];
    registerContinuation('search', async (_env, _db, _client, _job, outcome) => {
      seen.push(outcome);
    });
    const job_id = await runningJob({}, 'run_aged', new Date(Date.now() - 130 * 60_000));
    state.runs.set('run_aged', result({ run_id: 'run_aged', status: 'RUNNING' }));

    expect(await sweep(env, db, client)).toBe(1);
    expect((await stateOf(job_id))?.state).toBe('failed');
    expect(seen).toEqual([{ reason: 'timeout' }]);
    expect(await spentToday(db, today(), 'public')).toBe(
      Math.ceil(Math.ceil(reservation(10) / CENTS_PER_STEP) * CENTS_PER_STEP),
    );
  });

  it('gives up after five consecutive failed polls', async () => {
    const { client } = stubClient();
    const seen: unknown[] = [];
    registerContinuation('search', async (_env, _db, _client, _job, outcome) => {
      seen.push(outcome);
    });
    // Started 15 minutes ago: stale enough to poll, young enough not to hit the age cap.
    const job_id = await runningJob({}, 'run_flaky', new Date(Date.now() - 15 * 60_000));

    for (let i = 0; i < 4; i += 1) await sweep(env, db, client);
    expect((await stateOf(job_id))?.state).toBe('running');
    await sweep(env, db, client);
    expect((await stateOf(job_id))?.state).toBe('failed');
    expect(seen).toEqual([{ reason: 'timeout' }]);
  });

  it('a continuation that throws is logged and its job finished failed, and the next row still runs', async () => {
    const { client, state } = stubClient();
    registerContinuation('search', async () => {
      throw new Error('continuation exploded');
    });
    const first = await runningJob({ kind: 'search' }, 'run_first', OLD);
    const second = await runningJob({ kind: 'canary' }, 'run_second', new Date('2026-01-02T00:00:00.000Z'));
    state.runs.set('run_first', result({ run_id: 'run_first', status: 'COMPLETED', steps_used: 2 }));
    state.runs.set('run_second', result({ run_id: 'run_second', status: 'COMPLETED', steps_used: 2 }));

    await sweep(env, db, client);
    expect((await stateOf(first))?.state).toBe('failed');
    expect((await stateOf(second))?.state).toBe('done');
  });
});

describe('sweep', () => {
  it('finishes a run whose webhook never arrived', async () => {
    const { client, state } = stubClient();
    const seen: unknown[] = [];
    registerContinuation('search', async (_env, _db, _client, _job, outcome) => {
      seen.push(outcome);
    });
    const job_id = await runningJob({}, 'run_s', OLD);
    state.runs.set('run_s', result({ run_id: 'run_s', status: 'COMPLETED', steps_used: 2 }));

    expect(await sweep(env, db, client)).toBe(1);
    expect((await stateOf(job_id))?.state).toBe('done');
    expect(seen).toHaveLength(1);
  });

  it('leaves fresh runs and still-running runs alone', async () => {
    const { client, state } = stubClient();
    const fresh = await runningJob({}, 'run_fresh');
    // Started 30 minutes ago: past the sweep threshold, but well inside the 120 minute cap.
    const stale = await runningJob({}, 'run_stale', new Date(Date.now() - 30 * 60_000));
    state.runs.set('run_stale', result({ run_id: 'run_stale', status: 'RUNNING' }));

    expect(await sweep(env, db, client)).toBe(0);
    expect((await stateOf(fresh))?.state).toBe('running');
    expect((await stateOf(stale))?.state).toBe('running');
  });

  it('requeues a starting job that never got a run id', async () => {
    const { client } = stubClient();
    const { job_id } = await enqueue(db, job());
    await startJob(db, job_id, OLD);

    expect(await sweep(env, db, client)).toBe(1);
    const row = await stateOf(job_id);
    expect(row?.state).toBe('pending');
    expect(row?.attempt).toBe(1);
  });
});

describe('safeDetail', () => {
  it('passes the real schema refusal through unchanged', () => {
    const m = 'output_schema field "description" is not supported at #/properties/complaint_view_opened.';
    expect(safeDetail(m)).toBe(m);
  });

  it('replaces an address, up to the next whitespace or quote', () => {
    expect(safeDetail('bad url https://example.test/a?b=1 and "http://x.test/y" end')).toBe(
      'bad url [address] and "[address]" end',
    );
  });

  it('replaces a double-quoted run longer than 40 characters and keeps a shorter one', () => {
    const sixty = 'n'.repeat(60);
    expect(safeDetail(`goal "${sixty}" bad, "short" ok`)).toBe('goal "[text]" bad, "short" ok');
  });

  it('collapses whitespace and cuts a 500-character message to 200', () => {
    expect(safeDetail('a  \n b')).toBe('a b');
    expect(safeDetail('word '.repeat(100))).toHaveLength(200);
  });
});
