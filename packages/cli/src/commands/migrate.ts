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

    if (res.status === 401 || res.status === 403) {
      console.error(`\n❌ The engine requires authentication for migrations via API.`);
      console.log('');
      console.log('   Run migrations directly instead (no running engine needed):');
      console.log(`     DATABASE_URL=<your-url> zveltio migrate`);
      console.log(`     zveltio migrate --database-url postgresql://...`);
      console.log('');
      console.log('   Or set DATABASE_URL in your .env and run:');
      console.log('     source .env && zveltio migrate\n');
      process.exit(1);
    }

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as any;
      throw new Error(body.error ?? `Engine returned ${res.status}`);
    }

    const data = (await res.json()) as any;
    console.log(
      `✅ ${data.applied} migration(s) applied. Schema version: ${data.schema_version}\n`,
    );
  } catch (err: any) {
    if (err.message?.includes('fetch') || err.code === 'ECONNREFUSED') {
      console.error(`\n❌ Cannot reach engine at ${opts.url}`);
      console.log('');
      console.log('   Run migrations directly (no engine needed):');
      console.log(`     DATABASE_URL=<your-url> zveltio migrate`);
      console.log(`     zveltio migrate --database-url postgresql://...\n`);
    } else {
      console.error(`\n❌ ${err.message}`);
      console.log('   Tip: use --database-url for direct migration without a running engine\n');
    }
    process.exit(1);
  }
}
