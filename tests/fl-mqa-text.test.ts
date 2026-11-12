import { describe, expect, it } from 'vitest';
import { parseText } from '../src/registries/parsers/fl-mqa.lines';
import { STATUS_TABLES } from '../src/registries/status-tables';

// Every saved Florida MQA record page, read as raw HTML, with the Fields a person
// read off the page before scrubbing (the sibling *.expected.json).
const pages = import.meta.glob('./fixtures/fl-mqa/*.html', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const expected = import.meta.glob('./fixtures/fl-mqa/*.expected.json', {
  import: 'default',
  eager: true,
}) as Record<string, Record<string, unknown>>;

const LIVE = './fixtures/fl-mqa/live-physician-1.fetch.html';

// A minimal record page with one label/value pair per line, for status wordings.
function pageWithStatus(raw: string): string {
  return `<html><body><p>Printer Friendly Version</p><p>SAMPLE, PERSON A</p>
<p>License Number: ME000009</p><p>Data As Of 1/2/2026</p>
<p>Profession</p><p>Medical Doctor</p>
<p>License Status</p><p>${raw}</p>
<p>Discipline on File</p><p>No</p><p>Public Complaint</p><p>No</p></body></html>`;
}

describe('fl-mqa text reader: fixtures', () => {
  it('finds every fixture and its expected values', () => {
    expect(Object.keys(pages).length).toBeGreaterThanOrEqual(12);
    for (const path of Object.keys(pages)) {
      expect(expected[path.replace(/\.html$/, '.expected.json')], path).toBeDefined();
    }
  });

  for (const path of Object.keys(pages)) {
    it(`reads ${path.split('/').pop()} to the expected fields`, () => {
      const reading = parseText(pages[path]);
      expect(reading.reader).toBe('parser_text');
      expect(reading.fields).toEqual(expected[path.replace(/\.html$/, '.expected.json')]);
    });

    it(`quotes one line per non-null field in ${path.split('/').pop()}`, () => {
      const reading = parseText(pages[path]);
      const nonNull = Object.values(reading.fields).filter((v) => v !== null && !Array.isArray(v)).length;
      expect(reading.quotes.length).toBe(nonNull);
      for (const q of reading.quotes) expect(q.trim()).not.toBe('');
    });
  }
});

describe('fl-mqa text reader: labels and warnings', () => {
  it('warns and leaves the field null when a label is removed', () => {
    const html = pages[LIVE].replace('License Status', 'Licence Status');
    const reading = parseText(html);
    expect(reading.fields.status_raw).toBeNull();
    expect(reading.fields.status).toBeNull();
    expect(reading.warnings).toContain('label not found: License Status');
    expect(reading.fields.licence_number).toBe('ME000000');
  });

  it('warns for a removed same-line label', () => {
    const html = pages[LIVE].replace('Data As Of', 'Data Valid');
    const reading = parseText(html);
    expect(reading.fields.data_as_of).toBeNull();
    expect(reading.warnings).toContain('label not found: Data As Of');
  });

  it('has no warnings on a complete live page', () => {
    expect(parseText(pages[LIVE]).warnings).toEqual([]);
  });

  it('gives an empty discipline_actions and other_names', () => {
    const reading = parseText(pages[LIVE]);
    expect(reading.fields.discipline_actions).toEqual([]);
    expect(reading.fields.other_names).toEqual([]);
  });

  it('does not read Public Complaint Definition as the Public Complaint label', () => {
    const html = pages[LIVE].replace('Public Complaint', 'Public Complain');
    expect(parseText(html).warnings).toContain('label not found: Public Complaint');
  });
});

describe('fl-mqa text reader: status wordings', () => {
  const cases: [string, string][] = [
    ['Clear/Active', 'active'],
    ['CLEAR/ACTIVE', 'active'],
    ['Null and Void', 'inactive'],
    ['Null And Void/', 'inactive'],
    ['OBLIGATIONS/ACTIVE', 'probation'],
    ['DISCP-RELINQ/', 'surrendered'],
    ['DISCP RELINQ/', 'surrendered'],
    ['DELINQUENT/', 'delinquent'],
    ['REVOKED/', 'revoked'],
    ['Emerg Suspens/', 'suspended'],
    ['Suspended', 'suspended'],
    ['Probation', 'probation'],
    ['Expired', 'expired'],
    ['Pending', 'pending'],
    ['Retired', 'inactive'],
    ['Something new', 'other'],
  ];
  for (const [raw, status] of cases) {
    it(`maps "${raw}" to ${status}`, () => {
      const reading = parseText(pageWithStatus(raw));
      expect(reading.fields.status_raw).toBe(raw);
      expect(reading.fields.status).toBe(status);
    });
  }

  it('maps every wording in the shared fl-mqa table to the table value', () => {
    const table = STATUS_TABLES['fl-mqa'];
    const keys = Object.keys(table);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const html = pages[LIVE].replace('Clear/Active', key);
      expect(parseText(html).fields.status, key).toBe(table[key]);
    }
  });

  it('leaves status null and warns when the status cell is blank', () => {
    const reading = parseText(pages[LIVE].replace('Clear/Active', ''));
    expect(reading.fields.status_raw).toBeNull();
    expect(reading.fields.status).toBeNull();
    expect(reading.warnings).toContain('label not found: License Status');
  });
});

