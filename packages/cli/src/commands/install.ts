import { existsSync } from 'fs';
import { readFile, mkdir, cp } from 'fs/promises';
import { join } from 'path';

/**
 * zveltio install <extension-name> [--path <path>] [--url <engine-url>] [--force]
 *
 * Two flows:
 *   1. With --path: install from local directory (copies + activates via API)
 *   2. Without --path: look in the engine catalog (/api/marketplace) and activate
 *      the bundled extension directly (no copy — extension is already in repo).
 */
export async function installCommand(
  name: string,
  opts: { path?: string; url?: string; force?: boolean; registry?: string },
) {
  const engineUrl =
    opts.url || process.env.ENGINE_URL || 'http://localhost:3000';

  console.log(`\n📦 Installing extension: ${name}\n`);

  // ── Flow 1: local path ──────────────────────────────────────────────────
  if (opts.path) {
    await installFromPath(name, opts.path, engineUrl, opts.force ?? false);
    return;
  }

  // ── Flow 2: engine marketplace catalog ──────────────────────────────────
  await installFromCatalog(name, engineUrl);
}

// ── Flow 1: local path ──────────────────────────────────────────────────────

async function installFromPath(
  name: string,
  sourcePath: string,
  engineUrl: string,
  force: boolean,
) {
  if (!existsSync(join(sourcePath, 'manifest.json'))) {
    console.error('❌ No manifest.json found at', sourcePath);
    process.exit(1);
  }

  let manifest: any;
  try {
    manifest = JSON.parse(
      await readFile(join(sourcePath, 'manifest.json'), 'utf-8'),
    );
  } catch {
    console.error('❌ Failed to read manifest.json');
    process.exit(1);
  }

  if (!manifest.name) {
    console.error('❌ manifest.json is missing required field: name');
    process.exit(1);
  }

  // P0 FIX: Validate category and name against a strict allowlist to prevent
  // path traversal. path.join() normalises '..' segments, so a manifest with
  // category: '../../../etc/cron.d' would write outside the extensions/ directory.
  const SAFE_SEGMENT_RE = /^[a-z0-9][a-z0-9_-]*$/;
  const category = manifest.category || 'custom';
  if (!SAFE_SEGMENT_RE.test(category)) {
    console.error(`❌ manifest.json "category" contains invalid characters: "${category}"`);
    console.error('   Only lowercase letters, digits, hyphens, and underscores are allowed.');
    process.exit(1);
  }
  if (!SAFE_SEGMENT_RE.test(manifest.name)) {
    console.error(`❌ manifest.json "name" contains invalid characters: "${manifest.name}"`);
    console.error('   Only lowercase letters, digits, hyphens, and underscores are allowed.');
    process.exit(1);
  }

  console.log(`  Name:     ${manifest.displayName || manifest.name}`);
  console.log(`  Version:  ${manifest.version || '?'}`);
  console.log(`  Category: ${category}`);

  // Compatibilitate engine (informational)
  const enginePkgPath = join(process.cwd(), 'packages/engine/package.json');
  if (existsSync(enginePkgPath)) {
    const enginePkg = JSON.parse(await readFile(enginePkgPath, 'utf-8'));
    const engineVersion = enginePkg.version || '2.0.0';
    if (manifest.zveltioMinVersion) {
      console.log(
        `  Engine required: >= ${manifest.zveltioMinVersion} (current: ${engineVersion})`,
      );
    }
    if (manifest.zveltioMaxVersion) {
      console.log(`  Engine max:      <= ${manifest.zveltioMaxVersion}`);
    }
  }

  const extName = manifest.name;
  const targetDir = join(process.cwd(), 'extensions', category, extName);

  if (existsSync(targetDir) && !force) {
    console.error(`❌ Extension already exists at ${targetDir}`);
    console.error(`   Use --force to overwrite.`);
    process.exit(1);
  }

  await mkdir(targetDir, { recursive: true });
  await cp(sourcePath, targetDir, { recursive: true });
  console.log(`  ✓ Copied to ${targetDir}`);

  await activateViaApi(extName, category, engineUrl);

  console.log(
    `\n✅ Extension "${manifest.displayName || manifest.name}" installed!`,
  );
  console.log(`\n  Add to your .env:`);
  console.log(`  ZVELTIO_EXTENSIONS=...,${category}/${extName}\n`);
}

// ── Flow 2: engine catalog ──────────────────────────────────────────────────

