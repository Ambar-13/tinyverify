import { describe, expect, it } from 'vitest';
import { agree } from '../src/lookup/agree';
import { flDbpr } from '../src/registries/fl-dbpr';
import { flMqa } from '../src/registries/fl-mqa';
import type { Adapter } from '../src/registries/adapter';
import { emptyFields } from '../src/registries/shared';
import { FAKE_BUSINESS, scrub } from '../scripts/capture-scrub';
import { parseEnforcementTab } from '../src/registries/fl-mqa';

// TinyFish Fetch does not return a page's own HTML. It returns extracted content with no field labels
// on the contractor page and <strong>/<dd> pairs on the health page. These fixtures are scrubbed real
// Fetch-form captures (or variants derived from them, named derived-*), and both readers must read them.
const pages = import.meta.glob(
  ['./fixtures/fl-mqa/tf/*.html', './fixtures/fl-dbpr/tf/*.html', './fixtures/fl-mqa/tabs/*.html'],
  {
    query: '?raw',
    import: 'default',
    eager: true,
  },
) as Record<string, string>;
const page = (name: string): string => {
  const hit = Object.entries(pages).find(([k]) => k.endsWith(`/${name}`));
  if (!hit) throw new Error(`missing fixture ${name}`);
  return hit[1];
};

function both(adapter: Adapter, html: string) {
  const dom = adapter.parseHtml(html);
  const text = adapter.parseText(html);
  return { dom, text, agreed: agree([dom, text]) };
}

describe('fl-mqa reads the Fetch form', () => {
  const physician = {
    name: 'SAMPLE, PERSON A',
    licence_number: 'ME000000',
    status_raw: 'Clear/Active',
    status: 'active',
    expires: '2028-01-31',
    issued: '2026-04-20',
    licence_type: 'Medical Doctor',
    discipline_flag: false,
    discipline_actions: [],
    data_as_of: '2026-11-08',
    city: 'SAMPLE CITY',
    other_names: [],
  };

  it('both readers read the physician record and agree', () => {
    const r = both(flMqa, page('physician-active.tf.html'));
    expect(r.dom.fields).toEqual(physician);
    expect(r.text.fields).toEqual(physician);
    expect(r.dom.warnings).toEqual([]);
    expect(r.agreed.agree).toBe(true);
  });

  it('both readers read the nurse record and agree on every compared field', () => {
    const r = both(flMqa, page('nurse-active.tf.html'));
    for (const reading of [r.dom, r.text]) {
      expect(reading.fields.licence_number).toBe('RN0000000');
      expect(reading.fields.status).toBe('active');
      expect(reading.fields.expires).toBe('2027-04-30');
      expect(reading.fields.issued).toBe('2021-12-02');
      expect(reading.fields.licence_type).toBe('Registered Nurse');
      expect(reading.fields.city).toBe('SAMPLE CITY');
      expect(reading.fields.discipline_flag).toBe(false);
    }
    expect(r.agreed.agree).toBe(true);
  });

  it('a derived non-active status reads as that status in both readers', () => {
    const r = both(flMqa, page('derived-not-active.tf.html'));
    expect(r.dom.fields.status_raw).toBe('Retired');
    expect(r.dom.fields.status).toBe('inactive');
    expect(r.text.fields.status).toBe('inactive');
    expect(r.agreed.agree).toBe(true);
  });

  it('a disciplined, delinquent nurse reads the same in both readers', () => {
    const r = both(flMqa, page('nurse-disciplined.tf.html'));
    for (const reading of [r.dom, r.text]) {
      expect(reading.fields.licence_number).toBe('PN0000000');
      expect(reading.fields.status_raw).toBe('DELINQUENT/');
      expect(reading.fields.status).toBe('delinquent');
      expect(reading.fields.discipline_flag).toBe(true);
    }
    expect(r.agreed.agree).toBe(true);
  });

  it('the DOM reader still finds nothing it cannot read: a page with no labels gives nulls and warnings', () => {
    const dom = flMqa.parseHtml('<html><body><p>hello</p></body></html>');
    expect(dom.fields.licence_number).toBeNull();
    expect(dom.warnings.length).toBeGreaterThan(0);
  });
});

