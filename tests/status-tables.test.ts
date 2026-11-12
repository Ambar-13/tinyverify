import { describe, expect, it } from 'vitest';
import { STATUS_TABLES, statusFor } from '../src/registries/status-tables';

describe('status lookup hardening', () => {
  it('never reads an inherited property for a wording', () => {
    for (const registry of ['fl-mqa', 'fl-dbpr', 'ca-cslb'] as const) {
      for (const word of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
        expect(statusFor(registry, word), `${registry} ${word}`).toBe('other');
      }
    }
  });

  it('keeps the tables free of inherited keys', () => {
    expect(Object.getPrototypeOf(STATUS_TABLES['fl-mqa'])).toBeNull();
    expect(Object.getPrototypeOf(STATUS_TABLES['fl-dbpr'])).toBeNull();
  });

  it('maps an unlisted Obligations wording by its adverse term', () => {
    expect(statusFor('fl-mqa', 'Obligations/Suspended')).toBe('suspended');
  });

  it('maps a wording with no table entry and no adverse term to other', () => {
    expect(statusFor('fl-mqa', 'Totally new wording')).toBe('other');
    expect(statusFor('fl-dbpr', 'Totally new wording')).toBe('other');
  });

  it('applies the adverse terms in order, so the first matching term wins', () => {
    expect(statusFor('fl-mqa', 'Null and void, revoked')).toBe('inactive');
    expect(statusFor('fl-mqa', 'Revoked and suspended')).toBe('revoked');
    expect(statusFor('fl-mqa', 'Expired on probation')).toBe('probation');
  });

  it('never maps a wording to active by substring', () => {
    expect(statusFor('fl-mqa', 'Inactive clear/active notice')).toBe('other');
    expect(statusFor('fl-dbpr', 'Current,Active notice, revoked later')).toBe('revoked');
    expect(statusFor('fl-dbpr', 'Something active')).toBe('other');
  });

  it('keeps the CSLB longest-prefix rule', () => {
    expect(statusFor('ca-cslb', 'This license is current and inactive effective today')).toBe('inactive');
    expect(statusFor('ca-cslb', 'This license is current and active')).toBe('active');
  });
  it('ignores spacing and letter case in a wording', () => {
    for (const w of ['Current, Active', 'current,active', '  Current ,  Active ', 'CURRENT , ACTIVE']) {
      expect(statusFor('fl-dbpr', w), w).toBe('active');
    }
    expect(statusFor('fl-mqa', 'Clear / Active')).toBe('active');
  });

  it('keeps an adverse wording adverse when the spacing is odd', () => {
    expect(statusFor('fl-dbpr', ' Delinquent ,  Active')).toBe('delinquent');
    expect(statusFor('fl-dbpr', 'revoked , inactive')).toBe('revoked');
    expect(statusFor('fl-dbpr', 'Suspended,  Inactive')).toBe('suspended');
  });

  it('never maps an unknown wording with odd spacing to active', () => {
    expect(statusFor('fl-dbpr', 'Current , Maybe')).toBe('other');
    expect(statusFor('fl-dbpr', 'Not Current, Active')).not.toBe('active');
  });
});
