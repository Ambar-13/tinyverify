import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { registries } from '../src/registries/catalog';
import { app } from '../src/http/app';
import { runIdFromWebhook } from '../src/http/api';
import { countedLookup } from '../src/http/limits';
import { setClientFactory } from '../src/tinyfish/service-client';
import { resetWalletCache } from '../src/queue/budget';
import { setOwnClientFactory } from '../src/queue/own-key';
import { continuations, dispatch, sweep } from '../src/queue/queue';
import { TinyFishError } from '../src/tinyfish/client';
import type { TinyFish } from '../src/tinyfish/client';
import {
  insertCheck,
  insertEvent,
  insertSnapshot,
  insertWatch,
  getCheck,
  getSnapshot,
  listEvents,
  getWatch,
  markWebhookSeen,
  setWatchTier,
  updateWatchFields,
} from '../src/store';
import type { Fields } from '../src/types';
import mqaClear from './fixtures/watch/mqa-clear.html?raw';
import expectedClear from './fixtures/fl-mqa/live-physician-1.fetch.expected.json';

// The dispatcher still runs for real. The spy only counts how often the routes call it.
vi.mock('../src/queue/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/queue/queue')>();
  return { ...actual, dispatch: vi.fn(actual.dispatch) };
});

const ADMIN = { Authorization: 'Bearer test-admin-key' };
const JUDGE = { Authorization: 'Bearer test-api-key' };
const DAY_MS = 86_400_000;

// A TinyFish stand-in. Only the calls the API reaches are provided; each records its use.
function stubClient() {
  const calls: { name: string; args: unknown[] }[] = [];
  const record =
    (name: string, value: unknown) =>
    async (...args: unknown[]) => {
      calls.push({ name, args });
      return value;
    };
  const client = {
    calls,
    wallet: record('wallet', { balance_cents: 1_000_000 }),
    fetchPages: record('fetchPages', { results: [], errors: [] }),
    search: record('search', { results: [] }),
    // A Monitor run reads the licence page, as the real one does.
    runMonitorNow: record('runMonitorNow', { id: 'run_now_1', results: [{ text: mqaClear }], errors: [] }),
    stepScreenshot: async (run_id: string, step_id: string) => {
      calls.push({ name: 'stepScreenshot', args: [run_id, step_id] });
      return new Response('PNGDATA', { headers: { 'Content-Type': 'image/png' } });
    },
    createMonitor: record('createMonitor', {
      monitor: { id: 'mon_new' },
      run: { id: 'run_new', results: [], errors: [] },
    }),
    deleteMonitor: record('deleteMonitor', undefined),
    // A run webhook only wakes the service, which reads the run from here. Tests that care override it.
    getRun: async (id: string) => ({
      run_id: id,
      status: 'COMPLETED',
      result: {},
      steps: [],
      steps_used: 0,
      error: null,
    }),
  };
  return client;
}

// Budgets are raised so these tests exercise the rules under test, not the daily spend limit.
const roomy = {
  ...env,
  PUBLIC_DAILY_CENTS: '1000000',
  JUDGE_DAILY_CENTS: '1000000',
  OPS_DAILY_CENTS: '1000000',
  CEILING_CENTS: '10000000',
};

function useStub(overrides: Record<string, unknown> = {}) {
  const stub = { ...stubClient(), ...overrides };
  setClientFactory(() => stub as unknown as TinyFish);
  return stub;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}, e: object = roomy) {
  return app.request(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    e as never,
  );
}

afterEach(() => {
  vi.useRealTimers();
  setClientFactory(null);
});

// California lookups are refused from Sunday 20:00 to Monday 06:00 Pacific, and the service reads the real
// clock, so tests that queue a California lookup fix the time. Only Date is faked; timers keep running.
const OPEN_HOURS = '2026-11-11T18:00:00Z'; // Wednesday 10:00 Pacific
const MAINTENANCE = '2026-11-09T05:00:00Z'; // Sunday 21:00 Pacific
function setNow(iso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

describe('POST /verify', () => {
  it('uses the public bucket when no key is sent', async () => {
    setNow(OPEN_HOURS);
    useStub();
    const res = await post('/verify', { record_type: 'contractor', jurisdiction: 'US-CA', name: 'Public Builder' });
    expect(res.status).toBeLessThan(500);
    const row = await env.DB.prepare('SELECT bucket FROM queue ORDER BY rowid DESC LIMIT 1').first<{
      bucket: string;
    }>();
    expect(row?.bucket).toBe('public');
  });

  it('refuses a California lookup inside the board maintenance window, with the time it ends', async () => {
    setNow(MAINTENANCE);
    useStub();
    const res = await post('/verify', {
      record_type: 'contractor',
      jurisdiction: 'US-CA',
      name: 'Sunday Night Builder',
    });
    expect(res.status).toBeLessThan(500);
    const body = (await res.json()) as {
      state: string;
      outcome: string;
      unavailable: { reason: string; retry_after: string };
    };
    expect(body.state).toBe('done');
    expect(body.outcome).toBe('source_unavailable');
    expect(body.unavailable).toMatchObject({ reason: 'maintenance', retry_after: '2026-11-09T14:00:00.000Z' });
  });

  it('refuses the 21st public agent lookup from one IP in an hour with 429 and resets_at', async () => {
    useStub();
    const ip = { 'CF-Connecting-IP': '198.51.100.7' };
    for (let i = 0; i < 20; i++) {
      const res = await post(
        '/verify',
        { record_type: 'contractor', jurisdiction: 'US-CA', name: `Limit Builder ${i}` },
        ip,
      );
      expect(res.status).not.toBe(429);
    }
    const res = await post(
      '/verify',
      { record_type: 'contractor', jurisdiction: 'US-CA', name: 'Limit Builder 21' },
      ip,
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; message: string }; resets_at: string };
    expect(body.error.code).toBe('rate_limited');
    expect(Date.parse(body.resets_at)).toBeGreaterThan(Date.now());
  });

  it('answers invalid JSON with 400 invalid_input', async () => {
    useStub();
    const res = await post('/verify', '{not json');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_input');
  });
});

