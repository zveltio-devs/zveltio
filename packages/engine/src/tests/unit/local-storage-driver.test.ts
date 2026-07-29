/**
 * Local-filesystem storage driver (lib/storage/local-driver.ts) — the
 * zero-dependency default. Pure filesystem + HMAC-signing, no app boot.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalDriver,
  safeLocalPath,
  signKey,
  verifySignedKey,
} from '../../lib/storage/local-driver.js';

const TMP = mkdtempSync(join(tmpdir(), 'zv-storage-'));

describe('LocalDriver', () => {
  let driver: LocalDriver;

  beforeAll(() => {
    process.env.STORAGE_LOCAL_DIR = TMP;
    process.env.BETTER_AUTH_SECRET ||= 'test-secret-000000000000000000000000';
    process.env.BASE_URL = 'http://localhost:3000';
    driver = new LocalDriver();
  });

  afterAll(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('is always configured', () => {
    expect(driver.isConfigured()).toBe(true);
    expect(driver.kind).toBe('local');
  });

  it('put → get round-trips bytes + content-type', async () => {
    const bytes = new TextEncoder().encode('hello local storage');
    await driver.put('uploads/2026/a.txt', bytes, { contentType: 'text/plain' });
    const obj = await driver.get('uploads/2026/a.txt');
    expect(obj).not.toBeNull();
    expect(new TextDecoder().decode(obj!.bytes)).toBe('hello local storage');
    expect(obj!.contentType).toBe('text/plain');
    expect(obj!.size).toBe(bytes.length);
  });

  it('get returns null for a missing key', async () => {
    expect(await driver.get('nope/missing.bin')).toBeNull();
  });

  it('delete removes the object (idempotent)', async () => {
    await driver.put('uploads/del.txt', new Uint8Array([1, 2, 3]));
    expect(await driver.head('uploads/del.txt')).not.toBeNull();
    await driver.delete('uploads/del.txt');
    expect(await driver.get('uploads/del.txt')).toBeNull();
    await driver.delete('uploads/del.txt'); // second delete must not throw
  });

  it('rejects path traversal outside the root', () => {
    expect(() => safeLocalPath('../../etc/passwd')).toThrow();
    expect(() => safeLocalPath('uploads/../../../secret')).toThrow();
    // a normal nested key resolves fine
    expect(safeLocalPath('uploads/2026/a.txt')).toContain(TMP);
  });

  it('publicUrl points at the /files route', () => {
    expect(driver.publicUrl('uploads/a.txt')).toBe('http://localhost:3000/files/uploads/a.txt');
  });

  it('signedUrl carries a verifiable, expiring HMAC', async () => {
    const url = await driver.signedUrl('uploads/a.txt', 3600);
    const u = new URL(url);
    const exp = Number(u.searchParams.get('exp'));
    const sig = u.searchParams.get('sig')!;
    expect(verifySignedKey('uploads/a.txt', exp, sig)).toBe(true);
    // tampered key / sig / expiry all fail
    expect(verifySignedKey('uploads/OTHER.txt', exp, sig)).toBe(false);
    // Flip the last hex nibble to a guaranteed-different value. (A literal
    // "…0" tamper is a no-op ~6% of the time — when the HMAC already ends in
    // '0' — which made this test flaky across runs with different secrets.)
    const tampered = sig.slice(0, -1) + (sig.slice(-1) === '0' ? '1' : '0');
    expect(verifySignedKey('uploads/a.txt', exp, tampered)).toBe(false);
    expect(
      verifySignedKey(
        'uploads/a.txt',
        Math.floor(Date.now() / 1000) - 10,
        signKey('uploads/a.txt', 1),
      ),
    ).toBe(false);
  });
});
