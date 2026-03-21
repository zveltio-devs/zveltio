/**
 * zveltio extensions list [--url <engine-url>] [--category <cat>]
 *
 * Lists all available extensions from the engine marketplace,
 * grouped by category with install status.
 */
export async function extensionsListCommand(opts: {
  url?: string;
  category?: string;
  json?: boolean;
}) {
  const engineUrl = opts.url || process.env.ENGINE_URL || 'http://localhost:3000';

  let res: Response;
  try {
    res = await fetch(`${engineUrl}/api/marketplace`);
  } catch {
    console.error(`❌ Cannot reach engine at ${engineUrl}`);
    console.error(`   Is the engine running? Try: zveltio dev`);
    process.exit(1);
  }

  if (res.status === 401) {
    console.error('❌ Admin authentication required to view marketplace.');
    console.error('   Set ENGINE_TOKEN env var or use --token option.');
    process.exit(1);
  }

  if (!res.ok) {
    console.error(`❌ Marketplace error: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const { extensions } = await res.json() as { extensions: any[] };

  if (opts.json) {
    console.log(JSON.stringify(extensions, null, 2));
    return;
  }

  // Filter by category if requested
  const filtered = opts.category
    ? extensions.filter(e => e.category === opts.category)
    : extensions;

  if (!filtered.length) {
    console.log(`No extensions found${opts.category ? ` in category "${opts.category}"` : ''}.`);
    return;
  }

  // Group by category
  const byCategory: Record<string, any[]> = {};
  for (const ext of filtered) {
    const cat = ext.category || 'custom';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(ext);
  }

  const total = filtered.length;
  const active = filtered.filter(e => e.is_running).length;
  const installed = filtered.filter(e => e.is_installed).length;

  console.log(`\n📦 Zveltio Extensions (${active} active / ${installed} installed / ${total} available)\n`);

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
      const name = (ext.displayName || ext.name).padEnd(32);
      console.log(`  ${status} ${name} v${ext.version || '?'}  ${ext.description || ''}${needsRestart}`);
    }
    console.log('');
  }

  console.log('Legend: ✅ active  🔄 needs restart  📥 installed (disabled)  ⬜ not installed');
  console.log('\nInstall:  zveltio install <extension-name>');
  console.log('Enable:   zveltio extensions enable <extension-name>');
  console.log('');
}
