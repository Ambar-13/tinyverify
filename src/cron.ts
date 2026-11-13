/** Scheduled work. wrangler.toml lists the cron expressions; each one maps to the steps below. */

import type { Env } from './env';
import { dropStaleOwnKeys } from './queue/own-key';
import { dispatch, pollOwnRuns, sweep } from './queue/queue';
import { purgeOlderThan } from './store';
import { clientFor } from './tinyfish/service-client';
import { runAll } from './watch/canary';
import { enqueueRechecks } from './watch/watch';

const DAY_MS = 86_400_000;

/** Runs the work for one cron expression. Each step is logged on failure, so one failure does not stop the rest. */
export async function runCron(cron: string, env: Env, now: Date = new Date()): Promise<void> {
  const db = env.DB;
  const client = clientFor(env);
  switch (cron) {
    case '* * * * *':
      await step('dispatch', () => dispatch(env, db, client));
      await step('sweep', () => sweep(env, db, client));
      await step('pollOwnRuns', () => pollOwnRuns(env, db, client));
      await step('dropStaleOwnKeys', () => dropStaleOwnKeys(db, now));
      return;
    case '0 11 * * *':
      await step('enqueueRechecks', () => enqueueRechecks(env, db, now));
      return;
    case '0 12 * * *':
      await step('canary.runAll', () => runAll(env, db, client, now));
      return;
    case '0 13 * * *':
      await step('purgeOlderThan', () => purgeOlderThan(db, new Date(now.getTime() - 7 * DAY_MS).toISOString()));
      return;
    default:
      console.warn(`No work is set for the cron ${cron}`);
  }
}

async function step(name: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (err) {
    console.error(`cron step ${name} failed`, err);
  }
}
