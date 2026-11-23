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
 * One new file or object per write, never one rewritten. Each chain is judged
 * against every anchor in the target, not only the newest (ADR 0060 amendment
 * 2026-11-23): whoever holds the anchor credentials can add a newer anchor, but
 * not remove the older ones an object lock keeps, and an added anchor can only
 * raise what a chain is held to. The writer compares the database with the
 * newest anchor and carries forward the anchored head of any chain now behind
 * it or changed, so the engine itself does not anchor the shorter chain.
 *
 * Ids and hashes only: tenant ids, sequence numbers, SHA-256 hex, a timestamp.
 */

import { link, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { tryAdvisoryLock } from '../db/advisory-lock.js';
import { toJsonb } from './jsonb.js';

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
 * retention purge cut past it, after the anchor was written. `behind`: the chain ends before
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
      /** When the newest anchor was written; null before the first. */
      at: string | null;
      chains: { tenant_id: string | null; status: AnchorStatus; anchored: ChainLink }[];
    }
  /** The target holds no anchor while the database holds chains. */
  | { configured: true; missing: true };

/** The database side of one chain. */
export interface ChainState {
  head: ChainLink | null;
  /** `cut_ms`: when the database says the cut was made (epoch ms). */
  genesis: (ChainLink & { cut_ms: number }) | null;
  /** Hash of the entry at the anchored seq, null when there is none. */
  atAnchored: string | null;
}

const PREFIX = 'zveltio-audit-anchor-';
const MAX_MS = 9_999_999_999_999;
const INTERVAL_MS = 60 * 60_000;

type Target = { kind: 'dir'; dir: string } | { kind: 's3'; client: Bun.S3Client; prefix: string };

