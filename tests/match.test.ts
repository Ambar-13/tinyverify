import { describe, expect, it } from 'vitest';
import type { Candidate, VerifyInput } from '../src/types';
import { decide, normaliseName, sameSubject, scoreCandidate } from '../src/lookup/match';

type Row = Omit<Candidate, 'score' | 'reasons' | 'candidate_id'>;

const row = (name: string, extra: Partial<Row> = {}): Row => ({
  name,
  licence_number: null,
  city: null,
  licence_type: null,
  status_raw: null,
  from: 'search',
  link: null,
  ...extra,
});

const input = (extra: Partial<VerifyInput> = {}): VerifyInput => ({
  name: 'Wei Ming Lim',
  record_type: 'physician',
  jurisdiction: 'US-FL',
  ...extra,
});

const cand = (id: string, extra: Partial<Candidate> = {}): Candidate => ({
  candidate_id: id,
  name: 'Wei Ming Lim',
  licence_number: null,
  city: null,
  licence_type: null,
  status_raw: null,
  score: 0,
  reasons: [],
  from: 'search',
  link: null,
  ...extra,
});

describe('normaliseName', () => {
  it('folds diacritics, drops apostrophes and turns other punctuation into spaces', () => {
    expect(normaliseName("O'Brien-Núñez").folded).toBe('obrien nunez');
  });

  it('removes trailing business suffixes from suffixStripped only', () => {
    const n = normaliseName('Sample One Roofing, L.L.C.');
    expect(n.suffixStripped).toBe('sample one roofing');
    expect(n.folded).toBe('sample one roofing l l c');
    expect(n.tokens).toEqual(['sample', 'one', 'roofing', 'l', 'l', 'c']);
  });

  it('strips multi-word suffixes such as pty ltd', () => {
    expect(normaliseName('Acme Pty Ltd').suffixStripped).toBe('acme');
  });

  it('keeps a name that is only a suffix', () => {
    expect(normaliseName('LLC').suffixStripped).toBe('llc');
  });
});

describe('scoreCandidate', () => {
  it('scores an exact folded name at 1.0', () => {
    const r = scoreCandidate(input(), row('WEI MING LIM'));
    expect(r.score).toBe(1);
    expect(r.reasons).toContain('exact_name');
  });

  it('scores the same tokens in another order at least 0.9', () => {
    const r = scoreCandidate(input(), row('LIM WEI MING'));
    expect(r.score).toBeGreaterThanOrEqual(0.9);
    expect(r.score).toBeCloseTo(0.92, 4);
    expect(r.reasons).toContain('token_order_swap');
  });

  it('reorders LAST, FIRST MIDDLE and scores an extra record token at 0.7', () => {
    const r = scoreCandidate(input({ name: 'Raj Patel', record_type: 'dentist' }), row('PATEL, RAJ ALEX'));
    expect(r.score).toBeGreaterThan(0.5);
    expect(r.score).toBeLessThan(0.8);
    expect(r.score).toBeCloseTo(0.7, 4);
    expect(r.reasons).toContain('middle_name_on_record');
  });

  it('scores an extra input token at 0.65', () => {
    const r = scoreCandidate(input({ name: 'Raj Ajay Patel' }), row('PATEL, RAJ'));
    expect(r.score).toBeCloseTo(0.65, 4);
    expect(r.reasons).toContain('middle_name_on_input');
  });

  it('does not guess nicknames: Bill is not William', () => {
    const r = scoreCandidate(input({ name: 'Bill Johnson' }), row('WILLIAM JOHNSON'));
    expect(r.score).toBeLessThan(0.3);
    expect(r.score).toBeCloseTo(0.15, 4);
    expect(r.reasons).toContain('partial_tokens');
  });

  it('scores equal canonical suffixes at 0.9', () => {
    const r = scoreCandidate(input({ name: 'Sample One Roofing LLC' }), row('Sample One Roofing L.L.C.'));
    expect(r.score).toBeCloseTo(0.9, 4);
    expect(r.reasons).toContain('suffix_normalised');
  });

  it('adds 0.05 for a matching city and caps the score at 1.0', () => {
    const r = scoreCandidate(input({ city: 'MIAMI' }), row('WEI MING LIM', { city: 'Miami' }));
    expect(r.score).toBe(1);
    expect(r.reasons).toContain('city_match');
  });

  it('takes 0.1 off for a city mismatch when both cities are present', () => {
    const r = scoreCandidate(input({ city: 'Miami' }), row('WEI MING LIM', { city: 'Tampa' }));
    expect(r.score).toBeCloseTo(0.9, 4);
    expect(r.reasons).toContain('city_mismatch');
  });

  it('ignores a missing city on either side', () => {
    const r = scoreCandidate(input({ city: 'Miami' }), row('WEI MING LIM'));
    expect(r.score).toBe(1);
    expect(r.reasons).not.toContain('city_mismatch');
  });

  it('adds the type_match reason without changing the score', () => {
    const r = scoreCandidate(input(), row('WEI MING LIM', { licence_type: 'Physician' }));
    expect(r.score).toBe(1);
    expect(r.reasons).toContain('type_match');
  });

  it('builds the name from first_name and last_name when name is absent', () => {
    const r = scoreCandidate(
      { record_type: 'physician', jurisdiction: 'US-FL', first_name: 'Wei Ming', last_name: 'Lim' },
      row('LIM, WEI MING'),
    );
    expect(r.score).toBe(1);
    expect(r.reasons).toContain('exact_name');
  });
});

