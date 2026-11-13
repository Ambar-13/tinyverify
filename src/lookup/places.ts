/**
 * Places and their official hosts. A lookup with no adapter trusts a register only when its link sits on a host that
 * belongs to the government of the place asked; the rules for that are here, with the list of places a caller may
 * name and the wording used to search for a register.
 */

import type { Jurisdiction, RecordType } from '../types';

/** A place a caller may name: a US state, the United States as a whole, or a listed country. */
export interface Place {
  name: string;
  kind: 'state' | 'us' | 'country';
}

const US_STATES: [string, string][] = [
  ['Alabama', 'AL'],
  ['Alaska', 'AK'],
  ['Arizona', 'AZ'],
  ['Arkansas', 'AR'],
  ['California', 'CA'],
  ['Colorado', 'CO'],
  ['Connecticut', 'CT'],
  ['Delaware', 'DE'],
  ['Florida', 'FL'],
  ['Georgia', 'GA'],
  ['Hawaii', 'HI'],
  ['Idaho', 'ID'],
  ['Illinois', 'IL'],
  ['Indiana', 'IN'],
  ['Iowa', 'IA'],
  ['Kansas', 'KS'],
  ['Kentucky', 'KY'],
  ['Louisiana', 'LA'],
  ['Maine', 'ME'],
  ['Maryland', 'MD'],
  ['Massachusetts', 'MA'],
  ['Michigan', 'MI'],
  ['Minnesota', 'MN'],
  ['Mississippi', 'MS'],
  ['Missouri', 'MO'],
  ['Montana', 'MT'],
  ['Nebraska', 'NE'],
  ['Nevada', 'NV'],
  ['New Hampshire', 'NH'],
  ['New Jersey', 'NJ'],
  ['New Mexico', 'NM'],
  ['New York', 'NY'],
  ['North Carolina', 'NC'],
  ['North Dakota', 'ND'],
  ['Ohio', 'OH'],
  ['Oklahoma', 'OK'],
  ['Oregon', 'OR'],
  ['Pennsylvania', 'PA'],
  ['Rhode Island', 'RI'],
  ['South Carolina', 'SC'],
  ['South Dakota', 'SD'],
  ['Tennessee', 'TN'],
  ['Texas', 'TX'],
  ['Utah', 'UT'],
  ['Vermont', 'VT'],
  ['Virginia', 'VA'],
  ['Washington', 'WA'],
  ['West Virginia', 'WV'],
  ['Wisconsin', 'WI'],
  ['Wyoming', 'WY'],
  ['District of Columbia', 'DC'],
];

const COUNTRIES: [string, string[]][] = [
  ['United States', ['United States', 'USA', 'US']],
  ['Australia', ['Australia', 'AU']],
  ['United Kingdom', ['United Kingdom', 'UK', 'GB']],
  ['Canada', ['Canada', 'CAN']],
  ['Singapore', ['Singapore', 'SG']],
  ['India', ['India', 'IN']],
  ['New Zealand', ['New Zealand', 'NZ']],
  ['Ireland', ['Ireland', 'IE']],
];

/** The places a visitor can pick on the demo page, by name. */
export const STATE_NAMES: string[] = US_STATES.map(([name]) => name);
export const COUNTRY_NAMES: string[] = COUNTRIES.map(([name]) => name).filter((name) => name !== 'United States');

const keyOf = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const PLACES = new Map<string, Place>();
function addPlace(alias: string, place: Place): void {
  const key = keyOf(alias);
  // States go in first, so "IN" means Indiana; the country India is still recognised by name.
  if (!PLACES.has(key)) PLACES.set(key, place);
}
for (const [name, code] of US_STATES) {
  addPlace(name, { name, kind: 'state' });
  addPlace(code, { name, kind: 'state' });
}
for (const [name, aliases] of COUNTRIES) {
  for (const alias of aliases) addPlace(alias, { name, kind: name === 'United States' ? 'us' : 'country' });
}

/** The place name of each jurisdiction code that has its own adapters. */
export const JURISDICTION_NAME: Record<Jurisdiction, string> = {
  'US-FL': 'Florida',
  'US-CA': 'California',
  AU: 'Australia',
};

/**
 * The place a caller's wording names, or null. Accepts a state's name or code, a country's name or code, and a
 * trailing ", USA".
 */
