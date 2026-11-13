import { describe, expect, it } from 'vitest';
import { archiveFetchUrl, checkArchiveUrls, replayPages } from '../scripts/replay-lib';
import dbprA from './fixtures/pairs/dbpr-a.html?raw';

const ORIGINAL = 'https://www.myfloridalicense.com/LicenseDetail.asp?SID=&id=0';
const OLDER = `https://web.archive.org/web/20240101000000/${ORIGINAL}`;
const NEWER = `https://web.archive.org/web/20250305120000/${ORIGINAL}`;

// The fixture reads "Current,Active". The same page with another status word is the "later" capture.
const delinquent = dbprA.replace('Current,Active', 'Delinquent,Active');
const run = (older: string, newer: string) => replayPages('fl-dbpr', older, newer, OLDER, NEWER);

describe('replay of archived pages', () => {
  it('prints a status change, label line first', () => {
    const r = run(dbprA, delinquent);
    expect(r.exitCode).toBe(0);
    expect(r.lines[0]).toBe('replay of archived pages');
    expect(r.lines[1]).toBe('fl-dbpr CCC0000000');
    expect(r.lines).toContain('older capture: 2024-01-01');
    expect(r.lines).toContain('newer capture: 2025-03-05');
    expect(r.lines).toContain('status: active -> delinquent');
    expect(r.lines).toContain(`older: ${OLDER}`);
    expect(r.lines).toContain(`newer: ${NEWER}`);
  });

  it('prints the lines in the stated order', () => {
    const lines = run(dbprA, delinquent).lines;
    const at = (needle: string) => lines.findIndex((l) => l.startsWith(needle));
    expect(at('replay of')).toBeLessThan(at('fl-dbpr'));
    expect(at('fl-dbpr')).toBeLessThan(at('older capture'));
    expect(at('newer capture')).toBeLessThan(at('status:'));
    expect(at('status:')).toBeLessThan(at('older:'));
  });

  it('says so when no watched field changed', () => {
    const r = run(dbprA, dbprA);
    expect(r.exitCode).toBe(0);
    expect(r.lines).toContain('no change in watched fields');
    expect(r.lines.some((l) => l.startsWith('status:'))).toBe(false);
  });

  it('prints an expiry change as its own line', () => {
    const renewed = dbprA.replace('08/31/2028', '08/31/2030');
    const r = run(dbprA, renewed);
    expect(r.exitCode).toBe(0);
    expect(r.lines).toContain('expires: 2028-08-31 -> 2030-08-31');
  });

  it('refuses two different records', () => {
    const other = dbprA.replace('CCC0000000', 'CCC0000001');
    const r = run(dbprA, other);
    expect(r.exitCode).toBe(1);
    expect(r.lines).toEqual(['these are two different records']);
  });

  it('refuses a page its two readers read differently, naming the page and the field', () => {
    // The style block is hidden text to one reader and visible text to the other.
    const split = dbprA.replace('Current,Active', '<style>Delinquent,Active</style>Current,Active');
    const older = run(split, dbprA);
    expect(older.exitCode).toBe(1);
    expect(older.lines).toEqual(['readers disagree on the older page: status']);
    const newer = run(dbprA, split);
    expect(newer.exitCode).toBe(1);
    expect(newer.lines).toEqual(['readers disagree on the newer page: status']);
  });

  it('prints no name and no address, even when the name changed', () => {
    const renamed = delinquent.replace('SAMPLE, PERSON A', 'SAMPLE, PERSON B');
    for (const r of [run(dbprA, delinquent), run(dbprA, renamed)]) {
      const out = r.lines.join('\n');
      expect(out).not.toMatch(/SAMPLE, PERSON/i);
      expect(out).not.toContain('Sample St');
      expect(out).not.toContain('SAMPLE CITY');
    }
    expect(run(dbprA, renamed).lines).toContain('name: changed');
  });
});

describe('archive addresses', () => {
  it('accepts web.archive.org captures', () => {
    expect(checkArchiveUrls(OLDER, NEWER)).toBeNull();
  });

  it('refuses any other host with exit 2 and the fixed sentence', () => {
    for (const bad of [
      ORIGINAL,
      'https://web.archive.org.example.com/web/20240101000000/x',
      'https://example.com/web.archive.org/web/20240101000000/x',
      'https://user@evil.example/web/20240101000000/x',
      'not a url',
    ]) {
      expect(checkArchiveUrls(bad, NEWER)).toEqual({ exitCode: 2, lines: ['replay reads archived pages only'] });
      expect(checkArchiveUrls(OLDER, bad)).toEqual({ exitCode: 2, lines: ['replay reads archived pages only'] });
    }
  });

  it('refuses an archive address with no 14-digit timestamp', () => {
    const r = checkArchiveUrls('https://web.archive.org/web/2024/https://example.org/', NEWER);
    expect(r?.exitCode).toBe(2);
  });

  it('inserts id_ after the timestamp, once', () => {
    expect(archiveFetchUrl(OLDER)).toBe(`https://web.archive.org/web/20240101000000id_/${ORIGINAL}`);
    expect(archiveFetchUrl(archiveFetchUrl(OLDER))).toBe(`https://web.archive.org/web/20240101000000id_/${ORIGINAL}`);
  });
});
