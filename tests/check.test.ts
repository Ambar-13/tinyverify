import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetWalletCache, type Bucket } from '../src/queue/budget';
import { continueCheck, refine as refineCheck, startCheck } from '../src/lookup/check';
import { continuations, type Job, type Outcome as JobOutcome } from '../src/queue/queue';
import { resolveWatchFromSearch } from '../src/watch/watch';
import { app } from '../src/http/app';
import type { Candidate, Fields, Reading, ReaderName, RegistryId, VerifyInput, VerifyResult } from '../src/types';

vi.mock('../src/watch/watch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/watch/watch')>();
  return { ...actual, resolveWatchFromSearch: vi.fn(async () => undefined) };
});
import { getCheck, getKey, upsertKey } from '../src/store';
import { registries } from '../src/registries/catalog';
import { registerAdapter } from '../src/registries';
import type { Adapter } from '../src/registries/adapter';
import { flMqa } from '../src/registries/fl-mqa';
import { caCslb } from '../src/registries/ca-cslb';
import { flDbpr } from '../src/registries/fl-dbpr';
import { TinyFishError, type RunResult, type RunStep, type TinyFish } from '../src/tinyfish/client';
import mqaRecord from './fixtures/fl-mqa/live-physician-1.fetch.html?raw';
import mqaResults from './fixtures/fl-mqa/snapshots/results-page.snapshot.html?raw';
import mqaTab from './fixtures/fl-mqa/tabs/enforcement-tab.fetch.html?raw';
import dbprRecord from './fixtures/fl-dbpr/live-contractor-1.fetch.html?raw';

type Row = Omit<Candidate, 'score' | 'reasons' | 'candidate_id'>;

function fieldsOf(over: Partial<Fields> = {}): Fields {
  return {
    name: 'RAJ PATEL',
    licence_number: '1234567',
    status_raw: 'Active',
    status: 'active',
    expires: '2030-01-01',
    issued: '2010-01-01',
    licence_type: 'Certified General Contractor',
    discipline_flag: false,
    discipline_actions: [],
    data_as_of: '2026-11-01',
    city: 'Fresno',
    other_names: [],
    ...over,
  };
}

// Stand-in parsers read JSON fields, so a test controls exactly what each reader sees.
const page = (over: Partial<Fields> = {}): string => JSON.stringify(fieldsOf(over));
// What a search run captured when the registry showed no list and no licence page.
const NO_RECORD = page({ licence_number: null });

function readingOf(reader: ReaderName, html: string): Reading {
  return { reader, fields: JSON.parse(html) as Fields, quotes: [], warnings: [] };
}

function row(name: string, licence: string | null, city: string | null): Row {
  return {
    name,
    licence_number: licence,
    city,
    licence_type: 'Contractor',
    status_raw: 'Active',
    from: 'search',
    link: null,
  };
}

const cont = (client: TinyFish, check_id: string, outcome: JobOutcome, bucket: Bucket = 'public'): Promise<void> =>
  continueCheck(env, env.DB, client, check_id, outcome, bucket);
const refine = (
  client: TinyFish,
  check_id: string,
  candidate_id: string,
  bucket: Bucket = 'public',
): Promise<VerifyResult> => refineCheck(env, env.DB, client, check_id, candidate_id, bucket);

function run(status: RunResult['status'], over: Partial<RunResult> = {}): RunResult {
  return { run_id: 'run_1', status, result: null, steps: [{ step_id: 'step_1' }], steps_used: 1, error: null, ...over };
}

// A complaint run's snapshots: a licence record page, then the complaint view.
const RECORD_STEP = { step_id: 'rec' };
const viewRun = (over: Partial<RunResult> = {}): RunResult =>
  run('COMPLETED', { steps: [RECORD_STEP, { step_id: 'step_1' }], ...over });

interface AgentOpts {
  maintenanceUntil?: string | null;
  max_steps?: number;
}

// An agent-read registry: searches and records are read by a run, and the parsers read the last step's HTML.
function agentAdapter(id: RegistryId, opts: AgentOpts = {}): Adapter {
  const info = registries.find((r) => r.id === id);
  if (!info) throw new Error(`no registry ${id}`);
  return {
    id,
    version: 'test-1',
    info,
    search: {
      kind: 'agent',
      start_url: `https://${id}.test/search`,
      max_steps: opts.max_steps ?? 20,
      output_schema: {},
      goal: (q) => `Search for ${q.name ?? q.licence_number ?? ''}`,
    },
    rowsFromAgent: (output) => (output as { rows?: Row[] }).rows ?? [],
    record: {
      kind: 'agent',
      start_url: `https://${id}.test/record`,
      goal: (ln) => `Open ${ln}`,
      output_schema: {},
      max_steps: 20,
      source_lookup: (ln) => `https://${id}.test/lookup/${ln}`,
    },
    discipline: { kind: 'on_page' },
    statusTable: {},
    parseHtml: (h) => readingOf('parser_html', h),
    parseText: (h) => readingOf('parser_text', h),
    fieldsFromAgent: (out) => ({
      reader: 'agent_output',
      fields: (out as { fields: Fields }).fields,
      quotes: [],
      warnings: [],
    }),
    maintenanceUntil: () => opts.maintenanceUntil ?? null,
  };
}

// A link-read registry with a stand-in two-parser pair. The real MQA text reader is not used here.
function linkAdapter(id: RegistryId): Adapter {
  const base = agentAdapter(id);
  return {
    ...base,
    record: { kind: 'link', url: (link) => `https://${id}.test/record?licInd=${link.licInd}&proCde=${link.proCde}` },
  };
}

// A fetch-searched registry: the search is a page, and an alternate spelling changes its address.
function fetchSearchAdapter(): Adapter {
  const base = agentAdapter('fl-dbpr');
  return {
    ...base,
    search: {
      kind: 'fetch',
      url: (q: { name?: string; alternate?: boolean }) =>
        `https://fl-dbpr.test/search?name=${encodeURIComponent(q.name ?? '')}${q.alternate ? '&alt=1' : ''}`,
    },
    rowsFromFetchHtml: (html) =>
      html.includes('ALT') ? [row('Dana Lee', 'CMC1', 'Miami'), row('Dana Lee', 'CMC2', 'Tampa')] : [],
    record: { kind: 'link', url: () => 'https://fl-dbpr.test/record' },
  };
}

// A made-up complaint view and two made-up readers of it. "VIEW" marks the view and each "ROW" is one complaint.
// The second reader skips a "ROWBAD", which it does not take for a complaint, so the two readers can disagree.
const viewPage = (rows = 0, tail = ''): string => `VIEW ${'ROW '.repeat(rows)}${tail}`;
function recordOrBlank(reader: ReaderName, html: string): Reading {
  try {
    return readingOf(reader, html);
  } catch {
    return { reader, fields: fieldsOf({ licence_number: null }), quotes: [], warnings: [] };
  }
}
function complaintAdapter(): Adapter {
  return {
    ...fetchSearchAdapter(),
    discipline: { kind: 'agent_second_run', goal: () => 'Read complaints', output_schema: {} },
    // The stand-in record readers throw on a page that is not JSON; these give a blank licence number instead.
    parseHtml: (html) => recordOrBlank('parser_html', html),
    parseText: (html) => recordOrBlank('parser_text', html),
    rowsFromSnapshot: (html) => (html.includes('RESULTS') ? { rows: [], total: 0 } : null),
    complaintRows: (html) =>
      html.includes('VIEW')
        ? [...html.matchAll(/ROW/g)].map((_, i) => ({
            case_number: `C-${i + 1}`,
            status: 'Open',
            date: '2025-01-02',
            description: 'x',
          }))
        : null,
    complaintLines: (html) =>
      html.includes('VIEW')
        ? [...html.matchAll(/ROW(?!BAD)/g)].map((_, i) => ({ case_number: `C-${i + 1}`, status: 'Open' }))
        : null,
  };
}

interface Stubs {
  fetchPages: (urls: string[]) => Promise<unknown>;
  search: (query: string, opts?: unknown) => Promise<unknown>;
  stepHtml: (runId: string, stepId: string) => Promise<string>;
  runAsync: (req: unknown) => Promise<unknown>;
  wallet: () => Promise<{ balance_cents: number }>;
}

function client(over: Partial<Stubs> = {}): TinyFish {
  const stubs: Stubs = {
    fetchPages: async () => ({ results: [], errors: [] }),
    search: async () => ({ results: [] }),
    stepHtml: async () => page(),
    runAsync: async () => ({ run_id: 'run_started' }),
    wallet: async () => ({ balance_cents: 10_000 }),
    ...over,
  };
  return {
    ...stubs,
    getRun: async () => {
      throw new Error('getRun is not stubbed');
    },
  } as unknown as TinyFish;
}

async function jobs(): Promise<{ kind: string; state: string }[]> {
  const { results } = await env.DB.prepare('SELECT kind, state FROM queue').all<{ kind: string; state: string }>();
  return results;
}

async function stored(check_id: string): Promise<VerifyResult> {
  const row = await getCheck(env.DB, check_id);
  return JSON.parse(row?.result_json ?? 'null') as VerifyResult;
}

beforeEach(() => {
  resetWalletCache();
  registerAdapter('ca-cslb', agentAdapter('ca-cslb'));
  registerAdapter('fl-dbpr', fetchSearchAdapter());
});

afterEach(() => {
  registerAdapter('fl-mqa', flMqa);
  registerAdapter('ca-cslb', caCslb);
  registerAdapter('fl-dbpr', flDbpr);
});

describe('input validation and routing', () => {
  it('rejects a jurisdiction that is a city', async () => {
    const r = await startCheck(
      env,
      env.DB,
      client(),
      { name: 'Raj Patel', record_type: 'contractor', jurisdiction: 'Miami' },
      'public',
    );
    expect(r.state).toBe('done');
    expect(r.outcome).toBe('invalid_input');
    expect(r.invalid?.field).toBe('jurisdiction');
    expect(r.invalid?.expected).toBe('a US state or code, or a country');
  });

  it('rejects an unrecognised word as a jurisdiction', async () => {
    const r = await startCheck(
      env,
      env.DB,
      client(),
      { name: 'Raj Patel', record_type: 'contractor', jurisdiction: 'Gotham' },
      'public',
    );
    expect(r.outcome).toBe('invalid_input');
    expect(r.invalid?.field).toBe('jurisdiction');
  });

  it('rejects a name with a character outside the allowed set', async () => {
    const r = await startCheck(
      env,
      env.DB,
      client(),
      { name: 'Raj <script>', record_type: 'contractor', jurisdiction: 'California' },
      'public',
    );
    expect(r.outcome).toBe('invalid_input');
    expect(r.invalid?.field).toBe('name');
    expect(r.invalid?.expected).toContain('up to 80 characters');
  });

  it('rejects a name longer than 80 characters', async () => {
    const r = await startCheck(
      env,
      env.DB,
      client(),
      { name: 'A'.repeat(200), record_type: 'contractor', jurisdiction: 'California' },
      'public',
    );
    expect(r.outcome).toBe('invalid_input');
    expect(r.invalid?.field).toBe('name');
  });

  it('accepts a four-letter Florida prefix such as an APRN number, and starts the lookup', async () => {
    const r = await startCheck(
      env,
      env.DB,
      client(),
      { licence_number: 'APRN0000001', record_type: 'nurse', jurisdiction: 'US-FL' },
      'public',
    );
    expect(r.outcome).not.toBe('invalid_input');
    expect(r.state).not.toBe('done');
    expect(r.searched.registries).toEqual(['fl-mqa']);
  });

  it('rejects a CSLB number that breaks the published format', async () => {
    const r = await startCheck(
      env,
      env.DB,
      client(),
      { licence_number: 'ABC-12345', record_type: 'contractor', jurisdiction: 'California' },
      'public',
    );
    expect(r.outcome).toBe('invalid_input');
    expect(r.invalid?.field).toBe('licence_number');
    expect(r.searched.registries).toEqual([]);
  });

  const texasSearch = async () => ({
    results: [
      { position: 1, title: 'Lone Star Plumbers', url: 'https://www.example.com/texas-plumbers', snippet: '' },
      { position: 2, title: 'Texas State Licensing', url: 'https://www.tx.gov/licensing', snippet: '' },
    ],
  });
  const TEXAS = { name: 'Raj Patel', record_type: 'plumber', jurisdiction: 'Texas' };
  const TEXAS_LINK = { registry_name: 'Texas State Licensing', registry_url: 'https://www.tx.gov/licensing' };
  // A made-up record page: one label and one value per table row.
  const TEXAS_PAGE = `<html><body><h1>Licence details</h1><table>
<tr><th>Name</th><td>PATEL, RAJ K</td></tr>
<tr><th>Licence number</th><td>TX-204418</td></tr>
<tr><th>Licence type</th><td>Master Plumber</td></tr>
<tr><th>Status</th><td>Active</td></tr>
<tr><th>Expires</th><td>03/31/2027</td></tr>
</table></body></html>`;
  const texasRecord = {
    name: 'PATEL, RAJ K',
    licence_number: 'TX-204418',
    licence_type: 'Master Plumber',
    status: 'Active',
    expires: '03/31/2027',
    record_url: 'https://www.tx.gov/licensing/record/204418',
  };
  const saved = async (check_id: string): Promise<VerifyResult> =>
    JSON.parse((await getCheck(env.DB, check_id))!.result_json!) as VerifyResult;

  it('says the budget is used up, with the government link from Search, when no run can be paid for', async () => {
    const calls: { query: string; opts: unknown }[] = [];
    const c = client({
      search: async (query, opts) => {
        calls.push({ query, opts });
        return texasSearch();
      },
      wallet: async () => ({ balance_cents: 0 }),
    });
    const r = await startCheck(env, env.DB, c, TEXAS, 'public');
    expect(r.outcome).toBe('source_unavailable');
    expect(r.unavailable?.reason).toBe('budget');
    expect(r.unavailable?.retry_after).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.unsupported).toEqual(TEXAS_LINK);
    const again = await startCheck(env, env.DB, c, TEXAS, 'public');
    expect(again.served_from_cache).toBe(false);
    expect(calls[0].query).toBe('Texas contractor license lookup verify official');
    expect(calls[0].opts).toBeUndefined();
    const queued = await env.DB.prepare('SELECT kind FROM queue').all();
    expect(queued.results).toEqual([]);
  });

  it('queues one lookup on the register Search found, and keeps the link while it runs', async () => {
    const r = await startCheck(env, env.DB, client({ search: texasSearch }), TEXAS, 'public');
    expect(r.outcome).toBeNull();
    expect(r.state).toBe('searching');
    expect(r.unsupported).toEqual(TEXAS_LINK);
    const queued = await env.DB.prepare('SELECT kind, payload_json FROM queue').all<{
      kind: string;
      payload_json: string;
    }>();
    expect(queued.results.map((job) => job.kind)).toEqual(['generic']);
    const request = (JSON.parse(queued.results[0].payload_json) as Job['payload']).request;
    expect(request.url).toBe('https://www.tx.gov/licensing');
    expect(request.goal).toContain('<<<Patel>>>');
  });

  it('shows a record from that register only when the captured page says the same', async () => {
    const started = await startCheck(env, env.DB, client({ search: texasSearch }), TEXAS, 'public');
    const answer = { found: true, reason: null, results_total: 1, record: texasRecord };
    await cont(client({ stepHtml: async () => TEXAS_PAGE }), started.check_id, run('COMPLETED', { result: answer }));
    const r = await saved(started.check_id);
    expect(r.outcome).toBe('match');
    expect(r.warnings).toEqual(['generic_route']);
    expect(r.unsupported).toEqual(TEXAS_LINK);
    expect(r.records[0]).toMatchObject({
      registry: { id: 'generic', name: 'Texas State Licensing', jurisdiction: 'Texas' },
      key: { licence_number: 'TX-204418' },
      source_url: 'https://www.tx.gov/licensing/record/204418',
      source_lookup: 'https://www.tx.gov/licensing',
      licence: { type: 'Master Plumber', status: 'active', status_raw: 'Active', expires: '2027-03-31' },
      verification: { readers: ['agent_output', 'page_grounding'], agree: true },
      read_by: 'agent',
    });
    expect(r.records[0].evidence.snapshot_id).not.toBeNull();
  });

  it('shows no record when the page does not carry the status the agent reported', async () => {
    const started = await startCheck(env, env.DB, client({ search: texasSearch }), TEXAS, 'public');
    const answer = { found: true, reason: null, results_total: 1, record: { ...texasRecord, status: 'Revoked' } };
    await cont(client({ stepHtml: async () => TEXAS_PAGE }), started.check_id, run('COMPLETED', { result: answer }));
    const r = await saved(started.check_id);
    expect(r.outcome).toBe('needs_review');
    expect(r.records).toEqual([]);
    expect(r.warnings).toEqual(['generic_route', 'not_grounded']);
    expect(r.unsupported?.registry_url).toBe('https://www.tx.gov/licensing');
  });

  it('asks for the licence number when the register lists several records under the name', async () => {
    const started = await startCheck(env, env.DB, client({ search: texasSearch }), TEXAS, 'public');
    const answer = { found: false, reason: 'several', results_total: 7, record: null };
    await cont(client(), started.check_id, run('COMPLETED', { result: answer }));
    const r = await saved(started.check_id);
    expect(r.outcome).toBe('needs_review');
    expect(r.candidates_total).toBe(7);
    expect(r.disambiguators).toEqual(['licence_number']);
    expect(r.warnings).toEqual(['generic_route', 'several_results']);
    expect(r.unsupported?.message).toBe(
      'The register lists 7 records under this name. Add the licence number to check one.',
    );
  });

  it('says no match only when the captured page says the search found nothing', async () => {
    const answer = { found: false, reason: 'no_results', results_total: 0, record: null };
    const shown = await startCheck(env, env.DB, client({ search: texasSearch }), TEXAS, 'public');
    await cont(
      client({ stepHtml: async () => '<p>No records found for your search.</p>' }),
      shown.check_id,
      run('COMPLETED', { result: answer }),
    );
    expect((await saved(shown.check_id)).outcome).toBe('no_match');

    const other = { ...TEXAS, name: 'Dana Lee' };
    const unshown = await startCheck(env, env.DB, client({ search: texasSearch }), other, 'public');
    await cont(
      client({ stepHtml: async () => '<form><label>Last name</label><input></form>' }),
      unshown.check_id,
      run('COMPLETED', { result: answer }),
    );
    expect((await saved(unshown.check_id)).outcome).toBe('needs_review');
  });

  it('reports a captcha on that register as the source being unavailable', async () => {
    const started = await startCheck(env, env.DB, client({ search: texasSearch }), TEXAS, 'public');
    await cont(
      client(),
      started.check_id,
      run('COMPLETED', { result: { found: false, reason: 'captcha', results_total: null, record: null } }),
    );
    const r = await saved(started.check_id);
    expect(r.outcome).toBe('source_unavailable');
    expect(r.unavailable?.reason).toBe('captcha');
  });

  // The result lists below are the hosts Search returned on a live call, in rank order.
  const hits = (urls: string[]) => ({
    results: urls.map((url, i) => ({ position: i + 1, title: `Result ${i + 1}`, url, snippet: '' })),
  });
  const linkFor = async (jurisdiction: string, record_type: string, urls: string[]): Promise<string | null> => {
    // The wallet is too low for a run, so the answer is the link alone: with a link the budget is the reason,
    // and with none the place is not covered.
    const c = client({ search: async () => hits(urls), wallet: async () => ({ balance_cents: 0 }) });
    const r = await startCheck(env, env.DB, c, { name: 'Raj Patel', record_type, jurisdiction }, 'public');
    expect(r.outcome).toBe(r.unsupported?.registry_url ? 'source_unavailable' : 'unsupported');
    return r.unsupported?.registry_url ?? null;
  };

  it('gives the United Kingdom regulator and passes over a journal article and US state boards', async () => {
    expect(
      await linkFor('United Kingdom', 'physician', [
        'https://pmc.ncbi.nlm.nih.gov/articles/PMC4952532/',
        'https://www.maine.gov/md/',
        'https://kbml.ky.gov/',
        'https://www.gmc-uk.org/registration-and-licensing/our-registers',
      ]),
    ).toBe('https://www.gmc-uk.org/registration-and-licensing/our-registers');
  });

  it('gives a Singapore government host and passes over the US provider registry', async () => {
    expect(
      await linkFor('Singapore', 'physician', [
        'https://npiregistry.cms.hhs.gov/',
        'https://www.tmb.texas.gov/',
        'https://www.smc.gov.sg/',
        'https://hellodr.sg/',
      ]),
    ).toBe('https://www.smc.gov.sg/');
  });

  it('gives no link when no result is on an official host of the place asked', async () => {
    expect(
      await linkFor('United Kingdom', 'physician', [
        'https://doctorsdefenceservice.com/',
        'https://kbml.ky.gov/',
        'https://www.sec.gov/',
      ]),
    ).toBeNull();
  });

  it('passes over another state and a federal host when a US state is asked', async () => {
    expect(
      await linkFor('Texas', 'physician', [
        'https://oklahoma.gov/medicalboard',
        'https://portal.ct.gov/dph',
        'https://npiregistry.cms.hhs.gov/',
        'https://www.va.gov/',
        'https://vo.ras.dshs.state.tx.us/',
      ]),
    ).toBe('https://vo.ras.dshs.state.tx.us/');
  });

  it('asks a country in register wording first, then in licence wording when no official host came back', async () => {
    const asked: string[] = [];
    const c = client({
      search: async (query: string) => (
        asked.push(query),
        hits(asked.length === 1 ? ['https://kbml.ky.gov/'] : ['https://www.gmc-uk.org/'])
      ),
    });
    const r = await startCheck(
      env,
      env.DB,
      c,
      { name: 'Zed Quux', record_type: 'physician', jurisdiction: 'United Kingdom' },
      'public',
    );
    expect(r.unsupported?.registry_url).toBe('https://www.gmc-uk.org/');
    expect(asked).toEqual([
      'United Kingdom physician register check official',
      'United Kingdom physician license lookup verify official',
    ]);
  });

  it('asks for a company in business-register wording, once', async () => {
    const asked: string[] = [];
    const c = client({ search: async (query: string) => (asked.push(query), hits(['https://example.com/'])) });
    await startCheck(env, env.DB, c, { name: 'Acme Widgets', record_type: 'company', jurisdiction: 'Texas' }, 'public');
    await startCheck(
      env,
      env.DB,
      c,
      { name: 'Acme Widgets', record_type: 'business', jurisdiction: 'United Kingdom' },
      'public',
    );
    expect(asked).toEqual([
      'Texas business entity search secretary of state official',
      'United Kingdom company register search official',
    ]);
  });

  it("takes Florida's company register on sunbiz.org for a company, and for nothing else", async () => {
    const sunbiz = 'https://search.sunbiz.org/Inquiry/CorporationSearch/ByName';
    const c = client({ search: async () => hits(['https://www.bizapedia.com/fl/', sunbiz]) });
    const company = await startCheck(
      env,
      env.DB,
      c,
      { name: 'Acme Widgets', record_type: 'company', jurisdiction: 'Florida' },
      'public',
    );
    expect(company.unsupported?.registry_url).toBe(sunbiz);
    const elsewhere = await startCheck(
      env,
      env.DB,
      c,
      { name: 'Acme Widgets', record_type: 'company', jurisdiction: 'Georgia' },
      'public',
    );
    expect(elsewhere.unsupported?.registry_url).toBe(null);
    const pharmacist = await startCheck(
      env,
      env.DB,
      c,
      { name: 'Zed Quux', record_type: 'pharmacist', jurisdiction: 'Texas' },
      'public',
    );
    expect(pharmacist.unsupported?.registry_url).toBe(null);
  });

  it('asks a state once, in licence wording', async () => {
    const asked: string[] = [];
    const c = client({ search: async (query: string) => (asked.push(query), hits(['https://example.com/'])) });
    await startCheck(env, env.DB, c, { name: 'Zed Quux', record_type: 'physician', jurisdiction: 'Texas' }, 'public');
    expect(asked).toEqual(['Texas physician license lookup verify official']);
  });

  it('takes a .us host only under the state government name of the state asked', async () => {
    expect(
      await linkFor('Texas', 'physician', [
        'https://licence-lookup.zz.us/',
        'https://texas.ok.us/',
        'https://board.austin.tx.us/',
      ]),
    ).toBeNull();
    expect(await linkFor('Texas', 'dentist', ['https://www.state.ok.us/', 'https://www.state.tx.us/'])).toBe(
      'https://www.state.tx.us/',
    );
  });

  it('accepts a state board whose host names no state', async () => {
    expect(
      await linkFor('New York', 'nurse', [
        'https://nurselicenseguide.com/',
        'https://www.op.nysed.gov/registered-professional-nursing',
      ]),
    ).toBe('https://www.op.nysed.gov/registered-professional-nursing');
  });

  it('reads the longer state name when one name sits inside another', async () => {
    expect(await linkFor('Arkansas', 'nurse', ['https://healthy.arkansas.gov/'])).toBe('https://healthy.arkansas.gov/');
    expect(await linkFor('Kansas', 'nurse', ['https://healthy.arkansas.gov/'])).toBeNull();
  });

  it('reports a listed registry with no adapter as unsupported, with its own link and no run', async () => {
    let searched = false;
    let fetched = false;
    const c = client({
      search: async () => {
        searched = true;
        return { results: [] };
      },
      fetchPages: async () => {
        fetched = true;
        return { results: [], errors: [] };
      },
    });
    const r = await startCheck(
      env,
      env.DB,
      c,
      { name: 'Jane Citizen', record_type: 'physician', jurisdiction: 'Australia' },
      'public',
    );
    expect(r.state).toBe('done');
    expect(r.outcome).toBe('unsupported');
    expect(r.unsupported).toEqual({
      registry_name: 'Australian Health Practitioner Regulation Agency public register',
      registry_url: 'https://www.ahpra.gov.au/Registration/Registers-of-Practitioners.aspx',
      message: 'This registry is not connected yet',
    });
    expect(r.searched.registries).toEqual([]);
    expect(searched).toBe(false);
    expect(fetched).toBe(false);
    expect(await jobs()).toEqual([]);
  });

  it('reports an Australian state as the same not connected answer, and never as a timeout', async () => {
    const r = await startCheck(
      env,
      env.DB,
      client(),
      { name: 'Jane Citizen', record_type: 'GP', jurisdiction: 'Queensland' },
      'public',
    );
    expect(r.outcome).toBe('unsupported');
    expect(r.unavailable).toBeUndefined();
    expect(r.unsupported?.message).toBe('This registry is not connected yet');
  });

  it('marks USA as unsupported without searching and gives no link', async () => {
    let searched = false;
    const c = client({
      search: async () => {
        searched = true;
        return { results: [] };
      },
    });
    const r = await startCheck(
      env,
      env.DB,
      c,
      { name: 'Raj Patel', record_type: 'contractor', jurisdiction: 'USA' },
      'public',
    );
    expect(r.outcome).toBe('unsupported');
    expect(r.unsupported).toEqual({
      registry_name: null,
      registry_url: null,
      message: 'Name a state, for example Florida or California',
    });
    expect(searched).toBe(false);
  });

  it('runs one alternate-spellings search when the first pass finds nothing, and marks those rows', async () => {
    const urls: string[] = [];
    const c = client({
      fetchPages: async (u) => {
        urls.push(u[0]);
        const html = u[0].includes('alt=1') ? 'ALT results page' : 'FIRST results page';
        return { results: [{ url: u[0], text: html }], errors: [] };
      },
    });
    const r = await startCheck(
      env,
      env.DB,
      c,
      { name: 'Dana Lee', record_type: 'contractor', jurisdiction: 'FL' },
      'public',
    );
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('alt=1');
    expect(r.outcome).toBe('multiple_matches');
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates.every((cand) => cand.from === 'alternate_spellings')).toBe(true);
    expect(r.searched.alternate_spellings_used).toBe(true);
  });
});

