import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { type Database, getDb } from '../db/index.js';
import { getCurrentTenantTrx, onAfterCommit, withTenantIsolation } from './tenancy/index.js';

export type AuditEventType =
  | 'auth.login_failed'
  | 'auth.login_success'
  | 'auth.logout'
  /** A passkey or TOTP factor was added, removed or disabled (routes/step-up.ts). */
  | 'auth.factor_changed'
  /** A CLI sign-in or step-up was approved in the Console (routes/cli-sign-in.ts). */
  | 'auth.cli_approved'
  | 'permission.denied'
  | 'permission.granted'
  | 'permission.revoked'
  | 'collection.created'
  | 'collection.deleted'
  | 'schema.applied'
  | 'api_key.created'
  | 'api_key.revoked'
  | 'user.role_changed'
  | 'user.invited'
  | 'user.deleted'
  | 'user.created'
  | 'user.profile_updated'
  /** A directory provider's act on an account it provisioned (ADR 0039 decision 9, lib/extensions/directory.ts). */
  | 'identity.provisioned'
  | 'identity.updated'
  | 'identity.active_set'
  | 'identity.removed'
  | 'settings.changed'
  /** God set or removed a user's storage quota (routes/admin/storage-routes.ts). */
  | 'storage.quota_changed'
  | 'god_mode.used'
  | 'extension.loaded'
  | 'extension.load_failed'
  | 'extension.unloaded'
  | 'extension.crash_disabled'
  /** An administrator granted an extension the capabilities its manifest
   * declares. The one place a privilege widening is a deliberate act. */
  | 'extension.capabilities.approved'
  | 'extension.capabilities.pruned'
  | 'extension.egress.slot_bound'
  /** An administrator approved the caller credentials a worker extension's routes receive. */
  | 'extension.forward_credentials.approved'
  /** One run of an extension action (lib/extensions/actions.ts), with its outcome. */
  | 'extension.action.executed'
  /** One run of an extension job (lib/extensions/jobs.ts), with its outcome and enqueuer. */
  | 'extension.job.executed'
  | 'extension.job.enqueued'
  // An anonymous execution of a public edge function. Its own type because the
  // authenticated invocations are attributable by their user and these are not
  // attributable by anything but time and address.
  | 'edge_function.invoked_anonymously'
  // Saving a function's `egress` approves what it may reach; deleting it
  // removes a deployed endpoint. Both name who did it.
  | 'edge_function.egress_changed'
  | 'edge_function.deleted'
  | 'sql.executed'
  // Its own event, not a field on `sql.executed`. Someone asking who changed
  // the data should be able to filter for it, rather than read every ad-hoc
  // SELECT anyone has ever run looking for the one that wrote.
  | 'sql.write.executed'
  | 'sql.failed'
  | 'backup.created'
  | 'backup.deleted'
  | 'backup.downloaded'
  | 'backup.restored'
  | 'backup.scheduled'
  | 'pitr.config_changed'
  | 'pitr.restored'
  | 'approval.workflow_changed'
  | 'approval.decided'
  | 'approval.submitted'
  | 'approval.cancelled'
  | 'api_key.rate_limit_set'
  | 'api_key.rate_limit_removed'
  | 'export.executed'
  // Row rules (`/api/admin/rls`): who may read which rows is as much a
  // permission as a role grant, and changing it left no trace.
  | 'rls_rule.created'
  | 'rls_rule.updated'
  | 'rls_rule.deleted'
  // Validation rules (`ctx.internals.writeValidationRule`): instance-wide, they
  // decide which writes every tenant may make.
  | 'validation_rule.created'
  | 'validation_rule.updated'
  | 'validation_rule.deleted'
  | 'validation_rule_group.created'
  | 'validation_rule_group.deleted'
  // Tenant lifecycle and membership.
  //
  // `routes/tenants.ts` held no audit call at all: creating a firm, suspending
  // one, granting somebody `tenant_owner` inside it and taking it away again all
  // happened with no trace, while `routes/permissions.ts` audited the same act —
  // granting a role — on its own endpoint. One act, two routes, one of them
  // invisible.
  //
  // Their own types rather than folding them into `permission.granted`: someone
  // asking who was given the run of a firm should be able to filter for that,
  // not read every permission event ever written looking for the ones that were
  // about membership.
  | 'tenant.created'
  | 'tenant.updated'
  | 'tenant.member_added'
  | 'tenant.member_removed'
  | 'tenant.member_updated'
  | 'tenant.rls_enabled'
  | 'tenant.archived'
  | 'tenant.purged'
  // One row per request by a god (`middleware/god-audit.ts`).
  | 'god_action';

