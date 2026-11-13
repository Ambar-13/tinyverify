/**
 * Who is calling. A key comes from `Authorization: Bearer <key>` or `X-API-Key`; the API and the MCP server both read
 * it here, so they agree on keys, owners and which watches a caller may see.
 */

import type { Env } from '../env';
import { bucketFor, type Bucket } from '../queue/budget';

/** Null when the request carries no key. */
export function parseKey(headers: Headers): string | null {
  const auth = headers.get('Authorization');
  if (auth !== null && auth.startsWith('Bearer ')) return auth.slice(7).trim() || null;
  return headers.get('X-API-Key')?.trim() || null;
}

/**
 * Caller scope. The owner is the SHA-256 of the key. Admin-created watches are owned by 'ops'.
 * Null means no key at all, which is refused before any use.
 */
export interface Scope {
  bucket: Bucket;
  owner: string | null;
}

/** The scope of the caller holding this key. */
export async function scopeFor(key: string | null, env: Env): Promise<Scope> {
  const bucket = bucketFor(key, env);
  const owner = key === null ? null : bucket === 'ops' ? 'ops' : await sha256Hex(key);
  return { bucket, owner };
}

/**
 * True when the scope may see the watch. Admin sees every live watch.
 * A NULL owner is treated as 'ops', so only admin sees it.
 */
export function watchVisibleTo(watch: { owner_hash?: string | null }, scope: Scope): boolean {
  if (scope.bucket === 'ops') return true;
  return (watch.owner_hash ?? 'ops') === scope.owner;
}

/** SHA-256 of a text, in hex. Keys and addresses are stored and compared only in this form. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
