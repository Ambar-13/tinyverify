/**
 * Agent run queue. Every paid TinyFish Agent run goes through here, because TinyFish allows only two runs at once. A
 * job moves pending -> starting -> running -> done, failed or budget. This module decides what happens next and
 * writes the queue rows itself.
 */

import type { Env } from '../env';
import { TinyFishError, type RunResult, type TinyFish } from '../tinyfish/client';
import { CENTS_PER_STEP, canStart, heldStepsOf, settle, type Bucket, type RefusalCause } from './budget';
import { OWN_KEY_GONE, dropOwnKeyIfDone, ownClient, ownKeyFor } from './own-key';
import type { RegistryId } from '../types';
import {
  attachRun,
  countPending,
  enqueue as storeEnqueue,
  enqueueStatement,
  findJobByRun,
  finishJob,
  markWebhookSeen,
  nextJobs,
  requeue,
  staleRunning,
  startJob,
  unmarkWebhookSeen,
  webhookSeenAt,
  type JobRow,
} from '../store';

export type JobKind = 'search' | 'record' | 'discipline' | 'generic' | 'recheck' | 'recheck_complaints' | 'canary';

export interface Job {
  job_id: string;
  kind: JobKind;
  priority: 1 | 2 | 3;
  bucket: Bucket;
  /** Held by the queue until the run finishes; settle uses the actual steps, not this. */
  reserved_cents: number;
  payload: {
    check_id?: string;
    watch_id?: string;
    registry: RegistryId | 'generic';
    request: Parameters<TinyFish['runAsync']>[0];
    /** Wallet requeues in a row. Written by the dispatcher, cleared when the job starts. */
    wallet_requeues?: number;
  };
}

/**
 * What a continuation receives: the finished run, or why the job ended without one.
 * A budget refusal carries when it lifts (resets_at) and why it was refused (cause).
 */
export type Outcome =
  | RunResult
  | {
      reason: 'budget' | 'timeout' | 'source_unavailable' | 'start_refused';
      resets_at?: string;
      message?: string;
      cause?: RefusalCause;
    };

export type Continuation = (env: Env, db: D1Database, client: TinyFish, job: Job, outcome: Outcome) => Promise<void>;

/**
 * Each continuation registers itself when its module loads. This module never imports them,
 * which would create import cycles.
 */
export const continuations = new Map<JobKind, Continuation>();

/** A kind has one continuation; registering the same kind again replaces it. */
export function registerContinuation(kind: JobKind, fn: Continuation): void {
  continuations.set(kind, fn);
}

/** Slots are shared by every caller: the cron and each webhook can dispatch at once. */
const MAX_RUNNING = 2;
const MAX_PENDING = 50;
/**
 * One sweep handles at most this many stale rows, oldest first. Each row costs a poll and several writes,
 * and a Worker invocation allows 50 subrequests. Two slots exist, so more than this are seldom stale together.
 */
const MAX_SWEEP_ROWS = 5;
/**
 * Per dispatch call: at most this many pending jobs are considered, and it stops after
 * this many failed starts.
 */
const MAX_CONSIDERED = 10;
const MAX_FAILED_STARTS = 2;
const RETRY_DELAY_MS = 30_000;
/** A job on a visitor's key waits this long for the key to be stored, looked at again every OWN_KEY_RETRY_MS. */
const OWN_KEY_WAIT_MS = 60_000;
const OWN_KEY_RETRY_MS = 3_000;
/** A job held back because the provider's wallet could not be read waits this long before it is tried again. */
const WALLET_RETRY_MS = 60_000;
/** Wallet requeues in a row before a job is finished failed. */
const MAX_WALLET_REQUEUES = 10;
const STALE_MS = 10 * 60_000;
/** A running job older than this is given up on, even when its run is still reported running. */
const MAX_RUN_AGE_MS = 120 * 60_000;
/** Consecutive failed polls of one job before sweep gives up on it. Held in memory per isolate. */
const MAX_POLL_FAILURES = 5;
const pollFailures = new Map<string, number>();
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
/** Failures that a single retry can plausibly fix. */
const RETRYABLE_ERRORS: ReadonlySet<string> = new Set(['SYSTEM_FAILURE', 'UNKNOWN']);

