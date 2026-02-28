/**
 * GraphQL auto-generated API
 *
 * Generates a GraphQL schema from the active collections and exposes:
 *   GET  /api/graphql        — GraphQL Playground (HTML)
 *   POST /api/graphql        — Execute GraphQL query
 *   GET  /api/graphql/schema — SDL schema as plain text
 *
 * No external graphql package required — uses a lightweight inline executor
 * that handles list queries and single-record lookups for all collections.
 */

import { Hono } from 'hono';
import type { Database } from '../db/index.js';
import { DDLManager } from '../lib/ddl-manager.js';
import { checkPermission } from '../lib/permissions.js';

// ── Auth helper ───────────────────────────────────────────────────────────────

async function getUser(c: any, auth: any): Promise<any | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (session) return session.user;

  const rawKey = c.req.header('X-API-Key') || c.req.header('Authorization')?.replace('Bearer ', '');
  if (rawKey?.startsWith('zvk_')) return { id: `apikey:${rawKey}`, role: 'api_key' };
  return null;
}

// ── SDL schema builder ────────────────────────────────────────────────────────

function buildSDL(collections: any[]): string {
  const gqlType = (t: string): string => {
    switch (t) {
      case 'number': case 'integer': case 'float': return 'Float';
      case 'boolean': return 'Boolean';
      case 'json': return 'JSON';
      default: return 'String';
    }
  };

  const types = collections.map((col) => {
    const fields = (col.fields || [])
      .filter((f: any) => f.name && f.type)
      .map((f: any) => `  ${f.name}: ${gqlType(f.type)}`)
      .join('\n');
    return `type ${col.name} {\n  id: String\n${fields}\n  created_at: String\n  updated_at: String\n}`;
  });

  const queryFields = collections.map((col) =>
    `  ${col.name}(id: String, limit: Int, offset: Int): [${col.name}]`
  ).join('\n');

  return [
    'scalar JSON',
    ...types,
    `type Query {\n${queryFields}\n}`,
    'schema { query: Query }',
  ].join('\n\n');
}

// ── Minimal query parser / executor ──────────────────────────────────────────

function parseSelectionSet(body: string): string[] {
  const m = body.match(/\{([^}]+)\}/);
  if (!m) return ['id'];
  return m[1].split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

function parseRootFields(query: string): Array<{
  alias?: string;
  name: string;
  args: Record<string, any>;
  fields: string[];
}> {
  // Matches patterns like: alias: collectionName(args) { fields }
  const pattern = /(?:(\w+)\s*:\s*)?(\w+)\s*(?:\(([^)]*)\))?\s*\{([^}]+)\}/g;
  const results: ReturnType<typeof parseRootFields> = [];
  let m: RegExpExecArray | null;

  while ((m = pattern.exec(query)) !== null) {
    const [, alias, name, rawArgs, rawFields] = m;
    if (name === 'query' || name === 'mutation') continue;

    // Parse simple key: "value" or key: 123 args
    const args: Record<string, any> = {};
    if (rawArgs) {
      const argRe = /(\w+)\s*:\s*(?:"([^"]*)"|([\d.]+))/g;
      let am: RegExpExecArray | null;
      while ((am = argRe.exec(rawArgs)) !== null) {
        args[am[1]] = am[2] !== undefined ? am[2] : Number(am[3]);
      }
    }

    const fields = rawFields.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    results.push({ alias, name, args, fields });
  }

  return results;
}

async function executeField(
  db: Database,
  user: any,
  collectionName: string,
  args: Record<string, any>,
  requestedFields: string[],
): Promise<any[] | null> {
  try {
    // Permission check
    if (user.role !== 'admin') {
      const ok = await checkPermission(user.id, `data:${collectionName}`, 'read');
      if (!ok) return null;
    }

    if (!(await DDLManager.tableExists(db, collectionName))) return null;

    const tableName = DDLManager.getTableName(collectionName);
    let q = (db as any).selectFrom(tableName);

    if (args.id) {
      q = q.where('id', '=', String(args.id));
    }

    q = q.limit(args.limit ?? 20).offset(args.offset ?? 0);

    const rows: any[] = await q.selectAll().execute();

    // Project only requested fields
    return rows.map((row) => {
      const out: Record<string, any> = {};
      for (const f of requestedFields) {
        out[f] = row[f] ?? null;
      }
      return out;
    });
  } catch {
    return null;
  }
}

// ── Playground HTML ───────────────────────────────────────────────────────────

const PLAYGROUND_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Zveltio GraphQL Playground</title>
  <meta charset="utf-8" />
  <style>body{margin:0;font-family:sans-serif;background:#1a1a2e;color:#eee;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:1rem}
  h1{color:#a78bfa}p{color:#9ca3af;font-size:.9rem}a{color:#7c3aed}</style>
</head>
<body>
  <h1>Zveltio GraphQL API</h1>
  <p>Send POST requests with <code>{"query":"{ collection { field } }"}</code></p>
  <p>Schema: <a href="/api/graphql/schema">/api/graphql/schema</a></p>
</body>
</html>`;

// ── Route factory ─────────────────────────────────────────────────────────────

export function graphqlRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // GET / — Playground
  app.get('/', (c) => c.html(PLAYGROUND_HTML));

  // GET /schema — SDL
  app.get('/schema', async (c) => {
    const cols = await DDLManager.getCollections(db).catch(() => []);
    return c.text(buildSDL(cols), 200, { 'Content-Type': 'text/plain; charset=utf-8' });
  });

  // POST / — Execute query
  app.post('/', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ errors: [{ message: 'Unauthorized' }] }, 401);

    let body: { query?: string; variables?: Record<string, any> };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ errors: [{ message: 'Invalid JSON body' }] }, 400);
    }

    const { query = '' } = body;
    if (!query.trim()) {
      return c.json({ errors: [{ message: 'Missing query' }] }, 400);
    }

    const collections = await DDLManager.getCollections(db).catch(() => [] as any[]);
    const collectionNames = new Set(collections.map((c: any) => c.name));

    const rootFields = parseRootFields(query);
    if (rootFields.length === 0) {
      return c.json({ errors: [{ message: 'No valid selection fields found in query' }] });
    }

    const data: Record<string, any> = {};
    const errors: any[] = [];

    for (const field of rootFields) {
      const key = field.alias || field.name;

      if (!collectionNames.has(field.name)) {
        errors.push({ message: `Unknown collection: ${field.name}`, path: [key] });
        data[key] = null;
        continue;
      }

      const result = await executeField(db, user, field.name, field.args, field.fields);
      if (result === null) {
        errors.push({ message: `Access denied or collection not found: ${field.name}`, path: [key] });
        data[key] = null;
      } else {
        data[key] = result;
      }
    }

    const response: Record<string, any> = { data };
    if (errors.length > 0) response.errors = errors;
    return c.json(response);
  });

  return app;
}