// A health-board-like adapter whose name search stops at the results page: the run answers { page, total, url }
// and the rows are read by code from the run's page snapshot. A snapshot that starts with LIST is a results list.
function snapshotAdapter(): Adapter {
  const base = linkAdapter('fl-mqa');
  if (base.search.kind !== 'agent') throw new Error('agent search expected');
  return {
    ...base,
    search: {
      ...base.search,
      goal: (q) =>
        q.copy_rows ? 'COPY the rows' : q.licence_number && !q.name ? 'FIND the address' : 'STOP at the page',
      reports_page: true,
      snapshot: { applies: (q) => !!q.name && !q.copy_rows, output_schema: { snapshot: true }, max_steps: 10 },
    },
    rowsFromAgent: (output) => {
      const o = output as { rows?: Row[]; found?: boolean; url?: string };
      if (o.found === true && typeof o.url === 'string')
        return [{ ...row('Licence record', null, null), link: { licInd: '7', proCde: '8' } }];
      return o.rows ?? [];
    },
    rowsFromSnapshot: (html) =>
      html.startsWith('LIST')
        ? { rows: [row('Raj Patel', 'ME000001', 'Fresno'), row('Raj Patel', 'ME000002', 'Miami')], total: 91 }
        : null,
  };
}

async function searchJobs(): Promise<
  { goal: string; capture_config?: unknown; output_schema?: unknown; agent_config?: unknown }[]
> {
  const { results } = await env.DB.prepare("SELECT payload_json FROM queue WHERE kind = 'search' ORDER BY rowid").all<{
    payload_json: string;
  }>();
  return results.map(
    (r) =>
      (
        JSON.parse(r.payload_json) as {
          request: { goal: string; capture_config?: unknown; output_schema?: unknown; agent_config?: unknown };
        }
      ).request,
  );
}

describe('name search read by code from the run snapshot', () => {
  const NAME = { name: 'Raj Patel', record_type: 'physician', jurisdiction: 'FL' };
  const listRun = (over: Partial<RunResult> = {}): RunResult =>
    run('COMPLETED', {
      result: { page: 'results', total: 91 },
      steps: [
        { step_id: 's1', has_html: true },
        { step_id: 's2', has_html: true },
      ],
      ...over,
    });

  it('starts the stop-at-the-page goal with the page schema, the snapshot capture and its own step limit', async () => {
    registerAdapter('fl-mqa', snapshotAdapter());
    await startCheck({ ...env, AGENT_STEP_CAP: 'on' }, env.DB, client(), NAME, 'public');
    const [job] = await searchJobs();
    expect(job.goal.split('\n')[0]).toBe('STOP at the page');
    expect(job.output_schema).toEqual({ snapshot: true });
    expect(job.capture_config).toEqual({ html: true });
    expect(job.agent_config).toEqual({ max_steps: 10 });
  });

  it('asks a number-only search for the page too, so a "none" can be checked: the registry schema and an HTML capture', async () => {
    registerAdapter('fl-mqa', snapshotAdapter());
    await startCheck(
      env,
      env.DB,
      client(),
      { licence_number: 'ME000001', record_type: 'physician', jurisdiction: 'FL' },
      'public',
    );
    const [job] = await searchJobs();
    expect(job.goal.startsWith('FIND the address')).toBe(true);
    expect(job.capture_config).toEqual({ html: true });
    expect(job.output_schema).toEqual({});
  });

  it('uses the rows read from the latest snapshot, and the page total, with no second run', async () => {
    registerAdapter('fl-mqa', snapshotAdapter());
    const started = await startCheck(env, env.DB, client(), NAME, 'public');
    const asked: string[] = [];
    const c = client({ stepHtml: async (_run, step) => (asked.push(step), 'LIST page') });
    await cont(c, started.check_id, listRun());
    const r = await stored(started.check_id);
    expect(asked).toEqual(['s2']);
    expect(r.state).toBe('done');
    expect(r.outcome).toBe('multiple_matches');
    expect(r.candidates.map((x) => x.licence_number)).toEqual(['ME000001', 'ME000002']);
    expect(r.candidates_total).toBe(91);
    expect(r.warnings ?? []).not.toContain('results_read_by_agent');
    expect(await searchJobs()).toHaveLength(1);
  });

  it('falls back once to the row-copying goal when the snapshot is not a results list, and marks the result', async () => {
    registerAdapter('fl-mqa', snapshotAdapter());
    const started = await startCheck(env, env.DB, client(), NAME, 'public');
    await cont(client({ stepHtml: async () => 'a search form' }), started.check_id, listRun());
    const pending = await stored(started.check_id);
    expect(pending.state).toBe('searching');
    expect(pending.warnings).toEqual(['results_read_by_agent']);
    const jobsNow = await searchJobs();
    expect(jobsNow.map((j) => j.goal.split('\n')[0])).toEqual(['STOP at the page', 'COPY the rows']);
    expect(jobsNow[1].capture_config).toEqual({ html: true });
    expect(jobsNow[1].output_schema).toEqual({});
    // The second run's rows are used as rows always were.
    await cont(
      client(),
      started.check_id,
      run('COMPLETED', {
        result: { rows: [row('Raj Patel', 'ME000001', 'Fresno'), row('Raj Patel', 'ME000002', 'Miami')], total: 2 },
      }),
    );
    const r = await stored(started.check_id);
    expect(r.outcome).toBe('multiple_matches');
    expect(r.candidates_total).toBe(2);
    expect(r.warnings).toContain('results_read_by_agent');
    expect(await searchJobs()).toHaveLength(2);
  });

  it('falls back when no snapshot can be read at all (every step answers 404)', async () => {
    registerAdapter('fl-mqa', snapshotAdapter());
    const started = await startCheck(env, env.DB, client(), NAME, 'public');
    const c = client({
      stepHtml: async () => {
        throw new TinyFishError('not_found', 404, 'gone');
      },
    });
    await cont(c, started.check_id, listRun());
    expect((await searchJobs()).map((j) => j.goal.split('\n')[0])).toEqual(['STOP at the page', 'COPY the rows']);
    expect((await stored(started.check_id)).warnings).toEqual(['results_read_by_agent']);
  });

  it('ends as it does today when the fallback run also finds nothing: no_match, marked, and no third run', async () => {
    registerAdapter('fl-mqa', snapshotAdapter());
    const started = await startCheck(env, env.DB, client(), NAME, 'public');
    await cont(client({ stepHtml: async () => 'a search form' }), started.check_id, listRun());
    await cont(
      client({ stepHtml: async () => NO_RECORD }),
      started.check_id,
      run('COMPLETED', { result: { page: 'none', rows: [], total: 0 } }),
    );
    const r = await stored(started.check_id);
    expect(r.state).toBe('done');
    expect(r.outcome).toBe('no_match');
    expect(r.warnings).toContain('results_read_by_agent');
    expect(await searchJobs()).toHaveLength(2);
  });

  it('a snapshot that cannot be parsed starts exactly one fallback run', async () => {
    registerAdapter('fl-mqa', snapshotAdapter());
    const started = await startCheck(env, env.DB, client(), NAME, 'public');
    expect(await searchJobs()).toHaveLength(1);
    await cont(client({ stepHtml: async () => 'a search form' }), started.check_id, listRun());
    expect(await searchJobs()).toHaveLength(2);
  });

  it('a fallback run whose answer carries a page value and no rows starts no further run and is source_unavailable', async () => {
    registerAdapter('fl-mqa', snapshotAdapter());
    const started = await startCheck(env, env.DB, client(), NAME, 'public');
    await cont(client({ stepHtml: async () => 'a search form' }), started.check_id, listRun());
    expect(await searchJobs()).toHaveLength(2);
    // The fallback's own answer says "results" and holds no rows, and its snapshot would not parse either.
    await cont(client({ stepHtml: async () => 'a search form' }), started.check_id, listRun());
    expect(await searchJobs()).toHaveLength(2);
    const r = await stored(started.check_id);
    expect(r.state).toBe('done');
    expect(r.outcome).toBe('source_unavailable');
    expect(r.unavailable?.reason).toBe('layout_changed');
    expect(r.warnings).toContain('results_read_by_agent');
  });

  it('a fallback run whose answer carries a page value and has rows uses the rows, with no further run', async () => {
    registerAdapter('fl-mqa', snapshotAdapter());
    const started = await startCheck(env, env.DB, client(), NAME, 'public');
    await cont(client({ stepHtml: async () => 'a search form' }), started.check_id, listRun());
    await cont(
      client({ stepHtml: async () => 'a search form' }),
      started.check_id,
      run('COMPLETED', {
        result: {
          page: 'results',
          total: 2,
          rows: [row('Raj Patel', 'ME000001', 'Fresno'), row('Raj Patel', 'ME000002', 'Miami')],
        },
      }),
    );
    expect(await searchJobs()).toHaveLength(2);
    expect((await stored(started.check_id)).outcome).toBe('multiple_matches');
  });

  it('each spelling gets at most one snapshot run and one fallback run: the alternate pass after a fallback copies rows at once', async () => {
    registerAdapter('fl-mqa', {
      ...snapshotAdapter(),
      search: {
        ...(snapshotAdapter().search as Extract<Adapter['search'], { kind: 'agent' }>),
        goal: (q) => (q.copy_rows ? (q.alternate ? 'COPY alt rows' : 'COPY the rows') : 'STOP at the page'),
      },
    });
    const started = await startCheck(env, env.DB, client(), NAME, 'public');
    await cont(client({ stepHtml: async () => 'a search form' }), started.check_id, listRun());
    // The fallback finds a list with no plausible name, so the alternate-spelling pass starts, once.
    await cont(
      client(),
      started.check_id,
      run('COMPLETED', { result: { page: 'results', total: 1, rows: [row('Zed Quux', 'ME000009', 'Miami')] } }),
    );
    const goals = (await searchJobs()).map((j) => j.goal.split('\n')[0]);
    expect(goals).toEqual(['STOP at the page', 'COPY the rows', 'COPY alt rows']);
    // That pass answers with a page value and nothing else: it ends, with no fourth run.
    await cont(client(), started.check_id, run('COMPLETED', { result: { page: 'results', total: 0, rows: [] } }));
    expect(await searchJobs()).toHaveLength(3);
    expect((await stored(started.check_id)).outcome).toBe('source_unavailable');
  });

  it('ends as it does today when the fallback run fails: source_unavailable', async () => {
    registerAdapter('fl-mqa', snapshotAdapter());
    const started = await startCheck(env, env.DB, client(), NAME, 'public');
    await cont(client({ stepHtml: async () => 'a search form' }), started.check_id, listRun());
    await cont(
      client(),
      started.check_id,
      run('FAILED', { error: { code: 'AGENT_FAILURE', message: 'CAPTCHA page' } }),
    );
    expect((await stored(started.check_id)).unavailable?.reason).toBe('captcha');
  });

  describe('an answer of "none" is checked against the captured page', () => {
    const noneRun = (): RunResult =>
      run('COMPLETED', {
        result: { page: 'none', total: null, url: null },
        steps: [{ step_id: 's1', has_html: true }],
      });
    const again = (): Promise<VerifyResult> => startCheck(env, env.DB, client(), NAME, 'public');

    it('a captured page that is neither a list nor a licence page is a no_match that stays cached, with no fallback', async () => {
      registerAdapter('fl-mqa', snapshotAdapter());
      const started = await startCheck(env, env.DB, client(), NAME, 'public');
      await cont(client({ stepHtml: async () => NO_RECORD }), started.check_id, noneRun());
      const r = await stored(started.check_id);
      expect(r.outcome).toBe('no_match');
      expect(r.candidates_total).toBe(0);
      expect(await searchJobs()).toHaveLength(1);
      expect((await again()).served_from_cache).toBe(true);
    });

    it('a captured page that lists rows wins over the word: the search goes on as a results list', async () => {
      registerAdapter('fl-mqa', snapshotAdapter());
      const started = await startCheck(env, env.DB, client(), NAME, 'public');
      await cont(client({ stepHtml: async () => 'LIST page' }), started.check_id, noneRun());
      const r = await stored(started.check_id);
      expect(r.outcome).toBe('multiple_matches');
      expect(r.candidates.map((x) => x.licence_number)).toEqual(['ME000001', 'ME000002']);
      expect(r.candidates_total).toBe(91);
      expect(await searchJobs()).toHaveLength(1);
    });

    it('a captured page that is a licence page is not a no_match either: the row-copying run starts', async () => {
      registerAdapter('fl-mqa', snapshotAdapter());
      const started = await startCheck(env, env.DB, client(), NAME, 'public');
      await cont(client({ stepHtml: async () => page() }), started.check_id, noneRun());
      expect((await stored(started.check_id)).state).toBe('searching');
      expect((await searchJobs()).map((j) => j.goal.split('\n')[0])).toEqual(['STOP at the page', 'COPY the rows']);
    });

    it('no readable capture is still a no_match, but it is not kept for later callers', async () => {
      registerAdapter('fl-mqa', snapshotAdapter());
      const started = await startCheck(env, env.DB, client(), NAME, 'public');
      const gone = client({
        stepHtml: async () => {
          throw new TinyFishError('not_found', 404, 'gone');
        },
      });
      await cont(gone, started.check_id, noneRun());
      expect((await stored(started.check_id)).outcome).toBe('no_match');
      const second = await again();
      expect(second.served_from_cache).toBe(false);
      expect(second.state).toBe('searching');
    });

    it('a run with no capture at all is the same: a no_match that is not kept', async () => {
      registerAdapter('fl-mqa', snapshotAdapter());
      const started = await startCheck(env, env.DB, client(), NAME, 'public');
      const noSteps = run('COMPLETED', {
        result: { page: 'none' },
        steps: [
          { step_id: 's1', has_html: false },
          { step_id: 's2', has_html: false },
        ],
      });
      await cont(
        client({
          stepHtml: async () => {
            throw new Error('nothing was captured');
          },
        }),
        started.check_id,
        noSteps,
      );
      expect((await stored(started.check_id)).outcome).toBe('no_match');
      expect((await again()).served_from_cache).toBe(false);
    });
  });

  it.each(['Results', ' RESULTS ', 'results\n'])(
    'reads the page value %j without regard to letter case or spaces: no paid fallback run',
    async (value) => {
      registerAdapter('fl-mqa', snapshotAdapter());
      const started = await startCheck(env, env.DB, client(), NAME, 'public');
      await cont(
        client({ stepHtml: async () => 'LIST page' }),
        started.check_id,
        run('COMPLETED', { result: { page: value, total: 91 }, steps: [{ step_id: 's1', has_html: true }] }),
      );
      expect((await stored(started.check_id)).outcome).toBe('multiple_matches');
      expect(await searchJobs()).toHaveLength(1);
    },
  );

  it('reads "None" as the registry\'s own no-results page, checked against the capture', async () => {
    registerAdapter('fl-mqa', snapshotAdapter());
    const started = await startCheck(env, env.DB, client(), NAME, 'public');
    await cont(
      client({ stepHtml: async () => 'LIST page' }),
      started.check_id,
      run('COMPLETED', { result: { page: 'None' }, steps: [{ step_id: 's1', has_html: true }] }),
    );
    expect((await stored(started.check_id)).outcome).toBe('multiple_matches');
  });

  it('reads "Record" with an address as a record page', async () => {
    registerAdapter('fl-mqa', snapshotAdapter());
    const started = await startCheck(env, env.DB, client(), NAME, 'public');
    const shown = page({ licence_number: 'ME000001', name: 'RAJ PATEL' });
    const c = client({
      stepHtml: async () => shown,
      fetchPages: async (u) => ({ results: [{ url: u[0], text: shown }], errors: [] }),
    });
    await cont(
      c,
      started.check_id,
      run('COMPLETED', {
        result: { page: 'Record', url: 'https://mqa.test/x?LicInd=7&ProCde=8' },
        steps: [{ step_id: 's1', has_html: true }],
      }),
    );
    expect((await stored(started.check_id)).outcome).toBe('match');
  });

  it('does not send a row-copying run whose goal is the one that just ran: the search ends as an unreadable page', async () => {
    const base = numberSnapshotAdapter(() => null);
    const search = base.search as Extract<Adapter['search'], { kind: 'agent' }>;
    registerAdapter('fl-mqa', { ...base, search: { ...search, goal: () => 'ONE goal for every request' } });
    const started = await startCheck(
      env,
      env.DB,
      client(),
      { licence_number: 'ME000001', record_type: 'physician', jurisdiction: 'FL' },
      'public',
    );
    await cont(
      client({ stepHtml: async () => 'a search form' }),
      started.check_id,
      run('COMPLETED', { result: { page: 'results', total: 3 }, steps: [{ step_id: 's1', has_html: true }] }),
    );
    const r = await stored(started.check_id);
    expect(r.state).toBe('done');
    expect(r.outcome).toBe('source_unavailable');
    expect(r.unavailable?.reason).toBe('layout_changed');
    expect(await searchJobs()).toHaveLength(1);
  });

  describe('a list longer than the page that was read', () => {
    const only = (name: string, id: string): Adapter => ({
      ...snapshotAdapter(),
      rowsFromSnapshot: (html) =>
        html.startsWith('LIST')
          ? {
              rows: [{ ...row(name, id, 'Fresno'), link: { licInd: '1', proCde: '2' } }],
              total: Number(/total=(\d+)/.exec(html)?.[1] ?? 1),
            }
          : null,
    });
    const fetching = (): TinyFish =>
      client({
        stepHtml: async () => 'LIST page total=91',
        fetchPages: async () => {
          throw new Error('a list of more than one page decides nothing, so no record is fetched');
        },
      });

    it('the wanted name missing from page 1 of 91 is several matches with the page total, not a no_match', async () => {
      registerAdapter('fl-mqa', snapshotAdapter());
      const started = await startCheck(
        env,
        env.DB,
        client(),
        { name: 'Zed Quux', record_type: 'physician', jurisdiction: 'FL' },
        'public',
      );
      await cont(client({ stepHtml: async () => 'LIST page' }), started.check_id, listRun());
      const r = await stored(started.check_id);
      expect(r.outcome).toBe('multiple_matches');
      expect(r.candidates_total).toBe(91);
      expect(r.candidates).toHaveLength(2);
      expect(r.disambiguators).toEqual(expect.arrayContaining(['city', 'licence_number']));
      expect(await searchJobs()).toHaveLength(1);
    });

    it('one exact name on page 1 of 91 is a candidate, not a match', async () => {
      registerAdapter('fl-mqa', only('Raj Patel', 'ME000001'));
      const started = await startCheck(env, env.DB, client(), NAME, 'public');
      await cont(fetching(), started.check_id, listRun());
      const r = await stored(started.check_id);
      expect(r.outcome).toBe('multiple_matches');
      expect(r.candidates.map((x) => x.licence_number)).toEqual(['ME000001']);
      expect(r.candidates_total).toBe(91);
      expect(r.records).toEqual([]);
    });

    it('a total equal to the rows read behaves as before: one exact name is a match', async () => {
      registerAdapter('fl-mqa', only('Raj Patel', 'ME000001'));
      const started = await startCheck(env, env.DB, client(), NAME, 'public');
      const c = client({
        stepHtml: async () => 'LIST page total=1',
        fetchPages: async (u) => ({
          results: [{ url: u[0], text: page({ licence_number: 'ME000001', name: 'RAJ PATEL' }) }],
          errors: [],
        }),
      });
      await cont(
        c,
        started.check_id,
        run('COMPLETED', { result: { page: 'results', total: 1 }, steps: [{ step_id: 's1', has_html: true }] }),
      );
      expect((await stored(started.check_id)).outcome).toBe('match');
    });

    it('the rows an agent copied count the same: 2 rows of a total of 91 are several matches', async () => {
      registerAdapter('fl-mqa', snapshotAdapter());
      const started = await startCheck(
        env,
        env.DB,
        client(),
        { name: 'Zed Quux', record_type: 'physician', jurisdiction: 'FL' },
        'public',
      );
      await cont(client({ stepHtml: async () => 'a search form' }), started.check_id, listRun());
      await cont(
        client(),
        started.check_id,
        run('COMPLETED', {
          result: { rows: [row('Raj Patel', 'ME000001', 'Fresno'), row('Raj Patel', 'ME000002', 'Miami')], total: 91 },
        }),
      );
      const r = await stored(started.check_id);
      expect(r.outcome).toBe('multiple_matches');
      expect(r.candidates_total).toBe(91);
    });

    it('rows of another profession are dropped from a longer list, and the total is marked as counting them', async () => {
      registerAdapter('fl-mqa', { ...snapshotAdapter(), ofType: (r) => r.licence_number === 'ME000002' });
      const started = await startCheck(env, env.DB, client(), NAME, 'public');
      await cont(client({ stepHtml: async () => 'LIST page' }), started.check_id, listRun());
      const r = await stored(started.check_id);
      expect(r.outcome).toBe('multiple_matches');
      expect(r.candidates.map((x) => x.licence_number)).toEqual(['ME000002']);
      expect(r.candidates_total).toBe(91);
      expect(r.warnings).toContain('total_counts_other_professions');
    });

    it('a longer list whose first page holds only other professions is never a no_match', async () => {
      registerAdapter('fl-mqa', { ...snapshotAdapter(), ofType: () => false });
      const started = await startCheck(env, env.DB, client(), NAME, 'public');
      await cont(client({ stepHtml: async () => 'LIST page' }), started.check_id, listRun());
      const r = await stored(started.check_id);
      expect(r.outcome).toBe('source_unavailable');
      expect(r.unavailable?.message).toMatch(/first name, city or licence number/);
      expect(r.candidates).toEqual([]);
    });

    it('a whole list of other professions is a no_match that says so', async () => {
      const two = { rows: [row('Raj Patel', 'RN000001', 'Fresno'), row('Raj Patel', 'RN000002', 'Miami')], total: 2 };
      registerAdapter('fl-mqa', { ...snapshotAdapter(), rowsFromSnapshot: () => two, ofType: () => false });
      const started = await startCheck(env, env.DB, client(), NAME, 'public');
      await cont(
        client({ stepHtml: async () => 'LIST page' }),
        started.check_id,
        run('COMPLETED', { result: { page: 'results', total: 2 }, steps: [{ step_id: 's1', has_html: true }] }),
      );
      const r = await stored(started.check_id);
      expect(r.outcome).toBe('no_match');
      expect(r.candidates_total).toBe(0);
      expect(r.warnings).toContain('listed_under_other_professions');
    });
  });

  it('treats page record with an address as the link-finder answer, named from the licence page itself', async () => {
    registerAdapter('fl-mqa', snapshotAdapter());
    const started = await startCheck(env, env.DB, client(), NAME, 'public');
    const c = client({
      stepHtml: async () => page({ name: 'RAJ PATEL', licence_number: 'ME000001' }),
      fetchPages: async (u) => ({
        results: [{ url: u[0], text: page({ name: 'RAJ PATEL', licence_number: 'ME000001' }) }],
        errors: [],
      }),
    });
    await cont(
      c,
      started.check_id,
      run('COMPLETED', {
        result: { page: 'record', url: 'https://mqa.test/x?LicInd=7&ProCde=8' },
        steps: [{ step_id: 's1', has_html: true }],
      }),
    );
    const r = await stored(started.check_id);
    expect(r.outcome).toBe('match');
    expect(r.records[0].read_by).toBe('fetch');
    expect(await searchJobs()).toHaveLength(1);
  });

  it('does not let a row become a record: the chosen row is read from the licence page by the two readers', async () => {
    registerAdapter('fl-mqa', {
      ...snapshotAdapter(),
      rowsFromSnapshot: (html) =>
        html.startsWith('LIST')
          ? { rows: [{ ...row('Raj Patel', 'ME000001', 'Fresno'), link: { licInd: '1', proCde: '2' } }], total: 1 }
          : null,
    });
    const started = await startCheck(env, env.DB, client(), NAME, 'public');
    const fetched: string[] = [];
    const c = client({
      stepHtml: async () => 'LIST',
      fetchPages: async (u) => (
        fetched.push(u[0]),
        { results: [{ url: u[0], text: page({ licence_number: 'ME000001', name: 'RAJ PATEL' }) }], errors: [] }
      ),
    });
    await cont(c, started.check_id, listRun());
    const r = await stored(started.check_id);
    expect(fetched.length).toBeGreaterThan(0);
    expect(r.outcome).toBe('match');
    expect(r.records[0].verification.readers).toEqual(['parser_html', 'parser_text']);
  });
});

