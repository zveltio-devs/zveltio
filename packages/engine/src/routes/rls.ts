import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { checkPermission } from '../lib/permissions.js';
import {
  listRlsPolicies,
  createRlsPolicy,
  updateRlsPolicy,
  deleteRlsPolicy,
} from '../lib/rls.js';

async function requireAdmin(c: any, auth: any): Promise<any | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  if (!(await checkPermission(session.user.id, 'admin', '*'))) return null;
  return session.user;
}

const PolicySchema = z.object({
  collection: z.string().min(1).max(128),
  role: z.string().min(1).max(128),
  filter_field: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'Invalid field name'),
  filter_op: z.enum(['eq', 'neq', 'in', 'not_in']).default('eq'),
  filter_value_source: z.string().min(1).max(256),
  is_enabled: z.boolean().default(true),
  description: z.string().max(512).optional(),
});

export function rlsRoutes(_db: Database, auth: any): Hono {
  const app = new Hono();

  // GET /api/admin/rls — list all policies
  app.get('/', async (c) => {
    const user = await requireAdmin(c, auth);
    if (!user) return c.json({ error: 'Forbidden' }, 403);

    const policies = await listRlsPolicies();
    return c.json({ policies });
  });

  // POST /api/admin/rls — create policy
  app.post('/', zValidator('json', PolicySchema), async (c) => {
    const user = await requireAdmin(c, auth);
    if (!user) return c.json({ error: 'Forbidden' }, 403);

    const data = c.req.valid('json');
    const policy = await createRlsPolicy(data);
    return c.json({ policy }, 201);
  });

  // PATCH /api/admin/rls/:id — update policy
  app.patch('/:id', zValidator('json', PolicySchema.partial()), async (c) => {
    const user = await requireAdmin(c, auth);
    if (!user) return c.json({ error: 'Forbidden' }, 403);

    const id = c.req.param('id');
    const data = c.req.valid('json');
    const policy = await updateRlsPolicy(id, data);
    if (!policy) return c.json({ error: 'Policy not found' }, 404);
    return c.json({ policy });
  });

  // DELETE /api/admin/rls/:id — delete policy
  app.delete('/:id', async (c) => {
    const user = await requireAdmin(c, auth);
    if (!user) return c.json({ error: 'Forbidden' }, 403);

    const id = c.req.param('id');
    const ok = await deleteRlsPolicy(id);
    if (!ok) return c.json({ error: 'Policy not found' }, 404);
    return c.json({ success: true });
  });

  return app;
}