export class QueueFull extends Error {
  constructor() {
    super('The run queue is full');
    this.name = 'QueueFull';
  }
}

/** A continuation threw. The job's state is left for the caller to settle. */
export class ContinuationFailed extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ContinuationFailed';
  }
}

function toJob(row: JobRow): Job {
  return {
    job_id: row.job_id,
    kind: row.kind as JobKind,
    priority: row.priority as Job['priority'],
    bucket: row.bucket as Bucket,
    reserved_cents: row.reserved_cents,
    payload: JSON.parse(row.payload_json ?? 'null') as Job['payload'],
  };
}

function webhookUrl(env: Env): string {
  return `${env.BASE_URL}/hooks/tinyfish/run/${env.HOOK_SECRET}`;
}

/** Jobs starting or running, among those on visitors' keys or among this service's own. */
async function slotsHeld(db: D1Database, own: boolean): Promise<number> {
  const sql = `SELECT COUNT(*) AS n FROM queue WHERE state IN ('starting', 'running') AND bucket ${own ? '=' : '!='} 'own'`;
  return (await db.prepare(sql).first<{ n: number }>())?.n ?? 0;
}

/**
 * Jobs on visitors' keys that are waiting, starting or running. The API refuses a new one past OWN_MAX_IN_FLIGHT,
 * so those lookups cannot fill the queue this service's own lookups and watches wait in.
 */
export const OWN_MAX_IN_FLIGHT = 8;
export async function ownInFlight(db: D1Database): Promise<number> {
  const sql = "SELECT COUNT(*) AS n FROM queue WHERE state IN ('pending', 'starting', 'running') AND bucket = 'own'";
  return (await db.prepare(sql).first<{ n: number }>())?.n ?? 0;
}

/**
 * The cap is enforced on the row itself, after it is written: requests that arrive together all pass a count taken
 * before any of them has written. A job that is not among the first OWN_MAX_IN_FLIGHT of its kind is taken out again.
 */
async function keepsOwnPlace(db: D1Database, job_id: string): Promise<boolean> {
  const ahead = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM queue WHERE bucket = 'own' AND state IN ('pending', 'starting', 'running') AND rowid <= (SELECT rowid FROM queue WHERE job_id = ?)",
    )
    .bind(job_id)
    .first<{ n: number }>();
  if ((ahead?.n ?? 0) <= OWN_MAX_IN_FLIGHT) return true;
  await db.prepare("DELETE FROM queue WHERE job_id = ? AND state = 'pending'").bind(job_id).run();
  return false;
}

/**
 * The client a job's TinyFish calls go through. A job on a visitor's own key uses a client made from the key
 * held for its check, and null when that key is not held. Nothing falls back to this service's key.
 */
async function clientOf(env: Env, db: D1Database, shared: TinyFish, job: Job): Promise<TinyFish | null> {
  if (job.bucket !== 'own') return shared;
  const key = job.payload.check_id === undefined ? null : await ownKeyFor(env, db, job.payload.check_id);
  return key === null ? null : ownClient(key);
}

/** The client that can read a run: the one of the job holding it. A run no job holds is read with the shared client. */
export async function clientForRun(env: Env, db: D1Database, shared: TinyFish, run_id: string): Promise<TinyFish> {
  const row = await findJobByRun(db, run_id);
  return (row === null ? null : await clientOf(env, db, shared, toJob(row))) ?? shared;
}

async function callContinuation(env: Env, db: D1Database, client: TinyFish, job: Job, outcome: Outcome): Promise<void> {
  const fn = continuations.get(job.kind);
  // A kind with no continuation has nothing more to do; the caller has already marked the job.
  if (!fn) return;
  try {
    await fn(env, db, client, job, outcome);
  } catch (err) {
    throw new ContinuationFailed(err);
  }
  // A visitor's key is dropped as soon as its check has an answer.
  if (job.bucket === 'own' && job.payload.check_id !== undefined) await dropOwnKeyIfDone(db, job.payload.check_id);
}

