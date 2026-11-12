import type { RegistryId, Status } from '../types';

// Status wordings, per registry, and the status each one maps to. Data only. Keys are stored normalised: lower case,
// spaces collapsed, no spaces around commas and slashes, trailing slashes removed. statusFor normalises the input the
// same way before it looks anything up.

const normKey = (s: string): string =>
  s
    .replace(/\s+/g, ' ')
    .replace(/ ?([,/]) ?/g, '$1')
    .trim()
    .toLowerCase()
    .replace(/\/+$/, '')
    .trim();

/** Null prototype, so no wording can read an inherited property such as "constructor". */
function table(entries: [string, Status][]): Record<string, Status> {
  const out: Record<string, Status> = Object.create(null) as Record<string, Status>;
  for (const [k, v] of entries) out[normKey(k)] = v;
  return out;
}

const FL_MQA: [string, Status][] = [
  ['Clear/Active', 'active'],
  ['Clear/', 'active'],
  ['Obligations/Active', 'probation'],
  ['Military', 'other'],
  ['Probation', 'probation'],
  ['Null and Void', 'inactive'],
  ['Retired', 'inactive'],
  ['Closed', 'inactive'],
  ['Revoked', 'revoked'],
  ['Suspended', 'suspended'],
  ['Emerg Suspens', 'suspended'],
  ['Delinquent', 'delinquent'],
  ['DISCP-RELINQ', 'surrendered'],
  ['DISCP RELINQ', 'surrendered'],
  ['Relinquished', 'surrendered'],
  ['Voluntary Relinquishment', 'surrendered'],
  ['Expired', 'expired'],
  ['Pending', 'pending'],
];

const FL_DBPR: [string, Status][] = [
  ['Current,Active', 'active'],
  ['Delinquent,Active', 'delinquent'],
  ['Current,Inactive', 'inactive'],
  ['Delinquent,Inactive', 'delinquent'],
  ['Suspended,Inactive', 'suspended'],
  ['Revoked,Inactive', 'revoked'],
  ['Delinquent', 'delinquent'],
  ['Null and Void', 'inactive'],
  ['Suspended', 'suspended'],
  ['Revoked', 'revoked'],
  ['Expired', 'expired'],
  ['Probation', 'probation'],
];

/** CSLB keys are sentence starts. A raw sentence maps by its longest matching start. */
const CA_CSLB: [string, Status][] = [
  ['This license is current and active', 'active'],
  ['This license is current and inactive', 'inactive'],
  ['This license is expired', 'expired'],
  ['This license is suspended', 'suspended'],
  ['License is under suspension', 'suspended'],
  ['This license is revoked', 'revoked'],
  ['This license is cancelled', 'inactive'],
  ['This license is canceled', 'inactive'],
  ['This license is inactive', 'inactive'],
];

export const STATUS_TABLES: Record<RegistryId, Record<string, Status>> = {
  'fl-mqa': table(FL_MQA),
  'fl-dbpr': table(FL_DBPR),
  'ca-cslb': table(CA_CSLB),
  'au-ahpra': {},
};

/**
 * Adverse terms for fl-mqa and fl-dbpr, checked in this order, only after the exact lookup
 * fails. Nothing maps to active by substring.
 */
const ADVERSE: [string, Status][] = [
  ['null and void', 'inactive'],
  ['revoked', 'revoked'],
  ['suspen', 'suspended'],
  ['relinquish', 'surrendered'],
  ['delinquent', 'delinquent'],
  ['probation', 'probation'],
  ['expired', 'expired'],
];

/**
 * Maps one registry's status wording to a status. Exact normalised key first; for ca-cslb,
 * the longest sentence start; for fl-mqa and fl-dbpr, the ordered adverse terms; otherwise other.
 */
export function statusFor(registry: RegistryId, raw: string): Status {
  const table = STATUS_TABLES[registry];
  const k = normKey(raw);
  if (k === '') return 'other';
  if (registry === 'ca-cslb') {
    let best: string | null = null;
    for (const key of Object.keys(table)) {
      if (k.startsWith(key) && (best === null || key.length > best.length)) best = key;
    }
    return best === null ? 'other' : table[best];
  }
  if (Object.hasOwn(table, k)) return table[k];
  for (const [term, status] of ADVERSE) {
    if (k.includes(term)) return status;
  }
  return 'other';
}
