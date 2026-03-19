import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../../../packages/engine/src/db/index.js';
import { checkPermission } from '../../../packages/engine/src/lib/permissions.js';

type Bindings = { db: Database; user: any };

function buildListQuery(table: string, allowed: string[]) {
  return (c: any) => {
    const { limit = '50', page = '1', sort, order = 'desc', search } = c.req.query();
    const lim = Math.min(Math.max(1, parseInt(limit)), 200);
    const offset = (Math.max(1, parseInt(page)) - 1) * lim;
    const sortCol = allowed.includes(sort) ? sort : 'created_at';
    const dir = order === 'asc' ? 'ASC' : 'DESC';
    return { lim, offset, sortCol, dir, search: search?.trim() ?? null };
  };
}

export function crmRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // ── Auth guard ────────────────────────────────────────────────────────────
  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', session.user);
    await next();
  });

  // ═══════════════════════════════════════════════════════
  // CONTACTS
  // ═══════════════════════════════════════════════════════

  app.get('/contacts', async (c) => {
    const { lim, offset, sortCol, dir, search } = buildListQuery(
      'zvd_contacts',
      ['first_name', 'last_name', 'email', 'created_at'],
    )(c);

    const rows = await sql`
      SELECT id, first_name, last_name, email, phone, company, job_title,
             avatar_url, tags, source, created_at, updated_at
      FROM zvd_contacts
      WHERE (
        ${search ? sql`(first_name ILIKE ${'%' + search + '%'}
          OR last_name ILIKE ${'%' + search + '%'}
          OR email ILIKE ${'%' + search + '%'}
          OR company ILIKE ${'%' + search + '%'})` : sql`TRUE`}
      )
      ORDER BY ${sql.raw(sortCol)} ${sql.raw(dir)}
      LIMIT ${lim} OFFSET ${offset}
    `.execute(db);

    const total = await sql<{ count: string }>`
      SELECT COUNT(*) as count FROM zvd_contacts
      WHERE (${search ? sql`first_name ILIKE ${'%' + search + '%'}
        OR last_name ILIKE ${'%' + search + '%'}
        OR email ILIKE ${'%' + search + '%'}` : sql`TRUE`})
    `.execute(db);

    return c.json({
      data: rows.rows,
      meta: { total: parseInt((total.rows[0] as any).count), page: Math.ceil(offset / lim) + 1, limit: lim },
    });
  });

  app.get('/contacts/:id', async (c) => {
    const row = await sql`
      SELECT c.*, COALESCE(json_agg(o.*) FILTER (WHERE o.id IS NOT NULL), '[]') AS organizations
      FROM zvd_contacts c
      LEFT JOIN zvd_contact_organizations co ON co.contact_id = c.id
      LEFT JOIN zvd_organizations o ON o.id = co.organization_id
      WHERE c.id = ${c.req.param('id')}
      GROUP BY c.id
    `.execute(db);
    if (!row.rows.length) return c.json({ error: 'Not found' }, 404);
    return c.json({ data: row.rows[0] });
  });

  app.post('/contacts',
    zValidator('json', z.object({
      first_name: z.string().min(1),
      last_name: z.string().optional(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
      company: z.string().optional(),
      job_title: z.string().optional(),
      avatar_url: z.string().url().optional(),
      tags: z.array(z.string()).optional(),
      notes: z.string().optional(),
      source: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    })),
    async (c) => {
      const user = c.get('user') as any;
      const d = c.req.valid('json');
      const result = await sql`
        INSERT INTO zvd_contacts
          (first_name, last_name, email, phone, company, job_title, avatar_url,
           tags, notes, source, metadata, created_by)
        VALUES
          (${d.first_name}, ${d.last_name ?? null}, ${d.email ?? null},
           ${d.phone ?? null}, ${d.company ?? null}, ${d.job_title ?? null},
           ${d.avatar_url ?? null}, ${d.tags ?? []}, ${d.notes ?? null},
           ${d.source ?? null}, ${JSON.stringify(d.metadata ?? {})}::jsonb, ${user.id})
        RETURNING *
      `.execute(db);
      return c.json({ data: result.rows[0] }, 201);
    },
  );

  app.patch('/contacts/:id',
    zValidator('json', z.object({
      first_name: z.string().min(1).optional(),
      last_name: z.string().optional(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
      company: z.string().optional(),
      job_title: z.string().optional(),
      avatar_url: z.string().url().optional(),
      tags: z.array(z.string()).optional(),
      notes: z.string().optional(),
      source: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    })),
    async (c) => {
      const d = c.req.valid('json');
      const id = c.req.param('id');
      const sets: string[] = [];
      const vals: any[] = [];
      let i = 1;
      for (const [k, v] of Object.entries(d)) {
        if (v !== undefined) { sets.push(`${k} = $${i++}`); vals.push(k === 'metadata' ? JSON.stringify(v) : v); }
      }
      if (!sets.length) return c.json({ error: 'No fields to update' }, 400);
      const result = await db.executeQuery({ sql: `UPDATE zvd_contacts SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING *`, parameters: [...vals, id] } as any);
      if (!(result as any).rows.length) return c.json({ error: 'Not found' }, 404);
      return c.json({ data: (result as any).rows[0] });
    },
  );

  app.delete('/contacts/:id', async (c) => {
    const user = c.get('user') as any;
    const id = c.req.param('id');
    const existing = await sql<{ created_by: string }>`
      SELECT created_by FROM zvd_contacts WHERE id = ${id}
    `.execute(db);
    if (!existing.rows[0]) return c.json({ error: 'Not found' }, 404);
    const isAdmin = await checkPermission(user.id, 'admin', '*');
    if (existing.rows[0].created_by !== user.id && !isAdmin) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    await sql`DELETE FROM zvd_contacts WHERE id = ${id}`.execute(db);
    return c.json({ success: true });
  });

  // ═══════════════════════════════════════════════════════
  // ORGANIZATIONS
  // ═══════════════════════════════════════════════════════

  app.get('/organizations', async (c) => {
    const { lim, offset, sortCol, dir, search } = buildListQuery(
      'zvd_organizations',
      ['name', 'industry', 'created_at'],
    )(c);

    const rows = await sql`
      SELECT id, name, legal_name, tax_id, type, industry, website,
             email, phone, logo_url, is_active, tags, created_at, updated_at
      FROM zvd_organizations
      WHERE (${search ? sql`name ILIKE ${'%' + search + '%'} OR tax_id ILIKE ${'%' + search + '%'}` : sql`TRUE`})
      ORDER BY ${sql.raw(sortCol)} ${sql.raw(dir)}
      LIMIT ${lim} OFFSET ${offset}
    `.execute(db);

    const total = await sql<{ count: string }>`
      SELECT COUNT(*) as count FROM zvd_organizations
      WHERE (${search ? sql`name ILIKE ${'%' + search + '%'}` : sql`TRUE`})
    `.execute(db);

    return c.json({
      data: rows.rows,
      meta: { total: parseInt((total.rows[0] as any).count), page: Math.ceil(offset / lim) + 1, limit: lim },
    });
  });

  app.get('/organizations/:id', async (c) => {
    const row = await sql`
      SELECT o.*,
        COALESCE(json_agg(json_build_object('id', c.id, 'first_name', c.first_name, 'last_name', c.last_name, 'email', c.email))
          FILTER (WHERE c.id IS NOT NULL), '[]') AS contacts
      FROM zvd_organizations o
      LEFT JOIN zvd_contact_organizations co ON co.organization_id = o.id
      LEFT JOIN zvd_contacts c ON c.id = co.contact_id
      WHERE o.id = ${c.req.param('id')}
      GROUP BY o.id
    `.execute(db);
    if (!row.rows.length) return c.json({ error: 'Not found' }, 404);
    return c.json({ data: row.rows[0] });
  });

  app.post('/organizations',
    zValidator('json', z.object({
      name: z.string().min(1),
      legal_name: z.string().optional(),
      tax_id: z.string().optional(),
      registration_no: z.string().optional(),
      type: z.enum(['company', 'nonprofit', 'government', 'individual']).default('company'),
      industry: z.string().optional(),
      website: z.string().url().optional(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
      logo_url: z.string().url().optional(),
      tags: z.array(z.string()).optional(),
      notes: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    })),
    async (c) => {
      const user = c.get('user') as any;
      const d = c.req.valid('json');
      const result = await sql`
        INSERT INTO zvd_organizations
          (name, legal_name, tax_id, registration_no, type, industry,
           website, email, phone, logo_url, tags, metadata, created_by)
        VALUES
          (${d.name}, ${d.legal_name ?? null}, ${d.tax_id ?? null},
           ${d.registration_no ?? null}, ${d.type}, ${d.industry ?? null},
           ${d.website ?? null}, ${d.email ?? null}, ${d.phone ?? null},
           ${d.logo_url ?? null}, ${d.tags ?? []},
           ${JSON.stringify(d.metadata ?? {})}::jsonb, ${user.id})
        RETURNING *
      `.execute(db);
      return c.json({ data: result.rows[0] }, 201);
    },
  );

  app.patch('/organizations/:id',
    zValidator('json', z.object({
      name: z.string().min(1).optional(),
      legal_name: z.string().optional(),
      tax_id: z.string().optional(),
      type: z.enum(['company', 'nonprofit', 'government', 'individual']).optional(),
      industry: z.string().optional(),
      website: z.string().url().optional(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
      logo_url: z.string().url().optional(),
      is_active: z.boolean().optional(),
      tags: z.array(z.string()).optional(),
      metadata: z.record(z.unknown()).optional(),
    })),
    async (c) => {
      const d = c.req.valid('json');
      const id = c.req.param('id');
      const sets: string[] = [];
      const vals: any[] = [];
      let i = 1;
      for (const [k, v] of Object.entries(d)) {
        if (v !== undefined) { sets.push(`${k} = $${i++}`); vals.push(k === 'metadata' ? JSON.stringify(v) : v); }
      }
      if (!sets.length) return c.json({ error: 'No fields to update' }, 400);
      const result = await db.executeQuery({ sql: `UPDATE zvd_organizations SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING *`, parameters: [...vals, id] } as any);
      if (!(result as any).rows.length) return c.json({ error: 'Not found' }, 404);
      return c.json({ data: (result as any).rows[0] });
    },
  );

  app.delete('/organizations/:id', async (c) => {
    const user = c.get('user') as any;
    const id = c.req.param('id');
    const existing = await sql<{ created_by: string }>`
      SELECT created_by FROM zvd_organizations WHERE id = ${id}
    `.execute(db);
    if (!existing.rows[0]) return c.json({ error: 'Not found' }, 404);
    const isAdmin = await checkPermission(user.id, 'admin', '*');
    if (existing.rows[0].created_by !== user.id && !isAdmin) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    await sql`DELETE FROM zvd_organizations WHERE id = ${id}`.execute(db);
    return c.json({ success: true });
  });

  // ═══════════════════════════════════════════════════════
  // TRANSACTIONS
  // ═══════════════════════════════════════════════════════

  app.get('/transactions', async (c) => {
    const { lim, offset, sortCol, dir, search } = buildListQuery(
      'zvd_transactions',
      ['number', 'type', 'status', 'amount', 'created_at'],
    )(c);
    const { type, status } = c.req.query();

    const rows = await sql`
      SELECT t.id, t.type, t.status, t.number, t.currency, t.amount,
             t.tax_amount, t.total_amount, t.due_date, t.paid_date,
             t.created_at, t.updated_at,
             json_build_object('id', c.id, 'first_name', c.first_name, 'last_name', c.last_name) AS contact,
             json_build_object('id', o.id, 'name', o.name) AS organization
      FROM zvd_transactions t
      LEFT JOIN zvd_contacts c ON c.id = t.contact_id
      LEFT JOIN zvd_organizations o ON o.id = t.organization_id
      WHERE (${type ? sql`t.type = ${type}` : sql`TRUE`})
        AND (${status ? sql`t.status = ${status}` : sql`TRUE`})
        AND (${search ? sql`t.number ILIKE ${'%' + search + '%'} OR t.reference ILIKE ${'%' + search + '%'}` : sql`TRUE`})
      ORDER BY ${sql.raw('t.' + sortCol)} ${sql.raw(dir)}
      LIMIT ${lim} OFFSET ${offset}
    `.execute(db);

    const total = await sql<{ count: string }>`
      SELECT COUNT(*) as count FROM zvd_transactions
      WHERE (${type ? sql`type = ${type}` : sql`TRUE`})
        AND (${status ? sql`status = ${status}` : sql`TRUE`})
    `.execute(db);

    return c.json({
      data: rows.rows,
      meta: { total: parseInt((total.rows[0] as any).count), page: Math.ceil(offset / lim) + 1, limit: lim },
    });
  });

  app.get('/transactions/:id', async (c) => {
    const row = await sql`
      SELECT t.*,
        json_build_object('id', c.id, 'first_name', c.first_name, 'last_name', c.last_name, 'email', c.email) AS contact,
        json_build_object('id', o.id, 'name', o.name) AS organization
      FROM zvd_transactions t
      LEFT JOIN zvd_contacts c ON c.id = t.contact_id
      LEFT JOIN zvd_organizations o ON o.id = t.organization_id
      WHERE t.id = ${c.req.param('id')}
    `.execute(db);
    if (!row.rows.length) return c.json({ error: 'Not found' }, 404);
    return c.json({ data: row.rows[0] });
  });

  app.post('/transactions',
    zValidator('json', z.object({
      type: z.enum(['invoice', 'payment', 'credit_note', 'expense', 'transfer', 'other']),
      status: z.enum(['draft', 'pending', 'completed', 'cancelled', 'refunded']).default('draft'),
      number: z.string().optional(),
      organization_id: z.string().uuid().optional(),
      contact_id: z.string().uuid().optional(),
      currency: z.string().default('RON'),
      amount: z.number().default(0),
      tax_amount: z.number().default(0),
      total_amount: z.number().default(0),
      due_date: z.string().optional(),
      paid_date: z.string().optional(),
      line_items: z.array(z.record(z.unknown())).optional(),
      notes: z.string().optional(),
      reference: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    })),
    async (c) => {
      const user = c.get('user') as any;
      const d = c.req.valid('json');
      const result = await sql`
        INSERT INTO zvd_transactions
          (type, status, number, organization_id, contact_id, currency,
           amount, tax_amount, total_amount, due_date, paid_date,
           line_items, notes, reference, metadata, created_by)
        VALUES
          (${d.type}, ${d.status}, ${d.number ?? null},
           ${d.organization_id ?? null}, ${d.contact_id ?? null}, ${d.currency},
           ${d.amount}, ${d.tax_amount}, ${d.total_amount},
           ${d.due_date ?? null}, ${d.paid_date ?? null},
           ${JSON.stringify(d.line_items ?? [])}::jsonb,
           ${d.notes ?? null}, ${d.reference ?? null},
           ${JSON.stringify(d.metadata ?? {})}::jsonb, ${user.id})
        RETURNING *
      `.execute(db);
      return c.json({ data: result.rows[0] }, 201);
    },
  );

  app.patch('/transactions/:id',
    zValidator('json', z.object({
      status: z.enum(['draft', 'pending', 'completed', 'cancelled', 'refunded']).optional(),
      number: z.string().optional(),
      currency: z.string().optional(),
      amount: z.number().optional(),
      tax_amount: z.number().optional(),
      total_amount: z.number().optional(),
      due_date: z.string().optional(),
      paid_date: z.string().optional(),
      notes: z.string().optional(),
      reference: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    })),
    async (c) => {
      const d = c.req.valid('json');
      const id = c.req.param('id');
      const sets: string[] = [];
      const vals: any[] = [];
      let i = 1;
      for (const [k, v] of Object.entries(d)) {
        if (v !== undefined) {
          sets.push(`${k} = $${i++}`);
          vals.push(k === 'metadata' || k === 'line_items' ? JSON.stringify(v) : v);
        }
      }
      if (!sets.length) return c.json({ error: 'No fields to update' }, 400);
      const result = await db.executeQuery({ sql: `UPDATE zvd_transactions SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING *`, parameters: [...vals, id] } as any);
      if (!(result as any).rows.length) return c.json({ error: 'Not found' }, 404);
      return c.json({ data: (result as any).rows[0] });
    },
  );

  app.delete('/transactions/:id', async (c) => {
    const user = c.get('user') as any;
    const id = c.req.param('id');
    const existing = await sql<{ created_by: string }>`
      SELECT created_by FROM zvd_transactions WHERE id = ${id}
    `.execute(db);
    if (!existing.rows[0]) return c.json({ error: 'Not found' }, 404);
    const isAdmin = await checkPermission(user.id, 'admin', '*');
    if (existing.rows[0].created_by !== user.id && !isAdmin) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    await sql`DELETE FROM zvd_transactions WHERE id = ${id}`.execute(db);
    return c.json({ success: true });
  });

  return app;
}
