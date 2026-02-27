import type { Database } from '../index.js';
import { readdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

export async function runPending(db: Database): Promise<void> {
  const migrationsDir = join(import.meta.dir, 'sql');
  if (!existsSync(migrationsDir)) {
    console.log('  No migrations directory found, skipping.');
    return;
  }

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const name = file.replace('.sql', '');

    // Skip if already run
    const existing = await db
      .selectFrom('zv_migrations' as any)
      .select('id')
      .where('name' as any, '=', name)
      .executeTakeFirst()
      .catch(() => null);

    if (existing) continue;

    // Run migration
    const sql = await Bun.file(join(migrationsDir, file)).text();
    await (db as any).executeQuery({ sql, parameters: [] });

    // Mark as run
    await db
      .insertInto('zv_migrations' as any)
      .values({ name } as any)
      .execute();

    console.log(`  ✓ Migration: ${name}`);
  }
}