// A licence-number search that stops at the results page too (the contractor board): the rows are read by code from the
// snapshot, and the candidates are the rows carrying exactly the number asked for.
function numberSnapshotAdapter(rows: (html: string) => { rows: Row[]; total: number | null } | null): Adapter {
  const base = snapshotAdapter();
  if (base.search.kind !== 'agent') throw new Error('agent search expected');
  return {
    ...base,
    search: {
      ...base.search,
      goal: (q) => (q.copy_rows ? 'COPY the rows' : 'STOP at the page'),
      snapshot: {
        applies: (q) => (!!q.name || !!q.licence_number) && !q.copy_rows,
        output_schema: { snapshot: true },
        max_steps: 10,
      },
    },
    rowsFromSnapshot: rows,
  };
}
const withLink = (r: Row, id: string): Row => ({ ...r, link: { licInd: id, proCde: '2' } });

describe('licence-number search read by code from the run snapshot', () => {
  const NUMBER = { licence_number: 'ME000001', record_type: 'physician', jurisdiction: 'FL' };
  const listRun = (): RunResult =>
    run('COMPLETED', {
      result: { page: 'results', total: 3 },
      steps: [
        { step_id: 's1', has_html: true },
        { step_id: 's2', has_html: true },
      ],
    });
  const LIST = (html: string): boolean => html.startsWith('LIST');

  it('picks only the rows with the number asked for, and reads that one licence page', async () => {
    registerAdapter(
      'fl-mqa',
      numberSnapshotAdapter((html) =>
        LIST(html)
          ? {
              rows: [
                withLink(row('Raj Patel', 'ME000002', 'Fresno'), '9'),
                withLink(row('Raj Patel Inc', 'ME000001', 'Fresno'), '1'),
                withLink(row('Raj Patel', 'ME000001', 'Fresno'), '1'),
              ],
              total: 3,
            }
          : null,
      ),
    );
    const started = await startCheck(env, env.DB, client(), NUMBER, 'public');
    const fetched: string[] = [];
    const c = client({
      stepHtml: async () => 'LIST page',
      fetchPages: async (u) => (
        fetched.push(u[0]),
        { results: [{ url: u[0], text: page({ licence_number: 'ME000001', name: 'RAJ PATEL' }) }], errors: [] }
      ),
    });
    await cont(c, started.check_id, listRun());
    const r = await stored(started.check_id);
    expect(r.outcome).toBe('match');
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toContain('licInd=1&');
    expect(await searchJobs()).toHaveLength(1);
  });

  it('a number with its exact row on a long list is that licence, whatever the page total', async () => {
    registerAdapter(
      'fl-mqa',
      numberSnapshotAdapter((html) =>
        LIST(html)
          ? {
              rows: [
                withLink(row('Raj Patel', 'ME000002', 'Fresno'), '9'),
                withLink(row('Raj Patel', 'ME000001', 'Fresno'), '1'),
              ],
              total: 91,
            }
          : null,
      ),
    );
    const started = await startCheck(env, env.DB, client(), NUMBER, 'public');
    const c = client({
      stepHtml: async () => 'LIST page',
      fetchPages: async (u) => ({
        results: [{ url: u[0], text: page({ licence_number: 'ME000001', name: 'RAJ PATEL' }) }],
        errors: [],
      }),
    });
    await cont(c, started.check_id, listRun());
    expect((await stored(started.check_id)).outcome).toBe('match');
  });

  it('several rows for one licence (one for each name line) collapse to one candidate', async () => {
    registerAdapter(
      'fl-mqa',
      numberSnapshotAdapter((html) =>
        LIST(html)
          ? {
              rows: [
                withLink(row('Raj Patel Inc', 'ME000001', 'Fresno'), '1'),
                withLink(row('Raj Patel', 'ME000001', 'Fresno'), '1'),
              ],
              total: 2,
            }
          : null,
      ),
    );
    const started = await startCheck(env, env.DB, client(), NUMBER, 'public');
    const c = client({
      stepHtml: async () => 'LIST page',
      fetchPages: async (u) => ({
        results: [{ url: u[0], text: page({ licence_number: 'ME000001', name: 'RAJ PATEL' }) }],
        errors: [],
      }),
    });
    await cont(c, started.check_id, listRun());
    const r = await stored(started.check_id);
    expect(r.outcome).toBe('match');
    expect(r.records).toHaveLength(1);
  });

  it('a results list with no row carrying the number is a no_match, with no fallback run', async () => {
    registerAdapter(
      'fl-mqa',
      numberSnapshotAdapter((html) =>
        LIST(html)
          ? {
              rows: [
                withLink(row('Raj Patel', 'ME000002', 'Fresno'), '9'),
                withLink(row('Dana Lee', 'ME000003', 'Miami'), '8'),
              ],
              total: 2,
            }
          : null,
      ),
    );
    const started = await startCheck(env, env.DB, client(), NUMBER, 'public');
    await cont(client({ stepHtml: async () => 'LIST page' }), started.check_id, listRun());
    const r = await stored(started.check_id);
    expect(r.state).toBe('done');
    expect(r.outcome).toBe('no_match');
    expect(r.candidates_total).toBe(0);
    expect(await searchJobs()).toHaveLength(1);
  });

  it('a list with a row whose number cannot be read is not a no_match: the fallback runs', async () => {
    registerAdapter(
      'fl-mqa',
      numberSnapshotAdapter((html) =>
        LIST(html)
          ? {
              rows: [
                withLink(row('Raj Patel', 'ME000002', 'Fresno'), '9'),
                withLink(row('Dana Lee', null, 'Miami'), '8'),
              ],
              total: 2,
            }
          : null,
      ),
    );
    const started = await startCheck(env, env.DB, client(), NUMBER, 'public');
    await cont(client({ stepHtml: async () => 'LIST page' }), started.check_id, listRun());
    expect((await searchJobs()).map((j) => j.goal.split('\n')[0])).toEqual(['STOP at the page', 'COPY the rows']);
    expect((await stored(started.check_id)).warnings).toEqual(['results_read_by_agent']);
  });

  it('an unparsed snapshot takes the fallback once, and the fallback never starts a third run', async () => {
    registerAdapter(
      'fl-mqa',
      numberSnapshotAdapter(() => null),
    );
    const started = await startCheck(env, env.DB, client(), NUMBER, 'public');
    await cont(client({ stepHtml: async () => 'a search form' }), started.check_id, listRun());
    expect((await searchJobs()).map((j) => j.goal.split('\n')[0])).toEqual(['STOP at the page', 'COPY the rows']);
    await cont(
      client({ stepHtml: async () => 'a search form' }),
      started.check_id,
      run('COMPLETED', { result: { page: 'results', rows: [], total: 0 } }),
    );
    expect(await searchJobs()).toHaveLength(2);
    expect((await stored(started.check_id)).state).toBe('done');
  });
});

// A registry that did not answer is not a no match. The adapter asks for a page value (reports_page), so the search
// stage maps each of the six values: record, results, none, error, captcha and sign_in.
function pageAdapter(): Adapter {
  const base = linkAdapter('fl-mqa');
  if (base.search.kind !== 'agent') throw new Error('agent search expected');
  return {
    ...base,
    search: { ...base.search, reports_page: true },
    rowsFromAgent: (output) => {
      const o = (output ?? {}) as { rows?: Row[]; found?: boolean; url?: string; licence_number?: string };
      if (Array.isArray(o.rows) && o.rows.length > 0) return o.rows;
      if (o.found === true && o.url === 'https://mqa.test/good')
        return [{ ...row('Licence record', o.licence_number ?? null, null), link: { licInd: '7', proCde: '8' } }];
      return [];
    },
  };
}