describe('the enforcement tab through Fetch', () => {
  it('reads the tables that come back with no headings, in section order, after an empty first section', () => {
    expect(parseEnforcementTab(page('enforcement-tab.disciplined.tf.html'))).toEqual([
      'Discipline Cases | 000101 | Suspension',
      'Discipline Cases | 000102 | Suspension',
      'Public Complaints | 000103 | AC Filed',
      'Public Complaints | 000104 | AC Filed',
    ]);
  });

  it('still reads the page-HTML shape with its h5 headings', () => {
    const lines = parseEnforcementTab(page('enforcement-tab.fetch.html')) ?? [];
    expect(lines.some((l) => l.startsWith('Emergency Actions'))).toBe(true);
    expect(lines.some((l) => l.startsWith('Discipline Cases'))).toBe(true);
  });

  const CASE_TABLE =
    '<table><tr><th>Name</th><th>Case #</th><th>Action Taken</th></tr><tr><td>X</td><td>000900</td><td>AC Filed</td></tr></table>';
  const PLAIN_TABLE = '<table><tr><th>Name</th><th>Reference</th></tr><tr><td>X</td><td>000900</td></tr></table>';
  const wrap = (body: string): string => `<html><body>${body}</body></html>`;

  it('reads the live clean record: three empty sections worded as the registry words them', () => {
    expect(parseEnforcementTab(page('enforcement-tab.clean.tf.html'))).toEqual([]);
  });

  it('a clean tab missing its third section is still not parsed', () => {
    expect(parseEnforcementTab(wrap('<p>No Emergency Actions Found</p><p>No Discipline Found</p>'))).toBeNull();
  });

  it('a clean-worded discipline sentence in the wrong place is not parsed', () => {
    expect(
      parseEnforcementTab(
        wrap('<p>No Discipline Found</p><p>No Emergency Actions Found</p><p>No Public Complaint Found</p>'),
      ),
    ).toBeNull();
  });

  it('a page with one section marker is not parsed', () => {
    expect(parseEnforcementTab(wrap('<p>No Emergency Actions Found</p>'))).toBeNull();
  });

  it('reads three empty sections as parsed with no actions', () => {
    const html = wrap(
      '<p>No Emergency Actions Found</p><p>No Discipline Cases Found</p><p>No Public Complaints Found</p>',
    );
    expect(parseEnforcementTab(html)).toEqual([]);
  });

  it('is not parsed when a no-discipline sentence is followed by a complaint table and the emergency section has no marker', () => {
    expect(parseEnforcementTab(wrap(`<p>No Discipline Cases Found</p>${CASE_TABLE}`))).toBeNull();
  });

  it('is not parsed when the empty sections are worded in a way the reader does not know', () => {
    const html = wrap(`<p>No Emergency Action Found</p><p>No Disciplinary Actions Found</p>${CASE_TABLE}`);
    expect(parseEnforcementTab(html)).toBeNull();
  });

  it('is not parsed when the sentences are out of section order', () => {
    const html = wrap(`<p>No Discipline Cases Found</p><p>No Emergency Actions Found</p>${CASE_TABLE}`);
    expect(parseEnforcementTab(html)).toBeNull();
  });

  it('is not parsed for an error page that holds an unrelated table', () => {
    expect(parseEnforcementTab(wrap(`<h1>Error</h1>${CASE_TABLE}`))).toBeNull();
    expect(parseEnforcementTab(wrap(`<p>Something went wrong</p>${PLAIN_TABLE}`))).toBeNull();
    expect(parseEnforcementTab(wrap(`${CASE_TABLE}${CASE_TABLE}${PLAIN_TABLE}`))).toBeNull();
  });

  it('is not parsed for four markers, so a section cannot be misplaced', () => {
    const html = wrap(`<p>No Emergency Actions Found</p><p>No Discipline Cases Found</p>${CASE_TABLE}${CASE_TABLE}`);
    expect(parseEnforcementTab(html)).toBeNull();
  });

  it('gives no actions for an empty string and a page with no tables', () => {
    expect(parseEnforcementTab('')).toBeNull();
    expect(parseEnforcementTab(wrap('<p>hello</p>'))).toBeNull();
  });

  it('puts a table under the section its position gives it, after two empty sentences', () => {
    const html = wrap(`<p>No Emergency Actions Found</p><p>No Discipline Cases Found</p>${CASE_TABLE}`);
    expect(parseEnforcementTab(html)).toEqual(['Public Complaints | 000900 | AC Filed']);
  });
});

