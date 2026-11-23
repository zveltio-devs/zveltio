/**
 * Flow Executor — runs the steps of a Zveltio automation flow.
 *
 * Supports step types:
 *   run_script        — run sandboxed JS via script-runner
 *   send_email        — send email via email lib (graceful no-op if not configured)
 *   webhook           — HTTP call to an external URL
 *   send_notification — in-app notification to a user or role
 *   export_collection — export collection rows to CSV, optionally email the file
 *
 * Called by:
 *   - flowsRoutes POST /:id/run   (manual trigger via API)
 *   - flowScheduler._executeFlow  (cron trigger)
 *   - runFlowJob                  (data trigger, a `flow.trigger` job)
 */

import { sql } from 'kysely';
import { toJsonb } from '../jsonb.js';
import type { Database } from '../../db/index.js';
import {
  DEFAULT_TENANT_ID,
  grantHoldsIn,
  rolePrincipal,
  type RolePrincipal,
  runWithDomain,
  withEveryTenant,
  withTenantIsolation,
} from '../tenancy/index.js';
import { DDLManager, selectReadable, withheldColumns } from '../data/index.js';
import { runScript } from '../script-runner.js';
import { sendEmail } from '../email.js';
import { recordsToCsv } from '../security/index.js';
import { sendNotification } from '../../routes/notifications.js';
import { traced } from '../runtime/index.js';
import { evaluateCondition } from '../validation-engine.js';
import {
  isBlockedOutboundHeader,
  safeFetch,
  validatePublicUrl,
} from '../edge-functions/safe-fetch.js';