describe('sameSubject', () => {
  it('is true for the same folded name and city, whatever the name order', () => {
    expect(
      sameSubject(cand('a', { name: 'PATEL, RAJ', city: 'Miami' }), cand('b', { name: 'Raj Patel', city: 'miami' })),
    ).toBe(true);
  });

  it('is false when the cities differ', () => {
    expect(sameSubject(cand('a', { city: 'Miami' }), cand('b', { city: 'Tampa' }))).toBe(false);
  });
});

describe('decide', () => {
  it('returns match for a clear top score and returns only the top subject', () => {
    const out = decide([
      cand('a', { name: 'Wei Ming Lim', score: 0.96, reasons: ['exact_name'] }),
      cand('b', { name: 'Wei Lim Tan', score: 0.4 }),
    ]);
    expect(out.outcome).toBe('match');
    expect(out.chosen.map((c) => c.candidate_id)).toEqual(['a']);
    expect(out.disambiguators).toEqual([]);
  });

  it('returns match with both rows when they are the same subject', () => {
    const out = decide([cand('a', { city: 'Miami', score: 0.9 }), cand('b', { city: 'Miami', score: 0.9 })]);
    expect(out.outcome).toBe('match');
    expect(out.chosen).toHaveLength(2);
  });

  it('returns multiple_matches with city as the disambiguator when cities differ', () => {
    const out = decide([cand('a', { city: 'Miami', score: 0.9 }), cand('b', { city: 'Tampa', score: 0.9 })]);
    expect(out.outcome).toBe('multiple_matches');
    expect(out.disambiguators).toEqual(['city']);
    expect(out.chosen).toHaveLength(2);
  });

  it('lists disambiguators in the order city, middle_name, licence_type, licence_number', () => {
    const out = decide([
      cand('a', {
        name: 'Raj Patel',
        city: 'Miami',
        licence_type: 'Dentist',
        licence_number: 'D1',
        score: 0.9,
      }),
      cand('b', {
        name: 'Raj Ajay Patel',
        city: 'Tampa',
        licence_type: 'Physician',
        licence_number: 'P2',
        score: 0.9,
      }),
    ]);
    expect(out.outcome).toBe('multiple_matches');
    expect(out.disambiguators).toEqual(['city', 'middle_name', 'licence_type', 'licence_number']);
  });

  it('returns no_match when no row is at least 0.5', () => {
    const out = decide([cand('a', { score: 0.3 }), cand('b', { name: 'Someone Else', score: 0.2 })]);
    expect(out.outcome).toBe('no_match');
    expect(out.chosen).toEqual([]);
    expect(out.disambiguators).toEqual([]);
  });

  it('does not call a 0.84 top score a clear match', () => {
    const out = decide([cand('a', { score: 0.84 })]);
    expect(out.outcome).toBe('multiple_matches');
  });

  it('does not call a top score a clear match when the runner-up is within 0.25', () => {
    const out = decide([cand('a', { city: 'Miami', score: 0.9 }), cand('b', { city: 'Tampa', score: 0.7 })]);
    expect(out.outcome).toBe('multiple_matches');
  });

  it('calls a top score a clear match when the runner-up is 0.25 or more below', () => {
    const out = decide([cand('a', { city: 'Miami', score: 0.9 }), cand('b', { city: 'Tampa', score: 0.6 })]);
    expect(out.outcome).toBe('match');
  });
});

