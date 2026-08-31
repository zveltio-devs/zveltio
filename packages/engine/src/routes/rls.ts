import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { checkPermission, requireInstanceAdmin } from '../lib/tenancy/index.js';
import {
  listRlsPolicies,
  createRlsPolicy,
  updateRlsPolicy,
  deleteRlsPolicy,
} from '../lib/tenancy/index.js';

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
async function requireAdmin(c: any, auth: any): Promise<any | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  if (!(await requireInstanceAdmin(session.user.id))) return null;
  return session.user;
}

const PolicySchema = z.object({
  collection: z.string().min(1).max(128),
  role: z.string().min(1).max(128),
  filter_field: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'Invalid field name'),
  filter_op: z.enum(['eq', 'neq', 'in', 'not_in']).default('eq'),
  // The four sources the resolvers actually know, spelled out.
  //
  // `z.string()` accepted anything, and `user.id` — a dot instead of an
  // underscore — was stored happily and then resolved to nothing, so the rule
  // existed, was listed as enabled, and hid no rows. A harness test posted
  // exactly that and asserted 201 for as long as it has existed.
  filter_value_source: z
    .string()
    .min(1)
    .max(256)
    .refine(
      (v) => v === 'user_id' || v === 'user_email' || v === 'user_role' || v.startsWith('static:'),
      { message: 'must be user_id, user_email, user_role, or static:<value>' },
    ),
  is_enabled: z.boolean().default(true),
  description: z.string().max(512).optional(),
});

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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
    try {
      const policy = await createRlsPolicy(data);
      return c.json({ policy }, 201);
    } catch (err) {
      // A rule the layers cannot agree on is refused with the reason, not
      // stored and left to mean three different things.
      if ((err as Error).name === 'UnenforceableRuleError') {
        return c.json(
          {
            error: 'This rule cannot be enforced',
            detail: (err as Error).message,
            code: 'unenforceable_rls_rule',
          },
          400,
        );
      }
      throw err;
    }
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
