import { describe, expect, it } from 'vitest';
import { EXAMPLES, PURE_SOURCE, listedPlaces, pageApp, scriptFacts } from '../src/web/page';
import golden from '../src/golden.json';

const goldenNumber = (registry: string, prefix: string): string =>
  golden.records.find((r) => r.registry === registry && r.licence_number.startsWith(prefix))?.licence_number ?? '';
const DOCTOR = goldenNumber('fl-mqa', 'ME');
const NURSE = goldenNumber('fl-mqa', 'RN');
const CONTRACTOR = goldenNumber('fl-dbpr', 'CBC');
const CA_NUMBER = goldenNumber('ca-cslb', '');

async function load(): Promise<string> {
  const res = await pageApp.request('/');
  expect(res.status).toBe(200);
  expect(res.headers.get('Content-Type') ?? '').toContain('text/html');
  return res.text();
}

// The page has two inline scripts: the picture behind it, and the page script that the tests drive.
const PAGE_TAG = '<script id="page">';
const SCENE_TAG = '<script id="scene">';
const scriptOf = (html: string): string =>
  html.slice(html.indexOf(PAGE_TAG) + PAGE_TAG.length, html.lastIndexOf('</script>'));
const sceneOf = (html: string): string =>
  html.slice(html.indexOf(SCENE_TAG) + SCENE_TAG.length, html.indexOf('</script>', html.indexOf(SCENE_TAG)));
const styleOf = (html: string): string =>
  html.slice(html.indexOf('<style>') + '<style>'.length, html.indexOf('</style>'));

// Text a visitor reads in the served HTML, without the style, the script and the tags.
function staticText(html: string): string {
  const body = html.slice(html.indexOf('<body>'), html.indexOf(SCENE_TAG));
  return body.replace(/<[^>]+>/g, '\n');
}

// The words the page must never show a visitor (never-rule 4). Whole words, any case. Two sentences the owner wrote use
// "run" as a plain verb; they are taken out first.
const BANNED = [
  'adapter',
  'reader',
  'parser',
  'agent',
  'run',
  'step',
  'snapshot',
  'monitor',
  'tier',
  'bucket',
  'budget',
  'queue',
  'webhook',
  'endpoint',
  'dbpr',
  'mqa',
  'cslb',
  'status word',
];
const OWNER_SENTENCES = ['It costs money to run, so it needs a key.', 'Watching runs every day, so it needs a key.'];
function bannedIn(text: string): string[] {
  const kept = OWNER_SENTENCES.reduce((rest, sentence) => rest.split(sentence).join(''), text);
  return BANNED.filter((word) => new RegExp(`(^|[^a-z])${word}s?([^a-z]|$)`, 'i').test(kept));
}

// ---------------------------------------------------------------------------------------------------------------
// The pure functions the page inlines: the same source string, evaluated here.

const TV = new Function('F', `${PURE_SOURCE}\nreturn TV;`)(scriptFacts()) as Record<string, (...args: any[]) => any>;
const NOW = new Date(2026, 10, 9, 21, 29);
const at = (y: number, m: number, d: number, h: number, min: number): string => new Date(y, m, d, h, min).toISOString();

describe('the examples', () => {
  it('are three golden licence numbers, each with its profession and place', () => {
    const numbers = golden.records.map((r) => r.licence_number);
    expect(EXAMPLES.map((e) => e.number)).toEqual([DOCTOR, NURSE, CA_NUMBER]);
    expect(EXAMPLES.map((e) => e.kind)).toEqual(['physician', 'nurse', 'contractor']);
    expect(EXAMPLES.map((e) => e.place)).toEqual(['US-FL', 'US-FL', 'US-CA']);
    for (const e of EXAMPLES) expect(numbers).toContain(e.number);
  });
});

describe('reading the text', () => {
  it('reads each golden example as a licence number', () => {
    for (const number of [DOCTOR, NURSE, CONTRACTOR, CA_NUMBER])
      expect(TV.readQuery(number)).toEqual({ mode: 'number', number });
  });

  it('ignores spaces, dots, dashes and case inside a number', () => {
    expect(TV.readQuery(`${DOCTOR.slice(0, 2).toLowerCase()} ${DOCTOR.slice(2)}`)).toEqual({
      mode: 'number',
      number: DOCTOR,
    });
    expect(TV.readQuery('tx-204418')).toEqual({ mode: 'number', number: 'TX204418' });
    expect(TV.readQuery('12 345 678')).toEqual({ mode: 'number', number: '12345678' });
  });

  it('reads a name as a name, with its spaces tidied', () => {
    expect(TV.readQuery('  Jane   Smith ')).toEqual({ mode: 'name', name: 'Jane Smith' });
    expect(TV.readQuery("O'Brien & Sons, Inc.")).toEqual({ mode: 'name', name: "O'Brien & Sons, Inc." });
  });

  it('reads a business name that holds a digit as a name', () => {
    expect(TV.readQuery('21st Century Roofing')).toEqual({ mode: 'name', name: '21st Century Roofing' });
    expect(TV.readQuery('Jane1')).toEqual({ mode: 'number', number: 'JANE1' });
    expect(TV.readQuery('Roofing2000')).toEqual({ mode: 'name', name: 'Roofing2000' });
  });

  it('reports an empty text', () => {
    expect(TV.readQuery('   ').mode).toBe('empty');
    expect(TV.readQuery(undefined).mode).toBe('empty');
  });
});

describe('the verdict sentence', () => {
  const rec = (status: string, expires: string | null = '2030-01-31', raw = 'Raw words'): any => ({
    licence: { status, status_raw: raw, expires },
  });
  const table: [any, string][] = [
    [rec('active'), 'Licensed and active.'],
    [rec('active', null), 'Licensed and active.'],
    [rec('active', '2020-01-31'), 'Listed as active, but the licence passed its expiry date.'],
    [rec('probation'), 'Licensed, on probation.'],
    [rec('suspended'), 'Not in good standing. This licence is suspended.'],
    [rec('revoked'), 'Not in good standing. This licence was revoked.'],
    [rec('delinquent'), 'Not in good standing. This licence is delinquent.'],
    [rec('expired'), 'This licence has expired.'],
    [rec('surrendered'), 'This licence was given up.'],
    [rec('inactive'), 'This licence is inactive.'],
    [rec('pending'), 'This licence has not been issued yet.'],
    [rec('other', null, 'Retired status'), 'The registry lists a status this service does not know: “Retired status”.'],
  ];
  for (const [input, sentence] of table) {
    it(`says "${sentence}" for ${input.licence.status} expiring ${input.licence.expires}`, () => {
      expect(TV.verdict(input, NOW)).toBe(sentence);
    });
  }

  it('quotes the registry for a missing status too', () => {
    expect(TV.verdict({ licence: { status: null, status_raw: 'Odd words', expires: null } }, NOW)).toContain(
      '“Odd words”',
    );
  });

  it('counts an expiry date of today as still valid', () => {
    expect(TV.verdict(rec('active', '2026-11-09'), NOW)).toBe('Licensed and active.');
  });
});

describe('the lines of the card', () => {
  const record: any = {
    registry: { id: 'fl-mqa' },
    subject: { name: 'JANE SMITH', city: 'MIAMI' },
    licence: {
      type: 'Registered Nurse',
      status: 'active',
      status_raw: 'Clear/Active',
      expires: '2027-04-30',
      issued: '2021-12-02',
    },
    key: { licence_number: NURSE },
    verification: { readers: ['parser_html', 'parser_text'], agree: true },
    warnings: [],
  };

  it('writes what the licence is and the city under the name', () => {
    expect(TV.role(record)).toBe('Registered Nurse, MIAMI');
    expect(TV.role({ ...record, subject: { name: 'X', city: null } })).toBe('Registered Nurse');
    expect(TV.role({ subject: {}, licence: { type: null } })).toBe('');
  });

  it('lists the number, the registry wording and the dates with the month in words', () => {
    expect(TV.rows(record, NOW)).toEqual([
      ['Licence', NURSE],
      ['Status on the registry', 'Clear/Active'],
      ['Valid until', 'April 30, 2027'],
      ['First issued', 'December 2, 2021'],
    ]);
  });

  it('says a past expiry date has passed', () => {
    expect(TV.rows({ ...record, licence: { ...record.licence, expires: '2020-01-31' } }, NOW)[2]).toEqual([
      'Expired',
      'January 31, 2020',
    ]);
  });

  it('leaves out what the registry does not show', () => {
    expect(TV.rows({ ...record, licence: { expires: null, issued: null, status_raw: null } }, NOW)).toEqual([
      ['Licence', NURSE],
    ]);
  });

  it('writes times as 8:21 PM and says today', () => {
    expect(TV.clock(new Date(2026, 10, 9, 20, 21))).toBe('8:21 PM');
    expect(TV.clock(new Date(2026, 10, 9, 0, 5))).toBe('12:05 AM');
    expect(TV.quiet(record, at(2026, 10, 9, 21, 29), NOW)).toBe(
      'Read twice from the official page; both readings agree. Checked today at 9:29 PM.',
    );
    expect(TV.quiet(record, at(2026, 10, 5, 9, 2), NOW)).toBe(
      'Read twice from the official page; both readings agree. Checked November 5 at 9:02 AM.',
    );
  });

  it('says a helper found a record from a registry this service does not read by itself', () => {
    const routed = { ...record, registry: { ...record.registry, id: 'generic' } };
    expect(TV.quiet(routed, null, NOW)).toBe(
      'A helper found this record; every value shown was then checked against the official page.',
    );
  });

  it('leaves the check time off while the answer is partial', () => {
    expect(TV.quiet(record, null, NOW)).toBe('Read twice from the official page; both readings agree.');
  });
});

