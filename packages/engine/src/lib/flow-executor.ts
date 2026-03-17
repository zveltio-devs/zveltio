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
import type { Database } from '../db/index.js';
import { runScript } from './script-runner.js';
import { sendNotification } from '../routes/notifications.js';
import { aiProviderManager } from './ai-provider.js';
import { traced } from './telemetry.js';

export interface FlowRunResult {
  runId: string;
  status: 'success' | 'failed';
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
function interpolateTemplate(template: string, context: Record<string, any>): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, path) => {
    const keys = path.split('.');
    let value: any = context;
    for (const key of keys) {
      value = value?.[key];
      if (value === undefined) return match; // Leave placeholder if key not found
    }
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
}

// ── Step executor ─────────────────────────────────────────────────────────────

async function executeStep(
  db: Database,
  step: any,
  prevOutput: any,
  flowContext: Record<string, any> = {},
): Promise<{ output: any; logs?: string[] }> {
  const cfg = step.config ?? {};

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

      // Execute with statement_timeout to prevent long-running queries
      const result = await sql.raw(
        `SET LOCAL statement_timeout = '10s'; ${cfg.query}`,
      ).execute(db);
      return { output: result.rows };
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
      try {
        // @ts-ignore — email module is an optional extension
        const { sendEmailDirectly } = await import('./email.js');
        await sendEmailDirectly({
          recipient: cfg.to,
          subject: cfg.subject ?? 'Flow notification',
          bodyHtml: cfg.body_html ?? cfg.body ?? '',
          bodyText: cfg.body ?? '',
        });
        return { output: { sent: true, to: cfg.to } };
      } catch {
        return { output: { sent: false, error: 'Email service not configured' } };
      }
    }

    // ── webhook ──
    case 'webhook': {
      if (!cfg.url) return { output: prevOutput };

      // Security: sanitize user-supplied headers — block credential injection.
      const BLOCKED_HEADERS = new Set([
        'authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token',
        'x-forwarded-for', 'x-real-ip', 'x-zveltio-internal', 'host', 'origin', 'referer',
      ]);
      const sanitizedHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      for (const [key, value] of Object.entries((cfg.headers as Record<string, string>) ?? {})) {
        if (BLOCKED_HEADERS.has(key.toLowerCase())) {
          console.warn(`[Flow webhook] Blocked header injection attempt: "${key}"`);
          continue;
        }
        if (typeof value === 'string') sanitizedHeaders[key] = value;
      }

      const response = await fetch(cfg.url as string, {
        method: (cfg.method as string) ?? 'POST',
        headers: sanitizedHeaders,
        body: JSON.stringify(cfg.body ?? prevOutput),
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
      try {
        // @ts-ignore — export-manager is an optional extension
        const { ExportManager } = await import('./export-manager.js');
        const tableName = cfg.collection.startsWith('zvd_')
          ? cfg.collection
          : `zvd_${cfg.collection}`;

        const rows = await sql<any>`
          SELECT * FROM ${sql.raw(tableName)}
          LIMIT ${cfg.limit ?? 1000}
        `.execute(db);

        const exportResult = await ExportManager.export(rows.rows, {
          format: cfg.format ?? 'csv',
          filename: cfg.filename ?? `${cfg.collection}-export`,
          columns: cfg.columns,
        });

        if (cfg.email_to && exportResult?.buffer) {
          // @ts-ignore — email module is an optional extension
          const { sendEmailWithAttachment } = await import('./email.js');
          const ext = cfg.format === 'excel' ? 'xlsx' : (cfg.format ?? 'csv');
          await sendEmailWithAttachment({
            recipient: cfg.email_to,
            subject: cfg.email_subject ?? `Report: ${cfg.collection}`,
            bodyHtml: cfg.email_body ?? '<p>Please find the attached report.</p>',
            bodyText: cfg.email_body ?? 'Please find the attached report.',
            attachment: {
              filename: `${cfg.filename ?? cfg.collection}.${ext}`,
              content: exportResult.buffer,
              contentType: cfg.format === 'excel'
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

      const provider = aiProviderManager.getDefault();
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
  let steps: any[] = [];
  try {
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
    `.execute(db).catch(() => {});
    return { runId, status: 'failed', output: {}, error: String(err) };
  }

  // Execute steps
  let output: any = {};
  const stepLogs: Record<string, string[]> = {};
  const stepResults: Record<string, any> = {};
  const flowContext = { trigger: triggerData, stepResults };

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
          () => executeStep(db, step, output, flowContext),
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

    const finalOutput = Object.keys(stepLogs).length > 0
      ? { ...output, _step_logs: stepLogs }
      : output;

    await sql`
      UPDATE zv_flow_runs
      SET status = 'success',
          output = ${JSON.stringify(finalOutput)}::jsonb,
          finished_at = NOW()
      WHERE id = ${runId}
    `.execute(db).catch(() => {});

    return { runId, status: 'success', output: finalOutput };
  } catch (err) {
    await sql`
      UPDATE zv_flow_runs
      SET status = 'failed', error = ${String(err)}, finished_at = NOW()
      WHERE id = ${runId}
    `.execute(db).catch(() => {});

    return { runId, status: 'failed', output, error: String(err) };
  }
}
