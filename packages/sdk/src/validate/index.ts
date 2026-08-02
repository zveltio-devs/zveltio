/**
 * Pre-publish validators for Zveltio extensions (S4-04).
 *
 * Pure functions — no Node-specific imports, no Zod runtime. Designed so the
 * CLI (`zveltio extension validate`) can call them on file contents read from
 * disk, the engine can call them on uploaded archives, and registry code can
 * call them on publish. Each returns a `ValidationResult` with structured
 * diagnostics instead of throwing, so the CLI can print all problems at once.
 *
 * What's checked:
 *   - manifest.json shape (required fields, semver, sane category)
 *   - name matches the folder path it lives in
 *   - peerDependencies appear on the platform allow-list
 *   - migration SQL files parse + table coverage looks sane
 *   - destructive DDL in migrations has a `-- DOWN` section
 *   - bundle size stays within quota
 *
 * Out of scope (deferred):
 *   - Loading the extension module to inspect its default export. Requires
 *     a Bun runtime + sandbox. CLI's `validate` cannot guarantee correctness
 *     for runtime contracts; that's what `extension types` (S4-01) + `tsc`
 *     gives you locally.
 *   - Building the Studio bundle. Too slow; pair with `zveltio extension build`
 *     which can call validate as a sub-step.
 */

import { parseMigrationSql } from './migration-parse.js';

export { SHARED_MESSAGE_KEYS } from './shared-message-keys.js';

