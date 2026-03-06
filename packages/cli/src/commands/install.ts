import { existsSync } from 'fs';
import { readFile, mkdir, cp } from 'fs/promises';
import { join } from 'path';

/**
 * zveltio install <extension-name> [--path <path>] [--registry <url>] [--force]
 *
 * Installs an extension from a local path or registry.
 * 1. Reads manifest.json
 * 2. Copies to extensions/<category>/<name>/
 * 3. Activates via engine API (hot-load if running)
 */
export async function installCommand(
  name: string,
  opts: { registry?: string; path?: string; force?: boolean },
) {
  console.log(`\n📦 Installing extension: ${name}\n`);

  // 1. Determine source
  let sourcePath: string;

  if (opts.path) {
    sourcePath = opts.path;
    if (!existsSync(join(sourcePath, 'manifest.json'))) {
      console.error('❌ No manifest.json found at', sourcePath);
      process.exit(1);
    }
  } else {
    const registryUrl = opts.registry || process.env.ZVELTIO_REGISTRY || 'https://registry.zveltio.com';
    console.log(`  Fetching from ${registryUrl}...`);

    const res = await fetch(`${registryUrl}/extensions/${name}/latest`).catch(() => null);
    if (!res || !res.ok) {
      console.error(`❌ Extension "${name}" not found in registry (${registryUrl})`);
      console.error(`   Use --path <local-path> to install from local directory.`);
      process.exit(1);
    }

    // Registry download not yet implemented — show metadata and exit gracefully
    const meta = await res.json();
    console.log(`  Name: ${meta.displayName || meta.name}`);
    console.log(`  Version: ${meta.version}`);
    console.error('❌ Registry download not yet implemented. Use --path for local install.');
    process.exit(1);
  }

  // 2. Read and validate manifest
  let manifest: any;
  try {
    manifest = JSON.parse(await readFile(join(sourcePath, 'manifest.json'), 'utf-8'));
  } catch {
    console.error('❌ Failed to read manifest.json');
    process.exit(1);
  }

  console.log(`  Name:     ${manifest.displayName || manifest.name}`);
  console.log(`  Version:  ${manifest.version || '?'}`);
  console.log(`  Category: ${manifest.category || 'custom'}`);

  if (!manifest.name) {
    console.error('❌ manifest.json is missing required field: name');
    process.exit(1);
  }

  // 3. Check engine compatibility (informational)
  const enginePkgPath = join(process.cwd(), 'packages/engine/package.json');
  if (existsSync(enginePkgPath)) {
    const enginePkg = JSON.parse(await readFile(enginePkgPath, 'utf-8'));
    const engineVersion = enginePkg.version || '2.0.0';
    if (manifest.zveltioMinVersion) {
      console.log(`  Engine required: >= ${manifest.zveltioMinVersion}`);
      console.log(`  Engine current:  ${engineVersion}`);
    }
  }

  // 4. Copy to extensions/
  const category = manifest.category || 'custom';
  const extName = manifest.name;
  const targetDir = join(process.cwd(), 'extensions', category, extName);

  if (existsSync(targetDir) && !opts.force) {
    console.error(`❌ Extension already exists at ${targetDir}`);
    console.error(`   Use --force to overwrite.`);
    process.exit(1);
  }

  await mkdir(targetDir, { recursive: true });
  await cp(sourcePath, targetDir, { recursive: true });
  console.log(`  ✓ Copied to ${targetDir}`);

  // 5. Activate via engine API (hot-load if engine is running)
  const engineUrl = process.env.ENGINE_URL || 'http://localhost:3000';
  try {
    const enableRes = await fetch(
      `${engineUrl}/api/marketplace/${category}/${extName}/enable`,
      { method: 'POST' },
    );
    if (enableRes.ok) {
      const result = await enableRes.json();
      console.log(`  ✓ ${result.hot_loaded ? 'Hot-loaded into running engine' : 'Registered (restart engine to activate)'}`);
    } else {
      console.log(`  ⚠️ Engine responded with ${enableRes.status} — enable manually or restart`);
    }
  } catch {
    console.log(`  ⚠️ Engine not reachable at ${engineUrl} — enable manually or restart`);
  }

  console.log(`\n✅ Extension "${manifest.displayName || manifest.name}" installed!`);
  console.log(`\n  Add to your .env:`);
  console.log(`  ZVELTIO_EXTENSIONS=...,${category}/${extName}\n`);
}
