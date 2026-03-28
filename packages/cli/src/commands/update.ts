import { Command } from 'commander';
import { existsSync } from 'fs';
import { join } from 'path';

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const c = {
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,
  red:    (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan:   (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim:    (s: string) => `\x1b[2m${s}\x1b[0m`,
};

interface InstallMeta {
  version: string;
  mode: 'native' | 'docker';
  installed_at: string;
  install_dir: string;
  port: number;
}

interface VersionEntry {
  version: string;
  channel: string;
  published_at: string;
  breaking_changes: boolean;
  release_notes: string;
}

interface VersionsJson {
  latest: string;
  latest_beta: string | null;
  versions: VersionEntry[];
}

// Versions manifest is served from get.zveltio.com (zveltio-get repo)
const VERSIONS_URL = process.env.ZVELTIO_VERSIONS_URL
  || 'https://get.zveltio.com/versions.json';

export const updateCommand = new Command('update')
  .description('Update Zveltio to the latest version')
  .option('--version <v>', 'Target version (default: latest stable)')
  .option('--channel <c>', 'Channel: stable | beta', 'stable')
  .option('--check', 'Check for updates without installing')
  .option('--force', 'Skip confirmation')
  .option('--dir <path>', 'Installation directory')
  .action(async (opts) => {
    console.log(`\n${c.bold('Zveltio Update')}\n`);

    const installDir = opts.dir
      || process.env.ZVELTIO_DIR
      || join(process.cwd(), 'zveltio');

    const metaPath = join(installDir, '.zveltio-install.json');

    let meta: InstallMeta | null = null;
    if (existsSync(metaPath)) {
      try {
        meta = JSON.parse(await Bun.file(metaPath).text());
      } catch {
        // meta file unreadable — continue without it
      }
    }

    // Version detection order:
    //  1. .zveltio-install.json in install dir
    //  2. engine package.json in monorepo
    //  3. /api/health on running engine
    //  4. fall back to 0.0.0
    const currentVersion = meta?.version
      || await getVersionFromPackageJson()
      || await getCurrentVersionFromAPI(meta?.port ?? Number(process.env.PORT ?? 3000))
      || '0.0.0';

    const versionSource = meta?.version
      ? 'install meta'
      : await getVersionFromPackageJson()
        ? 'package.json'
        : 'running engine';

    console.log(`  Current version: ${c.cyan(`v${currentVersion}`)} ${c.dim(`(from ${versionSource})`)}`);

    // ── Fetch versions from registry ──────────────────────────────────────────
    let versionsData: VersionsJson | null = null;

    try {
      const res = await fetch(VERSIONS_URL, {
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) {
        throw new Error(`Registry returned ${res.status}`);
      }

      versionsData = await res.json() as VersionsJson;

      if (!versionsData?.latest) {
        throw new Error('Invalid versions response (missing "latest" field)');
      }
    } catch (err: any) {
      // Registry unavailable — this is expected during development / pre-launch
      if (opts.check) {
        console.log(c.yellow('\n  Cannot reach version registry.'));
        console.log(c.dim(`  URL tried: ${VERSIONS_URL}`));
        console.log(c.dim('  Override with: ZVELTIO_VERSIONS_URL=<url> zveltio update --check'));
        console.log(c.dim(`  Error: ${err.message}\n`));
        return;
      }

      // For an installed deployment, let the user still run the install script if they explicitly
      // provide --version, bypassing the registry check entirely.
      if (opts.version) {
        console.log(c.yellow(`\n  Registry unavailable — proceeding with explicit version: v${opts.version}`));
        await runUpdateScript(opts.version, installDir, meta, opts.force ?? false);
        return;
      }

      console.error(c.red('\n  Cannot reach the version registry.'));
      console.error(c.dim(`  URL: ${VERSIONS_URL}`));
      console.error(c.dim(`  Error: ${err.message}`));
      console.log('');
      console.log('  Options:');
      console.log(`    ${c.cyan('zveltio update --version <x.y.z>')}   ${c.dim('skip registry, update to specific version')}`);
      console.log(`    ${c.cyan('ZVELTIO_VERSIONS_URL=<url> zveltio update')}   ${c.dim('use a custom registry')}`);
      console.log('');
      process.exit(1);
    }

    const targetVersion = opts.version
      || (opts.channel === 'beta'
        ? versionsData.latest_beta ?? versionsData.latest
        : versionsData.latest);

    console.log(`  Target version:  ${c.cyan(`v${targetVersion}`)}`);

    if (opts.check) {
      const hasUpdate = compareVersions(targetVersion, currentVersion) > 0;
      if (hasUpdate) {
        const entry = versionsData.versions.find(v => v.version === targetVersion);
        console.log(c.green(`\n  Update available: v${currentVersion} → v${targetVersion}\n`));
        if (entry?.breaking_changes) {
          console.log(c.yellow('  ⚠  Contains BREAKING CHANGES — read release notes before updating.'));
        }
        if (entry?.release_notes) {
          console.log(`  Release notes: ${entry.release_notes}`);
        }
        console.log(`\n  Run: ${c.cyan('zveltio update')}\n`);
      } else {
        console.log(c.green('\n  Already up to date.\n'));
      }
      return;
    }

    if (compareVersions(targetVersion, currentVersion) <= 0 && !opts.force) {
      console.log(c.green('\n  Already up to date.\n'));
      return;
    }

    const targetEntry = versionsData.versions.find(v => v.version === targetVersion);
    if (targetEntry?.breaking_changes && !opts.force) {
      console.log(c.yellow(`\n  This update contains BREAKING CHANGES.`));
      if (targetEntry.release_notes) {
        console.log(`  Review: ${targetEntry.release_notes}`);
      }
      console.log('');
      process.stdout.write('  Continue? (yes/no): ');
      const confirm = await readLine();
      if (confirm !== 'yes') {
        console.log(c.dim('\n  Update cancelled.\n'));
        return;
      }
    }

    console.log(`\n  Upgrading ${c.cyan(`v${currentVersion}`)} → ${c.cyan(`v${targetVersion}`)}...\n`);
    await runUpdateScript(targetVersion, installDir, meta, opts.force ?? false);
    console.log(c.green(`\n  Updated to Zveltio v${targetVersion}\n`));
  });

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getVersionFromPackageJson(): Promise<string | null> {
  // Try monorepo engine package.json first, then project-level
  const candidates = [
    join(process.cwd(), 'packages/engine/package.json'),
    join(process.cwd(), 'package.json'),
  ];

  for (const pkgPath of candidates) {
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(await Bun.file(pkgPath).text());
      // Only trust if it's the engine package or has a zveltio engine version marker
      if (pkg.name === '@zveltio/engine' || pkg._zveltio_version) {
        return pkg.version ?? null;
      }
    } catch { /* ignore */ }
  }
  return null;
}

async function getCurrentVersionFromAPI(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    const data = await res.json() as any;
    // Try various field names the engine may use
    return data.engine ?? data.version ?? data.engine_version ?? null;
  } catch {
    return null;
  }
}

async function runUpdateScript(
  targetVersion: string,
  installDir: string,
  meta: InstallMeta | null,
  force: boolean,
): Promise<void> {
  // Back up .env
  const envPath = join(installDir, '.env');
  if (existsSync(envPath)) {
    const backupPath = `${envPath}.backup.${Date.now()}`;
    const envContent = await Bun.file(envPath).text();
    await Bun.write(backupPath, envContent);
    console.log(`  Backed up .env → ${backupPath}`);
  }

  const installScript = join(installDir, 'install.sh');

  if (existsSync(installScript)) {
    const args = [
      'bash', installScript,
      '--version', targetVersion,
      '--unattended',
      '--dir', installDir,
      '--mode', meta?.mode ?? 'auto',
    ];
    if (force) args.push('--force');

    const proc = Bun.spawn(args, { stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' });
    const code = await proc.exited;
    if (code !== 0) {
      console.error('\n  Update failed. Your previous version is still running.');
      if (existsSync(envPath)) {
        console.log(`  Restore .env: copy ${envPath}.backup.* to ${envPath}`);
      }
      process.exit(1);
    }
  } else {
    // No install.sh found — in monorepo dev environment this is expected
    // In a real deployment, download the installer
    console.log('  No local install.sh found — downloading installer from registry...');
    // get.zveltio.com/install.sh is the bootstrapper — it reads latest.json and
    // then downloads the versioned installer from the GitHub release assets.
    const installUrl = process.env.ZVELTIO_INSTALL_URL || 'https://get.zveltio.com/install.sh';
    const dlCmd = `curl -fsSL "${installUrl}" -o /tmp/zveltio-update.sh && bash /tmp/zveltio-update.sh --version ${targetVersion} --unattended --dir ${installDir}`;

    const dlProc = Bun.spawn(['bash', '-c', dlCmd], {
      stdout: 'inherit', stderr: 'inherit', stdin: 'inherit',
    });
    const code = await dlProc.exited;
    if (code !== 0) {
      console.error('\n  Update download/install failed.');
      console.error(`  Installer URL: ${installUrl}`);
      process.exit(1);
    }
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1;
  }
  return 0;
}

async function readLine(): Promise<string> {
  return new Promise(resolve => {
    process.stdin.once('data', data => resolve(data.toString().trim()));
  });
}
