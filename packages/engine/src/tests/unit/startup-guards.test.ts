import { describe, expect, it, spyOn } from 'bun:test';
import { assertProductionConfig, productionGuardViolations } from '../../lib/startup-guards.js';

describe('productionGuardViolations', () => {
  it('refuses production with the extension auth gate disabled', () => {
    const v = productionGuardViolations({
      NODE_ENV: 'production',
      ZVELTIO_EXT_AUTH_GATE: '0',
    });
    expect(v).toHaveLength(1);
    expect(v[0]!.variable).toBe('ZVELTIO_EXT_AUTH_GATE');
  });

  // The hatch has to keep working where it is meant to work, or it gets set
  // permanently in the deployment template to stop it being a nuisance.
  it.each(['development', 'test', undefined])('leaves NODE_ENV=%s alone', (NODE_ENV) => {
    expect(productionGuardViolations({ NODE_ENV, ZVELTIO_EXT_AUTH_GATE: '0' })).toEqual([]);
  });

  // `=== '0'` is the gate's own test, and this asserts the guard agrees with it
  // rather than with some looser idea of falsy — an env var is always a string,
  // and 'false' does NOT disable the gate.
  it.each(['1', 'false', '', 'no'])('does not fire on the non-disabling value %p', (value) => {
    expect(
      productionGuardViolations({ NODE_ENV: 'production', ZVELTIO_EXT_AUTH_GATE: value }),
    ).toEqual([]);
  });

  it('refuses production with a wildcard CORS allowlist', () => {
    const v = productionGuardViolations({ NODE_ENV: 'production', CORS_ORIGINS: '*' });
    expect(v).toHaveLength(1);
    expect(v[0]!.variable).toBe('CORS_ORIGINS');
  });

  // `*` buried in a list is the same `*`. The WS check tests for membership,
  // not for the list being exactly one entry.
  it('finds the wildcard among real origins', () => {
    const v = productionGuardViolations({
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://app.example.com, *, https://admin.example.com',
    });
    expect(v).toHaveLength(1);
  });

  // Unset is the normal self-hosted shape: CORS denies by default and only
  // trustedOrigins falls back. Failing it would block ordinary installs.
  it.each([undefined, '', 'https://app.example.com'])('accepts CORS_ORIGINS=%p', (CORS_ORIGINS) => {
    expect(productionGuardViolations({ NODE_ENV: 'production', CORS_ORIGINS })).toEqual([]);
  });

  it('passes a clean production environment', () => {
    expect(productionGuardViolations({ NODE_ENV: 'production' })).toEqual([]);
  });

  it('reports every violation at once', () => {
    const v = productionGuardViolations({
      NODE_ENV: 'production',
      ZVELTIO_EXT_AUTH_GATE: '0',
      CORS_ORIGINS: '*',
    });
    expect(v).toHaveLength(2);
    expect(v.map((x) => x.variable).sort()).toEqual(['CORS_ORIGINS', 'ZVELTIO_EXT_AUTH_GATE']);
  });
});

describe('assertProductionConfig', () => {
  it('throws, naming the variable, so the message survives a log tail', () => {
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() =>
        assertProductionConfig({ NODE_ENV: 'production', ZVELTIO_EXT_AUTH_GATE: '0' }),
      ).toThrow(/ZVELTIO_EXT_AUTH_GATE/);
    } finally {
      err.mockRestore();
    }
  });

  it('is silent when there is nothing to say', () => {
    expect(() => assertProductionConfig({ NODE_ENV: 'production' })).not.toThrow();
  });
});