describe('POST /verify input validation', () => {
  const checkCount = async (): Promise<number> =>
    (await env.DB.prepare('SELECT COUNT(*) AS n FROM checks').first<{ n: number }>())?.n ?? -1;

  async function refused(body: unknown): Promise<{ status: number; error: { code: string; message: string } }> {
    useStub();
    const before = await checkCount();
    const res = await post('/verify', body);
    // A body that fails the schema never reaches startCheck, which would have stored a check.
    expect(await checkCount()).toBe(before);
    const parsed = (await res.json()) as { error: { code: string; message: string } };
    return { status: res.status, error: parsed.error };
  }

  it('answers 400 invalid_input when record_type is missing', async () => {
    const r = await refused({ jurisdiction: 'US-FL', name: 'Jane Doe' });
    expect(r.status).toBe(400);
    expect(r.error.code).toBe('invalid_input');
    expect(r.error.message).toContain('record_type is required');
  });

  it('answers 400 invalid_input when jurisdiction is missing', async () => {
    const r = await refused({ record_type: 'physician', name: 'Jane Doe' });
    expect(r.status).toBe(400);
    expect(r.error.message).toContain('jurisdiction is required');
  });

  it('answers 400 invalid_input when name is a number', async () => {
    const r = await refused({ record_type: 'physician', jurisdiction: 'US-FL', name: 123 });
    expect(r.status).toBe(400);
    expect(r.error.code).toBe('invalid_input');
    expect(r.error.message).toContain('name must be text');
  });

  it('answers 400 for any other field of the wrong type, and names every field that is wrong', async () => {
    const r = await refused({
      record_type: 'physician',
      jurisdiction: 'US-FL',
      licence_number: 5,
      first_name: ['Jane'],
      last_name: null,
      city: {},
      include_complaints: 'yes',
    });
    expect(r.status).toBe(400);
    for (const field of ['licence_number', 'first_name', 'last_name', 'city', 'include_complaints']) {
      expect(r.error.message).toContain(field);
    }
  });

  it('answers 400 when check_id is not text, on the refinement path', async () => {
    const r = await refused({ check_id: 5, candidate_id: 'cand_1' });
    expect(r.status).toBe(400);
    expect(r.error.code).toBe('invalid_input');
  });

  it('answers 400 with the result as the body when startCheck refuses the input, for a city given as the place', async () => {
    useStub();
    const res = await post('/verify', { record_type: 'contractor', jurisdiction: 'Miami', name: 'Raj Patel' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { check_id: string; state: string; outcome: string; invalid: { field: string } };
    expect(body.state).toBe('done');
    expect(body.outcome).toBe('invalid_input');
    expect(body.invalid.field).toBe('jurisdiction');
    expect(body.check_id).toMatch(/^chk_/);
  });

  it('answers 400 for a licence number that breaks a published format', async () => {
    useStub();
    const res = await post('/verify', {
      record_type: 'contractor',
      jurisdiction: 'California',
      licence_number: 'ABC-12345',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { outcome: string }).outcome).toBe('invalid_input');
  });

  it('does not count a refused body against the visitor hourly limit', async () => {
    useStub();
    const ip = { 'CF-Connecting-IP': '198.51.100.99' };
    for (let i = 0; i < 25; i++) {
      expect((await post('/verify', { jurisdiction: 'US-FL', name: 'No Type' }, ip)).status).toBe(400);
    }
    for (let i = 0; i < 25; i++) {
      expect(
        (await post('/verify', { record_type: 'contractor', jurisdiction: 'Miami', name: 'Raj Patel' }, ip)).status,
      ).toBe(400);
    }
    const ok = await post('/verify', { record_type: 'contractor', jurisdiction: 'US-CA', name: 'Fresh Builder' }, ip);
    expect(ok.status).not.toBe(429);
    expect(ok.status).not.toBe(400);
  });

  it('still accepts a well formed body with only the required fields', async () => {
    useStub();
    const res = await post('/verify', { record_type: 'contractor', jurisdiction: 'US-CA', name: 'Plain Builder' });
    expect(res.status).toBeLessThan(400);
  });
});

describe('GET /verify/:id', () => {
  it('returns 404 for an unknown check id', async () => {
    const res = await app.request('/verify/chk_missing', {}, roomy as never);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
  });
});

describe('POST /watch', () => {
  it('answers 401 when neither an admin nor an API key is sent', async () => {
    useStub();
    const res = await post('/watch', { kind: 'record', registry: 'fl-mqa', licence_number: 'ME000000' });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unauthorised');
  });

  it('creates a record watch with an API key, reads it back and deletes it', async () => {
    useStub();
    const created = await post('/watch', { kind: 'record', registry: 'fl-mqa', licence_number: 'ME000000' }, JUDGE);
    expect(created.status).toBe(201);
    const { watch_id } = (await created.json()) as { watch_id: string };

    const read = await app.request(`/watch/${watch_id}`, { headers: JUDGE }, roomy as never);
    expect(read.status).toBe(200);

    const del = await app.request(`/watch/${watch_id}`, { method: 'DELETE', headers: JUDGE }, roomy as never);
    expect(del.status).toBe(200);
    const gone = await app.request(`/watch/${watch_id}`, { headers: JUDGE }, roomy as never);
    expect(gone.status).toBe(404);
  });

  it('answers 400 invalid_input for a record licence number the registry does not publish', async () => {
    useStub();
    const res = await post('/watch', { kind: 'record', registry: 'fl-mqa', licence_number: 'bad' }, JUDGE);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_input');
  });

  it('answers 409 watch_limit with the count of both tiers once the ceiling is reached', async () => {
    useStub();
    // Twenty-eight monitor-tier and two re-check-tier watches: all of them count.
    for (let i = 0; i < 28; i++) {
      await insertWatch(env.DB, {
        kind: 'record',
        registry: 'fl-mqa',
        licence_number: `ME${String(100000 + i)}`,
        name: null,
        monitor_id: `mon_${i}`,
        caller_webhook: null,
      });
    }
    for (let i = 0; i < 2; i++) {
      await insertWatch(env.DB, {
        kind: 'record',
        registry: 'ca-cslb',
        licence_number: `12345${i}`,
        name: null,
        monitor_id: null,
        caller_webhook: null,
      });
    }
    const res = await post('/watch', { kind: 'record', registry: 'fl-mqa', licence_number: 'ME999999' }, JUDGE);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string }; count: number };
    expect(body.error.code).toBe('watch_limit');
    expect(body.count).toBe(30);
  });

  it('answers 400 invalid_input for a bulletin kind and creates no watch', async () => {
    useStub();
    const res = await post('/watch', { kind: 'bulletin', registry: 'fl-mqa', name: 'Jane Doe' }, JUDGE);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'invalid_input', message: 'kind must be "record"' } });
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM watches').first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it('refuses a record watch on a registry that is not connected, and creates no watch row', async () => {
    const stub = useStub();
    const res = await post('/watch', { kind: 'record', registry: 'au-ahpra', licence_number: 'MED0001' }, JUDGE);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'unsupported', message: 'This registry is not connected yet' } });
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM watches').first<{ n: number }>();
    expect(rows?.n).toBe(0);
    expect(stub.calls.some((c) => c.name === 'createMonitor')).toBe(false);
  });
});

describe('POST /watch takes the inputs of POST /verify', () => {
  const verifyBody = { licence_number: 'ME000000', record_type: 'physician', jurisdiction: 'Florida' };
  const watchRows = async (): Promise<{ kind: string; registry: string; licence_number: string | null }[]> =>
    (
      await env.DB.prepare('SELECT kind, registry, licence_number FROM watches').all<{
        kind: string;
        registry: string;
        licence_number: string | null;
      }>()
    ).results;

  it('creates a record watch on fl-mqa from the body /verify accepts for a Florida physician by licence number', async () => {
    useStub();
    const res = await post('/watch', verifyBody, JUDGE);
    expect(res.status).toBe(201);
    expect(await watchRows()).toEqual([{ kind: 'record', registry: 'fl-mqa', licence_number: 'ME000000' }]);
  });

  it('reads the record type and the place the way /verify does: "MD" and "FL" name the same registry', async () => {
    useStub();
    const res = await post('/watch', { licence_number: 'ME000001', record_type: 'MD', jurisdiction: 'US-FL' }, JUDGE);
    expect(res.status).toBe(201);
    expect((await watchRows())[0].registry).toBe('fl-mqa');
  });

  it('answers 400 unsupported, as /verify would, for a place with no connected registry, and makes no watch', async () => {
    useStub();
    for (const body of [
      { licence_number: 'MED0001', record_type: 'physician', jurisdiction: 'Australia' },
      { licence_number: 'ME000000', record_type: 'physician', jurisdiction: 'California' },
      { licence_number: 'ME000000', record_type: 'physician', jurisdiction: 'Texas' },
    ]) {
      const res = await post('/watch', body, JUDGE);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unsupported');
    }
    expect(await watchRows()).toEqual([]);
  });

  it('answers 400 invalid_input for a record type or a place nobody knows', async () => {
    useStub();
    for (const body of [
      { licence_number: 'ME000000', record_type: 'wizard', jurisdiction: 'Florida' },
      { licence_number: 'ME000000', record_type: 'physician', jurisdiction: 'Narnia' },
      { licence_number: 'ME000000', record_type: 'physician' },
    ]) {
      const res = await post('/watch', body, JUDGE);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_input');
    }
    expect(await watchRows()).toEqual([]);
  });

  it('lists the ids when more than one registry covers the type and place', async () => {
    useStub();
    const dbpr = registries.find((r) => r.id === 'fl-dbpr');
    if (!dbpr) throw new Error('fl-dbpr missing');
    const before = dbpr.types;
    dbpr.types = [...before, 'physician'];
    try {
      const res = await post('/watch', verifyBody, JUDGE);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: {
          code: 'invalid_input',
          message: 'More than one registry covers that. Send registry as one of: fl-mqa, fl-dbpr.',
        },
      });
      expect(await watchRows()).toEqual([]);
    } finally {
      dbpr.types = before;
    }
  });

  it('an explicit registry and kind create the watch, and an explicit registry wins over record_type', async () => {
    useStub();
    const res = await post(
      '/watch',
      {
        kind: 'record',
        registry: 'fl-mqa',
        licence_number: 'ME000002',
        record_type: 'contractor',
        jurisdiction: 'California',
      },
      JUDGE,
    );
    expect(res.status).toBe(201);
    expect(await watchRows()).toEqual([{ kind: 'record', registry: 'fl-mqa', licence_number: 'ME000002' }]);
  });

  it('with neither a registry nor a record type and place it still asks for a registry; with no kind and no licence it still asks for a kind', async () => {
    useStub();
    const a = await post('/watch', { kind: 'record', licence_number: 'ME000000' }, JUDGE);
    expect(a.status).toBe(400);
    expect(((await a.json()) as { error: { message: string } }).error.message).toMatch(/registry/);
    const b = await post('/watch', { registry: 'fl-mqa', name: 'Jane Doe' }, JUDGE);
    expect(b.status).toBe(400);
    expect(((await b.json()) as { error: { message: string } }).error.message).toMatch(/kind/);
  });
});

