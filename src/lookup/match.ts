/**
 * Name matching. Normalises names, scores each registry row against the name asked, and decides between no match, one
 * clear match, or several candidates for the caller to choose from. Pure functions only.
 */

import { normaliseLicenceNumber, normaliseRecordType } from '../registries/catalog';
import type { SearchRow } from '../registries/adapter';
import type { Candidate, VerifyInput } from '../types';

export type Row = SearchRow;

export interface Decision {
  outcome: 'match' | 'multiple_matches' | 'no_match';
  chosen: Candidate[];
  disambiguators: string[];
  warnings: string[];
}

const PLAUSIBLE = 0.5;
const CLEAR_TOP = 0.85;
const CLEAR_GAP = 0.25;
const EPS = 1e-9;
/** A middle-initial match, and a name typed without its business suffix, never reach the clear-match threshold. */
const INITIAL_CAP = 0.84;

/**
 * Business suffixes that are removed when computing suffixStripped.
 * Longest first, so "pty ltd" is tried before "ltd".
 */
const SUFFIXES: string[][] = [
  'inc',
  'incorporated',
  'llc',
  'l l c',
  'ltd',
  'limited',
  'co',
  'company',
  'corp',
  'corporation',
  'pty',
  'pty ltd',
  'plc',
  'lp',
  'llp',
  'pc',
  'pa',
  'dba',
]
  .map((s) => s.split(' '))
  .sort((a, b) => b.length - a.length);

/**
 * Suffix spellings and the form each one is compared as. Forms that already equal
 * their canonical form are listed too, so they are not replaced by anything else.
 */
const SUFFIX_CANON: [string[], string[]][] = [
  ['l l c', 'llc'],
  ['llc', 'llc'],
  ['inc', 'inc'],
  ['incorporated', 'inc'],
  ['ltd', 'ltd'],
  ['limited', 'ltd'],
  ['corp', 'corp'],
  ['corporation', 'corp'],
  ['co', 'co'],
  ['company', 'co'],
  ['pty ltd', 'pty ltd'],
  ['pty', 'pty'],
  ['llp', 'llp'],
  ['lp', 'lp'],
  ['plc', 'plc'],
  ['pc', 'pc'],
  ['pa', 'pa'],
  ['dba', 'dba'],
]
  .map(([form, canon]): [string[], string[]] => [form.split(' '), canon.split(' ')])
  .sort((a, b) => b[0].length - a[0].length);

interface Analysed {
  tokens: string[];
  folded: string;
  compact: string;
  /** Suffix-stripped tokens: used for partial, subset and initial matching. */
  stripped: string[];
  /** Canonical suffix tokens: used for suffix_normalised and subject identity. */
  canon: string[];
}

function stripSuffixes(tokens: string[]): string[] {
  let t = tokens;
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of SUFFIXES) {
      const start = t.length - suffix.length;
      // Keep at least one token, so a name that is only a suffix survives.
      if (start > 0 && suffix.every((word, i) => t[start + i] === word)) {
        t = t.slice(0, start);
        changed = true;
        break;
      }
    }
  }
  return t;
}

function canonicalTokens(tokens: string[]): string[] {
  let t = tokens;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [form, canon] of SUFFIX_CANON) {
      const start = t.length - form.length;
      if (start < 0 || !form.every((word, i) => t[start + i] === word)) continue;
      if (form.join(' ') === canon.join(' ')) continue;
      t = [...t.slice(0, start), ...canon];
      changed = true;
      break;
    }
  }
  return t;
}

function analyse(s: string): Analysed {
  const tokens = s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .split(' ')
    .filter((t) => t !== '');
  return {
    tokens,
    folded: tokens.join(' '),
    compact: tokens.join(''),
    stripped: stripSuffixes(tokens),
    canon: canonicalTokens(tokens),
  };
}

export function normaliseName(s: string): {
  tokens: string[];
  folded: string;
  suffixStripped: string;
  compact: string;
} {
  const a = analyse(s);
  return { tokens: a.tokens, folded: a.folded, suffixStripped: a.stripped.join(' '), compact: a.compact };
}

/** Registries write "LAST, FIRST MIDDLE". Reorder to "FIRST MIDDLE LAST" before comparing. */
function reorderLastFirst(name: string): string {
  const comma = name.indexOf(',');
  if (comma < 0) return name;
  const last = name.slice(0, comma).trim();
  const rest = name.slice(comma + 1).trim();
  if (last === '' || rest === '') return name;
  return `${rest} ${last}`;
}

function nameOf(input: VerifyInput): string {
  if (input.name && input.name.trim() !== '') return input.name;
  return [input.first_name, input.last_name].filter((p) => p && p.trim() !== '').join(' ');
}

function sameMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return [...a].sort().join(' ') === [...b].sort().join(' ');
}

