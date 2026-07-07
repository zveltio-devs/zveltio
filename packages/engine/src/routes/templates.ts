/**
 * /api/templates — pre-built business application templates.
 *
 * A template is a JSON manifest describing a set of related collections.
 * GET  /                  — list available templates (id + metadata only)
 * GET  /:id               — full manifest for one template
 * POST /:id/install       — create every collection in the manifest via the
 *                            DDL queue. Returns the list of job_ids so the
 *                            caller can poll for completion.
 *
 * Why this lives in engine, not extensions:
 * 1. Templates are universal across deployments — every install benefits.
 * 2. Manifests are static JSON, not code, so bundling them is cheap.
 * 3. Extensions can still ship their own templates by registering with
 *    `ctx.registerTemplate(manifest)` (added separately if/when needed).
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { checkPermission } from '../lib/tenancy/index.js';
import { DDLManager } from '../lib/data/index.js';
import { fieldTypeRegistry } from '../lib/data/index.js';
import { enqueueDDLJob } from '../lib/data/index.js';
import { dynamicInsert } from '../db/dynamic.js';
import { auditLog } from '../lib/audit.js';
import { DEFAULT_TENANT_ID } from '../lib/tenancy/index.js';

// Static imports so Bun.build bundles the JSON into the binary.
// Adding a new builtin template = drop a JSON file + add the import here.
import crm from '../templates/builtin/crm.json' with { type: 'json' };
import invoicing from '../templates/builtin/invoicing.json' with { type: 'json' };
import project from '../templates/builtin/project.json' with { type: 'json' };
import helpdesk from '../templates/builtin/helpdesk.json' with { type: 'json' };
import inventory from '../templates/builtin/inventory.json' with { type: 'json' };
import ansvsa from '../templates/builtin/ansvsa.json' with { type: 'json' };

interface TemplateField {
  name: string;
  type: string;
  required?: boolean;
  options?: Record<string, unknown>;
}
interface TemplateCollection {
  name: string;
  display_name?: string;
  fields: TemplateField[];
}
interface TemplateManifest {
  id: string;
  name: string;
  description: string;
  icon?: string;
  tags?: string[];
  collections: TemplateCollection[];
  /**
   * Optional starter rows, keyed by (unprefixed) collection name. A row may set
   * `_key` (an in-template id) and reference another row's `_key` in an m2o field
   * as `"@<key>"` — the seeder resolves it to the created row's real id. Seeded
   * by POST /:id/seed AFTER install's DDL jobs complete (creation is async).
   */
  sampleData?: Record<string, Array<Record<string, unknown>>>;
}

const BUILTIN: readonly TemplateManifest[] = [
  crm as TemplateManifest,
  invoicing as TemplateManifest,
  project as TemplateManifest,
  helpdesk as TemplateManifest,
  inventory as TemplateManifest,
  ansvsa as TemplateManifest,
];

function summary(t: TemplateManifest): Omit<TemplateManifest, 'collections'> & {
  collection_count: number;
  relation_count: number;
} {
  const relationCount = t.collections.reduce((sum, c) => {
    return sum + c.fields.filter((f) => ['m2o', 'o2m', 'm2m', 'reference'].includes(f.type)).length;
  }, 0);
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    icon: t.icon,
    tags: t.tags,
    collection_count: t.collections.length,
    relation_count: relationCount,
  };
}

/**
 * Topologically sort collections so a collection that references another
 * appears AFTER its target. Without this, the DDL job for an m2o field can
 * be enqueued before its target table exists and the FK creation fails.
 *
 * Cycles are tolerated: if two collections reference each other, we still
 * emit both — the second create will skip the FK and a subsequent
 * `/sync-schema` call (or manual edit) can wire it.
 */