describe('POST /watch/:id/check-now', () => {
  const checkNow = (watch_id: string): Response | Promise<Response> =>
    app.request(`/watch/${watch_id}/check-now`, { method: 'POST', headers: ADMIN }, roomy as never);
  async function monitoredWatch(): Promise<string> {
    const watch_id = await insertWatch(env.DB, {
      kind: 'record',
      registry: 'fl-mqa',
      licence_number: 'ME000000',
      name: null,
      monitor_id: 'mon_1',
      caller_webhook: null,
    });
    await updateWatchFields(env.DB, watch_id, expectedClear as unknown as Fields);
    return watch_id;
  }

  it('runs a monitor-tier watch now through the same comparison as a webhook, and says processed', async () => {
    const stub = useStub();
    const watch_id = await monitoredWatch();
    const res = await checkNow(watch_id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, outcome: 'processed' });
    expect(stub.calls.some((c) => c.name === 'runMonitorNow' && c.args[0] === 'mon_1')).toBe(true);
    expect((await listEvents(env.DB, watch_id)).map((e) => e.kind)).toEqual(['unchanged']);
  });

  it('answers 502 and records nothing when the run it started cannot be read', async () => {
    useStub({ runMonitorNow: async () => ({ results: [], errors: [] }) });
    const watch_id = await monitoredWatch();

    const res = await checkNow(watch_id);

    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_checked');
    expect(await listEvents(env.DB, watch_id)).toHaveLength(0);
  });

  it('answers 502 not_checked when the page could not be read, and says the failed check was recorded', async () => {
    useStub({ runMonitorNow: async () => ({ id: 'run_blank', results: [{ text: '' }], errors: [] }) });
    const watch_id = await monitoredWatch();
    const res = await checkNow(watch_id);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: 'not_checked', message: 'The registry page could not be read. The failed check was recorded.' },
    });
    expect((await listEvents(env.DB, watch_id)).map((e) => e.kind)).toEqual(['check_failed']);
  });

  it('answers 502 not_checked when the Monitor run reported errors', async () => {
    useStub({ runMonitorNow: async () => ({ id: 'run_err', results: [], errors: [{ code: 'timeout' }] }) });
    const watch_id = await monitoredWatch();
    const res = await checkNow(watch_id);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_checked');
    expect((await listEvents(env.DB, watch_id)).map((e) => e.kind)).toEqual(['check_failed']);
  });

  it('answers 200 already_recorded when the Monitor webhook for the same run was handled first', async () => {
    useStub({ runMonitorNow: async () => ({ id: 'run_dup', results: [{ text: mqaClear }], errors: [] }) });
    const watch_id = await monitoredWatch();
    await markWebhookSeen(env.DB, 'run_dup');
    const res = await checkNow(watch_id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, outcome: 'already_recorded' });
  });
});

describe('GET /status and GET /registries', () => {
  it('GET /status lists four registries', async () => {
    const res = await app.request('/status', {}, roomy as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { registries: { id: string; health: string }[]; budget: Record<string, string> };
    expect(body.registries.map((r) => r.id).sort()).toEqual(['au-ahpra', 'ca-cslb', 'fl-dbpr', 'fl-mqa']);
    expect(body.registries.find((r) => r.id === 'au-ahpra')?.health).toBe('not_connected');
    expect(body.registries.find((r) => r.id === 'fl-mqa')?.health).toBe('unknown');
    expect(Object.keys(body.budget).sort()).toEqual(['judge', 'ops', 'public']);
  });

  it('GET /status has no feeds key', async () => {
    const res = await app.request('/status', {}, roomy as never);
    expect(Object.keys((await res.json()) as object)).not.toContain('feeds');
  });

  it('GET /registries gives the read route, watch tier and health of each connected registry', async () => {
    const res = await app.request('/registries', {}, roomy as never);
    const body = (await res.json()) as {
      registries: { id: string; read_route: string; watch_tier: string; health: string }[];
    };
    expect(body.registries.map((r) => r.id).sort()).toEqual(['ca-cslb', 'fl-dbpr', 'fl-mqa']);
    const cslb = body.registries.find((r) => r.id === 'ca-cslb');
    expect(cslb).toMatchObject({ read_route: 'agent', watch_tier: 'recheck', health: 'unknown' });
  });
});

describe('POST /admin/feeds', () => {
  it('answers 404 for the admin key', async () => {
    useStub();
    expect((await post('/admin/feeds', {}, ADMIN)).status).toBe(404);
  });
});

describe('hooks', () => {
  it('answers 404 for the run hook with a bad secret and stores nothing', async () => {
    const res = await post('/hooks/tinyfish/run/wrong-secret', { data: { run_id: 'run_1' } });
    expect(res.status).toBe(404);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM raw_webhooks WHERE source = 'run'").first<{
      n: number;
    }>();
    expect(count?.n).toBe(0);
  });

  it('answers 404 for the monitor hook with a bad secret', async () => {
    const res = await post('/hooks/tinyfish/monitor/wrong-secret', { fetch_monitor_id: 'mon_1', id: 'run_1' });
    expect(res.status).toBe(404);
  });

  it('stores a good run webhook and answers 200 without throwing to the sender', async () => {
    useStub();
    const res = await post('/hooks/tinyfish/run/test-hook-secret', {
      data: { run_id: 'run_unknown', status: 'COMPLETED', result: {}, steps: [] },
    });
    expect(res.status).toBe(200);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM raw_webhooks WHERE source = 'run'").first<{
      n: number;
    }>();
    expect(count?.n).toBe(1);
  });

  it('answers 200 to a run webhook whose body is not JSON', async () => {
    useStub();
    const res = await post('/hooks/tinyfish/run/test-hook-secret', 'not json');
    expect(res.status).toBe(200);
  });
});

describe('ignored webhooks are logged with a reason and never the body', () => {
  const MARKER = 'BODY-MARKER-7f3a';
  const monitorHook = (body: unknown) => post('/hooks/tinyfish/monitor/test-hook-secret', body);
  const runHook = (body: unknown) => post('/hooks/tinyfish/run/test-hook-secret', body);

  async function logged(
    send: () => Response | Promise<Response>,
  ): Promise<{ status: number; warns: string[]; errors: number }> {
    useStub();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await send();
      // No logged argument, of any kind, carries what the sender wrote.
      const everything = JSON.stringify([...warn.mock.calls, ...error.mock.calls].map((args) => args.map(String)));
      expect(everything).not.toContain(MARKER);
      return {
        status: res.status,
        warns: warn.mock.calls.map((args) => args.join(' ')),
        errors: error.mock.calls.length,
      };
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  }

  it('logs one line for a Monitor webhook with an id no watch has', async () => {
    const r = await logged(() => monitorHook({ fetch_monitor_id: 'mon_nobody', id: 'run_1', note: MARKER }));
    expect(r.status).toBe(200);
    expect(r.warns).toEqual(['Monitor webhook ignored: no watch has that monitor id']);
    expect(r.errors).toBe(0);
  });

  it('logs one line for a Monitor webhook of a shape it does not recognise', async () => {
    const r = await logged(() => monitorHook({ event: 'change', note: MARKER }));
    expect(r.status).toBe(200);
    expect(r.warns).toEqual(['Monitor webhook ignored: the body is not a monitor run']);
  });

  it('logs one line for a Monitor webhook body that is not JSON, without the parser message', async () => {
    const r = await logged(() => monitorHook(`not json ${MARKER}`));
    expect(r.status).toBe(200);
    expect(r.warns).toEqual(['Monitor webhook ignored: the body is not JSON']);
    expect(r.errors).toBe(0);
  });

  it('logs one line for a run webhook body that is not JSON, without the parser message', async () => {
    const r = await logged(() => runHook(`not json ${MARKER}`));
    expect(r.status).toBe(200);
    expect(r.warns).toEqual(['Run webhook ignored: the body is not JSON']);
    expect(r.errors).toBe(0);
  });

  it('logs one line for a run webhook that is JSON but has no run id', async () => {
    const r = await logged(() => runHook({ data: { note: MARKER } }));
    expect(r.status).toBe(200);
    expect(r.warns).toEqual(['Run webhook ignored: the body has no run id']);
  });

  it('logs nothing for a run webhook it can read', async () => {
    const r = await logged(() =>
      runHook({ data: { run_id: 'run_unknown_log', status: 'COMPLETED', result: {}, steps: [] } }),
    );
    expect(r.status).toBe(200);
    expect(r.warns).toEqual([]);
  });

  it('still stores the raw body of an ignored webhook, so it can be read later', async () => {
    useStub();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await monitorHook({ event: 'change', note: MARKER });
    } finally {
      warn.mockRestore();
    }
    const row = await env.DB.prepare("SELECT body FROM raw_webhooks WHERE source = 'monitor'").first<{
      body: string;
    }>();
    expect(row?.body).toContain(MARKER);
  });
});

describe('evidence endpoints', () => {
  it('returns the stored body and metadata for a snapshot, and 404 for an unknown one', async () => {
    const snapshot_id = await insertSnapshot(env.DB, {
      check_id: null,
      watch_id: null,
      registry: 'fl-mqa',
      url: 'https://example.test/record',
      reader_input: 'fetch_html',
      content_sha256: 'abc',
      body: '<html>record</html>',
      run_id: null,
      step_id: null,
      created_at: new Date().toISOString(),
    });
    const res = await app.request(`/evidence/${snapshot_id}`, {}, roomy as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      snapshot_id,
      registry: 'fl-mqa',
      content_sha256: 'abc',
      body: '<html>record</html>',
    });
    expect((await app.request('/evidence/snap_missing', {}, roomy as never)).status).toBe(404);
  });

  it('proxies the screenshot when the snapshot has run and step ids, and 404 when it does not', async () => {
    const stub = useStub();
    const withIds = await insertSnapshot(env.DB, {
      check_id: null,
      watch_id: null,
      registry: 'ca-cslb',
      url: 'https://example.test',
      reader_input: 'agent_html',
      content_sha256: 'def',
      body: '<html/>',
      run_id: 'run_9',
      step_id: 'step_3',
      created_at: new Date().toISOString(),
    });
    const without = await insertSnapshot(env.DB, {
      check_id: null,
      watch_id: null,
      registry: 'ca-cslb',
      url: 'https://example.test',
      reader_input: 'agent_html',
      content_sha256: 'ghi',
      body: '<html/>',
      run_id: null,
      step_id: null,
      created_at: new Date().toISOString(),
    });
    const ok = await app.request(`/evidence/${withIds}/screenshot`, {}, roomy as never);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Content-Type')).toBe('image/png');
    expect(new TextDecoder().decode(await ok.arrayBuffer())).toBe('PNGDATA');
    expect(stub.calls.some((c) => c.name === 'stepScreenshot' && c.args[0] === 'run_9' && c.args[1] === 'step_3')).toBe(
      true,
    );
    expect((await app.request(`/evidence/${without}/screenshot`, {}, roomy as never)).status).toBe(404);
  });
});