describe('a registry that did not answer is not a no match', () => {
  const NUMBER = { licence_number: 'ME000001', record_type: 'physician', jurisdiction: 'FL' };
  const answered = async (
    result: unknown,
    input: VerifyInput = NUMBER,
    c: TinyFish = client({ stepHtml: async () => NO_RECORD }),
  ): Promise<{ r: VerifyResult; again: VerifyResult }> => {
    registerAdapter('fl-mqa', pageAdapter());
    const started = await startCheck(env, env.DB, client(), input, 'public');
    expect(started.state).toBe('searching');
    await cont(c, started.check_id, run('COMPLETED', { result }));
    const r = await stored(started.check_id);
    const again = await startCheck(env, env.DB, client(), input, 'public');
    return { r, again };
  };
  const reasonOf = (r: VerifyResult): string | undefined => r.unavailable?.reason;

  it('record with a good address reads the licence page and matches', async () => {
    const c = client({
      fetchPages: async (u) => ({ results: [{ url: u[0], text: page({ licence_number: 'ME000001' }) }], errors: [] }),
    });
    const { r } = await answered(
      { page: 'record', found: true, url: 'https://mqa.test/good', rows: [], total: 0 },
      NUMBER,
      c,
    );
    expect(r.outcome).toBe('match');
  });

  it('results with a row goes on to the record', async () => {
    const c = client({
      fetchPages: async (u) => ({ results: [{ url: u[0], text: page({ licence_number: 'ME000001' }) }], errors: [] }),
    });
    const { r } = await answered({ page: 'results', found: true, url: 'https://mqa.test/good' }, NUMBER, c);
    expect(r.outcome).toBe('match');
  });

  it('none is a no_match, and it is cached', async () => {
    const { r, again } = await answered({ page: 'none', found: false, url: null, rows: [], total: 0 });
    expect(r.outcome).toBe('no_match');
    expect(again.served_from_cache).toBe(true);
  });

  it.each([
    ['error', 'timeout'],
    ['captcha', 'captcha'],
    ['sign_in', 'login_required'],
  ])('%s is source_unavailable with reason %s, and nothing is cached', async (value, reason) => {
    const { r, again } = await answered({ page: value, found: false, url: null, rows: [], total: 0 });
    expect(r.outcome).toBe('source_unavailable');
    expect(reasonOf(r)).toBe(reason);
    expect(again.served_from_cache).toBe(false);
    expect(again.state).toBe('searching');
  });

  it('found true with an address that does not parse is source_unavailable layout_changed, not a no_match', async () => {
    const { r, again } = await answered({
      page: 'record',
      found: true,
      url: 'https://elsewhere.test/x',
      rows: [],
      total: 0,
    });
    expect(r.outcome).toBe('source_unavailable');
    expect(reasonOf(r)).toBe('layout_changed');
    expect(again.served_from_cache).toBe(false);
  });

  it('record or results with nothing usable is layout_changed', async () => {
    for (const value of ['record', 'results']) {
      const { r } = await answered({ page: value, rows: [], total: 0 });
      expect(reasonOf(r)).toBe('layout_changed');
    }
  });

  it('an answer with no page value, no rows and no address is source_unavailable, never no_match', async () => {
    for (const result of [{ found: false, url: null, rows: [], total: 0 }, { rows: [], total: 0 }, {}, null]) {
      const { r } = await answered(result);
      expect(r.outcome).toBe('source_unavailable');
      expect(reasonOf(r)).toBe('layout_changed');
    }
  });

  it('a name search that listed rows and found no plausible one is a no_match that is not cached', async () => {
    const input = { name: 'Raj Patel', record_type: 'physician', jurisdiction: 'FL' };
    const { r, again } = await answered(
      { page: 'results', rows: [row('Zed Quux', 'ME000009', 'Miami')], total: 1 },
      input,
    );
    expect(r.outcome).toBe('no_match');
    expect(again.served_from_cache).toBe(false);
  });

  it('a name search whose page says none is a cached no_match', async () => {
    const input = { name: 'Raj Patel', record_type: 'physician', jurisdiction: 'FL' };
    const { r, again } = await answered({ page: 'none', rows: [], total: 0 }, input);
    expect(r.outcome).toBe('no_match');
    expect(again.served_from_cache).toBe(true);
  });

  it("an adapter that does not ask for a page keeps today's reading: empty rows are a no_match", async () => {
    registerAdapter('fl-mqa', linkAdapter('fl-mqa'));
    const started = await startCheck(env, env.DB, client(), NUMBER, 'public');
    await cont(client(), started.check_id, run('COMPLETED', { result: { rows: [], total: 0 } }));
    expect((await stored(started.check_id)).outcome).toBe('no_match');
  });
});

describe('cache, maintenance and budget', () => {
  it('serves a repeat check within ten minutes from the cache', async () => {
    registerAdapter('fl-mqa', linkAdapter('fl-mqa'));
    await upsertKey(env.DB, 'fl-mqa', 'ME123456', { licInd: '1', proCde: '2' });
    let fetches = 0;
    const c = client({
      fetchPages: async (u) => {
        fetches++;
        return { results: [{ url: u[0], text: page({ licence_number: 'ME123456' }) }], errors: [] };
      },
    });
    const input = { licence_number: 'me 123456', record_type: 'physician', jurisdiction: 'FL' };
    const first = await startCheck(env, env.DB, c, input, 'public');
    expect(first.outcome).toBe('match');
    const second = await startCheck(env, env.DB, c, input, 'public');
    expect(second.served_from_cache).toBe(true);
    expect(typeof second.cache_age_seconds).toBe('number');
    expect(fetches).toBe(1);
  });

  it('returns source_unavailable with retry_after during CSLB maintenance and enqueues nothing', async () => {
    const until = '2030-01-01T00:00:00.000Z';
    registerAdapter('ca-cslb', agentAdapter('ca-cslb', { maintenanceUntil: until }));
    let ran = false;
    const c = client({
      runAsync: async () => {
        ran = true;
        return { run_id: 'x' };
      },
    });
    const r = await startCheck(
      env,
      env.DB,
      c,
      { name: 'Raj Patel', record_type: 'contractor', jurisdiction: 'California' },
      'public',
    );
    expect(r.outcome).toBe('source_unavailable');
    expect(r.unavailable).toEqual({ reason: 'maintenance', message: expect.any(String), retry_after: until });
    expect(await jobs()).toEqual([]);
    expect(ran).toBe(false);
  });

  it('refuses a start the budget cannot pay for, with a reset time', async () => {
    registerAdapter('ca-cslb', agentAdapter('ca-cslb', { max_steps: 200 }));
    const r = await startCheck(
      env,
      env.DB,
      client(),
      { name: 'Raj Patel', record_type: 'contractor', jurisdiction: 'California' },
      'public',
    );
    expect(r.outcome).toBe('source_unavailable');
    expect(r.unavailable?.reason).toBe('budget');
    expect(typeof r.unavailable?.retry_after).toBe('string');
    expect(await jobs()).toEqual([]);
  });

  it('reports rate_limited with a one-minute retry when the queue is full', async () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      env.DB.prepare(
        "INSERT INTO queue (job_id, kind, priority, payload_json, state, bucket, reserved_cents, created_at) VALUES (?, 'canary', 3, NULL, 'pending', 'ops', 0, '2026-11-04T00:00:00.000Z')",
      ).bind(`filler_${i}`),
    );
    await env.DB.batch(rows);
    const r = await startCheck(
      env,
      env.DB,
      client(),
      { name: 'Raj Patel', record_type: 'contractor', jurisdiction: 'California' },
      'public',
    );
    expect(r.outcome).toBe('source_unavailable');
    expect(r.unavailable?.reason).toBe('rate_limited');
    expect(r.unavailable?.retry_after).toBeTruthy();
  });
});

describe('fetch path', () => {
  it('never stores raw page lines as discipline actions when the actions page does not parse', async () => {
    const base = linkAdapter('fl-mqa');
    registerAdapter('fl-mqa', {
      ...base,
      discipline: { kind: 'flag_then_fetch', url: () => 'https://fl-mqa.test/disciplinary-actions' },
    });
    await upsertKey(env.DB, 'fl-mqa', 'ME123456', { licInd: '1', proCde: '2' });
    const c = client({
      fetchPages: async (u) => {
        const text = u[0].includes('disciplinary-actions')
          ? page({ licence_number: 'ME123456', discipline_actions: [] })
          : page({ licence_number: 'ME123456', discipline_flag: true });
        return { results: [{ url: u[0], text }], errors: [] };
      },
    });
    const r = await startCheck(
      env,
      env.DB,
      c,
      { licence_number: 'ME123456', record_type: 'physician', jurisdiction: 'FL' },
      'public',
    );
    expect(r.outcome).toBe('match');
    const rec = r.records[0];
    expect(rec.discipline).toEqual({
      checked: false,
      on_file: true,
      actions: [],
      read_by: 'fetch',
      reason: 'actions page not parsed',
    });
    expect(rec.warnings).toContain('discipline_actions_unparsed');
  });

  it('finishes a known key at MQA by fetch, with two readers and no queued job', async () => {
    registerAdapter('fl-mqa', linkAdapter('fl-mqa'));
    await upsertKey(env.DB, 'fl-mqa', 'ME123456', { licInd: '1', proCde: '2' });
    const c = client({
      fetchPages: async (u) => ({ results: [{ url: u[0], text: page({ licence_number: 'ME123456' }) }], errors: [] }),
    });
    const r = await startCheck(
      env,
      env.DB,
      c,
      { licence_number: 'ME123456', record_type: 'physician', jurisdiction: 'FL' },
      'public',
    );
    expect(r.state).toBe('done');
    expect(r.outcome).toBe('match');
    expect(r.records[0].read_by).toBe('fetch');
    expect(r.records[0].verification.readers).toEqual(['parser_html', 'parser_text']);
    expect(await jobs()).toEqual([]);
    // The real MQA reader path is covered once the text parser lands in the MQA adapter tests; no test here yet.
  });

  it('stores a key learned from a search only when the record read agrees with the chosen licence', async () => {
    registerAdapter('fl-mqa', linkAdapter('fl-mqa'));
    const started = await startCheck(
      env,
      env.DB,
      client(),
      { name: 'Raj Patel', record_type: 'physician', jurisdiction: 'FL' },
      'public',
    );
    const link = { licInd: '1', proCde: '2' };
    const c = client({
      fetchPages: async (u) => ({ results: [{ url: u[0], text: page({ licence_number: 'ABC1' }) }], errors: [] }),
    });
    await cont(
      c,
      started.check_id,
      run('COMPLETED', { result: { rows: [{ ...row('Raj Patel', 'ABC1', 'Fresno'), link }] } }),
    );
    const r = await stored(started.check_id);
    expect(r.outcome).toBe('match');
    expect(await getKey(env.DB, 'fl-mqa', 'ABC1')).not.toBeNull();
  });

  it('answers needs_review with licence_number_mismatch and stores no key when the record is another licence', async () => {
    registerAdapter('fl-mqa', linkAdapter('fl-mqa'));
    const started = await startCheck(
      env,
      env.DB,
      client(),
      { name: 'Raj Patel', record_type: 'physician', jurisdiction: 'FL' },
      'public',
    );
    const link = { licInd: '1', proCde: '2' };
    const c = client({
      fetchPages: async (u) => ({ results: [{ url: u[0], text: page({ licence_number: 'XYZ9' }) }], errors: [] }),
    });
    await cont(
      c,
      started.check_id,
      run('COMPLETED', { result: { rows: [{ ...row('Raj Patel', 'ABC1', 'Fresno'), link }] } }),
    );
    const r = await stored(started.check_id);
    expect(r.outcome).toBe('needs_review');
    expect(r.readings?.every((x) => x.warnings.includes('licence_number_mismatch'))).toBe(true);
    expect(await getKey(env.DB, 'fl-mqa', 'ABC1')).toBeNull();
    expect(await getKey(env.DB, 'fl-mqa', 'XYZ9')).toBeNull();
  });

  it('searches once when a known link returns no record, and stores an empty link', async () => {
    registerAdapter('fl-mqa', linkAdapter('fl-mqa'));
    await upsertKey(env.DB, 'fl-mqa', 'ME123456', { licInd: '1', proCde: '2' });
    const c = client({
      fetchPages: async () => ({ results: [], errors: [{ url: 'x', code: 'not_found', message: 'gone' }] }),
    });
    const r = await startCheck(
      env,
      env.DB,
      c,
      { licence_number: 'ME123456', record_type: 'physician', jurisdiction: 'FL' },
      'public',
    );
    expect(r.state).toBe('searching');
    expect((await jobs()).map((j) => j.kind)).toEqual(['search']);
    const key = await getKey(env.DB, 'fl-mqa', 'ME123456');
    expect(key?.link_json).toBe('{}');
  });
});

describe('agent search and record path', () => {
  it('maps a failed search run with a captcha message to captcha', async () => {
    const started = await startCheck(
      env,
      env.DB,
      client(),
      { name: 'Raj Patel', record_type: 'contractor', jurisdiction: 'California' },
      'public',
    );
    expect(started.state).toBe('searching');
    await cont(
      client(),
      started.check_id,
      run('FAILED', { error: { code: 'AGENT_FAILURE', message: 'CAPTCHA page' } }),
    );
    const r = await stored(started.check_id);
    expect(r.state).toBe('done');
    expect(r.outcome).toBe('source_unavailable');
    expect(r.unavailable?.reason).toBe('captcha');
  });

  it('marks more than 25 matching rows as multiple_matches with 25 candidates and a city disambiguator', async () => {
    const started = await startCheck(
      env,
      env.DB,
      client(),
      { name: 'Raj Patel', record_type: 'contractor', jurisdiction: 'California' },
      'public',
    );
    const rows = Array.from({ length: 91 }, (_, i) =>
      row('Raj Patel', String(1000 + i), i % 2 === 0 ? 'Fresno' : 'Miami'),
    );
    await cont(client(), started.check_id, run('COMPLETED', { result: { rows } }));
    const r = await stored(started.check_id);
    expect(r.outcome).toBe('multiple_matches');
    expect(r.candidates.length).toBe(25);
    expect(r.disambiguators).toContain('city');
  });

  it('enqueues one record job and reads the record when a single row plausibly matches', async () => {
    const started = await startCheck(
      env,
      env.DB,
      client(),
      { name: 'Raj Patel', record_type: 'contractor', jurisdiction: 'California' },
      'public',
    );
    await cont(
      client(),
      started.check_id,
      run('COMPLETED', { result: { rows: [row('Raj Patel', '1234567', 'Fresno')] } }),
    );
    const r = await stored(started.check_id);
    expect(r.state).toBe('reading');
    expect(await jobs()).toEqual([
      { kind: 'search', state: 'pending' },
      { kind: 'record', state: 'pending' },
    ]);
  });

  it('reads the record page from the last step that has a capture, and takes the no-capture branch when none has', async () => {
    const started = await startCheck(
      env,
      env.DB,
      client(),
      { name: 'Raj Patel', record_type: 'contractor', jurisdiction: 'California' },
      'public',
    );
    await cont(
      client(),
      started.check_id,
      run('COMPLETED', { result: { rows: [row('Raj Patel', '1234567', 'Fresno')] } }),
    );
    const seen: string[][] = [];
    const c = client({
      stepHtml: async (runId: string, stepId: string) => {
        seen.push([runId, stepId]);
        return page();
      },
    });
    const steps = [
      { step_id: 's1', has_html: true, has_screenshot: true },
      { step_id: 's2', has_html: true, has_screenshot: true },
      { step_id: 's3', has_html: true, has_screenshot: true },
      { step_id: 'closing', has_html: false, has_screenshot: false },
    ];
    await cont(c, started.check_id, run('COMPLETED', { run_id: 'run_rec', steps, result: { fields: fieldsOf() } }));
    expect(seen).toEqual([['run_rec', 's3']]);

    // No capture at all: no page is asked for, and the single agent reading goes to review.
    const none = await startCheck(
      env,
      env.DB,
      client(),
      { name: 'Dana Wu', record_type: 'contractor', jurisdiction: 'California' },
      'judge',
    );
    await cont(
      client(),
      none.check_id,
      run('COMPLETED', { run_id: 'run_s2', result: { rows: [row('Dana Wu', '7654321', 'Fresno')] } }),
      'judge',
    );
    seen.length = 0;
    await cont(
      c,
      none.check_id,
      run('COMPLETED', {
        run_id: 'run_none',
        steps: [{ step_id: 'closing', has_html: false, has_screenshot: false }],
        result: { fields: fieldsOf({ name: 'Dana Wu', licence_number: '7654321' }) },
      }),
      'judge',
    );
    expect(seen).toEqual([]);
    const r = await stored(none.check_id);
    expect(r.outcome).toBe('needs_review');
    expect(r.readings?.map((x) => x.reader)).toEqual(['agent_output']);
  });

  it('walks back past a 404 step to the record page, and reviews on one reader when no page is readable', async () => {
    const started = await startCheck(
      env,
      env.DB,
      client(),
      { name: 'Raj Patel', record_type: 'contractor', jurisdiction: 'California' },
      'public',
    );
    await cont(
      client(),
      started.check_id,
      run('COMPLETED', { result: { rows: [row('Raj Patel', '1234567', 'Fresno')] } }),
    );
    const seen: string[] = [];
    const c = client({
      stepHtml: async (_runId: string, stepId: string) => {
        seen.push(stepId);
        if (stepId === 's3') throw new TinyFishError('not_found', 404, 'gone');
        return page();
      },
    });
    const steps = [{ step_id: 's1' }, { step_id: 's2' }, { step_id: 's3' }, { step_id: 'closing', has_html: false }];
    await cont(c, started.check_id, run('COMPLETED', { run_id: 'run_wb', steps, result: { fields: fieldsOf() } }));
    expect(seen).toEqual(['s3', 's2']);
    const snap = await env.DB.prepare('SELECT step_id FROM snapshots WHERE check_id = ?')
      .bind(started.check_id)
      .first<{ step_id: string }>();
    expect(snap?.step_id).toBe('s2');

    const none = await startCheck(
      env,
      env.DB,
      client(),
      { name: 'Dana Wu', record_type: 'contractor', jurisdiction: 'California' },
      'judge',
    );
    await cont(
      client(),
      none.check_id,
      run('COMPLETED', { run_id: 'run_s2', result: { rows: [row('Dana Wu', '7654321', 'Fresno')] } }),
      'judge',
    );
    const gone = client({
      stepHtml: async () => {
        throw new TinyFishError('not_found', 404, 'gone');
      },
    });
    await cont(
      gone,
      none.check_id,
      run('COMPLETED', {
        run_id: 'run_gone',
        steps: [{ step_id: 'x' }, { step_id: 'y' }],
        result: { fields: fieldsOf({ name: 'Dana Wu', licence_number: '7654321' }) },
      }),
      'judge',
    );
    const r = await stored(none.check_id);
    expect(r.outcome).toBe('needs_review');
    expect(r.readings?.map((x) => x.reader)).toEqual(['agent_output']);
  });

  it('returns needs_review with three readings when the agent status disagrees with both parsers', async () => {
    const started = await startCheck(
      env,
      env.DB,
      client(),
      { name: 'Raj Patel', record_type: 'contractor', jurisdiction: 'California' },
      'public',
    );
    await cont(
      client(),
      started.check_id,
      run('COMPLETED', { result: { rows: [row('Raj Patel', '1234567', 'Fresno')] } }),
    );
    const c = client({ stepHtml: async () => page({ status: 'active', status_raw: 'Active' }) });
    await cont(
      c,
      started.check_id,
      run('COMPLETED', {
        run_id: 'run_record',
        result: { fields: fieldsOf({ status: 'suspended', status_raw: 'Suspended' }) },
      }),
    );
    const r = await stored(started.check_id);
    expect(r.state).toBe('done');
    expect(r.outcome).toBe('needs_review');
    expect(r.readings).toHaveLength(3);
    expect(r.readings?.map((x) => x.reader)).toEqual(['parser_html', 'parser_text', 'agent_output']);
  });

  it('refines a multiple_matches result by candidate and reaches done', async () => {
    const started = await startCheck(
      env,
      env.DB,
      client(),
      { name: 'Raj Patel', record_type: 'contractor', jurisdiction: 'California' },
      'public',
    );
    await cont(
      client(),
      started.check_id,
      run('COMPLETED', { result: { rows: [row('Raj Patel', 'A1', 'Fresno'), row('Raj Patel', 'A2', 'Miami')] } }),
    );
    const multi = await stored(started.check_id);
    expect(multi.outcome).toBe('multiple_matches');

    const refined = await refine(
      client({ stepHtml: async () => page({ licence_number: 'A1' }) }),
      started.check_id,
      'cand_1',
    );
    expect(refined.state).toBe('reading');
    expect(refined.check_id).not.toBe(started.check_id);

    await cont(
      client({ stepHtml: async () => page({ licence_number: 'A1' }) }),
      refined.check_id,
      run('COMPLETED', { run_id: 'run_refine', result: { fields: fieldsOf({ licence_number: 'A1' }) } }),
    );
    const done = await stored(refined.check_id);
    expect(done.state).toBe('done');
    expect(done.outcome).toBe('match');
    expect(done.records).toHaveLength(1);
  });

  it('answers invalid_input for a refine with a candidate_id the check does not hold', async () => {
    const started = await startCheck(
      env,
      env.DB,
      client(),
      { name: 'Raj Patel', record_type: 'contractor', jurisdiction: 'California' },
      'public',
    );
    await cont(
      client(),
      started.check_id,
      run('COMPLETED', { result: { rows: [row('Raj Patel', 'A1', 'Fresno'), row('Raj Patel', 'A2', 'Miami')] } }),
    );
    const r = await refine(client(), started.check_id, 'cand_99');
    expect(r.outcome).toBe('invalid_input');
    expect(r.invalid?.field).toBe('candidate_id');
  });
});

