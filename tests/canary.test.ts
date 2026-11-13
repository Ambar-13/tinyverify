import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import golden from '../src/golden.json';
import samplePage from './fixtures/fl-mqa/live-physician-1.fetch.html?raw';
import { reservation } from '../src/queue/budget';
import { health, onRun, runAll } from '../src/watch/canary';
import { continuations, type Job } from '../src/queue/queue';
import { insertCanary, latestCanaries } from '../src/store';
import type { Fields, Reading, RegistryId } from '../src/types';
import { registerAdapter } from '../src/registries';
import type { Adapter } from '../src/registries/adapter';
import { TinyFishError, type FetchResult, type RunResult, type TinyFish } from '../src/tinyfish/client';

const db = env.DB;

// The sample page carries the same values as the golden MQA record, except the licence number.
// Swapping that number in gives a page that reads exactly as the golden record.
const MQA_OK = samplePage.replaceAll('ME000000', 'ME181008');
// The second golden MQA record is a registered nurse, expiring 30 April 2027.
const MQA_OK_NURSE = samplePage.replaceAll('ME000000', 'RN9584697').replace('1/31/2028', '4/30/2027');
const NURSE_LINK_ID = 'LicInd=732228';
const pageForMqa = (url: string, html: string) => (url.includes(NURSE_LINK_ID) ? MQA_OK_NURSE : html);

