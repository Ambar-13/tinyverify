/**
 * Money for agent runs, in cents. bucketFor maps an API key to a bucket, canStart refuses a run when the bucket's day
 * is spent, the lifetime ceiling is reached or the provider's wallet is under its floor, and settle records what a
 * finished run cost. limitedRun applies the step limits to a run request.
 */

import type { Env } from '../env';
import type { TinyFish } from '../tinyfish/client';
import { runLimits } from './run-limits';
import { addSpend, lifetimeSpend, spentToday } from '../store';

export { runLimits };

/**
 * own is a lookup run on the visitor's own TinyFish key: it spends none of this service's money, so it has no limit
 * and leaves no line in the ledger.
 */
export type Bucket = 'public' | 'judge' | 'ops' | 'own';

/**
 * Why canStart refused. daily: the bucket's day is spent. ceiling: the whole-window ceiling is reached.
 * wallet_floor: the provider's balance is under the floor. wallet_unreadable: the balance could not be
 * read, which says nothing about the money. bad_limit: a configured limit is not a number.
 */
export type RefusalCause = 'daily' | 'ceiling' | 'wallet_floor' | 'wallet_unreadable' | 'bad_limit';
export type Verdict = { ok: true } | { ok: false; reason: 'budget'; resets_at: string; cause: RefusalCause };

/** Estimated cost of one agent step. Reservations use it up front; settle uses it on actual steps. */
export const CENTS_PER_STEP = 1.6;

/** The wallet is read at most once per this many milliseconds per isolate. */
const WALLET_TTL_MS = 600_000;

let walletCache: { at: number; balance_cents: number } | null = null;

/** Forgets the cached wallet balance. Tests use it between cases. */
export function resetWalletCache(): void {
  walletCache = null;
  walletFailedAt = null;
}

/** The cents to hold for a run of at most maxSteps steps, rounded up. */
export function reservation(maxSteps: number): number {
  return Math.ceil(maxSteps * CENTS_PER_STEP);
}

/** A run request with its limits applied, and the cents to hold for it. Every place that starts a run uses this. */
export function limitedRun<R extends { goal: string; agent_config?: object }>(
  request: R,
  maxSteps: number,
  stepCap: string | undefined,
): {
  request: R & { agent_config: { max_steps?: number; max_duration_seconds?: number } };
  reserved_cents: number;
  held_steps: number;
} {
  const limits = runLimits(maxSteps, stepCap);
  return {
    request: { ...request, goal: request.goal + limits.goal_suffix, agent_config: limits.agent_config },
    reserved_cents: reservation(limits.held_steps),
    held_steps: limits.held_steps,
  };
}

/** The steps a reservation was made for. reservation rounds up to whole cents, so the division is floored. */
export function heldStepsOf(reservedCents: number): number {
  return Math.floor(reservedCents / CENTS_PER_STEP + 1e-9);
}