describe('search continuation with a watch', () => {
  it('hands a search run that carries a watch_id to resolveWatchFromSearch', async () => {
    const fn = continuations.get('search');
    expect(fn).toBeDefined();
    const job = {
      job_id: 'job_w',
      kind: 'search',
      priority: 2,
      bucket: 'ops',
      reserved_cents: 0,
      payload: {
        watch_id: 'w_1',
        registry: 'ca-cslb',
        request: { url: 'https://x.test', goal: 'y', output_schema: {} },
      },
    } as unknown as Job;
    const outcome = run('COMPLETED', { result: { rows: [] } });
    await fn!(env, env.DB, client(), job, outcome);
    const calls = vi.mocked(resolveWatchFromSearch).mock.calls;
    const call = calls[calls.length - 1];
    expect(calls).toHaveLength(1);
    expect(call[0]).toBe(env);
    expect(call[3]).toBe(job);
    expect(call[4]).toBe(outcome);
  });
});

describe('agent-read records, stage guards and DBPR complaint runs', () => {
  it('finds a number-only search row by its licence number and reaches match', async () => {
    registerAdapter('fl-mqa', linkAdapter('fl-mqa'));
    const link = { licInd: '1', proCde: '2' };
    const started = await startCheck(
      env,
      env.DB,
      client(),
      { licence_number: 'ME123456', record_type: 'physician', jurisdiction: 'FL' },
      'public',
    );
    expect(started.state).toBe('searching');
    const c = client({
      fetchPages: async (u) => ({ results: [{ url: u[0], text: page({ licence_number: 'ME123456' }) }], errors: [] }),
    });
    await cont(
      c,
      started.check_id,
      run('COMPLETED', { result: { rows: [{ ...row('Raj Patel', 'ME123456', 'Fresno'), link }] } }),
    );
    const r = await stored(started.check_id);
    expect(r.outcome).toBe('match');
  });

  it("names the search run that found a record in the record's evidence", async () => {
    registerAdapter('fl-mqa', linkAdapter('fl-mqa'));
    const link = { licInd: '1', proCde: '2' };
    const started = await startCheck(
      env,
      env.DB,
      client(),
      { licence_number: 'ME123456', record_type: 'physician', jurisdiction: 'FL' },
      'public',
    );
    const c = client({
      fetchPages: async (u) => ({ results: [{ url: u[0], text: page({ licence_number: 'ME123456' }) }], errors: [] }),
    });
    await cont(
      c,
      started.check_id,
      run('COMPLETED', {
        run_id: 'run_search_1',
        result: { rows: [{ ...row('Raj Patel', 'ME123456', 'Fresno'), link }] },
      }),
    );
    const r = await stored(started.check_id);
    expect(r.outcome).toBe('match');
    expect(r.records[0].evidence.tinyfish_run_id).toBe('run_search_1');
    expect(r.records[0].read_by).toBe('fetch');
  });

  it('leaves tinyfish_run_id null when the record address came from the stored key map', async () => {
    registerAdapter('fl-mqa', linkAdapter('fl-mqa'));
    await upsertKey(env.DB, 'fl-mqa', 'ME123456', { licInd: '1', proCde: '2' });
    const c = client({
      fetchPages: async (u) => ({ results: [{ url: u[0], text: page({ licence_number: 'ME123456' }) }], errors: [] }),
    });
    const started = await startCheck(
      env,
      env.DB,
      c,
      { licence_number: 'ME123456', record_type: 'physician', jurisdiction: 'FL' },
      'public',
    );
    const r = started.state === 'done' ? started : await stored(started.check_id);
    expect(r.outcome).toBe('match');
    expect(r.records[0].evidence.tinyfish_run_id).toBeNull();
  });

  it('answers no_match when a number-only search finds a different licence', async () => {
    registerAdapter('fl-mqa', linkAdapter('fl-mqa'));
    const link = { licInd: '1', proCde: '2' };
    const started = await startCheck(
      env,
      env.DB,
      client(),
      { licence_number: 'ME123456', record_type: 'physician', jurisdiction: 'FL' },
      'public',
    );
    await cont(
      client(),
      started.check_id,
      run('COMPLETED', { result: { rows: [{ ...row('Raj Patel', 'ME999999', 'Fresno'), link }] } }),
    );
    const r = await stored(started.check_id);
    expect(r.outcome).toBe('no_match');
  });

  describe('a refused start', () => {
    const MESSAGE = 'The check could not be started. This is a fault in TinyVerify, not in the registry.';

    it('answers source_unavailable with the fault wording for a refused search run', async () => {
      const started = await startCheck(
        env,
        env.DB,
        client(),
        { name: 'Raj Patel', record_type: 'contractor', jurisdiction: 'California' },
        'public',
      );
      expect(started.state).toBe('searching');
      await cont(client(), started.check_id, { reason: 'start_refused' });
      const r = await stored(started.check_id);
      expect(r.outcome).toBe('source_unavailable');
      expect(r.unavailable?.message).toBe(MESSAGE);
    });

    it('answers source_unavailable with the fault wording for a refused record run', async () => {
      const started = await startCheck(
        env,
        env.DB,
        client(),
        { licence_number: '1234567', record_type: 'contractor', jurisdiction: 'California' },
        'public',
      );
      expect(started.state).toBe('reading');
      await cont(client(), started.check_id, { reason: 'start_refused' });
      const r = await stored(started.check_id);
      expect(r.outcome).toBe('source_unavailable');
      expect(r.unavailable?.message).toBe(MESSAGE);
    });
  });

  describe('stage guard', () => {
    const lookup = () =>
      startCheck(
        env,
        env.DB,
        client(),
        { licence_number: '1234567', record_type: 'contractor', jurisdiction: 'California' },
        'public',
      );

    it('ignores a search-kind run for a check already reading, with one console.warn and no change', async () => {
      const started = await lookup();
      expect(started.state).toBe('reading');
      const before = (await getCheck(env.DB, started.check_id))?.result_json;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await continueCheck(
          env,
          env.DB,
          client(),
          started.check_id,
          run('COMPLETED', { result: { rows: [] } }),
          'public',
          'search',
        );
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
      expect((await getCheck(env.DB, started.check_id))?.result_json).toBe(before);
      expect((await stored(started.check_id)).state).toBe('reading');
    });

    it('ignores a record-kind run for a check still searching', async () => {
      const started = await startCheck(
        env,
        env.DB,
        client(),
        { name: 'Raj Patel', record_type: 'contractor', jurisdiction: 'California' },
        'public',
      );
      expect(started.state).toBe('searching');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await continueCheck(
          env,
          env.DB,
          client(),
          started.check_id,
          run('COMPLETED', { result: { rows: [] } }),
          'public',
          'record',
        );
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
      expect((await stored(started.check_id)).state).toBe('searching');
    });

    it('lets a record-kind run finish a reading check', async () => {
      const started = await lookup();
      await continueCheck(
        env,
        env.DB,
        client(),
        started.check_id,
        run('COMPLETED', { result: { fields: fieldsOf({ licence_number: '1234567' }) } }),
        'public',
        'record',
      );
      expect((await stored(started.check_id)).state).toBe('done');
    });
  });

  it('sends a licence lookup at an agent-record registry straight to the record run', async () => {
    const r = await startCheck(
      env,
      env.DB,
      client(),
      { licence_number: '1234567', record_type: 'contractor', jurisdiction: 'California' },
      'public',
    );
    expect(r.state).toBe('reading');
    expect(await jobs()).toEqual([{ kind: 'record', state: 'pending' }]);
  });

  it('answers needs_review with licence_number_mismatch and stores no key when an agent record is another licence', async () => {
    const started = await startCheck(
      env,
      env.DB,
      client(),
      { licence_number: '1234567', record_type: 'contractor', jurisdiction: 'California' },
      'public',
    );
    const c = client({ stepHtml: async () => page({ licence_number: '9999999' }) });
    await cont(
      c,
      started.check_id,
      run('COMPLETED', { run_id: 'run_m', result: { fields: fieldsOf({ licence_number: '9999999' }) } }),
    );
    const r = await stored(started.check_id);
    expect(r.outcome).toBe('needs_review');
    expect(r.readings?.every((x) => x.warnings.includes('licence_number_mismatch'))).toBe(true);
    expect(await getKey(env.DB, 'ca-cslb', '1234567')).toBeNull();
    expect(await getKey(env.DB, 'ca-cslb', '9999999')).toBeNull();
  });

  it('reads DBPR complaints with a discipline run and then finishes the check', async () => {
    registerAdapter('fl-dbpr', complaintAdapter());
    await upsertKey(env.DB, 'fl-dbpr', 'CMC1', { id: '1' });
    const c = client({
      fetchPages: async (u) => ({ results: [{ url: u[0], text: page({ licence_number: 'CMC1' }) }], errors: [] }),
      stepHtml: async (_run, step) => (step === 'rec' ? page({ licence_number: 'CMC1' }) : viewPage(1)),
    });
    const started = await startCheck(
      env,
      env.DB,
      c,
      { licence_number: 'CMC1', record_type: 'contractor', jurisdiction: 'FL' },
      'public',
    );
    expect(started.state).toBe('reading');
    expect((await jobs()).map((j) => j.kind)).toContain('discipline');
    await cont(
      c,
      started.check_id,
      viewRun({
        run_id: 'run_c',
        result: {
          complaints: [{ case_number: 'C-1', status: 'Open', date: '2025-01-02', description: 'Late filing' }],
          complaint_view_opened: true,
          evidence_line: 'C-1 Open 2025-01-02 Late filing',
        },
      }),
    );
    const r = await stored(started.check_id);
    expect(r.state).toBe('done');
    expect(r.outcome).toBe('match');
    expect(r.records[0].discipline).toMatchObject({
      checked: true,
      on_file: true,
      actions: ['C-1, 2025-01-02, Open: x'],
      read_by: 'both_readers',
    });
  });

  describe('stage guard', () => {
    const adapterWithComplaints = () => registerAdapter('fl-dbpr', complaintAdapter());
    const withKind = (c: TinyFish, check_id: string, outcome: JobOutcome, kind: 'record' | 'discipline') =>
      continueCheck(env, env.DB, c, check_id, outcome, 'public', kind);

    it('ignores a record run for a check that already holds its record', async () => {
      adapterWithComplaints();
      await upsertKey(env.DB, 'fl-dbpr', 'CMC1', { id: '1' });
      const c = client({
        fetchPages: async (u) => ({ results: [{ url: u[0], text: page({ licence_number: 'CMC1' }) }], errors: [] }),
      });
      const started = await startCheck(
        env,
        env.DB,
        c,
        { licence_number: 'CMC1', record_type: 'contractor', jurisdiction: 'FL' },
        'public',
      );
      expect((await stored(started.check_id)).records).toHaveLength(1);
      const before = (await getCheck(env.DB, started.check_id))?.result_json;
      const opened = { complaints: [], complaint_view_opened: true, evidence_line: 'No complaints on file' };
      await withKind(c, started.check_id, viewRun({ run_id: 'run_late', result: opened }), 'record');
      expect((await getCheck(env.DB, started.check_id))?.result_json).toBe(before);
      expect((await stored(started.check_id)).state).toBe('reading');
    });

    it('ignores a discipline run for a check that has no record yet', async () => {
      const started = await startCheck(
        env,
        env.DB,
        client(),
        { name: 'Raj Patel', record_type: 'contractor', jurisdiction: 'California' },
        'public',
      );
      await cont(client(), started.check_id, viewRun({ result: { rows: [row('Raj Patel', '1234567', 'Fresno')] } }));
      const before = (await getCheck(env.DB, started.check_id))?.result_json;
      expect((await stored(started.check_id)).records).toHaveLength(0);
      await withKind(
        client(),
        started.check_id,
        viewRun({ run_id: 'run_early', result: { fields: fieldsOf() } }),
        'discipline',
      );
      expect((await getCheck(env.DB, started.check_id))?.result_json).toBe(before);
    });
  });

  describe('DBPR complaint run proof', () => {
    const adapterWithComplaints = () => registerAdapter('fl-dbpr', complaintAdapter());
    const startDbpr = async (c: TinyFish) => {
      await upsertKey(env.DB, 'fl-dbpr', 'CMC1', { id: '1' });
      return startCheck(
        env,
        env.DB,
        c,
        { licence_number: 'CMC1', record_type: 'contractor', jurisdiction: 'FL' },
        'public',
      );
    };
    const pageClient = (over: Partial<Parameters<typeof client>[0]> = {}) =>
      client({
        fetchPages: async (u: string[]) => ({
          results: [{ url: u[0], text: page({ licence_number: 'CMC1' }) }],
          errors: [],
        }),
        ...over,
        stepHtml: async (runId: string, stepId: string) =>
          stepId === RECORD_STEP.step_id
            ? page({ licence_number: 'CMC1' })
            : (over.stepHtml ?? (async () => page()))(runId, stepId),
      });
    const snapshotsFor = async (check_id: string) =>
      (
        await env.DB.prepare(
          'SELECT snapshot_id, reader_input, body, run_id, step_id, url FROM snapshots WHERE check_id = ? ORDER BY created_at',
        )
          .bind(check_id)
          .all<{
            snapshot_id: string;
            reader_input: string;
            body: string;
            run_id: string | null;
            step_id: string | null;
            url: string;
          }>()
      ).results;
    const opened = (over: Record<string, unknown> = {}) => ({
      complaints: [],
      complaint_view_opened: true,
      evidence_line: 'No complaints on file',
      ...over,
    });

    describe('the record shows while complaints are being checked', () => {
      const PENDING_DISCIPLINE = {
        checked: false,
        on_file: null,
        actions: [],
        read_by: null,
        reason: 'Complaint check in progress.',
      };
      const getVerify = (check_id: string) => app.request(`/verify/${check_id}`, {}, env as never);

      it('GET /verify/:id returns the record with state reading, pending complaints and no outcome while the complaint run is in flight', async () => {
        adapterWithComplaints();
        const started = await startDbpr(pageClient());
        const res = await getVerify(started.check_id);
        const body = (await res.json()) as VerifyResult;
        expect(res.status).toBe(202);
        expect(body.state).toBe('reading');
        expect(body.outcome).toBeNull();
        expect(body.pending).toEqual(['complaints']);
        expect(body.records).toHaveLength(1);
        expect(body.records[0].key.licence_number).toBe('CMC1');
        expect(body.records[0].discipline).toEqual(PENDING_DISCIPLINE);
        expect(body.checked_at).toBeNull();
      });

      it('the POST answer for the same lookup carries the same partial record', async () => {
        adapterWithComplaints();
        const started = await startDbpr(pageClient());
        expect(started.state).toBe('reading');
        expect(started.pending).toEqual(['complaints']);
        expect(started.records[0].discipline).toEqual(PENDING_DISCIPLINE);
      });

      it('the final result replaces it, with the final record and an empty pending list', async () => {
        adapterWithComplaints();
        const c = pageClient({ stepHtml: async () => viewPage() });
        const started = await startDbpr(c);
        await cont(c, started.check_id, viewRun({ run_id: 'run_c', result: opened() }));
        const body = (await (await getVerify(started.check_id)).json()) as VerifyResult;
        expect(body.state).toBe('done');
        expect(body.outcome).toBe('match');
        expect(body.pending).toEqual([]);
        expect(body.records[0].discipline.reason).toBeUndefined();
      });

      it('an empty pending list also ends a check whose complaint run could not be read', async () => {
        adapterWithComplaints();
        const c = pageClient();
        const started = await startDbpr(c);
        await cont(c, started.check_id, { reason: 'start_refused' });
        const r = await stored(started.check_id);
        expect(r.state).toBe('done');
        expect(r.pending).toEqual([]);
        expect(r.warnings).toContain('complaints_not_checked');
      });

      it('a second POST of the same lookup inside that window does not return the partial as a cached result', async () => {
        adapterWithComplaints();
        const c = pageClient();
        const first = await startDbpr(c);
        const second = await startCheck(
          env,
          env.DB,
          c,
          { licence_number: 'CMC1', record_type: 'contractor', jurisdiction: 'FL' },
          'public',
        );
        expect(second.served_from_cache).toBe(false);
        expect(second.check_id).not.toBe(first.check_id);
        expect(second.state).toBe('reading');
        expect(second.outcome).toBeNull();
      });

      it('once the check is done the lookup is served from the cache with its empty pending list', async () => {
        adapterWithComplaints();
        const c = pageClient({ stepHtml: async () => viewPage() });
        const first = await startDbpr(c);
        await cont(c, first.check_id, viewRun({ run_id: 'run_c', result: opened() }));
        const again = await startCheck(
          env,
          env.DB,
          c,
          { licence_number: 'CMC1', record_type: 'contractor', jurisdiction: 'FL' },
          'public',
        );
        expect(again.served_from_cache).toBe(true);
        expect(again.pending).toEqual([]);
      });
    });

    describe('the captured page decides the complaint answer', () => {
      const oneComplaint = { case_number: 'C-1', status: 'Open', date: '2025-01-02', description: 'x' };
      const pageOnly = (html: string) => pageClient({ stepHtml: async () => html });
      const finish = async (c: TinyFish, result: Record<string, unknown>, steps?: { step_id: string }[]) => {
        const started = await startDbpr(c);
        await cont(c, started.check_id, viewRun({ result, ...(steps ? { steps } : {}) }));
        return stored(started.check_id);
      };

      it('starts the complaint run at the record link, not the search form', async () => {
        adapterWithComplaints();
        await startDbpr(pageClient());
        const row = await env.DB.prepare("SELECT payload_json FROM queue WHERE kind = 'discipline'").first<{
          payload_json: string;
        }>();
        expect((JSON.parse(row?.payload_json ?? 'null') as { request: { url: string } }).request.url).toBe(
          'https://fl-dbpr.test/record',
        );
      });

      it('reads none on file when the page has 0 rows and the run listed none', async () => {
        adapterWithComplaints();
        const r = await finish(pageOnly(viewPage(0)), opened({ evidence_line: '' }));
        expect(r.records[0].discipline).toMatchObject({
          checked: true,
          on_file: false,
          actions: [],
          read_by: 'both_readers',
        });
        expect(r.warnings ?? []).not.toContain('complaints_not_checked');
        expect(r.warnings ?? []).not.toContain('agent_answer_differs');
      });

      it('takes the actions from the page rows when both counts are 1', async () => {
        adapterWithComplaints();
        const r = await finish(
          pageOnly(viewPage(1)),
          opened({ complaints: [{ ...oneComplaint, description: 'agent words' }], evidence_line: '' }),
        );
        expect(r.records[0].discipline).toMatchObject({
          checked: true,
          on_file: true,
          actions: ['C-1, 2025-01-02, Open: x'],
        });
        expect(r.warnings ?? []).not.toContain('agent_answer_differs');
      });

      it.each([
        [
          'says the view was not opened and listed none',
          { complaints: [], complaint_view_opened: false, evidence_line: '' },
        ],
        ['has no complaint_view_opened', { complaints: [] }],
        [
          'has the text "true" for complaint_view_opened',
          { complaints: [], complaint_view_opened: 'true', evidence_line: 'x' },
        ],
        ['has null for complaint_view_opened', { complaints: [], complaint_view_opened: null, evidence_line: '' }],
        ['listed none', opened({ evidence_line: '' })],
      ])('keeps the page answer of 1 complaint, with agent_answer_differs, when the run %s', async (_label, result) => {
        adapterWithComplaints();
        const r = await finish(pageOnly(viewPage(1)), result);
        expect(r.records[0].discipline).toMatchObject({
          checked: true,
          on_file: true,
          actions: ['C-1, 2025-01-02, Open: x'],
          read_by: 'both_readers',
        });
        expect(r.records[0].warnings).toContain('agent_answer_differs');
        expect(r.warnings).toContain('agent_answer_differs');
        expect(r.warnings).not.toContain('complaints_not_checked');
      });

      it('keeps the page answer of none on file, with agent_answer_differs, when the run listed 1 and the page has 0 rows', async () => {
        adapterWithComplaints();
        const r = await finish(pageOnly(viewPage(0)), opened({ complaints: [oneComplaint], evidence_line: '' }));
        expect(r.records[0].discipline).toMatchObject({ checked: true, on_file: false, actions: [] });
        expect(r.warnings).toContain('agent_answer_differs');
      });

      it.each([
        ['a text', 'none'],
        ['null', null],
        ['an object', {}],
        ['missing', undefined],
      ])(
        'keeps the page answer, with agent_answer_differs, when the run answered complaints as %s',
        async (_label, value) => {
          adapterWithComplaints();
          const result: Record<string, unknown> = { complaint_view_opened: true, evidence_line: '' };
          if (value !== undefined) result.complaints = value;
          const r = await finish(pageOnly(viewPage(0)), result);
          expect(r.records[0].discipline).toMatchObject({
            checked: true,
            on_file: false,
            actions: [],
            read_by: 'both_readers',
          });
          expect(r.warnings).toContain('agent_answer_differs');
        },
      );

      it('marks complaints not checked when the page is not the complaint view', async () => {
        adapterWithComplaints();
        const r = await finish(pageOnly('licence page'), opened({ evidence_line: '' }));
        expect(r.records[0].discipline).toMatchObject({
          checked: false,
          on_file: null,
          read_by: null,
          reason: 'complaint page not captured',
        });
        expect(r.records[0].warnings).toContain('complaints_not_checked');
      });

      it('finds the complaint view one step before a record page that the run ended on', async () => {
        adapterWithComplaints();
        const pages: Record<string, string> = { a: viewPage(1), b: 'licence page' };
        const c = pageClient({ stepHtml: async (_run: string, step: string) => pages[step] });
        const r = await finish(c, opened({ complaints: [oneComplaint], evidence_line: '' }), [
          RECORD_STEP,
          { step_id: 'a' },
          { step_id: 'b' },
        ]);
        expect(r.records[0].discipline).toMatchObject({
          checked: true,
          on_file: true,
          actions: ['C-1, 2025-01-02, Open: x'],
        });
        const snap = (await snapshotsFor(r.check_id)).find(
          (x) => x.snapshot_id === r.records[0].discipline.snapshot_id,
        );
        expect(snap).toMatchObject({ step_id: 'a', body: viewPage(1) });
      });

      it('gives up after 4 snapshots that are not the complaint view', async () => {
        adapterWithComplaints();
        const seen: string[] = [];
        const c = pageClient({
          stepHtml: async (_run: string, step: string) => {
            seen.push(step);
            return step === 'first' ? viewPage(1) : 'licence page';
          },
        });
        const steps = ['first', 'a', 'b', 'c', 'd'].map((step_id) => ({ step_id }));
        const r = await finish(c, opened({ complaints: [oneComplaint], evidence_line: '' }), steps);
        expect(seen).toEqual(['d', 'c', 'b', 'a']);
        expect(r.records[0].discipline).toMatchObject({
          checked: false,
          on_file: null,
          actions: [],
          read_by: null,
          reason: 'complaint page not captured',
        });
        expect(r.records[0].warnings).toContain('complaints_not_checked');
      });

      it('marks complaints not checked, with complaint_readers_disagree, when the two readers count different rows', async () => {
        adapterWithComplaints();
        const r = await finish(
          pageOnly(viewPage(2, 'ROWBAD')),
          opened({ complaints: [oneComplaint, oneComplaint, oneComplaint], evidence_line: '' }),
        );
        expect(r.records[0].discipline).toMatchObject({ checked: false, on_file: null, actions: [], read_by: null });
        expect(r.records[0].warnings).toEqual(
          expect.arrayContaining(['complaints_not_checked', 'complaint_readers_disagree']),
        );
        expect(r.warnings).toEqual(expect.arrayContaining(['complaints_not_checked', 'complaint_readers_disagree']));
      });

      describe('the complaint view must belong to the licence being checked', () => {
        const NOT_TIED = 'complaint page not tied to the licence';
        const other = page({ licence_number: 'CMC9' });
        // Snapshots in run order, each a page; the last one is the complaint view.
        const withPages = (pages: Record<string, string>, seen: string[] = []) =>
          pageClient({
            stepHtml: async (_run: string, step: string) => {
              seen.push(step);
              return pages[step] ?? 'licence page';
            },
          });
        const ids = (...names: string[]) => names.map((step_id) => ({ step_id }));
        const refusedWith = async (r: VerifyResult, result: Record<string, unknown>) => {
          expect(r.records[0].discipline).toMatchObject({
            checked: false,
            on_file: null,
            actions: [],
            read_by: null,
            reason: NOT_TIED,
          });
          expect(r.records[0].warnings).toContain('complaints_not_checked');
          const snap = (await snapshotsFor(r.check_id)).find(
            (x) => x.snapshot_id === r.records[0].discipline.snapshot_id,
          );
          expect(JSON.parse(snap?.body ?? 'null')).toEqual(result);
          expect(r.records[0].discipline.screenshot_url).toBeNull();
        };

        it('accepts the view after the record page of this licence although the run said it did not open it', async () => {
          adapterWithComplaints();
          const r = await finish(pageOnly(viewPage(1)), {
            complaints: [],
            complaint_view_opened: false,
            evidence_line: '',
          });
          expect(r.records[0].discipline).toMatchObject({ checked: true, on_file: true, read_by: 'both_readers' });
          expect(r.records[0].warnings).toContain('agent_answer_differs');
        });

        it('refuses the view after the record page of a different licence number', async () => {
          adapterWithComplaints();
          const result = opened({ evidence_line: '' });
          const r = await finish(withPages({ other, view: viewPage(1) }), result, ids('other', 'view'));
          await refusedWith(r, result);
        });

        it('refuses the view when a results list lies between the record page and the view', async () => {
          adapterWithComplaints();
          const result = opened({ evidence_line: '' });
          const r = await finish(withPages({ results: 'RESULTS', view: viewPage(1) }), result, [
            RECORD_STEP,
            ...ids('results', 'view'),
          ]);
          await refusedWith(r, result);
        });

        it('refuses the view when no snapshot before it is a record page', async () => {
          adapterWithComplaints();
          const result = opened({ evidence_line: '' });
          const r = await finish(withPages({ view: viewPage(1) }), result, ids('a', 'b', 'view'));
          await refusedWith(r, result);
        });

        it('reads only the nearest snapshot that has a capture, and refuses when that one is not the licence page', async () => {
          adapterWithComplaints();
          const result = opened({ evidence_line: '' });
          const seen: string[] = [];
          const far = [RECORD_STEP, ...ids('a', 'b', 'c', 'view')];
          const r = await finish(withPages({ view: viewPage(1) }, seen), result, far);
          expect(seen).toEqual(['view', 'c']);
          await refusedWith(r, result);
        });

        it('refuses the view when the snapshot just before it answers 404, although the record page lies before that', async () => {
          adapterWithComplaints();
          const result = opened({ evidence_line: '' });
          const gone = pageClient({
            stepHtml: async (_run: string, step: string) => {
              if (step === 'gap') throw new TinyFishError('not_found', 404, 'gone');
              return step === 'view' ? viewPage(1) : page({ licence_number: 'CMC1' });
            },
          });
          const r = await finish(gone, result, [RECORD_STEP, ...ids('gap', 'view')]);
          await refusedWith(r, result);
        });

        it('refuses the view when a step between the record page and the view has no capture', async () => {
          adapterWithComplaints();
          const result = opened({ complaints: [oneComplaint], evidence_line: '' });
          const steps = [RECORD_STEP, { step_id: 'gap', has_html: false, has_screenshot: false }, { step_id: 'view' }];
          await refusedWith(await finish(withPages({ view: viewPage(1) }), result, steps), result);
        });

        // Seen on live runs: the agent stays on the complaint view for several steps.
        it('accepts the view when earlier captures of the same view lie between it and the record page', async () => {
          adapterWithComplaints();
          const pages = withPages({ v1: viewPage(1), v2: viewPage(1), view: viewPage(1) });
          const r = await finish(pages, opened({ complaints: [oneComplaint], evidence_line: '' }), [
            RECORD_STEP,
            ...ids('v1', 'v2', 'view'),
          ]);
          expect(r.records[0].discipline).toMatchObject({ checked: true, on_file: true });
        });

        it('refuses the view when an earlier capture of the view lists other complaints', async () => {
          adapterWithComplaints();
          const result = opened({ complaints: [oneComplaint], evidence_line: '' });
          const pages = withPages({ v1: viewPage(2), view: viewPage(1) });
          await refusedWith(await finish(pages, result, [RECORD_STEP, ...ids('v1', 'view')]), result);
        });
      });

      describe('with the real readers and the scrubbed captures', () => {
        const views = import.meta.glob('./fixtures/fl-dbpr/complaints/*.html', {
          query: '?raw',
          import: 'default',
          eager: true,
        }) as Record<string, string>;
        const view = (name: string): string => Object.entries(views).find(([k]) => k.endsWith(`/${name}`))?.[1] ?? '';
        const realReaders = () =>
          registerAdapter('fl-dbpr', {
            ...complaintAdapter(),
            complaintRows: flDbpr.complaintRows,
            complaintLines: flDbpr.complaintLines,
          });

        it('reads 3 complaints from the view although the run said it did not open it and listed none', async () => {
          realReaders();
          const r = await finish(pageOnly(view('complaint-view.real-three-rows.html')), {
            complaints: [],
            complaint_view_opened: false,
            evidence_line: '',
          });
          expect(r.records[0].discipline.checked).toBe(true);
          expect(r.records[0].discipline.on_file).toBe(true);
          expect(r.records[0].discipline.actions).toHaveLength(3);
          expect(r.records[0].discipline.read_by).toBe('both_readers');
          expect(r.records[0].warnings).toContain('agent_answer_differs');
        });

        it('reads none on file from the clean view when the run opened it and listed none', async () => {
          realReaders();
          const r = await finish(pageOnly(view('complaint-view.clean.html')), opened({ evidence_line: '' }));
          expect(r.records[0].discipline).toMatchObject({
            checked: true,
            on_file: false,
            actions: [],
            read_by: 'both_readers',
          });
          expect(r.records[0].warnings).not.toContain('agent_answer_differs');
          expect(r.warnings ?? []).not.toContain('complaints_not_checked');
        });

        it('marks complaints not checked when the view ends before its footer', async () => {
          realReaders();
          const real = view('complaint-view.real-three-rows.html');
          const r = await finish(pageOnly(real.slice(0, real.indexOf('<footer'))), opened({ evidence_line: '' }));
          expect(r.records[0].discipline).toMatchObject({
            checked: false,
            on_file: null,
            reason: 'complaint page not captured',
          });
          expect(r.records[0].warnings).toContain('complaints_not_checked');
        });
      });
    });

    it('a complaint stage that throws still finishes the check: complaints not checked, nothing pending, one error logged', async () => {
      registerAdapter('fl-dbpr', {
        ...complaintAdapter(),
        parseHtml: (html) => {
          if (html === 'BOOM') throw new Error('boom');
          return recordOrBlank('parser_html', html);
        },
      });
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const c = pageClient({ stepHtml: async (_run: string, step: string) => (step === 'a' ? 'BOOM' : viewPage(1)) });
        const started = await startDbpr(c);
        await cont(
          c,
          started.check_id,
          viewRun({ steps: [RECORD_STEP, { step_id: 'a' }, { step_id: 'view' }], result: opened() }),
        );
        const r = await stored(started.check_id);
        expect(r.state).toBe('done');
        expect(r.outcome).toBe('match');
        expect(r.pending ?? []).toEqual([]);
        expect(r.records[0].discipline).toMatchObject({
          checked: false,
          on_file: null,
          actions: [],
          read_by: null,
          reason: 'The complaint check could not be completed.',
        });
        expect(r.warnings).toContain('complaints_not_checked');
        expect(logged).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(logged.mock.calls)).not.toContain('CMC1');
      } finally {
        logged.mockRestore();
      }
    });

    it('tells the caller the check could not be started, as a fault in TinyVerify, when the complaint run was refused', async () => {
      adapterWithComplaints();
      const c = pageClient();
      const started = await startDbpr(c);
      await cont(c, started.check_id, { reason: 'start_refused' });
      const r = await stored(started.check_id);
      expect(r.state).toBe('done');
      expect(r.outcome).toBe('match');
      expect(r.records[0].discipline).toMatchObject({
        checked: false,
        on_file: null,
        actions: [],
        read_by: null,
        reason: 'The complaint check could not be started.',
      });
      expect(r.records[0].warnings).toContain('complaints_not_checked');
      expect(r.warnings).toContain('complaints_not_checked');
    });

    it('asks the complaint run to capture the page and a screenshot', async () => {
      adapterWithComplaints();
      await startDbpr(pageClient());
      const row = await env.DB.prepare("SELECT payload_json FROM queue WHERE kind = 'discipline'").first<{
        payload_json: string;
      }>();
      expect(
        (JSON.parse(row?.payload_json ?? 'null') as { request: { capture_config: unknown } }).request.capture_config,
      ).toEqual({ html: true, screenshots: true });
    });

    it('does not serve a result with unchecked complaints from cache, so the next call reads the complaints again', async () => {
      adapterWithComplaints();
      const c = pageClient();
      const first = await startDbpr(c);
      await cont(c, first.check_id, viewRun({ result: opened({ evidence_line: '' }) }));
      const second = await startDbpr(c);
      expect(second.served_from_cache).toBe(false);
      expect(second.check_id).not.toBe(first.check_id);
      expect(second.state).toBe('reading');
    });

    it('marks complaints not checked, with the warning, when the complaint run itself fails', async () => {
      adapterWithComplaints();
      const c = pageClient();
      const started = await startDbpr(c);
      await cont(
        c,
        started.check_id,
        run('FAILED', { run_id: 'run_f', error: { code: 'AGENT_FAILURE', message: 'blocked' } }),
      );
      const r = await stored(started.check_id);
      expect(r.records[0].discipline.checked).toBe(false);
      expect(r.records[0].warnings).toContain('complaints_not_checked');
      expect(r.warnings).toContain('complaints_not_checked');
    });

    it('reads the complaints when the view was opened, and keeps the evidence line as a quote', async () => {
      adapterWithComplaints();
      const c = pageClient({ stepHtml: async () => viewPage(0, 'No complaints on file') });
      const started = await startDbpr(c);
      await cont(c, started.check_id, viewRun({ result: opened() }));
      const r = await stored(started.check_id);
      expect(r.records[0].discipline).toMatchObject({
        checked: true,
        on_file: false,
        actions: [],
        read_by: 'both_readers',
      });
      expect(r.records[0].evidence.quotes).toContain('No complaints on file');
      expect(r.records[0].warnings).not.toContain('complaints_not_checked');
      expect(r.warnings ?? []).not.toContain('complaints_not_checked');
    });

    it('keeps the evidence line as a quote when it appears on the captured page, whatever its spacing and case', async () => {
      adapterWithComplaints();
      const c = pageClient({ stepHtml: async () => viewPage(0, '<p>Complaints:</p><p>NO   complaints\n on FILE</p>') });
      const started = await startDbpr(c);
      await cont(c, started.check_id, viewRun({ result: opened() }));
      const r = await stored(started.check_id);
      expect(r.records[0].evidence.quotes).toContain('No complaints on file');
      expect(r.records[0].warnings).not.toContain('complaint_quote_unverified');
      expect(r.warnings ?? []).not.toContain('complaint_quote_unverified');
    });

    it('drops an evidence line that is not on the captured page and adds complaint_quote_unverified', async () => {
      adapterWithComplaints();
      const c = pageClient({ stepHtml: async () => viewPage(0, '<p>Some other text</p>') });
      const started = await startDbpr(c);
      await cont(c, started.check_id, viewRun({ result: opened() }));
      const r = await stored(started.check_id);
      expect(r.records[0].evidence.quotes).not.toContain('No complaints on file');
      expect(r.records[0].warnings).toContain('complaint_quote_unverified');
      expect(r.warnings).toContain('complaint_quote_unverified');
    });

    it('counts the complaints as not checked, with both warnings, when no page was captured', async () => {
      adapterWithComplaints();
      const c = pageClient({
        stepHtml: async () => {
          throw new TinyFishError('network', 0, 'no page');
        },
      });
      const started = await startDbpr(c);
      await cont(c, started.check_id, viewRun({ result: opened() }));
      const r = await stored(started.check_id);
      expect(r.records[0].discipline).toMatchObject({ checked: false, on_file: null, actions: [], read_by: null });
      expect(r.records[0].evidence.quotes).not.toContain('No complaints on file');
      expect(r.records[0].warnings).toContain('complaints_not_checked');
      expect(r.records[0].warnings).toContain('complaint_page_not_captured');
      expect(r.warnings).toContain('complaints_not_checked');
    });

    it('adds no unverified warning when the run gave no evidence line', async () => {
      adapterWithComplaints();
      const c = pageClient({ stepHtml: async () => viewPage() });
      const started = await startDbpr(c);
      await cont(c, started.check_id, viewRun({ result: opened({ evidence_line: '' }) }));
      const r = await stored(started.check_id);
      expect(r.records[0].warnings).not.toContain('complaint_quote_unverified');
    });

    it('keeps the last step page as an agent_html snapshot and links it and its screenshot from the discipline block', async () => {
      adapterWithComplaints();
      const seen: string[][] = [];
      const c = pageClient({
        stepHtml: async (runId: string, stepId: string) => {
          seen.push([runId, stepId]);
          return viewPage();
        },
      });
      const started = await startDbpr(c);
      await cont(
        c,
        started.check_id,
        viewRun({ run_id: 'run_cv', steps: [RECORD_STEP, { step_id: 'z' }], result: opened() }),
      );
      expect(seen).toEqual([['run_cv', 'z']]);
      const r = await stored(started.check_id);
      const proof = r.records[0].discipline;
      const snaps = await snapshotsFor(started.check_id);
      const complaintSnap = snaps.find((x) => x.snapshot_id === proof.snapshot_id);
      expect(complaintSnap).toMatchObject({
        reader_input: 'agent_html',
        body: viewPage(),
        run_id: 'run_cv',
        step_id: 'z',
      });
      expect(proof.screenshot_url).toBe(`${env.BASE_URL}/evidence/${proof.snapshot_id}/screenshot`);
      expect(r.records[0].warnings).not.toContain('complaint_page_not_captured');
    });

    it('reads the complaint page from the last step that has a capture, not the closing step', async () => {
      adapterWithComplaints();
      const seen: string[][] = [];
      const c = pageClient({
        stepHtml: async (runId: string, stepId: string) => {
          seen.push([runId, stepId]);
          return viewPage();
        },
      });
      const started = await startDbpr(c);
      const steps = [
        RECORD_STEP,
        { step_id: 'a', has_html: true, has_screenshot: true },
        { step_id: 'b', has_html: true, has_screenshot: true },
        { step_id: 'done', has_html: false, has_screenshot: false },
      ];
      await cont(c, started.check_id, viewRun({ run_id: 'run_cap', steps, result: opened() }));
      expect(seen).toEqual([
        ['run_cap', 'b'],
        ['run_cap', 'a'],
      ]);
    });

    it('keeps the run result as the snapshot, and asks for no page, when no step has a capture', async () => {
      adapterWithComplaints();
      const seen: string[][] = [];
      const c = pageClient({
        stepHtml: async (runId: string, stepId: string) => {
          seen.push([runId, stepId]);
          return '<html>never</html>';
        },
      });
      const started = await startDbpr(c);
      const steps = [{ step_id: 'done', has_html: false, has_screenshot: false }];
      const result = opened();
      await cont(c, started.check_id, run('COMPLETED', { steps, result }));
      expect(seen).toEqual([]);
      const r = await stored(started.check_id);
      const snap = (await snapshotsFor(started.check_id)).find(
        (x) => x.snapshot_id === r.records[0].discipline.snapshot_id,
      );
      expect(JSON.parse(snap?.body ?? 'null')).toEqual(result);
    });

    it('walks back past a 404 step and reads the complaint page from the step before', async () => {
      adapterWithComplaints();
      const seen: string[] = [];
      const c = pageClient({
        stepHtml: async (_runId: string, stepId: string) => {
          seen.push(stepId);
          if (stepId === 'c') throw new TinyFishError('not_found', 404, 'gone');
          return viewPage();
        },
      });
      const started = await startDbpr(c);
      const steps = [
        RECORD_STEP,
        { step_id: 'b' },
        { step_id: 'c' },
        { step_id: 'done', has_html: false, has_screenshot: false },
      ];
      await cont(c, started.check_id, viewRun({ run_id: 'run_wb', steps, result: opened() }));
      expect(seen).toEqual(['c', 'b']);
      const r = await stored(started.check_id);
      const snap = (await snapshotsFor(started.check_id)).find(
        (x) => x.snapshot_id === r.records[0].discipline.snapshot_id,
      );
      expect(snap).toMatchObject({ step_id: 'b', body: viewPage() });
      expect(r.records[0].discipline.checked).toBe(true);
    });

    it('keeps the run result as the snapshot and counts complaints as not checked when the page capture fails', async () => {
      adapterWithComplaints();
      const c = pageClient({
        stepHtml: async () => {
          throw new TinyFishError('network', 0, 'no page');
        },
      });
      const started = await startDbpr(c);
      const result = opened();
      await cont(c, started.check_id, viewRun({ run_id: 'run_nc', result }));
      const r = await stored(started.check_id);
      expect(r.records[0].discipline).toMatchObject({ checked: false, on_file: null });
      expect(r.records[0].warnings).toContain('complaints_not_checked');
      expect(r.records[0].warnings).toContain('complaint_page_not_captured');
      expect(r.warnings).toContain('complaint_page_not_captured');
      const snap = (await snapshotsFor(started.check_id)).find(
        (x) => x.snapshot_id === r.records[0].discipline.snapshot_id,
      );
      expect(snap?.reader_input).toBe('agent_html');
      expect(JSON.parse(snap?.body ?? 'null')).toEqual(result);
    });

    it('keeps the run result as the snapshot when the run has no steps', async () => {
      adapterWithComplaints();
      const c = pageClient();
      const started = await startDbpr(c);
      const result = opened({ complaint_view_opened: false, evidence_line: '' });
      await cont(c, started.check_id, run('COMPLETED', { steps: [], result }));
      const r = await stored(started.check_id);
      expect(r.records[0].discipline.screenshot_url).toBeNull();
      const snap = (await snapshotsFor(started.check_id)).find(
        (x) => x.snapshot_id === r.records[0].discipline.snapshot_id,
      );
      expect(JSON.parse(snap?.body ?? 'null')).toEqual(result);
    });
  });

  it('does not serve a budget refusal from cache a second later', async () => {
    registerAdapter('ca-cslb', agentAdapter('ca-cslb', { max_steps: 200 }));
    const input = { name: 'Raj Patel', record_type: 'contractor', jurisdiction: 'California' };
    const first = await startCheck(env, env.DB, client(), input, 'public');
    expect(first.unavailable?.reason).toBe('budget');
    registerAdapter('ca-cslb', agentAdapter('ca-cslb'));
    const second = await startCheck(env, env.DB, client(), input, 'public');
    expect(second.served_from_cache).toBe(false);
    expect(second.state).toBe('searching');
  });

  it('charges a refine to the bucket it is given, not public', async () => {
    const started = await startCheck(
      env,
      env.DB,
      client(),
      { name: 'Raj Patel', record_type: 'contractor', jurisdiction: 'California' },
      'judge',
    );
    await cont(
      client(),
      started.check_id,
      run('COMPLETED', { result: { rows: [row('Raj Patel', 'A1', 'Fresno'), row('Raj Patel', 'A2', 'Miami')] } }),
      'judge',
    );
    await refine(client(), started.check_id, 'cand_1', 'judge');
    const { results } = await env.DB.prepare("SELECT bucket FROM queue WHERE kind = 'record'").all<{
      bucket: string;
    }>();
    expect(results.map((r) => r.bucket)).toEqual(['judge']);
  });

  it('reports the registry total on a multiple_matches result and keeps the 25 cap', async () => {
    const started = await startCheck(
      env,
      env.DB,
      client(),
      { name: 'Raj Patel', record_type: 'contractor', jurisdiction: 'California' },
      'public',
    );
    await cont(
      client(),
      started.check_id,
      run('COMPLETED', {
        result: { rows: [row('Raj Patel', 'A1', 'Fresno'), row('Raj Patel', 'A2', 'Miami')], total: 91 },
      }),
    );
    const r = await stored(started.check_id);
    expect(r.outcome).toBe('multiple_matches');
    expect(r.candidates_total).toBe(91);
    expect(r.candidates.length).toBeLessThanOrEqual(25);
  });

  it('refuses a registry host with no government suffix', async () => {
    const c = client({
      search: async () => ({
        results: [
          { position: 1, title: 'Florida DBPR', url: 'https://www.myfloridalicense.com/licensing', snippet: '' },
        ],
      }),
    });
    const r = await startCheck(
      env,
      env.DB,
      c,
      { name: 'Raj Patel', record_type: 'plumber', jurisdiction: 'Texas' },
      'public',
    );
    expect(r.outcome).toBe('unsupported');
    expect(r.unsupported?.registry_url).toBeNull();
  });
});

