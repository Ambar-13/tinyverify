/**
 * Hourly lookup limits for callers with no key. Visitors are told apart by a SHA-256 of their address; a request with
 * no CF-Connecting-IP header shares one key. A slot is taken before a lookup starts and given back when the answer
 * came from the cache or the input was refused, since neither spends a run.
 *
 * Counts are kept in memory, per isolate, so across the platform the effective limit can be higher than the number
 * below. The spending limits in queue/budget.ts are the hard stop; this one only slows a single address.
 */

import type { Bucket } from '../queue/budget';
import { sha256Hex } from './auth';

const HOUR_MS = 3_600_000;
const LOOKUP_LIMIT = 20;
const OWN_LOOKUP_LIMIT = 60;

const lookupCounts = new Map<string, number>();

type HasHeaders = { req: { header(name: string): string | undefined } };

async function visitor(c: HasHeaders, now: number, group = ''): Promise<{ key: string; resets_at: string }> {
  const ip = c.req.header('CF-Connecting-IP') ?? 'no-ip';
  const hash = await sha256Hex(ip);
  const hour = Math.floor(now / HOUR_MS);
  for (const key of lookupCounts.keys()) {
    if (Number(key.split(':')[0]) < hour) lookupCounts.delete(key);
  }
  return { key: `${hour}:${group}${hash}`, resets_at: new Date((hour + 1) * HOUR_MS).toISOString() };
}

function lookupsUsed(key: string): number {
  return lookupCounts.get(key) ?? 0;
}

function takeLookup(key: string): void {
  lookupCounts.set(key, lookupsUsed(key) + 1);
}

function giveBackLookup(key: string): void {
  lookupCounts.set(key, Math.max(0, lookupsUsed(key) - 1));
}

type Lookup = { served_from_cache?: boolean; outcome?: string | null };

/**
 * Runs one lookup for a caller. A caller with no key takes a slot from their address's hourly limit
 * first, and is refused with the reset time when none is left. The slot comes back when the lookup
 * throws. The API and the MCP server both count here, so one address has one limit across the two.
 */
export async function countedLookup<T extends Lookup>(
  c: HasHeaders,
  bucket: Bucket,
  work: () => Promise<T>,
): Promise<{ result: T } | { limit: number; resets_at: string }> {
  // A lookup on the visitor's own key spends none of this service's money, but it still takes queue room, so an
  // address has a second, larger hourly limit for those.
  const limit = bucket === 'public' ? LOOKUP_LIMIT : bucket === 'own' ? OWN_LOOKUP_LIMIT : null;
  if (limit === null) return { result: await work() };
  const seen = await visitor(c, Date.now(), bucket === 'own' ? 'own:' : '');
  if (lookupsUsed(seen.key) >= limit) return { limit, resets_at: seen.resets_at };
  takeLookup(seen.key);
  try {
    const result = await work();
    if (result.served_from_cache || result.outcome === 'invalid_input') giveBackLookup(seen.key);
    return { result };
  } catch (err) {
    giveBackLookup(seen.key);
    throw err;
  }
}

export function limitMessage(limit: number): string {
  return `This address has reached ${limit} agent lookups this hour. Try again after the reset time.`;
}
