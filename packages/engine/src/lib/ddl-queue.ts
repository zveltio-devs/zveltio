import type { Database } from '../db/index.js';
import { DDLManager } from './ddl-manager.js';

let _db: Database;

export function initDDLQueue(db: Database): void {
  _db = db;
  // Poll for pending jobs every 2 seconds
  setInterval(() => processNextJob(), 2000);
}

export async function enqueueDDLJob(db: Database, type: string, payload: any): Promise<string> {
  const result = await db
    .insertInto('zv_ddl_jobs' as any)
    .values({ type, payload: JSON.stringify(payload), status: 'pending' } as any)
    .returning('id' as any)
    .executeTakeFirst();
  return (result as any).id;
}

export async function getDDLJob(db: Database, jobId: string): Promise<any | null> {
  const row = await db
    .selectFrom('zv_ddl_jobs' as any)
    .selectAll()
    .where('id' as any, '=', jobId)
    .executeTakeFirst();
  return row || null;
}

async function processNextJob(): Promise<void> {
  if (!_db) return;

  // Grab one pending job
  const job = await _db
    .selectFrom('zv_ddl_jobs' as any)
    .selectAll()
    .where('status' as any, '=', 'pending')
    .orderBy('created_at' as any)
    .limit(1)
    .executeTakeFirst();

  if (!job) return;

  // Mark as running
  await _db
    .updateTable('zv_ddl_jobs' as any)
    .set({ status: 'running', started_at: new Date() } as any)
    .where('id' as any, '=', (job as any).id)
    .execute();

  try {
    const payload = typeof (job as any).payload === 'string'
      ? JSON.parse((job as any).payload)
      : (job as any).payload;

    switch ((job as any).type) {
      case 'create_collection':
        await DDLManager.createCollection(_db, payload);
        break;
      case 'drop_collection':
        await DDLManager.dropCollection(_db, payload.name);
        break;
      default:
        throw new Error(`Unknown DDL job type: ${(job as any).type}`);
    }

    await _db
      .updateTable('zv_ddl_jobs' as any)
      .set({ status: 'completed', completed_at: new Date() } as any)
      .where('id' as any, '=', (job as any).id)
      .execute();

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await _db
      .updateTable('zv_ddl_jobs' as any)
      .set({ status: 'failed', error, completed_at: new Date() } as any)
      .where('id' as any, '=', (job as any).id)
      .execute();
    console.error(`DDL job ${(job as any).id} failed:`, error);
  }
}
