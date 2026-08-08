/**
 * What the business needs from you today.
 *
 * Everything else the product measures is about the product: rows stored, API
 * calls served, webhooks active, collections defined. All true, none of it a
 * reason to open the page twice. An entrepreneur wants to know whether the
 * business is working, not whether the software is.
 *
 * So this answers one question to begin with, and it is the one every business
 * has: who owes me money. Nothing here is configured — `insights` already does
 * configurable panels well, and a panel you have to build first is a tool, not
 * an answer. These facts are derived from data every install already has.
 *
 * WHY `transactions` AND NOT THE INVOICING EXTENSION
 *
 * `transactions` is a CORE collection: it exists on every instance, with
 * `payment_status`, `due_date`, `total_amount` and `currency` in its shape. An
 * install with no extensions at all can still be told that three customers are
 * late. Reading the invoicing extension instead would make the answer depend on
 * which modules someone happened to enable, which is exactly the fragmentation
 * this is meant to undo.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * No summing across currencies. Adding RON to EUR produces a number that is
 * wrong in a way nobody notices, so amounts are grouped and the caller decides
 * how to show them.
 *
 * No opinion about what is "a lot". A threshold that means something to a
 * corner shop is noise to a distributor, and inventing one would teach people
 * to ignore the screen.
 *
 * It fails soft and returns zeroes. This is the first thing rendered after
 * sign-in, and a dashboard that 500s because a table is missing on a fresh
 * install is worse than one that says there is nothing to chase.
 */
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { getCurrentTenantTrx } from '../lib/tenancy/index.js';

/** Money owed, per currency, because adding them together would be a lie. */
export interface OverdueBucket {
  currency: string;
  count: number;
  total: number;
}

export interface Receivables {
  /** Past `due_date` and not settled. */
  overdue: OverdueBucket[];
  /** Days since the oldest unpaid invoice fell due, or null when none has. */
  oldestOverdueDays: number | null;
  /** Falling due in the next seven days — the ones still worth a phone call. */
  dueSoon: OverdueBucket[];
}

/** Statuses that mean the money is no longer coming. */
const SETTLED = ['completed', 'cancelled', 'refunded'];

async function receivables(db: Database): Promise<Receivables> {
  const empty: Receivables = { overdue: [], oldestOverdueDays: null, dueSoon: [] };
  try {
    const overdue = await sql<{ currency: string; count: number; total: number }>`
      SELECT currency,
             count(*)::int          AS count,
             COALESCE(sum(total_amount), 0)::float8 AS total
        FROM zvd_transactions
       WHERE type = 'invoice'
         AND due_date IS NOT NULL
         AND due_date < CURRENT_DATE
         AND payment_status NOT IN (${sql.join(SETTLED.map((s) => sql`${s}`))})
       GROUP BY currency
       ORDER BY total DESC
    `.execute(db);

    const oldest = await sql<{ days: number | null }>`
      SELECT (CURRENT_DATE - min(due_date))::int AS days
        FROM zvd_transactions
       WHERE type = 'invoice'
         AND due_date IS NOT NULL
         AND due_date < CURRENT_DATE
         AND payment_status NOT IN (${sql.join(SETTLED.map((s) => sql`${s}`))})
    `.execute(db);

    const soon = await sql<{ currency: string; count: number; total: number }>`
      SELECT currency,
             count(*)::int          AS count,
             COALESCE(sum(total_amount), 0)::float8 AS total
        FROM zvd_transactions
       WHERE type = 'invoice'
         AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7
         AND payment_status NOT IN (${sql.join(SETTLED.map((s) => sql`${s}`))})
       GROUP BY currency
       ORDER BY total DESC
    `.execute(db);

    return {
      overdue: overdue.rows,
      oldestOverdueDays: oldest.rows[0]?.days ?? null,
      dueSoon: soon.rows,
    };
  } catch {
    // A missing table on a fresh install, or a collection an administrator
    // reshaped. Neither is a reason to fail the first screen someone sees.
    return empty;
  }
}

/**
 * Just the one thing this route asks of better-auth.
 *
 * Other route files take the instance as `any` with a documented note, because
 * better-auth exports no usable type for it. This needs a single method, so a
 * structural type costs nothing and keeps the suppression count where it is —
 * which is the whole point of the ratchet.
 */
interface SessionReader {
  api: { getSession: (opts: { headers: Headers }) => Promise<unknown> };
}

export function briefingRoutes(db: Database, auth: SessionReader): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    // The request's tenant transaction, so the numbers are this tenant's and
    // RLS is what makes that true rather than a WHERE clause someone could
    // forget. Falls back to the pool only outside a request, where there is
    // nothing to scope to.
    const scoped = getCurrentTenantTrx() ?? db;
    return c.json({ receivables: await receivables(scoped) });
  });

  return app;
}
