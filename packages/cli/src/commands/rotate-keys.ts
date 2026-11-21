import { Command } from 'commander';
import { loadEngineRotateKeys } from '../lib/engine-modules.js';

/**
 * `zveltio rotate-keys` (ADR 0059): the engine's own pass, run straight on the
 * database. The published CLI ships no engine, so outside a checkout it says
 * to run the release binary's command, which is the same code.
 */
export const rotateKeysCommand = new Command('rotate-keys')
  .description(
    'Rewrite every engine-sealed field value under the current FIELD_ENCRYPTION_KEYS key, bound to its row, and report what is left under each key',
  )
  .option('--database-url <url>', 'Direct database URL (env: DATABASE_URL)')
  .option('--dry-run', 'Report only; write nothing')
  .option('--batch <n>', 'Rows per transaction', '500')
  .option(
    '--check-missing-tenants',
    'Also count rows of tenants missing from zv_tenants when row-level security binds the role (lifts FORCE per table for one statement)',
  )
  .action(
    async (opts: {
      databaseUrl?: string;
      dryRun?: boolean;
      batch: string;
      checkMissingTenants?: boolean;
    }) => {
      const databaseUrl = opts.databaseUrl || process.env.DATABASE_URL;
      const batchSize = Number(opts.batch);
      if (!databaseUrl || !Number.isInteger(batchSize) || batchSize < 1) {
        console.error('❌ DATABASE_URL (or --database-url) and a positive --batch are required.');
        process.exit(1);
      }
      process.env.DATABASE_URL = databaseUrl;
      process.env.DB_POOL_MAX ??= '2';
      const engine = await loadEngineRotateKeys();
      if (!engine) {
        console.error(
          '❌ this CLI does not ship the engine. Run the release binary instead, with\n' +
            '   DATABASE_URL and FIELD_ENCRYPTION_KEYS set:  zveltio rotate-keys [--dry-run]',
        );
        process.exit(1);
      }
      try {
        const db = await engine.db.initDatabase();
        const report = await engine.rotate.rotateKeys(db, {
          dryRun: opts.dryRun,
          batchSize,
          checkMissingTenants: opts.checkMissingTenants,
        });
        console.log(engine.rotate.formatRotateKeysReport(report));
        await db.destroy?.();
        process.exit(report.unopenable.length > 0 || !report.oldKeysDroppable ? 2 : 0);
      } catch (err) {
        console.error(`❌ rotate-keys failed: ${(err as Error).message}`);
        process.exit(1);
      }
    },
  );
