import { describe, expect, it } from 'vitest';
import { tryGetAdapter } from '../src/registries';
import {
  formatCheck,
  normaliseLicenceNumber,
  normaliseRecordType,
  parseJurisdiction,
  registries,
  routesFor,
} from '../src/registries/catalog';

describe('normaliseRecordType', () => {
  it('maps the brief examples', () => {
    expect(normaliseRecordType('MD')).toBe('physician');
    expect(normaliseRecordType('registered nurse')).toBe('nurse');
    expect(normaliseRecordType('General Contractor')).toBe('contractor');
    expect(normaliseRecordType('astronaut')).toBe(null);
  });

  it('ignores case, whitespace and punctuation', () => {
    expect(normaliseRecordType('  M.D. ')).toBe('physician');
    expect(normaliseRecordType('Registered   Nurse')).toBe('nurse');
    expect(normaliseRecordType('D.D.S.')).toBe('dentist');
  });

  it('maps the physician synonyms', () => {
    for (const s of [
      'physician',
      'doctor',
      'md',
      'medical doctor',
      'gp',
      'general practitioner',
      'osteopathic physician',
      'do',
      'medical practitioner',
    ]) {
      expect(normaliseRecordType(s), s).toBe('physician');
    }
  });

  it('maps the dentist synonyms', () => {
    for (const s of ['dentist', 'dds', 'dmd', 'dental practitioner']) {
      expect(normaliseRecordType(s), s).toBe('dentist');
    }
  });

  it('maps the nurse synonyms', () => {
    for (const s of ['nurse', 'rn', 'registered nurse', 'lpn', 'licensed practical nurse', 'enrolled nurse']) {
      expect(normaliseRecordType(s), s).toBe('nurse');
    }
  });

  it('maps the pharmacist synonyms', () => {
    for (const s of ['pharmacist', 'pharmacy']) {
      expect(normaliseRecordType(s), s).toBe('pharmacist');
    }
  });

  it('maps the contractor synonyms', () => {
    for (const s of [
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
    ]) {
      expect(normaliseRecordType(s), s).toBe('contractor');
    }
  });
});

describe('parseJurisdiction', () => {
  it('maps the brief examples', () => {
    expect(parseJurisdiction('Queensland')).toBe('AU');
    expect(parseJurisdiction('fl')).toBe('US-FL');
    expect(parseJurisdiction('Miami')).toBe(null);
    expect(parseJurisdiction('USA')).toBe(null);
  });

  it('maps Florida inputs to US-FL', () => {
    for (const s of ['US-FL', 'us-fl', 'FL', 'Florida', 'florida, usa']) {
      expect(parseJurisdiction(s), s).toBe('US-FL');
    }
  });

  it('accepts a trailing country name after a supported name', () => {
    expect(parseJurisdiction('California, USA')).toBe('US-CA');
    expect(parseJurisdiction('California, US')).toBe('US-CA');
    expect(parseJurisdiction('California, United States')).toBe('US-CA');
    expect(parseJurisdiction('Queensland, Australia')).toBe('AU');
    expect(parseJurisdiction('Florida, United States')).toBe('US-FL');
    expect(parseJurisdiction('Miami, USA')).toBe(null);
    expect(parseJurisdiction('USA')).toBe(null);
  });

  it('maps California inputs to US-CA and never Canada', () => {
    for (const s of ['US-CA', 'us-ca', 'CA', 'California']) {
      expect(parseJurisdiction(s), s).toBe('US-CA');
    }
    expect(parseJurisdiction('Canada')).toBe(null);
  });

  it('maps Australia and every state or territory to AU', () => {
    for (const s of [
      'AU',
      'au',
      'aus',
      'Australia',
      'NSW',
      'New South Wales',
      'VIC',
      'Victoria',
      'QLD',
      'Queensland',
      'WA',
      'Western Australia',
      'SA',
      'South Australia',
      'TAS',
      'Tasmania',
      'ACT',
      'Australian Capital Territory',
      'NT',
      'Northern Territory',
    ]) {
      expect(parseJurisdiction(s), s).toBe('AU');
    }
  });

  it('returns null for cities and countries that are not supported', () => {
    for (const s of ['United States', 'New York', 'Sydney', 'Ontario']) {
      expect(parseJurisdiction(s), s).toBe(null);
    }
  });
});

describe('routesFor', () => {
  it('returns the Florida contractor registry for contractors in US-FL', () => {
    expect(routesFor('contractor', 'US-FL').map((r) => r.id)).toEqual(['fl-dbpr']);
  });

  it('returns nothing when no registry covers the pair', () => {
    expect(routesFor('nurse', 'US-CA')).toEqual([]);
  });

  it('returns every registry that covers a pair', () => {
    expect(routesFor('nurse', 'US-FL').map((r) => r.id)).toEqual(['fl-mqa']);
    expect(routesFor('physician', 'AU').map((r) => r.id)).toEqual(['au-ahpra']);
    expect(routesFor('contractor', 'US-CA').map((r) => r.id)).toEqual(['ca-cslb']);
  });
});