/** The UTC calendar day (YYYY-MM-DD) that a moment falls in. Daily budgets reset on it. */
function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The next UTC midnight, as ISO text. Every refusal reports it as the reset time. */
function nextUtcMidnight(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

/** A limit is a non-negative integer of cents written in plain digits. Anything else is null. */
function parseLimit(value: string | undefined): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

function dailyLimitText(env: Env, bucket: Bucket): string | undefined {
  if (bucket === 'ops') return env.OPS_DAILY_CENTS;
  if (bucket === 'judge') return env.JUDGE_DAILY_CENTS;
  return env.PUBLIC_DAILY_CENTS;
}

/** Compares two keys without leaking how many leading bytes match. A length mismatch is a plain false. */
function sameKey(given: string, expected: string): boolean {
  const left = new TextEncoder().encode(given);
  const right = new TextEncoder().encode(expected);
  if (left.byteLength !== right.byteLength) return false;
  return crypto.subtle.timingSafeEqual(left, right);
}

/** A missing or unknown key is the public bucket, never an error. */
export function bucketFor(apiKey: string | null, env: Env): Bucket {
  if (!apiKey) return 'public';
  if (sameKey(apiKey, env.ADMIN_KEY)) return 'ops';
  // Every entry is compared, with no early exit, so the time taken does not show which entry matched.
  let judge = false;
  for (const entry of env.API_KEYS.split(',')) {
    const key = entry.trim();
    if (key !== '' && sameKey(apiKey, key)) judge = true;
  }
  return judge ? 'judge' : 'public';
}

/** After a failed wallet read, the guard refuses starts for this long without asking again. */
const WALLET_FAILURE_TTL_MS = 60_000;
let walletFailedAt: number | null = null;

/** Returns the wallet balance in cents, or null when the wallet could not be read. Null refuses the start. */
async function walletBalance(client: TinyFish, now: Date): Promise<number | null> {
  if (walletFailedAt !== null && now.getTime() - walletFailedAt < WALLET_FAILURE_TTL_MS) return null;
  if (walletCache !== null && now.getTime() - walletCache.at <= WALLET_TTL_MS) {
    return walletCache.balance_cents;
  }
  try {
    const { balance_cents } = await client.wallet();
    walletCache = { at: now.getTime(), balance_cents };
    walletFailedAt = null;
    return balance_cents;
  } catch {
    walletFailedAt = now.getTime();
    return null;
  }
}

/**
 * Cents reserved by jobs that have started but not finished, for one bucket or for all buckets.
 * Their spend is not in the ledger yet, so the guard must add it.
 * excludeJobId leaves out one job, for a dispatcher that has already claimed it.
 * Only constant clause text is joined into the SQL. Every value is bound.
 */
async function inFlightCents(db: D1Database, bucket: Bucket | null, excludeJobId?: string): Promise<number> {
  const clauses = ["state IN ('starting', 'running')", "bucket != 'own'"];
  const binds: string[] = [];
  if (bucket !== null) {
    clauses.push('bucket = ?');
    binds.push(bucket);
  }
  if (excludeJobId !== undefined) {
    clauses.push('job_id != ?');
    binds.push(excludeJobId);
  }
  const sql = `SELECT COALESCE(SUM(reserved_cents), 0) AS total FROM queue WHERE ${clauses.join(' AND ')}`;
  const row = await db
    .prepare(sql)
    .bind(...binds)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/**
 * Checks the daily bucket, then the lifetime ceiling, then the wallet floor. The first refusal wins,
 * and every refusal carries its cause.
 * A limit that does not parse refuses the start (fail closed) before any read happens.
 * A wallet that cannot be read refuses the start for a minute. excludeJobId leaves that job's own
 * reservation out of the in-flight sums.
 */
export async function canStart(
  env: Env,
  db: D1Database,
  client: TinyFish,
  bucket: Bucket,
  cents: number,
  now: Date = new Date(),
  excludeJobId?: string,
): Promise<Verdict> {
  if (bucket === 'own') return { ok: true };
  const refused = (cause: RefusalCause): Verdict => ({
    ok: false,
    reason: 'budget',
    resets_at: nextUtcMidnight(now),
    cause,
  });

  const dailyLimit = parseLimit(dailyLimitText(env, bucket));
  const ceiling = parseLimit(env.CEILING_CENTS);
  const floor = parseLimit(env.WALLET_FLOOR_CENTS);
  if (dailyLimit === null || ceiling === null || floor === null) return refused('bad_limit');

  // Spend already in the ledger plus reservations of jobs in flight (starting or running).
  const spent = (await spentToday(db, utcDay(now), bucket)) + (await inFlightCents(db, bucket, excludeJobId));
  if (spent + cents > dailyLimit) return refused('daily');

  const lifetime = (await lifetimeSpend(db)) + (await inFlightCents(db, null, excludeJobId));
  if (lifetime + cents > ceiling) return refused('ceiling');

  const balance = await walletBalance(client, now);
  if (balance === null) {
    return {
      ok: false,
      reason: 'budget',
      resets_at: new Date(now.getTime() + WALLET_FAILURE_TTL_MS).toISOString(),
      cause: 'wallet_unreadable',
    };
  }
  // -1 means the account has no wallet feature, so there is no floor to hold.
  if (balance !== -1 && balance < floor) return refused('wallet_floor');

  return { ok: true };
}

/**
 * Records the cost of a finished run from its actual steps. The reservation is held by the queue,
 * so it is only checked here.
 */
export async function settle(
  db: D1Database,
  bucket: Bucket,
  reserved: number,
  actualSteps: number,
  run_id: string,
  now: Date = new Date(),
): Promise<void> {
  // reserved comes from the queue row's reserved_cents column.
  if (typeof reserved !== 'number' || Number.isNaN(reserved)) {
    throw new TypeError('reserved must be a number of cents');
  }
  if (bucket === 'own') return;
  await addSpend(db, utcDay(now), bucket, Math.ceil(actualSteps * CENTS_PER_STEP), run_id, now);
}
