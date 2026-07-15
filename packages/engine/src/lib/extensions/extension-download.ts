// Registry client: catalog fetch + cache, package download + extraction, and
// archive signature verification.
//
// Extracted from extension-loader.ts (loader split). This is the "get an
// extension's files from the registry onto disk" concern. Its only shared state
// is the in-module catalog cache.

import { mkdirSync } from 'node:fs';
import { join } from 'path';
import { EXTENSION_CATALOG, type ExtensionCatalogEntry } from './extension-catalog.js';
import { fetchWithRetry } from './extension-utils.js';
import { parseSignature, verifySignature, SignatureMissingError } from '../security/index.js';

// ── Registry catalog cache ────────────────────────────────────────────────────
// Default points at the Cloudflare Worker registry (registry.zveltio.com).
// `apps.zveltio.com` is the marketplace UI (SvelteKit) — it does NOT expose /api/*.
export const REGISTRY_URL = process.env.REGISTRY_URL || 'https://registry.zveltio.com';
const CATALOG_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let catalogCache: ExtensionCatalogEntry[] | null = null;
let catalogCacheExpiry = 0;

/**
 * Clear the in-process catalog cache. Test-only seam: the cache is a
 * module-global singleton shared across every test file that imports this
 * module, so tests must reset it to avoid cross-file order dependence.
 */
export function _resetCatalogCacheForTests(): void {
  catalogCache = null;
  catalogCacheExpiry = 0;
}

/**
 * Merge the remote registry catalog with the local one baked into this binary.
 *
 * Remote failures are swallowed by design — listing extensions must keep working
 * offline. Callers that make a SECURITY decision from the result (enable-time
 * publisher-tier enforcement) must pass `requireRemote: true`: the local catalog
 * marks its own entries `is_official: true`, so a sideloaded extension sharing a
 * local entry's name would inherit first-party tier and be allowed to run inline
 * whenever the registry is unreachable. With `requireRemote`, a remote failure
 * throws instead, so the caller can fail closed. Reaching a cached catalog is
 * fine — the cache is only populated from a successful remote fetch.
 */
