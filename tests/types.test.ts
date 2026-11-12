import { describe, expect, it } from 'vitest';
import { parseVerifyRequest } from '../src/types';

describe('parseVerifyRequest', () => {
  const base = { record_type: 'physician', jurisdiction: 'US-FL' };

  it('accepts the two required fields alone', () => {
    expect(parseVerifyRequest(base)).toEqual({ ok: true, input: base });
  });

  it('accepts every optional field with its own type', () => {
    const full = {
      ...base,
      name: 'A',
      licence_number: 'ME1',
      first_name: 'B',
      last_name: 'C',
      city: 'D',
      include_complaints: true,
      candidate_id: 'cand_1',
    };
    expect(parseVerifyRequest(full)).toEqual({ ok: true, input: full });
  });

  it('separates check_id from the input and drops fields it does not know', () => {
    const r = parseVerifyRequest({ ...base, check_id: 'chk_1', extra: 1 });
    expect(r).toEqual({ ok: true, input: base, check_id: 'chk_1' });
  });

  it('refuses a missing required field, a wrong type and a non-object, each with a message', () => {
    for (const body of [
      { jurisdiction: 'US-FL' },
      { ...base, name: 123 },
      { ...base, include_complaints: 1 },
      { ...base, city: null },
      'text',
      null,
      [],
    ]) {
      const r = parseVerifyRequest(body);
      expect(r.ok, JSON.stringify(body)).toBe(false);
      if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
    }
  });
});
