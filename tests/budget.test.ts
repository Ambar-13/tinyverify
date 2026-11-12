import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { addSpend, attachRun, enqueue, lifetimeSpend, spentToday, startJob } from '../src/store';
import {
  bucketFor,
  canStart,
  CENTS_PER_STEP,
  limitedRun,
  reservation,
  resetWalletCache,
  runLimits,
  settle,
} from '../src/queue/budget';
import type { Env } from '../src/env';
import { TinyFish, TinyFishError } from '../src/tinyfish/client';

const NOW = new Date('2026-11-04T12:00:00Z');
const DAY = '2026-11-04';
const NEXT_MIDNIGHT = '2026-11-05T00:00:00.000Z';

// A stub client whose wallet() is driven by the test and counted.
function stubClient(wallet: () => Promise<{ balance_cents: number }> = async () => ({ balance_cents: 1000 })) {
  let calls = 0;
  const client = {
    wallet: () => {
      calls += 1;
      return wallet();
    },
  } as unknown as TinyFish;
  return { client, calls: () => calls };
}

beforeEach(() => {
  resetWalletCache();
});

describe('reservation', () => {
  it('rounds the step budget up to whole cents', () => {
    expect(CENTS_PER_STEP).toBe(1.6);
    expect(reservation(10)).toBe(16);
    expect(reservation(3)).toBe(5); // 4.8 rounds up
  });
});

describe('runLimits', () => {
  it('with the step cap on, sends max_steps and holds exactly that many steps', () => {
    expect(runLimits(20, 'on')).toEqual({ agent_config: { max_steps: 20 }, held_steps: 20, goal_suffix: '' });
  });

  it('with the step cap off, sends a duration, holds twice the steps and asks for the limit in the goal', () => {
    expect(runLimits(20, 'off')).toEqual({
      agent_config: { max_duration_seconds: 120 },
      held_steps: 40,
      goal_suffix: '\n\nUse at most 20 actions. If the task is not finished by then, stop and report what you have.',
    });
  });

  it('treats a missing or unknown value as off', () => {
    expect(runLimits(5, undefined).agent_config).toEqual({ max_duration_seconds: 30 });
    expect(runLimits(5, 'ON').held_steps).toBe(10);
  });

  it('limitedRun holds maxSteps * 2 * 1.6 cents when off and adds the suffix to the goal only then', () => {
    const base = { url: 'https://r.test', goal: 'Read it.' };
    const off = limitedRun(base, 15, 'off');
    expect(off.reserved_cents).toBe(Math.ceil(15 * 2 * 1.6));
    expect(off.request.goal).toBe('Read it.' + runLimits(15, 'off').goal_suffix);
    expect(off.request.agent_config).toEqual({ max_duration_seconds: 90 });
    const on = limitedRun(base, 15, 'on');
    expect(on.reserved_cents).toBe(reservation(15));
    expect(on.request.goal).toBe('Read it.');
    expect(on.request.agent_config).toEqual({ max_steps: 15 });
  });

  it('refuses a second run when the bucket cannot hold its reservation', async () => {
    // 40 steps off: 80 held steps, 128 cents. The public day holds 200, so one fits and a second does not.
    const cents = limitedRun({ url: 'https://r.test', goal: 'g' }, 40, 'off').reserved_cents;
    expect(cents).toBe(128);
    const { client } = stubClient();
    expect((await canStart(env, env.DB, client, 'public', cents, NOW)).ok).toBe(true);
    const jobId = await enqueue(
      env.DB,
      { kind: 'verify', priority: 0, payload_json: null, bucket: 'public', reserved_cents: cents },
      NOW,
    );
    await startJob(env.DB, jobId, NOW);
    const second = await canStart(env, env.DB, client, 'public', cents, NOW);
    expect(second).toMatchObject({ ok: false, cause: 'daily' });
  });
});

