import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { User } from 'better-auth';
import { auth } from '../../../../packages/engine/src/lib/auth.js';
import { checkPermission } from '../../../../packages/engine/src/lib/permissions.js';
import type { Database } from '../../../../packages/engine/src/db/index.js';
import { sql } from 'kysely';
import { DDLManager } from '../../../../packages/engine/src/lib/ddl-manager.js';
import { GhostDDL } from '../../../../packages/engine/src/lib/ghost-ddl.js';

export function schemaBranchesRoutes(db: Database, _auth: any): Hono {
  const router = new Hono<{ Variables: { user: User } }>()

    // Admin-only middleware
    .use('*', async (c, next) => {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (!session) return c.json({ error: 'Unauthorized' }, 401);
      c.set('user', session.user);
      const hasAdmin = await checkPermission(session.user.id, 'admin', '*');
      if (!hasAdmin) return c.json({ error: 'Admin access required' }, 403);
      await next();
    })

    // GET /api/schema/branches
    .get('/branches', async (c) => {
      try {
        const branches = await sql<{
          id: string;
          name: string;
          description: string | null;
          base_schema: string;
          branch_schema: string;
          status: string;
          changes: any[];
          created_by: string | null;
          merged_by: string | null;
          merged_at: Date | null;
          created_at: Date;
          updated_at: Date;
        }>`
          SELECT id, name, description, base_schema, branch_schema, status, changes,
                 created_by, merged_by, merged_at, created_at, updated_at
          FROM zv_schema_branches
          ORDER BY created_at DESC
        `.execute(db);
        return c.json({ branches: branches.rows });
      } catch (error) {
        console.error('Failed to list branches:', error);
        return c.json({ error: 'Failed to list branches' }, 500);
      }
    })

    // GET /api/schema/branches/:id
    .get('/branches/:id', async (c) => {
      const id = c.req.param('id');
      try {
        const result = await sql<{
          id: string;
          name: string;
          description: string | null;
          base_schema: string;
          branch_schema: string;
          status: string;
          changes: any[];
          created_by: string | null;
          merged_by: string | null;
          merged_at: Date | null;
          created_at: Date;
          updated_at: Date;
        }>`
          SELECT id, name, description, base_schema, branch_schema, status, changes,
                 created_by, merged_by, merged_at, created_at, updated_at
          FROM zv_schema_branches
          WHERE id = ${id}
        `.execute(db);
        if (result.rows.length === 0) return c.json({ error: 'Branch not found' }, 404);
        return c.json({ branch: result.rows[0] });
      } catch (error) {
        console.error('Failed to get branch:', error);
        return c.json({ error: 'Failed to get branch' }, 500);
      }
    })

    // POST /api/schema/branches
    .post(
      '/branches',
      zValidator('json', z.object({
        name: z.string().min(1).max(100),
        description: z.string().optional(),
      })),
      async (c) => {
        const user = c.get('user');
        const { name, description } = c.req.valid('json');
        const branchSchema = `branch_${name
          .toLowerCase()
          .replace(/\s+/g, '_')
          .replace(/[^a-z0-9_]/g, '')}_${Date.now()}`;

        try {
          await sql`CREATE SCHEMA IF NOT EXISTS ${sql.id(branchSchema)}`.execute(db);

          await sql`
            CREATE TABLE ${sql.id(branchSchema)}.zvd_collections
              (LIKE public.zvd_collections INCLUDING ALL)
          `.execute(db);

          await sql`
            INSERT INTO ${sql.id(branchSchema)}.zvd_collections
            SELECT * FROM public.zvd_collections
          `.execute(db);

          try {
            await sql`
              CREATE TABLE ${sql.id(branchSchema)}.zvd_relations
                (LIKE public.zvd_relations INCLUDING ALL)
            `.execute(db);
            await sql`
              INSERT INTO ${sql.id(branchSchema)}.zvd_relations
              SELECT * FROM public.zvd_relations
            `.execute(db);
          } catch {
            // zvd_relations might not exist
          }

          const collections = await DDLManager.getCollections(db);
          for (const col of collections as any[]) {
            const tableName = `zvd_${col.name}`;
            try {
              await sql`
                CREATE TABLE ${sql.id(branchSchema)}.${sql.id(tableName)}
                  (LIKE public.${sql.id(tableName)} INCLUDING ALL)
              `.execute(db);
            } catch {
              // table doesn't exist — skip
            }
          }

          const result = await sql<{
            id: string;
            name: string;
            branch_schema: string;
            status: string;
            created_at: Date;
          }>`
            INSERT INTO zv_schema_branches (name, description, base_schema, branch_schema, created_by)
            VALUES (${name}, ${description || null}, 'public', ${branchSchema}, ${user.id})
            RETURNING id, name, branch_schema, status, created_at
          `.execute(db);

          return c.json({ branch: result.rows[0], schema: branchSchema }, 201);
        } catch (error) {
          console.error('Failed to create branch:', error);
          try { await sql`DROP SCHEMA IF EXISTS ${sql.id(branchSchema)} CASCADE`.execute(db); } catch {}
          return c.json({ error: 'Failed to create branch' }, 500);
        }
      },
    )

    // GET /api/schema/branches/:id/diff
    .get('/branches/:id/diff', async (c) => {
      const id = c.req.param('id');
      try {
        const branchResult = await sql<{
          id: string;
          name: string;
          base_schema: string;
          branch_schema: string;
          changes: any[];
        }>`
          SELECT id, name, base_schema, branch_schema, changes
          FROM zv_schema_branches WHERE id = ${id}
        `.execute(db);

        if (branchResult.rows.length === 0) return c.json({ error: 'Branch not found' }, 404);
        const branch = branchResult.rows[0];

        const baseCols = await sql<{ name: string }>`
          SELECT name FROM public.zvd_collections ORDER BY name
        `.execute(db);

        let branchCols: { name: string }[] = [];
        try {
          const r = await sql<{ name: string }>`
            SELECT name FROM ${sql.id(branch.branch_schema)}.zvd_collections ORDER BY name
          `.execute(db);
          branchCols = r.rows;
        } catch {}

        const baseNames = new Set(baseCols.rows.map((r) => r.name));
        const branchNames = new Set(branchCols.map((r) => r.name));
        const added = [...branchNames].filter((n) => !baseNames.has(n));
        const removed = [...baseNames].filter((n) => !branchNames.has(n));
        const modified = (branch.changes || [])
          .map((ch: any) => ch.payload?.collection)
          .filter(Boolean);

        return c.json({
          branch_id: id,
          branch_name: branch.name,
          base_schema: branch.base_schema,
          diff: {
            collections_added: added,
            collections_removed: removed,
            fields_modified: [...new Set(modified)],
            raw_changes: branch.changes,
          },
        });
      } catch (error) {
        console.error('Failed to get diff:', error);
        return c.json({ error: 'Failed to get diff' }, 500);
      }
    })

    // POST /api/schema/branches/:id/merge
    .post('/branches/:id/merge', async (c) => {
      const user = c.get('user');
      const id = c.req.param('id');
      try {
        const branchResult = await sql<{
          id: string;
          name: string;
          branch_schema: string;
          status: string;
          changes: any[];
        }>`
          SELECT id, name, branch_schema, status, changes
          FROM zv_schema_branches WHERE id = ${id} AND status = 'open'
        `.execute(db);

        if (branchResult.rows.length === 0) return c.json({ error: 'Branch not found or already merged' }, 404);

        const branch = branchResult.rows[0];
        const changes = branch.changes || [];
        const applied: string[] = [];
        const errors: string[] = [];

        for (const change of changes) {
          try {
            if (change.type === 'add_collection') {
              const { enqueueDDLJob } = await import('../../../../packages/engine/src/lib/ddl-queue.js');
              await enqueueDDLJob(db, 'create_collection', change.payload);
              applied.push(`Add collection: ${change.payload.name}`);
            } else if (change.type === 'add_field') {
              const { fieldTypeRegistry } = await import('../../../../packages/engine/src/lib/field-type-registry.js');
              const tableName = DDLManager.getTableName(change.payload.collection);
              const colDDL = fieldTypeRegistry.getColumnDDL(change.payload.field);
              if (colDDL) {
                // Use Ghost DDL for large tables (>100k rows) to avoid downtime
                const countResult = await sql<{ cnt: string }>`
                  SELECT count(*) AS cnt FROM ${sql.id(tableName)}
                `.execute(db).catch(() => ({ rows: [{ cnt: '0' }] }));
                const rowCount = Number(countResult.rows[0]?.cnt ?? 0);

                if (rowCount > 100_000) {
                  await GhostDDL.execute(db, tableName, [`ADD COLUMN ${colDDL}`], (phase, detail) => {
                    console.log(`[ghost-ddl] ${phase}: ${detail}`);
                  });
                } else {
                  const { dynamicAddColumn } = await import('../../../../packages/engine/src/db/dynamic.js');
                  await dynamicAddColumn(db, tableName, colDDL);
                }
              }
              applied.push(`Add field: ${change.payload.field.name} to ${change.payload.collection}`);
            } else if (change.type === 'remove_field') {
              const tableName = DDLManager.getTableName(change.payload.collection);

              // Use Ghost DDL for large tables (>100k rows) to avoid downtime
              const countResult = await sql<{ cnt: string }>`
                SELECT count(*) AS cnt FROM ${sql.id(tableName)}
              `.execute(db).catch(() => ({ rows: [{ cnt: '0' }] }));
              const rowCount = Number(countResult.rows[0]?.cnt ?? 0);

              if (rowCount > 100_000) {
                await GhostDDL.execute(db, tableName, [`DROP COLUMN "${change.payload.field}"`], (phase, detail) => {
                  console.log(`[ghost-ddl] ${phase}: ${detail}`);
                });
              } else {
                const { dynamicDropColumn } = await import('../../../../packages/engine/src/db/dynamic.js');
                await dynamicDropColumn(db, tableName, change.payload.field);
              }
              applied.push(`Remove field: ${change.payload.field} from ${change.payload.collection}`);
            }
          } catch (err) {
            errors.push(`${change.type}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        await sql`
          UPDATE zv_schema_branches
          SET status = 'merged', merged_by = ${user.id}, merged_at = NOW()
          WHERE id = ${id}
        `.execute(db);

        return c.json({
          success: errors.length === 0,
          applied,
          errors,
          message: `Merged ${applied.length} changes. ${errors.length} errors.`,
        });
      } catch (error) {
        console.error('Failed to merge branch:', error);
        return c.json({ error: 'Failed to merge branch' }, 500);
      }
    })

    // POST /api/schema/branches/:id/changes
    .post(
      '/branches/:id/changes',
      zValidator('json', z.object({
        type: z.enum(['add_collection', 'add_field', 'remove_field']),
        payload: z.record(z.string(), z.any()),
      })),
      async (c) => {
        const id = c.req.param('id');
        const { type, payload } = c.req.valid('json');
        try {
          const branchResult = await sql<{ changes: any[] }>`
            SELECT changes FROM zv_schema_branches WHERE id = ${id} AND status = 'open'
          `.execute(db);
          if (branchResult.rows.length === 0) return c.json({ error: 'Branch not found or not open' }, 404);

          const currentChanges = branchResult.rows[0].changes || [];
          const newChange = { type, payload, timestamp: new Date().toISOString() };

          await sql`
            UPDATE zv_schema_branches
            SET changes = ${JSON.stringify([...currentChanges, newChange])}
            WHERE id = ${id}
          `.execute(db);

          return c.json({ success: true, change: newChange });
        } catch (error) {
          console.error('Failed to add change:', error);
          return c.json({ error: 'Failed to add change' }, 500);
        }
      },
    )

    // DELETE /api/schema/branches/:id
    .delete('/branches/:id', async (c) => {
      const id = c.req.param('id');
      try {
        const branchResult = await sql<{
          id: string;
          branch_schema: string;
          status: string;
        }>`
          SELECT id, branch_schema, status FROM zv_schema_branches WHERE id = ${id}
        `.execute(db);

        if (branchResult.rows.length === 0) return c.json({ error: 'Branch not found' }, 404);
        const branch = branchResult.rows[0];

        try {
          await sql`DROP SCHEMA IF EXISTS ${sql.id(branch.branch_schema)} CASCADE`.execute(db);
        } catch (e) {
          console.error('Failed to drop schema:', e);
        }

        await sql`UPDATE zv_schema_branches SET status = 'closed' WHERE id = ${id}`.execute(db);
        return c.json({ success: true });
      } catch (error) {
        console.error('Failed to close branch:', error);
        return c.json({ error: 'Failed to close branch' }, 500);
      }
    });

  return router;
}
