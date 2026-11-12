import { describe, expect, it } from 'vitest';
import type { Fields, Reading, ReaderName } from '../src/types';
import { COMPARED, WATCHED, agree, compareForWatch, expiryWarning } from '../src/lookup/agree';

const base: Fields = {
  name: 'SAMPLE, PERSON A',
  licence_number: 'ME000000',
  status_raw: 'Clear/Active',
  status: 'active',
  expires: '2028-01-31',
  issued: '2026-04-20',
  licence_type: 'Medical Doctor',
  discipline_flag: false,
  discipline_actions: [],
  data_as_of: '2026-11-03',
  city: 'SAMPLE CITY, FL 00000',
  other_names: [],
};

const reading = (reader: ReaderName, fields: Partial<Fields> = {}): Reading => ({
  reader,
  fields: { ...base, ...fields },
  quotes: [],
  warnings: [],
});

// Hand-built to mirror tests/fixtures/pairs/mqa-a.html (scrubbed original).
const mqaA: Fields = base;

// Mirrors tests/fixtures/pairs/mqa-a-dataasof.edited.html: only the Data As Of date differs.
const mqaDataAsOf: Fields = { ...base, data_as_of: '2026-11-04' };

// Mirrors tests/fixtures/pairs/mqa-a-status.edited.html: only Clear/Active changes to Null and Void.
const mqaStatus: Fields = { ...base, status_raw: 'Null and Void', status: 'other' };

describe('COMPARED', () => {
  it('lists the four fields the readers must agree on', () => {
    expect(COMPARED).toEqual(['status', 'licence_number', 'expires', 'discipline_flag']);
  });
});

describe('WATCHED', () => {
  it('is COMPARED plus name and discipline_actions', () => {
    expect(WATCHED).toEqual([...COMPARED, 'name', 'discipline_actions']);
  });
});

