/**
 * Worker entry: HTTP requests go to the app, cron ticks to runCron.
 *
 * Everything is imported statically, so the modules are evaluated once when the Worker starts and not inside the
 * first request. Importing the app also registers the queue continuations, which the cron path needs.
 */

import { runCron } from './cron';
import type { Env } from './env';
import { app } from './http/app';

export default {
  fetch: (request, env, ctx): Promise<Response> | Response => app.fetch(request, env, ctx),
  scheduled: async (event, env, ctx): Promise<void> => {
    ctx.waitUntil(runCron(event.cron, env));
  },
} satisfies ExportedHandler<Env>;
