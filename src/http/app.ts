/**
 * The Hono app: JSON replies for unknown paths and uncaught errors, then the API routes, /mcp and the demo page, in
 * that order.
 */

import { Hono } from 'hono';
import { mountApi } from './api';
import { mcpApp } from './mcp';
import { pageApp } from '../web/page';
import type { Env } from '../env';
// Importing these modules registers their queue continuations.
import '../lookup/check';
import '../watch/watch';
import '../watch/canary';

export const app = new Hono<{ Bindings: Env }>();

app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: { code: 'internal', message: 'Something went wrong' } }, 500);
});

mountApi(app);
app.route('/mcp', mcpApp);
// Mounted last, so the API routes win over the page.
app.route('/', pageApp);
