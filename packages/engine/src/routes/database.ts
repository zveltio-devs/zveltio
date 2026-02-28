import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { User } from 'better-auth';
import { auth } from '../lib/auth.js';
import { checkPermission } from '../lib/permissions.js';
import type { Database } from '../db/index.js';
import { sql } from 'kysely';

export function databaseRoutes(db: Database, _auth: any): Hono {
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

    // ── FUNCTIONS ─────────────────────────────────────────────────

    .get('/functions', async (c) => {
      try {
        const result = await sql<{
          schema: string; name: string; language: string; return_type: string;
          arguments: string; definition: string; security_definer: boolean;
          is_strict: boolean; description: string | null;
        }>`
          SELECT
            n.nspname                                    AS schema,
            p.proname                                    AS name,
            l.lanname                                    AS language,
            pg_get_function_result(p.oid)                AS return_type,
            pg_get_function_arguments(p.oid)             AS arguments,
            pg_get_functiondef(p.oid)                    AS definition,
            p.prosecdef                                  AS security_definer,
            p.proisstrict                                AS is_strict,
            obj_description(p.oid, 'pg_proc')            AS description
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          JOIN pg_language l ON l.oid = p.prolang
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND p.prokind = 'f'
          ORDER BY n.nspname, p.proname
        `.execute(db);
        return c.json({ functions: result.rows });
      } catch (error) {
        console.error('Failed to list functions:', error);
        return c.json({ error: 'Failed to list functions' }, 500);
      }
    })

    .post('/functions', zValidator('json', z.object({ definition: z.string().min(10) })), async (c) => {
      const { definition } = c.req.valid('json');
      if (!definition.toUpperCase().includes('CREATE') || !definition.toUpperCase().includes('FUNCTION')) {
        return c.json({ error: 'Definition must contain CREATE [OR REPLACE] FUNCTION' }, 400);
      }
      try {
        await sql.raw(definition).execute(db);
        return c.json({ success: true }, 201);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Failed to create function' }, 400);
      }
    })

    .delete('/functions/:schema/:name', async (c) => {
      const schema = c.req.param('schema');
      const name   = c.req.param('name');
      const cascade = c.req.query('cascade') === 'true';
      if (schema === 'pg_catalog' || schema === 'information_schema') {
        return c.json({ error: 'Cannot drop system functions' }, 403);
      }
      try {
        await sql.raw(`DROP FUNCTION IF EXISTS "${schema}"."${name}" ${cascade ? 'CASCADE' : 'RESTRICT'}`).execute(db);
        return c.json({ success: true });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Failed to drop function' }, 400);
      }
    })

    // ── TRIGGERS ──────────────────────────────────────────────────

    .get('/triggers', async (c) => {
      try {
        const result = await sql<{
          trigger_name: string; table_name: string; table_schema: string;
          event_manipulation: string; action_timing: string;
          function_name: string; is_enabled: boolean; definition: string;
        }>`
          SELECT
            t.trigger_name,
            t.event_object_table       AS table_name,
            t.event_object_schema      AS table_schema,
            t.event_manipulation,
            t.action_timing,
            t.action_statement,
            CASE WHEN pt.tgenabled != 'D' THEN true ELSE false END AS is_enabled,
            pg_get_triggerdef(pt.oid)  AS definition
          FROM information_schema.triggers t
          JOIN pg_trigger pt ON pt.tgname = t.trigger_name
          JOIN pg_class pc ON pc.oid = pt.tgrelid AND pc.relname = t.event_object_table
          WHERE t.trigger_schema NOT IN ('pg_catalog', 'information_schema')
            AND NOT pt.tgisinternal
          ORDER BY t.event_object_table, t.trigger_name
        `.execute(db);
        return c.json({ triggers: result.rows });
      } catch (error) {
        console.error('Failed to list triggers:', error);
        return c.json({ error: 'Failed to list triggers' }, 500);
      }
    })

    .post('/triggers', zValidator('json', z.object({ definition: z.string().min(10) })), async (c) => {
      const { definition } = c.req.valid('json');
      if (!definition.toUpperCase().includes('CREATE') || !definition.toUpperCase().includes('TRIGGER')) {
        return c.json({ error: 'Definition must contain CREATE TRIGGER' }, 400);
      }
      try {
        await sql.raw(definition).execute(db);
        return c.json({ success: true }, 201);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Failed to create trigger' }, 400);
      }
    })

    .patch('/triggers/:table/:name', zValidator('json', z.object({ enabled: z.boolean() })), async (c) => {
      const table = c.req.param('table');
      const name  = c.req.param('name');
      const { enabled } = c.req.valid('json');
      try {
        await sql.raw(`ALTER TABLE "${table}" ${enabled ? 'ENABLE' : 'DISABLE'} TRIGGER "${name}"`).execute(db);
        return c.json({ success: true });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Failed to toggle trigger' }, 400);
      }
    })

    .delete('/triggers/:table/:name', async (c) => {
      const table   = c.req.param('table');
      const name    = c.req.param('name');
      const cascade = c.req.query('cascade') === 'true';
      try {
        await sql.raw(`DROP TRIGGER IF EXISTS "${name}" ON "${table}" ${cascade ? 'CASCADE' : 'RESTRICT'}`).execute(db);
        return c.json({ success: true });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Failed to drop trigger' }, 400);
      }
    })

    // ── ENUMS ─────────────────────────────────────────────────────

    .get('/enums', async (c) => {
      try {
        const result = await sql<{
          schema: string; name: string; values: string[]; used_in: string[];
        }>`
          SELECT
            n.nspname AS schema,
            t.typname AS name,
            array_agg(e.enumlabel ORDER BY e.enumsortorder) AS values,
            COALESCE(
              array_agg(DISTINCT c.relname || '.' || a.attname)
              FILTER (WHERE c.relname IS NOT NULL),
              ARRAY[]::text[]
            ) AS used_in
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          JOIN pg_enum e ON e.enumtypid = t.oid
          LEFT JOIN pg_attribute a ON a.atttypid = t.oid
          LEFT JOIN pg_class c ON c.oid = a.attrelid AND c.relkind = 'r'
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
          GROUP BY n.nspname, t.typname
          ORDER BY n.nspname, t.typname
        `.execute(db);
        return c.json({ enums: result.rows });
      } catch (error) {
        console.error('Failed to list enums:', error);
        return c.json({ error: 'Failed to list enums' }, 500);
      }
    })

    .post('/enums', zValidator('json', z.object({
      name:   z.string().min(1).regex(/^[a-z][a-z0-9_]*$/),
      values: z.array(z.string().min(1)).min(1),
      schema: z.string().default('public'),
    })), async (c) => {
      const { name, values, schema } = c.req.valid('json');
      const valuesSQL = values.map(v => `'${v.replace(/'/g, "''")}'`).join(', ');
      try {
        await sql.raw(`CREATE TYPE "${schema}"."${name}" AS ENUM (${valuesSQL})`).execute(db);
        return c.json({ success: true }, 201);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Failed to create enum' }, 400);
      }
    })

    .post('/enums/:schema/:name/values', zValidator('json', z.object({ value: z.string().min(1) })), async (c) => {
      const schema = c.req.param('schema');
      const name   = c.req.param('name');
      const { value } = c.req.valid('json');
      try {
        await sql.raw(`ALTER TYPE "${schema}"."${name}" ADD VALUE IF NOT EXISTS '${value.replace(/'/g, "''")}'`).execute(db);
        return c.json({ success: true });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Failed to add enum value' }, 400);
      }
    })

    .delete('/enums/:schema/:name', async (c) => {
      const schema = c.req.param('schema');
      const name   = c.req.param('name');
      if (schema === 'pg_catalog') return c.json({ error: 'Cannot drop system enums' }, 403);
      try {
        await sql.raw(`DROP TYPE IF EXISTS "${schema}"."${name}" CASCADE`).execute(db);
        return c.json({ success: true });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Failed to drop enum' }, 400);
      }
    })

    // ── POSTGRES EXTENSIONS ───────────────────────────────────────

    .get('/extensions', async (c) => {
      try {
        const result = await sql<{
          name: string; default_version: string; installed_version: string | null;
          is_installed: boolean; comment: string | null; schema: string | null;
        }>`
          SELECT
            ae.name,
            ae.default_version,
            ie.extversion         AS installed_version,
            ie.extname IS NOT NULL AS is_installed,
            ae.comment,
            n.nspname             AS schema
          FROM pg_available_extensions ae
          LEFT JOIN pg_extension ie ON ie.extname = ae.name
          LEFT JOIN pg_namespace n ON n.oid = ie.extnamespace
          ORDER BY ae.name
        `.execute(db);
        return c.json({ extensions: result.rows });
      } catch (error) {
        console.error('Failed to list extensions:', error);
        return c.json({ error: 'Failed to list extensions' }, 500);
      }
    })

    .post('/extensions/:name/enable', async (c) => {
      const name = c.req.param('name');
      const ALLOWED = [
        'pgvector', 'pg_trgm', 'uuid-ossp', 'pg_stat_statements',
        'pg_crypto', 'postgis', 'fuzzystrmatch', 'pg_similarity',
        'btree_gin', 'btree_gist', 'intarray', 'hstore', 'ltree',
        'pg_partman', 'timescaledb', 'pgjwt', 'pg_net',
      ];
      if (!ALLOWED.includes(name)) return c.json({ error: `Extension "${name}" not in allowed list` }, 403);
      try {
        await sql.raw(`CREATE EXTENSION IF NOT EXISTS "${name}"`).execute(db);
        return c.json({ success: true });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Failed to enable extension' }, 400);
      }
    })

    .delete('/extensions/:name', async (c) => {
      const name = c.req.param('name');
      const PROTECTED = ['pgvector', 'uuid-ossp'];
      if (PROTECTED.includes(name)) return c.json({ error: `Extension "${name}" is protected and cannot be disabled` }, 403);
      try {
        await sql.raw(`DROP EXTENSION IF EXISTS "${name}" CASCADE`).execute(db);
        return c.json({ success: true });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Failed to disable extension' }, 400);
      }
    })

    // ── ROLES ─────────────────────────────────────────────────────

    .get('/roles', async (c) => {
      try {
        const result = await sql<{
          name: string; is_superuser: boolean; can_create_db: boolean;
          can_create_role: boolean; can_login: boolean; connection_limit: number;
          valid_until: string | null; member_of: string[];
        }>`
          SELECT
            r.rolname             AS name,
            r.rolsuper            AS is_superuser,
            r.rolcreatedb         AS can_create_db,
            r.rolcreaterole       AS can_create_role,
            r.rolcanlogin         AS can_login,
            r.rolconnlimit        AS connection_limit,
            r.rolvaliduntil::text AS valid_until,
            COALESCE(
              array_agg(mr.rolname) FILTER (WHERE mr.rolname IS NOT NULL),
              ARRAY[]::text[]
            ) AS member_of
          FROM pg_roles r
          LEFT JOIN pg_auth_members am ON am.member = r.oid
          LEFT JOIN pg_roles mr ON mr.oid = am.roleid
          WHERE r.rolname NOT LIKE 'pg_%' AND r.rolname NOT IN ('postgres')
          GROUP BY r.rolname, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
                   r.rolcanlogin, r.rolconnlimit, r.rolvaliduntil
          ORDER BY r.rolname
        `.execute(db);
        return c.json({ roles: result.rows });
      } catch (error) {
        console.error('Failed to list roles:', error);
        return c.json({ error: 'Failed to list roles' }, 500);
      }
    })

    .post('/roles', zValidator('json', z.object({
      name:             z.string().min(1).regex(/^[a-z][a-z0-9_]*$/),
      can_login:        z.boolean().default(false),
      can_create_db:    z.boolean().default(false),
      password:         z.string().optional(),
      connection_limit: z.number().int().default(-1),
      valid_until:      z.string().optional(),
    })), async (c) => {
      const data = c.req.valid('json');
      const parts = [`CREATE ROLE "${data.name}"`];
      const attrs: string[] = [];
      if (data.can_login)   attrs.push('LOGIN');
      if (data.can_create_db) attrs.push('CREATEDB');
      if (data.password)    attrs.push(`PASSWORD '${data.password.replace(/'/g, "''")}'`);
      if (data.connection_limit !== -1) attrs.push(`CONNECTION LIMIT ${data.connection_limit}`);
      if (data.valid_until) attrs.push(`VALID UNTIL '${data.valid_until}'`);
      if (attrs.length > 0) parts.push('WITH', attrs.join(' '));
      try {
        await sql.raw(parts.join(' ')).execute(db);
        return c.json({ success: true }, 201);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Failed to create role' }, 400);
      }
    })

    .delete('/roles/:name', async (c) => {
      const name = c.req.param('name');
      const PROTECTED = ['postgres', 'pg_monitor', 'pg_read_all_settings'];
      if (PROTECTED.includes(name) || name.startsWith('pg_')) return c.json({ error: 'Cannot drop system role' }, 403);
      try {
        await sql.raw(`DROP ROLE IF EXISTS "${name}"`).execute(db);
        return c.json({ success: true });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Failed to drop role' }, 400);
      }
    })

    // ── ROW LEVEL SECURITY ────────────────────────────────────────

    .get('/rls', async (c) => {
      try {
        const result = await sql<{
          table_schema: string; table_name: string; rls_enabled: boolean;
          rls_forced: boolean; policy_name: string | null; command: string | null;
          roles: string[] | null; qual: string | null; with_check: string | null;
        }>`
          SELECT
            n.nspname                    AS table_schema,
            c.relname                    AS table_name,
            c.relrowsecurity             AS rls_enabled,
            c.relforcerowsecurity        AS rls_forced,
            p.polname                    AS policy_name,
            CASE p.polcmd
              WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
              WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE'
              ELSE 'ALL'
            END                          AS command,
            ARRAY(
              SELECT pg_get_userbyid(unnest(p.polroles))
              WHERE p.polroles <> ARRAY[0::oid]
            )                            AS roles,
            pg_get_expr(p.polqual, p.polrelid)      AS qual,
            pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_policy p ON p.polrelid = c.oid
          WHERE c.relkind = 'r'
            AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          ORDER BY n.nspname, c.relname, p.polname
        `.execute(db);
        return c.json({ policies: result.rows });
      } catch (error) {
        console.error('Failed to list RLS policies:', error);
        return c.json({ error: 'Failed to list RLS policies' }, 500);
      }
    })

    .patch('/rls/:table', zValidator('json', z.object({
      enabled: z.boolean(),
      forced:  z.boolean().optional(),
    })), async (c) => {
      const table = c.req.param('table');
      const { enabled, forced } = c.req.valid('json');
      try {
        await sql.raw(`ALTER TABLE "${table}" ${enabled ? 'ENABLE' : 'DISABLE'} ROW LEVEL SECURITY`).execute(db);
        if (forced !== undefined) {
          await sql.raw(`ALTER TABLE "${table}" ${forced ? 'FORCE' : 'NO FORCE'} ROW LEVEL SECURITY`).execute(db);
        }
        return c.json({ success: true });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Failed to toggle RLS' }, 400);
      }
    })

    .post('/rls', zValidator('json', z.object({
      table:       z.string().min(1),
      policy_name: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/),
      command:     z.enum(['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE']).default('ALL'),
      roles:       z.array(z.string()).default(['PUBLIC']),
      using:       z.string().optional(),
      with_check:  z.string().optional(),
    })), async (c) => {
      const data = c.req.valid('json');
      let sql_str = `CREATE POLICY "${data.policy_name}" ON "${data.table}"`;
      sql_str += ` AS PERMISSIVE FOR ${data.command}`;
      sql_str += ` TO ${data.roles.join(', ')}`;
      if (data.using)      sql_str += ` USING (${data.using})`;
      if (data.with_check) sql_str += ` WITH CHECK (${data.with_check})`;
      try {
        await sql.raw(sql_str).execute(db);
        return c.json({ success: true }, 201);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Failed to create policy' }, 400);
      }
    })

    .delete('/rls/:table/:policy', async (c) => {
      const table  = c.req.param('table');
      const policy = c.req.param('policy');
      try {
        await sql.raw(`DROP POLICY IF EXISTS "${policy}" ON "${table}"`).execute(db);
        return c.json({ success: true });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Failed to drop policy' }, 400);
      }
    })

    // ── SAVED SQL QUERIES ─────────────────────────────────────────

    .get('/saved-queries', async (c) => {
      try {
        const result = await sql<{
          id: string; name: string; description: string | null;
          query: string; created_by: string; created_at: string; updated_at: string;
        }>`
          SELECT id, name, description, query, created_by, created_at, updated_at
          FROM zv_saved_queries ORDER BY name
        `.execute(db);
        return c.json({ queries: result.rows });
      } catch {
        return c.json({ error: 'Failed to list saved queries' }, 500);
      }
    })

    .post('/saved-queries', zValidator('json', z.object({
      name:        z.string().min(1),
      description: z.string().optional(),
      query:       z.string().min(1),
    })), async (c) => {
      const user = c.get('user');
      const data = c.req.valid('json');
      try {
        const result = await sql<{ id: string }>`
          INSERT INTO zv_saved_queries (name, description, query, created_by)
          VALUES (${data.name}, ${data.description || null}, ${data.query}, ${user.id})
          RETURNING id
        `.execute(db);
        return c.json({ id: result.rows[0].id }, 201);
      } catch {
        return c.json({ error: 'Failed to save query' }, 500);
      }
    })

    .put('/saved-queries/:id', zValidator('json', z.object({
      name:        z.string().min(1).optional(),
      description: z.string().optional(),
      query:       z.string().min(1).optional(),
    })), async (c) => {
      const id   = c.req.param('id');
      const data = c.req.valid('json');
      try {
        await (db as any)
          .updateTable('zv_saved_queries')
          .set({ ...data, updated_at: new Date() })
          .where('id', '=', id)
          .execute();
        return c.json({ success: true });
      } catch {
        return c.json({ error: 'Failed to update query' }, 500);
      }
    })

    .delete('/saved-queries/:id', async (c) => {
      const id = c.req.param('id');
      try {
        await (db as any).deleteFrom('zv_saved_queries').where('id', '=', id).execute();
        return c.json({ success: true });
      } catch {
        return c.json({ error: 'Failed to delete query' }, 500);
      }
    });

  return router;
}
