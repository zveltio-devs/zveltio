import { sql } from 'kysely';
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
  const jobId = (result as any).id;

  // In test mode, process the job immediately so tests don't need to
  // wait for the 2-second poll interval before the table is available.
  if (process.env.NODE_ENV === 'test') {
    await processNextJob();
  }

  return jobId;
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

    if ((job as any).type === 'create_collection') {
      // CREATE INDEX CONCURRENTLY cannot run inside a transaction block in PostgreSQL.
      // Run collection creation directly against _db (outside any transaction).
      await DDLManager.createCollection(_db, payload);
      await _db
        .updateTable('zv_ddl_jobs' as any)
        .set({ status: 'completed', completed_at: new Date() } as any)
        .where('id' as any, '=', (job as any).id)
        .execute();
    } else {
      // All other DDL ops run in a transaction for atomicity
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
          case 'create_relation': {
            // payload: { type, source_collection, source_field, target_collection, target_field, on_delete, on_update }
            const SAFE_NAME = /^[a-z][a-z0-9_]*$/;
            const SAFE_ACTION = /^(CASCADE|SET NULL|RESTRICT|NO ACTION)$/;
            const relType: string = payload.type ?? 'm2o';
            const srcCol: string = payload.source_collection ?? '';
            const tgtCol: string = payload.target_collection ?? '';
            const srcField: string = payload.source_field ?? '';
            const tgtField: string = payload.target_field ?? 'id';
            const onDelete: string = payload.on_delete ?? 'SET NULL';
            const onUpdate: string = payload.on_update ?? 'NO ACTION';

            if (relType === 'm2o') {
              if (!SAFE_NAME.test(srcCol) || !SAFE_NAME.test(tgtCol) || !SAFE_NAME.test(srcField) || !SAFE_NAME.test(tgtField)) {
                throw new Error(`Invalid identifier in create_relation payload`);
              }
              if (!SAFE_ACTION.test(onDelete) || !SAFE_ACTION.test(onUpdate)) {
                throw new Error(`Invalid ON DELETE/ON UPDATE action in create_relation`);
              }
              await sql.raw(
                `ALTER TABLE zvd_${srcCol} ADD COLUMN IF NOT EXISTS "${srcField}" UUID REFERENCES zvd_${tgtCol}(${tgtField}) ON DELETE ${onDelete} ON UPDATE ${onUpdate}`,
              ).execute(trx);
            } else if (relType === 'm2m') {
              const junctionTable: string = payload.junction_table ?? '';
              if (junctionTable && SAFE_NAME.test(junctionTable) && SAFE_NAME.test(srcCol) && SAFE_NAME.test(tgtCol)) {
                await sql.raw(
                  `CREATE TABLE IF NOT EXISTS ${junctionTable} (` +
                  `id UUID PRIMARY KEY DEFAULT gen_random_uuid(), ` +
                  `${srcCol}_id UUID REFERENCES zvd_${srcCol}(id) ON DELETE CASCADE, ` +
                  `${tgtCol}_id UUID REFERENCES zvd_${tgtCol}(id) ON DELETE CASCADE, ` +
                  `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
                ).execute(trx);
              }
            }
            // o2m and m2a: FK lives on the other side or is handled separately
            break;
          }
          case 'drop_relation': {
            // payload: { type, source_collection, source_field, junction_table }
            const SAFE_NAME = /^[a-z][a-z0-9_]*$/;
            const relType: string = payload.type ?? 'm2o';
            const srcCol: string = payload.source_collection ?? '';
            const srcField: string = payload.source_field ?? '';
            const junctionTable: string = payload.junction_table ?? '';

            if (relType === 'm2o') {
              if (SAFE_NAME.test(srcCol) && SAFE_NAME.test(srcField)) {
                await sql.raw(`ALTER TABLE zvd_${srcCol} DROP COLUMN IF EXISTS "${srcField}"`).execute(trx);
              }
            } else if (relType === 'm2m' && junctionTable && SAFE_NAME.test(junctionTable)) {
              await sql.raw(`DROP TABLE IF EXISTS ${junctionTable} CASCADE`).execute(trx);
            }
            break;
          }
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
    }
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
