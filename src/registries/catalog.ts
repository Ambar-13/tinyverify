/**
 * The support table: which registries exist, which record types and places each covers, and whether an adapter is
 * connected. routesFor finds the registries for a type and place. The helpers here also normalise record types,
 * places and licence numbers, and check a number against the registry's published format.
 */

import type { Jurisdiction, RecordType, RegistryId } from '../types';

export interface RegistryInfo {
  id: RegistryId;
  name: string;
  jurisdiction: Jurisdiction;
  types: RecordType[];
  url: string;
  read_route: 'fetch' | 'agent';
  watch_tier: 'monitor' | 'recheck';
  /** True when an adapter is registered for this registry, so a lookup can really read it. */
  connected: boolean;
}

/**
 * The adapters live in registries/index.ts, which imports this file, so the table cannot import
 * them back. That module installs the answer here when it loads, and `connected` asks it each time.
 */
let isConnected: (id: RegistryId) => boolean = () => false;

export function setConnectedProbe(probe: (id: RegistryId) => boolean): void {
  isConnected = probe;
}

/** A table row whose `connected` is read live. It is enumerable, so copies and JSON carry the value. */
function row(info: Omit<RegistryInfo, 'connected'>): RegistryInfo {
  return Object.defineProperty({ ...info } as RegistryInfo, 'connected', {
    enumerable: true,
    get: () => isConnected(info.id),
  });
}

/**
 * The one support table. Routing and the demo page read it.
 * A registry stays in the table when it has no adapter yet; `connected` says so.
 */
export const registries: RegistryInfo[] = [
  row({
    id: 'fl-mqa',
    name: 'Florida Department of Health, MQA licence verification',
    jurisdiction: 'US-FL',
    types: ['physician', 'dentist', 'nurse', 'pharmacist'],
    url: 'https://mqa-internet.doh.state.fl.us/MQASearchServices/HealthCareProviders',
    read_route: 'fetch',
    watch_tier: 'monitor',
  }),
  row({
    id: 'fl-dbpr',
    name: 'Florida Department of Business and Professional Regulation',
    jurisdiction: 'US-FL',
    types: ['contractor'],
    url: 'https://www.myfloridalicense.com/wl11.asp?mode=0&SID=',
    read_route: 'fetch',
    watch_tier: 'monitor',
  }),
  row({
    id: 'ca-cslb',
    name: 'California Contractors State License Board',
    jurisdiction: 'US-CA',
    types: ['contractor'],
    url: 'https://www.cslb.ca.gov/OnlineServices/CheckLicenseII/CheckLicense.aspx',
    read_route: 'agent',
    watch_tier: 'recheck',
  }),
  row({
    id: 'au-ahpra',
    name: 'Australian Health Practitioner Regulation Agency public register',
    jurisdiction: 'AU',
    types: ['physician', 'dentist', 'nurse', 'pharmacist'],
    url: 'https://www.ahpra.gov.au/Registration/Registers-of-Practitioners.aspx',
    read_route: 'agent',
    watch_tier: 'recheck',
  }),
];

/**
 * Matching key: lower case, with every character that is not a letter or digit removed.
 * That makes case, spaces and punctuation irrelevant ("M.D." and "md" are the same key).
 */
const matchKey = (input: string): string => input.toLowerCase().replace(/[^a-z0-9]/g, '');

const RECORD_TYPE_SYNONYMS: Record<RecordType, string[]> = {
  physician: [
    'physician',
    'doctor',
    'md',
    'medical doctor',
    'gp',
    'general practitioner',
    'osteopathic physician',
    'do',
    'medical practitioner',
  ],
  dentist: ['dentist', 'dds', 'dmd', 'dental practitioner'],
  nurse: ['nurse', 'rn', 'registered nurse', 'lpn', 'licensed practical nurse', 'enrolled nurse'],
  pharmacist: ['pharmacist', 'pharmacy'],
  contractor: [
    'contractor',
    'general contractor',
    'building contractor',
    'roofer',
    'roofing contractor',
    'builder',
    'electrical contractor',
    'plumbing contractor',
    'licensed contractor',
    'electrician',
    'plumber',
    'hvac contractor',
    'roofing',
  ],
  // A company's registration with the state or national business register, not a licence to practise.
  company: [
    'company',
    'business',
    'corporation',
    'llc',
    'business entity',
    'business registration',
    'company registration',
    'registered company',
  ],
};

const RECORD_TYPE_BY_KEY = new Map<string, RecordType>(
  (Object.entries(RECORD_TYPE_SYNONYMS) as [RecordType, string[]][]).flatMap(([type, words]) =>
    words.map((word): [string, RecordType] => [matchKey(word), type]),
  ),
);

const AUSTRALIA_NAMES = [
  'au',
  'aus',
  'australia',
  'new south wales',
  'nsw',
  'victoria',
  'vic',
  'queensland',
  'qld',
  'western australia',
  'wa',
  'south australia',
  'sa',
  'tasmania',
  'tas',
  'australian capital territory',
  'act',
  'northern territory',
  'nt',
];

const PLACE_NAMES: Record<Jurisdiction, string[]> = {
  'US-FL': ['us-fl', 'fl', 'florida'],
  'US-CA': ['us-ca', 'ca', 'california'],
  AU: AUSTRALIA_NAMES,
};

const JURISDICTION_BY_KEY = new Map<string, Jurisdiction>(
  (Object.entries(PLACE_NAMES) as [Jurisdiction, string[]][]).flatMap(([place, names]) =>
    names.map((name): [string, Jurisdiction] => [matchKey(name), place]),
  ),
);

export function normaliseRecordType(input: string): RecordType | null {
  return RECORD_TYPE_BY_KEY.get(matchKey(input)) ?? null;
}

/** A trailing country name is allowed after any supported name, e.g. "California, USA". */
const TRAILING_COUNTRY = /,\s*(usa|us|united states|australia)\s*$/i;

export function parseJurisdiction(input: string): Jurisdiction | null {
  const bare = input.replace(TRAILING_COUNTRY, '');
  return JURISDICTION_BY_KEY.get(matchKey(bare)) ?? null;
}

export function routesFor(type: RecordType, j: Jurisdiction): RegistryInfo[] {
  return registries.filter((r) => r.jurisdiction === j && r.types.includes(type));
}

/** Trims, removes every space and upper-cases. */
export function normaliseLicenceNumber(input: string): string {
  return input.trim().replace(/\s+/g, '').toUpperCase();
}

/** Published formats only. Registries without one return null for any input. */
const PUBLISHED_FORMATS: Partial<Record<RegistryId, { pattern: RegExp; message: string }>> = {
  'ca-cslb': {
    pattern: /^\d{1,8}$/,
    message: 'CSLB licence numbers are digits only, up to 8 digits',
  },
  'fl-mqa': {
    pattern: /^[A-Z]{2,4}\d+$/,
    message:
      'Florida health licence numbers are a two to four letter profession prefix followed by digits, for example ME000000 or APRN0000000',
  },
};

/**
 * The message to give when n breaks the registry's published number format. Null when it fits, or when the registry
 * publishes none.
 */
export function formatCheck(registry: RegistryId, n: string): string | null {
  const format = PUBLISHED_FORMATS[registry];
  if (!format) return null;
  return format.pattern.test(normaliseLicenceNumber(n)) ? null : format.message;
}
