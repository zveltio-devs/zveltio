/**
 * The external anchor of each chain's head (ADR 0060 decision 5).
 *
 * Before it, deleting a chain's newest rows together with their chain entries
 * left a shorter chain that verified: nothing outside the database remembered
 * the head. The anchor writes every chain's head and genesis to a target the
 * database cannot reach, one new file per write, and verify compares.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, setSystemTime } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
const T = {
  tail: crypto.randomUUID(),
  cut: crypto.randomUUID(),
  off: crypto.randomUUID(),
  forged: crypto.randomUUID(),
  replaced: crypto.randomUUID(),
};
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

  it('a newer anchor added by whoever holds the anchor credentials does not hide a cut', async () => {
    const own = await mkdtemp(join(tmpdir(), 'zv-anchor-forged-'));
    try {
      process.env[ENV] = own;
      const tenant = T.forged;
      for (const r of ['a', 'b', 'c']) await write(tenant, r);
      await anchorAuditChains(db);
      await cutTail(tenant, 2);
      // Well formed and named as the writer names it, dated after every anchor
      // the engine wrote; it names no chain, then the cut one, then a regrown one.
      let ms = Date.now() + 60_000;
      const forge = async (chains: unknown[]) => {
        ms += 1000;
        const name = `zveltio-audit-anchor-${String(9_999_999_999_999 - ms).padStart(13, '0')}-${new Date(ms).toISOString().replace(/[-:.]/g, '')}.json`;
        await writeFile(
          join(own, name),
          `${JSON.stringify({ v: 1, at: new Date(ms).toISOString(), chains })}\n`,
        );
      };
      const headOf = async () =>
        (
          await asAuditOwner(db, (trx) =>
            sql<{ seq: number; hash: string }>`
              SELECT seq::int AS seq, encode(hash, 'hex') AS hash FROM zv_audit_chain
               WHERE tenant_id = ${tenant}::uuid ORDER BY seq DESC LIMIT 1`.execute(trx),
          )
        ).rows[0];
      const held = async (status: string) =>
        expect((await anchorOf(tenant)).chain).toMatchObject({ status, anchored: { seq: 3 } });

      await forge([]);
      await held('behind');
      await forge([{ tenant_id: tenant, head: await headOf(), genesis: null }]);
      await held('behind');
      // The writer reads the newest anchor only; what it writes next still cannot hide the cut.
      await anchorAuditChains(db);
      await held('behind');
      // Regrown past the cut and anchored higher: the older anchor still judges seq 3.
      for (const r of ['x', 'y', 'z']) await write(tenant, r);
      await forge([{ tenant_id: tenant, head: await headOf(), genesis: null }]);
      await held('changed');

      // A file not named for its own date is not an anchor the engine wrote.
      await writeFile(join(own, 'zveltio-audit-anchor-0000000000000-x.json'), '{"v":1}\n');
      expect((await verifyAuditChains(db)).anchor).toMatchObject({ error: expect.any(String) });
    } finally {
      await rm(own, { recursive: true, force: true });
    }
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
  it('a configured target holding no anchor fails verify until the first write', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'zv-anchor-empty-'));
    try {
      process.env[ENV] = empty;
      const r = await verifyAuditChains(db);
      expect(r.anchor).toMatchObject({ configured: true, missing: true });
      expect(r.ok).toBe(false);
      await anchorAuditChains(db);
      expect((await verifyAuditChains(db)).anchor).not.toHaveProperty('missing');
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('a target directory that does not exist is an error, never created', async () => {
    const absent = join(dir, 'not-mounted');
    process.env[ENV] = absent;
    await expect(anchorAuditChains(db)).rejects.toThrow();
    expect(await stat(absent).catch(() => null)).toBeNull();
    expect((await verifyAuditChains(db)).anchor).toMatchObject({ error: expect.any(String) });
  });

  it('a clock stepped back still writes the newest anchor first', async () => {
    process.env[ENV] = dir;
    const first = await anchorAuditChains(db);
    try {
      setSystemTime(new Date(Date.parse(first.at as string) - 3_600_000));
      const second = await anchorAuditChains(db);
      expect(Date.parse(second.at as string)).toBeGreaterThan(Date.parse(first.at as string));
    } finally {
      setSystemTime();
    }
    const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
    const newest = JSON.parse(await readFile(join(dir, names[0] as string), 'utf8')) as {
      at: string;
    };
    expect(Date.parse(newest.at)).toBeGreaterThan(Date.parse(first.at as string));
    expect((await readdir(dir)).some((n) => !n.endsWith('.json'))).toBe(false);
  });

  it('an S3 anchor replaced under its own key fails verify', async () => {
    // Object lock keeps the old version; a read returns the new one. A fake
    // store that, like S3, sets LastModified itself on every PUT.
    const objs = new Map<string, { body: string; at: Date }>();
    const store = Bun.serve({
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        const key = u.pathname.split('/').slice(2).join('/');
        if (req.method === 'PUT') {
          objs.set(key, { body: await req.text(), at: new Date() });
          return new Response('');
        }
        if (u.searchParams.get('list-type') === '2') {
          const items = [...objs]
            .filter(([k]) => k.startsWith(u.searchParams.get('prefix') ?? ''))
            .map(
              ([k, o]) =>
                `<Contents><Key>${k}</Key><LastModified>${o.at.toISOString()}</LastModified><Size>${o.body.length}</Size></Contents>`,
            )
            .join('');
          return new Response(
            `<?xml version="1.0"?><ListBucketResult><Name>b</Name><IsTruncated>false</IsTruncated>${items}</ListBucketResult>`,
            { headers: { 'content-type': 'application/xml' } },
          );
        }
        const o = objs.get(key);
        return o ? new Response(o.body) : new Response('', { status: 404 });
      },
    });
    const env = {
      [ENV]: 's3://b/anchors',
      S3_ENDPOINT: `http://localhost:${store.port}`,
      AUDIT_ANCHOR_S3_ACCESS_KEY: 'k',
      AUDIT_ANCHOR_S3_SECRET_KEY: 's',
    };
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    try {
      Object.assign(process.env, env);
      const tenant = T.replaced;
      for (const r of ['a', 'b', 'c']) await write(tenant, r);
      setSystemTime(new Date(Date.now() - 3 * 3_600_000));
      try {
        await anchorAuditChains(db);
      } finally {
        setSystemTime();
      }
      await cutTail(tenant, 2);
      // Written on time three hours ago: no false alarm.
      expect((await anchorOf(tenant)).chain).toMatchObject({ status: 'behind' });

      // Replaced with the shorter chain under the same key.
      const [key, old] = [...objs][0]!;
      const a = JSON.parse(old.body) as { chains: { tenant_id: string; head: unknown }[] };
      const head = (
        await asAuditOwner(db, (trx) =>
          sql<{ seq: number; hash: string }>`
            SELECT seq::int AS seq, encode(hash, 'hex') AS hash FROM zv_audit_chain
             WHERE tenant_id = ${tenant}::uuid ORDER BY seq DESC LIMIT 1`.execute(trx),
        )
      ).rows[0];
      for (const c of a.chains) if (c.tenant_id === tenant) c.head = head;
      objs.set(key, { body: `${JSON.stringify(a)}\n`, at: new Date() });
      expect((await verifyAuditChains(db)).anchor).toMatchObject({
        error: expect.stringContaining('replaced'),
      });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      store.stop(true);
    }
  });
});
