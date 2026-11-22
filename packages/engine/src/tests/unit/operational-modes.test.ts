import { describe, expect, test } from 'bun:test';
import type { Database } from '../../db/index.js';
import { MODES, modeValue, operationalModeWarnings } from '../../lib/operational-modes.js';
import { healthRoutes } from '../../routes/health.js';

// ADR 0058 d4: one register, warned at every boot; the removed variables weaken nothing.
describe('operational-mode register', () => {
  test('a hardened environment warns about nothing', () => {
    expect(operationalModeWarnings({ NODE_ENV: 'production' })).toEqual([]);
  });

  test('warns for each mode that is on, by its weakening value only', () => {
    const lines = operationalModeWarnings({
      NODE_ENV: 'production',
      ZVELTIO_FAIL_CLOSED_TENANT: '0',
      REQUIRE_EXTENSION_SIGNATURES: 'true',
      ZVELTIO_EXT_TRANSPORT: 'runner',
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ZVELTIO_FAIL_CLOSED_TENANT=0');
    expect(operationalModeWarnings({})).toEqual([]); // unset is production (ADR 0058)
    expect(operationalModeWarnings({ NODE_ENV: 'development' })).toEqual([
      expect.stringContaining('NODE_ENV=development'),
    ]);
  });

  test('a removed variable still set is named as removed', () => {
    const lines = operationalModeWarnings({
      NODE_ENV: 'production',
      ZVELTIO_COLLECTION_RLS_EXEMPT: 'crm',
      ZVELTIO_ALLOW_UNENFORCED_RLS: '1',
      DEMO_MODE_ALLOW_IN_PROD: 'true',
    });
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l).toContain('removed (ADR 0058) and has no effect');
    // ADR 0056 amendment 2026-11-18: no unsigned mode.
    expect(operationalModeWarnings({ REQUIRE_EXTENSION_SIGNATURES: 'false' })).toEqual([
      expect.stringContaining('removed (ADR 0056) and has no effect'),
    ]);
  });

  test('every entry names what it weakens, a class and a removal', () => {
    for (const m of Object.values(MODES)) {
      expect(m.weakens.length).toBeGreaterThan(10);
      expect(m.removal.length).toBeGreaterThan(0);
    }
  });

  // It lifts the admin gate on /api/openapi.json in production: a hatch, so registered.
  test('OPENAPI_PUBLIC=true is a mode the boot warns about', () => {
    expect(operationalModeWarnings({ OPENAPI_PUBLIC: 'true' })).toEqual([
      expect.stringContaining('OPENAPI_PUBLIC=true'),
    ]);
  });

  test('modeValue reads the environment it is given', () => {
    expect(modeValue('ZVELTIO_SINGLE_INSTANCE', { ZVELTIO_SINGLE_INSTANCE: '1' })).toBe('1');
  });

  test('DEMO_MODE_ALLOW_IN_PROD no longer publishes the demo credentials in production', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, {
      NODE_ENV: 'production',
      DEMO_MODE: 'true',
      DEMO_MODE_ALLOW_IN_PROD: 'true',
    });
    try {
      const failing = {
        selectFrom: () => {
          throw new Error('no database');
        },
      } as unknown as Database;
      const body = (await (await healthRoutes(failing).request('/')).json()) as {
        demo_mode: boolean;
        demo_credentials?: unknown;
      };
      expect(body.demo_mode).toBe(true);
      expect(body.demo_credentials).toBeUndefined();
    } finally {
      for (const k of ['NODE_ENV', 'DEMO_MODE', 'DEMO_MODE_ALLOW_IN_PROD']) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});