describe('scheduled handler', () => {
  it('the 13:00 cron deletes an 8-day-old check and keeps a watched snapshot', async () => {
    const old = new Date(Date.now() - 8 * DAY_MS);
    const check_id = await insertCheck(env.DB, { state: 'done', result_json: '{}' }, old);
    const oldSnap = await insertSnapshot(env.DB, {
      check_id,
      watch_id: null,
      registry: 'fl-mqa',
      url: 'https://example.test',
      reader_input: 'fetch_html',
      content_sha256: 'old',
      body: 'old',
      run_id: null,
      step_id: null,
      created_at: old.toISOString(),
    });
    const watch_id = await insertWatch(env.DB, {
      kind: 'record',
      registry: 'fl-mqa',
      licence_number: 'ME000103',
      name: null,
      monitor_id: null,
      caller_webhook: null,
    });
    const watchedSnap = await insertSnapshot(env.DB, {
      check_id: null,
      watch_id,
      registry: 'fl-mqa',
      url: 'https://example.test',
      reader_input: 'fetch_html',
      content_sha256: 'kept',
      body: 'kept',
      run_id: null,
      step_id: null,
      created_at: old.toISOString(),
    });
    useStub();

    const ctx = createExecutionContext();
    await worker.scheduled(
      { cron: '0 13 * * *', scheduledTime: Date.now(), type: 'scheduled', noRetry() {} } as never,
      roomy as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(await getCheck(env.DB, check_id)).toBeNull();
    expect(await getSnapshot(env.DB, oldSnap)).toBeNull();
    expect(await getSnapshot(env.DB, watchedSnap)).not.toBeNull();
    expect(await getWatch(env.DB, watch_id)).not.toBeNull();
  });
});

describe('watch ownership', () => {
  const OTHER = { Authorization: 'Bearer second-api-key' };
  const twoKeys = { ...roomy, API_KEYS: 'test-api-key,second-api-key' };

  it('hides a watch from another key and shows it to its owner and to admin', async () => {
    useStub();
    const created = await post(
      '/watch',
      { kind: 'record', registry: 'fl-mqa', licence_number: 'ME000000' },
      JUDGE,
      twoKeys,
    );
    expect(created.status).toBe(201);
    const { watch_id } = (await created.json()) as { watch_id: string };

    expect((await app.request(`/watch/${watch_id}`, { headers: OTHER }, twoKeys as never)).status).toBe(404);
    expect((await app.request(`/watch/${watch_id}/events`, { headers: OTHER }, twoKeys as never)).status).toBe(404);
    expect(
      (await app.request(`/watch/${watch_id}`, { method: 'DELETE', headers: OTHER }, twoKeys as never)).status,
    ).toBe(404);
    expect(
      (await app.request(`/watch/${watch_id}/check-now`, { method: 'POST', headers: OTHER }, twoKeys as never)).status,
    ).toBe(404);

    expect((await app.request(`/watch/${watch_id}`, { headers: JUDGE }, twoKeys as never)).status).toBe(200);
    expect((await app.request(`/watch/${watch_id}`, { headers: ADMIN }, twoKeys as never)).status).toBe(200);
  });
});

describe('check-now guard', () => {
  it('refuses a second monitor check-now within an hour and reports when it resets', async () => {
    const stub = useStub();
    const watch_id = await insertWatch(env.DB, {
      kind: 'record',
      registry: 'fl-mqa',
      licence_number: 'ME000000',
      name: null,
      monitor_id: 'mon_cool',
      caller_webhook: null,
    });
    const first = await app.request(`/watch/${watch_id}/check-now`, { method: 'POST', headers: ADMIN }, roomy as never);
    expect(first.status).toBe(200);
    const second = await app.request(
      `/watch/${watch_id}/check-now`,
      { method: 'POST', headers: ADMIN },
      roomy as never,
    );
    expect(second.status).toBe(429);
    const body = (await second.json()) as { error: { code: string }; resets_at: string };
    expect(body.error.code).toBe('rate_limited');
    expect(Date.parse(body.resets_at)).toBeGreaterThan(Date.now());
    expect(stub.calls.filter((c) => c.name === 'runMonitorNow')).toHaveLength(1);
  });

  it('refuses check-now when the key has no budget left, before any run starts', async () => {
    const stub = useStub();
    const watch_id = await insertWatch(env.DB, {
      kind: 'record',
      registry: 'fl-mqa',
      licence_number: 'ME000002',
      name: null,
      monitor_id: 'mon_budget',
      caller_webhook: null,
    });
    const res = await app.request(`/watch/${watch_id}/check-now`, { method: 'POST', headers: ADMIN }, {
      ...roomy,
      OPS_DAILY_CENTS: '0',
    } as never);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('budget');
    expect(stub.calls.some((c) => c.name === 'runMonitorNow')).toBe(false);
  });
});

describe('GET /watches/public', () => {
  const T0 = Date.parse('2026-11-01T00:00:00Z');
  const at = (minutes: number): Date => new Date(T0 + minutes * 60_000);
  const adminWatch = (over: Record<string, unknown> = {}) =>
    insertWatch(
      env.DB,
      {
        kind: 'record',
        registry: 'fl-mqa',
        licence_number: 'ME000100',
        name: 'Typed Name',
        monitor_id: 'mon_secret',
        caller_webhook: 'https://caller.test/secret-hook',
        owner_hash: 'ops',
        ...over,
      },
      at(0),
    );
  type PublicWatch = {
    watch_id: string;
    registry: string;
    licence_number: string | null;
    tier: string;
    created_at: string;
    last_event_at: string | null;
    events: { event_id: string; kind: string; created_at: string }[];
  };
  const read = async (): Promise<{ status: number; text: string; watches: PublicWatch[] }> => {
    const res = await app.request('/watches/public', {}, roomy as never);
    const text = await res.text();
    return { status: res.status, text, watches: (JSON.parse(text) as { watches: PublicWatch[] }).watches };
  };

  it('needs no key and is empty when the admin has no watch', async () => {
    const r = await read();
    expect(r.status).toBe(200);
    expect(r.watches).toEqual([]);
  });

  it('lists only live watches made with the admin key, never a key holder', async () => {
    const mine = await adminWatch();
    const other = await adminWatch({ licence_number: '0000009', registry: 'ca-cslb' });
    await adminWatch({ licence_number: 'ME000101', owner_hash: 'a-judge-key-hash' });
    await adminWatch({ licence_number: 'ME000102', owner_hash: null });
    const gone = await adminWatch({ licence_number: 'ME000103' });
    await env.DB.prepare('UPDATE watches SET deleted_at = ? WHERE watch_id = ?').bind(at(5).toISOString(), gone).run();

    const r = await read();
    expect(r.status).toBe(200);
    expect(r.watches.map((w) => w.watch_id)).toEqual([mine, other]);
  });

  it('gives the id, registry, licence number, effective tier, created time and last event time', async () => {
    const mqa = await adminWatch();
    const cslb = await adminWatch({ registry: 'ca-cslb', licence_number: '0000009' });
    const demoted = await adminWatch({ licence_number: 'ME000104' });
    await setWatchTier(env.DB, demoted, 'recheck');
    await insertEvent(
      env.DB,
      { watch_id: mqa, kind: 'unchanged', before: null, after: null, evidence: { note: 'Nothing changed' } },
      at(10),
    );
    await insertEvent(
      env.DB,
      {
        watch_id: mqa,
        kind: 'status_change',
        before: { status_raw: 'Clear' },
        after: { status_raw: 'Probation' },
        evidence: {},
      },
      at(20),
    );

    const { watches } = await read();
    const byId = new Map(watches.map((w) => [w.watch_id, w]));
    expect(byId.get(mqa)).toMatchObject({
      registry: 'fl-mqa',
      licence_number: 'ME000100',
      tier: 'monitor',
      created_at: at(0).toISOString(),
      last_event_at: at(20).toISOString(),
    });
    expect(byId.get(cslb)).toMatchObject({
      registry: 'ca-cslb',
      licence_number: '0000009',
      tier: 'recheck',
      last_event_at: null,
      events: [],
    });
    expect(byId.get(demoted)?.tier).toBe('recheck');
  });

  it('shows the last 20 events of each watch, newest first, and not another watch events', async () => {
    const busy = await adminWatch();
    const quiet = await adminWatch({ licence_number: 'ME000105' });
    for (let i = 1; i <= 25; i++) {
      await insertEvent(
        env.DB,
        { watch_id: busy, kind: 'unchanged', before: null, after: null, evidence: { note: `run ${i}` } },
        at(i),
      );
    }
    await insertEvent(
      env.DB,
      { watch_id: quiet, kind: 'unchanged', before: null, after: null, evidence: { note: 'only one' } },
      at(3),
    );

    const { watches } = await read();
    const b = watches.find((w) => w.watch_id === busy);
    const q = watches.find((w) => w.watch_id === quiet);
    expect(b?.events).toHaveLength(20);
    expect(b?.events.map((e) => e.created_at)).toEqual(Array.from({ length: 20 }, (_, i) => at(25 - i).toISOString()));
    expect(b?.last_event_at).toBe(at(25).toISOString());
    expect(q?.events).toHaveLength(1);
  });

  it('carries no caller webhook, owner hash, monitor id or typed name', async () => {
    const id = await adminWatch();
    await insertEvent(env.DB, { watch_id: id, kind: 'unchanged', before: null, after: null, evidence: {} }, at(1));
    const { text, watches } = await read();
    expect(watches).toHaveLength(1);
    for (const secret of ['secret-hook', 'caller_webhook', 'owner_hash', 'mon_secret', 'monitor_id', 'Typed Name']) {
      expect(text).not.toContain(secret);
    }
    expect(Object.keys(watches[0]).sort()).toEqual([
      'created_at',
      'events',
      'last_event_at',
      'licence_number',
      'registry',
      'tier',
      'watch_id',
    ]);
  });

  it('shows a watch made through POST /watch with the admin key', async () => {
    useStub();
    const created = await post('/watch', { kind: 'record', registry: 'fl-mqa', licence_number: 'ME000001' }, ADMIN);
    const { watch_id } = (await created.json()) as { watch_id: string };
    const judge = await post('/watch', { kind: 'record', registry: 'fl-mqa', licence_number: 'ME000002' }, JUDGE);
    expect(judge.status).toBe(201);
    const { watches } = await read();
    expect(watches.map((w) => w.watch_id)).toEqual([watch_id]);
  });
});

describe('GET /watch/:id last_run_at', () => {
  it('is null before any event, then the time of the latest event', async () => {
    useStub();
    const created = await post('/watch', { kind: 'record', registry: 'fl-mqa', licence_number: 'ME000000' }, JUDGE);
    const { watch_id } = (await created.json()) as { watch_id: string };
    const read = async () =>
      (await (await app.request(`/watch/${watch_id}`, { headers: JUDGE }, roomy as never)).json()) as {
        last_run_at: string | null;
      };
    expect((await read()).last_run_at).toBeNull();

    await insertEvent(
      env.DB,
      { watch_id, kind: 'unchanged', before: null, after: null, evidence: {} },
      new Date('2026-11-02T03:00:00Z'),
    );
    await insertEvent(
      env.DB,
      { watch_id, kind: 'unchanged', before: null, after: null, evidence: {} },
      new Date('2026-11-03T03:00:00Z'),
    );
    expect((await read()).last_run_at).toBe('2026-11-03T03:00:00.000Z');
  });
});

describe('check-now when the wallet cannot be read', () => {
  it('answers 503 wallet_unreadable with a minute to wait, not a spent budget, and starts no run', async () => {
    const stub = useStub({
      wallet: async () => {
        throw new TinyFishError('network', 0, 'no wallet');
      },
    });
    resetWalletCache();
    try {
      const watch_id = await insertWatch(env.DB, {
        kind: 'record',
        registry: 'fl-mqa',
        licence_number: 'ME000003',
        name: null,
        monitor_id: 'mon_wallet',
        caller_webhook: null,
      });
      const res = await app.request(`/watch/${watch_id}/check-now`, { method: 'POST', headers: ADMIN }, roomy as never);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string; message: string }; resets_at: string };
      expect(body.error.code).toBe('wallet_unreadable');
      expect(body.error.message).toBe(
        'The service could not confirm it can pay for this check. Try again in a minute.',
      );
      expect(Date.parse(body.resets_at) - Date.now()).toBeLessThanOrEqual(61_000);
      expect(stub.calls.some((c) => c.name === 'runMonitorNow')).toBe(false);
    } finally {
      resetWalletCache();
    }
  });
});

