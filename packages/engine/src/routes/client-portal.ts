/**
 * Client Portal API — /api/portal-client/*
 *
 * Data isolation: every query is scoped to the operator(s) linked to the
 * authenticated user via zv_portal_operator_users.  Admins bypass isolation
 * to manage the portal from the admin panel.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';

// ── Auth helpers ─────────────────────────────────────────────

async function getUser(c: any, auth: any) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

/** Returns operator UUIDs the authenticated user is linked to. */
async function getUserOperatorIds(db: Database, userId: string): Promise<string[]> {
  const rows = await (db as any)
    .selectFrom('zv_portal_operator_users')
    .select('operator_id')
    .where('user_id', '=', userId)
    .where('is_verified', '=', true)
    .execute();
  return rows.map((r: any) => r.operator_id);
}

/** Auto-generates a reference number: PREFIX-YEAR-SEQUENCE */
async function nextReference(db: Database, prefix: string): Promise<string> {
  const year = new Date().getFullYear();
  const res = await sql<{ n: string }>`
    SELECT COALESCE(MAX(CAST(SPLIT_PART(reference_number, '-', 3) AS INT)), 0) + 1 AS n
    FROM (
      SELECT reference_number FROM zv_portal_authorizations
      WHERE reference_number LIKE ${`${prefix}-${year}-%`}
      UNION ALL
      SELECT reference_number FROM zv_portal_requests
      WHERE reference_number LIKE ${`${prefix}-${year}-%`}
      UNION ALL
      SELECT reference_number FROM zv_portal_inspections
      WHERE reference_number LIKE ${`${prefix}-${year}-%`}
    ) t
  `.execute(db).catch(() => ({ rows: [{ n: '1' }] }));
  const seq = String(parseInt(res.rows[0]?.n ?? '1')).padStart(5, '0');
  return `${prefix}-${year}-${seq}`;
}

// ─────────────────────────────────────────────────────────────

