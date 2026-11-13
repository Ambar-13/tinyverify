/**
 * The TinyFish client this service uses for its own account. Every call made through it is observed, so GET /status
 * can say whether TinyFish was reachable the last time it was asked.
 */

import type { Env } from '../env';
import { TinyFish, TinyFishError } from './client';

type ClientFactory = (env: Env) => TinyFish;

let clientFactory: ClientFactory | null = null;

/** Tests replace the TinyFish client with a stand-in. Passing null restores the real client. */
export function setClientFactory(factory: ClientFactory | null): void {
  clientFactory = factory;
}

export type TinyfishState = 'ok' | 'unreachable' | 'unknown';

let state: TinyfishState = 'unknown';

/** The outcome of the last TinyFish call made through this isolate. Read by GET /status. */
export function tinyfishState(): TinyfishState {
  return state;
}

function noteOutcome(err: unknown): void {
  const unreachable = err instanceof TinyFishError && (err.code === 'network' || err.code === 'timeout');
  state = unreachable ? 'unreachable' : 'ok';
}

/**
 * Wraps every method of the client so its last outcome is remembered. Calls still run on the real object,
 * so the client's private fields keep working.
 */
function observed(target: TinyFish): TinyFish {
  return new Proxy(target, {
    get(realClient, prop) {
      const value: unknown = Reflect.get(realClient, prop, realClient);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        let out: unknown;
        try {
          out = (value as (...a: unknown[]) => unknown).apply(realClient, args);
        } catch (err) {
          noteOutcome(err);
          throw err;
        }
        if (out instanceof Promise) {
          return out.then(
            (v) => {
              noteOutcome(null);
              return v;
            },
            (err: unknown) => {
              noteOutcome(err);
              throw err;
            },
          );
        }
        noteOutcome(null);
        return out;
      };
    },
  });
}

/** The client for this service's own TinyFish account. */
export function clientFor(env: Env): TinyFish {
  const raw = clientFactory ? clientFactory(env) : new TinyFish(env.TINYFISH_API_KEY);
  return observed(raw);
}
