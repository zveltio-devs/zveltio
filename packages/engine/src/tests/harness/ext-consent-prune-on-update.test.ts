/**
 * A new manifest prunes the consent to what it still declares (owner decision
 * 2026-11-08, ADR 0026 amendment).
 *
 * Before: a capability, static egress or slot binding that version N+1 stopped
 * declaring stayed in `granted_capabilities`, and N+2 declaring it again
 * inherited the approval given to N's code, with nobody asked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { recordManifest } from '../../lib/tenancy/resource-grants.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const NAME = `cprune${Date.now() % 1_000_000}`;
const NONE = `${NAME}n`;

const full = {
  permissions: ['data:system'],
  jobs: [{ name: 'call', egress: ['a.example.com'], egressSlots: ['api'] }],
};
const GRANTED = ['data:system', 'egress:a.example.com', 'egress:api=api.example.com'];

d('consent on a new manifest', () => {
  let db: Database;
  let dir: string;

  const write = (name: string, version: string, body: object) => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'manifest.json'), JSON.stringify({ name, version, ...body }));
    return recordManifest(db, name, join(dir, name));
  };
  const granted = async (name: string) => {
    const v = (
      await sql<{ g: unknown }>`SELECT granted_capabilities AS g FROM zv_extension_registry
                                 WHERE name = ${name} AND tenant_id IS NULL`.execute(db)
    ).rows[0]?.g;
    return typeof v === 'string' ? JSON.parse(v) : v;
  };
  const grant = (name: string, caps: string[]) =>
    sql`UPDATE zv_extension_registry SET granted_capabilities = ${JSON.stringify(caps)}::text::jsonb
         WHERE name = ${name}`.execute(db);

  beforeAll(async () => {
    ({ db } = await getTestApp());
    dir = mkdtempSync(join(tmpdir(), 'cprune-'));
    for (const n of [NAME, NONE]) {
      await sql`INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
                VALUES (${n}, ${n}, NULL, true, false)`.execute(db);
    }
  });

  afterAll(async () => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (!db) return;
    await sql`DELETE FROM zv_extension_registry WHERE name IN (${NAME}, ${NONE})`.execute(db);
    await sql`DELETE FROM zv_audit_log WHERE resource_id IN (${NAME}, ${NONE})`.execute(db);
  });

  it('keeps the consent when the first manifest is recorded, and when it is recorded again', async () => {
    expect(await write(NAME, '1.0.0', full)).toBe(true);
    await grant(NAME, GRANTED);
    expect(await write(NAME, '1.0.0', full)).toBe(true);
    expect(await granted(NAME)).toEqual(GRANTED);
  });

  it('drops what a new version no longer declares, slot bindings included, and audits it', async () => {
    expect(
      await write(NAME, '1.1.0', { permissions: ['data:system'], jobs: [{ name: 'call' }] }),
    ).toBe(true);
    expect(await granted(NAME)).toEqual(['data:system']);
    const audit = (
      await sql<{ metadata: unknown }>`SELECT metadata FROM zv_audit_log
        WHERE event_type = 'extension.capabilities.pruned' AND resource_id = ${NAME}`.execute(db)
    ).rows;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]?.metadata)).toContain('egress:api=api.example.com');
  });

  it('does not hand the dropped approvals back to a version that declares them again', async () => {
    expect(await write(NAME, '1.2.0', full)).toBe(true);
    expect(await granted(NAME)).toEqual(['data:system']);
  });

  it('leaves an install with no consent on record alone', async () => {
    expect(await write(NONE, '1.0.0', full)).toBe(true);
    expect(await write(NONE, '1.1.0', { jobs: [] })).toBe(true);
    expect(await granted(NONE)).toBeNull();
  });
});
