/**
 * Replay of archived pages: the logic. The command-line entry is scripts/replay.ts. Nothing here reads files, uses
 * the network or exits the process; the entry passes the pages in. The output never holds a name or an address.
 */

import { agree, compareForWatch } from '../src/lookup/agree';
import type { Fields, Reading, RegistryId } from '../src/types';
import type { Adapter } from '../src/registries/adapter';
import { caCslb } from '../src/registries/ca-cslb';
import { flDbpr } from '../src/registries/fl-dbpr';
import { flMqa } from '../src/registries/fl-mqa';

export interface Result {
  exitCode: number;
  lines: string[];
}

export const REPLAY_REGISTRIES: Partial<Record<RegistryId, Adapter>> = {
  'fl-mqa': flMqa,
  'fl-dbpr': flDbpr,
  'ca-cslb': caCslb,
};

export const ARCHIVE_ONLY = 'replay reads archived pages only';

/** "https://web.archive.org/web/<14 digits>[id_]/<original address>" */
const CAPTURE = /^https?:\/\/web\.archive\.org\/web\/(\d{14})(?:id_)?\/(.+)$/;

function onArchiveHost(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      (u.protocol === 'https:' || u.protocol === 'http:') &&
      u.hostname === 'web.archive.org' &&
      u.username === '' &&
      u.password === '' &&
      u.port === ''
    );
  } catch {
    return false;
  }
}

/** null when both addresses are archive captures; otherwise the result to print, with no request sent. */
export function checkArchiveUrls(older: string, newer: string): Result | null {
  for (const url of [older, newer]) {
    if (!onArchiveHost(url) || !CAPTURE.test(url)) return { exitCode: 2, lines: [ARCHIVE_ONLY] };
  }
  return null;
}

/** The raw archived form of a capture address: "id_" right after the timestamp, so the toolbar is left out. */
export function archiveFetchUrl(url: string): string {
  const m = CAPTURE.exec(url);
  if (!m) throw new Error('not an archive capture address');
  return `https://web.archive.org/web/${m[1]}id_/${m[2]}`;
}

/** YYYY-MM-DD from the capture timestamp, or null when it is not a real date. */
export function captureDate(url: string): string | null {
  const m = CAPTURE.exec(url);
  if (!m) return null;
  const [y, mo, d] = [m[1].slice(0, 4), m[1].slice(4, 6), m[1].slice(6, 8)];
  const check = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  const ok =
    check.getUTCFullYear() === Number(y) && check.getUTCMonth() === Number(mo) - 1 && check.getUTCDate() === Number(d);
  return ok ? `${y}-${mo}-${d}` : null;
}

/** Both readers on one page. Fields when they agree; otherwise the names of what they disagree on. */
function readPage(adapter: Adapter, html: string): { fields: Fields } | { problems: string[] } {
  const readings: Reading[] = [adapter.parseHtml(html), adapter.parseText(html)];
  const verdict = agree(readings);
  if (verdict.agree && verdict.fields) return { fields: verdict.fields };
  const problems = [...verdict.differences.map((d) => String(d.field)), ...verdict.warnings];
  return { problems: problems.length > 0 ? problems : ['unreadable'] };
}

const show = (v: unknown): string => (v === null || v === undefined ? 'none' : String(v));

export function replayPages(
  registryId: RegistryId,
  olderHtml: string,
  newerHtml: string,
  olderUrl: string,
  newerUrl: string,
): Result {
  const adapter = REPLAY_REGISTRIES[registryId];
  if (!adapter) return { exitCode: 2, lines: [`no adapter for registry ${registryId}`] };
  const refused = checkArchiveUrls(olderUrl, newerUrl);
  if (refused) return refused;

  const older = readPage(adapter, olderHtml);
  if ('problems' in older)
    return { exitCode: 1, lines: [`readers disagree on the older page: ${older.problems.join(', ')}`] };
  const newer = readPage(adapter, newerHtml);
  if ('problems' in newer)
    return { exitCode: 1, lines: [`readers disagree on the newer page: ${newer.problems.join(', ')}`] };

  if (older.fields.licence_number !== newer.fields.licence_number) {
    return { exitCode: 1, lines: ['these are two different records'] };
  }

  const diff = compareForWatch(older.fields, newer.fields);
  const changeLines = diff.changed
    ? // A name is a person or a business; the report never prints one, so a name change says only that it changed.
      diff.changes.map((c) =>
        c.field === 'name' ? 'name: changed' : `${c.field}: ${show(c.before)} -> ${show(c.after)}`,
      )
    : ['no change in watched fields'];

  return {
    exitCode: 0,
    lines: [
      'replay of archived pages',
      `${registryId} ${older.fields.licence_number}`,
      `older capture: ${captureDate(olderUrl)}`,
      `newer capture: ${captureDate(newerUrl)}`,
      ...changeLines,
      `older: ${olderUrl}`,
      `newer: ${newerUrl}`,
    ],
  };
}
