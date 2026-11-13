import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import {
  InvalidInput,
  InvalidWebhook,
  WatchLimit,
  onComplaintsRun,
  validateCallerWebhook,
  createRecordWatch,
  deleteWatch,
  enqueueRechecks,
  forwardEvent,
  onMonitorWebhook,
  onRecheckRun,
  resolveWatchFromSearch,
} from '../src/watch/watch';
import { type Job } from '../src/queue/queue';
import {
  getKey,
  getWatch,
  insertWatch,
  listEvents,
  listWatches,
  setWatchTier,
  updateWatchFields,
  upsertKey,
} from '../src/store';
import type { Event, Fields } from '../src/types';
import { TinyFishError, type RunResult, type RunStep, type TinyFish } from '../src/tinyfish/client';
import expectedClear from './fixtures/fl-mqa/live-physician-1.fetch.expected.json';

// The text reader for Florida is not written yet, so this double runs the HTML reader again on
// the same page. Everything else on the adapters is real. The CSLB and AHPRA adapters are not
// written yet either, so they are agent-read doubles with the same parsers.
const missingAdapters = vi.hoisted(() => new Set<string>());

vi.mock('../src/registries/index', async () => {
  const { flMqa } = await import('../src/registries/fl-mqa');
  const { parseHtml } = await import('../src/registries/parsers/fl-mqa.dom');
  const { flDbpr: dbpr } = await import('../src/registries/fl-dbpr');
  const fl = {
    ...flMqa,
    parseText: (html: string) => ({ ...parseHtml(html), reader: 'parser_text' }),
  };
  const agent = (id: string, url: string) => ({
    ...fl,
    id,
    record: {
      kind: 'agent',
      start_url: url,
      goal: (n: string) => `Look up licence ${n}`,
      output_schema: { type: 'object' },
      max_steps: 15,
      source_lookup: (n: string) => `${url}?q=${n}`,
    },
  });
  const adapters: Record<string, unknown> = {
    'fl-mqa': fl,
    'fl-dbpr': dbpr,
    'ca-cslb': agent('ca-cslb', 'https://agent.test/cslb'),
    'au-ahpra': agent('au-ahpra', 'https://agent.test/ahpra'),
  };
  const lookup = (id: string) => (missingAdapters.has(id) ? undefined : adapters[id]);
  return {
    getAdapter: (id: string) => {
      const adapter = lookup(id);
      if (!adapter) throw new Error(`No adapter is registered for ${id}`);
      return adapter;
    },
    tryGetAdapter: lookup,
  };
});