describe('decide warnings, middle initials, compact names and suffixes', () => {
  it('decide warns single_weak_candidate for one plausible candidate below 0.85', () => {
    const out = decide([cand('a', { name: 'Wei Ming Lim', score: 0.7 })]);
    expect(out.outcome).toBe('multiple_matches');
    expect(out.chosen.map((c) => c.candidate_id)).toEqual(['a']);
    expect(out.warnings).toContain('single_weak_candidate');
  });

  it('decide gives no warnings for a clear match', () => {
    const out = decide([cand('a', { score: 0.96 }), cand('b', { name: 'Other Person', score: 0.4 })]);
    expect(out.outcome).toBe('match');
    expect(out.warnings).toEqual([]);
  });

  it('a missing city never makes two rows the same subject', () => {
    const a = cand('a', { name: 'JOHN SMITH', city: null, licence_number: 'A1', score: 1 });
    const b = cand('b', { name: 'JOHN SMITH', city: null, licence_number: 'B2', score: 1 });
    expect(sameSubject(a, b)).toBe(false);
    const out = decide([a, b]);
    expect(out.outcome).toBe('multiple_matches');
    expect(out.disambiguators).toContain('licence_number');
  });

  it('compares names in suffix-stripped form for subject identity', () => {
    const a = cand('a', { name: 'SAMPLE ONE ROOFING LLC', city: 'Miami' });
    const b = cand('b', { name: 'SAMPLE ONE ROOFING L.L.C.', city: 'Miami' });
    expect(sameSubject(a, b)).toBe(true);
    const out = decide([
      { ...a, score: 0.9 },
      { ...b, score: 0.9 },
    ]);
    expect(out.outcome).toBe('match');
    expect(out.chosen).toHaveLength(2);
  });

  it('scores a middle initial against a full middle name at 0.8 and keeps it plausible', () => {
    const r = scoreCandidate(input({ name: 'Raj A Patel' }), row('PATEL, RAJ ALEX'));
    expect(r.score).toBeCloseTo(0.8, 4);
    expect(r.reasons).toContain('middle_initial');
    expect(r.score).toBeGreaterThanOrEqual(0.5);
  });

  it('accepts the reverse direction for a middle initial', () => {
    const r = scoreCandidate(input({ name: 'Raj Ajay Patel' }), row('PATEL, RAJ A'));
    expect(r.score).toBeCloseTo(0.8, 4);
    expect(r.reasons).toContain('middle_initial');
  });

  it('exposes compact names from normaliseName', () => {
    expect(normaliseName("Maria O'Brien-Núñez").compact).toBe('mariaobriennunez');
  });

  it('scores equal compact forms as compact_name at 0.9 when the given name lines up', () => {
    const r = scoreCandidate(input({ name: "Maria O'Brien-Núñez" }), row('O BRIEN NUNEZ, MARIA'));
    expect(r.score).toBeCloseTo(0.9, 4);
    expect(r.reasons).toContain('compact_name');
    expect(r.reasons).not.toContain('exact_name');
  });

  it('gives no compact bonus when the first tokens differ', () => {
    const r = scoreCandidate(input({ name: 'Ab Cde' }), row('Abc De'));
    expect(r.reasons).not.toContain('compact_name');
    expect(r.score).toBeLessThan(0.5);
  });

  it('gives no compact bonus when the token counts differ by more than two', () => {
    const r = scoreCandidate(input({ name: 'Jo Abcd' }), row('Jo A B C D'));
    expect(r.reasons).not.toContain('compact_name');
    expect(r.score).toBeLessThan(0.5);
  });

  it('treats LLC and L.L.C. as the same canonical suffix', () => {
    const r = scoreCandidate(input({ name: 'ACME LLC' }), row('ACME L.L.C.'));
    expect(r.score).toBeCloseTo(0.9, 4);
    expect(r.reasons).toContain('suffix_normalised');
    expect(
      sameSubject(cand('a', { name: 'ACME LLC', city: 'Miami' }), cand('b', { name: 'ACME L.L.C.', city: 'Miami' })),
    ).toBe(true);
  });

  it('treats LLC and INC as different suffixes: no bonus and not the same subject', () => {
    const r = scoreCandidate(input({ name: 'ACME LLC' }), row('ACME INC'));
    expect(r.reasons).not.toContain('suffix_normalised');
    expect(r.score).toBeLessThan(0.9);
    expect(
      sameSubject(cand('a', { name: 'ACME LLC', city: 'Miami' }), cand('b', { name: 'ACME INC', city: 'Miami' })),
    ).toBe(false);
  });

  it('canonicalises Incorporated and Inc. to the same suffix', () => {
    const r = scoreCandidate(input({ name: 'ACME Incorporated' }), row('ACME Inc.'));
    expect(r.reasons).toContain('suffix_normalised');
  });

  it('scores a business name typed without its suffix at 0.8 as suffix_one_side, not as a middle initial', () => {
    const r = scoreCandidate(input({ name: 'Sample One Roofing' }), row('SAMPLE ONE ROOFING LLC'));
    expect(r.score).toBeCloseTo(0.8, 4);
    expect(r.reasons).toContain('suffix_one_side');
    expect(r.reasons).not.toContain('middle_initial');
    expect(r.score).toBeGreaterThanOrEqual(0.5);
  });

  it('accepts the suffix on the input side only, and with other suffix words', () => {
    for (const [typed, held] of [
      ['Sample One Roofing LLC', 'SAMPLE ONE ROOFING'],
      ['Sample One Roofing Inc.', 'SAMPLE ONE ROOFING'],
      ['Acme Pty Ltd', 'ACME'],
      ['Acme', 'ACME CORPORATION'],
    ]) {
      const r = scoreCandidate(input({ name: typed }), row(held));
      expect(r.reasons, `${typed} against ${held}`).toContain('suffix_one_side');
      expect(r.score).toBeCloseTo(0.8, 4);
    }
  });

  it('keeps a suffix_one_side match plausible and never clear, even with the city bonus', () => {
    const r = scoreCandidate(
      input({ name: 'Sample One Roofing', city: 'Odessa' }),
      row('SAMPLE ONE ROOFING LLC', { city: 'Odessa' }),
    );
    expect(r.reasons).toContain('suffix_one_side');
    expect(r.reasons).toContain('city_match');
    expect(r.score).toBeCloseTo(0.84, 4);
    const out = decide([
      cand('a', { name: 'SAMPLE ONE ROOFING LLC', city: 'Odessa', score: r.score, reasons: r.reasons }),
    ]);
    expect(out.outcome).toBe('multiple_matches');
    expect(out.warnings).toContain('single_weak_candidate');
  });

  it('does not use suffix_one_side when both sides carry a suffix, or neither does', () => {
    expect(scoreCandidate(input({ name: 'ACME LLC' }), row('ACME L.L.C.')).reasons).toContain('suffix_normalised');
    expect(scoreCandidate(input({ name: 'ACME LLC' }), row('ACME INC')).reasons).not.toContain('suffix_one_side');
    expect(scoreCandidate(input({ name: 'Acme Roofing' }), row('ACME ROOFING')).reasons).toContain('exact_name');
  });

  it('does not use suffix_one_side when the words differ beyond the suffix', () => {
    const r = scoreCandidate(input({ name: 'Sample One Roofing' }), row('SAMPLE ONE PAVING LLC'));
    expect(r.reasons).not.toContain('suffix_one_side');
    expect(r.score).toBeLessThan(0.8);
  });

  it('still lets a matching licence number decide, whatever the suffix', () => {
    const r = scoreCandidate(
      input({ name: 'Sample One Roofing', licence_number: 'CCC0000001' }),
      row('SAMPLE ONE ROOFING LLC', { licence_number: 'CCC0000001' }),
    );
    expect(r.score).toBe(1);
    expect(r.reasons).toContain('licence_number');
  });

  it('pairs an initial only with a full token in the middle position', () => {
    const r = scoreCandidate(input({ name: 'Raj A Patel' }), row('ALEX RAJ PATEL'));
    expect(r.reasons).not.toContain('middle_initial');
    expect(r.score).toBeLessThan(0.5);
  });

  it('caps a middle_initial match at 0.84 after the city bonus, so it is never a clear match', () => {
    const r = scoreCandidate(input({ name: 'Raj A Patel', city: 'Miami' }), row('PATEL, RAJ ALEX', { city: 'Miami' }));
    expect(r.reasons).toContain('middle_initial');
    expect(r.score).toBeCloseTo(0.84, 4);
    const out = decide([cand('a', { name: 'PATEL, RAJ ALEX', city: 'Miami', score: r.score, reasons: r.reasons })]);
    expect(out.outcome).toBe('multiple_matches');
    expect(out.warnings).toContain('single_weak_candidate');
  });

  it('matches record types through normaliseRecordType', () => {
    const r = scoreCandidate(
      input({ record_type: 'physician' }),
      row('WEI MING LIM', { licence_type: 'Medical Doctor' }),
    );
    expect(r.reasons).toContain('type_match');
  });
});

