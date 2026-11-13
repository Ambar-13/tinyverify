import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { app } from '../src/http/app';

const hookUrl = (source: 'monitor' | 'run', secret: string) => `http://localhost/hooks/tinyfish/${source}/${secret}`;

const countRawWebhooks = async () => {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM raw_webhooks').first<{ n: number }>();
  return row?.n ?? 0;
};

describe('health', () => {
  it('GET /health returns ok', async () => {
    const res = await app.request('/health', {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, version: '0.1.0' });
  });
});

describe('TinyFish webhook sink', () => {
  it('monitor hook with wrong secret is 404 and stores nothing', async () => {
    const res = await app.request(
      hookUrl('monitor', 'wrong-secret'),
      { method: 'POST', body: '{"event":"change"}' },
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
    expect(await countRawWebhooks()).toBe(0);
  });

  it('monitor hook with the right secret stores the raw body and returns 200', async () => {
    const body = '{"event":"change","watch":"w1"}';
    const res = await app.request(hookUrl('monitor', 'test-hook-secret'), { method: 'POST', body }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const row = await env.DB.prepare('SELECT source, body FROM raw_webhooks').first<{
      source: string;
      body: string;
    }>();
    expect(row).toEqual({ source: 'monitor', body });
    expect(await countRawWebhooks()).toBe(1);
  });

  it('run hook with the right secret stores the raw body under source run', async () => {
    const res = await app.request(hookUrl('run', 'test-hook-secret'), { method: 'POST', body: '{"run":"r1"}' }, env);
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT source FROM raw_webhooks').first<{ source: string }>();
    expect(row?.source).toBe('run');
  });

  it('run hook with wrong secret is 404 and stores nothing', async () => {
    const res = await app.request(hookUrl('run', 'nope'), { method: 'POST', body: '{}' }, env);
    expect(res.status).toBe(404);
    expect(await countRawWebhooks()).toBe(0);
  });

  it('an empty HOOK_SECRET binding makes every hook post a 404', async () => {
    const noSecretEnv = { ...env, HOOK_SECRET: '' };
    for (const source of ['monitor', 'run'] as const) {
      const res = await app.request(hookUrl(source, 'test-hook-secret'), { method: 'POST', body: '{}' }, noSecretEnv);
      expect(res.status).toBe(404);
    }
    expect(await countRawWebhooks()).toBe(0);
  });

  it('a wrong secret of the same byte length is 404 and stores nothing', async () => {
    const sameLength = 'x'.repeat('test-hook-secret'.length);
    const res = await app.request(hookUrl('monitor', sameLength), { method: 'POST', body: '{}' }, env);
    expect(res.status).toBe(404);
    expect(await countRawWebhooks()).toBe(0);
  });

  it('a near-miss secret (right secret plus one character) is 404 and stores nothing', async () => {
    const res = await app.request(hookUrl('monitor', 'test-hook-secret!'), { method: 'POST', body: '{}' }, env);
    expect(res.status).toBe(404);
    expect(await countRawWebhooks()).toBe(0);
  });

  it('empty body is stored as an empty string and returns 200', async () => {
    const res = await app.request(hookUrl('monitor', 'test-hook-secret'), { method: 'POST' }, env);
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT body FROM raw_webhooks').first<{ body: string }>();
    expect(row?.body).toBe('');
  });
});