export interface ValidationError {
  /** Stable machine-readable code (e.g. `MANIFEST_NAME_MISMATCH`). */
  code: string;
  /** Operator-facing message. */
  message: string;
  /** Optional file path the error applies to, relative to the extension root. */
  file?: string;
  /** `warning` items are surfaced but do NOT fail validation (`result.ok`). */
  severity?: 'error' | 'warning';
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
  /** Counts surfaced for human-readable summaries. */
  stats: {
    tables: number;
    migrations: number;
    peerDeps: number;
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;

const KNOWN_CATEGORIES = new Set([
  'auth',
  'content',
  'crm',
  'finance',
  'hr',
  'operations',
  'developer',
  'compliance',
  'communications',
  'analytics',
  'geospatial',
  'ai',
  'integrations',
  'i18n',
  'workflow',
  'storage',
  'ecommerce',
  'projects',
  'sms',
  'forms',
  'billing',
  'intelligence',
  'business',
  'search',
  'data',
  'custom',
]);

// Sub-set of the engine's safety regexes — kept identical so the two paths
// agree. If we drift, an extension that validates clean would still be
// rejected at install time.
const SAFE_PACKAGE_NAME = /^(@[a-z0-9-_]+\/)?[a-z0-9-_.]+$/;
const SAFE_VERSION_RANGE = /^[\d.*^~>=<| -]+$/;

function err(code: string, message: string, file?: string): ValidationError {
  return file ? { code, message, file } : { code, message };
}

function warn(code: string, message: string, file?: string): ValidationError {
  return { ...err(code, message, file), severity: 'warning' };
}

// ─── manifest.json ─────────────────────────────────────────────────────────

export interface ManifestValidationInput {
  /** Parsed JSON object (or `null` if file couldn't be read). */
  manifest: unknown;
  /** Folder path slug — e.g. `'finance/invoicing'`. Used for name-match. */
  expectedName?: string;
}

export function validateManifest(input: ManifestValidationInput): ValidationError[] {
  const out: ValidationError[] = [];
  const m = input.manifest;
  if (m === null || typeof m !== 'object' || Array.isArray(m)) {
    out.push(err('MANIFEST_NOT_OBJECT', 'manifest.json must be a JSON object'));
    return out;
  }
  const obj = m as Record<string, unknown>;

  // Required string fields
  for (const k of ['name', 'displayName', 'category', 'description', 'version']) {
    if (typeof obj[k] !== 'string' || (obj[k] as string).trim() === '') {
      out.push(err('MANIFEST_MISSING_FIELD', `manifest.json missing required string field "${k}"`));
    }
  }

  const name = typeof obj.name === 'string' ? obj.name : '';
  if (input.expectedName && name && name !== input.expectedName) {
    out.push(
      err(
        'MANIFEST_NAME_MISMATCH',
        `manifest "name": "${name}" does not match folder path "${input.expectedName}"`,
      ),
    );
  }

  if (typeof obj.version === 'string' && !SEMVER_RE.test(obj.version)) {
    out.push(err('MANIFEST_BAD_VERSION', `version "${obj.version}" is not valid semver (x.y.z)`));
  }

  if (typeof obj.zveltioMinVersion === 'string' && !SEMVER_RE.test(obj.zveltioMinVersion)) {
    out.push(
      err(
        'MANIFEST_BAD_MIN_VERSION',
        `zveltioMinVersion "${obj.zveltioMinVersion}" is not valid semver`,
      ),
    );
  }
  if (typeof obj.zveltioMaxVersion === 'string' && !SEMVER_RE.test(obj.zveltioMaxVersion)) {
    out.push(
      err(
        'MANIFEST_BAD_MAX_VERSION',
        `zveltioMaxVersion "${obj.zveltioMaxVersion}" is not valid semver`,
      ),
    );
  }

  if (typeof obj.category === 'string' && !KNOWN_CATEGORIES.has(obj.category)) {
    // A true warning — categories are open-ended in practice (e.g. the RO
    // compliance set uses "compliance/ro"). Surfaced so authors notice typos
    // like "finanace", but it must NOT fail validation.
    out.push(
      warn(
        'MANIFEST_UNKNOWN_CATEGORY',
        `category "${obj.category}" isn't in the known set — typo? Known: ${[...KNOWN_CATEGORIES].sort().join(', ')}`,
      ),
    );
  }

  return out;
}

// ─── peerDependencies allow-list ───────────────────────────────────────────

export interface PeerDepsValidationInput {
  /** From manifest.json: `{ "lodash": "^4.0.0", ... }` (or undefined). */
  peerDependencies: Record<string, string> | undefined;
  /** The platform allow-list (caller supplies it — see peer-deps-allowlist.ts). */
  allowedPackages: ReadonlySet<string>;
}

export function validatePeerDependencies(input: PeerDepsValidationInput): ValidationError[] {
  const out: ValidationError[] = [];
  const deps = input.peerDependencies ?? {};
  for (const [pkg, version] of Object.entries(deps)) {
    if (typeof version !== 'string') {
      out.push(
        err(
          'PEERDEP_BAD_VERSION',
          `peerDependency "${pkg}" version must be a string, got ${typeof version}`,
        ),
      );
      continue;
    }
    if (!SAFE_PACKAGE_NAME.test(pkg)) {
      out.push(
        err(
          'PEERDEP_UNSAFE_NAME',
          `peerDependency "${pkg}" uses an unsupported name format (file:, git:, etc. are forbidden)`,
        ),
      );
      continue;
    }
    if (!SAFE_VERSION_RANGE.test(version)) {
      out.push(
        err(
          'PEERDEP_UNSAFE_VERSION',
          `peerDependency "${pkg}" version range "${version}" is not a plain semver range`,
        ),
      );
      continue;
    }
    if (!input.allowedPackages.has(pkg)) {
      out.push(
        err(
          'PEERDEP_NOT_ALLOWED',
          `peerDependency "${pkg}" is not on the platform allow-list — open a PR to peer-deps-allowlist.ts to request inclusion`,
        ),
      );
    }
  }
  return out;
}

// ─── Migrations ────────────────────────────────────────────────────────────

export interface MigrationsValidationInput {
  /** Pairs of (filename, sql contents). Filename is just for diagnostics. */
  files: Array<{ filename: string; sql: string }>;
  /** When `true`, every migration with destructive DDL must have a -- DOWN section. */
  requireDownForDestructive?: boolean;
}

/**
 * Detect "destructive" DDL statements in an UP section. Heuristic — we want
 * to catch the easy cases (DROP TABLE, DROP COLUMN, ALTER COLUMN ... DROP)
 * without false positives on benign DROP IF EXISTS in DOWN sections (which
 * we don't scan).
 */
function hasDestructiveDdl(upSql: string): boolean {
  // Strip strings and comments-light: this is a heuristic; full SQL parsing
  // is overkill for a pre-publish lint. Only DATA-destructive ops count —
  // DROP TABLE / DROP COLUMN lose rows. `ALTER COLUMN ... DROP NOT NULL` and
  // `DROP DEFAULT` only relax a constraint / remove a default and lose no data,
  // so they do NOT require a -- DOWN (they were false positives on legit
  // forward migrations that make a column nullable).
  const s = upSql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  if (/\bDROP\s+TABLE\b/i.test(s)) return true;
  if (/\bDROP\s+COLUMN\b/i.test(s)) return true;
  return false;
}

export function validateMigrations(input: MigrationsValidationInput): ValidationError[] {
  const out: ValidationError[] = [];
  for (const file of input.files) {
    if (file.sql.trim() === '') {
      out.push(err('MIGRATION_EMPTY', 'migration file is empty', file.filename));
      continue;
    }
    let parsed: ReturnType<typeof parseMigrationSql>;
    try {
      parsed = parseMigrationSql(file.sql);
    } catch (e) {
      out.push(
        err('MIGRATION_PARSE', `could not parse migration: ${(e as Error).message}`, file.filename),
      );
      continue;
    }
    if (parsed.up.trim() === '') {
      out.push(
        err(
          'MIGRATION_NO_UP',
          'migration has no UP section (everything before -- DOWN)',
          file.filename,
        ),
      );
      continue;
    }
    if (input.requireDownForDestructive && hasDestructiveDdl(parsed.up) && !parsed.down) {
      out.push(
        err(
          'MIGRATION_DESTRUCTIVE_NO_DOWN',
          'migration contains destructive DDL (DROP TABLE/COLUMN or ALTER ... DROP) but has no "-- DOWN" section. Add one so uninstall --purgeData can roll back.',
          file.filename,
        ),
      );
    }
  }
  return out;
}

// ─── File presence ─────────────────────────────────────────────────────────

export interface FilePresenceInput {
  /** Mapping of relative path → existence boolean. Caller does the disk hit. */
  paths: Record<string, boolean>;
  /** Paths that MUST exist. */
  required: string[];
}

export function validateFilePresence(input: FilePresenceInput): ValidationError[] {
  const out: ValidationError[] = [];
  for (const p of input.required) {
    if (!input.paths[p]) {
      out.push(err('FILE_MISSING', `required file is missing`, p));
    }
  }
  return out;
}

// ─── Bundle size quotas ────────────────────────────────────────────────────

export interface BundleSizeInput {
  /** Size of the extension folder (excluding node_modules), in bytes. */
  bundleBytes: number;
  /** Override the default cap (50 MB). */
  bundleSizeKbMax?: number;
}

const DEFAULT_BUNDLE_KB_MAX = 50_000;

export function validateBundleSize(input: BundleSizeInput): ValidationError[] {
  const cap = input.bundleSizeKbMax ?? DEFAULT_BUNDLE_KB_MAX;
  const observedKb = Math.ceil(input.bundleBytes / 1024);
  if (observedKb > cap) {
    return [
      err(
        'BUNDLE_TOO_LARGE',
        `extension bundle is ${observedKb} KB; quota is ${cap} KB. Reduce the bundle or raise the quota in manifest.quotas.bundleSizeKbMax.`,
      ),
    ];
  }
  return [];
}

// ─── SDUI declarative pages: endpoint contract ─────────────────────────────
//
// Catches the class of bug that shipped silently in beta.11: a declarative
// schema whose `dataSource`/`endpoint` points at a route the extension does NOT
// serve (wrong path → empty table / 404), or at a foreign endpoint outside the
// extension's own `/ext/<name>/` namespace (security). The response-key check
// (`dataPath`) needs the live response, so it lives in the runtime
// `zveltio extension test`, not here.

/** Read-only core endpoints a schema is legitimately allowed to call (relation
 * pickers etc.). Keep this list tiny and read-only. */
export const SDUI_SHARED_READ_ALLOWLIST: ReadonlySet<string> = new Set([
  '/api/collections',
  '/api/views',
]);

/** Collapse `{token}` and `:param` path segments so a schema endpoint
 * (`/periods/{id}/generate`) matches an engine route (`/periods/:id/generate`). */
function normalizeRoute(p: string): string {
  return (
    p
      .split('?')[0]
      .replace(/\{[^}]+\}/g, '*')
      .replace(/:[^/]+/g, '*')
      .replace(/\/+$/, '') || '/'
  );
}

/**
 * Schema keys whose value is user-visible text.
 *
 * The host renders these through `t()`, which looks the string up in the
 * message bundle and falls back to the literal. That fallback is why a typo is
 * invisible at runtime: the user simply sees `auth.saml.ui.begin_certificate`
 * rendered as a placeholder. Catching it here is the only place it is cheap.
 */
export const SDUI_I18N_SLOTS: readonly string[] = [
  'title',
  'subtitle',
  'label',
  'placeholder',
  'note',
  'confirm',
  'description',
  'emptyText',
  'emptyTitle',
  'hint',
];

/** Tokens that read the same in every locale we ship. */
const I18N_UNIVERSAL = new Set([
  'API',
  'JSON',
  'NDJSON',
  'CSV',
  'SQL',
  'URL',
  'UUID',
  'ID',
  'HTTP',
  'HTTPS',
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'Zveltio',
  'OK',
  'UTC',
  'AI',
  'SDK',
  'CLI',
  'RLS',
  'DB',
  'PDF',
  'XML',
  'YAML',
]);

/** Dotted lowercase identifier — the shape every message key in this project has. */
function looksLikeMessageKey(s: string): boolean {
  return /^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/i.test(s);
}

/**
 * Prose a user would read, as opposed to a token, an identifier or a code
 * sample. Deliberately the same judgement the Studio's own i18n gate makes —
 * flagging `CSV` or `status=active` would train authors to ignore the warning.
 */
function looksTranslatable(s: string): boolean {
  const t = s.trim();
  if (t.length < 3) return false;
  if (I18N_UNIVERSAL.has(t)) return false;
  if (!/[a-z]{2}/.test(t)) return false;
  if (/^[a-z0-9_.\-/]+$/.test(t)) return false; // identifier or path
  if (/^[a-z0-9_]+=/.test(t)) return false; // filter/code sample, e.g. status=active
  if (t.startsWith('http')) return false;
  return /^[A-Z]/.test(t) || t.split(/\s+/).length > 1;
}

/** Recursively collect every user-visible string with the slot it came from. */
function collectI18nStrings(node: unknown, acc: Array<{ slot: string; value: string }>): void {
  if (Array.isArray(node)) {
    for (const x of node) collectI18nStrings(x, acc);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (SDUI_I18N_SLOTS.includes(k) && typeof v === 'string' && v)
        acc.push({ slot: k, value: v });
      else collectI18nStrings(v, acc);
    }
  }
}

