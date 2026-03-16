/**
 * AI Analytics Routes
 *
 * GET  /api/ai-analytics/summary         — overall stats for a time range
 * GET  /api/ai-analytics/by-provider     — breakdown by provider
 * GET  /api/ai-analytics/daily           — daily token/request trends
 * GET  /api/ai-analytics/by-operation    — breakdown by operation type (chat, embed…)
 * GET  /api/ai-analytics/top-users       — top users by token consumption
 * GET  /api/ai-analytics/recommendations — cost/reliability recommendations
 *
 * All endpoints: authenticated users; top-users + recommendations require admin.
 */

import { Hono } from 'hono';
import { sql } from 'kysely';
import { checkPermission } from '../../../../packages/engine/src/lib/permissions.js';

async function getUser(c: any, auth: any) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

async function getAdmin(c: any, auth: any) {
  const user = await getUser(c, auth);
  if (!user) return null;
  const isAdmin = await checkPermission(user.id, 'admin', '*');
  return isAdmin ? user : null;
}

function parseDays(range: string): number {
  const map: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90 };
  return map[range] ?? parseInt(range) || 30;
}

export function aiAnalyticsRoutes(db: any, auth: any): Hono {
  const app = new Hono();

  // GET /summary — overall stats
  app.get('/summary', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const range = c.req.query('range') || '30d';
    const days = parseDays(range);
    const since = new Date(Date.now() - days * 86_400_000);

    const summary = await sql<{
      total_requests: string;
      total_tokens: string;
      avg_latency: string;
      top_provider: string;
    }>`
      SELECT
        COUNT(*)::text                                            AS total_requests,
        COALESCE(SUM(prompt_tokens + response_tokens), 0)::text  AS total_tokens,
        ROUND(AVG(latency_ms))::text                             AS avg_latency,
        (
          SELECT provider
          FROM zv_ai_usage
          WHERE created_at >= ${since.toISOString()}
          GROUP BY provider
          ORDER BY COUNT(*) DESC
          LIMIT 1
        )                                                         AS top_provider
      FROM zv_ai_usage
      WHERE created_at >= ${since.toISOString()}
    `.execute(db).then((r) => r.rows[0]).catch(() => ({
      total_requests: '0', total_tokens: '0', avg_latency: '0', top_provider: null,
    }));

    return c.json({ summary, range });
  });

  // GET /by-provider — breakdown per provider
  app.get('/by-provider', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const days = parseDays(c.req.query('range') || '30d');
    const since = new Date(Date.now() - days * 86_400_000);

    const byProvider = await sql<{
      provider: string;
      requests: string;
      total_tokens: string;
      avg_latency: string;
    }>`
      SELECT
        provider,
        COUNT(*)::text                                           AS requests,
        COALESCE(SUM(prompt_tokens + response_tokens), 0)::text  AS total_tokens,
        ROUND(AVG(latency_ms))::text                             AS avg_latency
      FROM zv_ai_usage
      WHERE created_at >= ${since.toISOString()}
      GROUP BY provider
      ORDER BY requests DESC
    `.execute(db).then((r) => r.rows).catch(() => []);

    return c.json({ providers: byProvider });
  });

  // GET /daily — daily request + token trends
  app.get('/daily', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const days = parseDays(c.req.query('range') || '30d');
    const since = new Date(Date.now() - days * 86_400_000);

    const daily = await sql<{
      date: string;
      requests: string;
      total_tokens: string;
    }>`
      SELECT
        DATE_TRUNC('day', created_at)::date::text  AS date,
        COUNT(*)::text                              AS requests,
        COALESCE(SUM(prompt_tokens + response_tokens), 0)::text AS total_tokens
      FROM zv_ai_usage
      WHERE created_at >= ${since.toISOString()}
      GROUP BY DATE_TRUNC('day', created_at)
      ORDER BY date ASC
    `.execute(db).then((r) => r.rows).catch(() => []);

    return c.json({ daily });
  });

  // GET /by-operation — breakdown by operation type
  app.get('/by-operation', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const days = parseDays(c.req.query('range') || '30d');
    const since = new Date(Date.now() - days * 86_400_000);

    const byOperation = await sql<{
      operation: string;
      requests: string;
      total_tokens: string;
      avg_latency: string;
    }>`
      SELECT
        operation,
        COUNT(*)::text                                           AS requests,
        COALESCE(SUM(prompt_tokens + response_tokens), 0)::text  AS total_tokens,
        ROUND(AVG(latency_ms))::text                             AS avg_latency
      FROM zv_ai_usage
      WHERE created_at >= ${since.toISOString()}
      GROUP BY operation
      ORDER BY requests DESC
    `.execute(db).then((r) => r.rows).catch(() => []);

    return c.json({ operations: byOperation });
  });

  // GET /top-users — admin only
  app.get('/top-users', async (c) => {
    const user = await getAdmin(c, auth);
    if (!user) return c.json({ error: 'Admin access required' }, 403);

    const days = parseDays(c.req.query('range') || '30d');
    const limit = Math.min(parseInt(c.req.query('limit') || '10'), 50);
    const since = new Date(Date.now() - days * 86_400_000);

    const topUsers = await sql<{
      user_id: string;
      user_name: string;
      requests: string;
      total_tokens: string;
    }>`
      SELECT
        u.user_id,
        COALESCE(usr.name, u.user_id) AS user_name,
        COUNT(*)::text                 AS requests,
        COALESCE(SUM(u.prompt_tokens + u.response_tokens), 0)::text AS total_tokens
      FROM zv_ai_usage u
      LEFT JOIN "user" usr ON usr.id::text = u.user_id::text
      WHERE u.created_at >= ${since.toISOString()}
      GROUP BY u.user_id, usr.name
      ORDER BY total_tokens DESC
      LIMIT ${limit}
    `.execute(db).then((r) => r.rows).catch(() => []);

    return c.json({ users: topUsers });
  });

  // GET /recommendations — admin only, cost/reliability tips
  app.get('/recommendations', async (c) => {
    const user = await getAdmin(c, auth);
    if (!user) return c.json({ error: 'Admin access required' }, 403);

    const recommendations: Array<{
      type: string;
      priority: 'high' | 'medium' | 'low';
      message: string;
      potential_saving?: string;
    }> = [];

    // Detect low-token requests going to expensive cloud providers
    const smallCloudRequests = await sql<{ provider: string; avg_tokens: string }>`
      SELECT
        provider,
        ROUND(AVG(prompt_tokens + response_tokens))::text AS avg_tokens
      FROM zv_ai_usage
      WHERE created_at >= NOW() - INTERVAL '7 days'
        AND provider IN ('openai', 'anthropic')
      GROUP BY provider
      HAVING AVG(prompt_tokens + response_tokens) < 200
    `.execute(db).then((r) => r.rows).catch(() => []);

    for (const row of smallCloudRequests) {
      recommendations.push({
        type: 'provider_optimization',
        priority: 'high',
        message: `${row.provider} is being used for small requests (avg ${row.avg_tokens} tokens). ` +
          `Consider routing simple queries to a local Ollama model.`,
        potential_saving: '40-70% on AI costs',
      });
    }

    // Detect high latency
    const highLatency = await sql<{ provider: string; avg_latency: string }>`
      SELECT
        provider,
        ROUND(AVG(latency_ms))::text AS avg_latency
      FROM zv_ai_usage
      WHERE created_at >= NOW() - INTERVAL '7 days'
      GROUP BY provider
      HAVING AVG(latency_ms) > 5000
    `.execute(db).then((r) => r.rows).catch(() => []);

    for (const row of highLatency) {
      recommendations.push({
        type: 'performance',
        priority: 'medium',
        message: `${row.provider} has high average latency (${row.avg_latency} ms). Check your network or API quotas.`,
      });
    }

    if (recommendations.length === 0) {
      recommendations.push({
        type: 'info',
        priority: 'low',
        message: 'No optimization recommendations at this time. Your AI setup looks healthy.',
      });
    }

    return c.json({ recommendations });
  });

  return app;
}