export interface AuditEvent {
  type: AuditEventType;
  userId?: string;
  resourceId?: string;
  resourceType?: string;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  metadata?: Record<string, any>;
  ip?: string;
  /**
   * Whose activity this is (`zv_audit_log.tenant_id`, migration 040).
   *
   * Absent: the writing transaction's tenant, NULL outside one. A tenant id:
   * that tenant's row, so it shows in the tenant's own activity — needed where
   * the route acts on a tenant it does not run as (`/api/tenants` runs in none).
   * `null`: an instance-level event, which a request's tenant transaction would
   * otherwise hand to whichever tenant the request resolved (the default firm,
   * on the root host).
   */
  tenantId?: string | null;
}

/**
 * Audit writes still running.
 *
 * Most callers do not await `auditLog` — the route answers the request and lets
 * the row land behind it, which is right: an audit failure must not break the
 * flow it is recording. It leaves a test with nothing to await, and
 * `sql-editor-read-only.test.ts` had the consequence: one case performs a write
 * over HTTP and the NEXT case reads `zv_audit_log` for the event it produced.
 * That passed on an idle runner and failed on a busy one, which is the worst
 * kind of red — it looks like the feature broke.
 *
 * Same answer as `_settleWebhookDeliveries` in `lib/webhooks.ts`: let a test
 * await the work instead of guessing how long it takes.
 */
const _inFlight = new Set<Promise<unknown>>();

/** Resolve once every audit write started so far has finished. Test-only. */
export async function _settleAuditWrites(): Promise<void> {
  // A loop rather than one `Promise.all`: a write can start another, and
  // awaiting the first snapshot would return with the second still running.
  while (_inFlight.size > 0) {
    await Promise.all([..._inFlight]);
  }
}

/**
 * Count `write` as an audit write in flight until it settles. For a caller whose
 * `auditLog` runs inside work of its own (a transaction it opens first): the
 * write is only registered once that work reaches it, and a settle in between
 * would return before it started.
 */
export async function trackAuditWrite<T>(write: Promise<T>): Promise<T> {
  _inFlight.add(write);
  try {
    return await write;
  } finally {
    _inFlight.delete(write);
  }
}

export function auditLog(db: Database, event: AuditEvent): Promise<void> {
  return trackAuditWrite(writeAuditRow(db, event));
}

const CURRENT_TENANT = sql`NULLIF(current_setting('zveltio.current_tenant', true), '')`;

/**
 * One INSERT … SELECT, so a row the policy would refuse is not attempted: a
 * named tenant only from that tenant's transaction, an instance row only from
 * outside every tenant's. A refused INSERT would abort the caller's transaction
 * (25P02) on a plain-role install; no row is a decision the caller can act on.
 */
async function insertRow(db: Database, event: AuditEvent): Promise<boolean> {
  const { tenantId } = event;
  // An API key is not a `"user"` row, and `user_id` names users only (it had a
  // foreign key until migration 128; writing `apikey:<id>` there lost the row).
  // The key goes in the metadata instead.
  const keyActor = event.userId?.startsWith('apikey:') ? event.userId : undefined;
  const userId = keyActor ? null : (event.userId ?? null);
  const metadata = keyActor ? { ...(event.metadata ?? {}), api_key: keyActor } : event.metadata;
  const tenant =
    tenantId === undefined ? sql`${CURRENT_TENANT}::uuid` : sql`${tenantId ?? null}::uuid`;
  const where =
    tenantId === undefined
      ? sql`true`
      : tenantId === null
        ? sql`${CURRENT_TENANT} IS NULL`
        : sql`${CURRENT_TENANT} = ${tenantId}`;
  // `::text::jsonb` on the metadata, not `::jsonb`. The driver already sends
  // that parameter as jsonb, so a bare `::jsonb` is a no-op and Postgres
  // stores the serialized string AS a jsonb string scalar — the whole object
  // wrapped in quotes with its own quotes escaped. Every row written that way
  // answers NULL to `metadata->>'anything'`, so the audit trail could be read
  // by a human and queried by nobody: no filtering by outcome, no counting
  // failed attempts, no alerting. Going through text makes Postgres parse it.
  // Migration 041 repairs the rows already written.
  const r = await sql`
    INSERT INTO zv_audit_log (
      event_type, user_id, resource_id, resource_type, metadata, ip, created_at, tenant_id
    )
    SELECT
      ${event.type},
      ${userId},
      ${event.resourceId ?? null},
      ${event.resourceType ?? null},
      ${JSON.stringify(metadata ?? {})}::text::jsonb,
      ${event.ip ?? null},
      NOW(),
      ${tenant}
    WHERE ${where}
  `.execute(db);
  return Number(r.numAffectedRows ?? 0) > 0;
}