describe('canStart: daily bucket', () => {
  it('public bucket at 199 spent allows a 1-cent start and refuses 2', async () => {
    await addSpend(env.DB, DAY, 'public', 199, null, NOW);
    const { client } = stubClient();

    expect(await canStart(env, env.DB, client, 'public', 1, NOW)).toEqual({ ok: true });

    const refused = await canStart(env, env.DB, client, 'public', 2, NOW);
    expect(refused).toEqual({ ok: false, reason: 'budget', resets_at: NEXT_MIDNIGHT, cause: 'daily' });
  });

  it('uses the judge and ops limits from env for their buckets', async () => {
    await addSpend(env.DB, DAY, 'judge', 499, null, NOW);
    await addSpend(env.DB, DAY, 'ops', 200, null, NOW);
    const { client } = stubClient();

    expect((await canStart(env, env.DB, client, 'judge', 1, NOW)).ok).toBe(true);
    expect((await canStart(env, env.DB, client, 'judge', 2, NOW)).ok).toBe(false);
    expect((await canStart(env, env.DB, client, 'ops', 1, NOW)).ok).toBe(false);
  });

  it('counts only the same UTC day', async () => {
    await addSpend(env.DB, '2026-11-03', 'public', 200, null, NOW);
    const { client } = stubClient();

    expect((await canStart(env, env.DB, client, 'public', 1, NOW)).ok).toBe(true);
  });
});

describe('canStart: lifetime ceiling', () => {
  it('refuses when lifetime spend at 4,999 cannot take a 2-cent start', async () => {
    // Spent on another day and bucket, so only the ceiling is in play.
    await addSpend(env.DB, '2026-11-03', 'judge', 4999, null, NOW);
    const { client } = stubClient();

    expect((await canStart(env, env.DB, client, 'public', 1, NOW)).ok).toBe(true);
    expect(await canStart(env, env.DB, client, 'public', 2, NOW)).toEqual({
      ok: false,
      reason: 'budget',
      resets_at: NEXT_MIDNIGHT,
      cause: 'ceiling',
    });
  });
});

describe('canStart: wallet floor', () => {
  it('refuses with reason budget when the wallet holds 250, below the 300 floor', async () => {
    const { client } = stubClient(async () => ({ balance_cents: 250 }));

    expect(await canStart(env, env.DB, client, 'public', 1, NOW)).toEqual({
      ok: false,
      reason: 'budget',
      resets_at: NEXT_MIDNIGHT,
      cause: 'wallet_floor',
    });
  });

  it('allows a wallet balance exactly at the floor', async () => {
    const { client } = stubClient(async () => ({ balance_cents: 300 }));

    expect((await canStart(env, env.DB, client, 'public', 1, NOW)).ok).toBe(true);
  });

  it('treats -1 as an account with no wallet, so it is allowed', async () => {
    const { client } = stubClient(async () => ({ balance_cents: -1 }));

    expect((await canStart(env, env.DB, client, 'public', 1, NOW)).ok).toBe(true);
  });

  it('refuses for a minute when wallet() throws bad_response, and remembers the failure for a minute', async () => {
    const failing = stubClient(async () => {
      throw new TinyFishError('bad_response', 200, 'TinyFish wallet response had no balance field');
    });
    const oneMinuteOn = '2026-11-04T12:01:00.000Z';

    expect(await canStart(env, env.DB, failing.client, 'public', 1, NOW)).toEqual({
      ok: false,
      reason: 'budget',
      resets_at: oneMinuteOn,
      cause: 'wallet_unreadable',
    });
    // Inside the minute the wallet is not asked again.
    expect((await canStart(env, env.DB, failing.client, 'public', 1, new Date(NOW.getTime() + 59_999))).ok).toBe(false);
    expect(failing.calls()).toBe(1);

    // After the minute the wallet is asked again.
    expect((await canStart(env, env.DB, failing.client, 'public', 1, new Date(NOW.getTime() + 60_000))).ok).toBe(false);
    expect(failing.calls()).toBe(2);
  });

  it('refuses when wallet() throws any other error, such as a network failure', async () => {
    const failing = stubClient(async () => {
      throw new TinyFishError('network', 0, 'Could not reach TinyFish');
    });

    expect((await canStart(env, env.DB, failing.client, 'public', 1, NOW)).ok).toBe(false);
  });

  it('refuses when wallet() throws a plain Error', async () => {
    const failing = stubClient(async () => {
      throw new Error('boom');
    });

    expect((await canStart(env, env.DB, failing.client, 'public', 1, NOW)).ok).toBe(false);
  });

  it('allows starts again once a wallet read after the failure succeeds', async () => {
    let healthy = false;
    const flaky = stubClient(async () => {
      if (!healthy) throw new TinyFishError('bad_response', 200, 'bad');
      return { balance_cents: 1000 };
    });

    expect((await canStart(env, env.DB, flaky.client, 'public', 1, NOW)).ok).toBe(false);
    healthy = true;
    expect((await canStart(env, env.DB, flaky.client, 'public', 1, new Date(NOW.getTime() + 60_000))).ok).toBe(true);
    expect(flaky.calls()).toBe(2);
  });

  it('still allows a start when the wallet feature is absent (-1), with no failure recorded', async () => {
    const absent = stubClient(async () => ({ balance_cents: -1 }));

    expect((await canStart(env, env.DB, absent.client, 'public', 1, NOW)).ok).toBe(true);
    expect((await canStart(env, env.DB, absent.client, 'public', 1, NOW)).ok).toBe(true);
    expect(absent.calls()).toBe(1);
  });

  it('checks the wallet only after the daily and ceiling checks pass', async () => {
    await addSpend(env.DB, DAY, 'public', 200, null, NOW);
    const { client, calls } = stubClient(async () => ({ balance_cents: 0 }));

    expect((await canStart(env, env.DB, client, 'public', 1, NOW)).ok).toBe(false);
    expect(calls()).toBe(0);
  });
});