/** Recursively collect every `dataSource` / `endpoint` / `saveEndpoint` string. */
function collectEndpoints(node: unknown, acc: string[]): void {
  if (Array.isArray(node)) {
    for (const x of node) collectEndpoints(x, acc);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if ((k === 'dataSource' || k === 'endpoint' || k === 'saveEndpoint') && typeof v === 'string')
        acc.push(v);
      else collectEndpoints(v, acc);
    }
  }
}

export interface SduiValidationInput {
  /** Parsed schema JSON (a PageSchema or SettingsSchema). */
  schema: unknown;
  /** Owning extension name, e.g. `finance/invoicing`. */
  extName: string;
  /** Route paths the extension's engine actually serves, relative to its mount
   * (e.g. `['/invoices', '/invoices/:id/pay']`). The CLI extracts these from
   * `engine/**` source; pass `undefined` to skip the path-existence check
   * (foreign-namespace check still runs). */
  providedRoutes?: string[];
  /** Extension names this one declares as dependencies (manifest.dependencies).
   * A schema may read a dependency's `/ext/<dep>/` routes (relation pickers),
   * which is otherwise treated as foreign. */
  dependencies?: string[];
  /** Message keys this schema may resolve against: the extension's own
   * `studio/messages/en.json` keys, unioned with `SHARED_MESSAGE_KEYS`.
   * Omit to skip the i18n checks (endpoint checks still run). */
  messageKeys?: Iterable<string>;
  /** For diagnostics. */
  file?: string;
}