describe('licence number lookups', () => {
  it('scores a row whose licence number equals the input at 1 with the licence_number reason', () => {
    const r = scoreCandidate(
      input({ name: undefined, licence_number: 'ME 123456' }),
      row('Anyone', { licence_number: 'ME123456' }),
    );
    expect(r.score).toBe(1);
    expect(r.reasons).toEqual(['licence_number']);
  });

  it('keeps the name reason when a name is also given', () => {
    const r = scoreCandidate(
      input({ licence_number: 'ME123456' }),
      row('Wei Ming Lim', { licence_number: 'ME123456' }),
    );
    expect(r.reasons).toEqual(['licence_number', 'exact_name']);
  });

  it('gives no match when neither the number nor the name matches', () => {
    const r = scoreCandidate(
      input({ name: undefined, licence_number: 'ME123456' }),
      row('Other', { licence_number: 'ME999999' }),
    );
    expect(r.score).toBe(0);
    const d = decide([cand('c1', { name: 'Other', licence_number: 'ME999999', score: r.score, reasons: r.reasons })]);
    expect(d.outcome).toBe('no_match');
  });

  it('carries single_weak_candidate as a decision warning', () => {
    const d = decide([cand('c1', { score: 0.7, reasons: ['partial_tokens'] })]);
    expect(d.outcome).toBe('multiple_matches');
    expect(d.warnings).toEqual(['single_weak_candidate']);
  });
});