async function installFromCatalog(name: string, engineUrl: string) {
  // Fetch catalog
  console.log(`  Checking engine catalog at ${engineUrl}...`);

  let catalogRes: Response;
  try {
    catalogRes = await fetch(`${engineUrl}/api/marketplace`);
  } catch {
    console.error(`❌ Cannot reach engine at ${engineUrl}`);
    console.error(`   Is the engine running? Use --path for offline install.`);
    process.exit(1);
  }

  if (catalogRes.status === 401) {
    console.error(
      '❌ Admin authentication required. Engine marketplace requires admin session.',
    );
    console.error(
      '   Tip: use --path <local-path> for unauthenticated install.',
    );
    process.exit(1);
  }

  if (!catalogRes.ok) {
    console.error(
      `❌ Marketplace error: ${catalogRes.status} ${catalogRes.statusText}`,
    );
    process.exit(1);
  }

  const { extensions } = (await catalogRes.json()) as { extensions: any[] };

  // Find the extension in the catalog (by name, package, or displayName)
  const entry = extensions.find(
    (e) =>
      e.name === name ||
      e.package === name ||
      e.name === name.replace('@zveltio/ext-', '') ||
      e.displayName?.toLowerCase() === name.toLowerCase(),
  );

  if (!entry) {
    console.error(`❌ Extension "${name}" not found in catalog.`);
    console.log('\nAvailable extensions:');
    const byCategory: Record<string, any[]> = {};
    for (const e of extensions) {
      if (!byCategory[e.category]) byCategory[e.category] = [];
      byCategory[e.category].push(e);
    }
    for (const [cat, exts] of Object.entries(byCategory).sort()) {
      console.log(`\n  ${cat.toUpperCase()}`);
      for (const e of exts) {
        const status = e.is_running ? '✅' : e.is_installed ? '📥' : '⬜';
        console.log(`  ${status} ${e.name.padEnd(35)} ${e.description || ''}`);
      }
    }
    console.log('');
    process.exit(1);
  }

  console.log(`  Name:        ${entry.displayName || entry.name}`);
  console.log(`  Version:     ${entry.version || '?'}`);
  console.log(`  Category:    ${entry.category || 'custom'}`);
  console.log(`  Description: ${entry.description || ''}`);

  if (entry.is_running) {
    console.log(
      `\n✅ Extension "${entry.displayName || entry.name}" is already active.`,
    );
    return;
  }

  if (entry.is_installed) {
    console.log(`  Already installed. Enabling...`);
  } else {
    // Install first (marks as installed in DB)
    const installRes = await fetch(
      `${engineUrl}/api/marketplace/${entry.name}/install`,
      { method: 'POST' },
    ).catch(() => null);

    if (!installRes?.ok) {
      const err = (await installRes?.json().catch(() => ({}))) as any;
      if (installRes?.status === 501) {
        console.log(
          `  ℹ️  Bundled extension — skipping install step, enabling directly...`,
        );
      } else {
        console.error(
          `❌ Install failed: ${err?.error || `HTTP ${installRes?.status}`}`,
        );
        process.exit(1);
      }
    } else {
      console.log(`  ✓ Marked as installed`);
    }
  }

  // Enable (hot-load if engine supports it)
  const enableRes = await fetch(
    `${engineUrl}/api/marketplace/${entry.name}/enable`,
    { method: 'POST' },
  ).catch(() => null);

  if (!enableRes?.ok) {
    const err = (await enableRes?.json().catch(() => ({}))) as any;
    console.error(
      `❌ Enable failed: ${err?.error || `HTTP ${enableRes?.status}`}`,
    );
    process.exit(1);
  }

  const result = (await enableRes.json()) as any;

  if (result.hot_loaded) {
    console.log(
      `\n✅ Extension "${entry.displayName || entry.name}" is now active (hot-loaded).`,
    );
  } else {
    console.log(
      `\n✅ Extension "${entry.displayName || entry.name}" installed.`,
    );
    console.log(`\n  Restart engine to activate:`);
    console.log(`  bun run dev\n`);
    console.log(`  Or add to your .env:`);
    console.log(`  ZVELTIO_EXTENSIONS=...,${entry.name}\n`);
  }
}

// ── Helper ───────────────────────────────────────────────────────────────────

async function activateViaApi(
  name: string,
  category: string,
  engineUrl: string,
) {
  try {
    const res = await fetch(
      `${engineUrl}/api/marketplace/${category}/${name}/enable`,
      {
        method: 'POST',
      },
    );
    if (res.ok) {
      const result = (await res.json()) as any;
      console.log(
        `  ✓ ${result.hot_loaded ? 'Hot-loaded into running engine' : 'Registered (restart engine to activate)'}`,
      );
    } else {
      console.log(
        `  ⚠️  Engine responded with ${res.status} — enable manually or restart`,
      );
    }
  } catch {
    console.log(
      `  ⚠️  Engine not reachable at ${engineUrl} — enable manually or restart`,
    );
  }
}
