/** Work that carries on after the response has been sent. */

import type { Env } from '../env';
import { dispatch } from '../queue/queue';
import type { TinyFish } from '../tinyfish/client';

/** The part of a request context that can keep the Worker alive after the response. */
export type CanWait = { executionCtx: { waitUntil(promise: Promise<unknown>): void } };

/**
 * Runs work after the response when the platform allows it. Outside the platform there is no
 * execution context, so the work is awaited instead.
 */
export async function later(c: CanWait, work: () => Promise<void>): Promise<void> {
  const pending = work();
  try {
    c.executionCtx.waitUntil(pending);
  } catch {
    await pending;
  }
}

/**
 * Starts the jobs that are waiting now, instead of at the next minute tick. A check that is not done
 * has a job in the queue. The dispatch runs after the response when the platform allows, and a failure
 * is logged: the minute cron dispatches again either way.
 */
export async function dispatchSoon(c: CanWait, env: Env, client: TinyFish, result: { state: string }): Promise<void> {
  if (result.state === 'done') return;
  await later(c, async () => {
    try {
      await dispatch(env, env.DB, client);
    } catch (err) {
      console.error('dispatch after enqueue failed', err);
    }
  });
}
