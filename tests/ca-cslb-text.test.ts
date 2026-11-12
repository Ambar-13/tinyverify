import { describe, expect, it } from 'vitest';
import { toText } from '../src/text';
import type { Fields } from '../src/types';
import { STATUS_TABLES } from '../src/registries/status-tables';
import { parseText } from '../src/registries/parsers/ca-cslb.lines';

const pages = import.meta.glob('./fixtures/ca-cslb/*.html', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const expectedFiles = import.meta.glob('./fixtures/ca-cslb/*.expected.json', {
  import: 'default',
  eager: true,
}) as Record<string, Fields>;

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

const PREFIX = './fixtures/ca-cslb/';
const WAYBACK_ACTIVE = `${PREFIX}wayback-20200809-active.wayback.html`;
const WITH_DISCIPLINE = `${PREFIX}wayback-20231029-active.wayback.html`;

// One quote per non-null field that came from a page line. discipline_flag always quotes
// a line when it is set: the disclosure line when true, the License Status label when false.
function expectedQuoteCount(f: Fields): number {
  const scalars = [
    f.name,
    f.licence_number,
    f.status_raw,
    f.status,
    f.expires,
    f.issued,
    f.licence_type,
    f.data_as_of,
    f.city,
  ];
  return scalars.filter((v) => v !== null).length + (f.discipline_flag !== null ? 1 : 0);
}

describe('fixtures', () => {
  it('pairs every fixture page with its expected json', () => {
    const names = Object.keys(pages);
    expect(names.length).toBeGreaterThanOrEqual(10);
    for (const path of names) {
      expect(expectedFiles[path.replace(/\.html$/, '.expected.json')], path).toBeDefined();
    }
  });

  for (const path of Object.keys(pages)) {
    const name = path.slice(PREFIX.length).replace(/\.html$/, '');
    const expected = expectedFiles[path.replace(/\.html$/, '.expected.json')];

    it(`${name}: fields equal the expected json, with no warnings`, () => {
      const reading = parseText(pages[path]);
      expect(reading.reader).toBe('parser_text');
      expect(reading.fields).toEqual(expected);
      expect(reading.warnings).toEqual([]);
    });

    it(`${name}: one quote per sourced field, and every quote is on the page`, () => {
      const reading = parseText(pages[path]);
      expect(reading.quotes.length).toBe(expectedQuoteCount(reading.fields));
      const text = norm(toText(pages[path]));
      for (const quote of reading.quotes) {
        expect(text, quote).toContain(norm(quote));
      }
    });
  }
});

describe('labels and warnings', () => {
  it('a page with Expire Date removed yields the warning and a null expires', () => {
    const html = pages[WAYBACK_ACTIVE].replace('Expire Date', 'Expiry Date');
    const reading = parseText(html);
    expect(reading.warnings).toEqual(['label not found: Expire Date']);
    expect(reading.fields).toEqual({
      ...expectedFiles[WAYBACK_ACTIVE.replace(/\.html$/, '.expected.json')],
      expires: null,
    });
  });

  it('a page with Classifications removed yields a null licence_type and the warning', () => {
    const html = pages[WAYBACK_ACTIVE].replace('Classifications', 'Categories');
    const reading = parseText(html);
    expect(reading.fields.licence_type).toBeNull();
    expect(reading.warnings).toEqual(['label not found: Classifications']);
  });

  it('a page with Business Information removed yields null name and city and both warnings', () => {
    const html = pages[WAYBACK_ACTIVE].replace('Business Information', 'Company Details');
    const reading = parseText(html);
    expect(reading.fields.name).toBeNull();
    expect(reading.fields.city).toBeNull();
    expect(reading.warnings).toEqual([
      'label not found: Business Information',
      'label not found: city under Business Information',
    ]);
  });

  it('a malformed date is null and warned, not guessed', () => {
    const html = pages[WAYBACK_ACTIVE].replace('05/31/2021', '31/05/2021');
    const reading = parseText(html);
    expect(reading.fields.expires).toBeNull();
    expect(reading.warnings).toEqual(['could not read date: Expire Date']);
  });

  it('a page with a complaint disclosure sentence reads discipline_flag true', () => {
    const reading = parseText(pages[WITH_DISCIPLINE]);
    expect(reading.fields.discipline_flag).toBe(true);
    expect(reading.fields.discipline_actions).toEqual([]);
  });
});

describe('status wording', () => {
  const cases: [string, string][] = [
    ['This license is current and active.', 'active'],
    ['This license is expired.', 'expired'],
    ['This license is suspended.', 'suspended'],
    ['License is under suspension for the following reasons:', 'suspended'],
    ['This license is revoked and not able to contract at this time.', 'revoked'],
    ['This license is cancelled.', 'inactive'],
    ['This license is inactive.', 'inactive'],
    ['Something the board has not listed.', 'other'],
  ];
  for (const [sentence, status] of cases) {
    it(`"${sentence}" maps to ${status}`, () => {
      const html = pages[WAYBACK_ACTIVE].replace('This license is current and active.', sentence);
      const reading = parseText(html);
      expect(reading.fields.status_raw).toBe(sentence);
      expect(reading.fields.status).toBe(status);
    });
  }
});

describe('timing', () => {
  it('parses the largest fixture in under 10 ms', () => {
    const largest = Object.keys(pages).reduce((a, b) => (pages[a].length >= pages[b].length ? a : b));
    const html = pages[largest];
    parseText(html); // warm up
    // Each sample is 50 parses, so the timer's coarse resolution does not hide the cost.
    const RUNS = 50;
    let best = Infinity;
    for (let sample = 0; sample < 10; sample++) {
      const t0 = performance.now();
      for (let i = 0; i < RUNS; i++) parseText(html);
      best = Math.min(best, (performance.now() - t0) / RUNS);
    }
    console.log(`ca-cslb text reader, largest fixture (${html.length} chars): ${best.toFixed(3)} ms per parse`);
    expect(best).toBeLessThan(10);
  });
});

describe('shared status table', () => {
  const keys = Object.entries(STATUS_TABLES['ca-cslb']);

  it('has every CSLB wording to test', () => {
    expect(keys.length).toBeGreaterThanOrEqual(9);
  });

  for (const [key, status] of keys) {
    it(`"${key}" maps to ${status} through parseText`, () => {
      const sentence = `${key} for this test.`;
      const html = pages[WAYBACK_ACTIVE].replace('This license is current and active.', sentence);
      const reading = parseText(html);
      expect(reading.fields.status_raw).toBe(sentence);
      expect(reading.fields.status).toBe(status);
    });
  }
});

describe('guards', () => {
  it('a blank status gives null, not the note under it', () => {
    const html = pages[WAYBACK_ACTIVE].replace('This license is current and active.', '');
    const reading = parseText(html);
    expect(reading.fields.status_raw).toBeNull();
    expect(reading.fields.status).toBeNull();
    expect(reading.warnings).toContain('no value under: License Status');
  });

  it('a blank name gives null, never the address line', () => {
    const html = pages[WAYBACK_ACTIVE].replace('SWIM CARE POOL SERVICES', '');
    const reading = parseText(html);
    expect(reading.fields.name).toBeNull();
    expect(reading.fields.city).toBe('SAMPLE CITY');
    expect(reading.warnings).toEqual(['no value under: Business Information']);
    expect(reading.quotes).not.toContain('1 Sample St');
  });

  it('no License Status block gives discipline_flag null and the label warning', () => {
    const html = pages[WAYBACK_ACTIVE].replace('License Status', 'Licence Condition');
    const reading = parseText(html);
    expect(reading.fields.discipline_flag).toBeNull();
    expect(reading.warnings).toContain('label not found: License Status');
  });

  it('a block with neither disclosure line gives false and quotes the License Status label', () => {
    const reading = parseText(pages[WAYBACK_ACTIVE]);
    expect(reading.fields.discipline_flag).toBe(false);
    expect(reading.quotes).toContain('License Status');
  });

  it('the complaint link alone gives discipline_flag true', () => {
    const html = pages[`${PREFIX}wayback-20200829-revoked.wayback.html`].replace(
      'There is Complaint Disclosure information for this license.',
      '',
    );
    const reading = parseText(html);
    expect(reading.fields.discipline_flag).toBe(true);
    expect(reading.quotes).toContain('Click here for Complaint Disclosure information.');
  });

  it('an impossible expiry date gives null and the warning', () => {
    const html = pages[WAYBACK_ACTIVE].replace('05/31/2021', '02/30/2021');
    const reading = parseText(html);
    expect(reading.fields.expires).toBeNull();
    expect(reading.warnings).toEqual(['could not read date: Expire Date']);
  });

  it('a valid leap day is kept', () => {
    const html = pages[WAYBACK_ACTIVE].replace('05/31/2021', '02/29/2024');
    expect(parseText(html).fields.expires).toBe('2024-02-29');
  });

  it('an impossible data date gives null and the warning', () => {
    const html = pages[WAYBACK_ACTIVE].replace('8/8/2020', '2/30/2020');
    const reading = parseText(html);
    expect(reading.fields.data_as_of).toBeNull();
    expect(reading.warnings).toEqual(['could not read date: Data current as of']);
  });
});