describe('agree', () => {
  it('agrees when three readings match on COMPARED and differ only in data_as_of', () => {
    const result = agree([
      reading('parser_html', { data_as_of: '2026-11-03' }),
      reading('parser_text', { data_as_of: '2026-11-04' }),
      reading('agent_output', { data_as_of: '2026-11-02' }),
    ]);
    expect(result.agree).toBe(true);
    expect(result.differences).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.fields).toEqual(base);
  });

  it('disagrees on status and lists the difference per reader', () => {
    const result = agree([
      reading('parser_html', { status: 'active' }),
      reading('agent_output', { status: 'expired' }),
    ]);
    expect(result.agree).toBe(false);
    expect(result.fields).toBeNull();
    expect(result.differences).toEqual([
      {
        field: 'status',
        values: { parser_html: 'active', agent_output: 'expired' },
      },
    ]);
  });

  it('disagrees with warning missing:licence_number when one reading lacks it', () => {
    const result = agree([reading('parser_html'), reading('agent_output', { licence_number: null })]);
    expect(result.agree).toBe(false);
    expect(result.fields).toBeNull();
    expect(result.warnings).toContain('missing:licence_number');
  });

  it('warns missing:status when a reading has no status', () => {
    const result = agree([reading('parser_html'), reading('agent_output', { status: null })]);
    expect(result.agree).toBe(false);
    expect(result.warnings).toContain('missing:status');
  });

  it('returns the one reading as agreed when only one reader ran', () => {
    const only = reading('parser_html', { data_as_of: '2026-11-03' });
    const result = agree([only]);
    expect(result.agree).toBe(true);
    expect(result.fields).toEqual(only.fields);
    expect(result.differences).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('disagrees when expires is null in one reading and dated in another', () => {
    const result = agree([
      reading('parser_html', { expires: null }),
      reading('parser_text', { expires: '2028-01-31' }),
    ]);
    expect(result.agree).toBe(false);
    expect(result.fields).toBeNull();
    expect(result.differences).toEqual([
      { field: 'expires', values: { parser_html: null, parser_text: '2028-01-31' } },
    ]);
    expect(result.warnings).toContain('missing:expires');
  });

  it('agrees when expires is null in every reading', () => {
    const result = agree([reading('parser_html', { expires: null }), reading('parser_text', { expires: null })]);
    expect(result.agree).toBe(true);
    expect(result.differences).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('compares expires when it is present in every reading', () => {
    const result = agree([
      reading('parser_html', { expires: '2028-01-31' }),
      reading('agent_output', { expires: '2029-01-31' }),
    ]);
    expect(result.agree).toBe(false);
    expect(result.differences.map((d) => d.field)).toEqual(['expires']);
  });

  it('treats discipline_flag null in one reading and false in another as a disagreement', () => {
    const result = agree([
      reading('parser_html', { discipline_flag: false }),
      reading('agent_output', { discipline_flag: null }),
    ]);
    expect(result.agree).toBe(false);
    expect(result.differences).toEqual([
      {
        field: 'discipline_flag',
        values: { parser_html: false, agent_output: null },
      },
    ]);
  });

  it('reports no agreement and a warning when there are no readings', () => {
    const result = agree([]);
    expect(result.agree).toBe(false);
    expect(result.fields).toBeNull();
    expect(result.warnings).toEqual(['no_readings']);
  });
});

describe('compareForWatch', () => {
  it('reports no change for identical fields', () => {
    expect(compareForWatch(mqaA, mqaA)).toEqual({ changed: false, changes: [], note: null });
  });

  it('reports no change and a note when only data_as_of differs, using hand-built fields that mirror the mqa-a fixtures', () => {
    const result = compareForWatch(mqaA, mqaDataAsOf);
    expect(result.changed).toBe(false);
    expect(result.changes).toEqual([]);
    expect(result.note).toBe('only data_as_of changed');
  });

  it('reports a change when status differs, using hand-built fields that mirror the status fixture', () => {
    const result = compareForWatch(mqaA, mqaStatus);
    expect(result.changed).toBe(true);
    expect(result.changes).toEqual([{ field: 'status', before: 'active', after: 'other' }]);
  });

  it('reports a change when the number of discipline actions changes, even if the flag stays true', () => {
    const before = { ...base, discipline_flag: true, discipline_actions: ['Reprimand'] };
    const after = { ...before, discipline_actions: ['Reprimand', 'Fine'] };
    const result = compareForWatch(before, after);
    expect(result.changed).toBe(true);
    expect(result.changes).toEqual([{ field: 'discipline_actions', before: 1, after: 2 }]);
  });

  it('reports a change for name', () => {
    const result = compareForWatch(mqaA, { ...base, name: 'SAMPLE, PERSON B' });
    expect(result.changed).toBe(true);
    expect(result.changes).toEqual([{ field: 'name', before: 'SAMPLE, PERSON A', after: 'SAMPLE, PERSON B' }]);
  });

  it('notes an ignored difference that happens alongside a watched change', () => {
    const result = compareForWatch(mqaA, { ...mqaStatus, data_as_of: '2026-11-04' });
    expect(result.changed).toBe(true);
    expect(result.note).toContain('data_as_of');
  });
});

describe('expiryWarning', () => {
  const now = new Date('2026-11-04');

  it('returns expiry_in_past when an active licence expired before now', () => {
    expect(expiryWarning({ expires: '2025-01-31', status: 'active' } as Fields, now)).toBe('expiry_in_past');
  });

  it('returns null when expires is null', () => {
    expect(expiryWarning({ expires: null, status: 'active' } as Fields, now)).toBeNull();
  });

  it('returns null when status is not active', () => {
    expect(expiryWarning({ expires: '2025-01-31', status: 'expired' } as Fields, now)).toBeNull();
  });

  it('returns null when expiry is in the future', () => {
    expect(expiryWarning({ expires: '2028-01-31', status: 'active' } as Fields, now)).toBeNull();
  });

  it('returns null when expiry is today', () => {
    expect(expiryWarning({ expires: '2026-11-04', status: 'active' } as Fields, now)).toBeNull();
  });
});
