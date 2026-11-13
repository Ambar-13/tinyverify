/**
 * Turns a live registry page into a test fixture with no personal data in it.
 *
 * Usage:
 *   npx tsx scripts/capture.ts <registry id> <url> <name>
 *   npx tsx scripts/capture.ts --scrub <name> <fixture path>
 *
 * The first form reads the url through TinyFish Fetch and saves the response in a scratch folder outside the
 * repository (TINYVERIFY_SCRATCH). It prints the outcome and the character count, never the page. The second form
 * writes the scrubbed copy under tests/fixtures/ and refuses while anything real is left in it.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TinyFish, TinyFishError } from '../src/tinyfish/client';
import { ScrubRefused, scrub, type ScrubRegistry } from './capture-scrub';

/** The repository root, found from this script's own location. */
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const DEV_VARS = `${ROOT}/.dev.vars`;
const SCRATCH = process.env.TINYVERIFY_SCRATCH ?? '';
const LOG = `${SCRATCH}/requests.log`;
const BUDGET = 40;

const readIfThere = (path: string): string | null => {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
};

/** The TinyFish key: the environment wins, otherwise the TINYFISH_API_KEY line of .dev.vars. */
function tinyfishKey(): string | null {
  const fromEnv = process.env.TINYFISH_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const line = (readIfThere(DEV_VARS) ?? '').split(/\r?\n/).find((l) => l.startsWith('TINYFISH_API_KEY='));
  const value = line
    ?.slice('TINYFISH_API_KEY='.length)
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2');
  return value || null;
}

const used = (): number => (readIfThere(LOG) ?? '').split('\n').filter((l) => l !== '').length;

/** The registry's own ids in a url: LicInd and ProCde for fl-mqa, id for fl-dbpr. */
function idsIn(url: string): string[] {
  try {
    const u = new URL(url);
    return ['LicInd', 'ProCde', 'ID', 'id'].map((k) => u.searchParams.get(k) ?? '').filter((v) => v !== '');
  } catch {
    return [];
  }
}

async function capture(registry: string, url: string, name: string): Promise<number> {
  if (
    registry !== 'fl-mqa' &&
    registry !== 'fl-dbpr' &&
    registry !== 'fl-mqa-tab' &&
    registry !== 'fl-dbpr-complaints' &&
    registry !== 'fl-dbpr-results'
  ) {
    console.log(
      'registry must be fl-mqa, fl-dbpr, fl-mqa-tab (the enforcement tab), fl-dbpr-complaints (the complaint view) or fl-dbpr-results (the results list)',
    );
    return 2;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    console.log('name may hold letters, digits, dot, dash and underscore only');
    return 2;
  }
  if (used() >= BUDGET) {
    console.log(`request budget of ${BUDGET} is used`);
    return 3;
  }
  const key = tinyfishKey();
  if (key === null) {
    console.log('No TinyFish key found. Create .dev.vars with TINYFISH_API_KEY=<key>.');
    return 2;
  }
  mkdirSync(SCRATCH, { recursive: true });
  appendFileSync(LOG, `${new Date().toISOString()} ${registry} ${name}\n`);
  const tf = new TinyFish(key);
  try {
    const res = await tf.fetchPages([url], { format: 'html', ttl: 0 });
    const hit = res.results.find((r) => r.text);
    if (!hit) {
      console.log(`HTTP ok, no page, error ${res.errors[0]?.code ?? 'empty'}`);
      return 1;
    }
    if (hit.text.length < 200) {
      console.log(`HTTP ok, ${hit.text.length} characters: too short, discarded`);
      return 1;
    }
    writeFileSync(`${SCRATCH}/${name}.tf.html`, hit.text);
    writeFileSync(`${SCRATCH}/${name}.meta.json`, JSON.stringify({ registry, url }));
    console.log(`HTTP ok, ${hit.text.length} characters, saved as ${name}.tf.html (request ${used()} of ${BUDGET})`);
    return 0;
  } catch (e) {
    if (e instanceof TinyFishError) {
      console.log(`error ${e.code} HTTP ${e.status}`);
      return e.status === 401 || e.status === 403 ? 4 : 1;
    }
    console.log('error');
    return 1;
  }
}

function scrubToFixture(name: string, fixturePath: string): number {
  const text = readIfThere(`${SCRATCH}/${name}.tf.html`);
  const meta = readIfThere(`${SCRATCH}/${name}.meta.json`);
  if (text === null || meta === null) {
    console.log('no capture with that name in the scratch folder');
    return 2;
  }
  const { registry, url } = JSON.parse(meta) as { registry: ScrubRegistry; url: string };
  const target = fixturePath.startsWith('/') ? fixturePath : `${ROOT}/${fixturePath}`;
  if (!target.startsWith(`${ROOT}/tests/fixtures/`)) {
    console.log('the fixture path must be under tests/fixtures/');
    return 2;
  }
  try {
    const clean = scrub(registry, text, idsIn(url));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, clean);
    console.log(`wrote ${target.slice(ROOT.length + 1)} (${clean.length} characters)`);
    return 0;
  } catch (e) {
    console.log(e instanceof ScrubRefused ? `scrub refused: ${e.message}` : 'scrub failed');
    return 1;
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (SCRATCH === '') {
    console.log('Set TINYVERIFY_SCRATCH to a folder outside the repository.');
    return 2;
  }
  if (args[0] === '--scrub' && args.length === 3) return scrubToFixture(args[1], args[2]);
  if (args.length === 3 && !args[0].startsWith('--')) return capture(args[0], args[1], args[2]);
  console.log('usage: capture.ts <registry id> <url> <name> | capture.ts --scrub <name> <fixture path>');
  return 2;
}

main().then((code) => process.exit(code));