/** How many tokens of `needles` can be matched one-to-one in `hay`. */
function countContained(needles: string[], hay: string[]): number {
  const pool = new Map<string, number>();
  for (const t of hay) pool.set(t, (pool.get(t) ?? 0) + 1);
  let n = 0;
  for (const t of needles) {
    const left = pool.get(t) ?? 0;
    if (left > 0) {
      pool.set(t, left - 1);
      n++;
    }
  }
  return n;
}

/**
 * A single letter in the middle of a name stands for a full middle name starting
 * with that letter. Both lists must have the same length, with each token paired
 * once: identical tokens first, then initials against full tokens.
 */
function sameWithInitials(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const isMiddle = (tokens: string[], i: number): boolean => i > 0 && i < tokens.length - 1;
  const left = b.map((token, i) => ({ token, middle: isMiddle(b, i) }));
  const pending: { token: string; middle: boolean }[] = [];
  a.forEach((token, i) => {
    const idx = left.findIndex((l) => l.token === token);
    if (idx >= 0) left.splice(idx, 1);
    else pending.push({ token, middle: isMiddle(a, i) });
  });
  for (const p of pending) {
    const idx = left.findIndex((l) => initialPairs(p, l));
    if (idx < 0) return false;
    left.splice(idx, 1);
  }
  return true;
}

/** An initial pairs only with a full token, and both must sit in the middle position. */
function initialPairs(x: { token: string; middle: boolean }, y: { token: string; middle: boolean }): boolean {
  const xInitial = x.token.length === 1;
  const yInitial = y.token.length === 1;
  if (xInitial === yInitial) return false;
  const initial = xInitial ? x : y;
  const full = xInitial ? y : x;
  return initial.middle && full.middle && full.token[0] === initial.token;
}

const round4 = (x: number): number => Math.round(x * 10000) / 10000;

function nameScore(input: Analysed, row: Analysed): { score: number; reason?: string } {
  if (input.tokens.length === 0 || row.tokens.length === 0) return { score: 0 };
  if (input.folded === row.folded) return { score: 1, reason: 'exact_name' };
  if (sameMultiset(input.tokens, row.tokens)) return { score: 0.92, reason: 'token_order_swap' };
  if (sameMultiset(input.canon, row.canon)) return { score: 0.9, reason: 'suffix_normalised' };
  // Compact forms only count when the given name lines up and the lengths are close.
  if (
    input.compact === row.compact &&
    input.tokens[0] === row.tokens[0] &&
    Math.abs(input.tokens.length - row.tokens.length) <= 2
  ) {
    return { score: 0.9, reason: 'compact_name' };
  }
  // Equal once a trailing business suffix is taken off one side only: "Sample One Roofing" against
  // "SAMPLE ONE ROOFING LLC". It is the same words with a suffix the other name does not show, so it is
  // plausible. It is not clear: the registry may hold both an LLC and an Inc of that name.
  const inputHasSuffix = input.stripped.length < input.tokens.length;
  const rowHasSuffix = row.stripped.length < row.tokens.length;
  if (inputHasSuffix !== rowHasSuffix && input.stripped.join(' ') === row.stripped.join(' ')) {
    return { score: 0.8, reason: 'suffix_one_side' };
  }
  if (sameWithInitials(input.stripped, row.stripped)) return { score: 0.8, reason: 'middle_initial' };

  const found = countContained(input.stripped, row.stripped);
  if (found === input.stripped.length) {
    const extra = row.stripped.length - input.stripped.length;
    if (extra >= 1 && extra <= 2) return { score: 0.7, reason: 'middle_name_on_record' };
  }
  const foundInInput = countContained(row.stripped, input.stripped);
  if (foundInInput === row.stripped.length) {
    const extra = input.stripped.length - row.stripped.length;
    if (extra >= 1 && extra <= 2) return { score: 0.65, reason: 'middle_name_on_input' };
  }

  // Fewer input tokens found (or extras beyond two): score by the share found.
  if (found === 0) return { score: 0 };
  return { score: 0.3 * (found / input.stripped.length), reason: 'partial_tokens' };
}