describe('check-now refusals name their cause', () => {
  async function refused(over: Record<string, unknown>, stubOver: Record<string, unknown> = {}) {
    const stub = useStub(stubOver);
    resetWalletCache();
    try {
      const watch_id = await insertWatch(env.DB, {
        kind: 'record',
        registry: 'fl-mqa',
        licence_number: 'ME000010',
        name: null,
        monitor_id: 'mon_cause',
        caller_webhook: null,
      });
      const res = await app.request(`/watch/${watch_id}/check-now`, { method: 'POST', headers: ADMIN }, {
        ...roomy,
        ...over,
      } as never);
      return { res, body: (await res.json()) as { error: { code: string; message: string }; resets_at: string }, stub };
    } finally {
      resetWalletCache();
    }
  }

  it('daily budget spent: 429 with the daily message and resets_at', async () => {
    const { res, body } = await refused({ OPS_DAILY_CENTS: '0' });
    expect(res.status).toBe(429);
    expect(body.error.message).toBe('The daily budget for this key is spent. It resets at midnight UTC.');
    expect(Date.parse(body.resets_at)).toBeGreaterThan(Date.now());
  });

  it('lifetime ceiling reached: 429 with the ceiling message and resets_at', async () => {
    const { res, body, stub } = await refused({ CEILING_CENTS: '0' });
    expect(res.status).toBe(429);
    expect(body.error.message).toBe('The lifetime spending ceiling is reached.');
    expect(body.resets_at).toEqual(expect.any(String));
    expect(stub.calls.some((c) => c.name === 'runMonitorNow')).toBe(false);
  });

  it('wallet below its floor: 429 with the wallet message and resets_at', async () => {
    const { res, body } = await refused({}, { wallet: async () => ({ balance_cents: 100 }) });
    expect(res.status).toBe(429);
    expect(body.error.message).toBe('The provider wallet is below its floor.');
    expect(body.resets_at).toEqual(expect.any(String));
  });

  it('wallet unreadable: 503 with the wallet message', async () => {
    const { res, body } = await refused(
      {},
      {
        wallet: async () => {
          throw new TinyFishError('network', 0, 'no wallet');
        },
      },
    );
    expect(res.status).toBe(503);
    expect(body.error.message).toBe('The service could not confirm it can pay for this check. Try again in a minute.');
  });
});

describe('public lookup accounting', () => {
  it('gives back the slot for invalid and cached results, and refuses the 21st counted lookup', async () => {
    useStub();
    const ip = { 'CF-Connecting-IP': '198.51.100.20' };

    for (let i = 0; i < 5; i++) {
      const res = await post('/verify', { record_type: 'bogus', jurisdiction: 'XX', name: 'Nobody' }, ip);
      expect(((await res.json()) as { outcome: string }).outcome).toBe('invalid_input');
    }

    const person = { record_type: 'dentist', jurisdiction: 'US-CA', name: 'Cache Person' };
    const first = (await (await post('/verify', person, ip)).json()) as { state: string; outcome: string };
    expect(first.state).toBe('done');
    // Only cacheable outcomes are kept. source_unavailable and invalid_input are never cached.
    expect(['unsupported', 'no_match']).toContain(first.outcome);
    const again = (await (await post('/verify', person, ip)).json()) as { served_from_cache: boolean };
    expect(again.served_from_cache).toBe(true);

    for (let i = 0; i < 19; i++) {
      const res = await post(
        '/verify',
        { record_type: 'contractor', jurisdiction: 'US-CA', name: `Counted Builder ${i}` },
        ip,
      );
      expect(res.status).not.toBe(429);
    }
    const refused = await post(
      '/verify',
      { record_type: 'contractor', jurisdiction: 'US-CA', name: 'Counted Builder 19' },
      ip,
    );
    expect(refused.status).toBe(429);
  });
});

describe('watch owner default', () => {
  it('hides a NULL-owner watch from a key holder and shows it to admin', async () => {
    useStub();
    const watch_id = await insertWatch(env.DB, {
      kind: 'record',
      registry: 'fl-mqa',
      licence_number: 'ME000000',
      name: null,
      monitor_id: null,
      caller_webhook: null,
    });
    expect((await app.request(`/watch/${watch_id}`, { headers: JUDGE }, roomy as never)).status).toBe(404);
    expect((await app.request(`/watch/${watch_id}/events`, { headers: JUDGE }, roomy as never)).status).toBe(404);
    const seen = await app.request(`/watch/${watch_id}`, { headers: ADMIN }, roomy as never);
    expect(seen.status).toBe(200);
    expect(((await seen.json()) as { tier: unknown }).tier).toBeNull();
  });

  it('stores watches created with the admin key with owner ops', async () => {
    useStub();
    const created = await post('/watch', { kind: 'record', registry: 'fl-mqa', licence_number: 'ME000000' }, ADMIN);
    const { watch_id } = (await created.json()) as { watch_id: string };
    const row = await env.DB.prepare('SELECT owner_hash FROM watches WHERE watch_id = ?')
      .bind(watch_id)
      .first<{ owner_hash: string }>();
    expect(row?.owner_hash).toBe('ops');
    expect((await app.request(`/watch/${watch_id}`, { headers: JUDGE }, roomy as never)).status).toBe(404);
  });
});

