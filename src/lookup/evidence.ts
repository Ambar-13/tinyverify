/**
 * Stored copies of the pages a reading came from. storeSnapshot saves a page with its SHA-256, and screenshotUrl
 * builds the address under which a caller can fetch the screenshot.
 */

import type { Env } from '../env';
import { insertSnapshot } from '../store';
import type { RegistryId } from '../types';

export interface SnapshotInput {
  check_id?: string;
  watch_id?: string;
  registry: RegistryId | 'generic';
  url: string;
  reader_input: 'fetch_html' | 'agent_html' | 'monitor_html';
  body: string;
  run_id?: string;
  step_id?: string;
}

/** Stores the page a reading came from, with its SHA-256 so the stored copy can be checked later. */
export async function storeSnapshot(
  db: D1Database,
  s: SnapshotInput,
): Promise<{ snapshot_id: string; content_sha256: string }> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s.body));
  const content_sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  const snapshot_id = await insertSnapshot(db, {
    check_id: s.check_id ?? null,
    watch_id: s.watch_id ?? null,
    registry: s.registry,
    url: s.url,
    reader_input: s.reader_input,
    content_sha256,
    body: s.body,
    run_id: s.run_id ?? null,
    step_id: s.step_id ?? null,
    created_at: new Date().toISOString(),
  });
  return { snapshot_id, content_sha256 };
}

export function screenshotUrl(env: Pick<Env, 'BASE_URL'>, snapshot_id: string): string {
  return `${env.BASE_URL}/evidence/${snapshot_id}/screenshot`;
}
