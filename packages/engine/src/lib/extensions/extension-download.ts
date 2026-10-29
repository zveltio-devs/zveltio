// Registry client: catalog fetch + cache, package download + extraction, and
// archive signature verification.
//
// Extracted from extension-loader.ts (loader split). This is the "get an
// extension's files from the registry onto disk" concern. Its only shared state
// is the in-module catalog cache.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'path';
import { EXTENSION_CATALOG, type ExtensionCatalogEntry } from './extension-catalog.js';
import { fetchWithRetry, isPathInsideBase } from './extension-utils.js';
import { tryAdvisoryLock } from '../../db/advisory-lock.js';
import type { Database } from '../../db/index.js';
import { purgeExtensionData } from './migration-runner.js';
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const data = (await res.json()) as { extensions: any[] };
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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
      // Used by the enable-time enforcement of marketplace-policy.md §2.
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

/** Per request: the archive and its signature each. */
const DOWNLOAD_TIMEOUT_MS = 60_000;

export interface ChangelogEntry {
  version: string;
  /** The heading after the version, e.g. `(2026-10-27)`; empty when none. */
  title: string;
  /** The entry's Markdown, heading excluded. */
  body: string;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The entries of a CHANGELOG.md (`## <version> …` headings) newer than `after`
 * and not newer than `upTo`, newest first. `after` null = everything up to
 * `upTo`. Headings that are not a semver version are skipped: an entry we
 * cannot place is not shown as part of an update.
 */
export function changelogBetween(md: string, after: string | null, upTo: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  for (const part of md.split(/^(?=## )/m)) {
    const m = part.match(/^## \[?v?([^\s\]]+)\]?[ \t]*(.*)\n?([\s\S]*)$/);
    if (!m) continue;
    const [, version, title, body] = m;
    // Bun.semver.order does not throw on junk ("Unreleased" sorts above 1.0.0).
    if (!SEMVER.test(version)) continue;
    if (Bun.semver.order(version, upTo) > 0) continue;
    if (after && Bun.semver.order(version, after) <= 0) continue;
    entries.push({ version, title: title.trim(), body: body.trim() });
  }
  return entries.sort((a, b) => Bun.semver.order(b.version, a.version));
}

/**
 * The extension's CHANGELOG.md from the registry, or null when it serves none
 * (404: none published, or a registry older than the changelog route). Any
 * other failure throws, so the caller reports "unreachable", not "no notes".
 */
export async function fetchRegistryChangelog(name: string): Promise<string | null> {
  const res = await fetch(
    `${REGISTRY_URL}/api/extensions/by-name/${encodeURIComponent(name)}/changelog`,
    { headers: { Accept: 'text/markdown' }, signal: AbortSignal.timeout(5000) },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Registry returned ${res.status}`);
  return res.text();
}

/**
 * Whether a missing signature blocks install. Exported so the default can be
 * pinned directly by a test, rather than a test reimplementing this
 * expression — a reimplementation checks its own copy, not this one, and
 * would stay green if this line regressed.
 *
 * default (unset or anything but "false") → required.
 * `REQUIRE_EXTENSION_SIGNATURES=false`    → not required (escape hatch for a
 * private mirror that does not sign yet).
 */
export function signaturesRequired(): boolean {
  return process.env.REQUIRE_EXTENSION_SIGNATURES !== 'false';
}

/**
 * Fetch `<download_url>.sig` and verify the archive's Ed25519 signature.
 *
 * Behaviour controlled by env:
 *   - default (unset or anything but "false") → a missing OR invalid signature
 *     throws (SignatureMissingError / SignatureInvalidError).
 *   - `REQUIRE_EXTENSION_SIGNATURES=false`    → a missing signature logs a
 *     warning and proceeds. An INVALID signature still throws either way — a
 *     present-but-broken signature is never accepted.
 */
async function verifyArchiveSignature(
  extensionName: string,
  downloadUrl: string,
  headers: Record<string, string>,
  archive: Uint8Array,
): Promise<void> {
  // Signatures are REQUIRED by default as of beta.37. The flag stays as an
  // escape hatch (`REQUIRE_EXTENSION_SIGNATURES=false`) for a private mirror
  // that does not sign yet; the supported way to trust another signer is
  // REGISTRY_PUBLIC_KEYS_JSON, not turning verification off.
  //
  // Enabling this was gated on the registry actually producing signatures, and
  // as of 2026-07-30 it does: all 57 official extensions serve a .sig at the URL
  // the engine fetches, and those signatures verify against the BUILTIN_KEYS
  // entry for registry-prod-2026 using this file's own verifySignature.
  const required = signaturesRequired();
  const sigUrl = `${downloadUrl}.sig`;

  let sigBody: unknown = null;
  try {
    // Bounded like the archive's: a boot fetches missing bundles before it serves.
    const sigRes = await fetchWithRetry(sigUrl, {
      headers,
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
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
      `[signature] ${extensionName}: no signature.sig found — install proceeded because REQUIRE_EXTENSION_SIGNATURES=false`,
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
/**
 * Result of a successful download.
 *
 * `archiveSha256` is returned so the caller can PIN it. The checks inside this
 * function prove the bytes match what the registry is serving right now and
 * that the registry signed them — neither notices a registry that serves
 * DIFFERENT bytes for a version you already installed, because it would sign
 * and declare those honestly too.
 */
export interface DownloadResult {
  archiveSha256: string;
}

export async function downloadExtension(
  entry: ExtensionCatalogEntry,
  destBase: string,
  licenseKey?: string,
  /** Digest recorded at the last install of THIS version, if any. */
  pinnedSha256?: string | null,
): Promise<DownloadResult> {
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
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
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

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 4) {
    throw new Error(`Empty package received for "${entry.name}"`);
  }

  // Trust chain: archive SHA-256 — publisher computed at pack time,
  // registry stored in R2 customMetadata at upload, returned here in
  // the X-Archive-Sha256 response header. If the bytes in `buf` don't
  // hash to the declared value, the package was tampered with in
  // transit (R2 corruption, MITM, proxy mutation). Refuse to extract.
  const { createHash } = await import('node:crypto');
  const actualArchiveSha = createHash('sha256').update(buf).digest('hex');

  // Pinning: the same version must always be the same bytes. The declared-hash
  // and signature checks below both compare against what the registry says
  // TODAY, so a registry that re-publishes different content under an existing
  // version passes them — it declares and signs the new bytes honestly. Only a
  // record of what was actually installed catches that.
  if (pinnedSha256 && pinnedSha256 !== actualArchiveSha) {
    throw new Error(
      `Extension "${entry.name}" version ${entry.version} does not match what was ` +
        `installed: pinned ${pinnedSha256.slice(0, 12)}… but the registry now serves ` +
        `${actualArchiveSha.slice(0, 12)}…. A published version's contents must never ` +
        `change. Refusing to install. If this is an intentional re-publish, the ` +
        `publisher must issue a new version.`,
    );
  }

  const declaredArchiveSha = res.headers.get('x-archive-sha256');
  if (declaredArchiveSha) {
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

  // Only now: bytes that failed a check above leave nothing on disk.
  const destDir = join(destBase, entry.name);
  mkdirSync(destDir, { recursive: true });

  // Magic-number sniffing — content-type from R2/Cloudflare can be unreliable.
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
  const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;

  const fs = await import('fs');
  const path = await import('path');

  // Stage into a temp dir so we can detect & flatten a single top-level folder
  // before moving files into the final destination. One of its own per call:
  // replicas booting onto one shared directory download at once, unlocked
  // (extension-loader.ts), and a fixed `_stage` / `_pkg` let each delete and
  // truncate the other's half-extracted files (measured: tar "Cannot mkdir").
  // Each entry below then appears whole, by rename.
  // A crash mid-extraction leaves its `_stage-*` (and archive) behind; one an
  // hour old is no download still running.
  for (const e of fs.readdirSync(destDir)) {
    const p = join(destDir, e);
    if (e.startsWith('_stage-') && Date.now() - fs.lstatSync(p).mtimeMs > 3_600_000)
      fs.rmSync(p, { recursive: true, force: true });
  }
  const stageDir = fs.mkdtempSync(join(destDir, '_stage-'));
  const pkgPath = `${stageDir}${isZip ? '.zip' : '.tar.gz'}`;
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

  // Defense-in-depth against zip-slip / symlink escape: GNU tar/unzip already
  // refuse `../` traversal, but a symlink inside the archive could point outside
  // the extension dir and be followed by a later file read (the extension's code
  // runs in-process). Reject any symlink in the staged tree before we adopt it.
  const assertNoSymlinks = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p); // lstat: do NOT follow — we want to detect links
      if (st.isSymbolicLink()) {
        try {
          fs.rmSync(stageDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        throw new Error(
          `Refusing extension "${entry.name}": archive contains a symlink (${name}) — ` +
            'possible path traversal.',
        );
      }
      if (st.isDirectory()) assertNoSymlinks(p);
    }
  };
  assertNoSymlinks(stageDir);

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
  return { archiveSha256: actualArchiveSha };
}

/** A new version downloaded beside the old one, to be swapped in when the caller is ready. */
export interface StagedExtension extends DownloadResult {
  /** The new directory takes the old one's place. Throws with the old one back and the download gone. */
  swap(): void;
  /** The new version stays: the old files go. */
  commit(): void;
  /** The old files come back where they were (or, before `swap`, the download goes). */
  rollback(): void;
  /** The `zv_migrations` ids the new version recorded: a crash's boot sweep undoes them. */
  noteMigrations(ids: number[]): void;
}

/**
 * Download `entry` into a SIBLING of its directory under `extBase` (same
 * filesystem, so the swap is renames), with every check `downloadExtension`
 * makes: bytes that fail one leave nothing behind and the old directory
 * untouched. `swap()` moves the old directory aside, not away, until
 * `commit()`; `rollback()` puts it back.
 *
 * There is no way back to an older version once committed: the registry serves
 * only an extension's current one.
 */
export async function stageExtensionDir(
  entry: ExtensionCatalogEntry,
  extBase: string,
  download: (destBase: string) => Promise<DownloadResult>,
): Promise<StagedExtension> {
  const target = join(extBase, entry.name);
  mkdirSync(extBase, { recursive: true });
  // Dot-named, so no directory listing takes it for an extension (discovery.ts);
  // named after the extension, so a crash's leftover is swept under its lock.
  const side = mkdtempSync(join(extBase, `${STAGING}${encodeURIComponent(entry.name)}.`));
  const fresh = join(side, entry.name);
  const previous = join(side, '.previous');
  let result: DownloadResult;
  try {
    result = await download(side);
  } catch (err) {
    rmSync(side, { recursive: true, force: true });
    throw err;
  }
  const had = existsSync(target);
  // A nested extension (`a/b` lives inside `a/`) is not part of `a`'s bundle: it stays.
  const carried: string[] = [];
  const carry = (from: string, to: string) => {
    for (const rel of carried) renameSync(join(from, rel), join(to, rel));
  };
  let swapped = false;
  let settled = false;
  return {
    ...result,
    swap() {
      try {
        if (had) {
          for (const rel of nestedExtensions(target, entry.name)) {
            if (existsSync(join(fresh, rel))) continue; // the new bundle ships that path itself
            mkdirSync(dirname(join(fresh, rel)), { recursive: true });
            renameSync(join(target, rel), join(fresh, rel));
            carried.push(rel);
          }
          renameSync(target, previous);
        }
        renameSync(fresh, target);
        swapped = true;
      } catch (err) {
        // Not swapped: whatever moved goes back where it was.
        if (had && !existsSync(target) && existsSync(previous)) renameSync(previous, target);
        if (existsSync(fresh)) carry(fresh, target);
        // Nothing changed: the staged download goes, and a later rollback has nothing to do.
        settled = true;
        rmSync(side, { recursive: true, force: true });
        throw err;
      }
    },
    commit() {
      if (settled) return;
      settled = true;
      rmSync(side, { recursive: true, force: true });
    },
    noteMigrations(ids) {
      writeFileSync(join(side, MIGRATED), JSON.stringify(ids));
    },
    rollback() {
      if (settled) return;
      if (swapped) {
        carry(target, previous);
        rmSync(target, { recursive: true, force: true });
        if (had) renameSync(previous, target);
      }
      settled = true;
      rmSync(side, { recursive: true, force: true });
    },
  };
}

const STAGING = '.update-';
const MIGRATED = '.migrations.json';
// Every extension name in the catalog: lowercase words, `/` between nested ones. No dots, so no `..`.
const EXTENSION_NAME = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/;

/** The extension a staging directory (`stageExtensionDir`) was made for, by its name. */
function stagedFor(dirName: string): string | null {
  const dot = dirName.lastIndexOf('.'); // mkdtemp's suffix holds none
  if (!dirName.startsWith(STAGING) || dot <= STAGING.length) return null;
  const encoded = dirName.slice(STAGING.length, dot);
  let name: string;
  try {
    name = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  // Exactly as stageExtensionDir spells it, and a name an extension can have.
  return encodeURIComponent(name) === encoded && EXTENSION_NAME.test(name) ? name : null;
}

/** What `noteMigrations` left in a staging directory. */
function notedMigrations(side: string): number[] {
  try {
    const ids: unknown = JSON.parse(readFileSync(join(side, MIGRATED), 'utf8'));
    return Array.isArray(ids) ? ids.filter((i): i is number => Number.isInteger(i)) : [];
  } catch {
    return []; // none ran
  }
}

function manifestVersion(dir: string): string | null {
  try {
    const { version } = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

/**
 * Boot, before any extension loads: settle what a crash left of an update under
 * `extBase`, touching nothing but its staging directories. Each is settled under
 * its extension's lock, skipped while another replica's update holds that.
 *
 * A `.previous` (the old bundle, moved aside by `swap`) comes back unless the
 * directory now holds the version on record, which is what an update records
 * before `commit` drops the old files; the migrations the update noted are
 * undone first, and when they cannot be, nothing is restored or removed.
 * Everything else of it goes.
 */
export async function sweepUpdateLeftovers(db: Database, extBase: string): Promise<void> {
  let entries: string[];
  try {
    entries = readdirSync(extBase).filter((e) => e.startsWith(STAGING));
  } catch {
    return; // no directory yet
  }
  for (const e of entries) {
    const name = stagedFor(e);
    // Not one stageExtensionDir made: not ours to remove.
    if (!name || !isPathInsideBase(extBase, join(extBase, name))) continue;
    const side = join(extBase, e);
    try {
      await tryAdvisoryLock(db, `ext:${name}`, async () => {
        if (!existsSync(side)) return; // its update settled it meanwhile
        const target = join(extBase, name);
        const previous = join(side, '.previous');
        const row = await db
          .selectFrom('zv_extension_registry')
          .select(['is_installed', 'installed_version'])
          .where('name', '=', name)
          .where('tenant_id', 'is', null)
          .executeTakeFirst();
        const current =
          row?.installed_version != null && manifestVersion(target) === row.installed_version;
        if (row?.is_installed && existsSync(previous) && !current) {
          // The old code never goes back onto the new version's schema.
          try {
            await purgeExtensionData(name, db, notedMigrations(side));
          } catch (err) {
            console.error(
              `[extensions] "${name}": an interrupted update's migrations were not undone ` +
                `(${(err as Error).message}); its new version stays and the previous one waits in ${side}`,
            );
            return;
          }
          if (existsSync(target)) {
            for (const rel of nestedExtensions(target, name)) {
              if (existsSync(join(previous, rel))) continue;
              mkdirSync(dirname(join(previous, rel)), { recursive: true });
              renameSync(join(target, rel), join(previous, rel));
            }
            rmSync(target, { recursive: true, force: true });
          }
          renameSync(previous, target);
          console.warn(`[extensions] "${name}": an interrupted update's previous version restored`);
        }
        rmSync(side, { recursive: true, force: true });
      });
    } catch (err) {
      console.warn(
        `[extensions] "${name}": update leftover ${e} not settled:`,
        (err as Error).message,
      );
    }
  }
}

/**
 * The paths under `dir` (extension `name`'s directory) of the extensions nested
 * in it: a directory whose manifest names it `<name>/<path>`, as every
 * extension's manifest names its own directory. A `manifest.json` that names
 * anything else (a PWA manifest, a dependency's) is part of the bundle.
 */
function nestedExtensions(dir: string, name: string, rel = ''): string[] {
  const found: string[] = [];
  for (const d of readdirSync(join(dir, rel), { withFileTypes: true })) {
    if (!d.isDirectory() || d.name === 'node_modules') continue;
    const sub = rel ? `${rel}/${d.name}` : d.name;
    let own: unknown;
    try {
      own = JSON.parse(readFileSync(join(dir, sub, 'manifest.json'), 'utf8')).name;
    } catch {
      /* no manifest of its own */
    }
    if (own === `${name}/${sub}`) found.push(sub);
    else found.push(...nestedExtensions(dir, name, sub));
  }
  return found;
}