const layoutPages = import.meta.glob('./fixtures/canary/*.html', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const MQA_LAYOUT = layoutPages['./fixtures/canary/mqa-layout-changed.fetch.html'];

// 4 November is an even UTC day, 5 November an odd one.
const EVEN_DAY = new Date('2026-11-04T12:00:00.000Z');
const ODD_DAY = new Date('2026-11-05T12:00:00.000Z');
const OLD = new Date('2026-01-01T00:00:00.000Z');
const RECENT = new Date('2026-11-03T12:00:00.000Z');

// A fetch client. Each URL gets the page given for it (a function of the URL), or a fetch error.
function fetchClient(html: string | ((url: string) => string), error?: { code: string }): TinyFish {
  return {
    fetchPages: async (urls: string[]) => {
      if (error) {
        return { results: [], errors: urls.map((url) => ({ url, code: error.code, message: 'stub' })) };
      }
      return {
        results: urls.map((url) => {
          const text = typeof html === 'function' ? html(url) : html;
          return { url, final_url: url, text } as unknown as FetchResult;
        }),
        errors: [],
      };
    },
    stepHtml: async () => (typeof html === 'function' ? html('') : html),
  } as unknown as TinyFish;
}

// The date the health tests judge against: 4 November 2026, 18:00 UTC.
const NOW = new Date('2026-11-04T18:00:00.000Z');

// Values that match the ca-cslb golden record. Each reader can be given different values.
const CSLB_FIELDS: Fields = {
  name: 'SAMPLE ROOFING LLC',
  licence_number: '1155041',
  status_raw: 'This license is current and active.',
  status: 'active',
  expires: '2028-05-31',
  issued: null,
  licence_type: null,
  discipline_flag: false,
  discipline_actions: [],
  data_as_of: null,
  city: null,
  other_names: [],
};

function reading(reader: Reading['reader'], fields: Partial<Fields>, warnings: string[] = []): Reading {
  return { reader, fields: { ...CSLB_FIELDS, ...fields }, quotes: [], warnings };
}

// A stand-in adapter for an agent registry. Only the parts the canary uses are filled in.
function agentAdapter(
  id: RegistryId,
  readers: { html?: Partial<Fields>; text?: Partial<Fields>; agent?: Partial<Fields> } = {},
  maxSteps = 20,
): Adapter {
  return {
    id,
    record: {
      kind: 'agent',
      start_url: 'https://example.test/search',
      goal: (licence: string) => `Find licence ${licence} and read its status.`,
      output_schema: { type: 'object' },
      max_steps: maxSteps,
      source_lookup: () => 'https://example.test/lookup',
    },
    parseHtml: () => reading('parser_html', readers.html ?? {}),
    parseText: () => reading('parser_text', readers.text ?? {}),
    fieldsFromAgent: () => reading('agent_output', readers.agent ?? {}),
  } as unknown as Adapter;
}

const agentRun = (overrides: Partial<RunResult> = {}): RunResult => ({
  run_id: 'run_1',
  status: 'COMPLETED',
  result: { record: {} },
  steps: [{ step_id: 'step_1' }],
  steps_used: 1,
  error: null,
  ...overrides,
});

async function queuedJobs(): Promise<
  { kind: string; priority: number; bucket: string; reserved_cents: number; payload_json: string }[]
> {
  const { results } = await db
    .prepare('SELECT kind, priority, bucket, reserved_cents, payload_json FROM queue')
    .all<{ kind: string; priority: number; bucket: string; reserved_cents: number; payload_json: string }>();
  return results;
}

async function latestFor(registry: RegistryId) {
  return (await latestCanaries(db)).find((c) => c.registry === registry);
}

beforeEach(() => {
  registerAdapter('ca-cslb', agentAdapter('ca-cslb'));
  registerAdapter('au-ahpra', agentAdapter('au-ahpra'));
});

afterEach(() => {
  registerAdapter('ca-cslb', null);
  registerAdapter('au-ahpra', null);
});

describe('golden records', () => {
  it('holds real records with the expected fields and their wording, and one pending Australian record', () => {
    expect(golden._note).toBe('Real public registry records used as daily canaries; business records preferred.');

    for (const record of golden.records.filter((r) => r.pending !== true)) {
      expect(Object.keys(record.expected ?? {}).sort(), record.licence_number).toEqual([
        'expires',
        'licence_number',
        'status',
        'status_raw',
      ]);
    }

    const mqa = golden.records.filter((r) => r.registry === 'fl-mqa').map((r) => r.licence_number);
    expect(mqa).toEqual(['ME181008', 'RN9584697']);

    const dbpr = golden.records.find((r) => r.registry === 'fl-dbpr');
    expect(dbpr?.licence_number).toBe('CCC1335434');

    const cslb = golden.records.find((r) => r.registry === 'ca-cslb');
    expect(cslb?.licence_number).toBe('1155041');
    expect(cslb?.link).toBeNull();

    const ahpra = golden.records.find((r) => r.registry === 'au-ahpra');
    expect(ahpra?.pending).toBe(true);
    expect(ahpra?.expected).toBeUndefined();
  });
});

describe('runAll, fetch registries', () => {
  it('inserts ok:true when the page reads as the golden values', async () => {
    await runAll(
      env,
      db,
      fetchClient((url) => pageForMqa(url, MQA_OK)),
      EVEN_DAY,
    );

    const row = await latestFor('fl-mqa');
    expect(row?.ok).toBe(true);
    expect(row?.detail).toBeNull();
  });

  it('inserts ok:false naming the missing label when the layout changed', async () => {
    await runAll(env, db, fetchClient(MQA_LAYOUT), EVEN_DAY);

    const row = await latestFor('fl-mqa');
    expect(row?.ok).toBe(false);
    expect(row?.detail).toContain('License Status');
  });

  it('inserts ok:false with the fetch error code when the fetch fails', async () => {
    await runAll(env, db, fetchClient('', { code: 'timeout' }), EVEN_DAY);

    const row = await latestFor('fl-mqa');
    expect(row?.ok).toBe(false);
    expect(row?.detail).toContain('timeout');
  });

  it('checks both Florida MQA golden records, and fails the registry when the second one fails', async () => {
    const onlyNurseLayout = (url: string) => (url.includes(NURSE_LINK_ID) ? MQA_LAYOUT : MQA_OK);
    await runAll(env, db, fetchClient(onlyNurseLayout), EVEN_DAY);

    const row = await latestFor('fl-mqa');
    expect(row?.ok).toBe(false);
    expect(row?.detail).toContain('RN9584697');
    expect(row?.detail).toContain('License Status');
  });

  it('inserts ok:false naming the field when the page shows another status', async () => {
    const changed = MQA_OK.replace('Clear/Active', 'Revoked/');
    await runAll(
      env,
      db,
      fetchClient((url) => pageForMqa(url, changed)),
      EVEN_DAY,
    );

    const row = await latestFor('fl-mqa');
    expect(row?.ok).toBe(false);
    expect(row?.detail).toContain('status');
  });
});

describe('runAll, agent registries', () => {
  it('queues one canary job for each agent registry with a golden record on even UTC days (step cap on)', async () => {
    await runAll({ ...env, AGENT_STEP_CAP: 'on' }, db, fetchClient(MQA_OK), EVEN_DAY);

    const jobs = await queuedJobs();
    // au-ahpra is pending in the golden file, so only ca-cslb is queued.
    expect(jobs).toHaveLength(1);
    expect(jobs[0].kind).toBe('canary');
    expect(jobs[0].priority).toBe(2);
    expect(jobs[0].bucket).toBe('ops');
    expect(jobs[0].reserved_cents).toBe(reservation(20));

    const payload = JSON.parse(jobs[0].payload_json);
    expect(payload.registry).toBe('ca-cslb');
    expect(payload.request.goal).toContain('1155041');
    expect(payload.request.goal).not.toContain('Use at most');
    expect(payload.request.agent_config).toEqual({ max_steps: 20 });
    expect(payload.request.capture_config).toEqual({ html: true });
  });

  it('with the step cap off, holds twice the steps, sends a duration and puts the limit in the goal', async () => {
    await runAll({ ...env, AGENT_STEP_CAP: 'off' }, db, fetchClient(MQA_OK), EVEN_DAY);

    const jobs = await queuedJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].reserved_cents).toBe(reservation(40));
    const payload = JSON.parse(jobs[0].payload_json);
    expect(payload.request.agent_config).toEqual({ max_duration_seconds: 120 });
    expect(payload.request.goal).toContain('Use at most 20 actions.');
  });

  it('queues nothing for agent registries on odd UTC days', async () => {
    await runAll(env, db, fetchClient(MQA_OK), ODD_DAY);

    expect(await queuedJobs()).toHaveLength(0);
  });
});

