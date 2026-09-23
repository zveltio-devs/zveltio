import { Command } from 'commander';
import { loadEngineMigrationModules } from '../lib/engine-modules.js';

export const rollbackCommand = new Command('rollback')
  .description('Rollback database migrations to a specific version')
  .option('--to <version>', 'Target schema version number')
  .option('--steps <n>', 'Number of migrations to rollback', '1')
  .option('--database-url <url>', 'Direct database URL')
  .option('--force', 'Skip confirmation prompt')
  .action(async (opts) => {
    console.log('\n⏪ Zveltio Rollback\n');

    const databaseUrl = opts.databaseUrl || process.env.DATABASE_URL;
    if (!databaseUrl) {
      console.error('❌ DATABASE_URL required. Use --database-url or set the env var.');
      process.exit(1);
    }

    process.env.DATABASE_URL = databaseUrl;

    let engine: Awaited<ReturnType<typeof loadEngineMigrationModules>>;
    try {
      engine = await loadEngineMigrationModules();
    } catch (err) {
      console.error(`\n❌ ${(err as Error).message}\n`);
      process.exit(1);
    }
    const { initDatabase } = engine.db;
    const { getLastAppliedMigration, rollbackMigration } = engine.migrations;

    // Determine target version
    let targetVersion: number;

    if (opts.to !== undefined) {
      targetVersion = parseInt(opts.to);
      if (Number.isNaN(targetVersion)) {
        console.error('❌ --to must be a valid integer');
        process.exit(1);
      }
    } else {
      const steps = parseInt(opts.steps);
      if (Number.isNaN(steps) || steps < 1) {
        console.error('❌ --steps must be a positive integer');
        process.exit(1);
      }
      const db = await initDatabase();
      const current = await getLastAppliedMigration(db);
      await db.destroy?.();
      targetVersion = Math.max(0, current - steps);
    }

    console.log(`   Rolling back to schema version: ${targetVersion}`);

    // Confirmation unless --force
    if (!opts.force) {
      const readline = await import('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const answer = await new Promise<string>((resolve) => {
        rl.question(`\n⚠️  This will rollback schema changes. Type "yes" to continue: `, resolve);
      });
      rl.close();

      if (answer.trim().toLowerCase() !== 'yes') {
        console.log('\n   Rollback cancelled.\n');
        process.exit(0);
      }
    }

    try {
      const db = await initDatabase();
      const result = await rollbackMigration(db, targetVersion);
      await db.destroy?.();

      if (!result.success) {
        console.error(`\n❌ Rollback failed: ${result.error}\n`);
        process.exit(1);
      }

      console.log(`\n✅ Rolled back to schema version ${targetVersion}.\n`);
      console.log('   ⚠️  Restart engine after rollback:');
      console.log('   zveltio stop && zveltio start\n');
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    } catch (err: any) {
      console.error(`\n❌ Rollback error: ${err.message}\n`);
      process.exit(1);
    }
  });
