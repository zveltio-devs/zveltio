/**
 * The external anchor of each chain's head (ADR 0060 decision 5).
 *
 * Before it, deleting a chain's newest rows together with their chain entries
 * left a shorter chain that verified: nothing outside the database remembered
 * the head. The anchor writes every chain's head and genesis to a target the
 * database cannot reach, one new file per write, and verify compares.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { _settleAuditWrites, type AuditEventType, verifyAuditChains } from '../../lib/audit.js';
import { anchorAuditChains } from '../../lib/audit-anchor.js';
import { asAuditOwner, asTenant, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TAG = `auditanchor-${crypto.randomUUID().slice(0, 8)}`;
const EV = `${TAG}.event` as AuditEventType;
const T = { tail: crypto.randomUUID(), cut: crypto.randomUUID(), off: crypto.randomUUID() };
const ENV = 'AUDIT_ANCHOR_TARGET';

d('external anchor of the audit chain heads (ADR 0060 decision 5)', () => {
  let db: Database;
  let dir: string;

  const write = (tenant: string, resourceId: string, ageDays = 0) =>
    asTenant(db, tenant, (trx) =>
      sql`INSERT INTO zv_audit_log (event_type, resource_id, tenant_id, created_at)
          VALUES (${EV}, ${resourceId}, ${tenant}::uuid,
                  now() - make_interval(days => ${ageDays}::int))`.execute(trx),
    );
  /** What an owner with the triggers off does: the newest rows and their entries go together. */
  const cutTail = (tenant: string, fromSeq: number) =>
    asAuditOwner(db, async (trx) => {
      await sql`DELETE FROM zv_audit_log WHERE id IN (
                  SELECT audit_id FROM zv_audit_chain
                   WHERE tenant_id = ${tenant}::uuid AND seq >= ${fromSeq})`.execute(trx);
      await sql`ALTER TABLE zv_audit_chain DISABLE TRIGGER zv_audit_chain_append_only`.execute(trx);
      await sql`DELETE FROM zv_audit_chain
                 WHERE tenant_id = ${tenant}::uuid AND seq >= ${fromSeq}`.execute(trx);
      await sql`ALTER TABLE zv_audit_chain ENABLE TRIGGER zv_audit_chain_append_only`.execute(trx);
    });
  const anchorOf = async (tenant: string) => {
    const r = await verifyAuditChains(db);
    const a = r.anchor;
    return { ok: r.ok, chain: 'chains' in a ? a.chains.find((c) => c.tenant_id === tenant) : null };
  };

  beforeAll(async () => {
    ({ db } = await getTestApp());
    dir = await mkdtemp(join(tmpdir(), 'zv-anchor-'));
    for (const id of Object.values(T)) {
      await sql`INSERT INTO zv_tenants (id, slug, name, status)
                VALUES (${id}::uuid, ${`${TAG}-${id.slice(0, 8)}`}, ${TAG}, 'active')`.execute(db);
    }
  });

  afterEach(() => {
    process.env[ENV] = dir;
  });

  afterAll(async () => {
    delete process.env[ENV];
    if (!db) return;
    await _settleAuditWrites();
    const ids = Object.values(T);
    await asAuditOwner(db, async (trx) => {
      await sql`DELETE FROM zv_audit_log WHERE event_type LIKE ${`${TAG}%`}`.execute(trx);
      for (const t of ['zv_audit_chain', 'zv_audit_chain_cut']) {
        const trigger = `${t}_append_only`;
        await sql.raw(`ALTER TABLE ${t} DISABLE TRIGGER ${trigger}`).execute(trx);
        await sql`DELETE FROM ${sql.table(t)} WHERE tenant_id = ANY(${ids}::uuid[])`.execute(trx);
        await sql.raw(`ALTER TABLE ${t} ENABLE TRIGGER ${trigger}`).execute(trx);
      }
    });
    await sql`DELETE FROM zv_tenants WHERE id = ANY(${ids}::uuid[])`.execute(db);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('a tail cut with its chain entries is behind the anchor; a chain rewritten past it is changed', async () => {
    process.env[ENV] = dir;
    for (const r of ['a', 'b', 'c']) await write(T.tail, r);
    expect((await anchorAuditChains(db)).written).toBe(true);
    expect((await anchorOf(T.tail)).chain?.status).toBe('ok');

    await cutTail(T.tail, 2);
    const report = await verifyAuditChains(db);
    // The chain alone still verifies: that is the defect the anchor closes.
    expect(report.chains.find((c) => c.tenant_id === T.tail)?.ok).toBe(true);
    expect(report.ok).toBe(false);
    expect((await anchorOf(T.tail)).chain).toMatchObject({
      status: 'behind',
      anchored: { seq: 3 },
    });

    // The next anchor does not launder the cut: it carries the old head forward.
    expect((await anchorAuditChains(db)).written).toBe(true);
    expect((await anchorOf(T.tail)).chain).toMatchObject({
      status: 'behind',
      anchored: { seq: 3 },
    });

    for (const r of ['x', 'y', 'z']) await write(T.tail, r);
    expect((await anchorOf(T.tail)).chain?.status).toBe('changed');
  });

  it('every write is a new file, and none is rewritten', async () => {
    process.env[ENV] = dir;
    const before = await readdir(dir);
    const first = await readFile(join(dir, before.sort()[0] as string), 'utf8');
    await anchorAuditChains(db);
    const after = await readdir(dir);
    expect(after.length).toBe(before.length + 1);
    expect(await readFile(join(dir, before.sort()[0] as string), 'utf8')).toBe(first);
    const body = JSON.parse(first) as { v: number; at: string; chains: unknown[] };
    expect(body.v).toBe(1);
    expect(Object.keys(body.chains[0] as object).sort()).toEqual(['genesis', 'head', 'tenant_id']);
  });

  it('a retention cut past the anchored head is covered, not a break', async () => {
    process.env[ENV] = dir;
    await write(T.cut, 'a', 40);
    await anchorAuditChains(db);
    await write(T.cut, 'b', 40);
    await write(T.cut, 'c');
    process.env.AUDIT_LOG_RETENTION_TENANT_DAYS = `${T.cut}=20`;
    try {
      const { runGarbageCollector } = await import('../../lib/runtime/garbage-collector.js');
      await runGarbageCollector(db);
    } finally {
      delete process.env.AUDIT_LOG_RETENTION_TENANT_DAYS;
    }
    expect((await anchorOf(T.cut)).chain?.status).toBe('covered');
  });

  it('unset, verify says the anchor is not configured; malformed, verify fails', async () => {
    await write(T.off, 'a');
    delete process.env[ENV];
    expect((await verifyAuditChains(db)).anchor).toEqual({ configured: false });
    expect((await anchorAuditChains(db)).written).toBe(false);

    process.env[ENV] = 'relative/dir';
    const r = await verifyAuditChains(db);
    expect(r.ok).toBe(false);
    expect(r.anchor).toMatchObject({ configured: true, error: expect.any(String) });
  });
});
