/**
 * buildExtensionInternals helper wiring (lib/extensions/internals.ts).
 */

import { describe, expect, it } from 'bun:test';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';

describe('buildExtensionInternals helpers', () => {
  const internals = buildExtensionInternals();

  it('invalidateRulesCache is callable without throwing', () => {
    expect(() => internals.invalidateRulesCache('contacts')).not.toThrow();
  });
});