/** Adds a job as pending. Throws QueueFull when 50 jobs are already pending. */
export async function enqueue(db: D1Database, job: Omit<Job, 'job_id'>): Promise<{ job_id: string; position: number }> {
  if ((await countPending(db)) >= MAX_PENDING) throw new QueueFull();
  const job_id = await storeEnqueue(db, {
    kind: job.kind,
    priority: job.priority,
    payload_json: JSON.stringify(job.payload),
    bucket: job.bucket,
    reserved_cents: job.reserved_cents,
  });
  if (job.bucket === 'own' && !(await keepsOwnPlace(db, job_id))) throw new QueueFull();
  // Position: pending jobs of equal or higher priority inserted before this one, plus one.
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM queue WHERE state = 'pending' AND priority <= ? AND rowid < (SELECT rowid FROM queue WHERE job_id = ?)",
    )
    .bind(job.priority, job_id)
    .first<{ n: number }>();
  return { job_id, position: (row?.n ?? 0) + 1 };
}

/**
 * One item of a batched enqueue: a job to add (or null when there is none), and a statement that must
 * run with it or not at all, such as the update that stamps the watch the job is for.
 */
export interface PlannedJob {
  job: Omit<Job, 'job_id'> | null;
  also?: D1PreparedStatement;
}

/**
 * Adds many jobs in one D1 batch instead of three round trips for each. The queue is counted once; jobs
 * beyond the room left before MAX_PENDING are not added, and neither are their companion statements. Items
 * that carry no job still run.
 * Returns how many items ran, and whether the queue filled up first.
 */
export async function enqueueBatch(db: D1Database, items: PlannedJob[]): Promise<{ ran: number; full: boolean }> {
  let room = MAX_PENDING - (await countPending(db));
  const statements: D1PreparedStatement[] = [];
  let ran = 0;
  let full = false;
  for (const plannedJob of items) {
    if (plannedJob.job !== null) {
      if (room <= 0) {
        full = true;
        continue;
      }
      room -= 1;
      statements.push(
        enqueueStatement(db, {
          kind: plannedJob.job.kind,
          priority: plannedJob.job.priority,
          payload_json: JSON.stringify(plannedJob.job.payload),
          bucket: plannedJob.job.bucket,
          reserved_cents: plannedJob.job.reserved_cents,
        }).statement,
      );
    }
    if (plannedJob.also) statements.push(plannedJob.also);
    ran += 1;
  }
  if (statements.length > 0) await db.batch(statements);
  return { ran, full };
}

/**
 * TinyFish's refusal message made safe for a log line: an address and a long quoted run (which could echo part of
 * the request, such as a name a caller typed) are replaced, whitespace is collapsed, and 200 characters are kept.
 */