/** null when unset; throws when set to something that is not a target. */
export function anchorTarget(): Target | null {
  const raw = process.env.AUDIT_ANCHOR_TARGET?.trim() ?? '';
  if (raw === '') return null;
  if (raw.startsWith('s3://')) {
    const url = new URL(raw);
    if (!url.hostname) throw new Error('AUDIT_ANCHOR_TARGET s3:// names no bucket');
    const path = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '');
    const env = process.env;
    // Own credentials when set, so whoever holds the files store's keys cannot
    // delete anchors; both or neither. Not a write-only account: the writer and
    // verify list and read every anchor first, so it needs list, read and
    // write, and no delete.
    const ownKey = env.AUDIT_ANCHOR_S3_ACCESS_KEY;
    const ownSecret = env.AUDIT_ANCHOR_S3_SECRET_KEY;
    if (!ownKey !== !ownSecret) {
      throw new Error(
        'AUDIT_ANCHOR_S3_ACCESS_KEY and AUDIT_ANCHOR_S3_SECRET_KEY must be set together',
      );
    }
    return {
      kind: 's3',
      prefix: path ? `${path}/` : '',
      client: new Bun.S3Client({
        bucket: url.hostname,
        endpoint: env.S3_ENDPOINT || undefined,
        region: env.S3_REGION || undefined,
        accessKeyId: (ownKey ? ownKey : env.S3_ACCESS_KEY) || undefined,
        secretAccessKey: (ownSecret ? ownSecret : env.S3_SECRET_KEY) || undefined,
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

/** Newest first in an ascending listing. */
const anchorName = (ms: number) =>
  `${PREFIX}${String(MAX_MS - ms).padStart(13, '0')}-${new Date(ms).toISOString().replace(/[-:.]/g, '')}.json`;

/**
 * Every anchor in the target (~8760 a year at one an hour, read in batches),
 * or with `newest` only the newest: names sort newest first.
 */
async function readAnchors(t: Target, newest = false): Promise<AnchorFile[]> {
  let texts: { name: string; read: () => Promise<string>; modified?: string }[];
  if (t.kind === 'dir') {
    // Never created: an absent directory is an unmounted target, and anchoring
    // to the root filesystem in its place would look like it worked.
    const names = await readdir(t.dir).catch((e: NodeJS.ErrnoException) => {
      throw new Error(`AUDIT_ANCHOR_TARGET directory ${t.dir} cannot be read (${e.code})`);
    });
    texts = names
      .filter((n) => n.startsWith(PREFIX) && n.endsWith('.json'))
      .map((n) => ({ name: n, read: () => readFile(join(t.dir, n), 'utf8') }));
  } else {
    texts = [];
    let continuationToken: string | undefined;
    do {
      const page = await t.client.list({ prefix: `${t.prefix}${PREFIX}`, continuationToken });
      for (const o of page.contents ?? []) {
        texts.push({
          name: o.key,
          read: () => t.client.file(o.key).text(),
          modified: o.lastModified,
        });
      }
      if (page.isTruncated && !page.nextContinuationToken) {
        throw new Error('the anchor listing was cut short with no way to continue it');
      }
      continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (continuationToken);
  }
  texts.sort((a, b) => (a.name < b.name ? -1 : 1));
  if (newest) texts = texts.slice(0, 1);
  const out: AnchorFile[] = [];
  for (let i = 0; i < texts.length; i += 32) {
    const batch = texts.slice(i, i + 32);
    for (const [k, text] of (await Promise.all(batch.map((f) => f.read()))).entries()) {
      // Any malformed anchor fails verify: one written in place of a good one is
      // the tampering this guards against, and it says which file.
      let a: unknown = null;
      try {
        a = JSON.parse(text);
      } catch {}
      const name = batch[k]!.name;
      if (!wellFormed(a, name.slice(name.lastIndexOf('/') + 1))) {
        throw new Error(`the audit anchor ${name} is malformed`);
      }
      // Object lock keeps an anchor's version, not its key: a PUT to the same
      // key makes a new current version, which is what a read returns. The
      // store, not the writer, sets LastModified, so a replaced anchor shows a
      // write time long after its own `at`.
      const modified = Date.parse(batch[k]!.modified ?? '');
      if (t.kind === 's3' && !(modified <= Date.parse(a.at) + REPLACED_MS)) {
        throw new Error(
          `the audit anchor ${name} was stored after its own date (replaced), or the store gave no write time`,
        );
      }
      out.push(a);
    }
  }
  return out;
}

const HEX = /^[0-9a-f]{64}$/;
/** A day of clock skew between replicas; an anchor dated later is not one the engine wrote. */
const SKEW_MS = 24 * 60 * 60_000;
/** The engine and the object store clocks may differ by this much; a replacement older than it is caught. */
const REPLACED_MS = 60 * 60_000;

const isLink = (l: unknown): l is ChainLink =>
  typeof l === 'object' &&
  l !== null &&
  Number.isSafeInteger((l as ChainLink).seq) &&
  (l as ChainLink).seq >= 0 &&
  typeof (l as ChainLink).hash === 'string' &&
  HEX.test((l as ChainLink).hash);

/**
 * The shape the writer writes, under the name it gives it: `at` parses, is not
 * in the future, and is what the name encodes, so the name sorting first is the
 * newest `at`.
 */
function wellFormed(a: unknown, name: string): a is AnchorFile {
  const f = a as AnchorFile | null;
  if (f?.v !== 1 || typeof f.at !== 'string' || !Array.isArray(f.chains)) return false;
  const at = Date.parse(f.at);
  if (!Number.isFinite(at) || at > Date.now() + SKEW_MS || anchorName(at) !== name) return false;
  return f.chains.every(
    (c) =>
      typeof c === 'object' &&
      c !== null &&
      (c.tenant_id === null || typeof c.tenant_id === 'string') &&
      isLink(c.head) &&
      (c.genesis === null || isLink(c.genesis)),
  );
}

/** One chain as some anchor holds it, at the latest time an anchor held it so. */
interface Held {
  chain: AnchoredChain;
  at: number;
}

/**
 * Per chain, what the anchors hold it to: every distinct (head, genesis) any
 * anchor names, each at the latest time an anchor named it — so a cut is
 * `covered` only if made after every anchor that held that head. A chain is
 * judged against each and answers its worst status, so an added anchor (a
 * higher head included) never takes an older one out of the judgment.
 */
function heldTo(anchors: AnchorFile[]): Map<string | null, Held[]> {
  const all = new Map<string | null, Map<string, Held>>();
  for (const a of anchors) {
    const at = Date.parse(a.at);
    for (const c of a.chains) {
      let held = all.get(c.tenant_id);
      if (!held) {
        held = new Map();
        all.set(c.tenant_id, held);
      }
      const key = JSON.stringify([c.head, c.genesis]);
      const was = held.get(key);
      if (!was || at > was.at) held.set(key, { chain: c, at });
    }
  }
  return new Map([...all].map(([t, held]) => [t, [...held.values()]]));
}

async function writeAnchor(t: Target, a: AnchorFile): Promise<string> {
  const name = anchorName(Date.parse(a.at));
  const body = `${JSON.stringify(a)}\n`;
  if (t.kind === 'dir') {
    // Whole or not at all: a temp file outside the name filter, then link(),
    // which refuses an existing name, so no anchor is ever overwritten.
    const tmp = join(t.dir, `.${name}.${crypto.randomUUID()}.tmp`);
    await writeFile(tmp, body, { flag: 'wx' });
    try {
      await link(tmp, join(t.dir, name));
    } finally {
      await unlink(tmp);
    }
    return join(t.dir, name);
  }
  // No conditional PUT in Bun's client: write-once is the bucket's object lock.
  await t.client.write(`${t.prefix}${name}`, body, { type: 'application/json' });
  return `${t.prefix}${name}`;
}

/**
 * Pure: how the database stands against one anchored chain, anchored at
 * `anchoredAt` (epoch ms). A cut past the anchored head is `covered` only if
 * made after the anchor: before it, the head was an entry above the genesis.
 * A cut row the database owner forges with a later `cut_at` is beyond reach.
 */
export function judgeAnchor(
  anchored: AnchoredChain,
  db: ChainState,
  anchoredAt: number,
): AnchorStatus {
  const ag = anchored.genesis;
  const g = db.genesis;
  if (ag && (!g || g.seq < ag.seq || (g.seq === ag.seq && g.hash !== ag.hash))) {
    return 'genesis_changed';
  }
  const a = anchored.head;
  if (!db.head || db.head.seq < a.seq) return 'behind';
  if (g && g.seq >= a.seq) {
    if (g.seq > a.seq) return g.cut_ms >= anchoredAt ? 'covered' : 'changed';
    return g.hash === a.hash ? 'ok' : 'changed';
  }
  return db.atAnchored === a.hash ? 'ok' : 'changed';
}

/** As the table owner: neither chain table is under RLS, the request role holds nothing on them. */
async function chainState(
  db: Database,
  tenantId: string | null,
): Promise<Omit<ChainState, 'atAnchored'>> {
  const own = tenantId === null ? sql`tenant_id IS NULL` : sql`tenant_id = ${tenantId}::uuid`;
  const r = await sql<{
    head: ChainLink | null;
    genesis: ChainState['genesis'];
  }>`
    SELECT
      (SELECT json_build_object('seq', seq, 'hash', encode(hash, 'hex')) FROM zv_audit_chain
        WHERE ${own} ORDER BY seq DESC LIMIT 1) AS head,
      (SELECT json_build_object('seq', seq, 'hash', encode(hash, 'hex'),
                                'cut_ms', extract(epoch FROM cut_at) * 1000)
         FROM zv_audit_chain_cut WHERE ${own} ORDER BY seq DESC LIMIT 1) AS genesis`.execute(db);
  const row = r.rows[0];
  return {
    head: row?.head ?? (row?.genesis ? { seq: row.genesis.seq, hash: row.genesis.hash } : null),
    genesis: row?.genesis ?? null,
  };
}

const holds = (s: AnchorStatus) => s === 'ok' || s === 'covered';

const SEVERITY: Record<AnchorStatus, number> = {
  ok: 0,
  covered: 1,
  behind: 2,
  changed: 3,
  genesis_changed: 4,
};

/** One chain against what the anchors hold it to: its worst status. */
async function judgeChain(
  db: Database,
  tenantId: string | null,
  held: Held[],
): Promise<{ status: AnchorStatus; anchored: AnchoredChain }> {
  const state = await chainState(db, tenantId);
  const own = tenantId === null ? sql`tenant_id IS NULL` : sql`tenant_id = ${tenantId}::uuid`;
  const seqs = toJsonb([...new Set(held.map((h) => h.chain.head.seq))]);
  const at = await sql<{ seq: string; hash: string }>`
    SELECT seq::text AS seq, encode(hash, 'hex') AS hash FROM zv_audit_chain
     WHERE ${own}
       AND seq IN (SELECT jsonb_array_elements_text(${seqs})::bigint)`.execute(db);
  const hashAt = new Map(at.rows.map((r) => [Number(r.seq), r.hash]));
  let worst: { status: AnchorStatus; anchored: AnchoredChain } | null = null;
  for (const h of held) {
    const status = judgeAnchor(
      h.chain,
      { ...state, atAnchored: hashAt.get(h.chain.head.seq) ?? null },
      h.at,
    );
    const rank = SEVERITY[status] - (worst ? SEVERITY[worst.status] : -1);
    if (rank > 0 || (rank === 0 && h.chain.head.seq > worst!.anchored.head.seq)) {
      worst = { status, anchored: h.chain };
    }
  }
  return worst!;
}

/** Verify's side: the database against every anchor. */
export async function verifyAnchor(db: Database): Promise<AnchorReport> {
  try {
    const target = anchorTarget();
    if (!target) return { configured: false };
    const anchors = await readAnchors(target);
    if (anchors.length === 0) {
      // An empty target is not a clean one: a fresh install leaves this at its
      // first write (boot writes at once); emptying the target re-baselines.
      const any = await sql<{ any: boolean }>`
        SELECT EXISTS (SELECT 1 FROM zv_audit_chain)
            OR EXISTS (SELECT 1 FROM zv_audit_chain_cut) AS any`.execute(db);
      return any.rows[0]?.any
        ? { configured: true, missing: true }
        : { configured: true, at: null, chains: [] };
    }
    const chains = [];
    for (const [tenant_id, held] of heldTo(anchors)) {
      const { status, anchored } = await judgeChain(db, tenant_id, held);
      chains.push({ tenant_id, status, anchored: anchored.head });
    }
    return { configured: true, at: newestAt(anchors), chains };
  } catch (err) {
    return { configured: true, error: (err as Error).message };
  }
}

const newestAt = (anchors: AnchorFile[]) =>
  anchors.reduce((m, a) => (Date.parse(a.at) > Date.parse(m) ? a.at : m), anchors[0]!.at);

export const anchorHolds = (r: AnchorReport): boolean =>
  !('error' in r) &&
  !('missing' in r) &&
  (!('chains' in r) || r.chains.every((c) => holds(c.status)));

/**
 * Write every chain's head and genesis as a new anchor. A chain behind the
 * newest anchor or changed against it keeps its anchored values: the evidence stays
 * until the operator, having looked, points AUDIT_ANCHOR_TARGET at a new prefix.
 */
export async function anchorAuditChains(
  db: Database,
): Promise<{ written: boolean; at?: string; carried?: (string | null)[] }> {
  const target = anchorTarget();
  if (!target) return { written: false };
  // The newest anchor only: verify reads every one, so an added newer anchor
  // cannot hide a cut from it, and reading them all each hour would grow with
  // the target. Carrying forward keeps the evidence in the newest file too.
  const anchors = await readAnchors(target, true);
  const prev = heldTo(anchors);
  // ponytail: a full scan of the chain's tenant column per write, as the purge
  // does; a skip scan over (tenant_id, seq) when the chain is large enough to show.
  const listed = await sql<{ tenant_id: string | null }>`
    SELECT tenant_id::text AS tenant_id FROM zv_audit_chain
     UNION SELECT tenant_id::text FROM zv_audit_chain_cut`.execute(db);
  const tenants = new Set([...listed.rows.map((r) => r.tenant_id), ...prev.keys()]);
  const chains: AnchoredChain[] = [];
  const carried: (string | null)[] = [];
  for (const tenant_id of tenants) {
    const held = prev.get(tenant_id);
    if (held) {
      const { status, anchored } = await judgeChain(db, tenant_id, held);
      if (!holds(status)) {
        chains.push(anchored);
        carried.push(tenant_id);
        continue;
      }
    }
    const state = await chainState(db, tenant_id);
    const g = state.genesis;
    if (state.head) {
      chains.push({ tenant_id, head: state.head, genesis: g && { seq: g.seq, hash: g.hash } });
    }
  }
  // Past the newest anchor even if the clock stepped back, or it would sort behind it.
  const last = anchors.length ? Date.parse(newestAt(anchors)) + 1 : 0;
  const at = new Date(Math.max(Date.now(), last)).toISOString();
  await writeAnchor(target, { v: 1, at, chains });
  if (carried.length) {
    console.error(
      `[audit-anchor] chain(s) ${carried.map((t) => t ?? 'instance').join(', ')} no longer ` +
        'match the anchors; their anchored head is carried forward. See GET /api/admin/audit/verify.',
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
