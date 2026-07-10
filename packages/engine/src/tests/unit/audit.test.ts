/**
 * Audit log writer (lib/audit.ts) — fire-and-forget INSERT into zv_audit_log.
 * Failures are swallowed (must never break the request). CannedDb drives both paths.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { auditLog } from '../../lib/audit.js';
import { CannedDb } from './fixtures/canned-db.js';

describe('auditLog', () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('writes an audit event via the sql template', async () => {
    const canned = new CannedDb();
    canned.when(/insert into zv_audit_log/i, []);
    const db = canned.kysely as unknown as Database;

    await auditLog(db, {
      type: 'auth.login_success',
      userId: 'u1',
      resourceId: 'r1',
      resourceType: 'session',
      metadata: { m: 1 },
      ip: '10.0.0.1',
    });

    const q = canned.executed(/insert into zv_audit_log/i)[0];
    expect(q).toBeDefined();
    expect(q!.parameters).toContain('auth.login_success');
    expect(q!.parameters).toContain('u1');
    expect(q!.parameters).toContain('10.0.0.1');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs and swallows DB errors without throwing', async () => {
    const canned = new CannedDb();
    canned.fail(/insert into zv_audit_log/i, new Error('disk full'));
    const db = canned.kysely as unknown as Database;

    await expect(
      auditLog(db, { type: 'permission.denied', userId: 'u1' }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
    const args = errorSpy.mock.calls[0] as unknown[];
    expect(String(args[0])).toContain('[Audit]');
    expect(String(args[1])).toBe('permission.denied');
  });
});
