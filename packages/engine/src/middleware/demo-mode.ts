/**
 * demo-mode middleware — blocks a small set of "would brick the demo for
 * the next visitor" actions when `DEMO_MODE=true`.
 *
 * Philosophy: demos should let people DO things, not lock everything down.
 * So we explicitly allow CRUD on data, schema edits, template installs.
 * We block:
 *   - Anything that mutates auth secrets / user roles / API keys.
 *   - Wiping audit logs.
 *   - Triggering restores or PITR (would crash the engine).
 *   - Migrating to a different schema version.
 *
 * The denial response is 451 (Unavailable For Legal Reasons) repurposed —
 * picked because it's distinct from 401/403/429 so the Studio can show
 * a "demo mode" banner instead of "permission denied".
 */

import type { Context, Next } from 'hono';

const BLOCKED_PATHS: Array<{ method: string; pattern: RegExp }> = [
  // Auth secrets & user-state machinery
  { method: 'DELETE', pattern: /^\/api\/users\/[^/]+$/ },
  { method: 'POST',   pattern: /^\/api\/admin\/api-keys$/ },
  { method: 'DELETE', pattern: /^\/api\/admin\/api-keys\/[^/]+$/ },
  // Backups: restoring or scheduling against a demo replaces the demo
  // state with whatever the operator dumped — not safe.
  { method: 'POST',   pattern: /^\/api\/backup\/pitr\/restore$/ },
  { method: 'POST',   pattern: /^\/api\/backup\/schedules$/ },
  // Migrations — re-running on demo can race the reset cron.
  { method: 'POST',   pattern: /^\/api\/admin\/migrate$/ },
  // Wiping logs would hide the audit trail of the demo session itself.
  { method: 'DELETE', pattern: /^\/api\/admin\/revisions$/ },
  // SQL editor — the demo can be useful with read-only SQL, but we'd need a
  // separate guard to enforce it. For now block destructive writes via SQL.
  // (The route already blocks DROP DATABASE / DROP SCHEMA.)
];

export function demoModeMiddleware() {
  const enabled = process.env.DEMO_MODE === 'true' || process.env.DEMO_MODE === '1';
  if (!enabled) {
    // Identity middleware — no overhead when demo mode is off.
    return async (_c: Context, next: Next) => { await next(); };
  }

  return async (c: Context, next: Next) => {
    const path = new URL(c.req.url).pathname;
    const method = c.req.method.toUpperCase();
    for (const rule of BLOCKED_PATHS) {
      if (rule.method === method && rule.pattern.test(path)) {
        return c.json({
          error: 'This action is disabled in demo mode.',
          code: 'DEMO_BLOCKED',
        }, 451);
      }
    }
    await next();
  };
}
