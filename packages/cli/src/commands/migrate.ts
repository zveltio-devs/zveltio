export async function migrateCommand(opts: { dryRun?: boolean }) {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('❌ DATABASE_URL environment variable is required');
    process.exit(1);
  }

  console.log('\n🗃️  Running migrations...\n');

  if (opts.dryRun) {
    console.log('  (dry run — no changes will be made)\n');
  }

  try {
    // Import and run migrations
    const { initDatabase } = await import('../../packages/engine/src/db/index.js').catch(() => ({
      initDatabase: null,
    }));

    if (!initDatabase) {
      console.error('❌ Could not find engine. Run migrations from within a Zveltio project.');
      process.exit(1);
    }

    if (!opts.dryRun) {
      await (initDatabase as any)();
      console.log('✅ Migrations completed successfully');
    }
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}
