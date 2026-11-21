/**
 * External anchor of the audit chain heads (ADR 0060 decision 5).
 *
 * The hash chain shows a row changed or removed inside it, but not its newest
 * rows deleted together with their chain entries: what is left is a shorter
 * chain that verifies. So every chain's head (and its current genesis) is
 * written outside the database, to a target only the operator names
 * (`AUDIT_ANCHOR_TARGET`, env only — never the Studio's storage overlay, a row
 * in the very database the anchor guards), and verify compares.
 *
 * One new file or object per write, never one rewritten. The writer compares
 * the database with the latest anchor first and carries forward the anchored
 * head of any chain now behind it or changed, so the engine itself cannot
 * launder a cut by anchoring the shorter chain.
 *
 * Ids and hashes only: tenant ids, sequence numbers, SHA-256 hex, a timestamp.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { tryAdvisoryLock } from '../db/advisory-lock.js';

export interface ChainLink {
  seq: number;
  /** Hex. */
  hash: string;
}

/** One chain as anchored: its newest entry (the genesis when every entry was cut). */
export interface AnchoredChain {
  /** null: the instance's own chain. */
  tenant_id: string | null;
  head: ChainLink;
  genesis: ChainLink | null;
}

interface AnchorFile {
  v: 1;
  at: string;
  chains: AnchoredChain[];
}

/**
 * `ok`: the anchored entry is still on the chain, unchanged. `covered`: the
 * retention purge cut past it (a later genesis). `behind`: the chain ends before
 * the anchored entry — its newest rows were removed. `changed`: the entry at the
 * anchored seq is gone or hashes differently. `genesis_changed`: the chain's
 * genesis moved back or changed.
 */
export type AnchorStatus = 'ok' | 'covered' | 'behind' | 'changed' | 'genesis_changed';

export type AnchorReport =
  | { configured: false }
  | { configured: true; error: string }
  | {
      configured: true;
      /** When the latest anchor was written; null before the first. */
      at: string | null;
      chains: { tenant_id: string | null; status: AnchorStatus; anchored: ChainLink }[];
    };

/** The database side of one chain. */
export interface ChainState {
  head: ChainLink | null;
  genesis: ChainLink | null;
  /** Hash of the entry at the anchored seq, null when there is none. */
  atAnchored: string | null;
}

const PREFIX = 'zveltio-audit-anchor-';
const MAX_MS = 9_999_999_999_999;
const INTERVAL_MS = 60 * 60_000;

type Target = { kind: 'dir'; dir: string } | { kind: 's3'; client: Bun.S3Client; prefix: string };

/** null when unset; throws when set to something that is not a target. */
function anchorTarget(): Target | null {
  const raw = process.env.AUDIT_ANCHOR_TARGET?.trim() ?? '';
  if (raw === '') return null;
  if (raw.startsWith('s3://')) {
    const url = new URL(raw);
    if (!url.hostname) throw new Error('AUDIT_ANCHOR_TARGET s3:// names no bucket');
    const path = url.pathname.replace(/^\/+|\/+$/g, '');
    const env = process.env;
    return {
      kind: 's3',
      prefix: path ? `${path}/` : '',
      client: new Bun.S3Client({
        bucket: url.hostname,
        endpoint: env.S3_ENDPOINT || undefined,
        region: env.S3_REGION || undefined,
        accessKeyId: env.S3_ACCESS_KEY || undefined,
        secretAccessKey: env.S3_SECRET_KEY || undefined,
      }),
    };
  }
  if (!isAbsolute(raw)) {
    throw new Error(
      `AUDIT_ANCHOR_TARGET=${JSON.stringify(raw)} is neither an absolute directory ` +
        'nor s3://<bucket>/<prefix>',
    );
  }
  return { kind: 'dir', dir: raw };
}

/** Newest first in an ascending listing (S3 lists ascending, one page is enough). */
const anchorName = (ms: number) =>
  `${PREFIX}${String(MAX_MS - ms).padStart(13, '0')}-${new Date(ms).toISOString().replace(/[-:.]/g, '')}.json`;

async function readLatest(t: Target): Promise<AnchorFile | null> {
  let text: string | null = null;
  if (t.kind === 'dir') {
    const names = await readdir(t.dir).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return [] as string[];
      throw e;
    });
    const newest = names.filter((n) => n.startsWith(PREFIX) && n.endsWith('.json')).sort()[0];
    if (newest) text = await readFile(join(t.dir, newest), 'utf8');
  } else {
    const list = await t.client.list({ prefix: `${t.prefix}${PREFIX}`, maxKeys: 1 });
    const key = list.contents?.[0]?.key;
    if (key) text = await t.client.file(key).text();
  }
  if (text === null) return null;
  const a = JSON.parse(text) as AnchorFile;
  if (a?.v !== 1 || !Array.isArray(a.chains))
    throw new Error('the latest audit anchor is malformed');
  return a;
}

async function writeAnchor(t: Target, a: AnchorFile): Promise<string> {
  const name = anchorName(Date.parse(a.at));
  const body = `${JSON.stringify(a)}\n`;
  if (t.kind === 'dir') {
    await mkdir(t.dir, { recursive: true });
    // 'wx': an existing anchor is never overwritten.
    await writeFile(join(t.dir, name), body, { flag: 'wx' });
    return join(t.dir, name);
  }
  await t.client.write(`${t.prefix}${name}`, body, { type: 'application/json' });
  return `${t.prefix}${name}`;
}