describe('the large word and the fish', () => {
  const rec = (status: string, expires: string | null = '2030-01-31'): any => ({
    records: [{ licence: { status, expires } }],
  });

  it('prints "Active." and forms the tick only for an active licence that has not passed its expiry date', () => {
    expect(TV.picture(rec('active'), NOW)).toEqual({ word: 'Active.', fish: 'check' });
    expect(TV.picture(rec('active', null), NOW)).toEqual({ word: 'Active.', fish: 'check' });
    expect(TV.picture(rec('active', '2020-01-31'), NOW)).toEqual({ word: 'Past expiry.', fish: 'hide' });
  });

  const table: [string, string][] = [
    ['probation', 'On probation.'],
    ['suspended', 'Suspended.'],
    ['revoked', 'Revoked.'],
    ['delinquent', 'Delinquent.'],
    ['expired', 'Expired.'],
    ['surrendered', 'Given up.'],
    ['inactive', 'Inactive.'],
    ['pending', 'Not issued.'],
    ['other', 'Unclear.'],
  ];
  for (const [status, word] of table) {
    it(`prints "${word}" with no tick for ${status}`, () => {
      expect(TV.picture(rec(status), NOW)).toEqual({ word, fish: 'hide' });
    });
  }

  it('asks which one for several matches, and shows no tick for any answer without a record', () => {
    expect(TV.picture({ outcome: 'multiple_matches', records: [] }, NOW)).toEqual({
      word: 'Which one?',
      fish: 'orbit',
    });
    expect(TV.picture({ outcome: 'no_match', records: [] }, NOW)).toEqual({ word: 'Not found.', fish: 'hide' });
    expect(TV.picture({ outcome: 'needs_review', records: [] }, NOW)).toEqual({ word: 'No answer.', fish: 'hide' });
    expect(TV.picture({ outcome: 'source_unavailable' }, NOW)).toEqual({ word: 'No answer.', fish: 'hide' });
    expect(TV.picture({ outcome: 'unsupported' }, NOW)).toEqual({ word: 'Not covered.', fish: 'hide' });
  });

  it('goes back to the name for refused input and for nothing at all', () => {
    expect(TV.picture({ outcome: 'invalid_input', records: [] }, NOW)).toEqual({ word: 'TinyVerify', fish: 'swim' });
    expect(TV.picture({}, NOW)).toEqual({ word: 'TinyVerify', fish: 'swim' });
  });
});

describe('the discipline sentence', () => {
  it('says none on file', () => {
    expect(TV.discipline({ checked: true, on_file: false, actions: [] })).toEqual({
      head: 'No discipline or complaints on file.',
      actions: [],
    });
  });

  it('counts complaints, singular for one, and lists each action', () => {
    expect(TV.discipline({ checked: true, on_file: true, actions: ['Fine paid'] })).toEqual({
      head: '1 complaint on file.',
      actions: ['Fine paid'],
    });
    expect(TV.discipline({ checked: true, on_file: true, actions: ['a', 'b'] }).head).toBe('2 complaints on file.');
  });

  it('says the complaints could not be checked, with a plain reason and never a code', () => {
    expect(
      TV.discipline({ checked: false, on_file: null, actions: [], reason: 'The discipline page did not load.' }).head,
    ).toBe('Complaints could not be checked. The discipline page did not load.');
    expect(TV.discipline({ checked: false, on_file: null, actions: [], reason: 'complaints_not_checked' }).head).toBe(
      'Complaints could not be checked.',
    );
    expect(TV.discipline({ checked: false, on_file: null, actions: [], reason: 'actions page not parsed' }).head).toBe(
      'Complaints could not be checked.',
    );
    expect(TV.discipline(undefined).head).toBe('Complaints could not be checked.');
  });

  it('shows the waiting line for a partial answer', () => {
    expect(TV.discipline({ checked: false, on_file: null, actions: [] }, true).head).toBe(
      'Checking public complaints…',
    );
  });
});

describe('warnings', () => {
  const rec = (expires: string, warnings: string[] = [], status = 'active'): any => ({
    licence: { status, expires },
    warnings,
  });

  it('says a licence expires soon when the date is within 60 days', () => {
    expect(TV.warnings(rec('2026-12-20'), NOW)).toEqual(['This licence expires soon.']);
    expect(TV.warnings(rec('2027-02-01'), NOW)).toEqual([]);
  });

  it('says nothing about expiry for a licence that is not active or already expired', () => {
    expect(TV.warnings(rec('2026-12-20', [], 'suspended'), NOW)).toEqual([]);
    expect(TV.warnings(rec('2020-01-01'), NOW)).toEqual([]);
  });

  it('writes the missing-expiry and ignored-summary sentences', () => {
    expect(TV.warnings(rec('2030-01-01', ['no_expiry_on_record']), NOW)).toContain(
      'The registry shows no expiry date.',
    );
    expect(TV.warnings(rec('2030-01-01', ['agent_answer_differs']), NOW)).toEqual([
      "The page was read directly; a helper's summary of it differed and was ignored.",
    ]);
  });

  it('says nothing for unverified quotes, second readings or unknown codes, and shows no code', () => {
    expect(
      TV.warnings(rec('2030-01-01', ['complaint_quote_unverified', 'differs:expires', 'something_new']), NOW),
    ).toEqual([]);
  });
});