function sortByDependencies(collections: TemplateCollection[]): TemplateCollection[] {
  const byName = new Map(collections.map((c) => [c.name, c]));
  const out: TemplateCollection[] = [];
  const seen = new Set<string>();
  const inProgress = new Set<string>();

  function visit(c: TemplateCollection) {
    if (seen.has(c.name)) return;
    if (inProgress.has(c.name)) return; // cycle — break here
    inProgress.add(c.name);
    for (const field of c.fields) {
      if (['m2o', 'o2m', 'm2m', 'reference'].includes(field.type)) {
        const target = field.options?.related_collection as string | undefined;
        if (target && byName.has(target)) visit(byName.get(target)!);
      }
    }
    inProgress.delete(c.name);
    seen.add(c.name);
    out.push(c);
  }

  for (const c of collections) visit(c);
  return out;
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
export function templatesRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // Auth + admin guard — applying a template creates tables, so admin only.
  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', session.user);
    if (!(await checkPermission(session.user.id, 'admin', '*'))) {
      return c.json({ error: 'Admin access required' }, 403);
    }
    await next();
  });

  // GET / — list templates (summaries only)
  app.get('/', (c) => c.json({ templates: BUILTIN.map(summary) }));

  // GET /:id — full manifest for one template
  app.get('/:id', (c) => {
    const t = BUILTIN.find((x) => x.id === c.req.param('id'));
    if (!t) return c.json({ error: 'Template not found' }, 404);
    return c.json({ template: t });
  });

  // POST /:id/install — apply the manifest
  app.post(
    '/:id/install',
    zValidator(
      'json',
      z
        .object({
          prefix: z
            .string()
            .regex(/^[a-z][a-z0-9_]*$/)
            .optional(),
          skip_existing: z.boolean().default(true),
        })
        .optional(),
    ),
    async (c) => {
      const t = BUILTIN.find((x) => x.id === c.req.param('id'));
      if (!t) return c.json({ error: 'Template not found' }, 404);

      const body = (await c.req.json().catch(() => ({}))) as {
        prefix?: string;
        skip_existing?: boolean;
      };
      const prefix = body.prefix?.replace(/_$/, '') ?? '';
      const skipExisting = body.skip_existing !== false;

      // Apply prefix to every collection name + every relation target.
      const renamed: TemplateCollection[] = t.collections.map((c) => ({
        ...c,
        name: prefix ? `${prefix}_${c.name}` : c.name,
        fields: c.fields.map((f) => {
          if (!prefix) return f;
          const target = f.options?.related_collection as string | undefined;
          if (target && t.collections.some((cc) => cc.name === target)) {
            return {
              ...f,
              options: { ...(f.options ?? {}), related_collection: `${prefix}_${target}` },
            };
          }
          return f;
        }),
      }));

      // Validate field types + reserved-name conflicts upfront. Fail fast
      // before any DDL is enqueued so we never leave half-installed
      // collections with phantom metadata in zvd_collections (which is
      // what happened when an early version of the helpdesk/invoicing/
      // project templates used "status" as a user field name — that
      // column already exists as a system column added by DDLManager).
      const SYSTEM_FIELDS = new Set([
        'id',
        'created_at',
        'updated_at',
        'status',
        'created_by',
        'updated_by',
        'search_vector',
      ]);
      for (const coll of renamed) {
        for (const f of coll.fields) {
          if (!fieldTypeRegistry.has(f.type)) {
            return c.json(
              { error: `Unknown field type '${f.type}' in collection '${coll.name}'` },
              400,
            );
          }
          if (SYSTEM_FIELDS.has(f.name)) {
            return c.json(
              {
                error: `Field name '${f.name}' in collection '${coll.name}' conflicts with a reserved system column. Rename the field in the template manifest.`,
              },
              400,
            );
          }
        }
      }

      const ordered = sortByDependencies(renamed);
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      const user = c.get('user' as never) as any;
      const created: { name: string; job_id: string | null; status: 'queued' | 'skipped' }[] = [];

      for (const coll of ordered) {
        const existing = await db
          .selectFrom('zvd_collections')
          .select('name')
          .where('name', '=', coll.name)
          .executeTakeFirst();
        if (existing) {
          if (skipExisting) {
            created.push({ name: coll.name, job_id: null, status: 'skipped' });
            continue;
          }
          return c.json({ error: `Collection '${coll.name}' already exists` }, 409);
        }

        // DDLManager requires every field to declare required/unique/indexed —
        // the manifest omits those when they're false, so default them here.
        const payload = {
          name: coll.name,
          display_name: coll.display_name,
          fields: coll.fields.map((f) => ({
            name: f.name,
            type: f.type,
            required: f.required ?? false,
            unique: false,
            indexed: false,
            // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
            options: (f.options ?? {}) as Record<string, any>,
          })),
        };
        await DDLManager.registerMetadata(db, payload);
        const jobId = await enqueueDDLJob(db, 'create_collection', payload);
        created.push({ name: coll.name, job_id: jobId, status: 'queued' });
      }

      await auditLog(db, {
        type: 'collection.created',
        userId: user?.id,
        resourceId: t.id,
        resourceType: 'template_install',
        metadata: { template: t.id, prefix, collections: created.map((c) => c.name) },
      });

      return c.json(
        {
          success: true,
          template: t.id,
          prefix: prefix || null,
          installed: created,
        },
        202,
      );
    },
  );

  // POST /:id/seed — insert the template's starter rows so a fresh install is an
  // instant working app, not empty tables. Separate from /install because
  // collection creation is async (DDL queue): when /install returns 202 the
  // tables don't exist yet. The caller (Studio install flow) polls the collection
  // jobs to completion, then calls this. Idempotent: a collection that already
  // has rows — or whose table isn't ready yet — is skipped, never duplicated.
  app.post(
    '/:id/seed',
    zValidator(
      'json',
      z
        .object({
          prefix: z
            .string()
            .regex(/^[a-z][a-z0-9_]*$/)
            .optional(),
        })
        .optional(),
    ),
    async (c) => {
      const t = BUILTIN.find((x) => x.id === c.req.param('id'));
      if (!t) return c.json({ error: 'Template not found' }, 404);
      if (!t.sampleData) return c.json({ success: true, seeded: 0, message: 'No sample data' });

      const body = (await c.req.json().catch(() => ({}))) as { prefix?: string };
      const prefix = body.prefix?.replace(/_$/, '') ?? '';
      const pfx = (name: string) => (prefix ? `${prefix}_${name}` : name);

      // The acting tenant. /api/templates is in TXN_SKIP_PREFIXES (no tenantTrx —
      // install's CREATE INDEX CONCURRENTLY can't run inside a txn), but
      // tenantMiddleware still resolves the request tenant onto the context.
      // Single-tenant installs resolve to the default tenant.
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      const tenantId = (c.get('tenant' as never) as any)?.id ?? DEFAULT_TENANT_ID;

      // Seed parents before children so "@key" m2o references resolve.
      const ordered = sortByDependencies(t.collections);
      // unprefixed collection name → row _key → created id
      const keyToId: Record<string, Record<string, string>> = {};
      let seeded = 0;
      let pending = 0;

      // One transaction with the tenant GUC set: collection tables have FORCE ROW
      // LEVEL SECURITY keyed on `zveltio.current_tenant`, so inserts on the bare
      // pool are rejected (42501) as soon as a tenant exists. set_config(..., true)
      // is transaction-scoped — same pattern as withTenantIsolation.
      await db.transaction().execute(async (trx) => {
        await sql`SELECT set_config('zveltio.current_tenant', ${tenantId}, true)`.execute(trx);

        for (const coll of ordered) {
          const rows = t.sampleData?.[coll.name];
          if (!Array.isArray(rows) || rows.length === 0) continue;
          keyToId[coll.name] = {};
          // Physical table is zvd_-prefixed (DDLManager.getTableName), NOT the
          // bare collection name — seeding the bare name silently seeded nothing.
          const tableName = DDLManager.getTableName(pfx(coll.name));

          // Existence check must be non-throwing: any error inside a transaction
          // aborts it, so a try/catch around `SELECT count(*)` would poison the
          // txn for every later collection. to_regclass returns NULL instead.
          const reg = await sql<{ ok: boolean }>`
            SELECT to_regclass(${tableName}) IS NOT NULL AS ok
          `.execute(trx);
          if (!reg.rows[0]?.ok) {
            pending++;
            continue; // table not created yet — caller retries after install completes
          }

          // Already seeded (for THIS tenant — the count runs under the GUC, so
          // RLS scopes it)? Skip: idempotent.
          const count = await sql<{ n: number }>`
            SELECT count(*)::int AS n FROM ${sql.id(tableName)}
          `.execute(trx);
          if ((count.rows[0]?.n ?? 0) > 0) continue;

          for (const row of rows) {
            const { _key, ...fields } = row;
            const resolved: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(fields)) {
              if (typeof v === 'string' && v.startsWith('@')) {
                const fieldDef = coll.fields.find((f) => f.name === k);
                const relColl = fieldDef?.options?.related_collection as string | undefined;
                resolved[k] = relColl ? (keyToId[relColl]?.[v.slice(1)] ?? null) : v;
              } else {
                resolved[k] = v;
              }
            }
            const inserted = await dynamicInsert(trx as unknown as Database, tableName, resolved);
            if (typeof _key === 'string') keyToId[coll.name][_key] = inserted.id as string;
            seeded++;
          }
        }
      });

      await auditLog(db, {
        type: 'collection.created',
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
        userId: (c.get('user' as never) as any)?.id,
        resourceId: t.id,
        resourceType: 'template_seed',
        metadata: { template: t.id, prefix, seeded, pending },
      });

      // 425 Too Early if some tables weren't ready — caller retries after the
      // DDL jobs finish; the idempotent guard makes the retry safe.
      return c.json(
        { success: pending === 0, template: t.id, seeded, pending },
        pending > 0 ? 425 : 200,
      );
    },
  );

  return app;
}