/** Pure: how the database stands against one anchored chain. */
export function judgeAnchor(anchored: AnchoredChain, db: ChainState): AnchorStatus {
  const ag = anchored.genesis;
  const g = db.genesis;
  if (ag && (!g || g.seq < ag.seq || (g.seq === ag.seq && g.hash !== ag.hash))) {
    return 'genesis_changed';
  }
  const a = anchored.head;
  if (!db.head || db.head.seq < a.seq) return 'behind';
  if (g && g.seq >= a.seq) {
    if (g.seq > a.seq) return 'covered';
    return g.hash === a.hash ? 'ok' : 'changed';
  }
  return db.atAnchored === a.hash ? 'ok' : 'changed';
}

/** As the table owner: neither chain table is under RLS, the request role holds nothing on them. */
async function chainState(
  db: Database,
  tenantId: string | null,
  anchoredSeq: number | null,
): Promise<ChainState> {
  const own = tenantId === null ? sql`tenant_id IS NULL` : sql`tenant_id = ${tenantId}::uuid`;
  const r = await sql<{ head: ChainLink | null; genesis: ChainLink | null; at: string | null }>`
    SELECT
      (SELECT json_build_object('seq', seq, 'hash', encode(hash, 'hex')) FROM zv_audit_chain
        WHERE ${own} ORDER BY seq DESC LIMIT 1) AS head,
      (SELECT json_build_object('seq', seq, 'hash', encode(hash, 'hex')) FROM zv_audit_chain_cut
        WHERE ${own} ORDER BY seq DESC LIMIT 1) AS genesis,
      (SELECT encode(hash, 'hex') FROM zv_audit_chain
        WHERE ${own} AND seq = ${anchoredSeq ?? -1}) AS at`.execute(db);
  const row = r.rows[0];
  return {
    head: row?.head ?? row?.genesis ?? null,
    genesis: row?.genesis ?? null,
    atAnchored: row?.at ?? null,
  };
}

const holds = (s: AnchorStatus) => s === 'ok' || s === 'covered';

/** Verify's side: the database against the latest anchor. */
export async function verifyAnchor(db: Database): Promise<AnchorReport> {
  try {
    const target = anchorTarget();
    if (!target) return { configured: false };
    const latest = await readLatest(target);
    const chains = [];
    for (const a of latest?.chains ?? []) {
      const state = await chainState(db, a.tenant_id, a.head.seq);
      chains.push({ tenant_id: a.tenant_id, status: judgeAnchor(a, state), anchored: a.head });
    }
    return { configured: true, at: latest?.at ?? null, chains };
  } catch (err) {
    return { configured: true, error: (err as Error).message };
  }
}

export const anchorHolds = (r: AnchorReport): boolean =>
  !('error' in r) && (!('chains' in r) || r.chains.every((c) => holds(c.status)));

/**
 * Write every chain's head and genesis as a new anchor. A chain behind the
 * latest anchor or changed against it keeps its anchored values: the evidence
 * stays until the operator, having looked, moves the old anchors away.
 */
export async function anchorAuditChains(
  db: Database,
): Promise<{ written: boolean; at?: string; carried?: (string | null)[] }> {
  const target = anchorTarget();
  if (!target) return { written: false };
  const latest = await readLatest(target);
  const prev = new Map((latest?.chains ?? []).map((c) => [c.tenant_id, c]));
  // ponytail: a full scan of the chain's tenant column per write, as the purge
  // does; a skip scan over (tenant_id, seq) when the chain is large enough to show.
  const listed = await sql<{ tenant_id: string | null }>`
    SELECT tenant_id::text AS tenant_id FROM zv_audit_chain
     UNION SELECT tenant_id::text FROM zv_audit_chain_cut`.execute(db);
  const tenants = new Set([...listed.rows.map((r) => r.tenant_id), ...prev.keys()]);
  const chains: AnchoredChain[] = [];
  const carried: (string | null)[] = [];
  for (const tenant_id of tenants) {
    const before = prev.get(tenant_id);
    const state = await chainState(db, tenant_id, before?.head.seq ?? null);
    if (before && !holds(judgeAnchor(before, state))) {
      chains.push(before);
      carried.push(tenant_id);
      continue;
    }
    if (state.head) chains.push({ tenant_id, head: state.head, genesis: state.genesis });
  }
  const at = new Date().toISOString();
  await writeAnchor(target, { v: 1, at, chains });
  if (carried.length) {
    console.error(
      `[audit-anchor] chain(s) ${carried.map((t) => t ?? 'instance').join(', ')} no longer ` +
        'match the latest anchor; their anchored head is carried forward. See GET /api/admin/audit/verify.',
    );
  }
  return { written: true, at, carried };
}

/**
 * Anchor at boot and hourly, on one replica at a time. Unset, nothing is
 * scheduled and verify answers `anchor: { configured: false }`.
 */
export function scheduleAuditAnchor(db: Database): () => void {
  try {
    if (!anchorTarget()) {
      console.warn(
        '[audit-anchor] AUDIT_ANCHOR_TARGET is unset: the audit chain heads are not ' +
          'anchored outside the database, and a cut tail would verify.',
      );
      return () => {};
    }
  } catch (err) {
    console.error(`[audit-anchor] ${(err as Error).message}; nothing is anchored.`);
    return () => {};
  }
  const tick = () =>
    tryAdvisoryLock(db, 'zveltio:audit-anchor', () => anchorAuditChains(db)).catch((err) =>
      console.error('[audit-anchor] write failed:', (err as Error).message),
    );
  void tick();
  const timer = setInterval(tick, INTERVAL_MS);
  return () => clearInterval(timer);
}
