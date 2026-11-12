/**
 * The adapters that are connected, by registry id. getAdapter throws for a registry with no adapter and tryGetAdapter
 * returns undefined. Loading this module tells the support table which registries are connected.
 */

import { setConnectedProbe } from './catalog';
import type { RegistryId } from '../types';
import type { Adapter } from './adapter';
import { flDbpr } from './fl-dbpr';
import { flMqa } from './fl-mqa';

/** The adapter for each registry that has one. Every other registry is looked up here too. */
export const adapters: Partial<Record<RegistryId, Adapter>> = {
  'fl-mqa': flMqa,
  'fl-dbpr': flDbpr,
};

/** Throws when the registry has no adapter. */
export function getAdapter(id: RegistryId): Adapter {
  const adapter = adapters[id];
  if (!adapter) throw new Error(`No adapter is registered for ${id}`);
  return adapter;
}

/** Like getAdapter, but returns undefined instead of throwing, for callers that skip a registry with no adapter. */
export function tryGetAdapter(id: RegistryId): Adapter | undefined {
  return adapters[id];
}

// The support table's `connected` flag reads this, so it is true exactly when an adapter is registered.
setConnectedProbe((id) => adapters[id] !== undefined);

/** Tests use this to replace an adapter with a stand-in. Passing null removes the entry. */
export function registerAdapter(id: RegistryId, adapter: Adapter | null): void {
  if (adapter === null) delete adapters[id];
  else adapters[id] = adapter;
}