describe('canary continuation', () => {
  it('is registered for the canary job kind', () => {
    expect(continuations.has('canary')).toBe(true);
  });

  it('inserts ok:true when the captured page and the agent output agree with the golden values', async () => {
    await onRun(env, db, fetchClient('<html></html>'), 'ca-cslb', agentRun());

    const row = await latestFor('ca-cslb');
    expect(row?.ok).toBe(true);
  });

  it('inserts ok:false with the run status when the agent run did not complete', async () => {
    await onRun(
      env,
      db,
      fetchClient('<html></html>'),
      'ca-cslb',
      agentRun({ status: 'FAILED', error: { code: 'AGENT_FAILURE', message: 'stub' } }),
    );

    const row = await latestFor('ca-cslb');
    expect(row?.ok).toBe(false);
    expect(row?.detail).toContain('FAILED');
  });

  it('inserts ok:false when a reader disagrees with the golden status', async () => {
    registerAdapter('ca-cslb', agentAdapter('ca-cslb', { html: { status: 'suspended', status_raw: 'Suspended' } }));

    await onRun(env, db, fetchClient('<html></html>'), 'ca-cslb', agentRun());

    const row = await latestFor('ca-cslb');
    expect(row?.ok).toBe(false);
    expect(row?.detail).toContain('status');
  });

  it('does not degrade when the status is other and the registry wording matches', async () => {
    const other = { status: 'other' as const };
    registerAdapter('ca-cslb', agentAdapter('ca-cslb', { html: other, text: other, agent: other }));

    await onRun(env, db, fetchClient('<html></html>'), 'ca-cslb', agentRun());

    const row = await latestFor('ca-cslb');
    expect(row?.ok).toBe(true);
    expect(row?.detail).toBeNull();
  });

  it('degrades when the status is other and the registry wording has changed', async () => {
    const changed = { status: 'other' as const, status_raw: 'Inactive' };
    registerAdapter('ca-cslb', agentAdapter('ca-cslb', { html: changed, text: changed, agent: changed }));

    await onRun(env, db, fetchClient('<html></html>'), 'ca-cslb', agentRun());

    const row = await latestFor('ca-cslb');
    expect(row?.ok).toBe(false);
    expect(row?.detail).toContain('status_raw');
  });

  it('degrades when readers disagree between two statuses other does not explain', async () => {
    registerAdapter('ca-cslb', agentAdapter('ca-cslb', { html: { status: 'suspended' } }));

    await onRun(env, db, fetchClient('<html></html>'), 'ca-cslb', agentRun());

    const row = await latestFor('ca-cslb');
    expect(row?.ok).toBe(false);
    expect(row?.detail).toContain('status');
  });

  it('inserts ok:false when the agent captured no step', async () => {
    await onRun(env, db, fetchClient('<html></html>'), 'ca-cslb', agentRun({ steps: [], steps_used: 0 }));

    const row = await latestFor('ca-cslb');
    expect(row?.ok).toBe(false);
    expect(row?.detail).toContain('step');
  });

  it('walks back past a step whose page answers 404 and judges the page it finds', async () => {
    const asked: string[] = [];
    const client = {
      stepHtml: async (_run: string, step: string) => {
        asked.push(step);
        if (step === 's3') throw new TinyFishError('not_found', 404, 'gone');
        return '<html></html>';
      },
    } as unknown as TinyFish;
    const steps = [{ step_id: 's1' }, { step_id: 's2' }, { step_id: 's3' }, { step_id: 'done', has_html: false }];
    await onRun(env, db, client, 'ca-cslb', agentRun({ steps }));
    expect(asked).toEqual(['s3', 's2']);
    expect((await latestFor('ca-cslb'))?.detail ?? '').not.toContain('step');
  });

  it('inserts ok:false, without throwing, when no step has a readable page', async () => {
    const client = {
      stepHtml: async () => {
        throw new TinyFishError('not_found', 404, 'gone');
      },
    } as unknown as TinyFish;
    await onRun(env, db, client, 'ca-cslb', agentRun({ steps: [{ step_id: 'a' }, { step_id: 'b' }] }));
    const row = await latestFor('ca-cslb');
    expect(row?.ok).toBe(false);
    expect(row?.detail).toContain('step html');
  });

  it('records a timed-out canary as ok:false and a budget refusal as no row', async () => {
    const job: Job = {
      job_id: 'job_test',
      kind: 'canary',
      priority: 2,
      bucket: 'ops',
      reserved_cents: 32,
      payload: { registry: 'ca-cslb', request: { url: 'https://example.test', goal: 'x' } },
    };
    const continuation = continuations.get('canary');
    expect(continuation).toBeDefined();

    await continuation!(env, db, fetchClient(''), job, { reason: 'budget' });
    expect(await latestFor('ca-cslb')).toBeUndefined();

    await continuation!(env, db, fetchClient(''), job, { reason: 'timeout' });
    const row = await latestFor('ca-cslb');
    expect(row?.ok).toBe(false);
    expect(row?.detail).toContain('timeout');
  });
});

