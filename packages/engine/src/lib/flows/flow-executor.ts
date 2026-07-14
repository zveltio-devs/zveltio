/**
 * Flow Executor — runs the steps of a Zveltio automation flow.
 *
 * Supports step types:
 *   query_db          — execute a raw SQL query and pass rows as output
 *   run_script        — run sandboxed JS via script-runner
 *   send_email        — send email via email lib (graceful no-op if not configured)
 *   webhook           — HTTP call to an external URL
 *   send_notification — in-app notification to a user or role
 *   export_collection — export collection rows to CSV/Excel, optionally email the file
 *
 * Called by:
 *   - flowsRoutes POST /:id/run   (manual trigger via API)
 *   - flowScheduler._executeFlow  (cron trigger)
 */

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DEFAULT_TENANT_ID } from '../tenancy/index.js';
import { runScript } from '../script-runner.js';
import { sendNotification } from '../../routes/notifications.js';
import { serviceRegistry } from '../service-registry.js';
import { traced } from '../runtime/index.js';
import { safeFetch, validatePublicUrl } from '../edge-functions/safe-fetch.js';

export interface FlowRunResult {
  runId: string;
  status: 'success' | 'failed';
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  output: any;
  error?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve user IDs that belong to a Casbin role (ptype='g'). */
async function getUsersForRole(db: Database, role: string): Promise<string[]> {
  try {
    const rows = await sql<{ v0: string }>`
      SELECT v0 FROM zvd_permissions WHERE ptype = 'g' AND v1 = ${role}
    `.execute(db);
    return rows.rows.map((r) => r.v0);
  } catch {
    return [];
  }
}

/** Replaces {{key.nested}} placeholders from a context object. */
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
function interpolateTemplate(template: string, context: Record<string, any>): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, path) => {
    const keys = path.split('.');
    // Security: block prototype chain traversal (e.g. {{__proto__.polluted}})
    if (keys.some((k: string) => k === '__proto__' || k === 'constructor' || k === 'prototype')) {
      return match;
    }
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    let value: any = context;
    for (const key of keys) {
      if (!Object.hasOwn(value, key)) return match;
      value = value[key];
      if (value === undefined || value === null) return match;
    }
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
}

// ── Step executor ─────────────────────────────────────────────────────────────

