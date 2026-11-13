import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { continuations } from '../src/queue/queue';

// The Worker entry imports everything it needs, so the modules are evaluated when the Worker starts
// and not inside the first request.
const entrySource = Object.values(
  import.meta.glob('../src/index.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>,
)[0];

describe('Worker entry', () => {
  it('has no dynamic import, so no module is evaluated inside a request', () => {
    expect(entrySource).toBeTruthy();
    expect(entrySource).not.toMatch(/\bimport\s*\(/);
    expect(entrySource).toMatch(/^import \{ runCron \} from '\.\/cron';$/m);
    expect(entrySource).toMatch(/^import \{ app \} from '\.\/http\/app';$/m);
  });

  it('has registered every queue continuation before any request or cron run', () => {
    for (const kind of ['search', 'record', 'discipline', 'recheck', 'recheck_complaints', 'canary'] as const) {
      expect(continuations.has(kind), kind).toBe(true);
    }
  });

  it('serves a request through the static app', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request('http://localhost/health'), env as never, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});