describe('a canary whose start was refused', () => {
  it('is recorded as a failed canary with the reason start_refused, and health shows that registry as degraded', async () => {
    const job: Job = {
      job_id: 'job_refused',
      kind: 'canary',
      priority: 2,
      bucket: 'ops',
      reserved_cents: 32,
      payload: { registry: 'ca-cslb', request: { url: 'https://example.test', goal: 'x' } },
    };
    const continuation = continuations.get('canary');
    expect(continuation).toBeDefined();

    await continuation!(env, db, fetchClient(''), job, { reason: 'start_refused' });

    const row = await latestFor('ca-cslb');
    expect(row?.ok).toBe(false);
    expect(row?.detail).toBe('start_refused');
    expect((await health(db, new Date()))['ca-cslb']).toBe('degraded');
  });
});

describe('health', () => {
  it('reports unknown for every registry with no canary', async () => {
    expect(await health(db, NOW)).toEqual({
      'fl-mqa': 'unknown',
      'fl-dbpr': 'unknown',
      'ca-cslb': 'unknown',
      'au-ahpra': 'unknown',
    });
  });

  it('reports unknown when the newest canary is more than 48 hours old', async () => {
    await insertCanary(db, 'fl-mqa', true, null, new Date(NOW.getTime() - 49 * 3_600_000));
    await insertCanary(db, 'fl-dbpr', true, null, new Date(NOW.getTime() - 47 * 3_600_000));

    const result = await health(db, NOW);
    expect(result['fl-mqa']).toBe('unknown');
    expect(result['fl-dbpr']).toBe('ok');
  });

  it('reports degraded only for the registry whose latest canary failed', async () => {
    await insertCanary(db, 'fl-mqa', false, 'label not found: License Status', RECENT);
    await insertCanary(db, 'fl-dbpr', true, null, RECENT);

    expect(await health(db, NOW)).toEqual({
      'fl-mqa': 'degraded',
      'fl-dbpr': 'ok',
      'ca-cslb': 'unknown',
      'au-ahpra': 'unknown',
    });
  });

  it('judges a registry by its newest canary only', async () => {
    await insertCanary(db, 'fl-mqa', false, 'boom', OLD);
    await insertCanary(db, 'fl-mqa', true, null, RECENT);

    expect((await health(db, NOW))['fl-mqa']).toBe('ok');
  });
});