async function executeStep(
  db: Database,
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  step: any,
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  prevOutput: any,
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  flowContext: Record<string, any> = {},
  // Tenant for any collection-data access in this step (query_db / export_collection
  // run inside a `set_config('zveltio.current_tenant', …)` transaction, and collection
  // tables are FORCE-RLS'd). This is the flow's OWN tenant, resolved by executeFlow —
  // NOT derived from caller-supplied trigger data, which a caller could set to another
  // tenant's id to read/export across tenants.
  flowTenantId: string = DEFAULT_TENANT_ID,
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
): Promise<{ output: any; logs?: string[] }> {
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
    // ── query_db ──
    case 'query_db': {
      if (!cfg.query) return { output: prevOutput };

      // Security: only SELECT/WITH statements permitted — blocks DML/DDL injection.
      const trimmed = (cfg.query as string).trim().toUpperCase();
      if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('WITH')) {
        throw new Error(
          'Flow query_db step only allows SELECT or WITH (read-only) statements. ' +
            'Use update_record or insert_record step types for writes.',
        );
      }

      // Block dangerous SQL patterns even inside SELECT
      const DANGEROUS_PATTERNS = [
        /;\s*(DROP|DELETE|UPDATE|INSERT|CREATE|ALTER|TRUNCATE|GRANT|REVOKE)/i,
        /pg_sleep/i,
        /pg_read_file/i,
        /pg_write_file/i,
        /copy\s+.*\s+to\s+/i,
        /copy\s+.*\s+from\s+/i,
        /lo_export/i,
        /lo_import/i,
      ];
      for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(cfg.query as string)) {
          throw new Error('Flow query_db: blocked dangerous SQL pattern.');
        }
      }

      // Execute with statement_timeout to prevent long-running queries.
      // SET LOCAL only takes effect inside a transaction, AND `.execute(db)`
      // can hand out a different pool connection per call — so the timeout
      // MUST live in the same transaction as the user query, otherwise a
      // cartesian join can monopolise a pool connection indefinitely.
      const result = await db.transaction().execute(async (trx: Database) => {
        await sql`SELECT set_config('zveltio.current_tenant', ${flowTenantId}, true)`.execute(trx);
        await sql.raw(`SET LOCAL statement_timeout = '10s'`).execute(trx);
        return sql.raw(cfg.query as string).execute(trx);
      });
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      return { output: (result as any).rows };
    }

    // ── run_script ──
    case 'run_script': {
      if (!cfg.code) return { output: prevOutput };
      const scriptResult = await runScript(
        cfg.code,
        cfg.input ?? prevOutput,
        cfg.timeout_ms ?? 30_000,
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

      try {
        // @ts-ignore — email module is an optional extension
        const { sendEmailDirectly } = await import('../email.js');
        await sendEmailDirectly({
          recipient,
          subject,
          bodyHtml: cfg.body_html ?? cfg.body ?? '',
          bodyText: cfg.body ?? '',
        });
        return { output: { sent: true, to: recipient } };
      } catch {
        return { output: { sent: false, error: 'Email service not configured' } };
      }
    }

    // ── webhook ──
    case 'webhook': {
      if (!cfg.url) return { output: prevOutput };

      // Security: sanitize user-supplied headers — block credential injection.
      const BLOCKED_HEADERS = new Set([
        'authorization',
        'cookie',
        'set-cookie',
        'x-api-key',
        'x-auth-token',
        'x-forwarded-for',
        'x-real-ip',
        'x-zveltio-internal',
        'host',
        'origin',
        'referer',
      ]);
      const sanitizedHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      for (const [key, value] of Object.entries((cfg.headers as Record<string, string>) ?? {})) {
        if (BLOCKED_HEADERS.has(key.toLowerCase())) {
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
      const response = await safeFetch(cfg.url as string, {
        method: (cfg.method as string) ?? 'POST',
        headers: sanitizedHeaders,
        body: JSON.stringify(cfg.body ?? prevOutput),
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
        const userIds = await getUsersForRole(db, cfg.role);
        if (userIds.length > 0) {
          await sendNotification(db, { ...notifBase, user_id: userIds });
        }
        return { output: { sent: true, sent_to: 'role', role: cfg.role, count: userIds.length } };
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
      if (!SAFE_COLLECTION.test(rawCollection)) {
        return { output: { error: `Invalid collection name: "${cfg.collection}"` } };
      }

      try {
        // @ts-ignore — export-manager is an optional extension
        const { ExportManager } = await import('../export-manager.js');

        const tableName = `zvd_${rawCollection}`;

        // sql.id() quotes the identifier — safe against injection even if validation
        // were somehow bypassed; sql.raw() was previously used here (vulnerability).
        // Run inside a tenant transaction so FORCE-RLS'd collection rows are
        // visible (and scoped to this flow's tenant).
        const rows = await db.transaction().execute(async (trx: Database) => {
          await sql`SELECT set_config('zveltio.current_tenant', ${flowTenantId}, true)`.execute(
            trx,
          );
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
          return sql<any>`
            SELECT * FROM ${sql.id(tableName)}
            LIMIT ${cfg.limit ?? 1000}
          `.execute(trx);
        });

        const exportResult = await ExportManager.export(rows.rows, {
          format: cfg.format ?? 'csv',
          filename: cfg.filename ?? `${cfg.collection}-export`,
          columns: cfg.columns,
        });

        if (cfg.email_to && exportResult?.buffer) {
          // @ts-ignore — email module is an optional extension
          const { sendEmailWithAttachment } = await import('../email.js');
          const ext = cfg.format === 'excel' ? 'xlsx' : (cfg.format ?? 'csv');
          await sendEmailWithAttachment({
            recipient: cfg.email_to,
            subject: cfg.email_subject ?? `Report: ${cfg.collection}`,
            bodyHtml: cfg.email_body ?? '<p>Please find the attached report.</p>',
            bodyText: cfg.email_body ?? 'Please find the attached report.',
            attachment: {
              filename: `${cfg.filename ?? cfg.collection}.${ext}`,
              content: exportResult.buffer,
              contentType:
                cfg.format === 'excel'
                  ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                  : 'text/csv',
            },
          });
          return { output: { exported: true, sent_to: cfg.email_to, rows: rows.rows.length } };
        }

        return { output: { exported: true, rows: rows.rows.length } };
      } catch {
        return { output: { exported: false, error: 'Export service not configured' } };
      }
    }

    // ── ai_decision ──
    case 'ai_decision': {
      const { prompt, options, fallback, temperature } = cfg;
      if (!prompt || !Array.isArray(options) || options.length === 0) {
        return { output: { decision: fallback ?? null, error: 'Missing prompt or options' } };
      }

      const interpolatedPrompt = interpolateTemplate(prompt, {
        ...flowContext,
        output: prevOutput,
      });

      type ChatProvider = {
        chat?: (
          messages: unknown[],
          opts?: unknown,
        ) => Promise<{ content?: string; usage?: unknown }>;
      };
      const aiProviders = serviceRegistry.get<{ getDefault(): ChatProvider | null }>(
        'ai.providers',
      );
      if (!aiProviders) {
        console.warn('[Flow] ai_decision: AI extension is not active, using fallback');
        return {
          output: { decision: fallback, usedFallback: true, error: 'AI extension not active' },
        };
      }
      const provider = aiProviders.getDefault();
      if (!provider?.chat) {
        console.warn('[Flow] ai_decision: no AI provider configured, using fallback');
        return { output: { decision: fallback, usedFallback: true, error: 'No AI provider' } };
      }

      try {
        const systemPrompt =
          `You are a decision engine. Analyze the context and choose EXACTLY ONE option.\n` +
          `Available options: ${options.join(', ')}\n` +
          `Respond with ONLY the option name, nothing else. No explanation, no punctuation.`;

        const aiResponse = await provider.chat(
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: interpolatedPrompt },
          ],
          { temperature: temperature ?? 0.1 },
        );

        const decision = (aiResponse?.content ?? '').trim().toLowerCase();
        const matchedOption = options.find((opt: string) => opt.toLowerCase() === decision);
        const finalDecision = matchedOption ?? fallback;

        console.log(
          `🤖 AI Decision [${step.id ?? step.name}]: "${decision}" → ${finalDecision}` +
            (matchedOption ? '' : ` (fallback, AI said: "${decision}")`),
        );

        return {
          output: {
            decision: finalDecision,
            aiRawResponse: decision,
            matched: !!matchedOption,
            usedFallback: !matchedOption,
          },
        };
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      } catch (err: any) {
        console.error(`🤖 AI Decision failed [${step.id ?? step.name}]:`, err);
        return {
          output: {
            decision: fallback,
            error: err.message,
            usedFallback: true,
          },
        };
      }
    }

    default:
      return { output: prevOutput };
  }
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
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  triggerData: any = {},
): Promise<FlowRunResult> {
  // Create run record
  let runId: string;
  try {
    const runRow = await sql<{ id: string }>`
      INSERT INTO zv_flow_runs (flow_id, status, trigger_data)
      VALUES (${flowId}, 'running', ${JSON.stringify(triggerData)}::jsonb)
      RETURNING id::text
    `.execute(db);
    runId = runRow.rows[0]?.id;
    if (!runId) throw new Error('Failed to create run record');
  } catch (err) {
    return { runId: '', status: 'failed', output: {}, error: String(err) };
  }

  // Load steps
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  let steps: any[] = [];
  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  let output: any = {};
  const stepLogs: Record<string, string[]> = {};
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  const stepResults: Record<string, any> = {};
  const flowContext = { trigger: triggerData, stepResults };

  // Authoritative tenant for this run's data access: the flow's OWN tenant_id.
  // Every caller (manual run, cron scheduler, DLQ retry, data-event trigger) goes
  // through here, so resolving it from the flow row — rather than trusting
  // triggerData — closes both the "runs as default tenant" leak and the
  // "caller spoofs trigger.tenantId" escalation. Best-effort: falls back to the
  // default tenant if the lookup fails (a missing flow fails later on the run FK).
  let flowTenantId = DEFAULT_TENANT_ID;
  try {
    const tRow = await sql<{ tenant_id: string }>`
      SELECT tenant_id::text AS tenant_id FROM zv_flows WHERE id = ${flowId}
    `.execute(db);
    if (tRow.rows[0]?.tenant_id) flowTenantId = tRow.rows[0].tenant_id;
  } catch {
    // keep default tenant
  }

  try {
    for (const step of steps) {
      try {
        const result = await traced(
          `flow.step.${step.type}`,
          {
            'flow.id': flowId,
            'flow.step.id': step.id || step.name || 'unknown',
            'flow.step.type': step.type,
          },
          () => executeStep(db, step, output, flowContext, flowTenantId),
        );
        output = result.output;
        if (step.id) stepResults[step.id] = output;
        if (result.logs?.length) stepLogs[step.id] = result.logs;
      } catch (stepErr) {
        if (step.on_error === 'continue') {
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
          output = ${JSON.stringify(finalOutput)}::jsonb,
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
