import { describe, expect, it, spyOn } from 'bun:test';
import { assertProductionConfig, productionGuardViolations } from '../../lib/startup-guards.js';

/**
 * Every test below is about ONE control, so each supplies a cache and the
 * Valkey guard stays out of its way. Without this a test for the CORS guard
 * would also be asserting that no OTHER guard fires — which is how a suite ends
 * up failing for reasons unrelated to what it names.
 */
const CACHE = 'redis://:pw@cache:6379';
/**
 * The same reasoning as CACHE, one guard later: every case below is about ONE
 * control, so each supplies a base URL and the BETTER_AUTH_URL guard stays out
 * of its way.
 */
const BASE = 'https://app.example.com';

describe('productionGuardViolations', () => {
  it('refuses production with the extension auth gate disabled', () => {
    const v = productionGuardViolations({
      NODE_ENV: 'production',
      VALKEY_URL: CACHE,
      BETTER_AUTH_URL: BASE,
      ZVELTIO_EXT_AUTH_GATE: '0',
    });
    expect(v).toHaveLength(1);
    expect(v[0]!.variable).toBe('ZVELTIO_EXT_AUTH_GATE');
  });

  // The hatch has to keep working where it is meant to work, or it gets set
  // permanently in the deployment template to stop it being a nuisance.
  it.each(['development', 'test', undefined])('leaves NODE_ENV=%s alone', (NODE_ENV) => {
    expect(
      productionGuardViolations({
        NODE_ENV,
        VALKEY_URL: CACHE,
        BETTER_AUTH_URL: BASE,
        ZVELTIO_EXT_AUTH_GATE: '0',
      }),
    ).toEqual([]);
  });

  // `=== '0'` is the gate's own test, and this asserts the guard agrees with it
  // rather than with some looser idea of falsy — an env var is always a string,
  // and 'false' does NOT disable the gate.
  it.each(['1', 'false', '', 'no'])('does not fire on the non-disabling value %p', (value) => {
    expect(
      productionGuardViolations({
        NODE_ENV: 'production',
        VALKEY_URL: CACHE,
        BETTER_AUTH_URL: BASE,
        ZVELTIO_EXT_AUTH_GATE: value,
      }),
    ).toEqual([]);
  });

  it('refuses production with a wildcard CORS allowlist', () => {
    const v = productionGuardViolations({
      NODE_ENV: 'production',
      VALKEY_URL: CACHE,
      BETTER_AUTH_URL: BASE,
      CORS_ORIGINS: '*',
    });
    expect(v).toHaveLength(1);
    expect(v[0]!.variable).toBe('CORS_ORIGINS');
  });

  // `*` buried in a list is the same `*`. The WS check tests for membership,
  // not for the list being exactly one entry.
  it('finds the wildcard among real origins', () => {
    const v = productionGuardViolations({
      NODE_ENV: 'production',
      VALKEY_URL: CACHE,
      BETTER_AUTH_URL: BASE,
      CORS_ORIGINS: 'https://app.example.com, *, https://admin.example.com',
    });
    expect(v).toHaveLength(1);
  });

  // Unset is the normal self-hosted shape: CORS denies by default and only
  // trustedOrigins falls back. Failing it would block ordinary installs.
  it.each([undefined, '', 'https://app.example.com'])('accepts CORS_ORIGINS=%p', (CORS_ORIGINS) => {
    expect(
      productionGuardViolations({
        NODE_ENV: 'production',
        VALKEY_URL: CACHE,
        BETTER_AUTH_URL: BASE,
        CORS_ORIGINS,
      }),
    ).toEqual([]);
  });

  // "Clean" now INCLUDES a cache: the engine treats a missing Valkey as a
  // production misconfiguration, because every shipped install path provides one
  // and the fallbacks degrade security in silence.
  it('passes a clean production environment', () => {
    expect(
      productionGuardViolations({
        NODE_ENV: 'production',
        VALKEY_URL: CACHE,
        BETTER_AUTH_URL: BASE,
      }),
    ).toEqual([]);
  });

  // Unset does not fail anything — it rewrites every absolute URL the engine
  // emits, including the link in a password-reset mail, which then arrives well
  // formed and pointing at localhost.
  it('refuses production without a base URL', () => {
    const v = productionGuardViolations({ NODE_ENV: 'production', VALKEY_URL: CACHE });
    expect(v).toHaveLength(1);
    expect(v[0]!.variable).toBe('BETTER_AUTH_URL');
  });

  it('reports every violation at once', () => {
    const v = productionGuardViolations({
      NODE_ENV: 'production',
      VALKEY_URL: CACHE,
      BETTER_AUTH_URL: BASE,
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
        assertProductionConfig({
          NODE_ENV: 'production',
          VALKEY_URL: CACHE,
          BETTER_AUTH_URL: BASE,
          ZVELTIO_EXT_AUTH_GATE: '0',
        }),
      ).toThrow(/ZVELTIO_EXT_AUTH_GATE/);
    } finally {
      err.mockRestore();
    }
  });

  it('is silent when there is nothing to say', () => {
    expect(() =>
      assertProductionConfig({ NODE_ENV: 'production', VALKEY_URL: CACHE, BETTER_AUTH_URL: BASE }),
    ).not.toThrow();
  });
});

describe('Valkey is a requirement, not a preference', () => {
  // The engine was the ONLY place treating Valkey as optional. Everything that
  // ships it — docker-compose (`depends_on: cache: service_healthy`),
  // `.env.example` (`VALKEY_PASSWORD=  # REQUIRED`), and both installers, which
  // fall back apt → prebuilt binary → build from source rather than skip it —
  // already required it. These pin the two together.

  it('refuses to start in production without it', () => {
    const v = productionGuardViolations({ NODE_ENV: 'production' });
    expect(v.map((x) => x.variable)).toContain('VALKEY_URL');
  });

  it('says WHAT degrades, not just that something is missing', () => {
    // An operator who reads "VALKEY_URL unset" learns nothing actionable. The
    // reason it is fatal is that the fallbacks are silent: permission checks go
    // to the database per request and a revoked permission stays live on every
    // replica but one.
    const msg = productionGuardViolations({ NODE_ENV: 'production' }).find(
      (x) => x.variable === 'VALKEY_URL',
    )?.message;
    expect(msg).toContain('no cache');
    expect(msg).toContain('revoked permission');
    expect(msg).toContain('ZVELTIO_ALLOW_NO_CACHE');
    // And says what is NOT broken, so nobody chases realtime: it falls back to
    // Postgres LISTEN/NOTIFY, a documented backend rather than a loss.
    expect(msg).toContain('LISTEN/NOTIFY');
  });

  it('is satisfied by setting it', () => {
    const v = productionGuardViolations({
      NODE_ENV: 'production',
      VALKEY_URL: 'redis://:pw@cache:6379',
    });
    expect(v.map((x) => x.variable)).not.toContain('VALKEY_URL');
  });

  it('has an escape hatch, because some operator really will run without one', () => {
    // Deliberate and visible beats undocumented and silent: the hatch has to be
    // set on purpose, and it shows up in the environment for anyone auditing it.
    const v = productionGuardViolations({
      NODE_ENV: 'production',
      ZVELTIO_ALLOW_NO_CACHE: '1',
    });
    expect(v.map((x) => x.variable)).not.toContain('VALKEY_URL');
  });

  it('does not fire outside production', () => {
    // A development box with no Valkey is a normal thing to run, and blocking it
    // would only teach people to set the hatch permanently.
    expect(productionGuardViolations({ NODE_ENV: 'development' })).toEqual([]);
    expect(productionGuardViolations({})).toEqual([]);
  });
});