describe('name order and unmapped wording', () => {
  it('passes first and last names to the adapter as "Last, First"', async () => {
    await startCheck(
      { ...env, AGENT_STEP_CAP: 'on' },
      env.DB,
      client(),
      { first_name: 'Wei', last_name: 'Lim', record_type: 'contractor', jurisdiction: 'California' },
      'public',
    );
    const { results } = await env.DB.prepare("SELECT payload_json FROM queue WHERE kind = 'search'").all<{
      payload_json: string;
    }>();
    const payload = JSON.parse(results[0].payload_json) as { request: { goal: string } };
    expect(payload.request.goal).toBe('Search for Lim, Wei');
  });

  it('with the step cap on, the job sends max_steps and holds that many steps', async () => {
    await startCheck(
      { ...env, AGENT_STEP_CAP: 'on' },
      env.DB,
      client(),
      { first_name: 'Wei', last_name: 'Lim', record_type: 'contractor', jurisdiction: 'California' },
      'public',
    );
    const { results } = await env.DB.prepare(
      "SELECT payload_json, reserved_cents FROM queue WHERE kind = 'search'",
    ).all<{ payload_json: string; reserved_cents: number }>();
    const payload = JSON.parse(results[0].payload_json) as { request: { agent_config: object } };
    expect(payload.request.agent_config).toEqual({ max_steps: 20 });
    expect(results[0].reserved_cents).toBe(32);
  });

  it('with the step cap off, the job sends a duration, holds twice the steps and ends its goal with the limit', async () => {
    await startCheck(
      { ...env, AGENT_STEP_CAP: 'off' },
      env.DB,
      client(),
      { first_name: 'Wei', last_name: 'Lim', record_type: 'contractor', jurisdiction: 'California' },
      'public',
    );
    const { results } = await env.DB.prepare(
      "SELECT payload_json, reserved_cents FROM queue WHERE kind = 'search'",
    ).all<{ payload_json: string; reserved_cents: number }>();
    const payload = JSON.parse(results[0].payload_json) as { request: { goal: string; agent_config: object } };
    expect(payload.request.agent_config).toEqual({ max_duration_seconds: 120 });
    expect(payload.request.goal.startsWith('Search for Lim, Wei\n\nUse at most 20 actions.')).toBe(true);
    expect(results[0].reserved_cents).toBe(64);
  });

  it('adds status_unknown_wording to the record and the top level when the status is other', async () => {
    registerAdapter('fl-mqa', linkAdapter('fl-mqa'));
    await upsertKey(env.DB, 'fl-mqa', 'ME123456', { licInd: '1', proCde: '2' });
    const c = client({
      fetchPages: async (u) => ({
        results: [{ url: u[0], text: page({ licence_number: 'ME123456', status: 'other', status_raw: 'Mystery' }) }],
        errors: [],
      }),
    });
    const r = await startCheck(
      env,
      env.DB,
      c,
      { licence_number: 'ME123456', record_type: 'physician', jurisdiction: 'FL' },
      'public',
    );
    expect(r.outcome).toBe('match');
    expect(r.records[0].warnings).toContain('status_unknown_wording');
    expect(r.warnings).toContain('status_unknown_wording');
  });

  it("adds the registry's own record warnings to the record", async () => {
    registerAdapter('fl-mqa', { ...linkAdapter('fl-mqa'), recordWarnings: () => ['no_expiry_on_record'] });
    await upsertKey(env.DB, 'fl-mqa', 'ME123456', { licInd: '1', proCde: '2' });
    const c = client({
      fetchPages: async (u) => ({ results: [{ url: u[0], text: page({ licence_number: 'ME123456' }) }], errors: [] }),
    });
    const r = await startCheck(
      env,
      env.DB,
      c,
      { licence_number: 'ME123456', record_type: 'physician', jurisdiction: 'FL' },
      'public',
    );
    expect(r.outcome).toBe('match');
    expect(r.records[0].warnings).toContain('no_expiry_on_record');
    expect(r.records[0].warnings.filter((w) => w === 'no_expiry_on_record')).toHaveLength(1);
  });
});

