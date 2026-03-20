import type { Database } from '../db/index.js';
import { DDLManager } from './ddl-manager.js';

let _db: Database;

export async function initDDLQueue(db: Database): Promise<void> {
  _db = db;

  // On startup, reset any jobs left in 'running' (process crashed mid-DDL) so they are retried.
  await db
    .updateTable('zv_ddl_jobs' as any)
    .set({ status: 'pending' } as any)
    .where('status' as any, '=', 'running')
    .execute();

  // Poll for pending jobs every 2 seconds
  setInterval(() => processNextJob(), 2000);
}

export async function enqueueDDLJob(
  db: Database,
  type: string,
  payload: any,
): Promise<string> {
  const result = await db
    .insertInto('zv_ddl_jobs' as any)
    .values({
      type,
      payload: JSON.stringify(payload),
      status: 'pending',
    } as any)
    .returning('id' as any)
    .executeTakeFirst();
  return (result as any).id;
}

export async function getDDLJob(
  db: Database,
  jobId: string,
): Promise<any | null> {
  const row = await db
    .selectFrom('zv_ddl_jobs' as any)
    .selectAll()
    .where('id' as any, '=', jobId)
    .executeTakeFirst();
  return row || null;
}

async function processNextJob(): Promise<void> {
  if (!_db) return;

  // Claim one pending job
  const job = await _db
    .selectFrom('zv_ddl_jobs' as any)
    .selectAll()
    .where('status' as any, '=', 'pending')
    .orderBy('created_at' as any)
    .limit(1)
    .executeTakeFirst();

  if (!job) return;

  // Mark as running (with a guard to avoid two pollers claiming the same job)
  const claimed = await _db
    .updateTable('zv_ddl_jobs' as any)
    .set({ status: 'running', started_at: new Date() } as any)
    .where('id' as any, '=', (job as any).id)
    .where('status' as any, '=', 'pending')
    .returning('id' as any)
    .executeTakeFirst();

  if (!claimed) return; // another poller claimed it first

  try {
    const payload =
      typeof (job as any).payload === 'string'
        ? JSON.parse((job as any).payload)
        : (job as any).payload;

    // Execute DDL inside a transaction — on failure, everything rolls back atomically
    await (_db as any).transaction().execute(async (trx: any) => {
      // BYOD Guard: block DDL on unmanaged collections (drop, add_field, remove_field)
      const byodSensitiveTypes = [
        'drop_collection',
        'add_field',
        'remove_field',
      ];
      if (byodSensitiveTypes.includes((job as any).type)) {
        const collectionName: string | undefined =
          payload.collection ?? payload.name;
        if (collectionName) {
          const meta = await trx
            .selectFrom('zvd_collections' as any)
            .select('is_managed' as any)
            .where('name' as any, '=', collectionName)
            .executeTakeFirst()
            .catch(() => null);

          if (meta && (meta as any).is_managed === false) {
            await trx
              .updateTable('zv_ddl_jobs' as any)
              .set({
                status: 'completed',
                completed_at: new Date(),
                error: `Skipped: collection "${collectionName}" is unmanaged (BYOD). DDL not allowed.`,
              } as any)
              .where('id' as any, '=', (job as any).id)
              .execute();
            return;
          }
        }
      }

      switch ((job as any).type) {
        case 'create_collection':
          await DDLManager.createCollection(trx, payload);
          break;
        case 'drop_collection':
          await DDLManager.dropCollection(trx, payload.name);
          break;
        case 'add_field':
          // payload: { collection: string, field: FieldSchema }
          await DDLManager.addField(trx, payload.collection, payload.field);
          break;
        case 'remove_field':
          // payload: { collection: string, fieldName: string }
          await DDLManager.removeField(trx, payload.collection, payload.fieldName);
          break;
        default:
          throw new Error(`Unknown DDL job type: ${(job as any).type}`);
      }

      // Mark complete inside the same transaction so DDL + status update are atomic
      await trx
        .updateTable('zv_ddl_jobs' as any)
        .set({ status: 'completed', completed_at: new Date() } as any)
        .where('id' as any, '=', (job as any).id)
        .execute();
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const retryCount = ((job as any).retry_count ?? 0) + 1;

    // Persist failure and increment retry counter (outside the rolled-back transaction)
    await _db
      .updateTable('zv_ddl_jobs' as any)
      .set({
        status: 'failed',
        error,
        completed_at: new Date(),
        retry_count: retryCount,
      } as any)
      .where('id' as any, '=', (job as any).id)
      .execute();

    console.error(
      `DDL job ${(job as any).id} failed (attempt ${retryCount}):`,
      error,
    );
  }
}
