import { describe, expect, it } from 'vitest';
import { toText } from '../src/text';
import type { Fields } from '../src/types';
import { parseText } from '../src/registries/parsers/fl-dbpr.lines';
import { STATUS_TABLES } from '../src/registries/status-tables';

// Every saved Florida DBPR licence page, read as raw HTML, with the Fields a person
// read off the page before scrubbing (the sibling *.expected.json).
const PREFIX = './fixtures/fl-dbpr/';

const pages = import.meta.glob('./fixtures/fl-dbpr/*.html', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const expectedFiles = import.meta.glob('./fixtures/fl-dbpr/*.expected.json', {
  import: 'default',
  eager: true,
}) as Record<string, Fields>;

const LIVE = `${PREFIX}live-contractor-1.fetch.html`;
const WAYBACK_ACTIVE = `${PREFIX}wayback-20210616-certified.wayback.html`;
const WAYBACK_2024 = `${PREFIX}wayback-20240730-registered.wayback.html`;

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

const expectedFor = (path: string): Fields => expectedFiles[path.replace(/\.html$/, '.expected.json')];

// One quote per non-null scalar field, plus one per other_names entry (each entry is
// quoted from its own page line). discipline_flag and data_as_of are null on this layout
// and carry no quote.
function expectedQuoteCount(f: Fields): number {
  const scalars = [f.name, f.licence_number, f.status_raw, f.status, f.expires, f.issued, f.licence_type, f.city];
  return scalars.filter((v) => v !== null).length + f.other_names.length;
}

// A minimal licence page with one label and value per line, for status wordings and label removals.
function pageWith(status: string, overrides: Record<string, string> = {}): string {
  const rows: [string, string][] = [
    ['Name:', 'SAMPLE, PERSON A (Primary Name)'],
    ['Main Address:', '1 Sample St'],
    ['', 'SAMPLE CITY, FL 00000'],
    ['License Type:', 'Certified Roofing Contractor'],
    ['License Number:', 'CCC0000000'],
    ['Status:', status],
    ['Licensure Date:', '03/06/2024'],
    ['Expires:', '08/31/2028'],
  ];
  const body = rows
    .map(([label, value]) => (label === '' ? `<p>${value}</p>` : `<p>${label}</p><p>${value}</p>`))
    .join('\n');
  const html = `<html><body>${body}\n<p>Alternate Names</p><p>View Related License Information</p></body></html>`;
  return Object.entries(overrides).reduce((h, [from, to]) => h.replace(from, to), html);
}

describe('fl-dbpr text reader: fixtures', () => {
  it('finds every fixture and its expected values', () => {
    expect(Object.keys(pages).length).toBeGreaterThanOrEqual(11);
    for (const path of Object.keys(pages)) {
      expect(expectedFor(path), path).toBeDefined();
    }
  });

  for (const path of Object.keys(pages)) {
    const name = path.slice(PREFIX.length);

    it(`reads ${name} to the expected fields`, () => {
      const reading = parseText(pages[path]);
      expect(reading.reader).toBe('parser_text');
      expect(reading.fields).toEqual(expectedFor(path));
      expect(reading.warnings).toEqual([]);
    });

    it(`quotes one line per sourced field in ${name}, and every quote is on the page`, () => {
      const reading = parseText(pages[path]);
      expect(reading.quotes.length).toBe(expectedQuoteCount(reading.fields));
      const text = norm(toText(pages[path]));
      for (const quote of reading.quotes) {
        expect(quote.trim()).not.toBe('');
        expect(text, quote).toContain(norm(quote));
      }
    });
  }
});

describe('fl-dbpr text reader: labels and warnings', () => {
  it('warns and leaves expires null when the expiry label is removed', () => {
    // The page labels this row "Expires". Removing it is the same as removing "Expiration Date".
    const html = pages[WAYBACK_ACTIVE].replace('Expires:', 'Expiry:');
    expect(html).not.toBe(pages[WAYBACK_ACTIVE]);
    const reading = parseText(html);
    expect(reading.fields.expires).toBeNull();
    expect(reading.warnings).toEqual(['label not found: Expiration Date']);
    expect(reading.fields).toEqual({ ...expectedFor(WAYBACK_ACTIVE), expires: null });
  });

  it('reads the expiry when the page labels it "Expiration Date"', () => {
    const html = pages[WAYBACK_ACTIVE].replace('Expires:', 'Expiration Date:');
    expect(parseText(html).fields).toEqual(expectedFor(WAYBACK_ACTIVE));
  });

  it('warns and leaves status null when the status label is removed', () => {
    const html = pages[LIVE].replace('for="LicStatus">Status<', 'for="LicStatus">State<');
    expect(html).not.toBe(pages[LIVE]);
    const reading = parseText(html);
    expect(reading.fields.status_raw).toBeNull();
    expect(reading.fields.status).toBeNull();
    expect(reading.warnings).toEqual(['label not found: Status']);
    expect(reading.fields.licence_number).toBe('CCC0000000');
  });

  it('warns when the licence number label is removed', () => {
    const reading = parseText(pageWith('Current,Active', { 'License Number:': 'Licence No:' }));
    expect(reading.fields.licence_number).toBeNull();
    expect(reading.warnings).toEqual(['label not found: License Number']);
  });

  it('warns when the primary name is missing', () => {
    const reading = parseText(pageWith('Current,Active', { '(Primary Name)': '' }));
    expect(reading.fields.name).toBeNull();
    expect(reading.warnings).toEqual(['label not found: Primary Name']);
  });

  it('warns when the city cannot be read under the address label', () => {
    const reading = parseText(pageWith('Current,Active', { 'SAMPLE CITY, FL 00000': 'Somewhere' }));
    expect(reading.fields.city).toBeNull();
    expect(reading.warnings).toEqual(['no city under label: Main Address']);
  });

  it('warns when a date cannot be read', () => {
    const reading = parseText(pageWith('Current,Active', { '03/06/2024': 'March 2024' }));
    expect(reading.fields.issued).toBeNull();
    expect(reading.warnings).toEqual(['could not read date: Licensure Date']);
  });

  it('has no warnings on a complete 2024 page, and reads the DBA from its suffix', () => {
    const reading = parseText(pages[WAYBACK_2024]);
    expect(reading.warnings).toEqual([]);
    expect(reading.fields.other_names).toEqual(['SCREEN BUILDERS INC']);
  });

  it('gives discipline_flag null and no discipline actions, since the page shows no discipline label', () => {
    const reading = parseText(pages[LIVE]);
    expect(reading.fields.discipline_flag).toBeNull();
    expect(reading.fields.discipline_actions).toEqual([]);
    expect(reading.fields.data_as_of).toBeNull();
  });

  it('reads alternate names that sit between the label and the View links', () => {
    const html = pageWith('Current,Active', {
      '<p>Alternate Names</p>': '<p>Alternate Names</p><p>OLD NAME LLC</p>',
    });
    expect(parseText(html).fields.other_names).toEqual(['OLD NAME LLC']);
  });
});

describe('fl-dbpr text reader: status wordings', () => {
  // Every wording in the shared table, swapped into the live page's status cell.
  const table = STATUS_TABLES['fl-dbpr'];
  for (const [key, status] of Object.entries(table)) {
    it(`maps "${key}" to ${status} on the live page`, () => {
      const html = pages[LIVE].replace('Current,Active', key);
      expect(html).not.toBe(pages[LIVE]);
      const reading = parseText(html);
      expect(reading.fields.status_raw).toBe(key);
      expect(reading.fields.status).toBe(status);
      expect(reading.warnings).toEqual([]);
    });
  }

  it('maps a wording the table does not hold to other', () => {
    const reading = parseText(pageWith('Something new'));
    expect(reading.fields.status_raw).toBe('Something new');
    expect(reading.fields.status).toBe('other');
  });
});

describe('fl-dbpr text reader: dates and city', () => {
  it('reads a leap day as a real date', () => {
    const reading = parseText(pageWith('Current,Active', { '08/31/2028': '02/29/2028' }));
    expect(reading.fields.expires).toBe('2028-02-29');
    expect(reading.warnings).toEqual([]);
  });

  it('gives null and a warning for a date that is not on the calendar', () => {
    const reading = parseText(pageWith('Current,Active', { '08/31/2028': '02/30/2028' }));
    expect(reading.fields.expires).toBeNull();
    expect(reading.warnings).toEqual(['could not read date: Expires']);
  });

  it('gives null and a warning for an impossible issue date', () => {
    const reading = parseText(pageWith('Current,Active', { '03/06/2024': '13/01/2024' }));
    expect(reading.fields.issued).toBeNull();
    expect(reading.warnings).toEqual(['could not read date: Licensure Date']);
  });

  it('reads the city of a page whose address is in another two-letter state', () => {
    const html = pages[LIVE].split('SAMPLE CITY, FL 00000').join('SAMPLE CITY, TX 00000');
    const reading = parseText(html);
    expect(reading.fields.city).toBe('SAMPLE CITY');
    expect(reading.warnings).toEqual([]);
  });
});

describe('fl-dbpr text reader: expiry label on the page', () => {
  it('warns with "Expires" when that label is shown but its value is missing', () => {
    const reading = parseText(pageWith('Current,Active', { '08/31/2028': '' }));
    expect(reading.fields.expires).toBeNull();
    expect(reading.warnings).toEqual(['label not found: Expires']);
  });

  it('warns with "Expiration Date" when that label is shown but its value is missing', () => {
    const reading = parseText(pageWith('Current,Active', { 'Expires:': 'Expiration Date:', '08/31/2028': '' }));
    expect(reading.fields.expires).toBeNull();
    expect(reading.warnings).toEqual(['label not found: Expiration Date']);
  });
});

describe('fl-dbpr text reader: timing', () => {
  it('parses the largest fixture in under 10 ms', () => {
    const largest = Object.keys(pages).reduce((a, b) => (pages[a].length >= pages[b].length ? a : b));
    // Each sample is a batch of 20 parses. The least of three samples is the figure.
    const runs = 20;
    let best = Infinity;
    for (let sample = 0; sample < 3; sample++) {
      const start = performance.now();
      for (let i = 0; i < runs; i++) parseText(pages[largest]);
      best = Math.min(best, (performance.now() - start) / runs);
    }
    console.log(
      `fl-dbpr text reader, ${largest.slice(PREFIX.length)}: best of 3 batches of ${runs} = ${best.toFixed(3)} ms`,
    );
    expect(best).toBeLessThan(10);
  });
});
