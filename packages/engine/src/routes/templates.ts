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
import type { Database } from '../db/index.js';
import { checkPermission } from '../lib/permissions.js';
import { DDLManager } from '../lib/ddl-manager.js';
import { fieldTypeRegistry } from '../lib/field-type-registry.js';
import { enqueueDDLJob } from '../lib/ddl-queue.js';
import { auditLog } from '../lib/audit.js';

// Static imports so Bun.build bundles the JSON into the binary.
// Adding a new builtin template = drop a JSON file + add the import here.
import crm from '../templates/builtin/crm.json' with { type: 'json' };
import invoicing from '../templates/builtin/invoicing.json' with { type: 'json' };
import project from '../templates/builtin/project.json' with { type: 'json' };
import helpdesk from '../templates/builtin/helpdesk.json' with { type: 'json' };
import inventory from '../templates/builtin/inventory.json' with { type: 'json' };

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
}

const BUILTIN: readonly TemplateManifest[] = [
  crm as TemplateManifest,
  invoicing as TemplateManifest,
  project as TemplateManifest,
  helpdesk as TemplateManifest,
  inventory as TemplateManifest,
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
    zValidator('json', z.object({
      prefix: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(),
      skip_existing: z.boolean().default(true),
    }).optional()),
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

      // Validate field types upfront — fail fast before any DDL is enqueued.
      for (const coll of renamed) {
        for (const f of coll.fields) {
          if (!fieldTypeRegistry.has(f.type)) {
            return c.json({ error: `Unknown field type '${f.type}' in collection '${coll.name}'` }, 400);
          }
        }
      }

      const ordered = sortByDependencies(renamed);
      const user = c.get('user' as never) as any;
      const created: { name: string; job_id: string | null; status: 'queued' | 'skipped' }[] = [];

      for (const coll of ordered) {
        const existing = await (db as any)
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

  return app;
}