export async function fetchRegistryCatalog(
  opts: { requireRemote?: boolean } = {},
): Promise<ExtensionCatalogEntry[]> {
  if (catalogCache && Date.now() < catalogCacheExpiry) return catalogCache;

  let remoteEntries: ExtensionCatalogEntry[] = [];
  let remoteError: Error | null = null;
  try {
    const res = await fetch(`${REGISTRY_URL}/api/extensions/list`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Registry returned ${res.status}`);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const data = (await res.json()) as { extensions: any[] };
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    remoteEntries = (data.extensions ?? []).map((e: any) => ({
      name: e.name,
      displayName: e.display_name ?? e.displayName ?? e.name,
      description: e.description ?? '',
      category: e.category ?? 'other',
      version: e.version ?? '1.0.0',
      author: e.developer_username ?? e.author ?? 'Zveltio',
      tags: e.tags ?? [],
      permissions: e.permissions ?? [],
      download_url:
        e.download_url ??
        `${REGISTRY_URL}/api/extensions/by-name/${encodeURIComponent(e.name)}/download`,
      // Used by the enable-time enforcement of MARKETPLACE-POLICY.md §2.
      // Registry exposes `is_official` on the catalog list response;
      // anything that isn't explicitly first-party is treated as a
      // community submission and must run in worker isolation.
      // D1/SQLite returns booleans as integers (0/1), so coerce here —
      // a strict `=== true` flagged all 54 first-party extensions as
      // community submissions and blocked every enable.
      is_official: e.is_official === true || e.is_official === 1,
      // Three-tier model (registry migration 010). When the registry is
      // new enough to send `publisher_tier`, carry it through so verified
      // partners are allowed to run inline. Older registries omit it and
      // the loader falls back to `is_official` via resolvePublisherTier().
      publisher_tier:
        e.publisher_tier === 'first-party' ||
        e.publisher_tier === 'verified' ||
        e.publisher_tier === 'community'
          ? e.publisher_tier
          : undefined,
    }));
  } catch (err) {
    remoteError = err as Error;
    console.warn(
      '[marketplace] Registry fetch failed, using local catalog:',
      (err as Error).message,
    );
  }

  // Security callers opt out of the local-catalog fallback (see the doc above).
  if (remoteError && opts.requireRemote) throw remoteError;

  // Always merge: remote entries win over local for the same name,
  // but local catalog fills in anything the registry doesn't list
  // (local/dev extensions, self-hosted, extensions not yet published).
  //
  // Local catalog entries default to is_official=true (they're
  // hardcoded in this binary — the 54 official + smoke fixtures).
  // Remote entries carry whatever the registry returned.
  const remoteNames = new Set(remoteEntries.map((e) => e.name));
  const localWithDefaults = EXTENSION_CATALOG.filter((e) => !remoteNames.has(e.name)).map((e) => ({
    ...e,
    is_official: e.is_official ?? true,
  }));
  const merged = [...remoteEntries, ...localWithDefaults];
  const result = merged.length > 0 ? merged : localWithDefaults;

  if (remoteEntries.length > 0) {
    catalogCache = result;
    catalogCacheExpiry = Date.now() + CATALOG_CACHE_TTL;
  }

  return result;
}

// ── Extension package download ────────────────────────────────────────────────

/**
 * Fetch `<download_url>.sig` and verify the archive's Ed25519 signature.
 *
 * Behaviour controlled by env:
 *   - `REQUIRE_EXTENSION_SIGNATURES=true`  → missing or invalid signature
 *     throws (SignatureMissingError / SignatureInvalidError).
 *   - default (unset or "false")           → missing signature logs a warning
 *     and proceeds; an INVALID signature still throws (we never accept a
 *     present-but-broken signature, regardless of the gate).
 */
async function verifyArchiveSignature(
  extensionName: string,
  downloadUrl: string,
  headers: Record<string, string>,
  archive: Uint8Array,
): Promise<void> {
  const required = process.env.REQUIRE_EXTENSION_SIGNATURES === 'true';
  const sigUrl = `${downloadUrl}.sig`;

  let sigBody: unknown = null;
  try {
    const sigRes = await fetchWithRetry(sigUrl, { headers });
    if (sigRes.ok) {
      sigBody = await sigRes.json();
    } else if (sigRes.status === 404) {
      sigBody = null;
    } else {
      // 5xx / non-404 — treat as missing for the purposes of the gate, but log
      // so operators can investigate.
      console.warn(
        `[signature] ${extensionName}: signature fetch returned ${sigRes.status}; treating as missing`,
      );
    }
  } catch (err) {
    console.warn(
      `[signature] ${extensionName}: signature fetch failed: ${(err as Error).message}; treating as missing`,
    );
  }

  if (sigBody === null) {
    if (required) throw new SignatureMissingError(extensionName);
    console.warn(
      `[signature] ${extensionName}: no signature.sig found — install proceeded because REQUIRE_EXTENSION_SIGNATURES is not set`,
    );
    return;
  }

  const parsed = parseSignature(sigBody, extensionName);
  await verifySignature(archive, parsed, extensionName);
  console.log(`🔐 Extension "${extensionName}": signature verified (keyId=${parsed.keyId})`);
}

/**
 * Download and extract an extension package into EXTENSIONS_DIR.
 *
 * URL resolution order:
 *   1. `entry.download_url` from the registry catalog (explicit, preferred)
 *   2. `${REGISTRY_URL}/api/extensions/by-name/${name}/download` (convention)
 *
 * Format detection: the response body is sniffed for a magic number to decide
 * between ZIP (`PK\x03\x04`) and gzip (`\x1f\x8b`). ZIPs are extracted with
 * `unzip`, tarballs with `tar`. If the archive contains a single top-level
 * directory matching the extension slug (or anything else), we flatten it so
 * `engine/`, `studio/`, `manifest.json` land directly inside `EXTENSIONS_DIR/<name>/`.
 */
export async function downloadExtension(
  entry: ExtensionCatalogEntry,
  destBase: string,
  licenseKey?: string,
): Promise<void> {
  const downloadUrl =
    entry.download_url ??
    `${REGISTRY_URL}/api/extensions/by-name/${encodeURIComponent(entry.name)}/download`;

  console.log(`📥 Downloading extension "${entry.name}" from ${downloadUrl} …`);

  const headers: Record<string, string> = {
    'User-Agent': 'zveltio-engine',
    Accept: 'application/octet-stream',
  };
  if (licenseKey) {
    headers['Authorization'] = `Bearer ${licenseKey}`;
  }

  const res = await fetchWithRetry(downloadUrl, {
    headers,
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // 403 from the registry's download endpoint means the extension
    // exists but its status is not 'published' — pending review,
    // rejected, or taken_down. Surface a friendlier error than the
    // raw HTTP status so users understand "wait for review" vs
    // "registry is down".
    if (res.status === 403 && /not.*available|not.*published|not yet published/i.test(body)) {
      throw new Error(
        `Extension "${entry.name}" is not yet approved by the marketplace ` +
          `review queue. The submission exists but admins haven't ` +
          `published it. Wait for the publisher to receive notification, ` +
          `or check ${REGISTRY_URL}/extensions/${encodeURIComponent(entry.name)} for status.`,
      );
    }
    throw new Error(
      `Registry returned ${res.status} for extension "${entry.name}" download${body ? `: ${body.slice(0, 200)}` : ''}`,
    );
  }

  const destDir = join(destBase, entry.name);
  mkdirSync(destDir, { recursive: true });

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 4) {
    throw new Error(`Empty package received for "${entry.name}"`);
  }

  // Trust chain: archive SHA-256 — publisher computed at pack time,
  // registry stored in R2 customMetadata at upload, returned here in
  // the X-Archive-Sha256 response header. If the bytes in `buf` don't
  // hash to the declared value, the package was tampered with in
  // transit (R2 corruption, MITM, proxy mutation). Refuse to extract.
  const declaredArchiveSha = res.headers.get('x-archive-sha256');
  if (declaredArchiveSha) {
    const { createHash } = await import('node:crypto');
    const actualArchiveSha = createHash('sha256').update(buf).digest('hex');
    if (actualArchiveSha !== declaredArchiveSha.toLowerCase()) {
      throw new Error(
        `Extension "${entry.name}" archive SHA-256 mismatch: ` +
          `registry declared ${declaredArchiveSha.slice(0, 12)}… but ` +
          `downloaded bytes hash to ${actualArchiveSha.slice(0, 12)}…. ` +
          `Refusing to extract a tampered package.`,
      );
    }
  }

  // S1-01: signature verification. Try to fetch `<download_url>.sig` next to
  // the archive. The registry publishes the sig file as a sibling of the
  // tarball. Missing-signature behaviour is gated by REQUIRE_EXTENSION_SIGNATURES.
  await verifyArchiveSignature(entry.name, downloadUrl, headers, new Uint8Array(buf));

  // Magic-number sniffing — content-type from R2/Cloudflare can be unreliable.
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
  const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;

  const fs = await import('fs');
  const path = await import('path');

  // Stage into a temp dir so we can detect & flatten a single top-level folder
  // before moving files into the final destination.
  const stageDir = join(destDir, '_stage');
  // Clean any leftover stage from a previous failed run
  try {
    fs.rmSync(stageDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  fs.mkdirSync(stageDir, { recursive: true });

  const pkgPath = join(destDir, isZip ? '_pkg.zip' : '_pkg.tar.gz');
  fs.writeFileSync(pkgPath, buf);

  let proc: ReturnType<typeof Bun.spawn>;
  if (isZip) {
    proc = Bun.spawn(['unzip', '-qq', '-o', pkgPath, '-d', stageDir], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } else if (isGzip) {
    proc = Bun.spawn(['tar', '-xzf', pkgPath, '-C', stageDir], { stdout: 'pipe', stderr: 'pipe' });
  } else {
    try {
      fs.unlinkSync(pkgPath);
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(stageDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw new Error(`Unknown archive format for "${entry.name}" (expected ZIP or gzip)`);
  }

  const exitCode = await proc.exited;
  try {
    fs.unlinkSync(pkgPath);
  } catch {
    /* ignore */
  }

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr as ReadableStream).text();
    try {
      fs.rmSync(stageDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw new Error(
      `Extraction failed for "${entry.name}": ${stderr.trim() || `exit ${exitCode}`}`,
    );
  }

  // If the archive wrapped everything in a single top-level dir, unwrap it.
  // Allowed layouts:
  //   stage/engine/index.ts + stage/manifest.json   ← already flat
  //   stage/<anything>/engine/...                    ← flatten to destDir
  let sourceDir = stageDir;
  const stageEntries = fs.readdirSync(stageDir);
  if (stageEntries.length === 1) {
    const only = path.join(stageDir, stageEntries[0]);
    if (fs.statSync(only).isDirectory()) sourceDir = only;
  }

  // Move every entry from sourceDir into destDir (replacing any prior files).
  for (const e of fs.readdirSync(sourceDir)) {
    const src = path.join(sourceDir, e);
    const dst = path.join(destDir, e);
    try {
      fs.rmSync(dst, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    fs.renameSync(src, dst);
  }
  try {
    fs.rmSync(stageDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  console.log(`✅ Extension "${entry.name}" extracted to ${destDir}`);
}