export function clientPortalRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // ── Public: portal configuration ─────────────────────────

  app.get('/config', async (c) => {
    const config = await (db as any)
      .selectFrom('zv_portal_config')
      .selectAll()
      .limit(1)
      .executeTakeFirst();
    return c.json({ config: config ?? { template: 'generic', is_enabled: false } });
  });

  // ── Auth guard for all remaining routes ──────────────────

  app.use('*', async (c, next) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', user);
    await next();
  });

  // ── My profile + operator context ────────────────────────

  app.get('/me', async (c) => {
    const user = c.get('user') as any;
    const operatorLinks = await (db as any)
      .selectFrom('zv_portal_operator_users as ou')
      .innerJoin('zv_portal_operators as o', 'o.id', 'ou.operator_id')
      .select([
        'o.id', 'o.fiscal_code', 'o.name', 'o.legal_form',
        'o.address', 'o.county', 'o.status', 'ou.role', 'ou.is_verified',
      ])
      .where('ou.user_id', '=', user.id)
      .execute();
    return c.json({ user, operators: operatorLinks });
  });

  // ── Operator self-registration ────────────────────────────

  app.post(
    '/operators/register',
    zValidator('json', z.object({
      fiscal_code: z.string().min(2).max(20),
      name: z.string().min(2),
      legal_form: z.string().optional(),
      address: z.string().optional(),
      county: z.string().optional(),
      contact_email: z.string().email().optional(),
      contact_phone: z.string().optional(),
    })),
    async (c) => {
      const user = c.get('user') as any;
      const data = c.req.valid('json');

      // Upsert operator
      let operator = await (db as any)
        .selectFrom('zv_portal_operators')
        .where('fiscal_code', '=', data.fiscal_code)
        .selectAll()
        .executeTakeFirst();

      if (!operator) {
        operator = await (db as any)
          .insertInto('zv_portal_operators')
          .values({ ...data, status: 'active' })
          .returningAll()
          .executeTakeFirst();
      }

      // Link user as representative (pending verification)
      await (db as any)
        .insertInto('zv_portal_operator_users')
        .values({ operator_id: operator.id, user_id: user.id, role: 'representative', is_verified: false })
        .onConflict((oc: any) => oc.columns(['operator_id', 'user_id']).doNothing())
        .execute();

      return c.json({ operator, message: 'Registration submitted — awaiting verification' }, 201);
    },
  );

  // ── Business Locations (puncte de lucru) ─────────────────

  app.get('/locations', async (c) => {
    const user = c.get('user') as any;
    const opIds = await getUserOperatorIds(db, user.id);
    if (opIds.length === 0) return c.json({ locations: [] });

    const locations = await (db as any)
      .selectFrom('zv_portal_locations')
      .selectAll()
      .where('operator_id', 'in', opIds)
      .orderBy('name', 'asc')
      .execute();
    return c.json({ locations });
  });

  app.post(
    '/locations',
    zValidator('json', z.object({
      operator_id: z.string().uuid(),
      name: z.string().min(2),
      address: z.string().min(5),
      county: z.string().optional(),
      activity_code: z.string().optional(),
      activity_desc: z.string().optional(),
      location_type: z.string().default('sediu_secundar'),
    })),
    async (c) => {
      const user = c.get('user') as any;
      const data = c.req.valid('json');
      const opIds = await getUserOperatorIds(db, user.id);
      if (!opIds.includes(data.operator_id))
        return c.json({ error: 'Forbidden' }, 403);

      const loc = await (db as any)
        .insertInto('zv_portal_locations')
        .values({ ...data, status: 'active' })
        .returningAll()
        .executeTakeFirst();
      return c.json({ location: loc }, 201);
    },
  );

  app.delete('/locations/:id', async (c) => {
    const user = c.get('user') as any;
    const opIds = await getUserOperatorIds(db, user.id);
    const loc = await (db as any)
      .selectFrom('zv_portal_locations')
      .where('id', '=', c.req.param('id'))
      .selectAll()
      .executeTakeFirst();
    if (!loc || !opIds.includes(loc.operator_id)) return c.json({ error: 'Not found' }, 404);
    await (db as any).deleteFrom('zv_portal_locations').where('id', '=', loc.id).execute();
    return c.json({ success: true });
  });

  app.patch('/locations/:id', async (c) => {
    const user = c.get('user') as any;
    const opIds = await getUserOperatorIds(db, user.id);
    const loc = await (db as any)
      .selectFrom('zv_portal_locations')
      .where('id', '=', c.req.param('id'))
      .selectAll()
      .executeTakeFirst();
    if (!loc || !opIds.includes(loc.operator_id)) return c.json({ error: 'Not found' }, 404);
    const body = await c.req.json();
    const allowed = ['name', 'address', 'county', 'activity_code', 'activity_desc', 'location_type', 'status'];
    const updates: any = {};
    for (const k of allowed) if (k in body) updates[k] = body[k];
    if (Object.keys(updates).length === 0) return c.json({ error: 'Nothing to update' }, 400);
    await (db as any).updateTable('zv_portal_locations').set(updates).where('id', '=', loc.id).execute();
    return c.json({ success: true });
  });

  // ── Authorizations (cereri de autorizare) ────────────────

  app.get('/authorizations', async (c) => {
    const user = c.get('user') as any;
    const opIds = await getUserOperatorIds(db, user.id);
    if (opIds.length === 0) return c.json({ authorizations: [] });

    const { status, location_id } = c.req.query();
    let query = (db as any)
      .selectFrom('zv_portal_authorizations as a')
      .leftJoin('zv_portal_locations as l', 'l.id', 'a.location_id')
      .select([
        'a.id', 'a.authorization_type', 'a.reference_number', 'a.title',
        'a.status', 'a.submitted_at', 'a.valid_from', 'a.valid_until',
        'a.created_at', 'a.reviewer_notes',
        'l.name as location_name', 'l.address as location_address',
      ])
      .where('a.operator_id', 'in', opIds)
      .orderBy('a.created_at', 'desc');

    if (status) query = query.where('a.status', '=', status);
    if (location_id) query = query.where('a.location_id', '=', location_id);

    return c.json({ authorizations: await query.execute() });
  });

  app.get('/authorizations/:id', async (c) => {
    const user = c.get('user') as any;
    const opIds = await getUserOperatorIds(db, user.id);
    const auth_ = await (db as any)
      .selectFrom('zv_portal_authorizations')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();
    if (!auth_ || !opIds.includes(auth_.operator_id)) return c.json({ error: 'Not found' }, 404);

    const docs = await (db as any)
      .selectFrom('zv_portal_documents')
      .selectAll()
      .where('authorization_id', '=', auth_.id)
      .execute();

    return c.json({ authorization: auth_, documents: docs });
  });

  app.post(
    '/authorizations',
    zValidator('json', z.object({
      operator_id: z.string().uuid(),
      location_id: z.string().uuid().optional(),
      authorization_type: z.string().min(2),
      title: z.string().min(3),
      description: z.string().optional(),
      submit: z.boolean().default(false),
    })),
    async (c) => {
      const user = c.get('user') as any;
      const data = c.req.valid('json');
      const opIds = await getUserOperatorIds(db, user.id);
      if (!opIds.includes(data.operator_id))
        return c.json({ error: 'Forbidden' }, 403);

      const refNum = data.submit ? await nextReference(db, 'AUTH') : null;
      const auth_ = await (db as any)
        .insertInto('zv_portal_authorizations')
        .values({
          operator_id: data.operator_id,
          location_id: data.location_id ?? null,
          authorization_type: data.authorization_type,
          reference_number: refNum,
          title: data.title,
          description: data.description ?? null,
          status: data.submit ? 'submitted' : 'draft',
          submitted_at: data.submit ? new Date() : null,
          created_by: user.id,
        })
        .returningAll()
        .executeTakeFirst();

      return c.json({ authorization: auth_ }, 201);
    },
  );

  app.post('/authorizations/:id/submit', async (c) => {
    const user = c.get('user') as any;
    const opIds = await getUserOperatorIds(db, user.id);
    const auth_ = await (db as any)
      .selectFrom('zv_portal_authorizations')
      .where('id', '=', c.req.param('id'))
      .selectAll()
      .executeTakeFirst();
    if (!auth_ || !opIds.includes(auth_.operator_id)) return c.json({ error: 'Not found' }, 404);
    if (auth_.status !== 'draft') return c.json({ error: 'Only draft authorizations can be submitted' }, 400);

    const refNum = await nextReference(db, 'AUTH');
    await (db as any)
      .updateTable('zv_portal_authorizations')
      .set({ status: 'submitted', submitted_at: new Date(), reference_number: refNum })
      .where('id', '=', auth_.id)
      .execute();
    return c.json({ success: true, reference_number: refNum });
  });

  // ── Inspections (controale) — read-only for operators ────

  app.get('/inspections', async (c) => {
    const user = c.get('user') as any;
    const opIds = await getUserOperatorIds(db, user.id);
    if (opIds.length === 0) return c.json({ inspections: [] });

    const { status, location_id } = c.req.query();
    let query = (db as any)
      .selectFrom('zv_portal_inspections as i')
      .leftJoin('zv_portal_locations as l', 'l.id', 'i.location_id')
      .select([
        'i.id', 'i.inspection_type', 'i.reference_number', 'i.status', 'i.result',
        'i.scheduled_date', 'i.completed_date', 'i.inspector_name', 'i.inspector_team',
        'i.findings', 'i.remediation_deadline', 'i.created_at',
        'l.name as location_name', 'l.address as location_address',
      ])
      .where('i.operator_id', 'in', opIds)
      .orderBy('i.scheduled_date', 'desc');

    if (status) query = query.where('i.status', '=', status);
    if (location_id) query = query.where('i.location_id', '=', location_id);

    return c.json({ inspections: await query.execute() });
  });

  app.get('/inspections/:id', async (c) => {
    const user = c.get('user') as any;
    const opIds = await getUserOperatorIds(db, user.id);
    const insp = await (db as any)
      .selectFrom('zv_portal_inspections')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();
    if (!insp || !opIds.includes(insp.operator_id)) return c.json({ error: 'Not found' }, 404);
    return c.json({ inspection: insp });
  });

  // ── Requests (cereri diverse) ─────────────────────────────

  app.get('/requests', async (c) => {
    const user = c.get('user') as any;
    const { status } = c.req.query();
    let query = (db as any)
      .selectFrom('zv_portal_requests')
      .selectAll()
      .where('user_id', '=', user.id)
      .orderBy('created_at', 'desc');
    if (status) query = query.where('status', '=', status);
    return c.json({ requests: await query.execute() });
  });

  app.post(
    '/requests',
    zValidator('json', z.object({
      operator_id: z.string().uuid().optional(),
      request_type: z.string().default('general'),
      subject: z.string().min(3),
      description: z.string().optional(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
    })),
    async (c) => {
      const user = c.get('user') as any;
      const data = c.req.valid('json');

      if (data.operator_id) {
        const opIds = await getUserOperatorIds(db, user.id);
        if (!opIds.includes(data.operator_id))
          return c.json({ error: 'Forbidden' }, 403);
      }

      const refNum = await nextReference(db, 'REQ');
      const req = await (db as any)
        .insertInto('zv_portal_requests')
        .values({ ...data, user_id: user.id, reference_number: refNum, status: 'submitted' })
        .returningAll()
        .executeTakeFirst();
      return c.json({ request: req }, 201);
    },
  );

  // ── Tickets (generic / saas / services) ──────────────────

  app.get('/tickets', async (c) => {
    const user = c.get('user') as any;
    const tickets = await (db as any)
      .selectFrom('zv_portal_tickets')
      .selectAll()
      .where('user_id', '=', user.id)
      .orderBy('created_at', 'desc')
      .execute();
    return c.json({ tickets });
  });

  app.post(
    '/tickets',
    zValidator('json', z.object({
      subject: z.string().min(3),
      message: z.string().optional(),
      description: z.string().optional(),
      category: z.string().default('general'),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
    })),
    async (c) => {
      const user = c.get('user') as any;
      const data = c.req.valid('json');
      const description = data.message ?? data.description ?? null;
      const ticket = await (db as any)
        .insertInto('zv_portal_tickets')
        .values({ subject: data.subject, description, category: data.category, priority: data.priority, user_id: user.id, status: 'open' })
        .returningAll()
        .executeTakeFirst();
      // Save first message if provided
      if (description) {
        await (db as any).insertInto('zv_portal_ticket_messages')
          .values({ ticket_id: ticket.id, user_id: user.id, content: description, is_internal: false })
          .execute().catch(() => {});
      }
      return c.json({ ticket }, 201);
    },
  );

  app.get('/tickets/:id/messages', async (c) => {
    const user = c.get('user') as any;
    const ticket = await (db as any)
      .selectFrom('zv_portal_tickets')
      .where('id', '=', c.req.param('id'))
      .where('user_id', '=', user.id)
      .selectAll()
      .executeTakeFirst();
    if (!ticket) return c.json({ error: 'Not found' }, 404);
    const messages = await (db as any)
      .selectFrom('zv_portal_ticket_messages')
      .selectAll()
      .where('ticket_id', '=', ticket.id)
      .where('is_internal', '=', false)
      .orderBy('created_at', 'asc')
      .execute();
    return c.json({ ticket, messages });
  });

  app.post('/tickets/:id/messages', async (c) => {
    const user = c.get('user') as any;
    const ticket = await (db as any)
      .selectFrom('zv_portal_tickets')
      .where('id', '=', c.req.param('id'))
      .where('user_id', '=', user.id)
      .selectAll()
      .executeTakeFirst();
    if (!ticket) return c.json({ error: 'Not found' }, 404);
    const { content } = await c.req.json();
    if (!content?.trim()) return c.json({ error: 'Content required' }, 400);
    const msg = await (db as any)
      .insertInto('zv_portal_ticket_messages')
      .values({ ticket_id: ticket.id, user_id: user.id, content, is_internal: false })
      .returningAll()
      .executeTakeFirst();
    // Reopen if closed
    if (ticket.status === 'resolved' || ticket.status === 'closed') {
      await (db as any).updateTable('zv_portal_tickets')
        .set({ status: 'open', updated_at: new Date() }).where('id', '=', ticket.id).execute();
    }
    return c.json({ message: msg }, 201);
  });

  // ── Portal config management (admin) ─────────────────────

  app.get('/admin/config', async (c) => {
    const user = c.get('user') as any;
    const { checkPermission } = await import('../lib/permissions.js');
    if (!(await checkPermission(user.id, 'admin', '*')))
      return c.json({ error: 'Admin access required' }, 403);
    const config = await (db as any)
      .selectFrom('zv_portal_config').selectAll().limit(1).executeTakeFirst();
    return c.json({ config });
  });

  app.patch(
    '/admin/config',
    zValidator('json', z.object({
      template: z.enum(['generic', 'saas', 'services', 'regulatory']).optional(),
      is_enabled: z.boolean().optional(),
      site_name: z.string().optional(),
      site_logo: z.string().optional(),
      primary_color: z.string().optional(),
      config: z.record(z.any()).optional(),
    })),
    async (c) => {
      const user = c.get('user') as any;
      const { checkPermission } = await import('../lib/permissions.js');
      if (!(await checkPermission(user.id, 'admin', '*')))
        return c.json({ error: 'Admin access required' }, 403);
      const data = c.req.valid('json');
      const existing = await (db as any).selectFrom('zv_portal_config').selectAll().limit(1).executeTakeFirst();
      if (existing) {
        await (db as any).updateTable('zv_portal_config')
          .set({ ...data, updated_at: new Date() })
          .execute();
      } else {
        await (db as any).insertInto('zv_portal_config')
          .values({ template: 'generic', is_enabled: false, site_name: 'Client Portal', primary_color: '#069494', ...data })
          .execute();
      }
      return c.json({ success: true });
    },
  );

  // ── Admin: manage operator verifications ─────────────────

  app.get('/admin/operators', async (c) => {
    const user = c.get('user') as any;
    const { checkPermission } = await import('../lib/permissions.js');
    if (!(await checkPermission(user.id, 'admin', '*')))
      return c.json({ error: 'Admin access required' }, 403);
    const operators = await (db as any)
      .selectFrom('zv_portal_operators').selectAll().orderBy('name', 'asc').execute();
    // Attach linked users for each operator
    const opIds = operators.map((o: any) => o.id);
    const links = opIds.length > 0
      ? await (db as any)
          .selectFrom('zv_portal_operator_users as ou')
          .innerJoin('user as u', 'u.id', 'ou.user_id')
          .select(['ou.operator_id', 'ou.user_id', 'ou.role', 'ou.is_verified', 'u.name', 'u.email'])
          .where('ou.operator_id', 'in', opIds)
          .execute()
          .catch(() => [])
      : [];
    const grouped = operators.map((op: any) => ({
      ...op,
      users: links.filter((l: any) => l.operator_id === op.id),
    }));
    return c.json({ operators: grouped });
  });

  app.patch('/admin/operators/:id/verify-user/:userId', async (c) => {
    const user = c.get('user') as any;
    const { checkPermission } = await import('../lib/permissions.js');
    if (!(await checkPermission(user.id, 'admin', '*')))
      return c.json({ error: 'Admin access required' }, 403);
    await (db as any)
      .updateTable('zv_portal_operator_users')
      .set({ is_verified: true })
      .where('operator_id', '=', c.req.param('id'))
      .where('user_id', '=', c.req.param('userId'))
      .execute();
    return c.json({ success: true });
  });

  // Admin: create/update inspections
  app.post(
    '/admin/inspections',
    zValidator('json', z.object({
      operator_id: z.string().uuid(),
      location_id: z.string().uuid().optional(),
      inspection_type: z.string().default('routine'),
      scheduled_date: z.string().optional(),
      inspector_name: z.string().optional(),
      inspector_team: z.string().optional(),
    })),
    async (c) => {
      const user = c.get('user') as any;
      const { checkPermission } = await import('../lib/permissions.js');
      if (!(await checkPermission(user.id, 'admin', '*')))
        return c.json({ error: 'Admin access required' }, 403);
      const data = c.req.valid('json');
      const refNum = await nextReference(db, 'CTRL');
      const insp = await (db as any)
        .insertInto('zv_portal_inspections')
        .values({
          ...data,
          reference_number: refNum,
          scheduled_date: data.scheduled_date ? new Date(data.scheduled_date) : null,
          status: 'scheduled',
        })
        .returningAll()
        .executeTakeFirst();
      return c.json({ inspection: insp }, 201);
    },
  );

  app.patch('/admin/inspections/:id', async (c) => {
    const user = c.get('user') as any;
    const { checkPermission } = await import('../lib/permissions.js');
    if (!(await checkPermission(user.id, 'admin', '*')))
      return c.json({ error: 'Admin access required' }, 403);
    const body = await c.req.json();
    const allowed = ['status', 'result', 'findings', 'completed_date', 'remediation_deadline', 'report_url'];
    const updates: any = {};
    for (const k of allowed) if (k in body) updates[k] = body[k];
    await (db as any).updateTable('zv_portal_inspections')
      .set({ ...updates, updated_at: new Date() })
      .where('id', '=', c.req.param('id'))
      .execute();
    return c.json({ success: true });
  });

  return app;
}