export interface FlowRunResult {
  runId: string;
  status: 'success' | 'failed';
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  output: any;
  error?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Users holding a role in one tenant, as the enforcer would answer it there.
 * No catch: a lookup that fails fails the step — an empty list here was
 * reported as `{ sent: true, count: 0 }`.
 *
 * - `held` is the role and every role that inherits it: `g manager employee D`
 *   makes a manager hold `employee`, as `getImplicitRolesForUser` walks it. Only
 *   role→role rows (v0 not a user) in this tenant or `*` (the `g` domain
 *   matcher); UNION ends the seeded `g member member *` self-loops and cycles.
 * - A `g` row counts as `grantHoldsIn` says: in this tenant's domain unless the
 *   membership here has lapsed; at `*` only for a member of the tenant.
 *   Otherwise a tenant-A flow carried its message to tenant B.
 * - `member` is a `g <user> member *` row like any other `*` grant; `"user".role`
 *   (god) is an instance attribute, not a role, and is not read here.
 */
async function getUsersForRole(db: Database, role: string, tenantId: string): Promise<string[]> {
  const rows = await sql<{ id: string }>`
    WITH RECURSIVE held(r) AS (
      SELECT ${role}::text
      UNION
      SELECT g.v0 FROM zvd_permissions g JOIN held ON g.v1 = held.r
       WHERE g.ptype = 'g' AND (g.v2 = ${tenantId} OR g.v2 = '*')
         AND NOT EXISTS (SELECT 1 FROM "user" x WHERE x.id = g.v0)
    )
    SELECT u.id FROM "user" u
     WHERE EXISTS (SELECT 1 FROM zvd_permissions g
                    WHERE g.ptype = 'g' AND g.v0 = u.id AND g.v1 IN (SELECT r FROM held)
                      AND ${grantHoldsIn('g', tenantId)})
  `.execute(db);
  return rows.rows.map((r) => r.id);
}

// ── Step executor ─────────────────────────────────────────────────────────────

/** Rows one `export_collection` step may write; its step schema caps `limit` the same. */
const EXPORT_MAX_ROWS = 100_000;

/**
 * The step types this executor actually implements.
 *
 * Derived from the `switch` in `executeStep` and exported so the creation route
 * can refuse anything else. That route declared `type: z.string().min(1)`, so
 * any string was storable and the mistake only surfaced at run time — where the
 * `default` arm returned success.
 *
 * Deliberately NOT the same list as `flow-step-schemas.ts`, which defines
 * fourteen types. Seven of those never execute.
 * The two lists disagreeing with nothing to notice is the shape of this bug,
 * so this one is anchored to the code that runs.
 */
export const EXECUTABLE_STEP_TYPES = [
  'run_script',
  'send_email',
  'webhook',
  'send_notification',
  'export_collection',
  'condition',
] as const;

export type ExecutableStepType = (typeof EXECUTABLE_STEP_TYPES)[number];

/**
 * Step types the engine ran once and now refuses, with what the author does
 * instead. A flow holding one is refused before its first step: run with the
 * step skipped (`on_error: 'continue'`), its later steps would act on an input
 * that was never produced.
 *
 * `query_db` ran caller-written SQL. RLS reads the `zveltio.*` settings, which
 * that SQL could rewrite with `set_config` in its own transaction and read
 * another tenant's rows; without `zveltio_flow_reader` it ran as the connection
 * role (a superuser on a stock install). No caller-written SQL runs in the
 * engine (ADR 0058, DR-05). Migration 124 keeps stored steps, inert.
 */
export const REMOVED_STEP_TYPES: ReadonlyMap<string, string> = new Map([
  [
    'query_db',
    'raw SQL steps were removed (ADR 0058): read a collection with an export_collection ' +
      "step, which reads as the flow's role, and delete this step",
  ],
]);

async function executeStep(
  db: Database,
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  step: any,
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  prevOutput: any,
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  flowContext: Record<string, any> = {},
  // Tenant for any collection-data access in this step (export_collection runs
  // inside a `set_config('zveltio.current_tenant', …)` transaction, and collection
  // tables are FORCE-RLS'd). This is the flow's OWN tenant, resolved by executeFlow —
  // NOT derived from caller-supplied trigger data, which a caller could set to another
  // tenant's id to read/export across tenants.
  flowTenantId: string = DEFAULT_TENANT_ID,
  // The role the flow runs as (ADR 0004): every collection read below goes
  // through its grants, row rules and column rules. Required: a step with no
  // principal is the bypass this replaced. Resolved on first use, so a flow
  // that reads nothing asks nothing of Casbin.
  principal?: () => Promise<RolePrincipal>,
): Promise<{
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  output: any;
  logs?: string[];
  skip?: string[];
  stop?: boolean;
  branches?: string[];
}> {
  // The Bun SQL driver hands jsonb columns back as strings, so step.config read via
  // `SELECT * FROM zv_flow_steps` can be a JSON string (see the pervasive
  // `typeof x === 'string' ? JSON.parse(x)` guards elsewhere). Without parsing it,
  // cfg.query / cfg.code / cfg.url / … are all undefined and every config-driven
  // step silently no-ops (returns prevOutput).
  let cfg = step.config ?? {};
  if (typeof cfg === 'string') {
    try {
      cfg = JSON.parse(cfg);
    } catch {
      cfg = {};
    }
  }

  switch (step.type) {
    // ── run_script ──
    case 'run_script': {
      // The schema calls it `script`; this read `cfg.code`.
      //
      // `flow-step-schemas.ts` requires `script: z.string().min(1)`, so a step
      // that VALIDATES has no `code` — and the guard then returned the previous
      // output unchanged. The step could not run and the flow reported success:
      // the "failure that renders as a success" shape, sitting inside the
      // executor whose own `default:` branch was fixed for exactly that reason.
      //
      // Both names are accepted because `code` is what flows authored before the
      // schema existed carry in `zv_flow_steps.config`, and refusing those on
      // upgrade would break running flows in order to fix a typo.
      const source = cfg.script ?? cfg.code;
      if (!source) {
        // Not a silent skip. A run_script step with no script is a
        // misconfiguration, and saying so is what stops the flow reporting a run
        // in which nothing happened.
        throw new Error(
          `Step "${step.name}" is type run_script but carries no script. ` +
            'Expected `script` (or legacy `code`) in its config.',
        );
      }
      const scriptResult = await runScript(
        source,
        cfg.input ?? prevOutput,
        cfg.timeout_ms ?? 30_000,
        cfg.egress ?? null,
      );
      if (scriptResult.error) {
        throw new Error(`Script error in step "${step.name}": ${scriptResult.error}`);
      }
      return { output: scriptResult.output, logs: scriptResult.logs };
    }

    // ── send_email ──
    case 'send_email': {
      if (!cfg.to) return { output: prevOutput };

      // Validate email address to prevent header injection (newlines, commas)
      const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
      const recipient = String(cfg.to).trim();
      if (!EMAIL_RE.test(recipient)) {
        return { output: { sent: false, error: 'Invalid recipient email address' } };
      }
      // Sanitize subject — strip newlines to prevent header injection
      const subject = String(cfg.subject ?? 'Flow notification').replace(/[\r\n]/g, ' ');

      // A failed send fails the step, so the flow's on_error decides what
      // happens next — never a successful run with no email behind it.
      await sendEmail({
        to: recipient,
        subject,
        html: cfg.body_html ?? cfg.body ?? '',
        text: cfg.body ?? '',
      });
      return { output: { sent: true, to: recipient } };
    }

    // ── webhook ──
    case 'webhook': {
      if (!cfg.url) return { output: prevOutput };

      // The author's headers, less the ones no outbound request may set.
      const sanitizedHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      for (const [key, value] of Object.entries((cfg.headers as Record<string, string>) ?? {})) {
        if (isBlockedOutboundHeader(key)) {
          console.warn(`[Flow webhook] Blocked header injection attempt: "${key}"`);
          continue;
        }
        if (typeof value === 'string') sanitizedHeaders[key] = value;
      }

      // Timeout prevents a slow/hung server from blocking the flow scheduler.
      // cfg.timeout_ms is user-configurable; default 10s is safe for most webhooks.
      const timeoutMs = Math.min(Number(cfg.timeout_ms) || 10_000, 60_000);
      // SSRF protection: validate URL targets a public address before fetching
      validatePublicUrl(cfg.url as string);
      // A body is attached only when the method can carry one. `fetch` refuses
      // outright — "GET/HEAD/OPTIONS method cannot have body" — so a flow whose
      // webhook step was configured as a GET threw before it sent anything, and the
      // step failed with a TypeError about argument values rather than anything an
      // author could act on. The default is POST, which is why this went unseen.
      const method = String((cfg.method as string) ?? 'POST').toUpperCase();
      const carriesBody = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
      const response = await safeFetch(cfg.url as string, {
        method,
        headers: sanitizedHeaders,
        ...(carriesBody ? { body: JSON.stringify(cfg.body ?? prevOutput) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { output: { status: response.status, ok: response.ok } };
    }

    // ── send_notification ──
    case 'send_notification': {
      const notifBase = {
        title: cfg.title ?? 'Flow notification',
        message: cfg.message ?? '',
        type: cfg.type ?? 'info',
        action_url: cfg.action_url,
        source: 'flow',
      } as const;

      if (cfg.role) {
        const userIds = await getUsersForRole(db, cfg.role, flowTenantId);
        if (userIds.length > 0) {
          await sendNotification(db, { ...notifBase, user_id: userIds });
        }
        // Nobody holds the role: nothing was sent, and a step log that says
        // `sent: true` would record a delivery that did not happen.
        return {
          output: {
            sent: userIds.length > 0,
            sent_to: 'role',
            role: cfg.role,
            count: userIds.length,
          },
        };
      }

      if (cfg.user_id) {
        await sendNotification(db, { ...notifBase, user_id: cfg.user_id });
        return { output: { sent: true, sent_to: 'user', user_id: cfg.user_id } };
      }

      return { output: { sent: false, error: 'No role or user_id specified' } };
    }

    // ── export_collection ──
    case 'export_collection': {
      if (!cfg.collection) return { output: prevOutput };

      const SAFE_COLLECTION = /^[a-z][a-z0-9_]*$/;
      const rawCollection = cfg.collection.startsWith('zvd_')
        ? cfg.collection.slice(4)
        : cfg.collection;
      // Thrown, not returned as output: a run that exported nothing is a failed run.
      if (!SAFE_COLLECTION.test(rawCollection)) {
        throw new Error(`export_collection: invalid collection name "${cfg.collection}"`);
      }
      const limit = cfg.limit ?? 1000;
      if (!Number.isInteger(limit) || limit < 1 || limit > EXPORT_MAX_ROWS) {
        throw new Error(
          `export_collection: limit must be an integer from 1 to ${EXPORT_MAX_ROWS}, got ${JSON.stringify(cfg.limit)}`,
        );
      }

      // CSV only: the engine carries no spreadsheet writer, and the "excel"
      // format this step once advertised was never produced by anything.
      if ((cfg.format ?? 'csv') !== 'csv') {
        throw new Error(`export_collection: format "${cfg.format}" is not supported, use "csv"`);
      }

      // A collection, read the way REST reads it. The step ran `SELECT *` on the
      // engine's own connection with only `zveltio.current_tenant` set: a stock
      // install connects as a superuser, which FORCE RLS does not bind, so the
      // CSV carried every firm's rows, the `password` hash served to no one and
      // the search columns — and `collection: 'permissions'` exported the
      // instance's Casbin table. A tenant admin may author this step.
      //
      // Now: only a collection; `withTenantIsolation` drops to the request role
      // in the flow's firm, with no actor, as every background reader does; the
      // rows come through `selectReadable` (the masking view, named columns,
      // never a stale `SELECT *` plan); and what leaves is what any outbound
      // payload carries (`afterWrite`): no unserved column, no ciphertext.
      //
      // And as the flow's role (ADR 0004): with no actor the masking view and
      // the row rules stood down, so the CSV carried what a column or row rule
      // hides from the very admin who wrote the flow. Casbin is asked here for
      // the message; the collection-permission policy refuses it anyway.
      const def = await DDLManager.getCollection(db, rawCollection);
      if (!def) throw new Error(`export_collection: "${cfg.collection}" is not a collection`);
      const runAs = await requirePrincipal(principal);
      if (!runAs.allows(rawCollection, 'read')) {
        throw new Error(`export_collection: the flow's role may not read "${rawCollection}"`);
      }
      const tableName = DDLManager.getTableName(rawCollection);
      const { unserved, sealed } = withheldColumns(def);
      const withheld = new Set([...unserved, ...sealed]);
      const rows = await withTenantIsolation(
        flowTenantId,
        async (trx) => (await selectReadable(trx, tableName)).limit(limit).execute(),
        { identity: runAs.identity },
      );

      const columns: string[] | undefined = cfg.columns?.length
        ? (cfg.columns as string[]).filter((col) => !withheld.has(col))
        : undefined;
      const records = rows.map((r: Record<string, unknown>) =>
        columns
          ? Object.fromEntries(columns.map((col) => [col, r[col]]))
          : Object.fromEntries(Object.entries(r).filter(([col]) => !withheld.has(col))),
      );
      const csv = recordsToCsv(records);
      const filename = `${cfg.filename ?? cfg.collection}.csv`;

      if (cfg.email_to) {
        await sendEmail({
          to: cfg.email_to,
          subject: cfg.email_subject ?? `Report: ${cfg.collection}`,
          html: cfg.email_body ?? '<p>Please find the attached report.</p>',
          text: cfg.email_body ?? 'Please find the attached report.',
          attachments: [{ filename, content: csv, contentType: 'text/csv' }],
        });
        return { output: { exported: true, sent_to: cfg.email_to, rows: records.length } };
      }

      // No recipient: the file is the step's output, for the next step to use.
      return { output: { exported: true, rows: records.length, filename, csv } };
    }

    case 'condition': {
      // CEL over `trigger` and `output`, the same evaluator as validation rules.
      // The losing branch's steps are skipped; with no branches named, false
      // ends the run — "only if total > 10,000" is the case the Studio form
      // (expression only) can express. An expression that does not evaluate
      // to a boolean fails the step: a gate that cannot decide must not open.
      const verdict = evaluateCondition(String(cfg.expression ?? ''), {
        trigger: flowContext.trigger ?? null,
        output: prevOutput ?? null,
      });
      if (verdict.status === 'refused') {
        throw new Error(`Condition "${cfg.expression}" ${verdict.reason}`);
      }
      const passed = verdict.status === 'passed';
      const trueBranch: string[] = Array.isArray(cfg.true_branch) ? cfg.true_branch : [];
      const falseBranch: string[] = Array.isArray(cfg.false_branch) ? cfg.false_branch : [];
      const stop = !passed && trueBranch.length === 0 && falseBranch.length === 0;
      return {
        output: prevOutput,
        logs: [`condition ${passed}${stop ? ': run ends here' : ''}`],
        skip: passed ? falseBranch : trueBranch,
        stop,
        branches: [...trueBranch, ...falseBranch],
      };
    }

    default:
      // Was `return { output: prevOutput }` — success, silently, passing the
      // previous step's output straight through. The Studio offers step types
      // this switch does not implement (`create_record`, `update_record`), so
      // a flow reading "if total > 10,000 then create an approval" ran green
      // and did nothing at all. A conditional that always
      // proceeds is worse than one that fails: the run is recorded successful
      // and nobody looks at it again.
      throw new Error(
        `Flow step type "${step.type}" is not implemented. Implemented types: ` +
          `${EXECUTABLE_STEP_TYPES.join(', ')}.`,
      );
  }
}

function requirePrincipal(
  principal: (() => Promise<RolePrincipal>) | undefined,
): Promise<RolePrincipal> {
  if (!principal) throw new Error('Flow step has no role to run as (ADR 0004)');
  return principal();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Execute a flow by ID.
 * Creates a run record, executes all steps in order, and updates the record.
 * Respects `on_error: 'continue' | 'stop'` per step.
 */
export async function executeFlow(
  db: Database,
  flowId: string,
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  triggerData: any = {},
  /** A run row its caller already claimed (a data trigger's, keyed by its event). */
  claimedRunId?: string,
): Promise<FlowRunResult> {
  let runId: string;
  try {
    const id =
      claimedRunId ??
      (
        await sql<{ id: string }>`
          INSERT INTO zv_flow_runs (flow_id, status, trigger_data)
          VALUES (${flowId}, 'running', ${toJsonb(triggerData)})
          RETURNING id::text
        `.execute(db)
      ).rows[0]?.id;
    if (!id) throw new Error('Failed to create run record');
    runId = id;
  } catch (err) {
    return { runId: '', status: 'failed', output: {}, error: String(err) };
  }

  // Load steps
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  let steps: any[] = [];
  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const stepsResult = await sql<any>`
      SELECT * FROM zv_flow_steps
      WHERE flow_id = ${flowId}
      ORDER BY step_order
    `.execute(db);
    steps = stepsResult.rows;
  } catch (err) {
    await sql`
      UPDATE zv_flow_runs
      SET status = 'failed', error = ${String(err)}, finished_at = NOW()
      WHERE id = ${runId}
    `
      .execute(db)
      .catch((bookkeepingErr: Error) => {
        console.warn(
          `[flow-executor] failed to mark run ${runId} as failed:`,
          bookkeepingErr.message,
        );
      });
    return { runId, status: 'failed', output: {}, error: String(err) };
  }

  // Execute steps
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  let output: any = {};
  const stepLogs: Record<string, string[]> = {};
  const flowContext = { trigger: triggerData };

  // Authoritative tenant for this run's data access: the flow's OWN tenant_id.
  // Every caller (manual run, cron scheduler, DLQ retry, data-event trigger) goes
  // through here, so resolving it from the flow row — rather than trusting
  // triggerData — closes both the "runs as default tenant" leak and the
  // "caller spoofs trigger.tenantId" escalation.
  //
  // Read across every firm: `zv_flows` is under the tenant policy (migration
  // 027), and on the bare pool a non-superuser database hides every other firm's
  // row — the lookup found nothing and a firm's flow ran as the DEFAULT firm.
  //
  // Fail closed. This used to keep the default tenant when the lookup failed or
  // found no row, so a flow this connection cannot see — its firm gone from
  // `zv_tenants`, a lookup that errored — ran its steps with the default firm's
  // data. Not knowing whose flow it is means not running it.
  //
  // And the role it runs as (ADR 0004), resolved in that firm. None — the role
  // was deleted (`deleteRole` clears it) — or one that cannot be resolved
  // refuses the run: a flow with no principal is the bypass ADR 0004 closed.
  let flowTenantId: string | undefined;
  let role: string | null | undefined;
  let lookupError = 'the flow row is not visible';
  try {
    const tRow = await withEveryTenant(db, (trx) =>
      sql<{ tenant_id: string; run_as_role: string | null }>`
      SELECT run_as_role, tenant_id::text AS tenant_id FROM zv_flows WHERE id = ${flowId}
    `.execute(trx),
    );
    flowTenantId = tRow.rows[0]?.tenant_id || undefined;
    role = tRow.rows[0]?.run_as_role;
    if (flowTenantId && !role) {
      lookupError = 'it has no run_as_role: its role was deleted; save it with a role';
    }
  } catch (err) {
    lookupError = String(err);
  }
  if (!flowTenantId || !role) {
    const error = flowTenantId
      ? `Flow ${flowId}: cannot resolve the role it runs as (${lookupError}) — refusing to run it.`
      : `Flow ${flowId}: cannot resolve the tenant it runs as (${lookupError}) — ` +
        'refusing to run it as the default tenant.';
    await sql`
      UPDATE zv_flow_runs
      SET status = 'failed', error = ${error}, finished_at = NOW()
      WHERE id = ${runId}
    `
      .execute(db)
      .catch((bookkeepingErr: Error) => {
        console.warn(
          `[flow-executor] failed to mark run ${runId} as failed:`,
          bookkeepingErr.message,
        );
      });
    return { runId, status: 'failed', output: {}, error };
  }

  const runAsRole = role;
  const tenant = flowTenantId;
  let resolved: Promise<RolePrincipal> | undefined;
  const principal = () => (resolved ??= runWithDomain(tenant, () => rolePrincipal(runAsRole)));

  try {
    for (const step of steps) {
      const removed = REMOVED_STEP_TYPES.get(step.type);
      if (removed) {
        throw new Error(
          `Flow step "${step.name}" is type ${step.type}, which the engine no longer runs: ` +
            `${removed}. Nothing in this run was executed.`,
        );
      }
    }
    const skipped = new Set<string>();
    for (const [index, step] of steps.entries()) {
      if (step.id && skipped.has(step.id)) continue;
      try {
        const result = await traced(
          `flow.step.${step.type}`,
          {
            'flow.id': flowId,
            'flow.step.id': step.id || step.name || 'unknown',
            'flow.step.type': step.type,
          },
          () => executeStep(db, step, output, flowContext, flowTenantId, principal),
        );
        output = result.output;
        if (result.logs?.length) stepLogs[step.id] = result.logs;
        if (result.branches) {
          // A branch can only name a step after the condition in this flow. Any
          // other id skips nothing, so the steps it was meant to gate would run.
          // ponytail: checked at run time; save time sees one step, not the flow.
          const later = new Set(steps.slice(index + 1).map((s: { id?: string }) => s.id));
          const stray = result.branches.filter((id) => !later.has(id));
          if (stray.length > 0) {
            throw new Error(
              `Condition branch names ${stray.join(', ')}, which is not a later step of this flow`,
            );
          }
        }
        for (const id of result.skip ?? []) skipped.add(id);
        if (result.stop) break;
      } catch (stepErr) {
        // A condition that cannot decide stops the run whatever on_error says:
        // continuing would run both branches, which is the gate opening.
        if (step.on_error === 'continue' && step.type !== 'condition') {
          output = { error: String(stepErr), step: step.name };
          continue;
        }
        // on_error === 'stop' (default): propagate
        throw stepErr;
      }
    }

    const finalOutput =
      Object.keys(stepLogs).length > 0 ? { ...output, _step_logs: stepLogs } : output;

    await sql`
      UPDATE zv_flow_runs
      SET status = 'success',
          output = ${toJsonb(finalOutput)},
          finished_at = NOW()
      WHERE id = ${runId}
    `
      .execute(db)
      .catch((bookkeepingErr: Error) => {
        console.warn(
          `[flow-executor] failed to mark run ${runId} as success:`,
          bookkeepingErr.message,
        );
      });

    return { runId, status: 'success', output: finalOutput };
  } catch (err) {
    await sql`
      UPDATE zv_flow_runs
      SET status = 'failed', error = ${String(err)}, finished_at = NOW()
      WHERE id = ${runId}
    `
      .execute(db)
      .catch((bookkeepingErr: Error) => {
        console.warn(
          `[flow-executor] failed to mark run ${runId} as failed:`,
          bookkeepingErr.message,
        );
      });

    return { runId, status: 'failed', output, error: String(err) };
  }
}

/** Test-only export — never import outside src/tests/. */
export const _internalForTests = { executeStep };