describe('support table', () => {
  it('lists the four registries with their fields', () => {
    expect(registries).toEqual([
      {
        id: 'fl-mqa',
        name: 'Florida Department of Health, MQA licence verification',
        jurisdiction: 'US-FL',
        types: ['physician', 'dentist', 'nurse', 'pharmacist'],
        url: 'https://mqa-internet.doh.state.fl.us/MQASearchServices/HealthCareProviders',
        read_route: 'fetch',
        watch_tier: 'monitor',
        connected: true,
      },
      {
        id: 'fl-dbpr',
        name: 'Florida Department of Business and Professional Regulation',
        jurisdiction: 'US-FL',
        types: ['contractor'],
        url: 'https://www.myfloridalicense.com/wl11.asp?mode=0&SID=',
        read_route: 'fetch',
        watch_tier: 'monitor',
        connected: true,
      },
      {
        id: 'ca-cslb',
        name: 'California Contractors State License Board',
        jurisdiction: 'US-CA',
        types: ['contractor'],
        url: 'https://www.cslb.ca.gov/OnlineServices/CheckLicenseII/CheckLicense.aspx',
        read_route: 'agent',
        watch_tier: 'recheck',
        connected: true,
      },
      {
        id: 'au-ahpra',
        name: 'Australian Health Practitioner Regulation Agency public register',
        jurisdiction: 'AU',
        types: ['physician', 'dentist', 'nurse', 'pharmacist'],
        url: 'https://www.ahpra.gov.au/Registration/Registers-of-Practitioners.aspx',
        read_route: 'agent',
        watch_tier: 'recheck',
        connected: false,
      },
    ]);
  });

  it('flags a registry connected exactly when an adapter is registered for it', () => {
    for (const r of registries) expect(r.connected, r.id).toBe(tryGetAdapter(r.id) !== undefined);
  });

  it('keeps the Ahpra row in the table, flagged not connected', () => {
    const ahpra = registries.find((r) => r.id === 'au-ahpra');
    expect(ahpra?.connected).toBe(false);
    expect(tryGetAdapter('au-ahpra')).toBeUndefined();
  });

  it('carries the connected flag when a row is copied or sent as JSON', () => {
    const mqa = registries.find((r) => r.id === 'fl-mqa');
    expect({ ...mqa }.connected).toBe(true);
    expect((JSON.parse(JSON.stringify(mqa)) as { connected: boolean }).connected).toBe(true);
  });
});

describe('normaliseLicenceNumber', () => {
  it('trims, removes inner spaces and upper-cases', () => {
    expect(normaliseLicenceNumber(' ccc0000000 ')).toBe('CCC0000000');
    expect(normaliseLicenceNumber('me 000000')).toBe('ME000000');
  });
});

describe('formatCheck', () => {
  it('rejects CSLB numbers that are not digits', () => {
    const message = formatCheck('ca-cslb', 'ABC-12345');
    expect(message).not.toBeNull();
    expect(message).toContain('digits');
    expect(message).toBe('CSLB licence numbers are digits only, up to 8 digits');
  });

  it('rejects CSLB numbers longer than 8 digits', () => {
    expect(formatCheck('ca-cslb', '123456789')).not.toBeNull();
  });

  it('accepts CSLB numbers of 1 to 8 digits', () => {
    expect(formatCheck('ca-cslb', '1234567')).toBe(null);
    expect(formatCheck('ca-cslb', '7')).toBe(null);
  });

  it('accepts Florida health numbers with a two, three or four letter prefix', () => {
    expect(formatCheck('fl-mqa', 'me 000000')).toBe(null);
    expect(formatCheck('fl-mqa', 'ABC12345')).toBe(null);
    expect(formatCheck('fl-mqa', 'APRN0000001')).toBe(null);
    expect(formatCheck('fl-mqa', ' aprn 0000001 ')).toBe(null);
  });

  it('rejects a Florida health prefix of one letter or five letters', () => {
    expect(formatCheck('fl-mqa', 'M000000')).not.toBeNull();
    expect(formatCheck('fl-mqa', 'APRNS0000001')).not.toBeNull();
  });

  it('rejects Florida health numbers without the prefix shape', () => {
    expect(formatCheck('fl-mqa', '000000')).toBe(
      'Florida health licence numbers are a two to four letter profession prefix followed by digits, for example ME000000 or APRN0000000',
    );
    expect(formatCheck('fl-mqa', 'MEDICAL1')).not.toBeNull();
  });

  it('has no format rule for registries without a published one', () => {
    expect(formatCheck('fl-dbpr', 'ANY-99')).toBe(null);
    expect(formatCheck('au-ahpra', 'ANY-99')).toBe(null);
  });
});
