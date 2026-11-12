/**
 * Compares the readings of independent readers. agree returns the fields all readers share, or what they differ on.
 * compareForWatch lists the watched fields that changed between two sets of fields, and expiryWarning flags an active
 * licence whose expiry date has passed.
 */

import type { Fields, Reading, ReaderName } from '../types';

/** The fields independent readers must agree on before a result is trusted. */
export const COMPARED: (keyof Fields)[] = ['status', 'licence_number', 'expires', 'discipline_flag'];

/** Fields a watch looks at: the readers' fields, plus the name and the number of discipline actions. */
export const WATCHED: (keyof Fields)[] = [...COMPARED, 'name', 'discipline_actions'];

/** Fields a missing value makes unsafe to decide on. A null here is a warning, not a value. */
const REQUIRED: (keyof Fields)[] = ['status', 'licence_number'];

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** fields is the shared reading when every reader agrees, and null otherwise. */
export function agree(readings: Reading[]): {
  agree: boolean;
  fields: Fields | null;
  differences: { field: keyof Fields; values: Record<ReaderName, unknown> }[];
  warnings: string[];
} {
  if (readings.length === 0) {
    return { agree: false, fields: null, differences: [], warnings: ['no_readings'] };
  }

  const warnings: string[] = [];
  for (const field of REQUIRED) {
    if (readings.some((r) => r.fields[field] === null)) warnings.push(`missing:${field}`);
  }
  // expires may legitimately be null in every reading (some registries show none). A null in
  // only some readers is a disagreement, recorded below as a difference.
  const expiresSomeNull =
    readings.some((r) => r.fields.expires === null) && readings.some((r) => r.fields.expires !== null);
  if (expiresSomeNull) warnings.push('missing:expires');

  const differences: { field: keyof Fields; values: Record<ReaderName, unknown> }[] = [];
  for (const field of COMPARED) {
    const first = readings[0].fields[field];
    if (readings.every((r) => same(r.fields[field], first))) continue;
    const values = {} as Record<ReaderName, unknown>;
    for (const r of readings) values[r.reader] = r.fields[field];
    differences.push({ field, values });
  }

  const ok = warnings.length === 0 && differences.length === 0;
  return { agree: ok, fields: ok ? readings[0].fields : null, differences, warnings };
}

/** note names the fields that changed without being watched, or is null when there are none. */
export function compareForWatch(
  before: Fields,
  after: Fields,
): {
  changed: boolean;
  changes: { field: keyof Fields; before: unknown; after: unknown }[];
  note: string | null;
} {
  // discipline_actions is compared by count: a change in how many actions there are is a change.
  const valueOf = (fields: Fields, field: keyof Fields): unknown =>
    field === 'discipline_actions' ? fields.discipline_actions.length : fields[field];
  const differs = (field: keyof Fields): boolean => !same(valueOf(before, field), valueOf(after, field));

  const changes = WATCHED.filter(differs).map((field) => ({
    field,
    before: valueOf(before, field),
    after: valueOf(after, field),
  }));

  const ignored = (Object.keys(before) as (keyof Fields)[]).filter(
    (field) => !WATCHED.includes(field) && differs(field),
  );

  const changed = changes.length > 0;
  let note: string | null = null;
  if (ignored.length > 0) {
    note = changed ? `not watched: ${ignored.join(', ')} changed` : `only ${ignored.join(', ')} changed`;
  }

  return { changed, changes, note };
}

/** Only an active licence can warn: its expiry date must already be past. */
export function expiryWarning(fields: Fields, now: Date): string | null {
  if (fields.expires === null || fields.status !== 'active') return null;
  const today = now.toISOString().slice(0, 10);
  return fields.expires < today ? 'expiry_in_past' : null;
}
