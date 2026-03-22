import { Command } from 'commander';
import { existsSync } from 'fs';
import { join } from 'path';

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

export const updateCommand = new Command('update')
  .description('Update Zveltio to the latest version')
  .option('--version <v>', 'Target version (default: latest stable)')
  .option('--channel <c>', 'Channel: stable | beta', 'stable')
  .option('--check', 'Check for updates without installing')
  .option('--force', 'Skip confirmation')
  .option('--dir <path>', 'Installation directory')
  .action(async (opts) => {
    console.log('\nZveltio Update\n');

    const installDir = opts.dir
      || process.env.ZVELTIO_DIR
      || join(process.cwd(), 'zveltio');

    const metaPath = join(installDir, '.zveltio-install.json');

    let meta: InstallMeta | null = null;
    if (existsSync(metaPath)) {
      meta = JSON.parse(await Bun.file(metaPath).text());
    }

    const currentVersion = meta?.version
      || await getCurrentVersionFromAPI(meta?.port ?? 3000)
      || '0.0.0';

    console.log(`   Current version: v${currentVersion}`);

    let versionsData: VersionsJson;
    try {
      const res = await fetch(
        'https://raw.githubusercontent.com/zveltio/zveltio/main/versions.json'
      );
      versionsData = await res.json() as VersionsJson;
    } catch {
      console.error('Cannot fetch version information. Check your connection.');
      process.exit(1);
    }

    const targetVersion = opts.version
      || (opts.channel === 'beta'
        ? versionsData.latest_beta ?? versionsData.latest
        : versionsData.latest);

    console.log(`   Target version:  v${targetVersion}`);

    if (opts.check) {
      const hasUpdate = compareVersions(targetVersion, currentVersion) > 0;
      if (hasUpdate) {
        const entry = versionsData.versions.find(v => v.version === targetVersion);
        console.log(`\n   Update available!\n`);
        if (entry?.breaking_changes) {
          console.log(`   Contains BREAKING CHANGES`);
        }
        console.log(`   Release notes: ${entry?.release_notes ?? ''}`);
        console.log(`\n   Run: zveltio update\n`);
      } else {
        console.log('\n   Already up to date.\n');
      }
      return;
    }

    if (compareVersions(targetVersion, currentVersion) <= 0) {
      console.log('\n   Already up to date.\n');
      return;
    }

    const targetEntry = versionsData.versions.find(v => v.version === targetVersion);
    if (targetEntry?.breaking_changes && !opts.force) {
      console.log(`\n   This update contains BREAKING CHANGES.`);
      console.log(`   Review: ${targetEntry.release_notes}`);
      console.log('');
      process.stdout.write('   Continue? (yes/no): ');
      const confirm = await readLine();
      if (confirm !== 'yes') {
        console.log('\n   Update cancelled.\n');
        return;
      }
    }

    console.log(`\n   Upgrading v${currentVersion} -> v${targetVersion}...\n`);

    const envPath = join(installDir, '.env');
    if (existsSync(envPath)) {
      const backupPath = `${envPath}.backup.${Date.now()}`;
      // Use Bun.write to copy .env backup
      const envContent = await Bun.file(envPath).text();
      await Bun.write(backupPath, envContent);
      console.log(`   Backed up .env to ${backupPath}`);
    }

    const installScript = join(installDir, 'install.sh');

    if (existsSync(installScript)) {
      const proc = Bun.spawn([
        'bash',
        installScript,
        '--version', targetVersion,
        '--unattended',
        '--dir', installDir,
        '--mode', meta?.mode ?? 'auto',
      ], { stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' });

      const code = await proc.exited;
      if (code !== 0) {
        console.error('\nUpdate failed. Your previous version is still running.');
        console.log(`   Restore .env: copy ${envPath}.backup.* to ${envPath}`);
        process.exit(1);
      }
    } else {
      console.log('   Downloading installer...');
      const dlProc = Bun.spawn([
        'bash', '-c',
        `curl -fsSL https://get.zveltio.com/install.sh -o /tmp/zveltio-update.sh && ` +
        `bash /tmp/zveltio-update.sh ` +
        `--version ${targetVersion} --unattended --dir ${installDir}`,
      ], { stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' });
      const code = await dlProc.exited;
      if (code !== 0) {
        console.error('\nUpdate download/install failed.');
        process.exit(1);
      }
    }

    console.log(`\nUpdated to Zveltio v${targetVersion}\n`);
  });

async function getCurrentVersionFromAPI(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://localhost:${port}/api/health/version`);
    const data = await res.json() as any;
    return data.engine ?? null;
  } catch {
    return null;
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