describe('fl-dbpr reads the Fetch form', () => {
  const building = {
    name: 'SAMPLE, PERSON A',
    licence_number: 'CBC0000000',
    status_raw: 'Current,Active',
    status: 'active',
    expires: '2028-08-31',
    issued: '2016-01-20',
    licence_type: 'Certified Building Contractor',
    city: 'SAMPLE CITY',
  };

  it('both readers read the building contractor record and agree', () => {
    const r = both(flDbpr, page('contractor-cbc.tf.html'));
    for (const reading of [r.dom, r.text]) {
      for (const [k, v] of Object.entries(building))
        expect(reading.fields[k as keyof typeof reading.fields], k).toBe(v);
    }
    expect(r.dom.warnings).toEqual([]);
    expect(r.text.warnings).toEqual([]);
    expect(r.agreed.agree).toBe(true);
  });

  it('both readers read the roofing contractor record, with its repeated address block, and agree', () => {
    const r = both(flDbpr, page('contractor-ccc.tf.html'));
    for (const reading of [r.dom, r.text]) {
      expect(reading.fields.licence_number).toBe('CCC0000000');
      expect(reading.fields.status).toBe('active');
      expect(reading.fields.expires).toBe('2028-08-31');
      expect(reading.fields.issued).toBe('2024-03-06');
      expect(reading.fields.licence_type).toBe('Certified Roofing Contractor');
    }
    expect(r.agreed.agree).toBe(true);
  });

  it('a Null and Void record reads as inactive in both readers', () => {
    const r = both(flDbpr, page('contractor-null-void.tf.html'));
    for (const reading of [r.dom, r.text]) {
      expect(reading.fields.status_raw).toBe('Null and Void');
      expect(reading.fields.status).toBe('inactive');
      expect(reading.fields.expires).not.toBeNull();
    }
    expect(r.agreed.agree).toBe(true);
  });

  it('reads a city line that spells the state out, including a two-word state', () => {
    const r = both(flDbpr, page('derived-out-of-state.tf.html'));
    expect(r.dom.fields.city).toBe('SAMPLE CITY');
    expect(r.text.fields.city).toBe('SAMPLE CITY');
  });

  it('the DOM reader returns nulls with a warning when the second section has 5 fields', () => {
    const r = both(flDbpr, page('derived-five-fields.tf.html'));
    expect(r.dom.warnings).toContain('unexpected field count');
    for (const v of Object.values(r.dom.fields)) expect(v === null || (Array.isArray(v) && v.length === 0)).toBe(true);
    expect(r.agreed.agree).toBe(false);
  });

  it('the lines reader gives null dates with a warning when a date is missing, and still reads the rest', () => {
    const r = both(flDbpr, page('derived-five-fields.tf.html'));
    expect(r.text.fields.licence_number).toBe('CBC0000000');
    expect(r.text.fields.status).toBe('active');
    expect(r.text.fields.expires).toBeNull();
    expect(r.text.fields.issued).toBeNull();
    expect(r.text.warnings.length).toBeGreaterThan(0);
  });

  it('a derived non-active status reads as that status in both readers', () => {
    const r = both(flDbpr, page('derived-suspended.tf.html'));
    expect(r.dom.fields.status_raw).toBe('Suspended,Inactive');
    expect(r.dom.fields.status).toBe('suspended');
    expect(r.text.fields.status).toBe('suspended');
    expect(r.agreed.agree).toBe(true);
  });

  it('with the two dates swapped the lines reader still takes the later date as the expiry', () => {
    const r = both(flDbpr, page('derived-dates-swapped.tf.html'));
    expect(r.text.fields.expires).toBe('2028-08-31');
    expect(r.text.fields.issued).toBe('2016-01-20');
    // The DOM reader reads by position, so the swap shows up as a disagreement, not a wrong answer.
    expect(r.dom.fields.expires).toBe('2016-01-20');
    expect(r.agreed.agree).toBe(false);
  });

  it('a second section with two licence-number-shaped lines gives null with a warning in the lines reader', () => {
    const html = page('contractor-cbc.tf.html').replace('Cert Building', 'CBC0000001');
    const t = flDbpr.parseText(html);
    expect(t.fields.licence_number).toBeNull();
    expect(t.warnings.length).toBeGreaterThan(0);
  });
});

