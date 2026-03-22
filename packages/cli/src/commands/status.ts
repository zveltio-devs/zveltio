// ── ANSI helpers ─────────────────────────────────────────────────────────────
const c = {
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,
  red:    (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan:   (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim:    (s: string) => `\x1b[2m${s}\x1b[0m`,
};

function statusIcon(ok: boolean | string | undefined): string {
  if (ok === true || ok === 'ok' || ok === 'healthy' || ok === 'connected') return c.green('OK');
  if (ok === false || ok === 'error' || ok === 'unhealthy') return c.red('FAIL');
  return c.yellow('UNKNOWN');
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export async function statusCommand(opts: { url?: string; json?: boolean }) {
  const engineUrl = opts.url || process.env.ZVELTIO_URL || process.env.ENGINE_URL || 'http://localhost:3000';

  if (!opts.json) {
    console.log(`\n${c.bold('Zveltio Status')}\n`);
    console.log(`  Engine: ${c.dim(engineUrl)}`);
    console.log('');
  }

  let healthData: any;
  try {
    const res = await fetch(`${engineUrl}/api/health`, {
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      if (opts.json) {
        console.log(JSON.stringify({ status: 'error', code: res.status, message: res.statusText }));
      } else {
        console.error(c.red(`Engine returned ${res.status} ${res.statusText}`));
        console.error(c.dim('  Is the engine running? Try: zveltio dev'));
      }
      process.exit(1);
    }

    healthData = await res.json();
  } catch (err: any) {
    if (opts.json) {
      console.log(JSON.stringify({ status: 'error', message: err.message }));
    } else {
      if (err.name === 'TimeoutError') {
        console.error(c.red('Connection timed out after 8s'));
      } else {
        console.error(c.red(`Cannot reach engine at ${engineUrl}`));
        console.error(c.dim(`  ${err.message}`));
      }
      console.error(c.dim('  Is the engine running? Try: zveltio dev'));
    }
    process.exit(1);
  }

  if (opts.json) {
    console.log(JSON.stringify(healthData, null, 2));
    return;
  }

  // ── Pretty-print ──────────────────────────────────────────────────────────
  const db     = healthData.database ?? healthData.db;
  const cache  = healthData.cache ?? healthData.redis ?? healthData.valkey;
  const uptime = healthData.uptime_seconds ?? healthData.uptime;
  const version = healthData.version ?? healthData.engine_version ?? healthData.engine;
  const status = healthData.status ?? 'ok';

  const overallIcon = status === 'ok' || status === 'healthy'
    ? c.green('HEALTHY')
    : c.red('DEGRADED');

  console.log(`  Status:   ${overallIcon}`);

  if (version) {
    console.log(`  Version:  ${version}`);
  }

  if (uptime !== undefined) {
    console.log(`  Uptime:   ${formatUptime(Number(uptime))}`);
  }

  console.log('');

  // Database status
  if (db !== undefined) {
    const dbStatus = typeof db === 'object'
      ? (db.status ?? db.ok)
      : db;
    const dbLatency = typeof db === 'object' ? db.latency_ms : undefined;
    const dbLabel = dbLatency !== undefined
      ? `${statusIcon(dbStatus)} ${c.dim(`(${dbLatency}ms)`)}`
      : statusIcon(dbStatus);
    console.log(`  Database: ${dbLabel}`);
  }

  // Cache / Valkey status
  if (cache !== undefined) {
    const cacheStatus = typeof cache === 'object'
      ? (cache.status ?? cache.ok)
      : cache;
    const cacheLatency = typeof cache === 'object' ? cache.latency_ms : undefined;
    const cacheLabel = cacheLatency !== undefined
      ? `${statusIcon(cacheStatus)} ${c.dim(`(${cacheLatency}ms)`)}`
      : statusIcon(cacheStatus);
    console.log(`  Cache:    ${cacheLabel}`);
  }

  // Storage status (if present)
  if (healthData.storage !== undefined) {
    const storageStatus = typeof healthData.storage === 'object'
      ? (healthData.storage.status ?? healthData.storage.ok)
      : healthData.storage;
    console.log(`  Storage:  ${statusIcon(storageStatus)}`);
  }

  // Extensions (if present)
  if (healthData.extensions !== undefined) {
    const extCount = typeof healthData.extensions === 'number'
      ? healthData.extensions
      : Array.isArray(healthData.extensions)
        ? healthData.extensions.length
        : healthData.extensions;
    console.log(`  Extensions: ${extCount} loaded`);
  }

  // Schema version
  if (healthData.schema_version !== undefined || (typeof db === 'object' && db?.schema_version)) {
    const sv = healthData.schema_version ?? db?.schema_version;
    console.log(`  Schema:   v${sv}`);
  }

  console.log('');
}
