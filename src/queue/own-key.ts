/**
 * A visitor may run one lookup on their own TinyFish key, outside the free budget. The lookup takes several requests
 * to finish (it is queued, run, and its captured pages are read back), so the key is held for that long: encrypted
 * with a secret only the Worker has (OWN_KEY_SECRET, used for nothing else), tied to that one check, and deleted when
 * the check is done. The key is never logged, never returned, and never used for another check or for a watch.
 */

import type { Env } from '../env';
import { TinyFish } from '../tinyfish/client';

export const OWN_KEY_HEADER = 'X-TinyFish-Key';
/** A key whose lookup never finished is deleted after this long. */
export const OWN_KEY_TTL_MS = 30 * 60_000;
export const OWN_KEY_GONE =
  'Your TinyFish key was no longer held when this step ran, so the lookup stopped. Start it again.';

const MAX_KEY_LENGTH = 200;
const IV_BYTES = 12;

type ClientFactory = (key: string) => TinyFish;
let factory: ClientFactory | null = null;

/** Tests replace the client built for a visitor's key with a stand-in. Passing null restores the real client. */
export function setOwnClientFactory(next: ClientFactory | null): void {
  factory = next;
}

export function ownClient(key: string): TinyFish {
  return factory ? factory(key) : new TinyFish(key);
}

/** The key a request carries: null when there is none, 'invalid' when the header is not a key at all. */
export function readOwnKey(headers: Headers): string | 'invalid' | null {
  const raw = headers.get(OWN_KEY_HEADER);
  if (raw === null) return null;
  const key = raw.trim();
  if (key === '') return null;
  return key.length <= MAX_KEY_LENGTH && /^[\x21-\x7e]+$/.test(key) ? key : 'invalid';
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** True when this service can hold a visitor's key at all. */
export function canHoldOwnKeys(env: Env): boolean {
  return typeof env.OWN_KEY_SECRET === 'string' && env.OWN_KEY_SECRET !== '';
}

/**
 * The AES key is derived from OWN_KEY_SECRET alone. The webhook secret takes no part: it sits in addresses
 * that TinyFish holds, so it cannot protect anything.
 */
async function sealingKey(env: Env): Promise<CryptoKey> {
  if (!canHoldOwnKeys(env)) throw new Error('OWN_KEY_SECRET is not set');
  const secret = await crypto.subtle.importKey('raw', text(env.OWN_KEY_SECRET as string), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: text('tinyverify own key v1') },
    secret,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** The check id is authenticated with the sealed key, so a stored value moved to another check cannot be opened. */
const sealParams = (iv: Uint8Array, check_id: string) => ({ name: 'AES-GCM', iv, additionalData: text(check_id) });

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

/** Stores the key for one check, replacing any key already held for it. */
export async function holdOwnKey(
  env: Env,
  db: D1Database,
  check_id: string,
  key: string,
  now: Date = new Date(),
): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(sealParams(iv, check_id), await sealingKey(env), text(key)),
  );
  const stored = new Uint8Array(IV_BYTES + sealed.byteLength);
  stored.set(iv);
  stored.set(sealed, IV_BYTES);
  await db
    .prepare(
      'INSERT INTO own_keys (check_id, sealed, created_at) VALUES (?, ?, ?) ON CONFLICT(check_id) DO UPDATE SET sealed = excluded.sealed, created_at = excluded.created_at',
    )
    .bind(check_id, toBase64(stored), now.toISOString())
    .run();
}

/** The key held for a check, or null when none is held or it cannot be opened. */
export async function ownKeyFor(env: Env, db: D1Database, check_id: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT sealed FROM own_keys WHERE check_id = ?')
    .bind(check_id)
    .first<{ sealed: string }>();
  if (!row) return null;
  const stored = fromBase64(row.sealed);
  try {
    const opened = await crypto.subtle.decrypt(
      sealParams(stored.slice(0, IV_BYTES), check_id),
      await sealingKey(env),
      stored.slice(IV_BYTES),
    );
    return new TextDecoder().decode(opened);
  } catch {
    return null;
  }
}

/** Deletes the key once its check has an answer. A check still running keeps it. */
export async function dropOwnKeyIfDone(db: D1Database, check_id: string): Promise<void> {
  await db
    .prepare(
      "DELETE FROM own_keys WHERE check_id = ? AND EXISTS (SELECT 1 FROM checks WHERE check_id = ? AND state = 'done')",
    )
    .bind(check_id, check_id)
    .run();
}

export async function dropStaleOwnKeys(db: D1Database, now: Date = new Date()): Promise<void> {
  await db
    .prepare('DELETE FROM own_keys WHERE created_at < ?')
    .bind(new Date(now.getTime() - OWN_KEY_TTL_MS).toISOString())
    .run();
}