describe('fl-mqa text reader: empty values and dates', () => {
  it('never takes the next label line as a value', () => {
    const reading = parseText(pages[LIVE].replace('Clear/Active', ''));
    expect(reading.fields.status_raw).not.toBe('Qualifications');
  });

  it('gives null and a warning for an impossible date, and keeps valid dates', () => {
    const bad = parseText(pages[LIVE].replace('1/31/2028', '2/30/2028'));
    expect(bad.fields.expires).toBeNull();
    expect(bad.warnings).toContain('could not read date: License Expiration Date');
    expect(bad.fields.issued).toBe('2026-04-20');
    expect(parseText(pages[LIVE]).fields.expires).toBe('2028-01-31');
  });

  it('reads a city in any two-letter state', () => {
    const reading = parseText(pages[LIVE].replace('SAMPLE CITY, FL 00000', 'SAMPLE CITY, GA 30301'));
    expect(reading.fields.city).toBe('SAMPLE CITY');
  });
});

describe('fl-mqa text reader: discipline', () => {
  it('sets discipline_flag from Public Complaint Yes when Discipline on File is No', () => {
    const html =
      '<html><body><p>Discipline on File</p><p>No</p><p>Public Complaint</p>' +
      '<p>Yes - Click on Discipline/Admin Action tab to see more details</p></body></html>';
    const reading = parseText(html);
    expect(reading.fields.discipline_flag).toBe(true);
    expect(reading.quotes).toContain('Yes - Click on Discipline/Admin Action tab to see more details');
  });

  it('lists an alert with no order line as one action, its alert line', () => {
    const html =
      '<html><body><p>Discipline on File</p><p>No</p><p>Alerts</p>' +
      '<p>Enforcement Alert 8/14/2023 4:28:31 PM</p></body></html>';
    const reading = parseText(html);
    expect(reading.fields.discipline_actions).toEqual(['Enforcement Alert 8/14/2023 4:28:31 PM']);
    expect(reading.fields.discipline_flag).toBe(true);
  });

  it('lists every order line in page order when there are two', () => {
    const html =
      '<html><body><p>Discipline on File</p><p>No</p>' +
      '<p>Emergency Restriction Order filed 08/14/2023.</p>' +
      '<p>Emergency Suspension Order filed 09/01/2023.</p></body></html>';
    expect(parseText(html).fields.discipline_actions).toEqual([
      'Emergency Restriction Order filed 08/14/2023.',
      'Emergency Suspension Order filed 09/01/2023.',
    ]);
  });

  it('lists the emergency order line as a discipline action and sets the flag', () => {
    const html = pages[LIVE].replace(
      'Printer Friendly Version',
      'Printer Friendly Version</p><p>Enforcement Alert</p><p>8/14/2023 4:28:31 PM</p><p>Emergency Restriction Order filed 08/14/2023.',
    );
    const reading = parseText(html);
    expect(reading.fields.discipline_actions).toEqual([
      'Enforcement Alert',
      'Emergency Restriction Order filed 08/14/2023.',
    ]);
    expect(reading.fields.discipline_flag).toBe(true);
  });
});

describe('fl-mqa text reader: timing', () => {
  it('parses the live fixture in under 10 ms', () => {
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      parseText(pages[LIVE]);
      times.push(performance.now() - start);
    }
    const best = Math.min(...times);
    console.log(`fl-mqa text reader, live fixture: best of 5 = ${best.toFixed(2)} ms`);
    expect(best).toBeLessThan(10);
  });
});