async function writeAuditRow(db: Database, event: AuditEvent): Promise<void> {
  try {
    if ((await insertRow(db, event)) || event.tenantId === undefined) return;
    // Not this transaction's row to write. Inside a tenant transaction, after it
    // ends: a second connection taken while this one is held is how the engine
    // deadlocks at `c = DB_POOL_MAX`. A rollback drops it with the act it records.
    if (getCurrentTenantTrx()) {
      onAfterCommit(() => auditLog(getDb(), event));
    } else if (event.tenantId) {
      const tenantId = event.tenantId;
      await withTenantIsolation(tenantId, async (trx) => {
        if (!(await insertRow(trx, event))) throw new Error(`not written for ${tenantId}`);
      });
    } else {
      throw new Error('an instance-level row cannot be written inside a tenant transaction');
    }
  } catch (err) {
    // Audit log failure must never break the main request flow
    console.error(
      '[Audit] Failed to write audit event:',
      event.type,
      (err as Error)?.message ?? err,
    );
  }
}

// ── Hash chain (ADR 0060 decisions 3 and 4, migrations 129 and 130) ─────

/** One `zv_audit_chain` entry, with the content hash of the row it names now. */
export interface AuditChainEntry {
  seq: number;
  audit_id: string;
  /** Hex. */
  content_hash: string;
  /** Hex: SHA-256(previous hash || content_hash). */
  hash: string;
  /** Hex hash of the row as it is now; null when the row is gone. */
  row_hash: string | null;
}

export type AuditChainBreak = {
  seq: number;
  audit_id: string | null;
  /**
   * `gap`: no entry at `seq`. `link`: the entry's hash does not follow from the
   * one before. `row_changed`: the row no longer hashes to its entry.
   * `row_missing`: the row is gone and its entry is still there. The retention
   * purge cuts the entries of the rows it deletes and moves the genesis past
   * them (migration 130), so a row gone at the oldest end is missing too.
   */
  reason: 'gap' | 'link' | 'row_changed' | 'row_missing';
};

export interface AuditChainReport {
  /** null: the instance's own chain. */
  tenant_id: string | null;
  ok: boolean;
  /** Entries checked: the whole chain when `ok`, else those before the break. */
  verified: number;
  /**
   * Where the walk started: the last entry the retention purge cut (its seq and
   * hash) and when; null while nothing was cut, the walk starting from 32 zero
   * bytes at seq 0.
   */
  genesis: { seq: number; hash: string; cut_at: string } | null;
  /** The last entry verified (the genesis when none was): the head when `ok`. */
  head: { seq: number; hash: string } | null;
  broken?: AuditChainBreak;
}

const GENESIS = '00'.repeat(32);

/** Walk state of one chain, carried across batches. */
export interface ChainWalk {
  seq: number;
  hash: string;
  verified: number;
}

/** From the chain's latest genesis, or from 32 zero bytes at seq 0. */
export const startChainWalk = (genesis?: { seq: number; hash: string } | null): ChainWalk => ({
  seq: genesis?.seq ?? 0,
  hash: genesis?.hash ?? GENESIS,
  verified: 0,
});

/**
 * Advance `walk` over `entries` (ascending `seq`). Returns the first break, or
 * null with `walk` moved to the last entry.
 */