const db = env.DB;
const BASE_URL = 'https://tinyverify.test';
const HOOK_SECRET = 'hook-secret-test';
const pages = import.meta.glob('./fixtures/watch/*.html', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const page = (name: string): string => pages[`./fixtures/watch/${name}.html`];
const baseline = expectedClear as unknown as Fields;

function testEnv(over: Partial<Env> = {}): Env {
  return { BASE_URL, HOOK_SECRET, ...over } as unknown as Env;
}

function stubClient() {
  const createMonitor = vi.fn(async (_req: unknown) => ({
    monitor: { id: 'mon_new' },
    run: { id: 'run_base', results: [{ text: page('mqa-clear') }], errors: [] as unknown[] },
  }));
  const deleteMonitor = vi.fn(async (_id: string) => {});
  const stepHtml = vi.fn(async (_run: string, _step: string) => page('mqa-clear'));
  const fetchPages = vi.fn(async (_urls: string[], _opts?: unknown) => ({
    results: [{ text: page('mqa-clear') }],
    errors: [] as unknown[],
  }));
  const client = { createMonitor, deleteMonitor, stepHtml, fetchPages, runAsync: vi.fn(), getRun: vi.fn() };
  return { client: client as unknown as TinyFish, createMonitor, deleteMonitor, stepHtml, fetchPages };
}

// The contractor board's complaint view as the two readers take it: a header row, then one row per complaint,
// then the footer. A case number is 10 digits and a date is MM/DD/YYYY.
const viewRow = (number: string, status: string, incident: string): string =>
  `<tr><td>${number}</td><td>Licensed Activity</td><td>${incident}</td><td>${status}</td><td>Closed</td><td></td><td><span></span><br><span>x</span></td></tr>`;
const complaintView = (rows: string[] = [], extra = ''): string =>
  '<html><body><h6>Complaint Details</h6><p>Below is a listing of public complaints regarding the person or entity selected.</p>' +
  '<table><thead><tr><th>Number</th><th>Class</th><th>Incident Date</th><th>Status</th><th>Disposition</th><th>Disposition Date</th>' +
  `<th><span>Discipline Date</span><br><span>Description</span></th></tr></thead><tbody>${rows.join('')}</tbody></table>${extra}<footer>The State of Florida is an AA/EEO employer.</footer></body></html>`;

// The watched licence's own page (CCC1234567), the snapshot a complaint run takes before it opens the view.
const liveRecord = import.meta.glob('./fixtures/fl-dbpr/live-contractor-1.fetch.html', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const recordPage = Object.values(liveRecord)[0].replaceAll('CCC0000000', 'CCC1234567');
const WITH_RECORD = [{ step_id: 'rec' }, { step_id: 'c1' }];
// Answers the record step with the licence page and every other step with `html`, the complaint view.
const viewAfterRecord = (
  stub: { stepHtml: { mockImplementation(fn: (run: string, step: string) => Promise<string>): unknown } },
  html: string,
): void => {
  stub.stepHtml.mockImplementation(async (_run: string, step: string) => (step === 'rec' ? recordPage : html));
};

// A record watch that already has a monitor and a stored baseline.
async function monitoredWatch(): Promise<{ watch_id: string; monitor_id: string }> {
  const monitor_id = `mon_${crypto.randomUUID()}`;
  const watch_id = await insertWatch(db, {
    kind: 'record',
    registry: 'fl-mqa',
    licence_number: 'ME000000',
    name: null,
    monitor_id,
    caller_webhook: null,
  });
  await updateWatchFields(db, watch_id, baseline);
  return { watch_id, monitor_id };
}

function hook(monitor_id: string, text: string | null, over: Record<string, unknown> = {}) {
  return {
    fetch_monitor_id: monitor_id,
    id: `run_${crypto.randomUUID()}`,
    is_baseline: false,
    outcome: 'changed',
    diff: '',
    results: text === null ? [] : [{ text }],
    errors: [],
    ...over,
  };
}

// A recheck-tier watch, inserted directly so the test does not depend on createRecordWatch.
async function cslbWatch(): Promise<{ watch_id: string }> {
  const watch_id = await insertWatch(db, {
    kind: 'record',
    registry: 'ca-cslb',
    licence_number: 'ME000000',
    name: null,
    monitor_id: null,
    caller_webhook: null,
  });
  return { watch_id };
}

async function eventsOf(watch_id: string): Promise<Event[]> {
  return listEvents(db, watch_id);
}

async function queueRows(kind: string): Promise<{ payload_json: string | null }[]> {
  const { results } = await db
    .prepare('SELECT payload_json FROM queue WHERE kind = ?')
    .bind(kind)
    .all<{ payload_json: string | null }>();
  return results;
}

function run(over: Partial<RunResult> = {}): RunResult {
  return {
    run_id: `run_${crypto.randomUUID()}`,
    status: 'COMPLETED',
    result: null,
    steps: [],
    steps_used: 0,
    error: null,
    ...over,
  };
}

const agentRecord = (status_raw: string) => ({
  record: {
    name: 'SAMPLE, PERSON A',
    licence_number: 'ME000000',
    status_raw,
    expires: '2028-01-31',
    issued: '2026-04-20',
    licence_type: 'Medical Doctor',
    discipline_flag: false,
    discipline_actions: [],
    data_as_of: '2026-11-03',
    city: 'SAMPLE CITY',
    other_names: [],
  },
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('createRecordWatch', () => {
  it('refuses a 31st monitored record watch with WatchLimit', async () => {
    for (let i = 0; i < 30; i += 1) {
      await insertWatch(db, {
        kind: 'record',
        registry: 'fl-mqa',
        licence_number: `ME00000${i}`,
        name: null,
        monitor_id: `mon_${i}`,
        caller_webhook: null,
      });
    }
    const stub = stubClient();
    await expect(createRecordWatch(testEnv(), db, stub.client, 'fl-mqa', 'ME000099')).rejects.toBeInstanceOf(
      WatchLimit,
    );
    expect(await listWatches(db, 'record')).toHaveLength(30);
    expect(stub.createMonitor).not.toHaveBeenCalled();
  });

  it('queues a key search with the watch id when the record link is unknown', async () => {
    const stub = stubClient();
    const result = await createRecordWatch(testEnv(), db, stub.client, 'fl-mqa', 'ME000000');
    expect(result).toEqual({ watch_id: result.watch_id, tier: 'monitor', pending: true });
    const jobs = await queueRows('search');
    expect(jobs).toHaveLength(1);
    expect(JSON.parse(jobs[0].payload_json ?? 'null').watch_id).toBe(result.watch_id);
    expect(stub.createMonitor).not.toHaveBeenCalled();
  });

  it('creates the Monitor with the CRON_TZ schedule and stores the baseline when the link is known', async () => {
    await upsertKey(db, 'fl-mqa', 'ME000000', { licInd: '111', proCde: '22' });
    const stub = stubClient();
    const result = await createRecordWatch(testEnv(), db, stub.client, 'fl-mqa', 'ME000000');
    expect(result).toEqual({ watch_id: result.watch_id, tier: 'monitor' });

    const req = stub.createMonitor.mock.calls[0][0] as Record<string, unknown>;
    expect(req).toMatchObject({
      type: 'fetch',
      name: 'fl-mqa ME000000',
      config: { format: 'html' },
      schedule_cron: 'CRON_TZ=America/New_York 0 7 * * *',
      purpose: 'The licence status, expiry date or discipline flag changes',
      webhook_url: `${BASE_URL}/hooks/tinyfish/monitor/${HOOK_SECRET}`,
    });
    expect((req.config as { url: string }).url).toContain('LicenseVerification?LicInd=111&ProCde=22');

    const watch = await getWatch(db, result.watch_id);
    expect(watch?.monitor_id).toBe('mon_new');
    expect(JSON.parse(watch?.last_fields_json ?? 'null')).toEqual(baseline);
  });

  it('finishes a pending watch from the link-finder answer on resolveWatchFromSearch', async () => {
    const stub = stubClient();
    const created = await createRecordWatch(testEnv(), db, stub.client, 'fl-mqa', 'ME000000');
    const job: Job = {
      job_id: 'job_search_1',
      kind: 'search',
      priority: 2,
      bucket: 'ops',
      reserved_cents: 0,
      payload: { watch_id: created.watch_id, registry: 'fl-mqa', request: { url: 'https://x.test', goal: 'g' } },
    };
    // The health board's number goal answers with the page value, found and the address, and no rows.
    const searchRun = run({
      status: 'COMPLETED',
      result: {
        page: 'results',
        found: true,
        url: 'LicenseVerification?LicInd=111&ProCde=22',
        licence_number: 'ME000000',
        rows: [],
        total: 0,
      },
    });
    await resolveWatchFromSearch(testEnv(), db, stub.client, job, searchRun);
    expect(stub.createMonitor).toHaveBeenCalledTimes(1);
    expect((await getKey(db, 'fl-mqa', 'ME000000'))?.link_json).toContain('"licInd":"111"');
    expect((await getWatch(db, created.watch_id))?.monitor_id).toBe('mon_new');
  });
});

describe('deleteWatch', () => {
  it('deletes the Monitor and hides the watch', async () => {
    const { watch_id, monitor_id } = await monitoredWatch();
    const stub = stubClient();
    await deleteWatch(db, stub.client, watch_id);
    expect(stub.deleteMonitor).toHaveBeenCalledWith(monitor_id);
    expect((await listWatches(db, 'record')).map((w) => w.watch_id)).not.toContain(watch_id);
  });
});

describe('onMonitorWebhook', () => {
  it('ignores a webhook for an unknown monitor id', async () => {
    const stub = stubClient();
    expect(await onMonitorWebhook(testEnv(), db, stub.client, hook('mon_unknown', page('mqa-clear')))).toBe('ignored');
  });

  it('logs one warn line, with the reason and not the body, when it ignores a webhook', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const stub = stubClient();
      expect(
        await onMonitorWebhook(testEnv(), db, stub.client, {
          fetch_monitor_id: 'mon_unknown',
          id: 'run_u',
          note: 'BODY-MARKER',
        }),
      ).toBe('ignored');
      expect(await onMonitorWebhook(testEnv(), db, stub.client, { note: 'BODY-MARKER' })).toBe('ignored');
      expect(await onMonitorWebhook(testEnv(), db, stub.client, 'BODY-MARKER')).toBe('ignored');
      expect(warn.mock.calls.map((a) => a.join(' '))).toEqual([
        'Monitor webhook ignored: no watch has that monitor id',
        'Monitor webhook ignored: the body is not a monitor run',
        'Monitor webhook ignored: the body is not a monitor run',
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('logs nothing when it processes a webhook', async () => {
    const { monitor_id } = await monitoredWatch();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await onMonitorWebhook(testEnv(), db, stubClient().client, hook(monitor_id, page('mqa-clear')))).toBe(
        'processed',
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('treats a repeated run id as a duplicate', async () => {
    const { monitor_id } = await monitoredWatch();
    const stub = stubClient();
    const body = hook(monitor_id, page('mqa-clear'));
    expect(await onMonitorWebhook(testEnv(), db, stub.client, body)).toBe('processed');
    expect(await onMonitorWebhook(testEnv(), db, stub.client, body)).toBe('duplicate');
  });

  it('raises check_failed and leaves the stored fields alone on a maintenance page', async () => {
    const { watch_id, monitor_id } = await monitoredWatch();
    const stub = stubClient();
    await onMonitorWebhook(testEnv(), db, stub.client, hook(monitor_id, page('maintenance')));
    const events = await eventsOf(watch_id);
    expect(events.map((e) => e.kind)).toEqual(['check_failed']);
    const after = await getWatch(db, watch_id);
    expect(JSON.parse(after?.last_fields_json ?? 'null')).toEqual(baseline);
  });

  it('writes an unchanged event for a run where nothing changed, with the page saved as its snapshot', async () => {
    const { watch_id, monitor_id } = await monitoredWatch();
    await onMonitorWebhook(testEnv(), db, stubClient().client, hook(monitor_id, page('mqa-clear')));
    const events = await eventsOf(watch_id);
    expect(events.map((e) => e.kind)).toEqual(['unchanged']);
    expect(events[0].evidence.snapshot_id).toMatch(/^snap_/);
    expect(events[0].evidence.note).toBeUndefined();
    expect(events[0].before).toBeNull();
    expect(events[0].after).toBeNull();
  });

  it('writes one unchanged event for every quiet run, each with its own time', async () => {
    const { watch_id, monitor_id } = await monitoredWatch();
    const client = stubClient().client;
    for (let i = 0; i < 3; i++) await onMonitorWebhook(testEnv(), db, client, hook(monitor_id, page('mqa-clear')));
    const events = await eventsOf(watch_id);
    expect(events.map((e) => e.kind)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    expect(new Set(events.map((e) => e.event_id)).size).toBe(3);
  });

  it('keeps the Monitor judgment beside an unchanged event, and never lets it decide', async () => {
    const { watch_id, monitor_id } = await monitoredWatch();
    const judgment = { changed: true, summary: 'The Monitor thinks the page moved' };
    await onMonitorWebhook(testEnv(), db, stubClient().client, hook(monitor_id, page('mqa-clear'), { judgment }));
    const events = await eventsOf(watch_id);
    expect(events.map((e) => e.kind)).toEqual(['unchanged']);
    expect(events[0].evidence.judgment).toEqual(judgment);
  });

  it('writes no unchanged event for the first reading of a watch, which is only a baseline', async () => {
    const watch_id = await insertWatch(db, {
      kind: 'record',
      registry: 'fl-mqa',
      licence_number: 'ME000000',
      name: null,
      monitor_id: 'mon_first',
      caller_webhook: null,
    });
    await onMonitorWebhook(testEnv(), db, stubClient().client, hook('mon_first', page('mqa-clear')));
    expect(await eventsOf(watch_id)).toHaveLength(0);
  });

  it('writes an unchanged note, not a status change, when only Data As Of moves', async () => {
    const { watch_id, monitor_id } = await monitoredWatch();
    const stub = stubClient();
    await onMonitorWebhook(testEnv(), db, stub.client, hook(monitor_id, page('mqa-data-as-of')));
    const events = await eventsOf(watch_id);
    expect(events.map((e) => e.kind)).toEqual(['unchanged']);
    expect(events[0].evidence.note).toBe('only data_as_of changed');
  });

  it('raises status_change with before and after when the status moves', async () => {
    const { watch_id, monitor_id } = await monitoredWatch();
    const stub = stubClient();
    await onMonitorWebhook(testEnv(), db, stub.client, hook(monitor_id, page('mqa-null-void')));
    const [event] = await eventsOf(watch_id);
    expect(event.kind).toBe('status_change');
    expect(event.before).toMatchObject({ status: 'active', status_raw: 'Clear/Active' });
    expect(event.after).toMatchObject({ status: 'inactive', status_raw: 'Null and Void' });
  });

  it('moves a watch to the daily re-read after two Monitor errors, and keeps the Monitor', async () => {
    const { watch_id, monitor_id } = await monitoredWatch();
    const stub = stubClient();
    const broken = () => hook(monitor_id, page('maintenance'), { errors: [{ code: 'x' }] });
    await onMonitorWebhook(testEnv(), db, stub.client, broken());
    expect((await getWatch(db, watch_id))?.fail_streak).toBe(1);
    expect((await getWatch(db, watch_id))?.tier).toBeNull();
    await onMonitorWebhook(testEnv(), db, stub.client, broken());
    const after = await getWatch(db, watch_id);
    expect(after?.tier).toBe('recheck');
    expect(after?.monitor_id).toBe(monitor_id);
    expect(stub.deleteMonitor).not.toHaveBeenCalled();
    const notes = (await eventsOf(watch_id)).map((e) => e.evidence.note);
    expect(notes.every((n) => n === 'check failed: the monitor reported errors')).toBe(true);
    expect(await onMonitorWebhook(testEnv(), db, stub.client, hook(monitor_id, page('mqa-clear')))).toBe('processed');
    expect((await getWatch(db, watch_id))?.fail_streak).toBe(0);
  });

  it('does not count a maintenance page without errors toward the streak', async () => {
    const { watch_id, monitor_id } = await monitoredWatch();
    const stub = stubClient();
    await onMonitorWebhook(testEnv(), db, stub.client, hook(monitor_id, page('maintenance')));
    await onMonitorWebhook(testEnv(), db, stub.client, hook(monitor_id, page('maintenance')));
    const watch = await getWatch(db, watch_id);
    expect(watch?.fail_streak).toBe(0);
    expect(watch?.tier).toBeNull();
  });

  it('keeps the licence check on Monitor pages: another licence number is check_failed and stores nothing', async () => {
    const { watch_id, monitor_id } = await monitoredWatch();
    const stub = stubClient();
    const other = page('mqa-clear').replaceAll('ME000000', 'ME000999');
    await onMonitorWebhook(testEnv(), db, stub.client, hook(monitor_id, other));
    const events = await eventsOf(watch_id);
    expect(events.map((e) => e.kind)).toEqual(['check_failed']);
    expect(events[0].evidence.note).toBe('licence_number_mismatch');
    expect(JSON.parse((await getWatch(db, watch_id))?.last_fields_json ?? 'null')).toEqual(baseline);
  });

  it('stores the Monitor judgment beside the event when the webhook carries one', async () => {
    const { watch_id, monitor_id } = await monitoredWatch();
    const stub = stubClient();
    await onMonitorWebhook(
      testEnv(),
      db,
      stub.client,
      hook(monitor_id, page('mqa-null-void'), { judgment: 'probable' }),
    );
    const [event] = await eventsOf(watch_id);
    expect(event.kind).toBe('status_change');
    expect((event.evidence as { judgment?: unknown }).judgment).toBe('probable');
  });
});

describe('enqueueRechecks', () => {
  async function registerWatches(): Promise<{ cslb: string; ahpra: string; dbpr: string }> {
    const cslb = await insertWatch(db, {
      kind: 'record',
      registry: 'ca-cslb',
      licence_number: '123456',
      name: null,
      monitor_id: null,
      caller_webhook: null,
    });
    const ahpra = await insertWatch(db, {
      kind: 'record',
      registry: 'au-ahpra',
      licence_number: 'MED0001',
      name: null,
      monitor_id: null,
      caller_webhook: null,
    });
    await upsertKey(db, 'fl-dbpr', 'CCC1234567', { id: '0'.repeat(32) });
    const dbpr = await insertWatch(db, {
      kind: 'record',
      registry: 'fl-dbpr',
      licence_number: 'CCC1234567',
      name: null,
      monitor_id: 'mon_dbpr',
      caller_webhook: null,
    });
    await insertWatch(db, {
      kind: 'record',
      registry: 'fl-mqa',
      licence_number: 'ME000000',
      name: null,
      monitor_id: 'mon_fl',
      caller_webhook: null,
    });
    return { cslb, ahpra, dbpr };
  }

  it('enqueues CSLB and AHPRA re-checks and DBPR complaints on a Monday', async () => {
    const ids = await registerWatches();
    const monday = new Date('2026-11-02T12:00:00.000Z');
    expect(await enqueueRechecks(testEnv(), db, monday)).toBe(3);
    const rechecks = (await queueRows('recheck')).map((r) => JSON.parse(r.payload_json ?? 'null').watch_id);
    expect(rechecks.sort()).toEqual([ids.cslb, ids.ahpra].sort());
    const complaints = (await queueRows('recheck_complaints')).map(
      (r) => JSON.parse(r.payload_json ?? 'null').watch_id,
    );
    expect(complaints).toEqual([ids.dbpr]);
  });

  it('asks the weekly complaint run to capture the page and a screenshot', async () => {
    await registerWatches();
    await enqueueRechecks(testEnv(), db, new Date('2026-11-02T12:00:00.000Z'));
    const [row] = await queueRows('recheck_complaints');
    const request = (
      JSON.parse(row.payload_json ?? 'null') as {
        request: { capture_config?: unknown; goal: string; output_schema: { required: string[] } };
      }
    ).request;
    expect(request.capture_config).toEqual({ html: true, screenshots: true });
    expect(request.output_schema.required).toEqual(['complaints', 'complaint_view_opened', 'evidence_line']);
    expect(request.goal).toContain('complaint_view_opened');
  });

  it('skips a watch whose registry has no adapter and still queues the others', async () => {
    const ids = await registerWatches();
    missingAdapters.add('au-ahpra');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await enqueueRechecks(testEnv(), db, new Date('2026-11-03T12:00:00.000Z'))).toBe(1);
      expect(warn).toHaveBeenCalled();
      const rechecks = (await queueRows('recheck')).map((r) => JSON.parse(r.payload_json ?? 'null').watch_id);
      expect(rechecks).toEqual([ids.cslb]);
    } finally {
      missingAdapters.clear();
    }
  });

  it('enqueues no DBPR complaints on other days', async () => {
    await registerWatches();
    expect(await enqueueRechecks(testEnv(), db, new Date('2026-11-03T12:00:00.000Z'))).toBe(2);
    expect(await queueRows('recheck_complaints')).toHaveLength(0);
  });

  it('does not queue the same re-check twice in one day', async () => {
    await registerWatches();
    const monday = new Date('2026-11-02T12:00:00.000Z');
    expect(await enqueueRechecks(testEnv(), db, monday)).toBe(3);
    expect(await enqueueRechecks(testEnv(), db, monday)).toBe(0);
  });
});

describe('onRecheckRun', () => {
  it('stores a baseline, then raises status_change when the agent and the page both show the new status', async () => {
    const stub = stubClient();
    const created = await cslbWatch();

    const first = run({ result: agentRecord('Clear/Active'), steps: [{ step_id: 'step_1' }] });
    await onRecheckRun(testEnv(), db, stub.client, created.watch_id, first);
    expect(await eventsOf(created.watch_id)).toHaveLength(0);
    expect(stub.stepHtml).toHaveBeenCalledWith(first.run_id, 'step_1');

    stub.stepHtml.mockResolvedValueOnce(page('mqa-null-void'));
    await onRecheckRun(
      testEnv(),
      db,
      stub.client,
      created.watch_id,
      run({ result: agentRecord('Null and Void'), steps: [{ step_id: 'step_2' }] }),
    );
    const [event] = await eventsOf(created.watch_id);
    expect(event.kind).toBe('status_change');
    expect(event.before).toMatchObject({ status: 'active' });
    expect(event.after).toMatchObject({ status: 'inactive' });
  });

  it('raises check_failed with the note capture unavailable, and does not throw, when the step page cannot be captured', async () => {
    const stub = stubClient();
    const created = await cslbWatch();
    stub.stepHtml.mockRejectedValueOnce(new Error('capture failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        onRecheckRun(
          testEnv(),
          db,
          stub.client,
          created.watch_id,
          run({ result: agentRecord('Clear/Active'), steps: [{ step_id: 'step_1' }] }),
        ),
      ).resolves.toBeUndefined();
    } finally {
      warn.mockRestore();
    }
    const events = await eventsOf(created.watch_id);
    expect(events.map((e) => [e.kind, e.evidence.note])).toEqual([['check_failed', 'capture unavailable']]);
  });

  it('reads the page from the last step that has a capture, not the closing step', async () => {
    const stub = stubClient();
    const created = await cslbWatch();
    const steps = [
      { step_id: 'a', has_html: true, has_screenshot: true },
      { step_id: 'b', has_html: true, has_screenshot: true },
      { step_id: 'done', has_html: false, has_screenshot: false },
    ];
    const finished = run({ result: agentRecord('Clear/Active'), steps });
    await onRecheckRun(testEnv(), db, stub.client, created.watch_id, finished);
    expect(stub.stepHtml).toHaveBeenCalledTimes(1);
    expect(stub.stepHtml).toHaveBeenCalledWith(finished.run_id, 'b');
  });

  it('walks back past a step whose page answers 404 and reads the one before', async () => {
    const stub = stubClient();
    const created = await cslbWatch();
    stub.stepHtml.mockImplementation(async (_run: string, step: string) => {
      if (step === 'c') throw new TinyFishError('not_found', 404, 'gone');
      return page('mqa-clear');
    });
    const steps = [{ step_id: 'a' }, { step_id: 'b' }, { step_id: 'c' }, { step_id: 'done', has_html: false }];
    const finished = run({ result: agentRecord('Clear/Active'), steps });
    await onRecheckRun(testEnv(), db, stub.client, created.watch_id, finished);
    expect(stub.stepHtml.mock.calls.map((c) => c[1])).toEqual(['c', 'b']);
    const [snap] = (
      await db
        .prepare('SELECT step_id FROM snapshots WHERE watch_id = ?')
        .bind(created.watch_id)
        .all<{ step_id: string }>()
    ).results;
    expect(snap?.step_id).toBe('b');
  });

  it('raises check_failed with capture unavailable when four steps in a row answer 404', async () => {
    const stub = stubClient();
    const created = await cslbWatch();
    stub.stepHtml.mockRejectedValue(new TinyFishError('not_found', 404, 'gone'));
    const steps = ['a', 'b', 'c', 'd', 'e'].map((step_id) => ({ step_id }));
    await onRecheckRun(
      testEnv(),
      db,
      stub.client,
      created.watch_id,
      run({ result: agentRecord('Clear/Active'), steps }),
    );
    expect(stub.stepHtml).toHaveBeenCalledTimes(4);
    const events = await eventsOf(created.watch_id);
    expect(events.map((e) => [e.kind, e.evidence.note])).toEqual([['check_failed', 'capture unavailable']]);
  });

  it('raises check_failed with the no-page note, and asks for no page, when no step has a capture', async () => {
    const stub = stubClient();
    const created = await cslbWatch();
    const steps = [{ step_id: 'done', has_html: false, has_screenshot: false }];
    await onRecheckRun(
      testEnv(),
      db,
      stub.client,
      created.watch_id,
      run({ result: agentRecord('Clear/Active'), steps }),
    );
    expect(stub.stepHtml).not.toHaveBeenCalled();
    const events = await eventsOf(created.watch_id);
    expect(events.map((e) => e.kind)).toEqual(['check_failed']);
    expect(events[0].evidence.note).toMatch(/captured no page/);
  });

  it('raises check_failed when the readers disagree', async () => {
    const stub = stubClient();
    const created = await cslbWatch();
    await onRecheckRun(
      testEnv(),
      db,
      stub.client,
      created.watch_id,
      run({ result: agentRecord('Null and Void'), steps: [{ step_id: 'step_1' }] }),
    );
    const events = await eventsOf(created.watch_id);
    expect(events.map((e) => e.kind)).toEqual(['check_failed']);
    expect(events[0].evidence.note).toMatch(/do not agree/);
  });
});

describe('forwardEvent', () => {
  const event: Event = {
    event_id: 'ev_1',
    watch_id: 'w_1',
    kind: 'status_change',
    before: { status: 'active' },
    after: { status: 'inactive' },
    evidence: {},
    created_at: '2026-11-04T00:00:00.000Z',
  };

  it('posts the event as JSON to the caller webhook', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    await forwardEvent(event, 'https://caller.test/hook');
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://caller.test/hook');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(event);
  });

  it('forwards status_change and check_failed events, and never an unchanged one', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    try {
      for (const kind of ['status_change', 'check_failed'] as const) {
        await forwardEvent({ ...event, kind }, 'https://caller.test/hook');
      }
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      await forwardEvent({ ...event, kind: 'unchanged' }, 'https://caller.test/hook');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('does not throw when the caller webhook fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(forwardEvent(event, 'https://caller.test/hook')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

// A D1 handle that counts the round trips made through it: every statement run on its own, and every batch.
function countingDb(real: D1Database): { db: D1Database; calls: () => number } {
  let calls = 0;
  const real_of = new WeakMap<object, D1PreparedStatement>();
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const proxy: D1PreparedStatement = new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (prop === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
        if (prop === 'run' || prop === 'all' || prop === 'first' || prop === 'raw') {
          return (...args: unknown[]) => {
            calls += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    real_of.set(proxy, stmt);
    return proxy;
  };
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare') return (query: string) => wrap(target.prepare(query));
      if (prop === 'batch') {
        return (statements: D1PreparedStatement[]) => {
          calls += 1;
          return target.batch(statements.map((st) => real_of.get(st) ?? st));
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { db, calls: () => calls };
}

describe('enqueueRechecks batching and caps', () => {
  const cslbWatches = async (n: number): Promise<string[]> => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(
        await insertWatch(db, {
          kind: 'record',
          registry: 'ca-cslb',
          licence_number: `${1000 + i}`,
          name: null,
          monitor_id: null,
          caller_webhook: null,
        }),
      );
    }
    return ids;
  };
  const stamped = async (): Promise<number> =>
    (await db.prepare('SELECT COUNT(*) AS n FROM watches WHERE last_recheck_at IS NOT NULL').first<{ n: number }>())
      ?.n ?? 0;
  const pending = async (): Promise<number> =>
    (await db.prepare("SELECT COUNT(*) AS n FROM queue WHERE state = 'pending'").first<{ n: number }>())?.n ?? 0;

  it('keeps its cap of 10 and queues exactly 10 of 12 due watches, each stamped', async () => {
    await cslbWatches(12);
    expect(await enqueueRechecks(testEnv(), db, new Date('2026-11-03T12:00:00.000Z'))).toBe(10);
    expect(await pending()).toBe(10);
    expect(await stamped()).toBe(10);
  });

  it('uses 3 D1 round trips for 10 queued re-checks: one batch of reads, one count, one batch of writes', async () => {
    await cslbWatches(12);
    const counted = countingDb(db);
    expect(await enqueueRechecks(testEnv(), counted.db, new Date('2026-11-03T12:00:00.000Z'))).toBe(10);
    expect(counted.calls()).toBe(3);
    expect(await pending()).toBe(10);
  });

  it('uses 4 D1 round trips on a Monday with DBPR complaint runs: the stored links are read in one batch', async () => {
    await cslbWatches(2);
    const dbprIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const n = `CCC000000${i}`;
      await upsertKey(db, 'fl-dbpr', n, { id: `${i}`.repeat(32) });
      dbprIds.push(
        await insertWatch(db, {
          kind: 'record',
          registry: 'fl-dbpr',
          licence_number: n,
          name: null,
          monitor_id: `mon_${i}`,
          caller_webhook: null,
        }),
      );
    }
    const counted = countingDb(db);
    expect(await enqueueRechecks(testEnv(), counted.db, new Date('2026-11-02T12:00:00.000Z'))).toBe(8);
    expect(counted.calls()).toBe(4);
    const complaintWatches = (await queueRows('recheck_complaints')).map(
      (r) => JSON.parse(r.payload_json ?? 'null').watch_id as string,
    );
    expect(complaintWatches.sort()).toEqual([...dbprIds].sort());
    const stampedComplaints = await db
      .prepare('SELECT COUNT(*) AS n FROM watches WHERE last_complaints_at IS NOT NULL')
      .first<{ n: number }>();
    expect(stampedComplaints?.n).toBe(6);
  });

  it('still reads the free daily re-read of a link registry inline and stamps it with the batch', async () => {
    await upsertKey(db, 'fl-mqa', 'ME000000', { licInd: '111', proCde: '22' });
    const watch_id = await insertWatch(db, {
      kind: 'record',
      registry: 'fl-mqa',
      licence_number: 'ME000000',
      name: null,
      monitor_id: 'mon_inline',
      caller_webhook: null,
    });
    await updateWatchFields(db, watch_id, baseline);
    await setWatchTier(db, watch_id, 'recheck');
    const stub = stubClient();
    const ids = await cslbWatches(1);
    expect(await enqueueRechecks(testEnv(), db, new Date('2026-11-03T12:00:00.000Z'), stub.client)).toBe(2);
    expect(stub.fetchPages).toHaveBeenCalledTimes(1);
    expect(await pending()).toBe(1);
    const rows = await db
      .prepare('SELECT watch_id, last_recheck_at FROM watches WHERE watch_id IN (?, ?)')
      .bind(watch_id, ids[0])
      .all<{ last_recheck_at: string | null }>();
    expect(rows.results.every((r) => r.last_recheck_at === '2026-11-03T12:00:00.000Z')).toBe(true);
  });

  it('does not re-read a link registry fetched in the last 20 hours', async () => {
    await upsertKey(db, 'fl-mqa', 'ME000000', { licInd: '111', proCde: '22' });
    const watch_id = await insertWatch(db, {
      kind: 'record',
      registry: 'fl-mqa',
      licence_number: 'ME000000',
      name: null,
      monitor_id: 'mon_inline2',
      caller_webhook: null,
    });
    await updateWatchFields(db, watch_id, baseline);
    await setWatchTier(db, watch_id, 'recheck');
    const stub = stubClient();
    const first = new Date('2026-11-03T12:00:00.000Z');
    expect(await enqueueRechecks(testEnv(), db, first, stub.client)).toBe(1);
    // The reading wrote a fetch_html snapshot, so a pass 2 hours later leaves the watch alone.
    expect(await enqueueRechecks(testEnv(), db, new Date(first.getTime() + 2 * 3_600_000), stub.client)).toBe(0);
    expect(stub.fetchPages).toHaveBeenCalledTimes(1);
  });

  it('adds only the jobs that fit when the queue is nearly full, and stamps only those watches', async () => {
    await cslbWatches(5);
    await db.batch(
      Array.from({ length: 48 }, (_, i) =>
        db
          .prepare(
            "INSERT INTO queue (job_id, kind, priority, payload_json, state, bucket, reserved_cents, created_at) VALUES (?, 'search', 1, '{}', 'pending', 'public', 0, ?)",
          )
          .bind(`fill_${i}`, new Date().toISOString()),
      ),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await enqueueRechecks(testEnv(), db, new Date('2026-11-03T12:00:00.000Z'))).toBe(2);
      expect(warn).toHaveBeenCalledWith('The run queue is full; the rest of the re-checks are not queued');
    } finally {
      warn.mockRestore();
    }
    expect(await pending()).toBe(50);
    expect(await stamped()).toBe(2);
  });

  it('queues the same 10 oldest-first as before: never-checked watches go ahead of stamped ones', async () => {
    const ids = await cslbWatches(12);
    // Stamp the first two as checked long ago; every other watch has never been checked.
    for (const id of ids.slice(0, 2))
      await db
        .prepare('UPDATE watches SET last_recheck_at = ? WHERE watch_id = ?')
        .bind('2026-10-01T00:00:00.000Z', id)
        .run();
    await enqueueRechecks(testEnv(), db, new Date('2026-11-03T12:00:00.000Z'));
    const queued = (await queueRows('recheck')).map((r) => JSON.parse(r.payload_json ?? 'null').watch_id as string);
    expect(queued).toHaveLength(10);
    // The 10 never-checked watches are taken; the two already checked wait.
    expect(queued.sort()).toEqual(ids.slice(2).sort());
  });
});

describe('caller webhook validation', () => {
  it.each([
    'http://example.com/hook',
    'https://127.0.0.1/x',
    'https://[::1]/x',
    'https://localhost/x',
    'https://svc.internal/x',
  ])('rejects %s on watch creation', async (url) => {
    const stub = stubClient();
    await expect(createRecordWatch(testEnv(), db, stub.client, 'fl-mqa', 'ME000000', url)).rejects.toBeInstanceOf(
      InvalidWebhook,
    );
    expect(await listWatches(db, 'record')).toHaveLength(0);
  });

  it('accepts a public https webhook', () => {
    expect(validateCallerWebhook('https://example.com/hook')).toBeNull();
  });

  it('does not follow a redirect from the caller', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://evil.test/' } }));
    const event: Event = {
      event_id: 'ev_r',
      watch_id: 'w_r',
      kind: 'status_change',
      before: null,
      after: null,
      evidence: {},
      created_at: '2026-11-04T00:00:00.000Z',
    };
    await expect(forwardEvent(event, 'https://caller.test/hook')).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((fetchSpy.mock.calls[0][1] as RequestInit).redirect).toBe('manual');
  });
});

describe('licence input', () => {
  it('rejects a licence number with characters outside the shape', async () => {
    const stub = stubClient();
    await expect(createRecordWatch(testEnv(), db, stub.client, 'fl-mqa', 'ME-1;DROP')).rejects.toBeInstanceOf(
      InvalidInput,
    );
  });

  it('rejects a licence number that the registry format does not allow', async () => {
    const stub = stubClient();
    await expect(createRecordWatch(testEnv(), db, stub.client, 'fl-mqa', 'XX')).rejects.toBeInstanceOf(InvalidInput);
  });
});

describe('monitor ceiling counts pending watches', () => {
  it('refuses a new monitor-tier watch when 30 pending ones exist', async () => {
    for (let i = 0; i < 30; i += 1) {
      await insertWatch(db, {
        kind: 'record',
        registry: 'fl-mqa',
        licence_number: `ME00001${i % 10}`,
        name: null,
        monitor_id: null,
        caller_webhook: null,
      });
    }
    const stub = stubClient();
    await expect(createRecordWatch(testEnv(), db, stub.client, 'fl-mqa', 'ME000099')).rejects.toBeInstanceOf(
      WatchLimit,
    );
  });

  it('re-checks the ceiling before createMonitor and fails the watch instead', async () => {
    const stub = stubClient();
    // No record link yet, so the watch is pending until its key search finishes.
    const created = await createRecordWatch(testEnv(), db, stub.client, 'fl-mqa', 'ME000000');
    // Another pending watch appears after this one was accepted, so this one would be the 31st.
    for (let i = 0; i < 30; i += 1) {
      await insertWatch(db, {
        kind: 'record',
        registry: 'fl-mqa',
        licence_number: `ME00002${i % 10}`,
        name: null,
        monitor_id: null,
        caller_webhook: null,
      });
    }
    stub.createMonitor.mockClear();
    const job: Job = {
      job_id: 'job_limit',
      kind: 'search',
      priority: 2,
      bucket: 'ops',
      reserved_cents: 0,
      payload: { watch_id: created.watch_id, registry: 'fl-mqa', request: { url: 'https://x.test', goal: 'g' } },
    };
    const found = run({
      status: 'COMPLETED',
      result: {
        rows: [
          {
            licence_number: 'ME000000',
            name: 'SAMPLE, PERSON A',
            profession: 'Medical Doctor',
            city: 'SAMPLE CITY',
            status_raw: 'Clear/Active',
            link_url: 'LicenseVerification?LicInd=111&ProCde=22',
          },
        ],
      },
    });
    await resolveWatchFromSearch(testEnv(), db, stub.client, job, found);
    expect(stub.createMonitor).not.toHaveBeenCalled();
    const events = await eventsOf(created.watch_id);
    expect(events.map((e) => e.kind)).toEqual(['check_failed']);
    expect(events[0].evidence.note).toMatch(/limit/);
    expect((await listWatches(db, 'record')).map((w) => w.watch_id)).not.toContain(created.watch_id);
  });
});

describe('onComplaintsRun', () => {
  it('turns complaints into discipline actions and raises status_change when they change', async () => {
    const watch_id = await insertWatch(db, {
      kind: 'record',
      registry: 'fl-dbpr',
      licence_number: 'CCC1234567',
      name: null,
      monitor_id: 'mon_dbpr',
      caller_webhook: null,
    });
    const stub = stubClient();
    const withSteps = (result: unknown) => run({ result, steps: WITH_RECORD });

    viewAfterRecord(stub, complaintView());
    await onComplaintsRun(
      testEnv(),
      db,
      stub.client,
      watch_id,
      withSteps({ complaints: [], complaint_view_opened: true, evidence_line: 'No complaints on file' }),
    );
    expect(await eventsOf(watch_id)).toHaveLength(0);

    const withComplaint = complaintView([viewRow('2026041200', 'Closed', '10/01/2026')]);
    viewAfterRecord(stub, withComplaint);
    await onComplaintsRun(
      testEnv(),
      db,
      stub.client,
      watch_id,
      withSteps({
        complaints: [{ case_number: '2026041200', status: 'Closed', date: '10/01/2026', description: 'x' }],
        complaint_view_opened: true,
        evidence_line: '2026041200 Closed 10/01/2026',
      }),
    );
    const events = await eventsOf(watch_id);
    expect(events.map((e) => e.kind)).toEqual(['status_change']);
    expect(events[0].before).toMatchObject({ discipline_flag: false, discipline_actions: [] });
    expect(events[0].after).toMatchObject({
      discipline_flag: true,
      discipline_actions: ['2026041200 Closed 10/01/2026'],
    });

    const stored = JSON.parse((await getWatch(db, watch_id))?.last_fields_json ?? 'null') as Fields;
    expect(stored.discipline_actions).toEqual(['2026041200 Closed 10/01/2026']);

    const snap = await db
      .prepare('SELECT reader_input, body FROM snapshots WHERE watch_id = ? ORDER BY created_at DESC LIMIT 1')
      .bind(watch_id)
      .first<{ reader_input: string; body: string }>();
    expect(snap?.reader_input).toBe('agent_html');
    expect(snap?.body).toBe(withComplaint);
  });

  it('writes one unchanged event when the complaints are unchanged', async () => {
    const complaint = { case_number: '2026041200', status: 'Closed', date: '10/01/2026', description: 'x' };
    const watch_id = await insertWatch(db, {
      kind: 'record',
      registry: 'fl-dbpr',
      licence_number: 'CCC1234567',
      name: null,
      monitor_id: 'mon_dbpr2',
      caller_webhook: null,
    });
    const stub = stubClient();
    viewAfterRecord(stub, complaintView([viewRow('2026041200', 'Closed', '10/01/2026')]));
    const go = () =>
      onComplaintsRun(
        testEnv(),
        db,
        stub.client,
        watch_id,
        run({
          result: {
            complaints: [complaint],
            complaint_view_opened: true,
            evidence_line: '2026041200 Closed 10/01/2026',
          },
          steps: WITH_RECORD,
        }),
      );
    await go();
    await go();
    expect((await eventsOf(watch_id)).map((e) => e.kind)).toEqual(['unchanged']);
  });
});

describe('onComplaintsRun proof that the complaint view was opened', () => {
  async function flaggedWatch(): Promise<string> {
    const watch_id = await insertWatch(db, {
      kind: 'record',
      registry: 'fl-dbpr',
      licence_number: 'CCC1234567',
      name: null,
      monitor_id: 'mon_proof',
      caller_webhook: null,
    });
    await updateWatchFields(db, watch_id, {
      ...baseline,
      discipline_flag: true,
      discipline_actions: ['2026041200 Closed 10/01/2026'],
    } as Fields);
    return watch_id;
  }
  const snapshotsOf = async (watch_id: string) =>
    (
      await db
        .prepare(
          'SELECT reader_input, body, run_id, step_id FROM snapshots WHERE watch_id = ? ORDER BY created_at DESC',
        )
        .bind(watch_id)
        .all<{ reader_input: string; body: string; run_id: string | null; step_id: string | null }>()
    ).results;
  const storedFields = async (watch_id: string) =>
    JSON.parse((await getWatch(db, watch_id))?.last_fields_json ?? 'null') as Fields;

  for (const [label, result] of [
    ['complaint_view_opened is false', { complaints: [], complaint_view_opened: false, evidence_line: '' }],
    ['complaint_view_opened is missing', { complaints: [] }],
    ['complaint_view_opened is the text "true"', { complaints: [], complaint_view_opened: 'true', evidence_line: 'x' }],
  ] as const) {
    it(`takes the page's answer, with agent_answer_differs, when ${label}`, async () => {
      const watch_id = await flaggedWatch();
      const stub = stubClient();
      viewAfterRecord(stub, complaintView([viewRow('2026041200', 'Closed', '10/01/2026')]));
      await onComplaintsRun(testEnv(), db, stub.client, watch_id, run({ result, steps: WITH_RECORD }));

      const stored = await storedFields(watch_id);
      expect(stored.discipline_flag).toBe(true);
      expect(stored.discipline_actions).toEqual(['2026041200 Closed 10/01/2026']);
      const events = await eventsOf(watch_id);
      expect(events.map((e) => e.kind)).toEqual(['unchanged']);
      expect(events[0].evidence.note).toContain('agent_answer_differs');
      expect(events[0].evidence.snapshot_id).toMatch(/^snap_/);
      expect((await snapshotsOf(watch_id))[0].reader_input).toBe('agent_html');
    });
  }

  it('tells the caller webhook about a run whose complaint page was not captured', async () => {
    const watch_id = await flaggedWatch();
    await db
      .prepare('UPDATE watches SET caller_webhook = ? WHERE watch_id = ?')
      .bind('https://caller.test/hook', watch_id)
      .run();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    try {
      await onComplaintsRun(
        testEnv(),
        db,
        stubClient().client,
        watch_id,
        run({ result: { complaints: [], complaint_view_opened: false, evidence_line: '' }, steps: WITH_RECORD }),
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)).toMatchObject({
        kind: 'check_failed',
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('reads the complaints and keeps the evidence line on the event when the view was opened', async () => {
    const watch_id = await insertWatch(db, {
      kind: 'record',
      registry: 'fl-dbpr',
      licence_number: 'CCC1234567',
      name: null,
      monitor_id: 'mon_proof2',
      caller_webhook: null,
    });
    const stub = stubClient();
    const opened = (complaints: unknown[], line: string) =>
      run({ result: { complaints, complaint_view_opened: true, evidence_line: line }, steps: WITH_RECORD });
    viewAfterRecord(stub, complaintView([], 'No complaints on file'));
    await onComplaintsRun(testEnv(), db, stub.client, watch_id, opened([], 'No complaints on file'));
    viewAfterRecord(stub, complaintView([viewRow('2026090009', 'Open', '11/01/2026')], '2026090009 Open 11/01/2026'));
    await onComplaintsRun(
      testEnv(),
      db,
      stub.client,
      watch_id,
      opened(
        [{ case_number: '2026090009', status: 'Open', date: '11/01/2026', description: 'x' }],
        '2026090009 Open 11/01/2026',
      ),
    );
    const events = await eventsOf(watch_id);
    expect(events.map((e) => e.kind)).toEqual(['status_change']);
    expect(events[0].evidence.line).toBe('2026090009 Open 11/01/2026');
    expect(events[0].evidence.snapshot_id).toMatch(/^snap_/);
  });

  it('keeps the evidence line when it appears on the captured page, whatever its spacing and case', async () => {
    const watch_id = await insertWatch(db, {
      kind: 'record',
      registry: 'fl-dbpr',
      licence_number: 'CCC1234567',
      name: null,
      monitor_id: 'mon_quote1',
      caller_webhook: null,
    });
    const stub = stubClient();
    const opened = (complaints: unknown[], line: string) =>
      run({ result: { complaints, complaint_view_opened: true, evidence_line: line }, steps: WITH_RECORD });
    viewAfterRecord(stub, complaintView());
    await onComplaintsRun(testEnv(), db, stub.client, watch_id, opened([], 'No complaints on file'));
    viewAfterRecord(
      stub,
      complaintView([viewRow('2026090009', 'Open', '11/01/2026')], '<p>2026090009   OPEN\n11/01/2026</p>'),
    );
    await onComplaintsRun(
      testEnv(),
      db,
      stub.client,
      watch_id,
      opened(
        [{ case_number: '2026090009', status: 'Open', date: '11/01/2026', description: 'x' }],
        '2026090009 Open 11/01/2026',
      ),
    );
    const [event] = await eventsOf(watch_id);
    expect(event.evidence.line).toBe('2026090009 Open 11/01/2026');
    expect(event.evidence.note ?? '').not.toContain('complaint_quote_unverified');
  });

  it('drops an evidence line that is not on the captured page and notes complaint_quote_unverified', async () => {
    const watch_id = await flaggedWatch();
    const stub = stubClient();
    viewAfterRecord(stub, complaintView([], 'Something else'));
    await onComplaintsRun(
      testEnv(),
      db,
      stub.client,
      watch_id,
      run({
        result: { complaints: [], complaint_view_opened: true, evidence_line: 'No complaints on file' },
        steps: WITH_RECORD,
      }),
    );
    const [event] = await eventsOf(watch_id);
    expect(event.kind).toBe('status_change');
    expect(event.evidence.line).toBeUndefined();
    expect(event.evidence.note).toContain('complaint_quote_unverified');
  });

  it('counts the complaints from the captured page: a run list of 1 against a page of 0 rows clears the complaints and notes agent_answer_differs', async () => {
    const watch_id = await flaggedWatch();
    const stub = stubClient();
    viewAfterRecord(stub, complaintView());
    await onComplaintsRun(
      testEnv(),
      db,
      stub.client,
      watch_id,
      run({
        result: {
          complaints: [{ case_number: '2026010001', status: 'Open', date: '10/30/2026', description: 'x' }],
          complaint_view_opened: true,
          evidence_line: '',
        },
        steps: WITH_RECORD,
      }),
    );
    expect((await storedFields(watch_id)).discipline_actions).toEqual([]);
    const events = await eventsOf(watch_id);
    expect(events.map((e) => e.kind)).toEqual(['status_change']);
    expect(events[0].evidence.note).toContain('agent_answer_differs');
  });

  it('is a failed check, with nothing changed, when the captured page is not the complaint view', async () => {
    const watch_id = await flaggedWatch();
    const stub = stubClient();
    stub.stepHtml.mockResolvedValue('<html><body>Licence page, no complaint view</body></html>');
    await onComplaintsRun(
      testEnv(),
      db,
      stub.client,
      watch_id,
      run({ result: { complaints: [], complaint_view_opened: true, evidence_line: '' }, steps: WITH_RECORD }),
    );
    expect((await storedFields(watch_id)).discipline_actions).toEqual(['2026041200 Closed 10/01/2026']);
    const events = await eventsOf(watch_id);
    expect(events.map((e) => e.kind)).toEqual(['check_failed']);
    expect(events[0].evidence.note).toContain('complaint page not captured');
  });

  it('raises check_failed, and drops the evidence line, when no page was captured', async () => {
    const watch_id = await flaggedWatch();
    const stub = stubClient();
    stub.stepHtml.mockRejectedValueOnce(new Error('capture failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await onComplaintsRun(
        testEnv(),
        db,
        stub.client,
        watch_id,
        run({
          result: { complaints: [], complaint_view_opened: true, evidence_line: 'No complaints on file' },
          steps: WITH_RECORD,
        }),
      );
    } finally {
      warn.mockRestore();
    }
    const [event] = await eventsOf(watch_id);
    expect(event.kind).toBe('check_failed');
    expect(event.evidence.line).toBeUndefined();
    expect(event.evidence.note).toContain('complaints_not_checked');
  });

  it('keeps the last step page as an agent_html snapshot with its run and step ids', async () => {
    const watch_id = await flaggedWatch();
    const stub = stubClient();
    const finished = run({
      run_id: 'run_proof',
      result: { complaints: [], complaint_view_opened: true, evidence_line: 'x' },
      steps: [{ step_id: 'a' }, { step_id: 'last' }],
    });
    await onComplaintsRun(testEnv(), db, stub.client, watch_id, finished);
    expect(stub.stepHtml).toHaveBeenCalledWith('run_proof', 'last');
    const [snap] = await snapshotsOf(watch_id);
    expect(snap).toEqual({ reader_input: 'agent_html', body: page('mqa-clear'), run_id: 'run_proof', step_id: 'last' });
  });

  it('reads the complaint page from the last step that has a capture, and counts complaints as not checked when none has', async () => {
    const watch_id = await flaggedWatch();
    const stub = stubClient();
    const result = { complaints: [], complaint_view_opened: true, evidence_line: 'No complaints on file' };
    const steps = [
      { step_id: 'a', has_html: true, has_screenshot: true },
      { step_id: 'done', has_html: false, has_screenshot: false },
    ];
    await onComplaintsRun(testEnv(), db, stub.client, watch_id, run({ run_id: 'run_cap', result, steps }));
    expect(stub.stepHtml).toHaveBeenCalledTimes(1);
    expect(stub.stepHtml).toHaveBeenCalledWith('run_cap', 'a');

    stub.stepHtml.mockClear();
    const other = await flaggedWatch();
    await onComplaintsRun(
      testEnv(),
      db,
      stub.client,
      other,
      run({ run_id: 'run_none', result, steps: [{ step_id: 'done', has_html: false, has_screenshot: false }] }),
    );
    expect(stub.stepHtml).not.toHaveBeenCalled();
    const [event] = await eventsOf(other);
    expect(event.kind).toBe('check_failed');
    expect(event.evidence.line).toBeUndefined();
    expect(event.evidence.note).toContain('complaints_not_checked');
  });

  it('walks back past a 404 step and keeps the page it finds with that step id', async () => {
    const watch_id = await flaggedWatch();
    const stub = stubClient();
    stub.stepHtml.mockImplementation(async (_run: string, step: string) => {
      if (step === 'c') throw new TinyFishError('not_found', 404, 'gone');
      return page('mqa-clear');
    });
    const steps = [{ step_id: 'b' }, { step_id: 'c' }, { step_id: 'done', has_html: false }];
    await onComplaintsRun(
      testEnv(),
      db,
      stub.client,
      watch_id,
      run({ run_id: 'run_w', result: { complaints: [], complaint_view_opened: true, evidence_line: 'x' }, steps }),
    );
    expect(stub.stepHtml.mock.calls.map((c) => c[1])).toEqual(['c', 'b']);
    expect((await snapshotsOf(watch_id))[0]).toMatchObject({ run_id: 'run_w', step_id: 'b', body: page('mqa-clear') });
  });

  it('stores and forwards nothing about discipline when no page could be read', async () => {
    const watch_id = await flaggedWatch();
    await db
      .prepare('UPDATE watches SET caller_webhook = ? WHERE watch_id = ?')
      .bind('https://caller.test/hook', watch_id)
      .run();
    const stub = stubClient();
    stub.stepHtml.mockRejectedValue(new TinyFishError('not_found', 404, 'gone'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await onComplaintsRun(
        testEnv(),
        db,
        stub.client,
        watch_id,
        run({
          result: { complaints: [], complaint_view_opened: true, evidence_line: 'No complaints on file' },
          steps: WITH_RECORD,
        }),
      );
      const events = await eventsOf(watch_id);
      expect(events.map((e) => e.kind)).toEqual(['check_failed']);
      expect(events[0].evidence.note).toContain('complaints_not_checked');
      expect(JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)).toMatchObject({
        kind: 'check_failed',
      });
    } finally {
      fetchSpy.mockRestore();
      warn.mockRestore();
    }
    const stored = await storedFields(watch_id);
    expect(stored.discipline_flag).toBe(true);
    expect(stored.discipline_actions).toEqual(['2026041200 Closed 10/01/2026']);
  });

  it.each([
    ['a text', 'none'],
    ['null', null],
    ['an object', {}],
    ['missing', undefined],
  ])(
    'takes the page answer of 0 rows, with agent_answer_differs, when the run answered complaints as %s',
    async (_label, value) => {
      const watch_id = await flaggedWatch();
      const stub = stubClient();
      viewAfterRecord(stub, complaintView());
      const result: Record<string, unknown> = { complaint_view_opened: true, evidence_line: 'No complaints on file' };
      if (value !== undefined) result.complaints = value;
      await onComplaintsRun(testEnv(), db, stub.client, watch_id, run({ result, steps: WITH_RECORD }));
      const events = await eventsOf(watch_id);
      expect(events.map((e) => e.kind)).toEqual(['status_change']);
      expect(events[0].evidence.note).toContain('agent_answer_differs');
      expect((await storedFields(watch_id)).discipline_flag).toBe(false);
    },
  );

  it('keeps the run result as the snapshot and says so on the event when the page capture fails', async () => {
    const watch_id = await flaggedWatch();
    const stub = stubClient();
    stub.stepHtml.mockRejectedValueOnce(new Error('capture failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = { complaints: [], complaint_view_opened: true, evidence_line: 'No complaints on file' };
    try {
      await expect(
        onComplaintsRun(testEnv(), db, stub.client, watch_id, run({ result, steps: WITH_RECORD })),
      ).resolves.toBeUndefined();
    } finally {
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    }
    const [snap] = await snapshotsOf(watch_id);
    expect(snap.reader_input).toBe('agent_html');
    expect(JSON.parse(snap.body)).toEqual(result);
    // The agent said none on file, but no page backs it: a failed check, and the stored complaints stay as they were.
    const events = await eventsOf(watch_id);
    expect(events.map((e) => e.kind)).toEqual(['check_failed']);
    expect(events[0].evidence.note).toContain('page not captured');
    expect((await storedFields(watch_id)).discipline_flag).toBe(true);
  });

  it('keeps the run result as the snapshot when the run has no steps to capture', async () => {
    const watch_id = await flaggedWatch();
    const result = { complaints: [], complaint_view_opened: false, evidence_line: '' };
    await onComplaintsRun(testEnv(), db, stubClient().client, watch_id, run({ result, steps: [] }));
    const [snap] = await snapshotsOf(watch_id);
    expect(JSON.parse(snap.body)).toEqual(result);
    expect(snap.step_id).toBeNull();
  });
});

describe('onComplaintsRun reads the captured page with two readers', () => {
  const views = import.meta.glob('./fixtures/fl-dbpr/complaints/*.html', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;
  const view = (name: string): string => Object.entries(views).find(([k]) => k.endsWith(`/${name}`))?.[1] ?? '';
  const threeRows = view('complaint-view.real-three-rows.html');
  const THREE_ACTIONS = [
    '2000000001 Set for Board Presentation 05/05/2026',
    '2000000002 Closed 04/11/2025',
    '2000000003 Ready for Collections 04/11/2023',
  ];
  const answer = (over: Record<string, unknown> = {}, steps: { step_id: string }[] = WITH_RECORD) =>
    run({ result: { complaints: [], complaint_view_opened: true, evidence_line: '', ...over }, steps });
  const watchWith = async (actions: string[], webhook: string | null = null): Promise<string> => {
    const watch_id = await insertWatch(db, {
      kind: 'record',
      registry: 'fl-dbpr',
      licence_number: 'CCC1234567',
      name: null,
      monitor_id: `mon_${crypto.randomUUID()}`,
      caller_webhook: webhook,
    });
    await updateWatchFields(db, watch_id, {
      ...baseline,
      discipline_flag: actions.length > 0,
      discipline_actions: actions,
    } as Fields);
    return watch_id;
  };
  const storedActions = async (watch_id: string): Promise<string[]> =>
    (JSON.parse((await getWatch(db, watch_id))?.last_fields_json ?? 'null') as Fields).discipline_actions;

  it('reads 3 complaints from the real view although the run said it did not open it and listed none', async () => {
    const watch_id = await watchWith([]);
    const stub = stubClient();
    viewAfterRecord(stub, threeRows);
    await onComplaintsRun(testEnv(), db, stub.client, watch_id, answer({ complaint_view_opened: false }));
    const events = await eventsOf(watch_id);
    expect(events.map((e) => e.kind)).toEqual(['status_change']);
    expect(events[0].after).toMatchObject({ discipline_flag: true, discipline_actions: THREE_ACTIONS });
    expect(events[0].evidence.note).toContain('agent_answer_differs');
    expect(await storedActions(watch_id)).toEqual(THREE_ACTIONS);
  });

  it('reads none on file from the clean view when the run opened it and listed none, with no agent_answer_differs', async () => {
    const watch_id = await watchWith([]);
    const stub = stubClient();
    viewAfterRecord(stub, view('complaint-view.clean.html'));
    await onComplaintsRun(testEnv(), db, stub.client, watch_id, answer());
    const events = await eventsOf(watch_id);
    expect(events.map((e) => e.kind)).toEqual(['unchanged']);
    expect(events[0].evidence.note ?? '').not.toContain('agent_answer_differs');
  });

  it('finds the complaint view one step before a record page that the run ended on', async () => {
    const watch_id = await watchWith([]);
    const stub = stubClient();
    const pages: Record<string, string> = { rec: recordPage, a: threeRows, b: page('mqa-clear') };
    stub.stepHtml.mockImplementation(async (_run: string, step: string) => pages[step]);
    await onComplaintsRun(
      testEnv(),
      db,
      stub.client,
      watch_id,
      answer({}, [{ step_id: 'rec' }, { step_id: 'a' }, { step_id: 'b' }]),
    );
    expect((await eventsOf(watch_id)).map((e) => e.kind)).toEqual(['status_change']);
    expect(await storedActions(watch_id)).toEqual(THREE_ACTIONS);
  });

  it('is a failed check, with complaint page not captured, when none of the last 4 snapshots is the complaint view', async () => {
    const watch_id = await watchWith(THREE_ACTIONS);
    const stub = stubClient();
    stub.stepHtml.mockImplementation(async (_run: string, step: string) =>
      step === 'first' ? threeRows : page('mqa-clear'),
    );
    const steps = ['first', 'a', 'b', 'c', 'd'].map((step_id) => ({ step_id }));
    await onComplaintsRun(testEnv(), db, stub.client, watch_id, answer({}, steps));
    expect(stub.stepHtml.mock.calls.map((c) => c[1])).toEqual(['d', 'c', 'b', 'a']);
    const events = await eventsOf(watch_id);
    expect(events.map((e) => e.kind)).toEqual(['check_failed']);
    expect(events[0].evidence.note).toContain('complaint page not captured');
    expect(await storedActions(watch_id)).toEqual(THREE_ACTIONS);
  });

  it('is a failed check, with complaint_readers_disagree, when the two readers count different rows', async () => {
    const watch_id = await watchWith([]);
    const stub = stubClient();
    viewAfterRecord(stub, threeRows.replace('2000000002', 'not a case number'));
    await onComplaintsRun(testEnv(), db, stub.client, watch_id, answer());
    const events = await eventsOf(watch_id);
    expect(events.map((e) => e.kind)).toEqual(['check_failed']);
    expect(events[0].evidence.note).toContain('complaint_readers_disagree');
    expect(events[0].evidence.note).toContain('complaints_not_checked');
    expect(await storedActions(watch_id)).toEqual([]);
  });

  it('is a failed check when the complaint view ends before its footer', async () => {
    const watch_id = await watchWith([]);
    const stub = stubClient();
    viewAfterRecord(stub, threeRows.slice(0, threeRows.indexOf('<footer')));
    await onComplaintsRun(testEnv(), db, stub.client, watch_id, answer());
    const events = await eventsOf(watch_id);
    expect(events.map((e) => e.kind)).toEqual(['check_failed']);
    expect(events[0].evidence.note).toContain('complaint page not captured');
  });

  it('writes one unchanged event with the snapshot id, and posts nothing to the caller, when the checked complaints are unchanged', async () => {
    const watch_id = await watchWith(THREE_ACTIONS, 'https://caller.test/hook');
    const stub = stubClient();
    viewAfterRecord(stub, threeRows);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    try {
      await onComplaintsRun(
        testEnv(),
        db,
        stub.client,
        watch_id,
        answer({
          complaints: THREE_ACTIONS.map((a) => ({
            case_number: a.slice(0, 10),
            status: '',
            date: '',
            description: '',
          })),
        }),
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
    const events = await eventsOf(watch_id);
    expect(events.map((e) => e.kind)).toEqual(['unchanged']);
    const snap = await db
      .prepare('SELECT snapshot_id FROM snapshots WHERE watch_id = ?')
      .bind(watch_id)
      .first<{ snapshot_id: string }>();
    expect(events[0].evidence.snapshot_id).toBe(snap?.snapshot_id);
  });

  it('writes check_failed and no unchanged event when the run ends not checked', async () => {
    const watch_id = await watchWith(THREE_ACTIONS);
    const stub = stubClient();
    stub.stepHtml.mockResolvedValue(page('mqa-clear'));
    await onComplaintsRun(testEnv(), db, stub.client, watch_id, answer());
    expect((await eventsOf(watch_id)).map((e) => e.kind)).toEqual(['check_failed']);
  });

  describe('the complaint view must belong to the watched licence', () => {
    const resultsList = Object.entries(
      import.meta.glob('./fixtures/fl-dbpr/results/results-number.snapshot.html', {
        query: '?raw',
        import: 'default',
        eager: true,
      }) as Record<string, string>,
    )[0][1];
    const otherRecord = recordPage.replaceAll('CCC1234567', 'CCC7654321');
    const ids = (...names: string[]) => names.map((step_id) => ({ step_id }));
    // Serves each step its page, and the view for the step named "view".
    const serve = (stub: ReturnType<typeof stubClient>, pages: Record<string, string>) =>
      stub.stepHtml.mockImplementation(async (_run: string, step: string) => pages[step] ?? 'licence page');

    async function expectRefused(
      watch_id: string,
      over: Record<string, unknown>,
      stub: ReturnType<typeof stubClient>,
      steps: { step_id: string }[],
    ): Promise<void> {
      await onComplaintsRun(testEnv(), db, stub.client, watch_id, answer(over, steps));
      const events = await eventsOf(watch_id);
      expect(events.map((e) => e.kind)).toEqual(['check_failed']);
      expect(events[0].evidence.note).toContain('complaint page not tied to the licence');
      expect(events[0].evidence.note).toContain('complaints_not_checked');
      expect(await storedActions(watch_id)).toEqual(THREE_ACTIONS.slice(0, 1));
      const snap = await db
        .prepare('SELECT body, step_id FROM snapshots WHERE watch_id = ?')
        .bind(watch_id)
        .first<{ body: string; step_id: string | null }>();
      expect(JSON.parse(snap?.body ?? 'null')).toMatchObject({ complaint_view_opened: true });
      expect(snap?.step_id).toBeNull();
    }

    it('accepts the view after the record page of the watched licence although the run said it did not open it', async () => {
      const watch_id = await watchWith([]);
      const stub = stubClient();
      serve(stub, { rec: recordPage, view: threeRows });
      await onComplaintsRun(
        testEnv(),
        db,
        stub.client,
        watch_id,
        answer({ complaint_view_opened: false }, ids('rec', 'view')),
      );
      expect((await eventsOf(watch_id)).map((e) => e.kind)).toEqual(['status_change']);
      expect(await storedActions(watch_id)).toEqual(THREE_ACTIONS);
    });

    it('refuses the view after the record page of a different licence number and leaves the stored fields alone', async () => {
      const watch_id = await watchWith(THREE_ACTIONS.slice(0, 1));
      const stub = stubClient();
      serve(stub, { other: otherRecord, view: threeRows });
      await expectRefused(watch_id, {}, stub, ids('other', 'view'));
    });

    it('refuses the view when a results list lies between the record page and the view', async () => {
      const watch_id = await watchWith(THREE_ACTIONS.slice(0, 1));
      const stub = stubClient();
      serve(stub, { rec: recordPage, results: resultsList, view: threeRows });
      await expectRefused(watch_id, {}, stub, ids('rec', 'results', 'view'));
    });

    it('refuses the view when no snapshot before it is a record page', async () => {
      const watch_id = await watchWith(THREE_ACTIONS.slice(0, 1));
      const stub = stubClient();
      serve(stub, { view: threeRows });
      await expectRefused(watch_id, {}, stub, ids('a', 'b', 'view'));
    });

    it('reads only the nearest snapshot that has a capture, and refuses when that one is not the licence page', async () => {
      const watch_id = await watchWith(THREE_ACTIONS.slice(0, 1));
      const stub = stubClient();
      serve(stub, { rec: recordPage, view: threeRows });
      await expectRefused(watch_id, {}, stub, ids('rec', 'a', 'b', 'view'));
      expect(stub.stepHtml.mock.calls.map((c) => c[1])).toEqual(['view', 'b']);
    });

    it('refuses the view when the snapshot just before it answers 404, although the record page lies before that', async () => {
      const watch_id = await watchWith(THREE_ACTIONS.slice(0, 1));
      const stub = stubClient();
      stub.stepHtml.mockImplementation(async (_run: string, step: string) => {
        if (step === 'gap') throw new TinyFishError('not_found', 404, 'gone');
        return step === 'rec' ? recordPage : threeRows;
      });
      await expectRefused(watch_id, {}, stub, ids('rec', 'gap', 'view'));
    });

    it('refuses the view when a step between the record page and the view has no capture, and reads nothing past it', async () => {
      const watch_id = await watchWith(THREE_ACTIONS.slice(0, 1));
      const stub = stubClient();
      serve(stub, { rec: recordPage, view: threeRows });
      await expectRefused(watch_id, {}, stub, [
        { step_id: 'rec' },
        { step_id: 'a', has_html: false } as { step_id: string },
        { step_id: 'view' },
      ]);
      expect(stub.stepHtml.mock.calls.map((c) => c[1])).toEqual(['view']);
    });

    // Seen on live runs: the agent stays on the complaint view for several steps.
    it('accepts the view when earlier captures of the same view lie between it and the record page', async () => {
      const watch_id = await watchWith([]);
      const stub = stubClient();
      serve(stub, { rec: recordPage, v1: threeRows, v2: threeRows, view: threeRows });
      await onComplaintsRun(testEnv(), db, stub.client, watch_id, answer({}, ids('rec', 'v1', 'v2', 'view')));
      expect(stub.stepHtml.mock.calls.map((c) => c[1])).toEqual(['view', 'v2', 'v1', 'rec']);
      expect(await storedActions(watch_id)).toEqual(THREE_ACTIONS);
    });
  });

  it('writes its change event and no unchanged event when the checked complaints changed', async () => {
    const watch_id = await watchWith(THREE_ACTIONS.slice(0, 2));
    const stub = stubClient();
    viewAfterRecord(stub, threeRows);
    await onComplaintsRun(testEnv(), db, stub.client, watch_id, answer({ complaints: [{}, {}, {}] }));
    expect((await eventsOf(watch_id)).map((e) => e.kind)).toEqual(['status_change']);
  });
});

describe('free daily re-read of a Florida watch', () => {
  it('reads the record page inline, raises status_change, and runs once a day', async () => {
    await upsertKey(db, 'fl-mqa', 'ME000000', { licInd: '111', proCde: '22' });
    const watch_id = await insertWatch(db, {
      kind: 'record',
      registry: 'fl-mqa',
      licence_number: 'ME000000',
      name: null,
      monitor_id: 'mon_reread',
      caller_webhook: null,
    });
    await updateWatchFields(db, watch_id, baseline);
    await setWatchTier(db, watch_id, 'recheck');
    const stub = stubClient();
    stub.fetchPages.mockResolvedValueOnce({ results: [{ text: page('mqa-null-void') }], errors: [] });

    expect(await enqueueRechecks(testEnv(), db, new Date('2026-11-03T12:00:00.000Z'), stub.client)).toBe(1);
    expect(stub.fetchPages).toHaveBeenCalledTimes(1);
    expect((stub.fetchPages.mock.calls[0][0] as string[])[0]).toContain('LicInd=111');
    expect(stub.fetchPages.mock.calls[0][1]).toMatchObject({ ttl: 0 });
    const events = await eventsOf(watch_id);
    expect(events.map((e) => e.kind)).toEqual(['status_change']);
    expect(events[0].after).toMatchObject({ status: 'inactive' });

    expect(await enqueueRechecks(testEnv(), db, new Date('2026-11-03T13:00:00.000Z'), stub.client)).toBe(0);
    expect(stub.fetchPages).toHaveBeenCalledTimes(1);
  });

  it('a re-read on another licence number raises licence_number_mismatch and stores nothing', async () => {
    await upsertKey(db, 'fl-mqa', 'ME000000', { licInd: '111', proCde: '22' });
    const watch_id = await insertWatch(db, {
      kind: 'record',
      registry: 'fl-mqa',
      licence_number: 'ME000000',
      name: null,
      monitor_id: 'mon_reread2',
      caller_webhook: null,
    });
    await updateWatchFields(db, watch_id, baseline);
    await setWatchTier(db, watch_id, 'recheck');
    const stub = stubClient();
    stub.fetchPages.mockResolvedValueOnce({
      results: [{ text: page('mqa-null-void').replaceAll('ME000000', 'ME000999') }],
      errors: [],
    });
    await enqueueRechecks(testEnv(), db, new Date('2026-11-03T12:00:00.000Z'), stub.client);
    const events = await eventsOf(watch_id);
    expect(events.map((e) => e.kind)).toEqual(['check_failed']);
    expect(events[0].evidence.note).toBe('licence_number_mismatch');
    expect(JSON.parse((await getWatch(db, watch_id))?.last_fields_json ?? 'null')).toEqual(baseline);
  });
});

describe('resolveWatchFromSearch reads the record before it stores a key', () => {
  it('stores no key and creates no Monitor when the record page is another licence number', async () => {
    const stub = stubClient();
    const created = await createRecordWatch(testEnv(), db, stub.client, 'fl-mqa', 'ME000000');
    stub.fetchPages.mockResolvedValueOnce({
      results: [{ text: page('mqa-clear').replaceAll('ME000000', 'ME000999') }],
      errors: [],
    });
    const job: Job = {
      job_id: 'job_mismatch',
      kind: 'search',
      priority: 2,
      bucket: 'ops',
      reserved_cents: 0,
      payload: { watch_id: created.watch_id, registry: 'fl-mqa', request: { url: 'https://x.test', goal: 'g' } },
    };
    const found = run({
      status: 'COMPLETED',
      result: {
        rows: [
          {
            licence_number: 'ME000000',
            name: 'SAMPLE, PERSON A',
            profession: 'Medical Doctor',
            city: 'SAMPLE CITY',
            status_raw: 'Clear/Active',
            link_url: 'LicenseVerification?LicInd=111&ProCde=22',
          },
        ],
      },
    });
    await resolveWatchFromSearch(testEnv(), db, stub.client, job, found);
    expect(stub.fetchPages).toHaveBeenCalledTimes(1);
    expect(stub.createMonitor).not.toHaveBeenCalled();
    expect(await getKey(db, 'fl-mqa', 'ME000000')).toBeNull();
    const events = await eventsOf(created.watch_id);
    expect(events.map((e) => e.evidence.note)).toEqual(['licence_number_mismatch']);
  });
});

describe('resolveWatchFromSearch and a registry that did not answer', () => {
  const noteFor = async (result: unknown): Promise<string | undefined> => {
    const stub = stubClient();
    const created = await createRecordWatch(testEnv(), db, stub.client, 'fl-mqa', 'ME000000');
    const job: Job = {
      job_id: 'job_unanswered',
      kind: 'search',
      priority: 2,
      bucket: 'ops',
      reserved_cents: 0,
      payload: { watch_id: created.watch_id, registry: 'fl-mqa', request: { url: 'https://x.test', goal: 'g' } },
    };
    await resolveWatchFromSearch(testEnv(), db, stub.client, job, run({ status: 'COMPLETED', result }));
    expect(stub.createMonitor).not.toHaveBeenCalled();
    return (await eventsOf(created.watch_id)).map((e) => e.evidence.note)[0];
  };

  it('says the registry did not answer for an error, a captcha, a sign-in, and an answer that cannot be read', async () => {
    expect(await noteFor({ page: 'error', found: false, url: null, rows: [], total: 0 })).toContain(
      'did not answer (timeout)',
    );
    expect(await noteFor({ page: 'captcha', found: false, url: null, rows: [], total: 0 })).toContain(
      'did not answer (captcha)',
    );
    expect(await noteFor({ page: 'sign_in', found: false, url: null, rows: [], total: 0 })).toContain(
      'did not answer (login_required)',
    );
    expect(await noteFor({ found: true, url: 'https://elsewhere.test/x', rows: [], total: 0 })).toContain(
      'did not answer (layout_changed)',
    );
  });

  it('keeps the not-returned wording when the registry itself says there are no results', async () => {
    expect(await noteFor({ page: 'none', found: false, url: null, rows: [], total: 0 })).toContain(
      'did not return this licence number',
    );
  });
});

describe('complaint comparison owns only the discipline fields', () => {
  it('a complaint change leaves the Monitor fields alone', async () => {
    const watch_id = await insertWatch(db, {
      kind: 'record',
      registry: 'fl-dbpr',
      licence_number: 'CCC1234567',
      name: null,
      monitor_id: 'mon_dbpr_fields',
      caller_webhook: null,
    });
    await updateWatchFields(db, watch_id, { ...baseline, status: 'active', status_raw: 'Clear/Active' } as Fields);
    const stub = stubClient();
    viewAfterRecord(stub, complaintView([viewRow('2026010001', 'Open', '10/30/2026')]));
    await onComplaintsRun(
      testEnv(),
      db,
      stub.client,
      watch_id,
      run({
        steps: WITH_RECORD,
        result: {
          complaints: [{ case_number: '2026010001', status: 'Open', date: '10/30/2026', description: 'x' }],
          complaint_view_opened: true,
          evidence_line: '2026010001 Open 10/30/2026',
        },
      }),
    );
    const [event] = await eventsOf(watch_id);
    expect(event.kind).toBe('status_change');
    expect(Object.keys(event.before ?? {}).sort()).toEqual(['discipline_actions', 'discipline_flag']);
    const stored = JSON.parse((await getWatch(db, watch_id))?.last_fields_json ?? 'null') as Fields;
    expect(stored.status).toBe('active');
    expect(stored.discipline_actions).toEqual(['2026010001 Open 10/30/2026']);
  });
});

describe('re-check cap and the shared ceiling', () => {
  it('starts at most ten re-checks per run, oldest watches first', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      ids.push(
        await insertWatch(db, {
          kind: 'record',
          registry: 'ca-cslb',
          licence_number: String(10000000 + i),
          name: null,
          monitor_id: null,
          caller_webhook: null,
        }),
      );
    }
    expect(await enqueueRechecks(testEnv(), db, new Date('2026-11-03T12:00:00.000Z'))).toBe(10);
    const queued = (await queueRows('recheck')).map((r) => JSON.parse(r.payload_json ?? 'null').watch_id as string);
    expect(queued.sort()).toEqual(ids.slice(0, 10).sort());
  });

  it('counts re-check tier watches toward the same ceiling', async () => {
    for (let i = 0; i < 30; i += 1) {
      await insertWatch(db, {
        kind: 'record',
        registry: 'ca-cslb',
        licence_number: String(20000000 + i),
        name: null,
        monitor_id: null,
        caller_webhook: null,
      });
    }
    const stub = stubClient();
    await expect(createRecordWatch(testEnv(), db, stub.client, 'ca-cslb', '123456')).rejects.toBeInstanceOf(WatchLimit);
  });
});

describe('a missing discipline flag reads as false', () => {
  it('a DBPR baseline from createRecordWatch, a quiet Monitor read and a quiet complaint week raise no status_change', async () => {
    await upsertKey(db, 'fl-dbpr', 'CCC0000000', { id: '0'.repeat(32) });
    const stub = stubClient();
    // The baseline is read from the DBPR live page, whose parsers give a null discipline flag.
    stub.createMonitor.mockResolvedValueOnce({
      monitor: { id: 'mon_dbpr_flag' },
      run: { id: 'run_dbpr_base', results: [{ text: page('dbpr-live') }], errors: [] as unknown[] },
    });
    const created = await createRecordWatch(testEnv(), db, stub.client, 'fl-dbpr', 'CCC0000000');
    expect(created.tier).toBe('monitor');
    const watch_id = created.watch_id;
    const baselineStored = JSON.parse((await getWatch(db, watch_id))?.last_fields_json ?? 'null') as Fields;
    expect(baselineStored.discipline_flag).toBe(false);

    await onMonitorWebhook(testEnv(), db, stub.client, hook('mon_dbpr_flag', page('dbpr-live')));
    await onComplaintsRun(
      testEnv(),
      db,
      stub.client,
      watch_id,
      run({
        steps: [{ step_id: 'quiet' }],
        result: { complaints: [], complaint_view_opened: true, evidence_line: 'No complaints on file' },
      }),
    );
    expect((await eventsOf(watch_id)).filter((e) => e.kind === 'status_change')).toHaveLength(0);
    const stored = JSON.parse((await getWatch(db, watch_id))?.last_fields_json ?? 'null') as Fields;
    expect(stored.discipline_flag).toBe(false);
  });
});

describe('a Monitor baseline on another licence number', () => {
  it('raises licence_number_mismatch instead of dropping the baseline silently', async () => {
    await upsertKey(db, 'fl-mqa', 'ME000000', { licInd: '111', proCde: '22' });
    const stub = stubClient();
    stub.createMonitor.mockResolvedValueOnce({
      monitor: { id: 'mon_bad_base' },
      run: {
        id: 'run_bad_base',
        results: [{ text: page('mqa-clear').replaceAll('ME000000', 'ME000999') }],
        errors: [] as unknown[],
      },
    });
    const created = await createRecordWatch(testEnv(), db, stub.client, 'fl-mqa', 'ME000000');
    expect(created.tier).toBe('monitor');
    const events = await eventsOf(created.watch_id);
    expect(events.map((e) => e.evidence.note)).toEqual(['licence_number_mismatch']);
    expect((await getWatch(db, created.watch_id))?.last_fields_json).toBeNull();
    // The Monitor on the wrong page is deleted, and the watch is left without one.
    expect(stub.deleteMonitor).toHaveBeenCalledWith('mon_bad_base');
    expect((await getWatch(db, created.watch_id))?.monitor_id).toBeNull();
  });
});

describe('re-check ordering', () => {
  it('re-checks every one of twelve watches within three daily runs', async () => {
    const base = Date.now();
    for (let i = 0; i < 12; i += 1) {
      await insertWatch(db, {
        kind: 'record',
        registry: 'ca-cslb',
        licence_number: String(30000000 + i),
        name: null,
        monitor_id: null,
        caller_webhook: null,
      });
    }
    const checked = new Set<string>();
    for (const day of [0, 1, 2]) {
      await enqueueRechecks(testEnv(), db, new Date(base + day * 24 * 3_600_000));
    }
    for (const row of await queueRows('recheck')) {
      checked.add(JSON.parse(row.payload_json ?? 'null').watch_id as string);
    }
    expect(checked.size).toBe(12);
  });
});

describe('weekly complaint runs are ordered', () => {
  it('gives each of twelve DBPR watches a complaint run within three Mondays', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const licence = `CCC${String(4000000 + i)}`;
      await upsertKey(db, 'fl-dbpr', licence, { id: String(i).padStart(32, '0') });
      ids.push(
        await insertWatch(db, {
          kind: 'record',
          registry: 'fl-dbpr',
          licence_number: licence,
          name: null,
          monitor_id: null,
          caller_webhook: null,
        }),
      );
    }
    // The next Monday after today, then the two Mondays after it.
    const today = new Date();
    const add = (8 - today.getUTCDay()) % 7 || 7;
    const firstMonday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + add, 12);
    for (const week of [0, 1, 2]) {
      await enqueueRechecks(testEnv(), db, new Date(firstMonday + week * 7 * 24 * 3_600_000));
    }
    const runs = (await queueRows('recheck_complaints')).map(
      (r) => JSON.parse(r.payload_json ?? 'null').watch_id as string,
    );
    for (const id of ids) expect(runs).toContain(id);
  });
});

describe('weekly complaint runs and watches with no record link', () => {
  const monday = new Date('2026-11-09T12:00:00Z');
  const week = 7 * 24 * 3_600_000;

  async function dbprWatch(n: number, linked: boolean): Promise<string> {
    const licence = `CCC${String(5000000 + n)}`;
    if (linked) await upsertKey(db, 'fl-dbpr', licence, { id: String(n).padStart(32, '0') });
    return insertWatch(db, {
      kind: 'record',
      registry: 'fl-dbpr',
      licence_number: licence,
      name: null,
      monitor_id: null,
      caller_webhook: null,
    });
  }

  it('gives all ten linked watches a run when three linkless watches come first in line', async () => {
    const linkless = [await dbprWatch(1, false), await dbprWatch(2, false), await dbprWatch(3, false)];
    const linked: string[] = [];
    for (let i = 10; i < 20; i += 1) linked.push(await dbprWatch(i, true));
    await enqueueRechecks(testEnv(), db, monday);
    const runs = (await queueRows('recheck_complaints')).map(
      (r) => JSON.parse(r.payload_json ?? 'null').watch_id as string,
    );
    expect(runs.sort()).toEqual([...linked].sort());
    for (const id of linkless) expect(runs).not.toContain(id);
  });

  it('gives a linkless watch a check_failed event with the note no record link yet, once a week', async () => {
    const id = await dbprWatch(1, false);
    await enqueueRechecks(testEnv(), db, monday);
    await enqueueRechecks(testEnv(), db, new Date(monday.getTime() + 3_600_000));
    let events = await eventsOf(id);
    expect(events.map((e) => [e.kind, e.evidence.note])).toEqual([['check_failed', 'no record link yet']]);
    await enqueueRechecks(testEnv(), db, new Date(monday.getTime() + week));
    events = await eventsOf(id);
    expect(events.map((e) => e.evidence.note)).toEqual(['no record link yet', 'no record link yet']);
  });

  it('notes at most five linkless watches in one call, and the rest on the next call', async () => {
    const linkless: string[] = [];
    for (let i = 1; i <= 8; i += 1) linkless.push(await dbprWatch(i, false));
    const linked: string[] = [];
    for (let i = 10; i < 20; i += 1) linked.push(await dbprWatch(i, true));
    const noted = async (): Promise<string[]> => {
      const out: string[] = [];
      for (const id of linkless) if ((await eventsOf(id)).length > 0) out.push(id);
      return out;
    };

    await enqueueRechecks(testEnv(), db, monday);
    const first = await noted();
    expect(first).toHaveLength(5);
    const runs = (await queueRows('recheck_complaints')).map(
      (r) => JSON.parse(r.payload_json ?? 'null').watch_id as string,
    );
    expect(runs.sort()).toEqual([...linked].sort());

    await enqueueRechecks(testEnv(), db, new Date(monday.getTime() + 60_000));
    const second = await noted();
    expect(second).toHaveLength(8);
    for (const id of first) expect(await eventsOf(id)).toHaveLength(1);
    for (const id of linkless) expect((await eventsOf(id)).map((e) => e.evidence.note)).toEqual(['no record link yet']);
  });

  it('does not post linkless notices to caller webhooks inside the scheduled run', async () => {
    const id = await dbprWatch(1, false);
    await db
      .prepare('UPDATE watches SET caller_webhook = ? WHERE watch_id = ?')
      .bind('https://caller.test/hook', id)
      .run();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    try {
      await enqueueRechecks(testEnv(), db, monday);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
    expect(await eventsOf(id)).toHaveLength(1);
  });

  it('writes no linkless event on a day that is not Monday', async () => {
    const id = await dbprWatch(1, false);
    await enqueueRechecks(testEnv(), db, new Date('2026-11-10T12:00:00Z'));
    expect(await eventsOf(id)).toEqual([]);
  });
});

// A new contractor watch finds its record link the way a lookup does: the record page the search opens, the row on the
// results list in the run's snapshot, or one run that copies the rows.
describe('the key search of a new contractor watch', () => {
  const LICENCE = 'CBC0000001';
  const RECORD_URL = `https://www.myfloridalicense.com/LicenseDetail.asp?SID=&id=${'0'.repeat(31)}1`;
  const record = recordPage.replaceAll('CCC1234567', LICENCE);
  const resultsList = Object.values(
    import.meta.glob('./fixtures/fl-dbpr/results/results-number.snapshot.html', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>,
  )[0];
  const noCapture: RunStep[] = ['s1', 's2', 's3'].map((step_id) => ({
    step_id,
    has_html: false,
    has_screenshot: false,
  }));
  const captured: RunStep[] = [
    { step_id: 's1', has_html: true, has_screenshot: false },
    { step_id: 's2', has_html: false, has_screenshot: false },
  ];

  async function pendingWatch(
    licence = LICENCE,
  ): Promise<{ stub: ReturnType<typeof stubClient>; watch_id: string; job: Job }> {
    const stub = stubClient();
    stub.fetchPages.mockResolvedValue({ results: [{ text: record }], errors: [] });
    stub.createMonitor.mockResolvedValue({
      monitor: { id: 'mon_new' },
      run: { id: 'run_base', results: [{ text: record }], errors: [] },
    });
    const created = await createRecordWatch(testEnv(), db, stub.client, 'fl-dbpr', licence);
    return { stub, watch_id: created.watch_id, job: await lastSearchJob() };
  }
  // The search jobs in the order they were queued.
  async function searchPayloads(): Promise<Job['payload'][]> {
    const { results } = await db
      .prepare("SELECT payload_json FROM queue WHERE kind = 'search' ORDER BY rowid")
      .all<{ payload_json: string }>();
    return results.map((r) => JSON.parse(r.payload_json) as Job['payload']);
  }
  async function lastSearchJob(): Promise<Job> {
    const payloads = await searchPayloads();
    return {
      job_id: `job_${payloads.length}`,
      kind: 'search',
      priority: 2,
      bucket: 'ops',
      reserved_cents: 0,
      payload: payloads[payloads.length - 1],
    };
  }

  it('asks for the page value with an HTML capture, as a lookup does', async () => {
    const { job } = await pendingWatch();
    expect(job.payload.request.capture_config).toEqual({ html: true });
    expect(job.payload.request.goal).toContain('Return page as one word');
  });

  it('a record page in the answer gives the link, and the record is read before the key is stored', async () => {
    const { stub, watch_id, job } = await pendingWatch();
    await resolveWatchFromSearch(
      testEnv(),
      db,
      stub.client,
      job,
      run({ result: { page: 'record', url: RECORD_URL, total: null }, steps: noCapture }),
    );
    expect(stub.stepHtml).not.toHaveBeenCalled();
    expect(stub.fetchPages).toHaveBeenCalledTimes(1);
    expect((await getKey(db, 'fl-dbpr', LICENCE))?.link_json).toContain('"id":"00000000000000000000000000000001"');
    expect((await getWatch(db, watch_id))?.monitor_id).toBe('mon_new');
  });

  it('a record page of another licence is refused after the fetch, and no key is stored', async () => {
    const { stub, watch_id, job } = await pendingWatch();
    stub.fetchPages.mockResolvedValue({ results: [{ text: record.replaceAll(LICENCE, 'CBC0000009') }], errors: [] });
    await resolveWatchFromSearch(
      testEnv(),
      db,
      stub.client,
      job,
      run({ result: { page: 'record', url: RECORD_URL, total: null }, steps: noCapture }),
    );
    expect(await getKey(db, 'fl-dbpr', LICENCE)).toBeNull();
    expect((await eventsOf(watch_id)).map((e) => e.evidence.note)).toEqual(['licence_number_mismatch']);
  });

  it('a results list takes the link from the row of the watched number in the run snapshot', async () => {
    const { stub, watch_id, job } = await pendingWatch();
    stub.stepHtml.mockResolvedValue(resultsList);
    await resolveWatchFromSearch(
      testEnv(),
      db,
      stub.client,
      job,
      run({ result: { page: 'results', total: 4 }, steps: captured }),
    );
    expect(stub.stepHtml.mock.calls.map((c) => c[1])).toEqual(['s1']);
    expect((await getKey(db, 'fl-dbpr', LICENCE))?.link_json).toContain('"id":"00000000000000000000000000000001"');
    expect((await getWatch(db, watch_id))?.monitor_id).toBe('mon_new');
    expect(await queueRows('search')).toHaveLength(1);
  });

  it('a list with no row for the number starts the row-copying run once, and the watch stays pending', async () => {
    const { stub, watch_id, job } = await pendingWatch('CBC0000009');
    stub.stepHtml.mockResolvedValue(resultsList);
    await resolveWatchFromSearch(
      testEnv(),
      db,
      stub.client,
      job,
      run({ result: { page: 'results', total: 4 }, steps: captured }),
    );
    const payloads = await searchPayloads();
    expect(payloads).toHaveLength(2);
    const second = payloads[1];
    expect(second.watch_id).toBe(watch_id);
    expect(second.request.goal).not.toBe(job.payload.request.goal);
    expect(second.request.capture_config).toEqual({ html: true });
    expect(await eventsOf(watch_id)).toEqual([]);
    expect(stub.createMonitor).not.toHaveBeenCalled();

    // The copying run finds the link: the watch is finished from its answer.
    stub.fetchPages.mockResolvedValue({ results: [{ text: record.replaceAll(LICENCE, 'CBC0000009') }], errors: [] });
    stub.createMonitor.mockResolvedValue({
      monitor: { id: 'mon_new' },
      run: { id: 'run_base', results: [{ text: record.replaceAll(LICENCE, 'CBC0000009') }], errors: [] },
    });
    const copying = await lastSearchJob();
    await resolveWatchFromSearch(
      testEnv(),
      db,
      stub.client,
      copying,
      run({
        result: { page: 'record', found: true, url: RECORD_URL, licence_number: 'CBC0000009', rows: [], total: 0 },
        steps: noCapture,
      }),
    );
    expect((await getWatch(db, watch_id))?.monitor_id).toBe('mon_new');
  });

  it('the row-copying run that finds no link ends the watch, with no third run', async () => {
    const { stub, watch_id, job } = await pendingWatch('CBC0000009');
    stub.stepHtml.mockResolvedValue(resultsList);
    await resolveWatchFromSearch(
      testEnv(),
      db,
      stub.client,
      job,
      run({ result: { page: 'results', total: 4 }, steps: captured }),
    );
    const copying = await lastSearchJob();
    await resolveWatchFromSearch(
      testEnv(),
      db,
      stub.client,
      copying,
      run({
        result: { page: 'results', found: false, url: null, licence_number: 'CBC0000009', rows: [], total: 0 },
        steps: captured,
      }),
    );
    expect(await searchPayloads()).toHaveLength(2);
    const events = await eventsOf(watch_id);
    expect(events.map((e) => e.kind)).toEqual(['check_failed']);
    expect(events[0].evidence.note).toContain('did not return this licence number');
  });
});