describe('licence number with a name', () => {
  it('scores a matching number with a mismatched name at 0.84, plausible but not clear', () => {
    const r = scoreCandidate(
      input({ licence_number: 'ME123456' }),
      row('Totally Different', { licence_number: 'ME123456' }),
    );
    expect(r.score).toBe(0.84);
    expect(r.reasons).toEqual(['licence_number', 'name_mismatch']);
    const d = decide([
      cand('c1', { name: 'Totally Different', licence_number: 'ME123456', score: r.score, reasons: r.reasons }),
    ]);
    expect(d.outcome).toBe('multiple_matches');
    expect(d.warnings).toEqual(['single_weak_candidate']);
  });
});

describe('one subject per licence number', () => {
  it('treats a primary row and a DBA row with the same number as one subject, so the decision is match', () => {
    const primary = cand('c1', {
      name: 'Raj Patel',
      licence_number: 'ME123456',
      city: 'Fresno',
      score: 1,
      reasons: ['licence_number'],
    });
    const dba = cand('c2', {
      name: 'Raj Patel DBA Shop',
      licence_number: 'ME123456',
      city: null,
      score: 1,
      reasons: ['licence_number'],
    });
    expect(sameSubject(primary, dba)).toBe(true);
    const d = decide([primary, dba]);
    expect(d.outcome).toBe('match');
    expect(d.chosen).toHaveLength(2);
  });

  it('does not merge two rows with the same number whose links differ', () => {
    const a = cand('c1', {
      name: 'Raj Patel',
      licence_number: 'ME123456',
      link: { licInd: '1', proCde: '2' },
      score: 1,
    });
    const b = cand('c2', {
      name: 'Raj Patel',
      licence_number: 'ME123456',
      link: { licInd: '9', proCde: '2' },
      score: 1,
    });
    expect(sameSubject(a, b)).toBe(false);
  });
});
