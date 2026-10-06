import { describe, expect, it } from 'vitest';
import { missingMessageKeys } from '../scripts/lib/paraglide-output.js';

/**
 * A compile whose plugin failed to load still exits 0 and writes an empty
 * module; this is the rule `check-paraglide-output.ts` fails the build on.
 */
describe('missingMessageKeys', () => {
  it('names every key an empty compile left out', () => {
    expect(missingMessageKeys(['common.save', 'nav.home'], {})).toEqual([
      'common.save',
      'nav.home',
    ]);
  });

  it('is empty when every key compiled to a function', () => {
    const compiled = { 'common.save': () => 'Save', 'nav.home': () => 'Home' };
    expect(missingMessageKeys(['common.save', 'nav.home'], compiled)).toEqual([]);
  });

  it('does not accept a key that compiled to something other than a function', () => {
    expect(missingMessageKeys(['common.save'], { 'common.save': 'Save' })).toEqual(['common.save']);
  });
});