export function walkAuditChain(
  walk: ChainWalk,
  entries: AuditChainEntry[],
): AuditChainBreak | null {
  for (const e of entries) {
    if (e.seq !== walk.seq + 1) return { seq: walk.seq + 1, audit_id: null, reason: 'gap' };
    const link = createHash('sha256')
      .update(Buffer.from(walk.hash, 'hex'))
      .update(Buffer.from(e.content_hash, 'hex'))
      .digest('hex');
    if (link !== e.hash) return { seq: e.seq, audit_id: e.audit_id, reason: 'link' };
    if (e.row_hash === null) return { seq: e.seq, audit_id: e.audit_id, reason: 'row_missing' };
    if (e.row_hash !== e.content_hash) {
      return { seq: e.seq, audit_id: e.audit_id, reason: 'row_changed' };
    }
    walk.seq = e.seq;
    walk.hash = e.hash;
    walk.verified++;
  }
  return null;
}

const VERIFY_BATCH = 1000;

/**
 * Check every tenant's chain and the instance's: each link, each row against its
 * entry, and that no row is outside the chain (`unchained`, a row written with
 * the chain trigger switched off). The first break of each chain is reported.
 *
 * As the table owner, publishing every tenant the chain names besides the live
 * ones: a purged tenant's rows stay until retention takes them, and the
 * published reach of `withEveryTenant` holds live tenants only.
 */
export async function verifyAuditChains(db: Database): Promise<{
  ok: boolean;
  chains: AuditChainReport[];
  unchained: { audit_id: string; tenant_id: string | null } | null;
}> {
  return db.transaction().execute(async (trx) => {
    await sql`
      SELECT set_config('zveltio.current_tenant', '', true),
             set_config('zveltio.visible_tenants', coalesce((
               SELECT string_agg(DISTINCT t::text, ',') FROM (
                 SELECT tenant_id AS t FROM zv_audit_chain WHERE tenant_id IS NOT NULL
                 UNION SELECT id FROM zv_tenants) s), ''), true)
    `.execute(trx);
    // A chain cut to its last entry is listed by its genesis.
    const tenants = await sql<{ tenant_id: string | null }>`
      SELECT tenant_id::text AS tenant_id FROM zv_audit_chain
       UNION SELECT tenant_id::text FROM zv_audit_chain_cut
       ORDER BY tenant_id NULLS FIRST`.execute(trx);

    const chains: AuditChainReport[] = [];
    for (const { tenant_id } of tenants.rows) {
      const own =
        tenant_id === null ? sql`c.tenant_id IS NULL` : sql`c.tenant_id = ${tenant_id}::uuid`;
      const genesis =
        (
          await sql<{ seq: number; hash: string; cut_at: string }>`
            SELECT seq::float8 AS seq, encode(hash, 'hex') AS hash, cut_at::text AS cut_at
              FROM zv_audit_chain_cut
             WHERE tenant_id IS NOT DISTINCT FROM ${tenant_id}::uuid
             ORDER BY seq DESC LIMIT 1`.execute(trx)
        ).rows[0] ?? null;
      const walk = startChainWalk(genesis);
      let broken: AuditChainBreak | null = null;
      for (;;) {
        const batch = await sql<AuditChainEntry>`
          SELECT c.seq::float8 AS seq, c.audit_id::text AS audit_id,
                 encode(c.content_hash, 'hex') AS content_hash, encode(c.hash, 'hex') AS hash,
                 CASE WHEN a.id IS NOT NULL
                      THEN encode(zveltio_audit_content_hash(a), 'hex') END AS row_hash
            FROM zv_audit_chain c
            LEFT JOIN zv_audit_log a ON a.id = c.audit_id
           WHERE ${own} AND c.seq > ${walk.seq}
           ORDER BY c.seq
           LIMIT ${VERIFY_BATCH}`.execute(trx);
        broken = walkAuditChain(walk, batch.rows);
        if (broken || batch.rows.length < VERIFY_BATCH) break;
      }
      chains.push({
        tenant_id,
        ok: !broken,
        verified: walk.verified,
        genesis,
        head: walk.seq ? { seq: walk.seq, hash: walk.hash } : null,
        ...(broken ? { broken } : {}),
      });
    }

    const loose = await sql<{ audit_id: string; tenant_id: string | null }>`
      SELECT a.id::text AS audit_id, a.tenant_id::text AS tenant_id FROM zv_audit_log a
       WHERE NOT EXISTS (SELECT 1 FROM zv_audit_chain c WHERE c.audit_id = a.id)
       ORDER BY a.created_at, a.id LIMIT 1`.execute(trx);
    const unchained = loose.rows[0] ?? null;
    return { ok: !unchained && chains.every((c) => c.ok), chains, unchained };
  });
}