export function validateSduiSchema(input: SduiValidationInput): ValidationError[] {
  const out: ValidationError[] = [];
  const { schema, extName, file } = input;
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    out.push(err('SDUI_NOT_OBJECT', 'schema must be a JSON object', file));
    return out;
  }
  const s = schema as Record<string, unknown>;

  // Light structural guard (the host's validateSchema is the full one).
  if (typeof s.title !== 'string' || !s.title)
    out.push(err('SDUI_NO_TITLE', 'schema missing "title"', file));
  if (s.kind === 'settings') {
    if (typeof s.dataSource !== 'string' || typeof s.saveEndpoint !== 'string')
      out.push(err('SDUI_SETTINGS_SHAPE', 'settings schema needs dataSource + saveEndpoint', file));
  } else if (!Array.isArray(s.resources) || s.resources.length === 0) {
    out.push(err('SDUI_NO_RESOURCES', 'page schema needs a non-empty "resources" array', file));
  }

  const mount = `/ext/${extName}`;
  const depMounts = (input.dependencies ?? []).map((d) => `/ext/${d}`);
  const provided = input.providedRoutes
    ? new Set(input.providedRoutes.map(normalizeRoute))
    : undefined;
  const inMount = (bare: string, m: string) => bare === m || bare.startsWith(`${m}/`);

  const endpoints: string[] = [];
  collectEndpoints(schema, endpoints);
  for (const raw of endpoints) {
    const bare = raw.split('?')[0];
    if (SDUI_SHARED_READ_ALLOWLIST.has(bare)) continue;
    // A dependency's namespace is allowed (relation pickers etc.).
    if (depMounts.some((m) => inMount(bare, m))) continue;
    if (!inMount(bare, mount)) {
      out.push(
        err(
          'SDUI_ENDPOINT_FOREIGN',
          `endpoint "${raw}" is outside this extension's namespace "${mount}/" (or a declared dependency, or the shared-read allowlist). Schemas may only call their own routes.`,
          file,
        ),
      );
      continue;
    }
    if (provided) {
      const rel = normalizeRoute(bare.slice(mount.length) || '/');
      if (!provided.has(rel)) {
        out.push(
          err(
            'SDUI_ENDPOINT_UNKNOWN',
            `endpoint "${raw}" resolves to "${rel}", which the engine does not serve. Provided routes: ${[...provided].sort().join(', ') || '(none found)'}.`,
            file,
          ),
        );
      }
    }
  }

  // ── i18n ─────────────────────────────────────────────────────────────────
  // A schema is data, so every user-visible string sits in a named slot and can
  // be checked exactly — no source parsing, no heuristics about what is prose.
  // That is the property hand-written pages do not have.
  if (input.messageKeys) {
    const known = new Set(input.messageKeys);
    const strings: Array<{ slot: string; value: string }> = [];
    collectI18nStrings(schema, strings);
    for (const { slot, value } of strings) {
      if (known.has(value)) continue;
      if (looksLikeMessageKey(value)) {
        out.push(
          err(
            'SDUI_I18N_KEY_MISSING',
            `${slot} "${value}" is not a known message key. The host renders an unknown key as literal text, so this reaches the user as-is. Add it to studio/messages/{locale}.json, or use a shared common.* key.`,
            file,
          ),
        );
      } else if (looksTranslatable(value)) {
        out.push(
          warn(
            'SDUI_I18N_HARDCODED',
            `${slot} "${value}" is hardcoded text, not a message key — it stays English in all nine locales. Move it to studio/messages/{locale}.json.`,
            file,
          ),
        );
      }
    }
  }
  return out;
}