/** The score runs from 0 to 1. */
export function scoreCandidate(input: VerifyInput, row: Row): { score: number; reasons: string[] } {
  const inputAnalysed = analyse(reorderLastFirst(nameOf(input)));
  const rowAnalysed = analyse(reorderLastFirst(row.name));
  const name = nameScore(inputAnalysed, rowAnalysed);

  // A licence number that equals the row's number is the record itself, whatever the name says.
  if (input.licence_number && row.licence_number !== null) {
    if (normaliseLicenceNumber(input.licence_number) === normaliseLicenceNumber(row.licence_number)) {
      // No name given: the number alone decides. A name that does not match keeps the row plausible, never clear.
      if (inputAnalysed.tokens.length === 0) return { score: 1, reasons: ['licence_number'] };
      if (name.score >= PLAUSIBLE)
        return { score: 1, reasons: ['licence_number', ...(name.reason ? [name.reason] : [])] };
      return { score: 0.84, reasons: ['licence_number', 'name_mismatch'] };
    }
  }

  let score = name.score;
  const reasons: string[] = name.reason ? [name.reason] : [];

  const inputCity = input.city ? normaliseName(input.city).folded : '';
  const rowCity = row.city ? normaliseName(row.city).folded : '';
  if (inputCity !== '' && rowCity !== '') {
    if (inputCity === rowCity) {
      score += 0.05;
      reasons.push('city_match');
    } else {
      score -= 0.1;
      reasons.push('city_mismatch');
    }
  }
  if (name.reason === 'middle_initial' || name.reason === 'suffix_one_side') score = Math.min(score, INITIAL_CAP);

  if (input.record_type && row.licence_type) {
    const inputType = normaliseRecordType(input.record_type);
    const rowType = normaliseRecordType(row.licence_type);
    if (inputType !== null && inputType === rowType) reasons.push('type_match');
  }

  return { score: Math.min(1, Math.max(0, round4(score))), reasons };
}

/**
 * Subject identity uses the canonical name, so "LLC" and "L.L.C." agree but
 * "LLC" and "INC" do not.
 */
function subjectName(name: string): string {
  return canonicalTokens(analyse(reorderLastFirst(name)).tokens).join(' ');
}

/** A missing city is never equal to anything, so it does not merge two rows. */
function cityKey(city: string | null): string | null {
  if (!city) return null;
  const folded = normaliseName(city).folded;
  return folded === '' ? null : folded;
}

const licenceKey = (n: string): string => n.replace(/\s+/g, '').toUpperCase();
const sameLink = (x: Record<string, string>, y: Record<string, string>): boolean =>
  JSON.stringify(Object.entries(x).sort()) === JSON.stringify(Object.entries(y).sort());

/** True when two rows are one licensee: the same licence number, or the same name and city. */
export function sameSubject(a: Candidate, b: Candidate): boolean {
  // One licence number is one subject, whatever names its rows carry (primary, DBA, alternate), when their links agree.
  if (
    a.licence_number !== null &&
    b.licence_number !== null &&
    licenceKey(a.licence_number) === licenceKey(b.licence_number)
  ) {
    return a.link === null || b.link === null || sameLink(a.link, b.link);
  }
  const cityA = cityKey(a.city);
  const cityB = cityKey(b.city);
  if (cityA === null || cityB === null) return false;
  return subjectName(a.name) === subjectName(b.name) && cityA === cityB;
}

function distinctCount(values: (string | null)[]): number {
  return new Set(values).size;
}

export function disambiguatorsFor(plausible: Candidate[]): string[] {
  const out: string[] = [];
  if (distinctCount(plausible.map((c) => cityKey(c.city))) > 1) out.push('city');
  if (distinctCount(plausible.map((c) => String(analyse(reorderLastFirst(c.name)).stripped.length))) > 1) {
    out.push('middle_name');
  }
  if (distinctCount(plausible.map((c) => (c.licence_type ? normaliseName(c.licence_type).folded : null))) > 1) {
    out.push('licence_type');
  }
  const numberKey = (n: string | null): string | null => (n ? n.replace(/\s+/g, '').toUpperCase() : null);
  if (distinctCount(plausible.map((c) => numberKey(c.licence_number))) > 1) out.push('licence_number');
  return out;
}

export function decide(cands: Candidate[]): Decision {
  const plausible = cands.filter((c) => c.score >= PLAUSIBLE).sort((a, b) => b.score - a.score);
  if (plausible.length === 0) {
    return { outcome: 'no_match', chosen: [], disambiguators: [], warnings: [] };
  }

  const top = plausible[0];
  // The top candidate is always its own subject, even when its city is missing.
  const isTopSubject = (c: Candidate): boolean => c.candidate_id === top.candidate_id || sameSubject(top, c);

  let rivalScore = 0;
  for (const c of cands) {
    if (!isTopSubject(c)) rivalScore = Math.max(rivalScore, c.score);
  }

  const disambiguators = disambiguatorsFor(plausible);
  const clear = top.score >= CLEAR_TOP - EPS && top.score - rivalScore >= CLEAR_GAP - EPS;

  if (clear) {
    const chosen = cands.filter(isTopSubject).sort((a, b) => b.score - a.score);
    return { outcome: 'match', chosen, disambiguators, warnings: [] };
  }

  const warnings: string[] = [];
  if (plausible.length === 1 && top.score < CLEAR_TOP - EPS) warnings.push('single_weak_candidate');
  return { outcome: 'multiple_matches', chosen: plausible, disambiguators, warnings };
}
