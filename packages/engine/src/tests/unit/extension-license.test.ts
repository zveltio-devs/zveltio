/**
 * Extension license helpers (lib/extensions/extension-license.ts) — the pure
 * ones: fingerprintToken (audit-log correlation without storing the token) and
 * clientIp (x-forwarded-for / x-real-ip extraction). The DB read/write helpers
 * are covered by the marketplace integration tests.
 */

import { describe, it, expect } from 'bun:test';
import {
  clientIp,
  fingerprintToken,
  getLicenseKey,
  writeLicenseAudit,
} from '../../lib/extensions/extension-license.js';
import { CannedDb } from './fixtures/canned-db.js';

describe('fingerprintToken', () => {
  it('is a stable 16-char hex digest', async () => {
    const a = await fingerprintToken('secret-token');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await fingerprintToken('secret-token')).toBe(a); // deterministic
  });

  it('differs for different tokens', async () => {
    expect(await fingerprintToken('token-a')).not.toBe(await fingerprintToken('token-b'));
  });
});

describe('clientIp', () => {
  const ctx = (headers: Record<string, string>) => ({
    req: { header: (k: string) => headers[k.toLowerCase()] },
  });

  it('takes the first entry of x-forwarded-for', () => {
    expect(clientIp(ctx({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe('203.0.113.7');
  });

  it('trims whitespace around the forwarded IP', () => {
    expect(clientIp(ctx({ 'x-forwarded-for': '  198.51.100.2  , 10.0.0.1' }))).toBe('198.51.100.2');
  });

  it('falls back to x-real-ip when no forwarded header', () => {
    expect(clientIp(ctx({ 'x-real-ip': '192.0.2.9' }))).toBe('192.0.2.9');
  });

  it('returns null when neither header is present', () => {
    expect(clientIp(ctx({}))).toBeNull();
  });
});

describe('getLicenseKey', () => {
  it('reads the per-extension license key from zv_settings', async () => {
    const db = new CannedDb();
    db.when(/FROM "zv_settings"/i, [{ value: 'lic-abc-123' }]);
    expect(await getLicenseKey(db.kysely, 'paid-ext')).toBe('lic-abc-123');
  });

  it('returns undefined when no row exists', async () => {
    const db = new CannedDb();
    db.when(/FROM "zv_settings"/i, []);
    expect(await getLicenseKey(db.kysely, 'free-ext')).toBeUndefined();
  });

  it('returns undefined when the settings query fails', async () => {
    const db = new CannedDb();
    db.fail(/FROM "zv_settings"/i, new Error('db down'));
    expect(await getLicenseKey(db.kysely, 'x')).toBeUndefined();
  });
});

describe('writeLicenseAudit', () => {
  it('inserts an audit row with stringified details', async () => {
    const db = new CannedDb();
    db.when(/INSERT INTO "zv_license_audit"/i, []);
    await writeLicenseAudit(db.kysely, {
      action: 'rotate',
      extension_name: 'my-ext',
      performed_by: 'u1',
      ip: '203.0.113.1',
      user_agent: 'test-agent',
      details: { fingerprint: 'abc' },
    });
    const insert = db.executed(/INSERT INTO "zv_license_audit"/i)[0]!;
    expect(insert.parameters).toContain('rotate');
    expect(insert.parameters).toContain('my-ext');
  });

  it('swallows insert failures without throwing', async () => {
    const db = new CannedDb();
    db.fail(/INSERT INTO "zv_license_audit"/i, new Error('write failed'));
    await expect(
      writeLicenseAudit(db.kysely, {
        action: 'delete',
        extension_name: null,
        performed_by: null,
        ip: null,
        user_agent: null,
      }),
    ).resolves.toBeUndefined();
  });
});
