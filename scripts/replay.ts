/**
 * Replays a real change: reads two archived copies of one licence page and prints which watched fields differ between
 * them. Only web.archive.org is contacted. The logic is in replay-lib.ts.
 *
 * Usage:
 *   npx tsx scripts/replay.ts <registry id> <older archive url> <newer archive url>
 */

import type { RegistryId } from '../src/types';
import { REPLAY_REGISTRIES, archiveFetchUrl, checkArchiveUrls, replayPages } from './replay-lib';

const TIMEOUT_MS = 30_000;
const GAP_MS = 2_000;

async function fetchPage(which: 'older' | 'newer', url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(archiveFetchUrl(url), { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
  } catch (e) {
    console.log(`the ${which} page failed to load: ${e instanceof Error ? e.name : 'error'}`);
    process.exit(1);
  }
  if (!res.ok) {
    console.log(`the ${which} page failed to load: HTTP ${res.status}`);
    process.exit(1);
  }
  return res.text();
}

async function main(): Promise<void> {
  const [id, olderUrl, newerUrl] = process.argv.slice(2);
  if (!id || !olderUrl || !newerUrl || !(id in REPLAY_REGISTRIES)) {
    console.log('usage: npx tsx scripts/replay.ts <fl-mqa|fl-dbpr|ca-cslb> <older archive url> <newer archive url>');
    process.exit(2);
  }
  const refused = checkArchiveUrls(olderUrl, newerUrl);
  if (refused) {
    console.log(refused.lines.join('\n'));
    process.exit(refused.exitCode);
  }
  const older = await fetchPage('older', olderUrl);
  await new Promise((r) => setTimeout(r, GAP_MS));
  const newer = await fetchPage('newer', newerUrl);
  const result = replayPages(id as RegistryId, older, newer, olderUrl, newerUrl);
  console.log(result.lines.join('\n'));
  process.exit(result.exitCode);
}

void main();