export function placeOf(raw: string): Place | null {
  const bare = raw.replace(/,\s*(usa|us|united states)\s*$/i, '');
  return PLACES.get(keyOf(bare)) ?? null;
}

/** Regulators set up by statute that publish their register on a host with no government suffix. */
const UK_REGULATORS = ['gmc-uk.org', 'nmc.org.uk', 'gdc-uk.org', 'pharmacyregulation.org', 'hcpc-uk.org'];
const COUNTRY_HOSTS: Record<string, string[]> = {
  Australia: ['gov.au'],
  'United Kingdom': ['gov.uk', ...UK_REGULATORS],
  Singapore: ['gov.sg'],
  Canada: ['gc.ca', 'canada.ca'],
  India: ['gov.in', 'nic.in'],
  'New Zealand': ['govt.nz'],
  Ireland: ['gov.ie'],
};
/** Federal hosts carry no state's register. va.gov is Veterans Affairs, not Virginia. */
const US_FEDERAL = [
  'hhs.gov',
  'nih.gov',
  'cms.gov',
  'sec.gov',
  'fda.gov',
  'state.gov',
  'va.gov',
  'usa.gov',
  'ftc.gov',
  'irs.gov',
  'dol.gov',
  'cdc.gov',
  'ed.gov',
  'justice.gov',
  'usdoj.gov',
  'osha.gov',
  'sba.gov',
  'sam.gov',
  'uspto.gov',
  'ssa.gov',
  'dhs.gov',
  'faa.gov',
  'epa.gov',
  'medicare.gov',
  'healthcare.gov',
  'congress.gov',
  'whitehouse.gov',
  'loc.gov',
  'census.gov',
  'bls.gov',
];
/**
 * Official business registers that sit on a host with no government suffix. Florida's Division of Corporations
 * publishes its register on sunbiz.org, and Ireland's Companies Registration Office on cro.ie. They count only
 * for a company lookup.
 */
const COMPANY_REGISTER_HOSTS: Record<string, string[]> = { Florida: ['sunbiz.org'], Ireland: ['cro.ie'] };
const under = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

/**
 * The state a US government host names, or null when it names none. The longest state name inside a label
 * wins, so healthy.arkansas.gov is Arkansas and not Kansas. Failing that, a label that is a state code
 * counts: tx in state.tx.us, wa in lni.wa.gov.
 */
function stateOfHost(host: string): string | null {
  const labels = host.split('.').map((label) => label.replace(/-/g, ''));
  let named: string | null = null;
  for (const [name] of US_STATES) {
    if (labels.some((label) => label.includes(keyOf(name))) && (named === null || name.length > named.length))
      named = name;
  }
  if (named !== null) return named;
  const coded = US_STATES.find(([, code]) => labels.slice(0, -1).includes(code.toLowerCase()));
  return coded ? coded[0] : null;
}

/**
 * True when the link sits on a government host of the place asked about. A host that names another state,
 * a federal host, and every host with no government suffix are refused.
 */
export function isOfficialHost(url: string, place: Place, type: RecordType): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (type === 'company' && COMPANY_REGISTER_HOSTS[place.name]?.some((domain) => under(host, domain))) return true;
  if (place.kind === 'country') return COUNTRY_HOSTS[place.name]?.some((domain) => under(host, domain)) ?? false;
  if (place.kind !== 'state') return false;
  // Under .us only state.<code>.us is kept for a state's government, so a .us host must sit under the one
  // of the state asked. Any other .us name can be registered by anyone.
  if (host.endsWith('.us')) {
    const code = US_STATES.find(([name]) => name === place.name)?.[1].toLowerCase();
    return code !== undefined && under(host, `state.${code}.us`);
  }
  if (!host.endsWith('.gov')) return false;
  if (US_FEDERAL.some((domain) => under(host, domain))) return false;
  const state = stateOfHost(host);
  return state === null || state === place.name;
}

/**
 * What to ask the search for. A US state keeps companies with its Secretary of State; a country has one register.
 * Outside the US a regulator keeps a register of professionals, and licence wording returns US state boards first.
 */
export function searchWordings(place: Place, type: RecordType): string[] {
  if (type === 'company') {
    return [
      place.kind === 'country'
        ? `${place.name} company register search official`
        : `${place.name} business entity search secretary of state official`,
    ];
  }
  const licence = `${place.name} ${type} license lookup verify official`;
  return place.kind === 'country' ? [`${place.name} ${type} register check official`, licence] : [licence];
}