describe('agent number lookup with a name', () => {
  it('answers needs_review with name_mismatch and stores no key when the read name differs', async () => {
    const started = await startCheck(
      env,
      env.DB,
      client(),
      { name: 'Wei Ming Lim', licence_number: '1234567', record_type: 'contractor', jurisdiction: 'California' },
      'public',
    );
    await cont(
      client({ stepHtml: async () => page({ name: 'RAJ PATEL' }) }),
      started.check_id,
      run('COMPLETED', { run_id: 'run_n', result: { fields: fieldsOf({ name: 'RAJ PATEL' }) } }),
    );
    const r = await stored(started.check_id);
    expect(r.outcome).toBe('needs_review');
    expect(r.readings?.every((x) => x.warnings.includes('name_mismatch'))).toBe(true);
    expect(await getKey(env.DB, 'ca-cslb', '1234567')).toBeNull();
  });

  it('matches when the read name is the same as the input name', async () => {
    const started = await startCheck(
      env,
      env.DB,
      client(),
      { name: 'Raj Patel', licence_number: '1234567', record_type: 'contractor', jurisdiction: 'California' },
      'public',
    );
    await cont(
      client(),
      started.check_id,
      run('COMPLETED', { run_id: 'run_n2', result: { fields: fieldsOf({ name: 'RAJ PATEL' }) } }),
    );
    const r = await stored(started.check_id);
    expect(r.outcome).toBe('match');
  });
});

describe('one licence under several rows, a refused complaints run and name mismatches', () => {
  const dbaRows = (name: string) => [
    { ...row(name, 'ME123456', 'Fresno'), link: { licInd: '1', proCde: '2' } },
    { ...row('Raj Patel DBA Shop', 'ME123456', 'Fresno'), link: { licInd: '1', proCde: '2' } },
  ];

  it('matches a number-only lookup whose primary and DBA rows share one licence number', async () => {
    registerAdapter('fl-mqa', linkAdapter('fl-mqa'));
    const started = await startCheck(
      env,
      env.DB,
      client(),
      { licence_number: 'ME123456', record_type: 'physician', jurisdiction: 'FL' },
      'public',
    );
    const c = client({
      fetchPages: async (u) => ({ results: [{ url: u[0], text: page({ licence_number: 'ME123456' }) }], errors: [] }),
    });
    await cont(c, started.check_id, run('COMPLETED', { result: { rows: dbaRows('Raj Patel') } }));
    expect((await stored(started.check_id)).outcome).toBe('match');
  });

  it('matches a number and name lookup whose primary and DBA rows share one licence number', async () => {
    registerAdapter('fl-mqa', linkAdapter('fl-mqa'));
    const started = await startCheck(
      env,
      env.DB,
      client(),
      { name: 'Raj Patel', licence_number: 'ME123456', record_type: 'physician', jurisdiction: 'FL' },
      'public',
    );
    const c = client({
      fetchPages: async (u) => ({ results: [{ url: u[0], text: page({ licence_number: 'ME123456' }) }], errors: [] }),
    });
    await cont(c, started.check_id, run('COMPLETED', { result: { rows: dbaRows('Raj Patel') } }));
    expect((await stored(started.check_id)).outcome).toBe('match');
  });

  it('keeps the record and marks complaints not checked when the complaints run is refused by the budget', async () => {
    registerAdapter('fl-dbpr', complaintAdapter());
    await upsertKey(env.DB, 'fl-dbpr', 'CMC1', { id: '1' });
    const today = new Date().toISOString().slice(0, 10);
    await env.DB.prepare("INSERT INTO budgets (day, bucket, spent_cents) VALUES (?, 'public', 200)").bind(today).run();
    const c = client({
      fetchPages: async (u) => ({ results: [{ url: u[0], text: page({ licence_number: 'CMC1' }) }], errors: [] }),
    });
    const r = await startCheck(
      env,
      env.DB,
      c,
      { licence_number: 'CMC1', record_type: 'contractor', jurisdiction: 'FL' },
      'public',
    );
    expect(r.outcome).toBe('match');
    expect(r.records[0].discipline).toEqual({
      checked: false,
      on_file: null,
      actions: [],
      read_by: null,
      reason: 'budget',
    });
    expect(r.records[0].warnings).toContain('complaints_not_checked');
    expect(r.warnings).toContain('complaints_not_checked');
  });

  it('answers needs_review with name_mismatch on the known-key path when the read name differs', async () => {
    registerAdapter('fl-mqa', linkAdapter('fl-mqa'));
    await upsertKey(env.DB, 'fl-mqa', 'ME123456', { licInd: '1', proCde: '2' });
    const c = client({
      fetchPages: async (u) => ({
        results: [{ url: u[0], text: page({ licence_number: 'ME123456', name: 'RAJ PATEL' }) }],
        errors: [],
      }),
    });
    const r = await startCheck(
      env,
      env.DB,
      c,
      { name: 'Wei Ming Lim', licence_number: 'ME123456', record_type: 'physician', jurisdiction: 'FL' },
      'public',
    );
    expect(r.outcome).toBe('needs_review');
    expect(r.readings?.every((x) => x.warnings.includes('name_mismatch'))).toBe(true);
  });
});

describe('enforcement tab actions through the adapter', () => {
  it('merges the tab rows with the alert lines, deduplicated in order, and fetches with both flags set', async () => {
    const base = linkAdapter('fl-mqa');
    let flags: Record<string, boolean> = {};
    registerAdapter('fl-mqa', {
      ...base,
      discipline: {
        kind: 'flag_then_fetch',
        url: (_link, f) => {
          flags = f;
          return 'https://fl-mqa.test/enforcement';
        },
      },
      parseDisciplinePage: () => ['Tab action A', 'Tab action B'],
    });
    await upsertKey(env.DB, 'fl-mqa', 'ME123456', { licInd: '1', proCde: '2' });
    const c = client({
      fetchPages: async (u) => ({
        results: [
          {
            url: u[0],
            text: u[0].includes('enforcement')
              ? 'TAB PAGE'
              : page({ licence_number: 'ME123456', discipline_flag: false, discipline_actions: ['Tab action A'] }),
          },
        ],
        errors: [],
      }),
    });
    const r = await startCheck(
      env,
      env.DB,
      c,
      { licence_number: 'ME123456', record_type: 'physician', jurisdiction: 'FL' },
      'public',
    );
    expect(r.outcome).toBe('match');
    expect(flags).toEqual({ hasDiscipline: true, hasPublicComplaint: true });
    expect(r.records[0].discipline).toEqual({
      checked: true,
      on_file: true,
      actions: ['Tab action A', 'Tab action B'],
      read_by: 'fetch',
    });
  });
});

describe('degraded results and refusal messages', () => {
  it('does not serve a result with complaints_not_checked from cache; a repeat call reads the complaints', async () => {
    registerAdapter('fl-dbpr', complaintAdapter());
    await upsertKey(env.DB, 'fl-dbpr', 'CMC1', { id: '1' });
    const today = new Date().toISOString().slice(0, 10);
    await env.DB.prepare("INSERT INTO budgets (day, bucket, spent_cents) VALUES (?, 'public', 200)").bind(today).run();
    const c = client({
      fetchPages: async (u) => ({ results: [{ url: u[0], text: page({ licence_number: 'CMC1' }) }], errors: [] }),
    });
    const input = { licence_number: 'CMC1', record_type: 'contractor', jurisdiction: 'FL' };
    const first = await startCheck(env, env.DB, c, input, 'public');
    expect(first.warnings).toContain('complaints_not_checked');
    await env.DB.prepare('DELETE FROM budgets').run();
    const second = await startCheck(env, env.DB, c, input, 'public');
    expect(second.served_from_cache).toBe(false);
    expect(second.state).toBe('reading');
    expect((await jobs()).map((j) => j.kind)).toContain('discipline');
  });

  it('reports an unreadable provider wallet as a timeout with a minute to wait, not as a spent budget', async () => {
    resetWalletCache();
    const c = client({
      wallet: async () => {
        throw new TinyFishError('network', 0, 'no wallet');
      },
    });
    const before = Date.now();
    const r = await startCheck(
      env,
      env.DB,
      c,
      { name: 'Raj Patel', record_type: 'contractor', jurisdiction: 'California' },
      'public',
    );
    expect(r.outcome).toBe('source_unavailable');
    expect(r.unavailable?.reason).toBe('timeout');
    expect(r.unavailable?.message).toBe(
      'The service could not confirm it can pay for this check. Try again in a minute.',
    );
    const wait = Date.parse(r.unavailable?.retry_after ?? '') - before;
    expect(wait).toBeGreaterThanOrEqual(55_000);
    expect(wait).toBeLessThanOrEqual(65_000);
    expect(await jobs()).toEqual([]);
  });

  it('still reports a spent daily budget as budget, with the midnight reset', async () => {
    resetWalletCache();
    await env.DB.prepare("INSERT INTO budgets (day, bucket, spent_cents) VALUES (?, 'public', 100000)")
      .bind(new Date().toISOString().slice(0, 10))
      .run();
    const r = await startCheck(
      env,
      env.DB,
      client(),
      { name: 'Raj Patel', record_type: 'contractor', jurisdiction: 'California' },
      'public',
    );
    expect(r.unavailable?.reason).toBe('budget');
    expect(r.unavailable?.retry_after).toMatch(/T00:00:00\.000Z$/);
  });

  it('passes the queue refusal message and resets_at through as the unavailable message and retry_after', async () => {
    const started = await startCheck(
      env,
      env.DB,
      client(),
      { name: 'Raj Patel', record_type: 'contractor', jurisdiction: 'California' },
      'public',
    );
    const resets = '2030-01-01T00:00:00.000Z';
    const refusal = {
      reason: 'budget',
      message: 'wallet could not be read, retry in a minute',
      resets_at: resets,
    } as unknown as JobOutcome;
    await cont(client(), started.check_id, refusal);
    const r = await stored(started.check_id);
    expect(r.outcome).toBe('source_unavailable');
    expect(r.unavailable).toEqual({
      reason: 'budget',
      message: 'wallet could not be read, retry in a minute',
      retry_after: resets,
    });
  });
});

describe('an empty enforcement tab fails closed', () => {
  const tabAdapter = (parse: () => string[] | null) => {
    const base = linkAdapter('fl-mqa');
    return {
      ...base,
      discipline: { kind: 'flag_then_fetch' as const, url: () => 'https://fl-mqa.test/enforcement' },
      parseDisciplinePage: parse,
    };
  };
  const flagged = (tab: { results: unknown[]; errors: unknown[] } | 'text') =>
    client({
      fetchPages: async (u: string[]) => {
        if (u[0].includes('enforcement')) {
          return tab === 'text' ? { results: [{ url: u[0], text: 'TAB PAGE' }], errors: [] } : tab;
        }
        return {
          results: [
            { url: u[0], text: page({ licence_number: 'ME123456', discipline_flag: true, discipline_actions: [] }) },
          ],
          errors: [],
        };
      },
    } as unknown as Partial<Stubs>);

  it('reports actions not parsed, never on_file false, when the tab parses to nothing', async () => {
    registerAdapter(
      'fl-mqa',
      tabAdapter(() => []),
    );
    await upsertKey(env.DB, 'fl-mqa', 'ME123456', { licInd: '1', proCde: '2' });
    const r = await startCheck(
      env,
      env.DB,
      flagged('text'),
      { licence_number: 'ME123456', record_type: 'physician', jurisdiction: 'FL' },
      'public',
    );
    expect(r.records[0].discipline).toEqual({
      checked: false,
      on_file: true,
      actions: [],
      read_by: 'fetch',
      reason: 'actions page not parsed',
    });
    expect(r.records[0].warnings).toContain('discipline_actions_unparsed');
  });

  describe('a tab the parser could not read is never counted as checked', () => {
    const withFlag = (flag: boolean) =>
      client({
        fetchPages: async (u: string[]) =>
          u[0].includes('enforcement')
            ? { results: [{ url: u[0], text: 'TAB PAGE' }], errors: [] }
            : {
                results: [
                  {
                    url: u[0],
                    text: page({ licence_number: 'ME123456', discipline_flag: flag, discipline_actions: [] }),
                  },
                ],
                errors: [],
              },
      } as unknown as Partial<Stubs>);
    const lookup = async (parse: () => string[] | null, flag: boolean) => {
      registerAdapter('fl-mqa', tabAdapter(parse));
      await upsertKey(env.DB, 'fl-mqa', 'ME123456', { licInd: '1', proCde: '2' });
      return startCheck(
        env,
        env.DB,
        withFlag(flag),
        { licence_number: 'ME123456', record_type: 'physician', jurisdiction: 'FL' },
        'public',
      );
    };

    it('null with the flag false: checked false, on_file null, reason actions page not parsed', async () => {
      const r = await lookup(() => null, false);
      expect(r.records[0].discipline).toEqual({
        checked: false,
        on_file: null,
        actions: [],
        read_by: null,
        reason: 'actions page not parsed',
      });
    });

    it('null with the flag true: the unparsed outcome', async () => {
      const r = await lookup(() => null, true);
      expect(r.records[0].discipline).toEqual({
        checked: false,
        on_file: true,
        actions: [],
        read_by: 'fetch',
        reason: 'actions page not parsed',
      });
      expect(r.records[0].warnings).toContain('discipline_actions_unparsed');
    });

    it('an empty array with the flag false: checked, none on file', async () => {
      const r = await lookup(() => [], false);
      expect(r.records[0].discipline).toEqual({ checked: true, on_file: false, actions: [], read_by: 'fetch' });
    });

    it('an array with entries: on file', async () => {
      const r = await lookup(() => ['Fine, 2026-01-02'], false);
      expect(r.records[0].discipline).toEqual({
        checked: true,
        on_file: true,
        actions: ['Fine, 2026-01-02'],
        read_by: 'fetch',
      });
    });
  });

  it('reports actions not parsed when the tab fetch fails', async () => {
    registerAdapter(
      'fl-mqa',
      tabAdapter(() => ['never used']),
    );
    await upsertKey(env.DB, 'fl-mqa', 'ME123456', { licInd: '1', proCde: '2' });
    const r = await startCheck(
      env,
      env.DB,
      flagged({ results: [], errors: [{ url: 'x', code: 'not_found', message: 'gone' }] }),
      { licence_number: 'ME123456', record_type: 'physician', jurisdiction: 'FL' },
      'public',
    );
    expect(r.records[0].discipline).toEqual({
      checked: false,
      on_file: true,
      actions: [],
      read_by: 'fetch',
      reason: 'actions page not parsed',
    });
    expect(r.records[0].warnings).toContain('discipline_actions_unparsed');
  });
});