describe('the other outcomes', () => {
  const base: any = { query: {}, searched: { registries: ['fl-mqa'] }, candidates: [] };
  const out = (r: object): any => TV.outcome({ ...base, ...r }, NOW);

  it('lists several matches and offers each one', () => {
    const view = out({
      outcome: 'multiple_matches',
      candidates: [
        {
          candidate_id: 'c1',
          name: 'JANE SMITH',
          licence_type: 'Registered Nurse',
          city: 'MIAMI',
          status_raw: 'Clear/Active',
        },
        { candidate_id: 'c2', name: 'JANE SMITH', licence_type: null, city: null, status_raw: 'Null and Void' },
      ],
    });
    expect(view.head).toBe('Found 2 licences under that name. Pick the one you mean.');
    expect(view.rows).toEqual([
      { id: 'c1', name: 'JANE SMITH', meta: 'Registered Nurse, MIAMI, Clear/Active' },
      { id: 'c2', name: 'JANE SMITH', meta: 'Null and Void' },
    ]);
    expect(view.sub).toBeUndefined();
  });

  it('says when more matches exist than it shows', () => {
    const view = out({
      outcome: 'multiple_matches',
      candidates_total: 40,
      candidates: [
        { candidate_id: 'c1', name: 'A' },
        { candidate_id: 'c2', name: 'B' },
      ],
    });
    expect(view.head).toBe('Found 40 licences under that name. Pick the one you mean.');
    expect(view.sub).toBe('Showing the first 2. Add a city or use the licence number to narrow it.');
  });

  it('speaks of a company, not a licence, when a company was asked for', () => {
    const company = { query: { record_type: 'company', name: 'X' } };
    expect(out({ ...company, outcome: 'no_match' })).toEqual({
      head: 'No company found for that name.',
      sub: 'Check the spelling, or try the registration number.',
    });
    expect(out({ outcome: 'no_match', query: { record_type: 'company', licence_number: '1' } }).head).toBe(
      'No company found with that number.',
    );
    expect(
      out({
        ...company,
        outcome: 'multiple_matches',
        candidates: [
          { candidate_id: 'c1', name: 'A' },
          { candidate_id: 'c2', name: 'B' },
        ],
      }).head,
    ).toBe('Found 2 companies under that name. Pick the one you mean.');
    expect(out({ ...company, outcome: 'unsupported', unsupported: {} }).head).toBe(
      'This service could not find the official company register there.',
    );
    expect(TV.verdict({ licence: { status: 'active', expires: null } }, NOW, true)).toBe('Registered and active.');
    expect(TV.verdict({ licence: { status: 'revoked', expires: null } }, NOW, true)).toBe(
      'Not in good standing. This registration was revoked.',
    );
    expect(TV.verdict({ licence: { status: null, status_raw: null } }, NOW, true)).toBe(
      'The registry gives no status for this registration.',
    );
  });

  it('says no licence was found, by name or by number', () => {
    expect(out({ outcome: 'no_match', query: { name: 'X' } })).toMatchObject({
      head: 'No licence found for that name.',
      sub: 'Check the spelling, or try the licence number.',
    });
    expect(out({ outcome: 'no_match', query: { licence_number: '1' } }).head).toBe(
      'No licence found with that number.',
    );
  });

  it('asks for the licence number when another registry lists several records', () => {
    const unsupported = {
      registry_url: 'https://www.tx.gov/licensing',
      message: 'The register lists 7 records under this name. Add the licence number to check one.',
    };
    const view = out({ outcome: 'needs_review', warnings: ['generic_route', 'several_results'], unsupported });
    expect(view.head).toBe(unsupported.message);
    expect(view.link).toEqual({ href: 'https://www.tx.gov/licensing', text: 'Open the official registry' });
  });

  it('gives no answer when the page of another registry could not be read with confidence', () => {
    const view = out({
      outcome: 'needs_review',
      warnings: ['generic_route', 'not_grounded'],
      unsupported: { registry_url: 'https://www.tx.gov/licensing' },
    });
    expect(view.head).toBe('No answer. The official page could not be read with confidence, so nothing is shown.');
    expect(view.link.href).toBe('https://www.tx.gov/licensing');
  });

  it('gives no answer when the two readings disagreed, and offers the official record', () => {
    const view = out({ outcome: 'needs_review' });
    expect(view.head).toBe('No answer. The two readings of the official page did not agree, so nothing is shown.');
    expect(view.link.text).toBe('Open the official record');
    expect(view.link.href).toMatch(/^https:/);
  });

  it('says the registry is not answering, and names the weekly closure', () => {
    expect(out({ outcome: 'source_unavailable', unavailable: { reason: 'timeout' } }).head).toBe(
      'The registry is not answering right now.',
    );
    const closed = out({
      outcome: 'source_unavailable',
      searched: { registries: ['ca-cslb'] },
      unavailable: { reason: 'maintenance', retry_after: at(2026, 10, 10, 3, 0) },
    });
    expect(closed.head).toBe("California's contractor board is closed for maintenance until tomorrow at 3:00 AM.");
  });

  it('says the kind is not covered and offers the official registry', () => {
    const view = out({
      outcome: 'unsupported',
      unsupported: { registry_name: 'X', registry_url: 'https://example.test/r' },
    });
    expect(view.head).toBe('This service does not read that kind of licence there yet.');
    expect(view.link).toEqual({ href: 'https://example.test/r', text: 'Open the official registry' });
    expect(
      out({ outcome: 'unsupported', unsupported: { registry_name: null, registry_url: null } }).link,
    ).toBeUndefined();
  });

  it('refuses a link that is not https', () => {
    expect(out({ outcome: 'unsupported', unsupported: { registry_url: 'javascript:alert(1)' } }).link).toBeUndefined();
  });

  it('gives a plain sentence for input the server refused', () => {
    expect(
      out({
        outcome: 'invalid_input',
        invalid: { field: 'licence_number', expected: 'Florida health licence numbers are a prefix and digits' },
      }).head,
    ).toBe('Florida health licence numbers are a prefix and digits.');
    expect(out({ outcome: 'invalid_input', invalid: { field: 'city', expected: 'letters only' } }).head).toBe(
      'The city needs letters only.',
    );
  });

  it('says the free checks are used up, for the day or for this address', () => {
    expect(out({ outcome: 'source_unavailable', unavailable: { reason: 'budget' } }).head).toBe(
      "Today's free checks are used up. They start again tomorrow.",
    );
    expect(out({ outcome: 'source_unavailable', unavailable: { reason: 'rate_limited' } }).head).toBe(
      'Too many checks are under way. Try again in a minute.',
    );
    expect(TV.limitText(at(2026, 10, 9, 22, 0), NOW)).toBe(
      'The free checks from this address are used up for now. They start again today at 10:00 PM.',
    );
    expect(TV.limitText(undefined, NOW)).toBe(
      'The free checks from this address are used up for now. They start again within the hour.',
    );
  });

  it('falls back to a plain sentence', () => {
    expect(out({ outcome: 'surprise' }).head).toBe('Something went wrong on our side. Nothing was checked.');
  });

  it('writes the waiting sentence from the state of the answer', () => {
    expect(TV.waitText('queued')).toBe('Looking on the official registry…');
    expect(TV.waitText('searching')).toBe('Looking on the official registry…');
    expect(TV.waitText('reading')).toBe('Found the record. Reading it…');
  });
});