export function safeDetail(text: string): string {
  return text
    .replace(/https?:\/\/[^\s"']+/g, '[address]')
    .replace(/"[^"]{41,}"/g, '"[text]"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * 4xx answers that can pass on their own (rate limit, request timeout, conflict, too early) follow the 5xx retry path.
 * The rest are refusals of the request or of the account, and the same request is refused again.
 */
const RETRIED_4XX = new Set([408, 409, 425, 429]);

/**
 * Starts pending jobs while fewer than two runs hold a slot, in priority then age order.
 * Returns the number of runs started.
 *
 * Limits per call: at most MAX_CONSIDERED pending jobs are considered; the call stops after
 * MAX_FAILED_STARTS failed starts; and once canStart refuses a bucket, the rest of that bucket
 * waits for a later call.
 *
 * Slot safety: the cron and a webhook can both call dispatch at the same time, and both can
 * pass the first count before either claims a job. So each job is claimed in two steps:
 * startJob moves it from pending to starting (only one caller can), then the count is taken
 * again. The claim counts as a slot, so if the total is now over two, this caller hands its
 * job back and stops. That hand-back does not count as an attempt: it is not the job's fault.
 */
export async function dispatch(env: Env, db: D1Database, shared: TinyFish): Promise<number> {
  let started = 0;
  let failedStarts = 0;
  let stepCapLogged = false;
  const refused = new Set<Bucket>();
  const candidates = await nextJobs(db, MAX_CONSIDERED);

  for (const next of candidates) {
    const job = toJob(next);
    // Runs on visitors' keys are on other accounts. They have two slots of their own and take none of this service's.
    const own = job.bucket === 'own';
    if ((await slotsHeld(db, own)) >= MAX_RUNNING) continue;
    if (refused.has(job.bucket)) continue;

    if (!(await startJob(db, job.job_id))) continue;

    if ((await slotsHeld(db, own)) > MAX_RUNNING) {
      await requeue(db, job.job_id, new Date().toISOString(), false);
      continue;
    }

    const now = new Date();
    const jobClient = await clientOf(env, db, shared, job);
    if (jobClient === null) {
      // The request that queued the job stores the visitor's key just after, so a young job waits for it.
      if (now.getTime() - Date.parse(next.created_at) < OWN_KEY_WAIT_MS) {
        await requeue(db, job.job_id, new Date(now.getTime() + OWN_KEY_RETRY_MS).toISOString(), false);
        continue;
      }
      await finishJob(db, job.job_id, 'failed');
      await callContinuation(env, db, shared, job, { reason: 'timeout', message: OWN_KEY_GONE });
      continue;
    }
    const client = jobClient;

    // The claimed job is in starting, so it counts as in flight; excluding it keeps its own
    // reservation from being counted twice.
    const verdict = await canStart(env, db, client, job.bucket, job.reserved_cents, now, job.job_id);
    if (!verdict.ok) {
      if (verdict.cause === 'wallet_unreadable') {
        // Nothing is known about the money, so the job is not refused. It goes back to pending for a
        // minute, without using an attempt, and the other jobs would meet the same wallet, so this round ends.
        // After MAX_WALLET_REQUEUES in a row it is finished failed and its continuation hears a timeout.
        const requeues = job.payload.wallet_requeues ?? 0;
        if (requeues >= MAX_WALLET_REQUEUES) {
          await finishJob(db, job.job_id, 'failed');
          await callContinuation(env, db, client, job, { reason: 'timeout' });
          break;
        }
        await setPayloadField(db, job.job_id, 'wallet_requeues', requeues + 1);
        await requeue(db, job.job_id, new Date(now.getTime() + WALLET_RETRY_MS).toISOString(), false);
        break;
      }
      refused.add(job.bucket);
      await finishJob(db, job.job_id, 'budget');
      await callContinuation(env, db, client, job, {
        reason: 'budget',
        resets_at: verdict.resets_at,
        cause: verdict.cause,
      });
      continue;
    }

    if (job.payload.wallet_requeues) await setPayloadField(db, job.job_id, 'wallet_requeues', 0);

    let run: { run_id: string; streaming_url?: string };
    try {
      // A run on a visitor's key carries no webhook: its address holds this service's secret, and the visitor can
      // read their own runs. Such a run is found finished by pollOwnRuns.
      run = await client.runAsync(
        job.bucket === 'own' ? job.payload.request : { ...job.payload.request, webhook_url: webhookUrl(env) },
      );
    } catch (err) {
      if (err instanceof TinyFishError && err.code === 'step_cap_unavailable') {
        // Retrying cannot help: the account refuses a custom step cap. Fail the job now.
        if (!stepCapLogged) console.error('queue: TinyFish refused max_steps; set AGENT_STEP_CAP to "off"');
        stepCapLogged = true;
        failedStarts += 1;
        await finishJob(db, job.job_id, 'failed');
        await callContinuation(env, db, client, job, { reason: 'source_unavailable' });
        if (failedStarts >= MAX_FAILED_STARTS) break;
        continue;
      }
      if (err instanceof TinyFishError && err.status >= 400 && err.status < 500 && !RETRIED_4XX.has(err.status)) {
        // TinyFish refused the request itself (a 400 INVALID_INPUT, say). The same request is refused again, so the
        // job fails now and the continuation hears start_refused. The line holds what TinyFish said, never the request.
        console.error(
          `queue: TinyFish refused to start a ${job.kind} job for ${job.payload.registry}: HTTP ${err.status}, code ${err.code}, message ${err.detail === undefined ? 'none' : safeDetail(err.detail)}`,
        );
        failedStarts += 1;
        await finishJob(db, job.job_id, 'failed');
        await callContinuation(env, db, client, job, { reason: 'start_refused' });
        if (failedStarts >= MAX_FAILED_STARTS) break;
        continue;
      }
      // Any failure to start counts as an attempt, so a job cannot retry forever.
      failedStarts += 1;
      await retryOrFail(env, db, client, job, next.attempt);
      // Only a TinyFish error is handled here. Anything else is a bug, so it is rethrown.
      if (!(err instanceof TinyFishError)) throw err;
      if (failedStarts >= MAX_FAILED_STARTS) break;
      continue;
    }

    let attached: boolean;
    try {
      attached = await attachRun(db, job.job_id, run.run_id);
    } catch (err) {
      // The run was paid for and has no job to hold it. Settle it from the reservation, then
      // surface the error.
      await settleFromReservation(db, job, run.run_id);
      throw err;
    }
    if (!attached) {
      await settleFromReservation(db, job, run.run_id);
      console.error(`queue: run ${run.run_id} started but job ${job.job_id} was no longer starting`);
      // The job's state is now unknown, so stop this round rather than start more paid runs.
      started += 1;
      break;
    }
    if (run.streaming_url) await setPayloadField(db, job.job_id, 'streaming_url', run.streaming_url);
    started += 1;
  }
  return started;
}

async function setPayloadField(db: D1Database, job_id: string, field: string, value: string | number): Promise<void> {
  await db
    .prepare(`UPDATE queue SET payload_json = json_set(COALESCE(payload_json, '{}'), '$.${field}', ?) WHERE job_id = ?`)
    .bind(value, job_id)
    .run();
}

/**
 * Settles a paid run from its job's reservation: the most it can cost. Settling by run id is
 * idempotent, so a later webhook or sweep for the same run cannot count it again.
 */
async function settleFromReservation(db: D1Database, job: Job, runId: string): Promise<void> {
  await settle(db, job.bucket, job.reserved_cents, Math.ceil(job.reserved_cents / CENTS_PER_STEP), runId);
}

/**
 * After a failed start: requeue for 30 seconds when the job has no attempt used up,
 * otherwise finish it failed and tell its continuation the job timed out.
 */
async function retryOrFail(env: Env, db: D1Database, client: TinyFish, job: Job, attempt: number): Promise<void> {
  if (attempt < 1) {
    await requeue(db, job.job_id, new Date(Date.now() + RETRY_DELAY_MS).toISOString());
    return;
  }
  await finishJob(db, job.job_id, 'failed');
  await callContinuation(env, db, client, job, { reason: 'timeout' });
}

/**
 * Handles a finished run, from a webhook or from sweep. Each run id is processed once.
 *
 * The run id is claimed first, with markWebhookSeen. A call that loses the claim returns at once.
 * If processing throws, the claim is released, so a later call can process the run again.
 * The cost is settled whenever a job holds the run, whatever the job's state. settle is
 * idempotent per run id, so a repeat cannot double-spend. Only the job state change and the
 * continuation depend on the job still being live.
 */
export async function onRunFinished(env: Env, db: D1Database, client: TinyFish, run: RunResult): Promise<void> {
  if (!(await markWebhookSeen(db, run.run_id))) return;
  try {
    await processFinishedRun(env, db, client, run);
  } catch (err) {
    await unmarkWebhookSeen(db, run.run_id);
    throw err;
  }
}

/**
 * The steps to charge for a run. A run result that carries no step list at all (not an empty one)
 * is looked up once; if that fails, the job's reservation is charged instead.
 */
async function stepsToCharge(client: TinyFish, run: RunResult, job: Job): Promise<number> {
  if (run.steps_used > 0 || Array.isArray(run.steps)) return run.steps_used;
  try {
    return (await client.getRun(run.run_id)).steps_used;
  } catch {
    return Math.ceil(job.reserved_cents / CENTS_PER_STEP);
  }
}

async function processFinishedRun(env: Env, db: D1Database, shared: TinyFish, run: RunResult): Promise<void> {
  const row = await findJobByRun(db, run.run_id);
  if (!row) {
    // Accounting limit: a run whose id was never recorded (runAsync accepted but threw before
    // returning it) cannot be settled here, because nothing in this ledger knows the run id.
    // The wallet floor in canStart is the backstop: it reads the provider's balance, not this ledger.
    // No job holds this run yet, so its bucket is unknown and it is not settled here. The claim
    // is released: the run may be attached to a job later, and sweep must be able to finish and
    // settle it then, which a held claim would block. The dispatcher settles a run whose attach
    // failed, so no run is left unpaid in the ledger.
    await unmarkWebhookSeen(db, run.run_id);
    return;
  }
  const job = toJob(row);
  const jobClient = await clientOf(env, db, shared, job);
  if (jobClient === null) {
    // The visitor's key is gone, so the captured pages cannot be read. The job ends and its check says why.
    if (row.state !== 'running' || row.run_id !== run.run_id) return;
    await callContinuation(env, db, shared, job, { reason: 'timeout', message: OWN_KEY_GONE });
    await finishJob(db, job.job_id, 'failed');
    return;
  }
  const client = jobClient;
  const charged = await stepsToCharge(client, run, job);
  const held = heldStepsOf(job.reserved_cents);
  if (charged > held) {
    console.warn(`run used more steps than were held: run ${run.run_id} used ${charged}, held ${held}`);
  }
  await settle(db, job.bucket, job.reserved_cents, charged, run.run_id);

  // A late webhook for a job that was requeued, or already finished, changes nothing further.
  if (row.state !== 'running' || row.run_id !== run.run_id) return;

  const retryable = run.status === 'FAILED' && RETRYABLE_ERRORS.has(run.error?.code ?? '');
  if (retryable && row.attempt < 1) {
    await requeue(db, job.job_id, new Date(Date.now() + RETRY_DELAY_MS).toISOString());
    return;
  }
  // The continuation runs before the job is marked, so a throw leaves the job running. A retry
  // of this run then runs the continuation again, and sweep also picks the job up.
  await callContinuation(env, db, client, job, retryable ? { reason: 'timeout' } : run);
  await finishJob(db, job.job_id, run.status === 'COMPLETED' ? 'done' : 'failed');
}

/**
 * Gives up on a running job: its run is charged from the reservation, the job is failed, and its
 * continuation hears it timed out. A late webhook for the same run cannot charge it again.
 * The run id is claimed first, as onRunFinished does, so a webhook for the same run cannot process
 * it again. If the claim is already held, another caller is handling the run and this one stops.
 */
async function abandon(env: Env, db: D1Database, client: TinyFish, row: JobRow, runId: string): Promise<void> {
  pollFailures.delete(row.job_id);
  if (!(await markWebhookSeen(db, runId))) return;
  try {
    const job = toJob(row);
    await settleFromReservation(db, job, runId);
    await finishJob(db, job.job_id, 'failed');
    await callContinuation(env, db, client, job, { reason: 'timeout' });
  } catch (err) {
    await unmarkWebhookSeen(db, runId);
    throw err;
  }
}

/**
 * A webhook claims its run id and then processes the run. If the isolate is cut off in between, the claim
 * stays and the job stays running, which holds an agent slot. A claim older than STALE_MS that still has
 * a running job on it is that case: the claim is released, so the sweep can finish or abandon the run.
 */
async function releaseStaleClaim(db: D1Database, runId: string, now: Date): Promise<void> {
  const claimedAt = await webhookSeenAt(db, runId);
  if (claimedAt === null) return;
  if (now.getTime() - Date.parse(claimedAt) > STALE_MS) await unmarkWebhookSeen(db, runId);
}

/** Handles one row from sweep. Returns true when it acted on the row. */
async function sweepRow(env: Env, db: D1Database, client: TinyFish, row: JobRow, now: Date): Promise<boolean> {
  if (row.state === 'starting') {
    if (row.attempt >= 1) {
      await finishJob(db, row.job_id, 'failed');
      await callContinuation(env, db, client, toJob(row), { reason: 'timeout' });
    } else {
      await requeue(db, row.job_id, now.toISOString());
    }
    return true;
  }
  if (row.run_id === null) return false;
  if (row.state === 'running') await releaseStaleClaim(db, row.run_id, now);

  const startedAt = Date.parse(row.started_at ?? '');
  const tooOld = Number.isFinite(startedAt) && now.getTime() - startedAt > MAX_RUN_AGE_MS;

  let run: RunResult;
  try {
    run = await (await clientForRun(env, db, client, row.run_id)).getRun(row.run_id);
  } catch {
    // A failed poll is counted; the job is looked at again next time, until the limit is hit.
    const failures = (pollFailures.get(row.job_id) ?? 0) + 1;
    pollFailures.set(row.job_id, failures);
    if (failures >= MAX_POLL_FAILURES || tooOld) {
      await abandon(env, db, client, row, row.run_id);
      return true;
    }
    return false;
  }
  pollFailures.delete(row.job_id);

  if (!TERMINAL_STATUSES.has(run.status)) {
    if (!tooOld) return false;
    await abandon(env, db, client, row, row.run_id);
    return true;
  }
  await onRunFinished(env, db, client, { ...run, run_id: row.run_id });
  return true;
}

/**
 * Runs on a visitor's key send no webhook, so each running one is read here. Called every minute, and when the
 * visitor's page asks how its check is doing. Returns the number of jobs it acted on.
 */
export async function pollOwnRuns(env: Env, db: D1Database, client: TinyFish, check_id?: string): Promise<number> {
  const now = new Date();
  const one = check_id === undefined ? '' : " AND json_extract(payload_json, '$.check_id') = ?";
  const sql = `SELECT * FROM queue WHERE state = 'running' AND bucket = 'own'${one} ORDER BY started_at ASC LIMIT ?`;
  const binds = check_id === undefined ? [MAX_SWEEP_ROWS] : [check_id, MAX_SWEEP_ROWS];
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<JobRow>();
  let handled = 0;
  for (const row of results) {
    try {
      if (await sweepRow(env, db, client, row, now)) handled += 1;
    } catch (err) {
      console.error(`queue: could not read the run of job ${row.job_id}`, err);
      if (err instanceof ContinuationFailed) await finishJob(db, row.job_id, 'failed');
    }
  }
  return handled;
}

/**
 * Picks up runs whose webhook never arrived. Each stale row is handled on its own: an error on
 * one row is logged and the rest still run. A continuation that throws finishes its job failed.
 * Returns the number of jobs it acted on.
 */
export async function sweep(env: Env, db: D1Database, client: TinyFish): Promise<number> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - STALE_MS).toISOString();
  let handled = 0;

  for (const row of await staleRunning(db, cutoff, MAX_SWEEP_ROWS)) {
    try {
      if (await sweepRow(env, db, client, row, now)) handled += 1;
    } catch (err) {
      console.error(`queue: sweep could not handle job ${row.job_id}`, err);
      if (err instanceof ContinuationFailed) {
        await finishJob(db, row.job_id, 'failed').catch((e: unknown) =>
          console.error(`queue: could not finish job ${row.job_id}`, e),
        );
      }
    }
  }
  return handled;
}