describe('include_complaints governs only the DBPR complaint run', () => {
  const tabAdapter = (parse: () => string[]) => ({
    ...linkAdapter('fl-mqa'),
    discipline: { kind: 'flag_then_fetch' as const, url: () => 'https://fl-mqa.test/enforcement' },
    parseDisciplinePage: parse,
  });
  const mqaClient = (flag: boolean, fetched: string[] = []) =>
    client({
      fetchPages: async (u: string[]) => {
        fetched.push(u[0]);
        if (u[0].includes('enforcement')) return { results: [{ url: u[0], text: 'TAB PAGE' }], errors: [] };
        return {
          results: [
            { url: u[0], text: page({ licence_number: 'ME123456', discipline_flag: flag, discipline_actions: [] }) },
          ],
          errors: [],
        };
      },
    });
  const mqaInput = (include_complaints?: boolean) => ({
    licence_number: 'ME123456',
    record_type: 'physician',
    jurisdiction: 'FL',
    ...(include_complaints === undefined ? {} : { include_complaints }),
  });

  it('MQA with include_complaints false still reads the flag and the enforcement tab', async () => {
    registerAdapter(
      'fl-mqa',
      tabAdapter(() => ['Fine, 2026-01-02']),
    );
    await upsertKey(env.DB, 'fl-mqa', 'ME123456', { licInd: '1', proCde: '2' });
    const fetched: string[] = [];
    const r = await startCheck(env, env.DB, mqaClient(true, fetched), mqaInput(false), 'public');
    expect(r.records[0].discipline).toEqual({
      checked: true,
      on_file: true,
      actions: ['Fine, 2026-01-02'],
      read_by: 'fetch',
    });
    expect(fetched.some((u) => u.includes('enforcement'))).toBe(true);
    expect(r.records[0].discipline.reason).toBeUndefined();
  });

  it('MQA with include_complaints false reports none on file when the flag is clear, and reads no tab', async () => {
    // An adapter with no tab parser: the enforcement page is fetched only when the record page sets the flag.
    registerAdapter('fl-mqa', {
      ...linkAdapter('fl-mqa'),
      discipline: { kind: 'flag_then_fetch' as const, url: () => 'https://fl-mqa.test/enforcement' },
    });
    await upsertKey(env.DB, 'fl-mqa', 'ME123456', { licInd: '1', proCde: '2' });
    const fetched: string[] = [];
    const r = await startCheck(env, env.DB, mqaClient(false, fetched), mqaInput(false), 'public');
    expect(r.records[0].discipline).toEqual({ checked: true, on_file: false, actions: [], read_by: 'fetch' });
    expect(fetched.some((u) => u.includes('enforcement'))).toBe(false);
  });

  it('MQA gives the same discipline with the flag false, true and left out', async () => {
    registerAdapter(
      'fl-mqa',
      tabAdapter(() => ['Fine, 2026-01-02']),
    );
    await upsertKey(env.DB, 'fl-mqa', 'ME123456', { licInd: '1', proCde: '2' });
    const answers: unknown[] = [];
    for (const flag of [false, true, undefined]) {
      await env.DB.prepare('DELETE FROM checks').run();
      const r = await startCheck(env, env.DB, mqaClient(true), mqaInput(flag), 'public');
      answers.push(r.records[0].discipline);
    }
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
  }, 30_000);

  it('a repeat of an MQA lookup with the other flag value is the same lookup and comes from the cache', async () => {
    registerAdapter(
      'fl-mqa',
      tabAdapter(() => ['Fine, 2026-01-02']),
    );
    await upsertKey(env.DB, 'fl-mqa', 'ME123456', { licInd: '1', proCde: '2' });
    const first = await startCheck(env, env.DB, mqaClient(true), mqaInput(false), 'public');
    expect(first.served_from_cache).toBe(false);
    const second = await startCheck(env, env.DB, mqaClient(true), mqaInput(true), 'public');
    expect(second.served_from_cache).toBe(true);
    expect(second.check_id).toBe(first.check_id);
  });

  it('CSLB with include_complaints false still reports the discipline flag its record page shows', async () => {
    const input = {
      licence_number: '1234567',
      record_type: 'contractor',
      jurisdiction: 'California',
      include_complaints: false,
    };
    const started = await startCheck(env, env.DB, client(), input, 'public');
    const c = client({
      stepHtml: async () => page({ discipline_flag: true, discipline_actions: ['Citation 2025-02-03'] }),
    });
    await cont(
      c,
      started.check_id,
      run('COMPLETED', {
        run_id: 'run_cslb',
        result: { fields: fieldsOf({ discipline_flag: true, discipline_actions: ['Citation 2025-02-03'] }) },
      }),
    );
    const r = await stored(started.check_id);
    expect(r.outcome).toBe('match');
    expect(r.records[0].discipline).toEqual({
      checked: true,
      on_file: true,
      actions: ['Citation 2025-02-03'],
      read_by: 'agent',
    });
  });

  it('DBPR with include_complaints false starts no complaint run and says complaints were not requested', async () => {
    registerAdapter('fl-dbpr', complaintAdapter());
    await upsertKey(env.DB, 'fl-dbpr', 'CMC1', { id: '1' });
    const c = client({
      fetchPages: async (u: string[]) => ({
        results: [{ url: u[0], text: page({ licence_number: 'CMC1' }) }],
        errors: [],
      }),
    });
    const r = await startCheck(
      env,
      env.DB,
      c,
      { licence_number: 'CMC1', record_type: 'contractor', jurisdiction: 'FL', include_complaints: false },
      'public',
    );
    expect(r.state).toBe('done');
    expect(r.records[0].discipline).toMatchObject({ checked: false, reason: 'Complaints were not requested.' });
    expect(await jobs()).toEqual([]);
  });

  it('DBPR keeps the flag in its cache key: a repeat with the other value is a new lookup', async () => {
    registerAdapter('fl-dbpr', complaintAdapter());
    await upsertKey(env.DB, 'fl-dbpr', 'CMC1', { id: '1' });
    const c = client({
      fetchPages: async (u: string[]) => ({
        results: [{ url: u[0], text: page({ licence_number: 'CMC1' }) }],
        errors: [],
      }),
    });
    const base = { licence_number: 'CMC1', record_type: 'contractor', jurisdiction: 'FL' };
    const off = await startCheck(env, env.DB, c, { ...base, include_complaints: false }, 'public');
    const on = await startCheck(env, env.DB, c, { ...base, include_complaints: true }, 'public');
    expect(on.served_from_cache).toBe(false);
    expect(on.check_id).not.toBe(off.check_id);
    expect(on.state).toBe('reading');
  });
});

// A run's steps as GET /v1/runs/{id} returns them: every step carries the capture flags, and a run that asked for
// no capture has none.
const noCapture = (count: number): RunStep[] =>
  Array.from({ length: count }, (_, i) => ({ step_id: `s${i + 1}`, has_html: false, has_screenshot: false }));

describe('a number lookup whose search opens the record page, with the real adapters', () => {
  const MQA_URL = 'https://mqa-internet.doh.state.fl.us/MQASearchServices/LicenseVerification?LicInd=2468&ProCde=1501';
  const DBPR_URL = 'https://www.myfloridalicense.com/LicenseDetail.asp?SID=&id=0123456789abcdef0123456789abcdef';
  const MQA_INPUT = { licence_number: 'ME000000', record_type: 'physician', jurisdiction: 'FL' };
  const DBPR_INPUT = {
    licence_number: 'CCC0000000',
    record_type: 'contractor',
    jurisdiction: 'FL',
    include_complaints: false,
  };
  const mqaAnswer = (over: object = {}): object => ({
    url: MQA_URL,
    page: 'record',
    rows: [],
    found: true,
    total: 0,
    licence_number: 'ME000000',
    ...over,
  });
  const dbprAnswer = (over: object = {}): object => ({ url: DBPR_URL, page: 'record', total: null, ...over });

  const noPage = async (): Promise<string> => {
    throw new Error('a run with no capture has no page to read');
  };
  const fetching = (urls: string[], record: string, tab = '', stepHtml: Stubs['stepHtml'] = noPage): TinyFish =>
    client({
      fetchPages: async (u) => (
        urls.push(u[0]),
        { results: [{ url: u[0], text: u[0].includes('LoadEnforcementActionsTab') ? tab : record }], errors: [] }
      ),
      stepHtml,
    });

  beforeEach(() => {
    registerAdapter('fl-mqa', flMqa);
    registerAdapter('fl-dbpr', flDbpr);
  });

  it('health board: the record link in the answer is fetched, with no snapshot to read', async () => {
    const started = await startCheck(env, env.DB, client(), MQA_INPUT, 'public');
    const fetched: string[] = [];
    await cont(
      fetching(fetched, mqaRecord, mqaTab),
      started.check_id,
      run('COMPLETED', { result: mqaAnswer(), steps: noCapture(4) }),
    );
    const r = await stored(started.check_id);
    expect(r.outcome).toBe('match');
    expect(r.records[0].key.licence_number).toBe('ME000000');
    expect(fetched[0]).toContain('LicInd=2468&ProCde=1501');
    expect(await searchJobs()).toHaveLength(1);
  });

  it('health board: an answer that found an address on a results page is fetched too, with no second run', async () => {
    const started = await startCheck(env, env.DB, client(), MQA_INPUT, 'public');
    const fetched: string[] = [];
    await cont(
      fetching(fetched, mqaRecord, mqaTab),
      started.check_id,
      run('COMPLETED', { result: mqaAnswer({ page: 'results' }), steps: noCapture(4) }),
    );
    expect((await stored(started.check_id)).outcome).toBe('match');
    expect(fetched.length).toBeGreaterThan(0);
    expect(await searchJobs()).toHaveLength(1);
  });

  it('health board: an address on another host is layout_changed, never no_match, and fetches nothing', async () => {
    const started = await startCheck(env, env.DB, client(), MQA_INPUT, 'public');
    const fetched: string[] = [];
    await cont(
      fetching(fetched, mqaRecord),
      started.check_id,
      run('COMPLETED', {
        result: mqaAnswer({ url: 'https://elsewhere.example/x?LicInd=2468&ProCde=1501' }),
        steps: noCapture(4),
      }),
    );
    const r = await stored(started.check_id);
    expect(r.outcome).toBe('source_unavailable');
    expect(r.unavailable?.reason).toBe('layout_changed');
    expect(fetched).toEqual([]);
  });

  it('health board: a record that shows another number than the one asked for goes to review', async () => {
    const started = await startCheck(env, env.DB, client(), { ...MQA_INPUT, licence_number: 'ME000009' }, 'public');
    await cont(
      fetching([], mqaRecord, mqaTab),
      started.check_id,
      run('COMPLETED', { result: mqaAnswer({ licence_number: 'ME000009' }), steps: noCapture(4) }),
    );
    const r = await stored(started.check_id);
    expect(r.outcome).toBe('needs_review');
    expect(r.readings?.every((x) => x.warnings.includes('licence_number_mismatch'))).toBe(true);
  });

  // The contractor board captures, but the page before the closing step answers 404 and the earlier ones are the search form.
  const dbprSteps: RunStep[] = ['s1', 's2', 's3', 's4'].map((step_id) => ({
    step_id,
    has_html: true,
    has_screenshot: false,
  }));
  const formThenNotFound = async (_run: string, step: string): Promise<string> => {
    if (step === 's3') throw new TinyFishError('not_found', 404, 'gone');
    return '<html><body><form>Search by License Number</form></body></html>';
  };

  it('contractor board: the record link is fetched although the snapshots show only the search form', async () => {
    const started = await startCheck(env, env.DB, client(), DBPR_INPUT, 'public');
    const fetched: string[] = [];
    await cont(
      fetching(fetched, dbprRecord, '', formThenNotFound),
      started.check_id,
      run('COMPLETED', { result: dbprAnswer(), steps: dbprSteps }),
    );
    const r = await stored(started.check_id);
    expect(r.outcome).toBe('match');
    expect(r.records[0].key.licence_number).toBe('CCC0000000');
    expect(fetched[0]).toContain('id=0123456789abcdef0123456789abcdef');
    expect(await searchJobs()).toHaveLength(1);
  });

  it('contractor board: an address on another host is layout_changed, not no_match', async () => {
    const started = await startCheck(env, env.DB, client(), DBPR_INPUT, 'public');
    await cont(
      fetching([], dbprRecord, '', formThenNotFound),
      started.check_id,
      run('COMPLETED', {
        result: dbprAnswer({
          url: 'https://elsewhere.example/LicenseDetail.asp?SID=&id=0123456789abcdef0123456789abcdef',
        }),
        steps: dbprSteps,
      }),
    );
    const r = await stored(started.check_id);
    expect(r.outcome).toBe('source_unavailable');
    expect(r.unavailable?.reason).toBe('layout_changed');
  });

  it('contractor board: a record that shows another number than the one asked for goes to review', async () => {
    const started = await startCheck(env, env.DB, client(), { ...DBPR_INPUT, licence_number: 'CCC0000009' }, 'public');
    await cont(
      fetching([], dbprRecord, '', formThenNotFound),
      started.check_id,
      run('COMPLETED', { result: dbprAnswer(), steps: dbprSteps }),
    );
    expect((await stored(started.check_id)).outcome).toBe('needs_review');
  });
});

describe('"none" and a list with no row, with the real adapters', () => {
  const MQA_URL = 'https://mqa-internet.doh.state.fl.us/MQASearchServices/LicenseVerification?LicInd=2468&ProCde=1501';
  const NAME = { name: 'Sample Person', record_type: 'physician', jurisdiction: 'FL' };
  const NUMBER = { licence_number: 'ME000001', record_type: 'physician', jurisdiction: 'FL' };
  const asRecord = (number: string): string => mqaRecord.replaceAll('ME000000', number);
  const serving = (html: string): TinyFish =>
    client({
      stepHtml: async () => html,
      fetchPages: async (u) => ({
        results: [{ url: u[0], text: u[0].includes('LoadEnforcementActionsTab') ? mqaTab : asRecord('ME000001') }],
        errors: [],
      }),
    });
  const withPage = (result: object): RunResult =>
    run('COMPLETED', {
      result,
      steps: [
        { step_id: 's1', has_html: true },
        { step_id: 's2', has_html: false },
      ],
    });

  beforeEach(() => registerAdapter('fl-mqa', flMqa));

  it('a name search answered "none" over the captured results page of 91 is not a no_match', async () => {
    const started = await startCheck(env, env.DB, client(), NAME, 'public');
    await cont(serving(mqaResults), started.check_id, withPage({ page: 'none', total: null, url: null }));
    const r = await stored(started.check_id);
    expect(r.outcome).toBe('multiple_matches');
    expect(r.candidates_total).toBe(91);
  });

  it('a number search asks for an HTML capture, as the name search does', async () => {
    await startCheck(env, env.DB, client(), NUMBER, 'public');
    const [job] = await searchJobs();
    expect(job.capture_config).toEqual({ html: true });
  });

  it('a number search answered "none" while the captured list holds the number reads that licence', async () => {
    const started = await startCheck(env, env.DB, client(), NUMBER, 'public');
    await cont(
      serving(mqaResults),
      started.check_id,
      withPage({ page: 'none', found: false, url: null, licence_number: 'ME000001', rows: [], total: 0 }),
    );
    const r = await stored(started.check_id);
    expect(r.outcome).toBe('match');
    expect(r.records[0].key.licence_number).toBe('ME000001');
  });

  it('a number search answered "results" with found false while the captured list holds the number reads that licence', async () => {
    const started = await startCheck(env, env.DB, client(), NUMBER, 'public');
    await cont(
      serving(mqaResults),
      started.check_id,
      withPage({ page: 'results', found: false, url: null, licence_number: 'ME000001', rows: [], total: 0 }),
    );
    expect((await stored(started.check_id)).outcome).toBe('match');
  });

  it('a list that really has no row for the number is a no_match that is not kept, and "none" with no list is kept', async () => {
    const started = await startCheck(env, env.DB, client(), { ...NUMBER, licence_number: 'ME000099' }, 'public');
    await cont(
      serving(mqaResults),
      started.check_id,
      withPage({ page: 'results', found: false, url: null, licence_number: 'ME000099', rows: [], total: 0 }),
    );
    expect((await stored(started.check_id)).outcome).toBe('no_match');
    expect(
      (await startCheck(env, env.DB, client(), { ...NUMBER, licence_number: 'ME000099' }, 'public')).served_from_cache,
    ).toBe(false);

    const other = await startCheck(env, env.DB, client(), { ...NUMBER, licence_number: 'ME000098' }, 'public');
    await cont(
      serving('<html><body>No results were found.</body></html>'),
      other.check_id,
      withPage({ page: 'none', found: false, url: null, licence_number: 'ME000098', rows: [], total: 0 }),
    );
    expect((await stored(other.check_id)).outcome).toBe('no_match');
    expect(
      (await startCheck(env, env.DB, client(), { ...NUMBER, licence_number: 'ME000098' }, 'public')).served_from_cache,
    ).toBe(true);
  });

  it('the address of a record page still wins over a captured list', async () => {
    const started = await startCheck(env, env.DB, client(), NUMBER, 'public');
    await cont(
      serving(mqaResults),
      started.check_id,
      withPage({ page: 'record', found: true, url: MQA_URL, licence_number: 'ME000001', rows: [], total: 0 }),
    );
    expect((await stored(started.check_id)).outcome).toBe('match');
  });
});

describe('a name search on a results list of 91, with the real adapter', () => {
  const run91 = run('COMPLETED', {
    result: { page: 'results', total: 91 },
    steps: [{ step_id: 's1', has_html: true }],
  });
  const listing = (): TinyFish =>
    client({
      stepHtml: async () => mqaResults,
      fetchPages: async () => {
        throw new Error('a list of more than one page decides nothing, so no record is fetched');
      },
    });

  beforeEach(() => registerAdapter('fl-mqa', flMqa));

  it('a name that is not on page 1 is several matches with a total of 91', async () => {
    const started = await startCheck(
      env,
      env.DB,
      client(),
      { name: 'Quux, Zed', record_type: 'physician', jurisdiction: 'FL' },
      'public',
    );
    await cont(listing(), started.check_id, run91);
    const r = await stored(started.check_id);
    expect(r.outcome).toBe('multiple_matches');
    expect(r.candidates_total).toBe(91);
    expect(r.candidates).toHaveLength(5);
    expect(r.warnings).toContain('total_counts_other_professions');
    expect(r.disambiguators).toEqual(expect.arrayContaining(['city', 'licence_number']));
  });

  it('a name that is exactly one row on page 1 is still several matches', async () => {
    const started = await startCheck(
      env,
      env.DB,
      client(),
      { name: 'Sample, Person C', record_type: 'physician', jurisdiction: 'FL' },
      'public',
    );
    await cont(listing(), started.check_id, run91);
    const r = await stored(started.check_id);
    expect(r.outcome).toBe('multiple_matches');
    expect(r.candidates[0].licence_number).toBe('ME000003');
    expect(r.candidates_total).toBe(91);
  });
});
