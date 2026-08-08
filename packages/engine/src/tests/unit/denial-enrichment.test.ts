/**
 * A refusal is a fork in the road, not the end of one.
 *
 * The product answered `Forbidden: missing payroll:read permission` — English,
 * on a Romanian product, naming an internal concept, to someone from HR who
 * opened a page. It said what was absent and nothing about what to do, so the
 * reader could not tell a rule from a bug.
 *
 * Two rounds of security work made that worse before better: deny-by-default
 * and the tenant-isolation fix both made the system refuse correctly where it
 * used to wave things through, so more people meet the message more often.
 *
 * The enrichment lives in the HOST rather than in `permissionGate`, because the
 * gate ships inside every extension bundle: improving the sentence there would
 * mean repacking twenty-eight extensions, and the next improvement another
 * twenty-eight. The legacy shape is parsed for exactly that reason — an install
 * gets the better message before anything is rebuilt.
 */

import { describe, expect, it } from 'bun:test';
import { denialSentence } from '../../lib/tenancy/denial.js';

describe('what a refusal says', () => {
  it('separates a rule from an omission', () => {
    // "Payroll is confidential" is a decision somebody made, and the reader
    // should not feel accused by it. "You do not have access to invoices" is an
    // omission, and probably a mistake worth fixing. Same status code, and the
    // person needs to be able to tell them apart.
    const confidential = denialSentence({
      resource: 'payroll',
      action: 'read',
      confidential: true,
      canGrant: [{ name: 'Ana Popescu' }],
    });
    expect(confidential).toBe('payroll is confidential. Ana Popescu can give you access.');

    const missing = denialSentence({
      resource: 'invoices',
      action: 'read',
      confidential: false,
      canGrant: [{ name: 'Ana Popescu' }],
    });
    expect(missing).toBe('you do not have access to invoices. Ana Popescu can give you access.');
  });

  it('always ends with somewhere to go', () => {
    // Including when nobody holds an administrative role, which is the case a
    // naive implementation leaves as a bare "you cannot do this".
    const nobody = denialSentence({
      resource: 'payroll',
      action: 'read',
      confidential: true,
      canGrant: [],
    });
    expect(nobody).toContain('can grant it');
  });

  it('reads as a sentence when more than one person can help', () => {
    const two = denialSentence({
      resource: 'payroll',
      action: 'read',
      confidential: true,
      canGrant: [{ name: 'Ana' }, { name: 'Bogdan' }],
    });
    expect(two).toContain('Ana or Bogdan');
  });

  it('never mentions an internal permission string', () => {
    // The whole point. `payroll:read` is our vocabulary, not the reader's.
    const s = denialSentence({
      resource: 'payroll',
      action: 'read',
      confidential: true,
      canGrant: [{ name: 'Ana' }],
    });
    expect(s).not.toContain('payroll:read');
    expect(s).not.toContain('permission');
    expect(s).not.toContain('Forbidden');
  });
});