describe('canStart: wallet cache', () => {
  it('reads the wallet once within 600,000 ms and again once the cache is older', async () => {
    const { client, calls } = stubClient();
    const t0 = NOW.getTime();

    await canStart(env, env.DB, client, 'public', 1, new Date(t0));
    await canStart(env, env.DB, client, 'public', 1, new Date(t0 + 599_999));
    expect(calls()).toBe(1);

    await canStart(env, env.DB, client, 'public', 1, new Date(t0 + 600_000));
    expect(calls()).toBe(1);

    await canStart(env, env.DB, client, 'public', 1, new Date(t0 + 600_001));
    expect(calls()).toBe(2);
  });

  it('resetWalletCache forces the next call to read the wallet', async () => {
    const { client, calls } = stubClient();

    await canStart(env, env.DB, client, 'public', 1, NOW);
    resetWalletCache();
    await canStart(env, env.DB, client, 'public', 1, NOW);
    expect(calls()).toBe(2);
  });
});

describe('settle', () => {
  it('records ceil(actualSteps * 1.6) with the run id, not the reservation', async () => {
    await settle(env.DB, 'public', 50, 3, 'run_abc', NOW);

    expect(await spentToday(env.DB, DAY, 'public')).toBe(5);
    expect(await lifetimeSpend(env.DB)).toBe(5);
    const row = await env.DB.prepare('SELECT cents, run_id FROM ledger').first<{ cents: number; run_id: string }>();
    expect(row).toEqual({ cents: 5, run_id: 'run_abc' });
  });

  it('records 16 cents for 10 steps', async () => {
    await settle(env.DB, 'judge', 99, 10, 'run_ten', NOW);

    expect(await spentToday(env.DB, DAY, 'judge')).toBe(16);
  });

  it('rejects a reservation that is not a number', async () => {
    await expect(settle(env.DB, 'public', Number.NaN, 3, 'run_bad', NOW)).rejects.toThrow();
    expect(await lifetimeSpend(env.DB)).toBe(0);
  });
});