describe('the watches and the status', () => {
  const ev = (kind: string, when: string, extra: object = {}): any => ({
    kind,
    created_at: when,
    before: null,
    after: null,
    evidence: { note: 'raw note, do not show' },
    ...extra,
  });

  it('writes each event as a sentence', () => {
    expect(TV.eventLine(ev('unchanged', at(2026, 10, 9, 20, 21)), NOW)).toBe('Today at 8:21 PM: no change.');
    expect(
      TV.eventLine(
        ev('status_change', at(2026, 10, 9, 8, 0), { before: { status: 'active' }, after: { status: 'suspended' } }),
        NOW,
      ),
    ).toBe('Today at 8:00 AM: status changed from active to suspended.');
    expect(TV.eventLine(ev('check_failed', at(2026, 10, 9, 19, 3)), NOW)).toBe(
      'Today at 7:03 PM: the check could not be completed.',
    );
  });

  it('never shows the raw note', () => {
    for (const kind of ['unchanged', 'status_change', 'check_failed'])
      expect(TV.eventLine(ev(kind, at(2026, 10, 9, 8, 0)), NOW)).not.toContain('raw note');
  });

  it('names the watched licence in plain words', () => {
    expect(TV.watchTitle({ registry: 'fl-mqa', licence_number: DOCTOR })).toBe(`Florida health licence ${DOCTOR}`);
    expect(TV.watchTitle({ registry: 'ca-cslb', licence_number: CA_NUMBER })).toBe(
      `California contractor licence ${CA_NUMBER}`,
    );
  });

  it('writes one sentence per registry', () => {
    expect(TV.healthLine('fl-mqa', 'ok')).toBe("Florida's health board: answering.");
    expect(TV.healthLine('ca-cslb', 'unknown')).toBe("California's contractor board: not checked yet today.");
    expect(TV.healthLine('fl-dbpr', 'degraded')).toBe("Florida's contractor board: not answering.");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The served HTML

describe('GET /', () => {
  it('holds the three fields, the button and the claim', async () => {
    const html = await load();
    for (const label of ['Name or licence number', 'Who or what', 'Place'])
      expect(html).toContain(`<span>${label}</span>`);
    expect(html).toContain('<span id="go-label">Check</span>');
    expect(html).toContain(
      'Professional licences,<br><span>checked at the official registry. Any US state, and six countries.</span>',
    );
    expect(listedPlaces().countries).toHaveLength(6);
    expect(html).toContain('This page needs JavaScript to check a licence.');
  });

  it('offers the five professions and a company', async () => {
    const html = await load();
    const kinds = html.slice(
      html.indexOf('<select id="kind">'),
      html.indexOf('</select>', html.indexOf('<select id="kind">')),
    );
    expect([...kinds.matchAll(/<option value="([a-z]+)">([A-Za-z]+)</g)].map((m) => `${m[1]}:${m[2]}`)).toEqual([
      'physician:Doctor',
      'nurse:Nurse',
      'dentist:Dentist',
      'pharmacist:Pharmacist',
      'contractor:Contractor',
      'company:Company',
    ]);
  });

  it('lists the places this service reads by itself first, then every other state, then the countries', async () => {
    const { states, countries } = listedPlaces();
    expect(states.slice(0, 2)).toEqual([
      { value: 'US-FL', label: 'Florida' },
      { value: 'US-CA', label: 'California' },
    ]);
    expect(states).toHaveLength(51);
    expect(states.filter((s) => s.label === 'Florida' || s.label === 'California')).toHaveLength(2);
    expect(states).toContainEqual({ value: 'Texas', label: 'Texas' });
    expect(countries).toEqual(['United Kingdom', 'Canada', 'Singapore', 'India', 'New Zealand', 'Ireland']);
    const html = await load();
    expect(html).toContain(
      '<optgroup label="United States"><option value="US-FL">Florida</option><option value="US-CA">California</option><option value="Alabama">Alabama</option>',
    );
    expect(html).toContain('<optgroup label="Other countries"><option value="United Kingdom">United Kingdom</option>');
  });

  it('leaves out a country whose registry is known but not connected yet', async () => {
    const html = await load();
    expect(html).not.toContain('Australia');
    expect(html).not.toContain('au-ahpra');
  });

  it('holds the three examples as buttons, not as underlined words', async () => {
    const html = await load();
    expect(html).toContain(
      '<div class="under" id="eg"><span>Try</span><button type="button" class="chip" id="eg0">A doctor in Florida</button><button type="button" class="chip" id="eg1">A nurse in Florida</button><button type="button" class="chip" id="eg2">A contractor in California</button></div>',
    );
    const css = styleOf(html);
    expect(css).toMatch(/\.chip\{border:1px solid var\(--line\);background:var\(--card\)/);
    expect(css).not.toContain('text-decoration:underline');
  });

  it('gives the text that fish can swim behind a rim of the paper colour', async () => {
    const css = styleOf(await load());
    expect(css).toMatch(/\.under,\.claim,\.foot,\.mark\{text-shadow:[^}]*var\(--paper\)/);
    expect(css).toMatch(/\.chip\{[^}]*text-shadow:none/);
    const scene = sceneOf(await load());
    expect(scene).toContain('float rim = layer(uTone, p, .7854, 0, uCell * .34);');
    expect(scene.indexOf('col = mix(col, vec3(1., 1., .996), rim);')).toBeLessThan(
      scene.indexOf('vec3(.115, .105, .095), ink);'),
    );
  });

  it('shows no sample record and no preview switch', async () => {
    const html = await load();
    expect(staticText(html)).not.toMatch(/sample|preview|fictional/i);
    expect(html).not.toContain('DEMO-');
    expect(html).not.toContain('type="radio"');
  });

  it('starts with the card and the watchlist closed', async () => {
    const html = await load();
    expect(html).toContain('<section class="card ui" id="card" aria-live="polite" hidden></section>');
    expect(html).toMatch(/<aside class="panel ui" id="panel"[^>]* hidden>/);
    expect(html).not.toContain('<details');
  });

  it('has two inline scripts that are valid JavaScript', async () => {
    const html = await load();
    expect(html.match(/<script/g)).toHaveLength(2);
    expect(() => new Function(scriptOf(html))).not.toThrow();
    expect(() => new Function(sceneOf(html))).not.toThrow();
  });

  it('is under 70,000 bytes', async () => {
    const html = await load();
    const bytes = new TextEncoder().encode(html).byteLength;
    console.log(`served page: ${bytes} bytes`);
    expect(bytes).toBeLessThan(70_000);
  });

  it('loads only its two typefaces from another origin, and no script', async () => {
    const html = await load();
    expect(html).not.toMatch(/<script[^>]*\ssrc=/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(styleOf(html)).not.toMatch(/@import|@font-face|url\((?!"data:)/i);
    const links = [...html.matchAll(/<link\b[^>]*href="([^"]+)"/g)].map((m) => new URL(m[1]).host);
    expect(new Set(links)).toEqual(new Set(['fonts.googleapis.com', 'fonts.gstatic.com']));
    const outside = [...html.matchAll(/(?:src|action)="(https?:[^"]+)"/gi)].map((m) => m[1]);
    expect(outside).toEqual([]);
    expect([...html.matchAll(/<a\b[^>]*href="(https?:[^"]+)"/g)].map((m) => m[1])).toEqual(['https://www.tinyfish.ai']);
  });

  it('keeps the picture off the network', async () => {
    expect(sceneOf(await load())).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|https?:/);
  });

  it('contains no U+2014 em dash', async () => {
    expect(await load()).not.toContain('—');
  });

  it('shows no internal word in the text a visitor reads', async () => {
    const text = staticText(await load());
    expect(bannedIn(text)).toEqual([]);
  });

  it('holds one side panel with three views, and one key field in it', async () => {
    const html = await load();
    for (const text of [
      'Each licence here is read again every day. A change of status is recorded.',
      'each check is charged to your TinyFish account, usually 10 to 60 cents',
      'Any other US state or country has no line here. Its registry is found and read at the time of each check.',
    ]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('<div id="view-watch">');
    expect(html).toContain('<div id="view-key" hidden>');
    expect(html).toContain('<div id="view-status" hidden>');
    expect(html.match(/type="password"/g)).toHaveLength(1);
    expect(html).not.toContain('Watchlist');
  });

  it('names the button for what it opens, and offers the own key under the search', async () => {
    const html = await load();
    expect(html).toContain('>Watched licences<span class="n" id="wc">0</span></button>');
    expect(html).toContain(
      '<span id="own-say">Free checks are limited each day.</span> <button type="button" class="chip" id="ownBtn" aria-haspopup="dialog">Use your own TinyFish key</button>',
    );
  });
});

describe('the style', () => {
  it('has no uppercase text, monospace, italic, blur or rounded corner', async () => {
    const css = styleOf(await load());
    expect(css).not.toMatch(/text-transform/i);
    expect(css).not.toMatch(/monospace|ui-mono|courier|menlo|consolas|condensed/i);
    expect(css).not.toMatch(/italic|oblique/i);
    expect(css).not.toMatch(/blur\(|backdrop-filter/i);
    expect(css.match(/border-radius:[^;}]+/g)).toEqual(['border-radius:0']);
    expect(css).not.toMatch(/outline\s*:\s*[^0n]/i);
  });

  it('uses one gradient, on the check button', async () => {
    const css = styleOf(await load());
    expect(css.match(/gradient\(/g)).toHaveLength(1);
    expect(css).toMatch(/\.go\{[^}]*background:var\(--grad\)/);
  });

  it('uses the off-white ground, the two typefaces and text no smaller than 13px', async () => {
    const css = styleOf(await load());
    expect(css).toContain('--paper:#fffffe');
    expect(css).toContain("--display:'Bricolage Grotesque'");
    expect(css).toContain("--text:'Hanken Grotesk'");
    const sizes = [...css.matchAll(/font-size:(\d+)px/g)].map((m) => Number(m[1]));
    expect(Math.min(...sizes)).toBe(13);
    expect(css).toMatch(/prefers-reduced-motion/);
    expect(css).toMatch(/max-width:860px/);
  });

  it('lets a long answer scroll inside the card at both widths', async () => {
    const css = styleOf(await load());
    expect(css).toMatch(
      /\.card\{[^}]*top:calc\(21vh \+ 178px\);width:380px;max-height:calc\(79vh - 202px\);overflow:auto/,
    );
    expect(css).toMatch(/\.card\{[^}]*max-height:52vh/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The script, driven through a small fake page.

class Node_ {
  id = '';
  attrs: Record<string, string> = {};
  kids: Node_[] = [];
  parent: Node_ | null = null;
  listeners: Record<string, ((ev: any) => void)[]> = {};
  own = '';
  value = '';
  checked = false;
  hidden = false;
  disabled = false;
  scrollTop = 0;
  className = '';
  constructor(
    public tag: string,
    private doc: Doc,
  ) {}
  get textContent(): string {
    return this.kids.length ? this.kids.map((k) => k.textContent).join(' ') : this.own;
  }
  set textContent(v: string) {
    this.kids = [];
    this.own = v;
  }
  get firstChild(): Node_ | null {
    return this.kids[0] ?? null;
  }
  appendChild(child: Node_): Node_ {
    child.parent = this;
    this.kids.push(child);
    return child;
  }
  removeChild(child: Node_): void {
    this.kids = this.kids.filter((k) => k !== child);
  }
  replaceChild(next: Node_, old: Node_): void {
    this.kids = this.kids.map((k) => (k === old ? next : k));
    next.parent = this;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = String(value);
    if (name === 'hidden') this.hidden = true;
    if (name === 'value') this.value = String(value);
    if (name === 'class') this.className = String(value);
  }
  removeAttribute(name: string): void {
    delete this.attrs[name];
    if (name === 'hidden') this.hidden = false;
  }
  hasAttribute(name: string): boolean {
    return name in this.attrs;
  }
  addEventListener(type: string, fn: (ev: any) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type: string): void {
    for (let node: Node_ | null = this; node; node = node.parent) {
      for (const fn of node.listeners[type] ?? []) fn({ preventDefault() {}, target: this });
    }
  }
  focus(): void {
    this.doc.focused = this;
  }
  find(pred: (n: Node_) => boolean): Node_[] {
    return [...(pred(this) ? [this] : []), ...this.kids.flatMap((k) => k.find(pred))];
  }
  byText(text: string): Node_ {
    const hit = this.find((n) => n.own === text || (n.kids.length === 0 && n.own.trim() === text))[0];
    if (!hit) throw new Error(`no node with text "${text}" in: ${this.textContent}`);
    return hit;
  }
}

class Doc {
  focused: Node_ | null = null;
  byId = new Map<string, Node_>();
  body = new Node_('body', this);
  getElementById = (id: string): Node_ => {
    if (!this.byId.has(id)) {
      const n = new Node_('div', this);
      n.id = id;
      this.byId.set(id, n);
    }
    return this.byId.get(id) as Node_;
  };
  createElement = (tag: string): Node_ => new Node_(tag, this);
  addEventListener = (type: string, fn: (ev: any) => void): void => {
    this.body.addEventListener(type, fn);
  };
  createTextNode = (text: string): Node_ => {
    const n = new Node_('#text', this);
    n.own = text;
    return n;
  };
}

type Reply = { status: number; json: unknown };
type Handler = (method: string, path: string, body: any) => Reply | undefined;

function mount(html: string, handler: Handler = () => undefined) {
  const doc = new Doc();
  const sent: { method: string; path: string; body: any; auth?: string; headers?: Record<string, string> }[] = [];
  const timers: (() => void)[] = [];
  // What the page asked the picture to do, in order: ['mode', 'search'], ['word', 'Active.'], ...
  const scene: [string, string][] = [];
  const fakeScene = {
    word: (text: string) => scene.push(['word', text]),
    mode: (name: string) => scene.push(['mode', name]),
  };
  const fakeFetch = (path: string, opts: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
    const method = opts.method ?? 'GET';
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    sent.push({ method, path, body, auth: opts.headers?.Authorization, headers: opts.headers });
    const reply = handler(method, path, body) ?? { status: 404, json: {} };
    return Promise.resolve({ ok: reply.status < 400, status: reply.status, json: () => Promise.resolve(reply.json) });
  };
  const q = doc.getElementById('q');
  q.value = DOCTOR;
  doc.getElementById('kind').value = 'physician';
  doc.getElementById('place').value = 'US-FL';
  doc.getElementById('card').hidden = true;
  doc.getElementById('panel').hidden = true;
  doc.getElementById('now').hidden = true;
  new Function('document', 'fetch', 'location', 'setTimeout', 'clearTimeout', 'Scene', scriptOf(html))(
    doc,
    fakeFetch,
    { href: 'https://tinyverify.test/' },
    (fn: () => void) => timers.push(fn),
    () => undefined,
    fakeScene,
  );
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const el = (id: string): Node_ => doc.getElementById(id);
  return {
    doc,
    sent,
    scene,
    el,
    flush,
    verifyCalls: () => sent.filter((s) => s.method === 'POST' && s.path === '/verify'),
    type: (text: string) => {
      q.value = text;
      q.fire('input');
    },
    choose: (kind: string, place: string) => {
      el('kind').value = kind;
      el('place').value = place;
    },
    submit: async () => {
      el('lookup').fire('submit');
      await flush();
    },
    press: async (label: string, within = 'card') => {
      el(within).byText(label).fire('click');
      await flush();
    },
    click: async (id: string) => {
      el(id).fire('click');
      await flush();
    },
    poll: async () => {
      const next = timers.shift();
      next?.();
      await flush();
    },
    text: (id: string) => el(id).textContent,
  };
}

const noop: Handler = () => undefined;
const baseResult = {
  check_id: 'chk_1',
  query: { record_type: 'physician', jurisdiction: 'US-FL' },
  served_from_cache: false,
  candidates: [],
  disambiguators: [],
  searched: { registries: ['fl-mqa'], spellings_tried: [], alternate_spellings_used: false },
};
const nurse: any = {
  registry: { id: 'fl-mqa', name: 'Florida Department of Health, MQA licence verification', jurisdiction: 'US-FL' },
  key: { licence_number: NURSE },
  source_url: 'https://registry.example.test/x',
  source_lookup: null,
  data_as_of: null,
  subject: { name: 'JANE SMITH', kind: 'person', other_names: [], city: null },
  licence: {
    type: 'Registered Nurse',
    rank: null,
    status: 'active',
    status_raw: 'Clear/Active',
    issued: '2021-12-02',
    expires: '2099-04-30',
  },
  discipline: { checked: true, on_file: false, actions: [], read_by: 'fetch' },
  match: null,
  verification: { readers: ['parser_html', 'parser_text'], agree: true },
  evidence: {
    quotes: ['Clear/Active', 'Clear/Active', 'Expires 04/30/2099'],
    snapshot_id: 's1',
    content_sha256: 'x',
    screenshot_url: null,
    tinyfish_run_id: null,
  },
  read_by: 'fetch',
  adapter_version: '1.0.0',
  warnings: [],
};
const done = (extra: object = {}): Reply => ({
  status: 200,
  json: {
    ...baseResult,
    state: 'done',
    outcome: 'match',
    checked_at: new Date().toISOString(),
    records: [nurse],
    pending: [],
    ...extra,
  },
});
const answers =
  (reply: Reply): Handler =>
  (m, p) =>
    m === 'POST' && p === '/verify' ? reply : undefined;
const several = (extra: object = {}): Reply =>
  done({
    outcome: 'multiple_matches',
    records: [],
    candidates: [
      {
        candidate_id: 'c1',
        name: 'JANE SMITH',
        licence_type: 'Registered Nurse',
        city: 'MIAMI',
        status_raw: 'Clear/Active',
      },
      { candidate_id: 'c2', name: 'JANE SMYTH', licence_type: null, city: null, status_raw: null },
    ],
    ...extra,
  });
const proofOf = (page: ReturnType<typeof mount>): Node_ => page.el('card').find((n) => n.className === 'extract')[0];

describe('asking a question', () => {
  it('sends the typed number with the chosen profession and place', async () => {
    const page = mount(await load(), answers(done()));
    await page.submit();
    expect(page.verifyCalls()).toHaveLength(1);
    expect(page.verifyCalls()[0].body).toEqual({
      record_type: 'physician',
      jurisdiction: 'US-FL',
      licence_number: DOCTOR,
      include_complaints: true,
    });
  });

  it('fills the three fields from an example press and checks at once', async () => {
    const page = mount(await load(), noop);
    await page.click('eg1');
    await page.click('eg2');
    const bodies = page.verifyCalls().map((c) => c.body);
    expect(bodies[0]).toEqual({
      record_type: 'nurse',
      jurisdiction: 'US-FL',
      licence_number: NURSE,
      include_complaints: true,
    });
    expect(bodies[1]).toEqual({
      record_type: 'contractor',
      jurisdiction: 'US-CA',
      licence_number: CA_NUMBER,
      include_complaints: true,
    });
    expect(page.el('q').value).toBe(CA_NUMBER);
    expect(page.el('kind').value).toBe('contractor');
    expect(page.el('place').value).toBe('US-CA');
  });

  it('asks for text when the field is empty, in place of the examples, and sends nothing', async () => {
    const page = mount(await load(), noop);
    page.type('  ');
    await page.submit();
    expect(page.text('now')).toBe('Type a name or a licence number first.');
    expect(page.el('now').hidden).toBe(false);
    expect(page.el('eg').hidden).toBe(true);
    expect(page.doc.focused).toBe(page.el('q'));
    expect(page.verifyCalls()).toHaveLength(0);
    page.type('J');
    expect(page.el('eg').hidden).toBe(false);
    expect(page.el('now').hidden).toBe(true);
  });

  it('sends a name with the chosen profession and any listed place', async () => {
    const page = mount(await load(), noop);
    page.type('21st Century Roofing');
    page.choose('contractor', 'Texas');
    await page.submit();
    expect(page.verifyCalls()[0].body).toEqual({
      record_type: 'contractor',
      jurisdiction: 'Texas',
      name: '21st Century Roofing',
      include_complaints: true,
    });
  });

  it('says how the text was read and how long the check can take', async () => {
    const waiting: Reply = {
      status: 202,
      json: { ...baseResult, state: 'searching', outcome: null, checked_at: null, records: [] },
    };
    const here = mount(await load(), answers(waiting));
    await here.submit();
    expect(here.text('now')).toBe(
      'Read as a licence number. Looking on the official registry… This can take up to a minute.',
    );
    const elsewhere = mount(await load(), answers(waiting));
    elsewhere.type('Jane Smith');
    elsewhere.choose('nurse', 'United Kingdom');
    await elsewhere.submit();
    expect(elsewhere.text('now')).toBe(
      'Read as a name. Looking on the official registry… This can take up to three minutes.',
    );
    const other = mount(await load(), answers(waiting));
    other.choose('physician', 'US-CA');
    await other.submit();
    expect(other.text('now')).toContain('This can take up to three minutes.');
  });

  it('asks for a first and last name before it checks a person, and takes one word for a business', async () => {
    const page = mount(await load(), noop);
    page.type('Alex');
    await page.submit();
    expect(page.text('now')).toBe('Type the first and last name, or the licence number.');
    expect(page.doc.focused).toBe(page.el('q'));
    expect(page.verifyCalls()).toHaveLength(0);
    for (const kind of ['contractor', 'company']) {
      page.choose(kind, 'US-FL');
      await page.submit();
    }
    expect(page.verifyCalls().map((c) => c.body.name)).toEqual(['Alex', 'Alex']);
  });

  it('promises a minute only for a licence number on a registry whose record page is read directly', async () => {
    const waiting: Reply = {
      status: 202,
      json: { ...baseResult, state: 'searching', outcome: null, checked_at: null, records: [] },
    };
    const cases: [string, string, string, string][] = [
      [DOCTOR, 'physician', 'US-FL', 'a minute'],
      ['Jane Smith', 'physician', 'US-FL', 'three minutes'],
      [CA_NUMBER, 'contractor', 'US-CA', 'three minutes'],
      ['Acme Widgets', 'company', 'US-FL', 'three minutes'],
      ['12345678', 'company', 'United Kingdom', 'three minutes'],
    ];
    for (const [text, kind, place, promise] of cases) {
      const page = mount(await load(), answers(waiting));
      page.type(text);
      page.choose(kind, place);
      await page.submit();
      expect(page.text('now'), text).toContain(`This can take up to ${promise}.`);
    }
  });

  it('sets the fish circling while it checks', async () => {
    const page = mount(await load(), noop);
    await page.submit();
    expect(page.scene[0]).toEqual(['mode', 'search']);
  });
});

describe('the result', () => {
  it('shows the registry, the name, the verdict, the facts, the buttons and the small print in that order', async () => {
    const page = mount(await load(), answers(done()));
    await page.submit();
    const card = page.el('card');
    expect(card.hidden).toBe(false);
    const text = card.textContent.replace(/\s+/g, ' ');
    const order = [
      'Florida Department of Health, MQA licence verification',
      'JANE SMITH',
      'Registered Nurse',
      'Licensed and active.',
      `Licence ${NURSE}`,
      'Status on the registry Clear/Active',
      'Valid until April 30, 2099',
      'First issued December 2, 2021',
      'No discipline or complaints on file.',
      'See the proof',
      'Watch this licence',
      'Read twice from the official page; both readings agree. Checked today at',
    ];
    const places = order.map((part) => text.indexOf(part));
    expect(
      places.every((at) => at >= 0),
      text,
    ).toBe(true);
    expect([...places].sort((a, b) => a - b)).toEqual(places);
    expect(page.el('eg').hidden).toBe(false);
    expect(page.text('go-label')).toBe('Check');
  });

  it('prints "Active." and forms the tick for a licence in good standing', async () => {
    const page = mount(await load(), answers(done()));
    await page.submit();
    expect(page.scene).toEqual([
      ['mode', 'search'],
      ['word', 'Active.'],
      ['mode', 'check'],
    ]);
  });

  it('writes a company as a registration, never as a licence', async () => {
    const company = {
      ...nurse,
      registry: { id: 'generic', name: 'Division of Corporations', jurisdiction: 'Florida' },
      key: { licence_number: 'L00000000000' },
      subject: { name: 'ACME WIDGETS LLC', kind: 'business', other_names: [], city: null },
      licence: {
        type: 'Florida Limited Liability Company',
        rank: null,
        status: 'active',
        status_raw: 'ACTIVE',
        issued: null,
        expires: null,
      },
    };
    const asked = { ...baseResult.query, record_type: 'company' };
    const page = mount(await load(), answers(done({ records: [company], query: asked })));
    page.type('Acme Widgets');
    page.choose('company', 'US-FL');
    await page.submit();
    const text = page.text('card').replace(/\s+/g, ' ');
    expect(text).toContain('Registered and active.');
    expect(text).toContain('Registration number L00000000000');
    expect(text).not.toMatch(/licen[cs]e/i);
    expect(page.scene.slice(1)).toEqual([
      ['word', 'Active.'],
      ['mode', 'check'],
    ]);
    const gone = { ...company, licence: { ...company.licence, status: 'inactive', status_raw: 'INACTIVE' } };
    const closed = mount(await load(), answers(done({ records: [gone], query: asked })));
    closed.choose('company', 'US-FL');
    await closed.submit();
    expect(closed.text('card')).toContain('This registration is inactive.');
  });

  it('prints the status and forms no tick for a licence that is not in good standing', async () => {
    const suspended = { ...nurse, licence: { ...nurse.licence, status: 'suspended', status_raw: 'Suspended' } };
    const page = mount(await load(), answers(done({ records: [suspended] })));
    await page.submit();
    expect(page.scene.slice(1)).toEqual([
      ['word', 'Suspended.'],
      ['mode', 'hide'],
    ]);
    expect(page.text('card')).toContain('Not in good standing. This licence is suspended.');
  });

  it('keeps the proof closed until it is asked for, with the record link, the registry name and the quotes without repeats', async () => {
    const page = mount(await load(), answers(done()));
    await page.submit();
    const proof = proofOf(page);
    expect(proof.hidden).toBe(true);
    await page.press('See the proof');
    expect(proof.hidden).toBe(false);
    expect(page.text('card')).toContain('Hide the proof');
    expect(proof.textContent).toContain('Open the official record');
    expect(proof.textContent).toContain('Florida Department of Health, MQA licence verification');
    expect(proof.textContent.match(/Clear\/Active/g)).toHaveLength(1);
    const link = proof.find((n) => n.tag === 'a')[0];
    expect(link.attrs.href).toBe('https://registry.example.test/x');
    expect(link.attrs.target).toBe('_blank');
    await page.press('Hide the proof');
    expect(proof.hidden).toBe(true);
  });

  it('shows the screenshot with its caption when the record has one', async () => {
    const withShot = {
      ...nurse,
      evidence: { ...nurse.evidence, screenshot_url: '/evidence/s1/screenshot' },
      discipline: { ...nurse.discipline, screenshot_url: '/evidence/s2/screenshot' },
    };
    const page = mount(await load(), answers(done({ records: [withShot] })));
    await page.submit();
    expect(proofOf(page).find((n) => n.tag === 'img')[0].attrs.src).toBe('/evidence/s2/screenshot');
    expect(proofOf(page).textContent).toContain('The complaints page as it was read');
  });

  it('refuses a screenshot address outside the evidence path, or on another host', async () => {
    for (const url of ['https://elsewhere.test/x.png', 'https://elsewhere.test/evidence/x/screenshot']) {
      const bad = { ...nurse, evidence: { ...nurse.evidence, screenshot_url: url } };
      const page = mount(await load(), answers(done({ records: [bad] })));
      await page.submit();
      expect(page.el('card').find((n) => n.tag === 'img')).toHaveLength(0);
    }
  });

  it('never inserts server text as markup and links only to https', async () => {
    const evil = {
      ...nurse,
      subject: { ...nurse.subject, name: '<img src=x onerror=alert(1)>' },
      source_url: 'javascript:alert(1)',
    };
    const page = mount(await load(), answers(done({ records: [evil] })));
    await page.submit();
    expect(page.el('card').textContent).toContain('<img src=x onerror=alert(1)>');
    expect(page.el('card').find((n) => n.tag === 'a' || n.tag === 'img')).toHaveLength(0);
    expect(scriptOf(await load())).not.toContain('innerHTML');
  });

  it('offers no watch for a record from a registry this service does not read by itself', async () => {
    const routed = { ...nurse, registry: { id: 'generic', name: 'Texas Medical Board', jurisdiction: 'Texas' } };
    const page = mount(await load(), answers(done({ records: [routed] })));
    await page.submit();
    expect(page.text('card')).toContain('See the proof');
    expect(page.text('card')).not.toContain('Watch this licence');
  });

  it('shows the waiting sentences as the answer changes, with the card closed', async () => {
    let state = 'searching';
    const page = mount(await load(), (m, p) => {
      if (m === 'POST' && p === '/verify')
        return {
          status: 202,
          json: { ...baseResult, state: 'searching', outcome: null, checked_at: null, records: [] },
        };
      if (m === 'GET' && p === '/verify/chk_1')
        return { status: 202, json: { ...baseResult, state, outcome: null, checked_at: null, records: [] } };
      return undefined;
    });
    await page.submit();
    expect(page.text('now')).toContain('Looking on the official registry…');
    state = 'reading';
    await page.poll();
    expect(page.text('now')).toContain('Found the record. Reading it…');
    expect(page.text('now')).not.toContain('Looking on the official registry…');
    expect(page.el('card').hidden).toBe(true);
    expect(page.text('go-label')).toBe('Checking…');
    expect(page.el('go').disabled).toBe(true);
    expect(page.el('go').attrs['aria-disabled']).toBe('true');
  });

  it('offers the live view as a press that opens a new tab, only for an https address', async () => {
    const reply = (url: string): Handler =>
      answers({
        status: 202,
        json: { ...baseResult, state: 'searching', outcome: null, records: [], streaming_url: url },
      });
    const page = mount(await load(), reply('https://stream.example.test/v'));
    await page.submit();
    const link = page.el('now').find((n) => n.tag === 'a')[0];
    expect(link.textContent).toBe('Watch it work');
    expect(link.attrs.target).toBe('_blank');
    const none = mount(await load(), reply('http://stream.example.test/v'));
    await none.submit();
    expect(none.el('now').find((n) => n.tag === 'a')).toHaveLength(0);
  });

  it('shows "Checking public complaints…" for a partial answer, then fills it in without redrawing the rest', async () => {
    const partialRecord = {
      ...nurse,
      discipline: { checked: false, on_file: null, actions: [], read_by: null, reason: 'Complaint check in progress.' },
    };
    const partial: Reply = {
      status: 202,
      json: {
        ...baseResult,
        state: 'reading',
        outcome: null,
        checked_at: null,
        records: [partialRecord],
        pending: ['complaints'],
      },
    };
    let final = false;
    const page = mount(await load(), (m, p) => {
      if (m === 'POST' && p === '/verify') return partial;
      if (m === 'GET' && p === '/verify/chk_1') {
        return final
          ? done({
              records: [
                { ...nurse, discipline: { checked: true, on_file: true, actions: ['Fine paid'], read_by: 'agent' } },
              ],
            })
          : partial;
      }
      return undefined;
    });
    await page.submit();
    const first = page.el('card').textContent;
    expect(first).toContain('JANE SMITH');
    expect(first).toContain('Checking public complaints…');
    expect(first).not.toContain('Complaint check in progress.');
    expect(first).not.toContain('See the proof');
    const verdictNode = page.el('card').find((n) => n.className === 'say')[0];
    final = true;
    await page.poll();
    const last = page.el('card').textContent;
    expect(last).not.toContain('Checking public complaints');
    expect(last).toContain('1 complaint on file.');
    expect(last).toContain('Fine paid');
    expect(last.match(/See the proof/g)).toHaveLength(1);
    expect(page.el('card').find((n) => n.className === 'say')[0]).toBe(verdictNode);
    expect(page.scene.filter((call) => call[0] === 'word')).toEqual([['word', 'Active.']]);
  });

  it('lists several matches, picks none, and checks the one that is pressed', async () => {
    const page = mount(await load(), (m, p, body) => {
      if (m === 'POST' && p === '/verify' && body.check_id) return done();
      return answers(several())(m, p, body);
    });
    page.type('Jane Smith');
    page.choose('nurse', 'US-FL');
    await page.submit();
    expect(page.text('card')).toContain('Which one?');
    expect(page.text('card')).toContain('Found 2 licences under that name. Pick the one you mean.');
    expect(page.text('card')).not.toContain('Licensed and active.');
    expect(page.scene.slice(1)).toEqual([
      ['word', 'Which one?'],
      ['mode', 'orbit'],
    ]);
    await page.press('JANE SMITH');
    expect(page.verifyCalls()[1].body).toEqual({ check_id: 'chk_1', candidate_id: 'c1' });
    expect(page.text('card')).toContain('Licensed and active.');
  });

  it('narrows a common name by city from the card, until the name is changed', async () => {
    const page = mount(await load(), answers(several({ candidates_total: 40 })));
    page.type('Jane Smith');
    await page.submit();
    expect(page.text('card')).toContain('Showing the first 2. Add a city or use the licence number to narrow it.');
    page.el('card').find((n) => n.tag === 'input')[0].value = ' Miami ';
    await page.press('Search in this city');
    expect(page.verifyCalls()[1].body).toMatchObject({ name: 'Jane Smith', city: 'Miami' });
    expect(page.el('card').find((n) => n.tag === 'input')[0].value).toBe('Miami');
    page.type('Jane Smyth');
    await page.submit();
    expect(page.verifyCalls()[2].body).not.toHaveProperty('city');
  });

  it('says "No answer." once when the page could not be read with confidence, and offers the official registry', async () => {
    const page = mount(
      await load(),
      answers(
        done({
          outcome: 'needs_review',
          records: [],
          warnings: ['generic_route', 'not_grounded'],
          unsupported: { registry_url: 'https://www.tx.gov/licensing' },
        }),
      ),
    );
    await page.submit();
    expect(page.text('card').match(/No answer\./g)).toHaveLength(1);
    expect(page.text('card')).toContain('The official page could not be read with confidence, so nothing is shown.');
    const link = page.el('card').find((n) => n.tag === 'a')[0];
    expect(link.attrs.href).toBe('https://www.tx.gov/licensing');
    expect(link.textContent).toBe('Open the official registry');
    expect(page.scene.slice(1)).toEqual([
      ['word', 'No answer.'],
      ['mode', 'hide'],
    ]);
  });

  it('shows the plain sentence for a refused input (400 with a result) and for a bad request', async () => {
    const invalid = mount(
      await load(),
      answers({
        status: 400,
        json: {
          ...baseResult,
          state: 'done',
          outcome: 'invalid_input',
          checked_at: 'x',
          records: [],
          invalid: { field: 'city', expected: 'letters only' },
        },
      }),
    );
    await invalid.submit();
    expect(invalid.text('card')).toBe('The city needs letters only.');
    expect(invalid.scene.slice(1)).toEqual([
      ['word', 'TinyVerify'],
      ['mode', 'swim'],
    ]);
    const bad = mount(
      await load(),
      answers({ status: 400, json: { error: { message: 'Invalid input: city must be text' } } }),
    );
    await bad.submit();
    expect(bad.text('card')).toBe('Invalid input: city must be text');
  });

  it('says the free checks are used up on HTTP 429', async () => {
    const page = mount(
      await load(),
      answers({
        status: 429,
        json: {
          error: { code: 'rate_limited', message: 'x' },
          resets_at: new Date(Date.now() + 3600_000).toISOString(),
        },
      }),
    );
    await page.submit();
    expect(page.text('card')).toContain('The free checks from this address are used up for now. They start again');
    expect(page.el('go').disabled).toBe(false);
  });

  it('says something went wrong for anything else', async () => {
    const page = mount(await load(), answers({ status: 500, json: {} }));
    await page.submit();
    expect(page.text('card')).toBe('Something went wrong on our side. Nothing was checked.');
    expect(page.el('eg').hidden).toBe(false);
  });

  it('goes back to the first screen from the name at the top, and drops a check still under way', async () => {
    const page = mount(
      await load(),
      answers({ status: 202, json: { ...baseResult, state: 'searching', outcome: null, records: [] } }),
    );
    await page.submit();
    await page.click('home');
    expect(page.el('card').hidden).toBe(true);
    expect(page.el('eg').hidden).toBe(false);
    expect(page.el('go').disabled).toBe(false);
    expect(page.scene.slice(-2)).toEqual([
      ['word', 'TinyVerify'],
      ['mode', 'swim'],
    ]);
    // The fake page cannot cancel a timer, so the old poll still fires here; its answer must change nothing.
    await page.poll();
    expect(page.el('card').hidden).toBe(true);
    expect(page.el('go').disabled).toBe(false);
    expect(page.scene.slice(-2)).toEqual([
      ['word', 'TinyVerify'],
      ['mode', 'swim'],
    ]);
  });

  it('shows no internal word in anything it draws', async () => {
    const outcomes: object[] = [
      { outcome: 'no_match', records: [], query: { name: 'X' } },
      { outcome: 'needs_review', records: [] },
      { outcome: 'source_unavailable', records: [], unavailable: { reason: 'blocked' } },
      { outcome: 'source_unavailable', records: [], unavailable: { reason: 'budget' } },
      {
        outcome: 'unsupported',
        records: [],
        unsupported: { registry_name: 'X', registry_url: 'https://example.test/r' },
      },
      {
        outcome: 'invalid_input',
        records: [],
        invalid: { field: 'candidate_id', expected: 'a candidate_id from an earlier result' },
      },
      {
        records: [
          {
            ...nurse,
            licence: { ...nurse.licence, status: 'other', status_raw: 'Odd' },
            warnings: ['status_unknown_wording', 'complaints_not_checked'],
            discipline: { checked: false, on_file: null, actions: [], read_by: null, reason: 'complaints_not_checked' },
          },
        ],
      },
    ];
    for (const extra of outcomes) {
      const page = mount(await load(), answers(done(extra)));
      await page.submit();
      const text = page.el('card').textContent.split('Florida Department of Health, MQA licence verification').join('');
      expect(bannedIn(text), text).toEqual([]);
      expect(text).not.toMatch(/[a-z]+_[a-z]+/);
    }
  });
});

describe('keeping a watch', () => {
  const watching: Handler = (m, p) => {
    if (m === 'POST' && p === '/verify') return done();
    if (m === 'POST' && p === '/watch') return { status: 201, json: { watch_id: 'w1', pending: false } };
    if (m === 'POST' && p === '/watch/w1/check-now') return { status: 200, json: { ok: true } };
    if (m === 'DELETE' && p === '/watch/w1') return { status: 200, json: { ok: true } };
    return undefined;
  };
  const keyField = (page: ReturnType<typeof mount>): Node_ => page.el('card').find((n) => n.tag === 'input')[0];

  it('asks for the key in the card, at the moment it is needed, and sends nothing before', async () => {
    const page = mount(await load(), watching);
    await page.submit();
    expect(page.text('card')).not.toContain('it needs a key');
    expect(keyField(page).parent?.hidden).toBe(true);
    await page.press('Watch this licence');
    expect(page.text('card')).toContain(
      'Watching checks the official record every day and records what changed. It costs money to run, so it needs a key. Ask the owner of this service for one.',
    );
    expect(keyField(page).parent?.hidden).toBe(false);
    expect(page.doc.focused).toBe(keyField(page));
    expect(page.el('panel').hidden).toBe(true);
    await page.press('Start watching');
    expect(page.sent.some((s) => s.path === '/watch')).toBe(false);
  });

  it('starts a watch with the key, then checks it now and stops it, all in the card', async () => {
    const page = mount(await load(), watching);
    await page.submit();
    expect(page.el('card').byText('Check it now').parent?.hidden).toBe(true);
    await page.press('Watch this licence');
    keyField(page).value = ' secret-key ';
    await page.press('Start watching');
    const made = page.sent.find((s) => s.path === '/watch');
    expect(made?.auth).toBe('Bearer secret-key');
    expect(made?.body).toMatchObject({ registry: 'fl-mqa', licence_number: NURSE, kind: 'record' });
    expect(page.text('card')).toContain('Watching started. It checks this licence every day.');
    expect(keyField(page).parent?.hidden).toBe(true);
    expect(page.el('card').byText('Check it now').parent?.hidden).toBe(false);
    await page.press('Check it now');
    expect(page.text('card')).toContain('Checked just now.');
    await page.press('Stop watching');
    expect(page.text('card')).toContain('Watching stopped.');
    expect(page.el('card').byText('Check it now').parent?.hidden).toBe(true);
  });

  it('remembers the key for the tab, so a second licence is watched with one press', async () => {
    const page = mount(await load(), watching);
    await page.submit();
    await page.press('Watch this licence');
    keyField(page).value = 'secret-key';
    await page.press('Start watching');
    await page.submit();
    await page.press('Watch this licence');
    expect(page.sent.filter((s) => s.path === '/watch')).toHaveLength(2);
  });

  it('asks for the key again when the service does not know it', async () => {
    const page = mount(await load(), (m, p) => {
      if (m === 'POST' && p === '/verify') return done();
      if (m === 'POST' && p === '/watch')
        return {
          status: 401,
          json: { error: { code: 'unauthorised', message: 'Send an API key in the Authorization header' } },
        };
      return undefined;
    });
    await page.submit();
    await page.press('Watch this licence');
    keyField(page).value = 'wrong-key';
    await page.press('Start watching');
    expect(page.text('card')).toContain('Send an API key in the Authorization header');
    expect(keyField(page).parent?.hidden).toBe(false);
    expect(page.el('card').byText('Check it now').parent?.hidden).toBe(true);
  });
});

describe('using your own TinyFish key', () => {
  const spent = done({
    outcome: 'source_unavailable',
    records: [],
    unavailable: { reason: 'budget' },
    unsupported: { registry_url: 'https://www.tx.gov/licensing' },
  });

  it('explains the cost and what happens to the key, beside the field', async () => {
    const html = await load();
    expect(html).toContain('each check is charged to your TinyFish account, usually 10 to 60 cents');
    expect(html).toContain(
      'used for your check only, held encrypted while that check is under way, and deleted when it ends',
    );
    expect(html).toContain('<input id="own" type="password" autocomplete="off">');
  });

  it('sends the key with a check and with nothing else, and only once one is typed', async () => {
    const page = mount(await load(), answers(done()));
    await page.submit();
    page.el('own').value = ' tf_my_key ';
    page.el('own').fire('input');
    expect(page.text('own-msg')).toBe('Checks from this tab now use your key.');
    expect(page.text('own-say')).toBe('Checks from this tab use your own TinyFish key.');
    expect(page.text('ownBtn')).toBe('Change it');
    await page.submit();
    const sentKey = (call: { headers?: Record<string, string> }) => call.headers?.['X-TinyFish-Key'];
    expect(page.verifyCalls().map(sentKey)).toEqual([undefined, 'tf_my_key']);
    expect(page.sent.filter((s) => s.path !== '/verify').some((s) => sentKey(s) !== undefined)).toBe(false);
  });

  it('offers the field when the free checks are used up, and not once a key is in use', async () => {
    const page = mount(await load(), answers(spent));
    await page.submit();
    expect(page.text('card')).toContain("Today's free checks are used up.");
    await page.press('Use my own TinyFish key');
    expect(page.el('panel').hidden).toBe(false);
    expect(page.doc.focused).toBe(page.el('own'));
    page.el('own').value = 'tf_my_key';
    page.el('own').fire('input');
    await page.submit();
    expect(page.text('card')).not.toContain('Use my own TinyFish key');
    expect(page.text('card')).toContain('Open the official registry');
  });
});

describe('the watchlist', () => {
  const watches = {
    watches: [
      {
        watch_id: 'a',
        registry: 'fl-mqa',
        licence_number: DOCTOR,
        events: [
          {
            kind: 'unchanged',
            created_at: new Date(2026, 10, 9, 20, 21).toISOString(),
            before: null,
            after: null,
            evidence: { note: 'raw note' },
          },
          {
            kind: 'check_failed',
            created_at: new Date(2026, 10, 8, 19, 3).toISOString(),
            before: null,
            after: null,
            evidence: { note: 'blocked: raw note' },
          },
          {
            kind: 'status_change',
            created_at: new Date(2026, 10, 7, 8, 0).toISOString(),
            before: { status: 'active' },
            after: { status: 'suspended' },
            evidence: {},
          },
          {
            kind: 'unchanged',
            created_at: new Date(2026, 10, 6, 8, 0).toISOString(),
            before: null,
            after: null,
            evidence: {},
          },
        ],
      },
    ],
  };
  const status = {
    registries: [
      { id: 'fl-mqa', health: 'ok' },
      { id: 'fl-dbpr', health: 'degraded' },
      { id: 'ca-cslb', health: 'unknown' },
    ],
    tinyfish: 'ok',
    budget: { public: 'ok', judge: 'ok', ops: 'ok' },
  };
  const feed: Handler = (m, p) =>
    p === '/watches/public'
      ? { status: 200, json: watches }
      : p === '/status'
        ? { status: 200, json: status }
        : undefined;

  it('shows one view at a time under its own title', async () => {
    const page = mount(await load(), feed);
    const shown = (): string[] => ['watch', 'key', 'status'].filter((name) => !page.el(`view-${name}`).hidden);
    await page.click('watchBtn');
    expect([page.text('panelTitle'), shown()]).toEqual(['Watched licences', ['watch']]);
    await page.click('statusBtn');
    expect([page.text('panelTitle'), shown()]).toEqual(['Is everything answering?', ['status']]);
    await page.click('ownBtn');
    expect([page.text('panelTitle'), shown()]).toEqual(['Your own TinyFish key', ['key']]);
    expect(page.doc.focused).toBe(page.el('own'));
    await page.click('watchBtn');
    expect(page.el('panel').hidden).toBe(false);
    expect(shown()).toEqual(['watch']);
    await page.click('watchBtn');
    expect(page.el('panel').hidden).toBe(true);
  });

  it('opens and closes from its button, and closes on the cross and on Escape', async () => {
    const page = mount(await load(), feed);
    await page.click('watchBtn');
    expect(page.el('panel').hidden).toBe(false);
    expect(page.doc.focused).toBe(page.el('panelClose'));
    await page.click('watchBtn');
    expect(page.el('panel').hidden).toBe(true);
    await page.click('watchBtn');
    await page.click('panelClose');
    expect(page.el('panel').hidden).toBe(true);
    await page.click('watchBtn');
    for (const fn of page.doc.body.listeners.keydown ?? []) fn({ key: 'Escape' });
    expect(page.el('panel').hidden).toBe(true);
  });

  it('counts the watched licences on its button', async () => {
    const page = mount(await load(), feed);
    await page.flush();
    expect(page.text('wc')).toBe('1');
  });

  it('lists each watch with its three newest events as sentences and no raw note', async () => {
    const page = mount(await load(), feed);
    await page.flush();
    const text = page.text('watched');
    expect(text).toContain(`Florida health licence ${DOCTOR}`);
    expect(text).toContain('the check could not be completed.');
    expect(text).toContain('status changed from active to suspended.');
    expect(text).not.toContain('raw note');
    expect(text.match(/: /g)).toHaveLength(3);
    expect(
      page
        .el('watched')
        .find((n) => n.className === 'small changed')
        .map((n) => n.textContent),
    ).toEqual([expect.stringContaining('status changed from active to suspended.')]);
  });

  it('says so when nothing is watched or the list cannot be loaded', async () => {
    const empty = mount(await load(), (m, p) =>
      p === '/watches/public' ? { status: 200, json: { watches: [] } } : undefined,
    );
    await empty.flush();
    expect(empty.text('watched')).toBe('No licences are being watched.');
    expect(empty.text('wc')).toBe('0');
    const broken = mount(await load(), noop);
    await broken.flush();
    expect(broken.text('watched')).toBe('The watched licences could not be loaded.');
  });

  it('says whether each registry and the free allowance are answering', async () => {
    const page = mount(await load(), feed);
    await page.flush();
    const text = page.text('health');
    expect(text).toContain("Florida's health board: answering.");
    expect(text).toContain("Florida's contractor board: not answering.");
    expect(text).toContain("California's contractor board: not checked yet today.");
    expect(text).toContain('TinyFish: answering.');
    expect(text).toContain('Free checks left today: yes.');
    expect(bannedIn(text)).toEqual([]);
  });
});
