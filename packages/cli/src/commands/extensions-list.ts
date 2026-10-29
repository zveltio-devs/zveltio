/**
 * zveltio extensions list [--url <engine-url>] [--category <cat>]
 *
 * Lists all available extensions from the engine marketplace,
 * grouped by category with install status.
 */
import { engineFetch, errorOf } from '../lib/engine-session.js';

export async function extensionsListCommand(opts: {
  url?: string;
  category?: string;
  json?: boolean;
}) {
  const engineUrl = opts.url || process.env.ENGINE_URL || 'http://localhost:3000';

  let res: Response;
  try {
    res = await engineFetch({ url: engineUrl }, '/api/marketplace');
  } catch (e) {
    console.error(
      e instanceof TypeError
        ? `❌ Cannot reach engine at ${engineUrl}\n   Is the engine running? Try: zveltio dev`
        : `❌ ${(e as Error).message}`,
    );
    process.exit(1);
  }

  if (!res.ok) {
    console.error(`❌ Marketplace error: ${await errorOf(res)}`);
    process.exit(1);
  }

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  const { extensions } = (await res.json()) as { extensions: any[] };

  if (opts.json) {
    console.log(JSON.stringify(extensions, null, 2));
    return;
  }

  // Filter by category if requested
  const filtered = opts.category
    ? extensions.filter((e) => e.category === opts.category)
    : extensions;

  if (!filtered.length) {
    console.log(`No extensions found${opts.category ? ` in category "${opts.category}"` : ''}.`);
    return;
  }

  // Group by category
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  const byCategory: Record<string, any[]> = {};
  for (const ext of filtered) {
    const cat = ext.category || 'custom';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(ext);
  }

  const total = filtered.length;
  const active = filtered.filter((e) => e.is_running).length;
  const installed = filtered.filter((e) => e.is_installed).length;

  console.log(
    `\n📦 Zveltio Extensions (${active} active / ${installed} installed / ${total} available)\n`,
  );

  for (const [category, exts] of Object.entries(byCategory).sort()) {
    console.log(`  ${category.toUpperCase()}`);
    for (const ext of exts) {
      const status = ext.is_running
        ? '✅'
        : ext.is_installed && ext.is_enabled
          ? '🔄' // enabled but needs restart
          : ext.is_installed
            ? '📥' // installed but disabled
            : '⬜'; // not installed

      const needsRestart = ext.needs_restart ? ' ⚠️ restart needed' : '';
      const update = ext.update_available ? ` ⬆️ ${ext.catalog_version} available` : '';
      const name = (ext.displayName || ext.name).padEnd(32);
      console.log(
        `  ${status} ${name} v${ext.installed_version || ext.version || '?'}  ${ext.description || ''}${needsRestart}${update}`,
      );
    }
    console.log('');
  }

  console.log('Legend: ✅ active  🔄 needs restart  📥 installed (disabled)  ⬜ not installed');
  console.log('\nInstall:  zveltio install <extension-name>');
  console.log('Enable:   zveltio extensions enable <extension-name>');
  console.log('Update:   zveltio extensions update <extension-name>');
  console.log('');
}
