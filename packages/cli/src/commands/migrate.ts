export async function migrateCommand(opts: { dryRun?: boolean } = {}) {
  console.log('🔄 Running database migrations...');

  if (opts.dryRun) {
    console.log('  (dry run — no changes will be made)');
    return;
  }

  const proc = Bun.spawn(['bun', 'run', 'packages/engine/src/db/migrate.ts'], {
    stdio: ['inherit', 'inherit', 'inherit'],
    cwd: process.cwd(),
  });

  const exitCode = await proc.exited;
  if (exitCode === 0) {
    console.log('✅ Migrations completed successfully');
  } else {
    console.error('❌ Migration failed');
    process.exit(exitCode ?? 1);
  }
}