/** Extract route paths an extension serves from its engine source text.
 * Heuristic regex over `app.get('/…')` / `.post(` / `.put(` / `.patch(` /
 * `.delete(`. Good enough to catch typo'd / nonexistent endpoints. */
export function extractEngineRoutes(engineSourceTexts: string[]): string[] {
  const routes = new Set<string>();
  const re = /\.(?:get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
  for (const text of engineSourceTexts) {
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
    while ((m = re.exec(text)) !== null) {
      const p = m[1];
      if (p.startsWith('/')) routes.add(p);
    }
  }
  return [...routes];
}

// ─── Composite ─────────────────────────────────────────────────────────────

export interface ValidateExtensionInput {
  manifest: ManifestValidationInput;
  peerDeps: PeerDepsValidationInput;
  migrations: MigrationsValidationInput;
  filePresence: FilePresenceInput;
  bundleSize?: BundleSizeInput;
  /** Numbers used to fill the result's `stats` for human summaries. */
  stats: { tables: number; migrations: number };
}

export function validateExtension(input: ValidateExtensionInput): ValidationResult {
  const errors: ValidationError[] = [
    ...validateManifest(input.manifest),
    ...validatePeerDependencies(input.peerDeps),
    ...validateMigrations(input.migrations),
    ...validateFilePresence(input.filePresence),
    ...(input.bundleSize ? validateBundleSize(input.bundleSize) : []),
  ];
  return {
    // Warnings are surfaced in `errors` but do not fail validation.
    ok: errors.every((e) => e.severity === 'warning'),
    errors,
    stats: {
      tables: input.stats.tables,
      migrations: input.stats.migrations,
      peerDeps: Object.keys(input.peerDeps.peerDependencies ?? {}).length,
    },
  };
}