describe('a contractor record with no expiry', () => {
  const blank = (html: string): string => html.replace(/<p>\s*08\/31\/2028\s*<\/p>/, '<p></p>');

  it('both readers agree the expiry is absent, and the adapter warns', () => {
    const r = both(flDbpr, blank(page('contractor-cbc.tf.html')));
    expect(r.dom.fields.expires).toBeNull();
    expect(r.text.fields.expires).toBeNull();
    expect(r.agreed.agree).toBe(true);
    expect(flDbpr.recordWarnings?.(r.agreed.fields ?? emptyFields())).toEqual(['no_expiry_on_record']);
  });

  it('does not warn when the page shows an expiry', () => {
    const r = both(flDbpr, page('contractor-cbc.tf.html'));
    expect(flDbpr.recordWarnings?.(r.agreed.fields ?? emptyFields())).toEqual([]);
  });

  const fields = (status_raw: string | null, status: string | null, expires: string | null) => ({
    ...emptyFields(),
    status_raw,
    status: status as never,
    expires,
  });

  it('warns for every status that is not terminal when the expiry is null', () => {
    for (const [raw, status] of [
      ['Current,Active', 'active'],
      ['Current,Inactive', 'inactive'],
      ['Delinquent,Active', 'delinquent'],
      ['Suspended', 'suspended'],
      ['Expired', 'expired'],
      [null, null],
    ] as const) {
      expect(flDbpr.recordWarnings?.(fields(raw, status, null)), String(raw)).toEqual(['no_expiry_on_record']);
    }
  });

  it('does not warn for a revoked, surrendered or null and void record', () => {
    expect(flDbpr.recordWarnings?.(fields('Revoked', 'revoked', null))).toEqual([]);
    expect(flDbpr.recordWarnings?.(fields('Voluntary Relinquishment', 'surrendered', null))).toEqual([]);
    expect(flDbpr.recordWarnings?.(fields('Null and Void', 'inactive', null))).toEqual([]);
    expect(flDbpr.recordWarnings?.(fields(' null  AND void ', 'inactive', null))).toEqual([]);
  });

  it('does not warn when the expiry is present, whatever the status', () => {
    expect(flDbpr.recordWarnings?.(fields('Current,Active', 'active', '2028-08-31'))).toEqual([]);
    expect(flDbpr.recordWarnings?.(fields('Revoked', 'revoked', '2028-08-31'))).toEqual([]);
  });
});

describe('the capture scrub and business names', () => {
  // A capture made up for the test: the scrubbed contractor page with invented real-looking values put back.
  const capture = page('contractor-cbc.tf.html')
    .replace('SAMPLE, PERSON A (Primary Name)', 'DOE, JANE Q (Primary Name)')
    .replace('SAMPLE CONSTRUCTION, INC.', 'RIVERSIDE ROOFING PARTNERS LLC')
    .split('CBC0000000')
    .join('CBC1234567')
    .split('1 Sample St')
    .join('12 Oak Lane')
    .split('SAMPLE CITY, FL 00000')
    .join('TAMPA, FL 33601')
    .replace(/<p>\s*Sample\s*<\/p>/, '<p>Hillsborough</p>');

  it('replaces the business name line with the placeholder', () => {
    const out = scrub('fl-dbpr', capture);
    expect(out).not.toMatch(/RIVERSIDE|PARTNERS/i);
    expect(out).toContain(FAKE_BUSINESS);
  });

  it('leaves an empty business line empty', () => {
    const noBusiness = capture.replace(/<p>\s*RIVERSIDE ROOFING PARTNERS LLC\s*<\/p>/, '<p></p>');
    const out = scrub('fl-dbpr', noBusiness);
    expect(out).not.toContain(FAKE_BUSINESS);
  });

  describe('the complaint view scrub', () => {
    const cell = (text: string): string => `<td valign="top"><font face="verdana">${text}</font></td>`;
    const view = [
      '<h6>Complaint Details</h6><p>Below is a listing of public complaints.</p>',
      '<p><span class="fw-bold">Name</span><br><span> DOE, JANE Q</span></p>',
      '<table><thead><tr><th>Number</th><th>Class</th><th>Incident Date</th></tr></thead><tbody>',
      `<tr>${cell('2026031616')}${cell('Licensed Activity')}${cell('05/05/2026')}</tr>`,
      `<tr>${cell('2025041537')}${cell('Licensed Activity')}${cell('04/11/2025')}</tr>`,
      '</tbody></table><footer>Tallahassee, FL 32399 (850) 487.1395</footer>',
    ].join('\n');

    it('replaces the name and each case number in the first column, and keeps the other cells', () => {
      const out = scrub('fl-dbpr-complaints', view);
      expect(out).not.toMatch(/DOE|JANE|2026031616|2025041537/);
      expect(out).toContain(FAKE_BUSINESS);
      expect(out).toContain('2000000001');
      expect(out).toContain('2000000002');
      expect(out).toContain('05/05/2026');
      expect(out).toContain('Licensed Activity');
    });
  });
});
