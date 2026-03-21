import { Command } from 'commander';

export const versionCommand = new Command('version')
  .description('Show version information and check for updates')
  .option('--url <url>', 'Engine URL', 'http://localhost:3000')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const [healthRes, updateRes] = await Promise.allSettled([
        fetch(`${opts.url}/api/health/version`),
        fetch(`${opts.url}/api/health/update-check`),
      ]);

      const versionData =
        healthRes.status === 'fulfilled' && healthRes.value.ok
          ? ((await healthRes.value.json()) as any)
          : null;

      const updateData =
        updateRes.status === 'fulfilled' && updateRes.value.ok
          ? ((await updateRes.value.json()) as any)
          : null;

      if (opts.json) {
        console.log(JSON.stringify({ version: versionData, update: updateData }, null, 2));
        return;
      }

      if (!versionData) {
        console.log('\n⚠️  Engine not running. Cannot determine version.\n');
        return;
      }

      console.log(`
📦 Zveltio Version Information

   Engine:    ${versionData.engine}
   Runtime:   ${versionData.runtime}
   Platform:  ${versionData.platform}

   Schema:    v${versionData.schema.current} / v${versionData.schema.maximum}
              ${
                versionData.schema.upToDate
                  ? '✅ Up to date'
                  : `⚠️  ${versionData.schema.pending} pending migration(s) — run: zveltio migrate`
              }
`);

      if (updateData?.has_update) {
        console.log(`   ⬆️  Update available: v${updateData.current} → v${updateData.latest}`);
        console.log(`      Run: zveltio update`);
        console.log(`      Notes: ${updateData.release_url}\n`);
      } else if (updateData && !updateData.error) {
        console.log(`   ✅ Engine is up to date (v${updateData.current})\n`);
      }
    } catch {
      console.log('\n⚠️  Could not connect to engine.\n');
    }
  });
