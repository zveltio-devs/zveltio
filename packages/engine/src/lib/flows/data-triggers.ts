import type { Database } from '../../db/index.js';
import { DEFAULT_TENANT_ID } from '../tenancy/index.js';
import { executeFlow } from './flow-executor.js';

/**
 * Trigger data-event flows when a record is created/updated/deleted.
 * Called from the data route after each write operation.
 *
 * Reads each candidate flow's trigger_config to decide which to execute.
 *
 * Scoped to the writing tenant: a write in tenant A must only fire tenant A's
 * flows. Without this a record created in one tenant would trigger (and run) every
 * other tenant's matching flow — cross-tenant execution. The write pipeline passes
 * its resolved tenant id; when absent (single-tenant installs) it falls back to the
 * default tenant, which is also where those flows' backfilled tenant_id points.
 */
export async function triggerDataFlows(
  db: Database,
  collection: string,
  event: 'insert' | 'update' | 'delete',
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  record: any,
  tenantId?: string | null,
): Promise<void> {
  try {
    // Map the data-route event vocabulary onto the trigger_type CHECK
    // constraint values stored in zv_flows.
    const triggerType =
      event === 'insert' ? 'on_create' : event === 'update' ? 'on_update' : 'on_delete';

    const flows = await db
      .selectFrom('zv_flows')
      .selectAll()
      .where('is_active', '=', true)
      .where('trigger_type', '=', triggerType)
      .where('tenant_id', '=', tenantId || DEFAULT_TENANT_ID)
      .execute();

    for (const flow of flows) {
      const cfg = (
        typeof flow.trigger_config === 'string'
          ? JSON.parse(flow.trigger_config)
          : (flow.trigger_config ?? {})
      ) as { collection?: string };
      if (cfg.collection === collection) {
        executeFlow(db, flow.id, { collection, event, record }).catch(console.error);
      }
    }
  } catch (err) {
    // Flow triggering must not break data operations — the write already
    // succeeded and failing it now would be worse than the automation not running.
    //
    // But this was a bare `catch {}` with only that sentence in it, and the flow
    // lookup above carried `.catch(() => [])` on top, so an automation that
    // stopped firing produced no error, no warning, and no count. The operator
    // sees the event happen and no consequence, with nothing to search for. The
    // swallow stays; the silence does not.
    console.error(
      `[flows] trigger "${event}" on ${collection} did not run its automations:`,
      err instanceof Error ? err.message : err,
    );
  }
}