describe('canStart: in-flight reservations', () => {
  it('counts a running job reservation against the daily limit', async () => {
    await addSpend(env.DB, DAY, 'public', 100, null, NOW);
    const jobId = await enqueue(
      env.DB,
      {
        kind: 'verify',
        priority: 0,
        payload_json: null,
        bucket: 'public',
        reserved_cents: 60,
      },
      NOW,
    );
    await startJob(env.DB, jobId, NOW);
    await attachRun(env.DB, jobId, 'run_inflight', NOW);
    const { client } = stubClient();

    // 100 spent + 60 reserved = 160 of 200. A start of 50 would reach 210.
    expect((await canStart(env, env.DB, client, 'public', 50, NOW)).ok).toBe(false);
    expect((await canStart(env, env.DB, client, 'public', 40, NOW)).ok).toBe(true);
  });

  it('counts reservations of other buckets against the lifetime ceiling only', async () => {
    await addSpend(env.DB, '2026-11-03', 'judge', 4900, null, NOW);
    const jobId = await enqueue(
      env.DB,
      {
        kind: 'verify',
        priority: 0,
        payload_json: null,
        bucket: 'judge',
        reserved_cents: 90,
      },
      NOW,
    );
    await startJob(env.DB, jobId, NOW);
    const { client } = stubClient();

    // Lifetime 4,900 + 90 reserved = 4,990. A 20-cent public start would reach 5,010.
    expect((await canStart(env, env.DB, client, 'public', 20, NOW)).ok).toBe(false);
    expect((await canStart(env, env.DB, client, 'public', 10, NOW)).ok).toBe(true);
  });

  it('leaves out the excluded job own reservation, and still counts other running jobs', async () => {
    await addSpend(env.DB, DAY, 'public', 100, null, NOW);
    const own = await enqueue(
      env.DB,
      {
        kind: 'verify',
        priority: 0,
        payload_json: null,
        bucket: 'public',
        reserved_cents: 60,
      },
      NOW,
    );
    await startJob(env.DB, own, NOW);
    await attachRun(env.DB, own, 'run_own', NOW);
    const { client } = stubClient();

    // Without the exclusion the claimed job's 60 is counted twice: 100 + 60 + 50 = 210 refuses.
    expect((await canStart(env, env.DB, client, 'public', 50, NOW)).ok).toBe(false);
    // Excluding the job itself leaves 100 + 50 = 150, which is allowed.
    expect((await canStart(env, env.DB, client, 'public', 50, NOW, own)).ok).toBe(true);

    // Another running job is still counted when a different job is excluded.
    const other = await enqueue(
      env.DB,
      {
        kind: 'verify',
        priority: 0,
        payload_json: null,
        bucket: 'public',
        reserved_cents: 60,
      },
      NOW,
    );
    await startJob(env.DB, other, NOW);
    await attachRun(env.DB, other, 'run_other', NOW);
    expect((await canStart(env, env.DB, client, 'public', 50, NOW, own)).ok).toBe(false);
  });

  it('ignores pending and finished jobs', async () => {
    await addSpend(env.DB, DAY, 'public', 100, null, NOW);
    await enqueue(
      env.DB,
      {
        kind: 'verify',
        priority: 0,
        payload_json: null,
        bucket: 'public',
        reserved_cents: 60,
      },
      NOW,
    );
    const { client } = stubClient();

    expect((await canStart(env, env.DB, client, 'public', 50, NOW)).ok).toBe(true);
  });
});

