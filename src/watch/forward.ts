/** Sends a watch's events to the webhook its caller gave, after checking that the address is safe to post to. */

import type { Event } from '../types';

const CALLER_TIMEOUT_MS = 10_000;

/**
 * Caller webhooks receive event data, so they must be public https endpoints.
 * Returns the reason when the URL is not acceptable, or null when it is.
 */
export function validateCallerWebhook(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'The caller webhook is not a valid URL';
  }
  if (parsed.protocol !== 'https:') return 'The caller webhook must use https';
  // WHATWG URL parsing already writes IPv4 in dotted form; IPv6 literals keep their brackets.
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) return 'The caller webhook must not be an IP address';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 'The caller webhook must not be an IP address';
  if (host === 'localhost' || /\.(local|internal|localhost)$/.test(host)) {
    return 'The caller webhook must not point at a local or internal host';
  }
  return null;
}

const FORWARDED_KINDS: Event['kind'][] = ['status_change', 'check_failed'];

/**
 * Posts one event to the caller. Only changes go out: status_change and check_failed. An unchanged
 * event is stored and never posted, since every Monitor run writes one. The URL is checked again before sending,
 * and a redirect is never followed, since its target was not checked. Failures are logged and never thrown.
 */
export async function forwardEvent(event: Event, caller_webhook: string | null): Promise<void> {
  if (caller_webhook === null) return;
  if (!FORWARDED_KINDS.includes(event.kind)) return;
  const reason = validateCallerWebhook(caller_webhook);
  if (reason !== null) {
    console.warn(`Caller webhook not used for event ${event.event_id}: ${reason}`);
    return;
  }
  try {
    const res = await fetch(caller_webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      redirect: 'manual',
      signal: AbortSignal.timeout(CALLER_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) {
      console.warn(`Caller webhook answered ${res.status} for event ${event.event_id}; redirect not followed`);
      return;
    }
    if (!res.ok) console.warn(`Caller webhook answered ${res.status} for event ${event.event_id}`);
  } catch (err) {
    console.warn(`Caller webhook failed for event ${event.event_id}: ${err instanceof Error ? err.name : 'error'}`);
  }
}
