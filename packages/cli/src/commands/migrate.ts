import { Command } from 'commander';

export const migrateCommand = new Command('migrate')
  .description('Run pending database migrations')
  .option('--url <url>', 'Engine URL', 'http://localhost:3000')
  .option('--database-url <url>', 'Direct database URL (skip engine)')
  .option('--dry-run', 'Show pending migrations without applying')
  .action(async (opts) => {
    console.log('\n🗄️  Database Migrations\n');

    const databaseUrl = opts.databaseUrl || process.env.DATABASE_URL;

    if (databaseUrl) {
      await runMigrationsDirectly(opts, databaseUrl);
    } else {
      await runMigrationsViaAPI(opts);
    }
  });

async function runMigrationsDirectly(opts: any, databaseUrl: string): Promise<void> {
  try {
    process.env.DATABASE_URL = databaseUrl;

    // Runtime path — TypeScript won't resolve this statically (cross-package)
    const dbPath = new URL('../../../engine/src/db/index.js', import.meta.url).href;
    const migrationsPath = new URL('../../../engine/src/db/migrations/index.js', import.meta.url).href;
    const { initDatabase } = await import(dbPath) as any;
    const { runMigrations, getAppliedMigrations, getLastAppliedMigration } =
      (await import(migrationsPath)) as any;

    const db = await initDatabase();

    if (opts.dryRun) {
      const applied = await getAppliedMigrations(db);
      const lastVersion = await getLastAppliedMigration(db);
      console.log(`   Applied migrations: ${applied.length}`);
      console.log(`   Last applied version: ${lastVersion}`);
      console.log('\n   (dry run — no changes made)\n');
      await db.destroy?.();
      return;
    }

    await runMigrations(db);
    console.log('\n✅ All migrations applied.\n');
    await db.destroy?.();
  } catch (err: any) {
    console.error(`\n❌ Migration failed: ${err.message}\n`);
    process.exit(1);
  }
}

async function runMigrationsViaAPI(opts: any): Promise<void> {
  try {
    const res = await fetch(`${opts.url}/api/admin/migrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as any;
      throw new Error(body.error ?? `Engine returned ${res.status}`);
    }

    const data = (await res.json()) as any;
    console.log(
      `✅ ${data.applied} migration(s) applied. Schema version: ${data.schema_version}\n`,
    );
  } catch (err: any) {
    console.error(`\n❌ ${err.message}`);
    console.log('   Tip: Start the engine first, or use --database-url for direct migration\n');
    process.exit(1);
  }
}