describe('canStart: fails closed on a limit that does not parse', () => {
  const bad = ['abc', '-1', '1.5', '', ' 200', '1e3', '200 '];

  it.each(bad)('refuses every start when CEILING_CENTS is %j', async (value) => {
    const broken = { ...env, CEILING_CENTS: value } as Env;
    const { client, calls } = stubClient();

    expect(await canStart(broken, env.DB, client, 'public', 1, NOW)).toEqual({
      ok: false,
      reason: 'budget',
      resets_at: NEXT_MIDNIGHT,
      cause: 'bad_limit',
    });
    expect(calls()).toBe(0);
  });

  it.each(bad)('refuses a public start when PUBLIC_DAILY_CENTS is %j', async (value) => {
    const broken = { ...env, PUBLIC_DAILY_CENTS: value } as Env;
    const { client } = stubClient();

    expect((await canStart(broken, env.DB, client, 'public', 1, NOW)).ok).toBe(false);
  });

  it('refuses a judge start when JUDGE_DAILY_CENTS does not parse, and an ops start when OPS_DAILY_CENTS does not', async () => {
    const { client } = stubClient();
    const brokenJudge = { ...env, JUDGE_DAILY_CENTS: 'abc' } as Env;
    const brokenOps = { ...env, OPS_DAILY_CENTS: 'abc' } as Env;

    expect((await canStart(brokenJudge, env.DB, client, 'judge', 1, NOW)).ok).toBe(false);
    expect((await canStart(brokenOps, env.DB, client, 'ops', 1, NOW)).ok).toBe(false);
  });

  it('refuses when WALLET_FLOOR_CENTS does not parse, even if the wallet is healthy', async () => {
    const broken = { ...env, WALLET_FLOOR_CENTS: 'abc' } as Env;
    const { client } = stubClient(async () => ({ balance_cents: 1_000_000 }));

    expect((await canStart(broken, env.DB, client, 'public', 1, NOW)).ok).toBe(false);
  });

  it('still allows a start when every limit parses and is within range', async () => {
    const { client } = stubClient();

    expect((await canStart(env, env.DB, client, 'public', 1, NOW)).ok).toBe(true);
  });
});

describe('canStart: every refusal carries its cause', () => {
  it('names daily, ceiling, wallet_floor, wallet_unreadable and bad_limit, each from its own check', async () => {
    const cause = async (
      e: Env,
      c: ReturnType<typeof stubClient>['client'],
      bucket: 'public' | 'judge' | 'ops' = 'public',
      cents = 1,
    ) => {
      const v = await canStart(e, env.DB, c, bucket, cents, NOW);
      return v.ok ? 'ok' : v.cause;
    };
    const healthy = stubClient().client;
    expect(await cause(env, healthy)).toBe('ok');
    expect(await cause(env, healthy, 'public', 500)).toBe('daily');
    expect(await cause({ ...env, CEILING_CENTS: '0' } as Env, healthy)).toBe('ceiling');
    resetWalletCache();
    expect(await cause(env, stubClient(async () => ({ balance_cents: 1 })).client)).toBe('wallet_floor');
    resetWalletCache();
    expect(
      await cause(
        env,
        stubClient(async () => {
          throw new TinyFishError('network', 0, 'down');
        }).client,
      ),
    ).toBe('wallet_unreadable');
    expect(await cause({ ...env, PUBLIC_DAILY_CENTS: 'abc' } as Env, healthy)).toBe('bad_limit');
  });
});

describe('bucketFor', () => {
  const env2 = {
    ADMIN_KEY: 'admin-secret',
    API_KEYS: 'key-a, key-b,,',
  } as unknown as Env;

  it('returns ops for the admin key', () => {
    expect(bucketFor('admin-secret', env2)).toBe('ops');
  });

  it('returns public for a key one character longer than the admin key, and for one shorter', () => {
    expect(bucketFor('admin-secretX', env2)).toBe('public');
    expect(bucketFor('admin-secre', env2)).toBe('public');
  });

  it('returns public for a key one character longer than a judge key', () => {
    expect(bucketFor('key-aX', env2)).toBe('public');
  });

  it('returns public for a key that differs in one character of the same length', () => {
    expect(bucketFor('admin-secreX', env2)).toBe('public');
    expect(bucketFor('key-b', env2)).toBe('judge');
    expect(bucketFor('key-c', env2)).toBe('public');
  });

  it('returns judge for a key listed in API_KEYS, ignoring spaces and empty entries', () => {
    expect(bucketFor('key-a', env2)).toBe('judge');
    expect(bucketFor('key-b', env2)).toBe('judge');
  });

  it('returns public for an unknown key, a missing key, or an empty key', () => {
    expect(bucketFor('someone-else', env2)).toBe('public');
    expect(bucketFor(null, env2)).toBe('public');
    expect(bucketFor('', env2)).toBe('public');
  });

  it('returns public for an empty key even when ADMIN_KEY is empty', () => {
    const blank = { ADMIN_KEY: '', API_KEYS: '' } as unknown as Env;
    expect(bucketFor('', blank)).toBe('public');
  });
});
