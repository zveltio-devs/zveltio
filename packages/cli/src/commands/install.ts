import { existsSync } from 'fs';
import { readFile, mkdir, cp } from 'fs/promises';
import { join } from 'path';
import { type EngineTarget, engineFetch, errorOf } from '../lib/engine-session.js';

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
  opts: {
    path?: string;
    url?: string;
    force?: boolean;
    registry?: string;
    approveForwardCredentials?: boolean;
    totp?: string;
  },
) {
  const engineUrl = opts.url || process.env.ENGINE_URL || 'http://localhost:3000';

  console.log(`\n📦 Installing extension: ${name}\n`);

  // ── Flow 1: local path ──────────────────────────────────────────────────
  if (opts.path) {
    await installFromPath(name, opts.path, opts.force ?? false);
    return;
  }

  // ── Flow 2: engine marketplace catalog ──────────────────────────────────
  try {
    await installFromCatalog(
      name,
      { url: engineUrl, totp: opts.totp },
      opts.approveForwardCredentials ?? false,
    );
  } catch (e) {
    console.error(`❌ ${(e as Error).message}`);
    process.exit(1);
  }
}

// ── Flow 1: local path ──────────────────────────────────────────────────────

async function installFromPath(name: string, sourcePath: string, force: boolean) {
  if (!existsSync(join(sourcePath, 'manifest.json'))) {
    console.error('❌ No manifest.json found at', sourcePath);
    process.exit(1);
  }

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  let manifest: any;
  try {
    manifest = JSON.parse(await readFile(join(sourcePath, 'manifest.json'), 'utf-8'));
  } catch {
    console.error('❌ Failed to read manifest.json');
    process.exit(1);
  }

  if (!manifest.name) {
    console.error('❌ manifest.json is missing required field: name');
    process.exit(1);
  }

  // Validate category and name against a strict allowlist — path traversal
  // guard. `path.join` normalises `..` segments, so a manifest with
  // `category: '../../../etc/cron.d'` would otherwise write outside the
  // extensions/ directory.
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
    const engineVersion = enginePkg.version || 'unknown';
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

  console.log(`  Enable it on a running engine: zveltio extensions enable ${extName}`);

  console.log(`\n✅ Extension "${manifest.displayName || manifest.name}" installed!`);
  console.log(`\n  Add to your .env:`);
  console.log(`  ZVELTIO_EXTENSIONS=...,${category}/${extName}\n`);
}

// ── Flow 2: engine catalog ──────────────────────────────────────────────────

async function installFromCatalog(name: string, target: EngineTarget, approveForward: boolean) {
  // Fetch catalog
  console.log(`  Checking engine catalog at ${target.url}...`);

  let catalogRes: Response;
  try {
    catalogRes = await engineFetch(target, '/api/marketplace');
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    console.error(`❌ Cannot reach engine at ${target.url}`);
    console.error(`   Is the engine running? Use --path for offline install.`);
    process.exit(1);
  }

  if (!catalogRes.ok) {
    console.error(`❌ Marketplace error: ${await errorOf(catalogRes)}`);
    process.exit(1);
  }

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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
    console.log(`\n✅ Extension "${entry.displayName || entry.name}" is already active.`);
    return;
  }

  // A worker extension may ask for the caller's credentials on some routes; the
  // engine forwards them only once an operator approves that exact map.
  const forward: Record<string, string[]> = entry.forwarded_credentials ?? {};
  const forwardPairs = Object.entries(forward).flatMap(([route, headers]) =>
    headers.map((h) => `${route}: ${h}`),
  );
  const approval = approveForward ? { forward_credentials: forward } : undefined;

  if (entry.is_installed) {
    console.log(`  Already installed. Enabling...`);
    if (approval && forwardPairs.length > 0) {
      const res = await engineFetch(
        target,
        `/api/marketplace/${encodeURIComponent(entry.name)}/approve-forward-credentials`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(approval),
        },
        `extension.approve-forward-credentials:${entry.name}`,
      );
      if (!res.ok) {
        console.error(`❌ Credential forwarding approval failed: ${await errorOf(res)}`);
        process.exit(1);
      }
      console.log(`  ✓ Credential forwarding approved (${forwardPairs.join(', ')})`);
    }
  } else {
    // Install first (marks as installed in DB)
    const installRes = await engineFetch(
      target,
      `/api/marketplace/${encodeURIComponent(entry.name)}/install`,
      {
        method: 'POST',
        ...(approval && {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(approval),
        }),
      },
      `extension.install:${entry.name}`,
    );

    if (!installRes.ok) {
      if (installRes.status === 501) {
        console.log(`  ℹ️  Bundled extension — skipping install step, enabling directly...`);
      } else {
        console.error(`❌ Install failed: ${await errorOf(installRes)}`);
        process.exit(1);
      }
    } else {
      console.log(`  ✓ Marked as installed`);
    }
  }

  if (forwardPairs.length > 0 && !approval) {
    console.log(`  ⚠️  Asks for the caller's credentials on: ${forwardPairs.join(', ')}`);
    console.log(`     Not forwarded until approved: re-run with --approve-forward-credentials,`);
    console.log(`     or approve it in Studio → Marketplace.`);
  }

  // Enable (hot-load if engine supports it)
  // A second confirmation: one code steps up one action. If it fails here the
  // extension stays installed and disabled, and the operator is told how to finish.
  const finish = `   Installed, not enabled. Finish with: zveltio extensions enable ${entry.name}`;
  let enableRes: Response;
  try {
    enableRes = await engineFetch(
      target,
      `/api/marketplace/${encodeURIComponent(entry.name)}/enable`,
      { method: 'POST' },
      `extension.enable:${entry.name}`,
    );
  } catch (e) {
    console.error(`❌ Enable failed: ${(e as Error).message}\n${finish}`);
    process.exit(1);
  }

  if (!enableRes.ok) {
    console.error(`❌ Enable failed: ${await errorOf(enableRes)}\n${finish}`);
    process.exit(1);
  }

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  const result = (await enableRes.json()) as any;

  if (result.hot_loaded) {
    console.log(`\n✅ Extension "${entry.displayName || entry.name}" is now active (hot-loaded).`);
  } else {
    console.log(`\n✅ Extension "${entry.displayName || entry.name}" installed.`);
    console.log(`\n  Restart engine to activate:`);
    console.log(`  bun run dev\n`);
    console.log(`  Or add to your .env:`);
    console.log(`  ZVELTIO_EXTENSIONS=...,${entry.name}\n`);
  }
}