describe('run webhook only wakes the service; GET run is the record', () => {
  // A job holding run_w1 that reserved 80 cents.
  async function holdRun(): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO queue (job_id, kind, priority, payload_json, state, run_id, bucket, reserved_cents, created_at, started_at) VALUES ('job_w1', 'discipline', 1, '{"registry":"fl-mqa","request":{}}', 'running', 'run_w1', 'public', 80, ?, ?)`,
    )
      .bind(new Date().toISOString(), new Date().toISOString())
      .run();
  }
  const hook = (body: unknown) => post('/hooks/tinyfish/run/test-hook-secret', body);
  const ledgerCents = async () =>
    (await env.DB.prepare("SELECT cents FROM ledger WHERE run_id = 'run_w1'").first<{ cents: number }>())?.cents ??
    null;
  const jobState = async () =>
    (await env.DB.prepare("SELECT state FROM queue WHERE job_id = 'job_w1'").first<{ state: string }>())?.state;
  const runOf = (over: Record<string, unknown>) => async (id: string) => ({
    run_id: id,
    status: 'COMPLETED',
    result: {},
    steps: [{ step_id: 's1' }],
    steps_used: 7,
    error: null,
    ...over,
  });

  it('takes only the run id from the body, from data or the top level', () => {
    expect(runIdFromWebhook({ data: { run_id: 'run_a', status: 'COMPLETED', steps: [] } })).toBe('run_a');
    expect(runIdFromWebhook({ run_id: 'run_b' })).toBe('run_b');
    expect(runIdFromWebhook({ data: { note: 'x' } })).toBeNull();
    expect(runIdFromWebhook('run_c')).toBeNull();
  });

  it('completes the run from the API when the webhook has no steps', async () => {
    await holdRun();
    const stub = useStub({
      getRun: async (id: string) => {
        stub.calls.push({ name: 'getRun', args: [id] });
        return { run_id: id, status: 'COMPLETED', result: {}, steps: [{ step_id: 's1' }], steps_used: 10, error: null };
      },
    });
    const res = await hook({ data: { run_id: 'run_w1', status: 'COMPLETED', result: {} } });
    expect(res.status).toBe(200);
    expect(stub.calls.some((c) => c.name === 'getRun' && c.args[0] === 'run_w1')).toBe(true);
    expect(await ledgerCents()).toBe(16); // 10 steps at 1.6 cents
    expect(await jobState()).toBe('done');
  });

  it('settles the steps GET run shows when the webhook carries an empty step list and no num_of_steps', async () => {
    await holdRun();
    useStub({ getRun: runOf({ steps_used: 7 }) });
    const res = await hook({ data: { run_id: 'run_w1', status: 'COMPLETED', result: {}, steps: [] } });
    expect(res.status).toBe(200);
    expect(await ledgerCents()).toBe(12); // 7 steps at 1.6 cents, rounded up
  });

  it('overrides a webhook status and result with what GET run says', async () => {
    await holdRun();
    const seen: unknown[] = [];
    const original = continuations.get('discipline');
    continuations.set('discipline', async (_env, _db, _client, _job, run) => {
      seen.push(run);
    });
    try {
      useStub({
        getRun: runOf({
          status: 'FAILED',
          result: { from: 'get' },
          steps_used: 3,
          error: { code: 'SITE_BLOCKED', message: 'x' },
        }),
      });
      const res = await hook({
        data: {
          run_id: 'run_w1',
          status: 'COMPLETED',
          result: { from: 'webhook' },
          num_of_steps: 99,
          steps: [{ id: 'z' }],
        },
      });
      expect(res.status).toBe(200);
    } finally {
      if (original) continuations.set('discipline', original);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ status: 'FAILED', result: { from: 'get' }, steps_used: 3 });
    expect(await ledgerCents()).toBe(5); // 3 steps, not the webhook's 99
    expect(await jobState()).toBe('failed');
  });

  it('settles nothing and answers 200 when GET run fails, leaving the run to the sweep', async () => {
    await holdRun();
    useStub({
      getRun: async () => {
        throw new TinyFishError('network', 0, 'Could not reach TinyFish');
      },
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await hook({ data: { run_id: 'run_w1', status: 'COMPLETED', result: {}, num_of_steps: 4 } });
      expect(res.status).toBe(200);
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
    expect(await ledgerCents()).toBeNull();
    expect(await jobState()).toBe('running');
    const raw = await env.DB.prepare("SELECT COUNT(*) AS n FROM raw_webhooks WHERE source = 'run'").first<{
      n: number;
    }>();
    expect(raw?.n).toBe(1);
  });

  // The extra read waits 2 seconds. Every other timer runs as it would; a 2000 ms timer fires at once and is counted.
  function skipTheWait(): { waits: () => number; restore: () => void } {
    const real = globalThis.setTimeout;
    let waits = 0;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      if (ms === 2000) {
        waits += 1;
        fn();
        return 0 as never;
      }
      return (real as unknown as (...a: unknown[]) => never)(fn, ms, ...rest);
    }) as never);
    return { waits: () => waits, restore: () => spy.mockRestore() };
  }

  it('reads the run once more after 2 seconds when the first read is not finished, and goes on when the second read is finished', async () => {
    await holdRun();
    const reads: string[] = [];
    let n = 0;
    useStub({
      getRun: async (id: string) => {
        n += 1;
        reads.push(id);
        return n === 1
          ? { run_id: id, status: 'RUNNING', result: null, steps: [], steps_used: 2, error: null }
          : { run_id: id, status: 'COMPLETED', result: {}, steps: [{ step_id: 's1' }], steps_used: 7, error: null };
      },
    });
    const timer = skipTheWait();
    try {
      const res = await hook({ data: { run_id: 'run_w1' } });
      expect(res.status).toBe(200);
      expect(timer.waits()).toBe(1);
    } finally {
      timer.restore();
    }
    expect(reads).toEqual(['run_w1', 'run_w1']);
    expect(await ledgerCents()).toBe(12);
    expect(await jobState()).toBe('done');
  });

  it('leaves the run to the sweep when the second read is not finished either, after exactly 2 reads', async () => {
    await holdRun();
    let reads = 0;
    useStub({
      getRun: async (id: string) => {
        reads += 1;
        return { run_id: id, status: 'RUNNING', result: null, steps: [], steps_used: 2, error: null };
      },
    });
    const timer = skipTheWait();
    try {
      const res = await hook({ data: { run_id: 'run_w1', status: 'COMPLETED', result: {}, num_of_steps: 4 } });
      expect(res.status).toBe(200);
      expect(timer.waits()).toBe(1);
    } finally {
      timer.restore();
    }
    expect(reads).toBe(2);
    expect(await ledgerCents()).toBeNull();
    expect(await jobState()).toBe('running');
  });

  it('makes one read and no wait when the first read is already finished', async () => {
    await holdRun();
    let reads = 0;
    useStub({
      getRun: async (id: string) => {
        reads += 1;
        return { run_id: id, status: 'COMPLETED', result: {}, steps: [{ step_id: 's1' }], steps_used: 7, error: null };
      },
    });
    const timer = skipTheWait();
    try {
      await hook({ data: { run_id: 'run_w1' } });
      expect(timer.waits()).toBe(0);
    } finally {
      timer.restore();
    }
    expect(reads).toBe(1);
  });

  it('leaves the run to the sweep when the second read fails', async () => {
    await holdRun();
    let reads = 0;
    useStub({
      getRun: async (id: string) => {
        reads += 1;
        if (reads === 2) throw new TinyFishError('network', 0, 'Could not reach TinyFish');
        return { run_id: id, status: 'RUNNING', result: null, steps: [], steps_used: 2, error: null };
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const timer = skipTheWait();
    try {
      const res = await hook({ data: { run_id: 'run_w1' } });
      expect(res.status).toBe(200);
    } finally {
      timer.restore();
      warn.mockRestore();
    }
    expect(reads).toBe(2);
    expect(await jobState()).toBe('running');
  });
});

describe('mounted surfaces', () => {
  it('serves the page at the root', async () => {
    const res = await app.request('/', {}, roomy as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type') ?? '').toContain('text/html');
    expect(await res.text()).toContain('TinyVerify');
  });

  it('answers an MCP request at /mcp without a key', async () => {
    const res = await app.request(
      '/mcp',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      },
      env as never,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { tools: unknown[] } }).result.tools).toHaveLength(6);
  });
});

describe('GET /verify/:id in progress', () => {
  async function checkInState(state: string): Promise<string> {
    const check_id = await insertCheck(env.DB, { state: state as never, query_json: '{}' });
    const result = {
      check_id,
      state,
      query: { record_type: 'contractor', jurisdiction: 'US-CA' },
      outcome: null,
      checked_at: null,
      served_from_cache: false,
      records: [],
      candidates: [],
      disambiguators: [],
      searched: { registries: ['ca-cslb'], spellings_tried: [], alternate_spellings_used: false },
    };
    await env.DB.prepare('UPDATE checks SET result_json = ? WHERE check_id = ?')
      .bind(JSON.stringify(result), check_id)
      .run();
    return check_id;
  }
  async function addJob(
    job_id: string,
    check_id: string,
    state: string,
    priority: number,
    payload: object,
  ): Promise<void> {
    await env.DB.prepare(
      'INSERT INTO queue (job_id, kind, priority, payload_json, state, bucket, reserved_cents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        job_id,
        'search',
        priority,
        JSON.stringify({ check_id, registry: 'ca-cslb', ...payload }),
        state,
        'public',
        0,
        new Date().toISOString(),
      )
      .run();
  }

  it('returns the streaming URL of the running job for the check', async () => {
    const check_id = await checkInState('searching');
    await addJob('job_stream', check_id, 'running', 1, { streaming_url: 'https://stream.example/run_1' });
    const res = await app.request(`/verify/${check_id}`, {}, roomy as never);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { state: string; streaming_url?: string; queue_position?: number };
    expect(body.state).toBe('searching');
    expect(body.streaming_url).toBe('https://stream.example/run_1');
    expect(body.queue_position).toBeUndefined();
  });

  it('gives the queue position of a pending job behind the jobs ahead of it', async () => {
    const first = await checkInState('queued');
    const second = await checkInState('queued');
    await addJob('job_ahead', first, 'pending', 1, {});
    await addJob('job_behind', second, 'pending', 1, {});
    const res = await app.request(`/verify/${second}`, {}, roomy as never);
    expect(res.status).toBe(202);
    expect(((await res.json()) as { queue_position: number }).queue_position).toBe(2);
  });
});

describe('dispatch on enqueue and on run webhooks', () => {
  const startsRun =
    (calls: { name: string; args: unknown[] }[]) =>
    async (...args: unknown[]) => {
      calls.push({ name: 'runAsync', args });
      return { run_id: 'run_started_1' };
    };
  const jobStates = async (): Promise<string[]> =>
    (await env.DB.prepare('SELECT state FROM queue ORDER BY rowid').all<{ state: string }>()).results.map(
      (r) => r.state,
    );

  it('dispatches once after POST /verify queues a search job, and the job starts at once', async () => {
    setNow(OPEN_HOURS);
    const calls: { name: string; args: unknown[] }[] = [];
    useStub({ runAsync: startsRun(calls) });
    vi.mocked(dispatch).mockClear();
    const res = await post('/verify', { record_type: 'contractor', jurisdiction: 'US-CA', name: 'Dispatch Builder' });
    expect(res.status).toBe(202);
    expect(vi.mocked(dispatch)).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.name === 'runAsync')).toHaveLength(1);
    expect(await jobStates()).toEqual(['running']);
  });

  it('does not dispatch when the answer is already done', async () => {
    useStub();
    vi.mocked(dispatch).mockClear();
    expect(
      (await post('/verify', { record_type: 'contractor', jurisdiction: 'Miami', name: 'Raj Patel' })).status,
    ).toBe(400);
    expect((await post('/verify', { jurisdiction: 'US-FL' })).status).toBe(400);
    expect(
      (await post('/verify', { record_type: 'physician', jurisdiction: 'Australia', name: 'Jane Citizen' })).status,
    ).toBe(200);
    expect(vi.mocked(dispatch)).not.toHaveBeenCalled();
  });

  it('still answers when the dispatcher fails, and logs it', async () => {
    setNow(OPEN_HOURS);
    useStub();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(dispatch).mockClear();
    vi.mocked(dispatch).mockRejectedValueOnce(new Error('dispatch broke'));
    const res = await post('/verify', {
      record_type: 'contractor',
      jurisdiction: 'US-CA',
      name: 'Broken Dispatch Builder',
    });
    expect(res.status).toBe(202);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('dispatches once after a refinement queues the record job', async () => {
    setNow(OPEN_HOURS);
    const calls: { name: string; args: unknown[] }[] = [];
    useStub({ runAsync: startsRun(calls) });
    const check_id = await insertCheck(env.DB, { state: 'done', query_json: '{}' });
    const stored = {
      check_id,
      state: 'done',
      query: { record_type: 'contractor', jurisdiction: 'US-CA', name: 'Refine Builder' },
      outcome: 'multiple_matches',
      checked_at: new Date().toISOString(),
      served_from_cache: false,
      records: [],
      candidates: [
        {
          name: 'REFINE BUILDER INC',
          licence_number: '0000001',
          city: 'Fresno',
          licence_type: 'B',
          status_raw: 'Active',
          from: 'search',
          link: null,
          score: 0.9,
          reasons: [],
          candidate_id: 'cand_1',
        },
        {
          name: 'REFINE BUILDER LLC',
          licence_number: '0000002',
          city: 'Clovis',
          licence_type: 'B',
          status_raw: 'Active',
          from: 'search',
          link: null,
          score: 0.9,
          reasons: [],
          candidate_id: 'cand_2',
        },
      ],
      disambiguators: ['city'],
      searched: { registries: ['ca-cslb'], spellings_tried: [], alternate_spellings_used: false },
    };
    await env.DB.prepare('UPDATE checks SET result_json = ? WHERE check_id = ?')
      .bind(JSON.stringify(stored), check_id)
      .run();
    vi.mocked(dispatch).mockClear();
    const res = await post('/verify', { check_id, candidate_id: 'cand_1' });
    expect(res.status).toBe(202);
    expect(vi.mocked(dispatch)).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.name === 'runAsync')).toHaveLength(1);
  });

  it('dispatches after the run hook processes a run, and the freed slot starts the next job', async () => {
    const calls: { name: string; args: unknown[] }[] = [];
    useStub({ runAsync: startsRun(calls) });
    const now = new Date().toISOString();
    const insert = env.DB.prepare(
      `INSERT INTO queue (job_id, kind, priority, payload_json, state, run_id, bucket, reserved_cents, created_at, started_at) VALUES (?, 'discipline', 1, '{"registry":"fl-mqa","request":{"url":"https://example.test","goal":"g"}}', ?, ?, 'public', 80, ?, ?)`,
    );
    await env.DB.batch([
      insert.bind('job_a', 'running', 'run_a', now, now),
      insert.bind('job_b', 'running', 'run_b', now, now),
      insert.bind('job_c', 'pending', null, now, null),
    ]);
    vi.mocked(dispatch).mockClear();
    const res = await post('/hooks/tinyfish/run/test-hook-secret', {
      data: { run_id: 'run_a', status: 'COMPLETED', result: {}, steps: [] },
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(dispatch)).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.name === 'runAsync')).toHaveLength(1);
    const states = await env.DB.prepare('SELECT job_id, state FROM queue ORDER BY job_id').all<{
      job_id: string;
      state: string;
    }>();
    expect(states.results).toEqual([
      { job_id: 'job_a', state: 'done' },
      { job_id: 'job_b', state: 'running' },
      { job_id: 'job_c', state: 'running' },
    ]);
  });

  it('does not dispatch for a run webhook it cannot read', async () => {
    useStub();
    vi.mocked(dispatch).mockClear();
    expect((await post('/hooks/tinyfish/run/test-hook-secret', 'not json')).status).toBe(200);
    expect(vi.mocked(dispatch)).not.toHaveBeenCalled();
  });
});

describe('run webhook processing is deferred and recoverable', () => {
  const MINUTE_MS = 60_000;
  const holdJob = async (run_id: string): Promise<void> => {
    const started = new Date(Date.now() - 30 * MINUTE_MS).toISOString();
    await env.DB.prepare(
      `INSERT INTO queue (job_id, kind, priority, payload_json, state, run_id, bucket, reserved_cents, created_at, started_at) VALUES ('job_h', 'discipline', 1, '{"registry":"fl-mqa","request":{}}', 'running', ?, 'public', 80, ?, ?)`,
    )
      .bind(run_id, started, started)
      .run();
  };
  const jobState = async (): Promise<string | undefined> =>
    (await env.DB.prepare("SELECT state FROM queue WHERE job_id = 'job_h'").first<{ state: string }>())?.state;
  const body = (run_id: string) => JSON.stringify({ data: { run_id, status: 'COMPLETED', result: {}, steps: [] } });

  it('answers the hook with only the raw body stored, and processes the run inside waitUntil', async () => {
    useStub();
    await holdJob('run_defer');
    const original = continuations.get('discipline');
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ran = 0;
    continuations.set('discipline', async () => {
      await gate;
      ran += 1;
    });
    try {
      const ctx = createExecutionContext();
      const res = await app.request(
        '/hooks/tinyfish/run/test-hook-secret',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body('run_defer') },
        roomy as never,
        ctx,
      );
      // The answer is out while the continuation is still waiting: the work is deferred, not done in the request.
      expect(res.status).toBe(200);
      expect(ran).toBe(0);
      const raw = await env.DB.prepare("SELECT COUNT(*) AS n FROM raw_webhooks WHERE source = 'run'").first<{
        n: number;
      }>();
      expect(raw?.n).toBe(1);
      release();
      await waitOnExecutionContext(ctx);
      expect(ran).toBe(1);
      expect(await jobState()).toBe('done');
    } finally {
      if (original) continuations.set('discipline', original);
    }
  });

  it('leaves a run whose processing threw for the next sweep, which finishes it', async () => {
    const stub = useStub({
      getRun: async (id: string) => ({
        run_id: id,
        status: 'COMPLETED',
        result: {},
        steps: [{ step_id: 's1' }],
        steps_used: 1,
        error: null,
      }),
    });
    await holdJob('run_throw');
    const original = continuations.get('discipline');
    let calls = 0;
    continuations.set('discipline', async () => {
      calls += 1;
      if (calls === 1) throw new Error('cut off');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await post('/hooks/tinyfish/run/test-hook-secret', body('run_throw'));
      expect(res.status).toBe(200);
      expect(calls).toBe(1);
      expect(await jobState()).toBe('running');

      expect(await sweep(roomy as never, env.DB, stub as unknown as TinyFish)).toBe(1);
      expect(calls).toBe(2);
      expect(await jobState()).toBe('done');
    } finally {
      error.mockRestore();
      if (original) continuations.set('discipline', original);
    }
  });
});

describe("POST /verify with the visitor's own TinyFish key", () => {
  const OWN = { 'X-TinyFish-Key': 'tf_test_visitor_key_000' };
  const NAME = { record_type: 'physician', jurisdiction: 'US-FL', name: 'Raj Patel' };
  const called = (stub: { calls: { name: string }[] }, name: string): number =>
    stub.calls.filter((call) => call.name === name).length;
  const heldKeys = async (): Promise<number> =>
    (await env.DB.prepare('SELECT COUNT(*) AS n FROM own_keys').first<{ n: number }>())?.n ?? 0;
  // The client made for the visitor's key is a second stand-in, so each test can see which account a call went to.
  function useOwn(overrides: Record<string, unknown> = {}) {
    const base = stubClient();
    const runAsync = async (request: unknown) => {
      base.calls.push({ name: 'runAsync', args: [request] });
      return { run_id: 'run_own_1' };
    };
    const own = { ...base, runAsync, wallet: async () => ({ balance_cents: 5 }), ...overrides };
    setOwnClientFactory(() => own as unknown as TinyFish);
    return own;
  }
  afterEach(() => setOwnClientFactory(null));

  it("runs the lookup on the visitor's account when this service has no budget left, and holds the key while it runs", async () => {
    const shared = useStub();
    const own = useOwn();
    const broke = { ...env, PUBLIC_DAILY_CENTS: '0', CEILING_CENTS: '0' };

    const res = await post('/verify', NAME, OWN, broke);

    const body = (await res.json()) as { state: string; outcome: string | null; check_id: string };
    expect(res.status).toBe(202);
    expect(body.outcome).toBeNull();
    expect(called(own, 'runAsync')).toBe(1);
    expect(called(shared, 'runAsync')).toBe(0);
    expect(await heldKeys()).toBe(1);
    expect(JSON.stringify(body)).not.toContain(OWN['X-TinyFish-Key']);
    const row = await getCheck(env.DB, body.check_id);
    expect(JSON.stringify(row)).not.toContain(OWN['X-TinyFish-Key']);
  });

  it('refuses the same lookup without a key when the budget is spent', async () => {
    useStub();
    const res = await post('/verify', NAME, {}, { ...env, PUBLIC_DAILY_CENTS: '0', CEILING_CENTS: '0' });
    const body = (await res.json()) as { outcome: string; unavailable: { reason: string } };
    expect(body.outcome).toBe('source_unavailable');
    expect(body.unavailable.reason).toBe('budget');
  });

  it('answers 400 and starts nothing when TinyFish does not take the key', async () => {
    const shared = useStub();
    const own = useOwn({
      wallet: async () => {
        throw new TinyFishError('unauthorised', 401, 'TinyFish rejected the API key');
      },
    });
    const res = await post('/verify', NAME, OWN);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('tinyfish_key_refused');
    expect(called(own, 'runAsync') + called(shared, 'runAsync')).toBe(0);
    expect(await heldKeys()).toBe(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM checks').first<{ n: number }>())?.n).toBe(0);
  });

  it('answers 503 and starts nothing when this service has no secret to seal the key with', async () => {
    useStub();
    const own = useOwn();
    const res = await post('/verify', NAME, OWN, { ...roomy, OWN_KEY_SECRET: undefined });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('own_key_unavailable');
    expect(called(own, 'runAsync')).toBe(0);
    expect(await heldKeys()).toBe(0);
  });

  it('answers 400 for a header that is not a key', async () => {
    useStub();
    const res = await post('/verify', NAME, { 'X-TinyFish-Key': 'two words' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_input');
  });

  it('does not use up the free lookups of the address', async () => {
    useStub();
    useOwn();
    const ip = { 'CF-Connecting-IP': '198.51.100.44' };
    for (const name of ['Own Key A', 'Own Key B', 'Own Key C'])
      await post('/verify', { ...NAME, name }, { ...ip, ...OWN });
    for (let i = 0; i < 20; i++) {
      const res = await post(
        '/verify',
        { record_type: 'contractor', jurisdiction: 'US-CA', name: `Free Builder ${String.fromCharCode(65 + i)}` },
        ip,
      );
      expect(res.status).not.toBe(429);
    }
  });

  it('has its own hourly limit of 60 for one address', async () => {
    const c = { req: { header: (name: string) => (name === 'CF-Connecting-IP' ? '198.51.100.45' : undefined) } };
    for (let i = 0; i < 60; i++) expect(await countedLookup(c, 'own', async () => ({}))).toEqual({ result: {} });
    expect(await countedLookup(c, 'own', async () => ({}))).toMatchObject({ limit: 60 });
    expect(await countedLookup(c, 'public', async () => ({}))).toEqual({ result: {} });
  });

  it("refuses a ninth lookup on visitors' keys while eight are waiting or under way, and starts nothing for it", async () => {
    useStub();
    useOwn();
    for (let i = 0; i < 8; i++) {
      const res = await post(
        '/verify',
        { ...NAME, name: `Queued Key ${String.fromCharCode(65 + i)}` },
        { ...OWN, 'CF-Connecting-IP': `198.51.100.${60 + i}` },
      );
      expect(res.status).toBe(202);
    }
    const checks = (await env.DB.prepare('SELECT COUNT(*) AS n FROM checks').first<{ n: number }>())?.n;
    const res = await post(
      '/verify',
      { ...NAME, name: 'Queued Key Ninth' },
      { ...OWN, 'CF-Connecting-IP': '198.51.100.99' },
    );
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM checks').first<{ n: number }>())?.n).toBe(checks);
    const free = await post('/verify', { record_type: 'contractor', jurisdiction: 'US-CA', name: 'Free Builder' });
    expect(free.status).not.toBe(429);
  });

  it('stores no key for an answer given at once', async () => {
    useStub();
    useOwn();
    const res = await post('/verify', { record_type: 'physician', jurisdiction: 'Atlantis', name: 'Raj Patel' }, OWN);
    expect(((await res.json()) as { state: string }).state).toBe('done');
    expect(await heldKeys()).toBe(0);
  });

  it('finds the run finished when the page asks about the check, and then deletes the key', async () => {
    useStub();
    const own = useOwn({
      getRun: async (id: string) => ({
        run_id: id,
        status: 'FAILED',
        result: null,
        steps: [],
        steps_used: 2,
        error: { code: 'SITE_DOWN', message: 'x' },
      }),
    });
    const started = (await (await post('/verify', NAME, OWN)).json()) as { check_id: string };
    expect(await heldKeys()).toBe(1);

    const res = await app.request(`/verify/${started.check_id}`, {}, roomy as never);
    await res.json();
    const after = (await (await app.request(`/verify/${started.check_id}`, {}, roomy as never)).json()) as {
      state: string;
      outcome: string;
    };

    expect(after.state).toBe('done');
    expect(after.outcome).toBe('source_unavailable');
    expect(await heldKeys()).toBe(0);
    expect(called(own, 'runAsync')).toBe(1);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM ledger').first<{ n: number }>())?.n).toBe(0);
  });
});

describe('check-now on a watch that is re-checked by an agent run', () => {
  const recheckBucket = async (): Promise<string[]> =>
    (await env.DB.prepare("SELECT bucket FROM queue WHERE kind = 'recheck'").all<{ bucket: string }>()).results.map(
      (row) => row.bucket,
    );

  it("holds the run against the budget of the key that asked, never against the service's own", async () => {
    useStub();
    const made = (await (await post('/watch', { registry: 'ca-cslb', licence_number: '1234567' }, JUDGE)).json()) as {
      watch_id: string;
    };
    await env.DB.prepare("DELETE FROM queue WHERE kind = 'recheck'").run();

    const res = await app.request(
      `/watch/${made.watch_id}/check-now`,
      { method: 'POST', headers: JUDGE },
      roomy as never,
    );

    expect(((await res.json()) as { queued: boolean }).queued).toBe(true);
    expect(await recheckBucket()).toEqual(['judge']);
  });

  it("holds the admin key's own check against the service budget", async () => {
    useStub();
    const made = (await (await post('/watch', { registry: 'ca-cslb', licence_number: '1234568' }, ADMIN)).json()) as {
      watch_id: string;
    };
    await env.DB.prepare("DELETE FROM queue WHERE kind = 'recheck'").run();
    await app.request(`/watch/${made.watch_id}/check-now`, { method: 'POST', headers: ADMIN }, roomy as never);
    expect(await recheckBucket()).toEqual(['ops']);
  });
});
