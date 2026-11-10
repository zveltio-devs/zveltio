/**
 * Stored files: the one path that writes, reads and deletes them.
 *
 * `/api/storage` (routes/storage.ts) and a job's `host.files` (ADR 0032,
 * lib/extensions/file-grants.ts) both come through here, so a file reaches the store
 * by one set of checks — size, quota, folder, type allowlist, SVG sanitising,
 * content sniffing — and is read and deleted by one visibility rule
 * (`media-visibility.ts`). A second door with its own copy of these checks is
 * how the quota once had a hole (`storage-quota.ts`).
 *
 * Who acts is a `FileActor` (`fileActorOf`): the request's user, or the user
 * who handed a job its files. Nothing here reads a request.
 */

import type { Database } from '../db/index.js';
import { apiKeyRowId, isApiKeyPrincipal, type RequestUser, rowAuthorId } from './data/index.js';
import { mayDeleteFile, mayReadFile } from './media-visibility.js';
import { getStorage } from './storage/index.js';
import { checkStorageQuota } from './storage-quota.js';
import { isTenantAdmin } from './tenancy/index.js';

// Extract image width/height from raw bytes — avoids pulling in `image-size`
// or similar. Supports PNG (IHDR chunk), JPEG (SOF markers), GIF89a/GIF87a,
// and WebP (VP8/VP8L/VP8X).
function extractImageDimensions(
  buffer: Buffer,
  mimeType: string,
): { width?: number; height?: number } {
  try {
    if (mimeType === 'image/png') {
      // PNG: IHDR chunk at bytes 8-28; width at 16-19 (BE), height at 20-23 (BE).
      if (buffer.length >= 24) {
        return {
          width: buffer.readUInt32BE(16),
          height: buffer.readUInt32BE(20),
        };
      }
    } else if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
      // JPEG: scan for SOF0-SOF3 markers (0xFF 0xC0..0xC3), skipping other segments.
      let i = 2;
      while (i < buffer.length - 8) {
        if (buffer[i] !== 0xff) break;
        const marker = buffer[i + 1];
        if (marker >= 0xc0 && marker <= 0xc3) {
          return {
            height: buffer.readUInt16BE(i + 5),
            width: buffer.readUInt16BE(i + 7),
          };
        }
        const segLen = buffer.readUInt16BE(i + 2);
        if (segLen < 2) break; // malformed
        i += 2 + segLen;
      }
    } else if (mimeType === 'image/gif') {
      // GIF: logical screen descriptor at bytes 6-9 (LE).
      if (buffer.length >= 10) {
        return {
          width: buffer.readUInt16LE(6),
          height: buffer.readUInt16LE(8),
        };
      }
    } else if (mimeType === 'image/webp') {
      // WebP: RIFF header, then WEBP FourCC, then VP8/VP8L/VP8X chunk.
      if (
        buffer.length >= 30 &&
        buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WEBP'
      ) {
        const chunkType = buffer.toString('ascii', 12, 16);
        if (chunkType === 'VP8 ' && buffer.length >= 30) {
          // Lossy VP8: 14-bit width/height at bytes 26-29 (LE, minus 1 each).
          return {
            width: (buffer.readUInt16LE(26) & 0x3fff) + 1,
            height: (buffer.readUInt16LE(28) & 0x3fff) + 1,
          };
        } else if (chunkType === 'VP8L' && buffer.length >= 26 && buffer[20] === 0x2f) {
          // Lossless VP8L: packed 28-bit fields (14 bits each) starting at byte 21.
          const bits = buffer.readUInt32LE(21);
          return {
            width: (bits & 0x3fff) + 1,
            height: ((bits >> 14) & 0x3fff) + 1,
          };
        } else if (chunkType === 'VP8X' && buffer.length >= 30) {
          // Extended VP8X: 24-bit LE width-1 at bytes 24-26, height-1 at 27-29.
          const w = buffer.readUIntLE(24, 3) + 1;
          const h = buffer.readUIntLE(27, 3) + 1;
          return { width: w, height: h };
        }
      }
    }
  } catch {
    /* parsing error — skip, leave dimensions undefined */
  }
  return {};
}

/**
 * Strip script/event-handler nodes out of an SVG string.
 *
 * An SVG with `<script>` or `<foreignObject>` content executes when the
 * browser renders it inline. Even an `<img src="...svg">` can run scripts
 * if the SVG is served from the same origin. We delete the dangerous
 * subtrees and scrub every `on*` attribute before storage.
 *
 * We deliberately use a regex sweep rather than parsing the SVG: bringing
 * in a DOM parser on every upload is heavy, and the cases we need to kill
 * are stable. False positives (e.g. an SVG with a `<title>` that happens
 * to contain the literal word "script") are not destructive — the worst
 * case is a stripped attribute, not a corrupted file.
 */
/**
 * Schemes an SVG link may carry. Anything else — including anything this
 * function cannot confidently read — becomes `#`.
 */
function isSafeSvgUrl(raw: string): boolean {
  // Decode what a browser decodes before it resolves the scheme: HTML entities
  // (numeric and the few named ones that matter) and control characters, which
  // are ignored inside a scheme.
  const decoded = raw
    .replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);?/g, (_m, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&colon;/gi, ':')
    .replace(/&NewLine;/gi, '\n')
    .replace(/&Tab;/gi, '\t')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\u0000-\u0020\u00a0\ufeff]/g, '')
    .toLowerCase();
  if (decoded === '') return true;
  // Relative, fragment and root-relative references carry no scheme at all.
  if (/^[#/.?]/.test(decoded)) return true;
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(decoded);
  if (!scheme) return true; // a bare path such as `logo.png`
  return scheme[1] === 'http' || scheme[1] === 'https' || scheme[1] === 'mailto';
}

/** Exported for the regression suite — the sweep is the whole defence for SVG. */
export function sanitizeSvgString(svg: string): string {
  let s = svg;
  // Strip <script>...</script>
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  // Strip <script .../> self-closing
  s = s.replace(/<script\b[^>]*\/>/gi, '');
  // Strip <foreignObject> — can embed arbitrary HTML, including <iframe>
  s = s.replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject>/gi, '');
  // Strip all on* event handler attributes (onload, onclick, …)
  s = s.replace(/\s+on[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/g, '');
  // Every href is checked against an ALLOWLIST of schemes rather than a list of
  // bad ones. The denylist here matched the literal strings `javascript:`,
  // `data:` and `vbscript:`, and an SVG carrying
  // `xlink:href="java&#10;script:alert(1)"` went through untouched — the browser
  // decodes the entity, the regex does not. Measured, with the three payloads
  // below surviving byte for byte. A denylist over an open namespace is the
  // shape this codebase has been bitten by repeatedly; this is the same fix.
  s = s.replace(
    /(\bhref|\bxlink:href)\s*=\s*("|')([^"']*)\2/gi,
    (whole, attr: string, quote: string, value: string) =>
      isSafeSvgUrl(value) ? whole : `${attr}=${quote}#${quote}`,
  );
  // SMIL can set an attribute the sanitiser just cleaned: `<set
  // attributeName="xlink:href" to="javascript:…">` and the `<animate>` form of
  // it both re-point a link at script AFTER load, so neither is reachable by
  // looking at href attributes. Only the animations that target a URL attribute
  // are removed; an ordinary animated SVG keeps working.
  s = s.replace(
    /<(set|animate|animateTransform|animateMotion)\b[^>]*\battributeName\s*=\s*("|')\s*(?:xlink:)?href\s*\2[^>]*>(?:[\s\S]*?<\/\1\s*>)?/gi,
    '',
  );
  // Strip <use href="data:..."> — Chrome and Firefox both allow script:
  // execution through external SVG references.
  s = s.replace(
    /<use\b[^>]*\b(?:href|xlink:href)\s*=\s*(?:"|')\s*(?:javascript|data|vbscript):/gi,
    '<use ',
  );
  return s;
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  '7z': 'application/x-7z-compressed',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
};

/**
 * Detect a file's real MIME from its magic bytes, ignoring the
 * client-supplied `file.type`. A user can rename `evil.html` to `safe.png`
 * and trick the browser into rendering it as HTML if we trust the header;
 * checking the actual bytes catches that. Falls back to the extension
 * allowlist mapping when we don't have a magic-byte signature for the
 * file type (e.g. plain text formats).
 */
function detectMimeFromMagic(buf: Buffer, ext: string): string | null {
  if (buf.length >= 4) {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
      return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38)
      return 'image/gif';
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46)
      return 'application/pdf';
    if (buf[0] === 0x50 && buf[1] === 0x4b) return MIME_BY_EXT[ext] ?? 'application/zip';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46)
      return 'image/webp'; // RIFF — could be WAV/AVI too, prefer ext
  }
  return MIME_BY_EXT[ext] ?? null;
}

/** The extensions `storeFile` accepts; anything else is refused, whatever its bytes. */
const ALLOWED_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'avif',
  'svg',
  'pdf',
  'txt',
  'md',
  'csv',
  'xlsx',
  'xls',
  'docx',
  'doc',
  'pptx',
  'ppt',
  'mp4',
  'webm',
  'mov',
  'avi',
  'mp3',
  'wav',
  'ogg',
  'flac',
  'zip',
  'tar',
  'gz',
  '7z',
  'json',
  'xml',
]);

const extensionOf = (name: string) =>
  (name.split('.').pop() ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Why `storeFile` would refuse a file named `name` by its type, or null. */
export function fileTypeRefusal(name: string): FileRefusal | null {
  const ext = extensionOf(name);
  if (ext && ALLOWED_EXTENSIONS.has(ext)) return null;
  return {
    status: 400,
    body: {
      error: `File type ".${ext}" is not allowed. Allowed types: ${[...ALLOWED_EXTENSIONS].join(', ')}`,
    },
  };
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who acts on stored files. */
export interface FileActor {
  /** The tenant the request or job acts in. */
  tenantId: string;
  /** Compared with the uploader (`media-visibility`): a user id, or a member key's `apikey:<uuid>`. */
  principalId: string;
  /** The `"user"` row a new file is recorded as (`created_by`), and whose quota it counts against. */
  author: string | null;
  /** A member key's own row (`created_by_api_key`), so it finds its private uploads again. */
  apiKeyRow: string | null;
  /** Reads and deletes every file of the tenant: a tenant admin. */
  seesAll: boolean;
}

/**
 * `user` as `/api/storage` takes them in `tenantId`: files are recorded, and
 * counted against a quota, as a key's issuer; a key finds its own private
 * uploads through its row. A key is never a tenant admin itself; its exemption
 * is `rls_bypass`, the data path's rule, and only while its issuer is one. A
 * failed lookup sees no more than its own.
 */
export async function fileActorOf(
  user: Pick<RequestUser, 'id' | 'rlsBypass' | 'authorUserId'>,
  tenantId: string,
): Promise<FileActor> {
  const key = isApiKeyPrincipal(user);
  // The session's own question, asked of the issuer in this tenant.
  const admin = key ? (user.rlsBypass === true && user.authorUserId) || null : user.id;
  return {
    tenantId,
    principalId: user.id,
    author: rowAuthorId(user),
    apiKeyRow: key ? apiKeyRowId(user.id) : null,
    seesAll: admin ? await isTenantAdmin(admin).catch(() => false) : false,
  };
}

/** A refusal, as `/api/storage` answers it. */
export interface FileRefusal {
  status: 400 | 403 | 404 | 413 | 500 | 502 | 503;
  body: { error: string } & Record<string, unknown>;
}

type ZvMediaFile = Awaited<ReturnType<typeof selectFile>>;
/** A `zv_media_files` row. */
export type StoredFile = NonNullable<ZvMediaFile>;

const selectFile = (db: Database, tenantId: string, id: string) =>
  db
    .selectFrom('zv_media_files')
    .selectAll()
    .where('id', '=', id)
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();

/**
 * A folder named in a write must be one this tenant can see. The foreign key is
 * checked by Postgres outside row-level security, so it accepted another
 * tenant's folder id: the new row hung under B's folder, and the 201-versus-
 * error answer told A which of B's folder ids exist.
 */
export const folderVisible = async (db: Database, tenantId: string, id: unknown) =>
  typeof id === 'string' &&
  UUID_RE.test(id) &&
  Boolean(
    await db
      .selectFrom('zv_media_folders')
      .select('id')
      .where('id', '=', id)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst(),
  );

/**
 * The file `id` when `actor` may read it, else null. Null, not a refusal, for
 * one that exists but is not theirs: whether a colleague's private file exists
 * is itself something they did not share.
 */
export async function readableFile(
  db: Database,
  actor: FileActor,
  id: string,
): Promise<NonNullable<ZvMediaFile> | null> {
  if (!UUID_RE.test(id)) return null;
  const file = await selectFile(db, actor.tenantId, id);
  if (!file || !mayReadFile(file, actor.principalId, actor.seesAll, actor.tenantId)) return null;
  return file;
}

/** The largest single file, `MAX_UPLOAD_BYTES` (default 50 MB). */
export const maxUploadBytes = (): number =>
  parseInt(process.env.MAX_UPLOAD_BYTES ?? '') || 50 * 1024 * 1024;

/**
 * Store `bytes` as a new file named `name`, recorded as `actor`'s, in its
 * tenant. Private (served only through a signed, expiring URL) unless
 * `isPublic`, which stores it under the public namespace with a bare URL.
 * `typeHint` is the client's content type, used only when neither the bytes
 * nor the extension say what the file is. `id` is the new row's, when the caller
 * must know it ahead (a job's put: its job id, ADR 0032).
 */
export async function storeFile(
  db: Database,
  actor: FileActor,
  input: {
    name: string;
    bytes: Uint8Array;
    folderId?: string | null;
    isPublic?: boolean;
    typeHint?: string;
    id?: string;
  },
): Promise<{ file: NonNullable<ZvMediaFile> } | FileRefusal> {
  const { name, folderId, isPublic = false } = input;
  const buffer = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
  const maxBytes = maxUploadBytes();
  if (buffer.length > maxBytes) {
    return {
      status: 413,
      body: {
        error: `File too large. Maximum allowed size is ${Math.round(maxBytes / 1024 / 1024)} MB.`,
      },
    };
  }

  // The cumulative quota, a different question from the size of one file.
  const quota = await checkStorageQuota(db, actor.tenantId, actor.author, buffer.length);
  if (!quota.ok) {
    return {
      status: 413,
      body: {
        error: 'Storage quota exceeded',
        used_bytes: quota.usedBytes,
        quota_bytes: quota.quotaBytes,
      },
    };
  }

  // Before anything is stored: a refused folder must not leave an object behind.
  if (folderId && !(await folderVisible(db, actor.tenantId, folderId))) {
    return { status: 404, body: { error: 'Folder not found' } };
  }

  const typeRefused = fileTypeRefusal(name);
  if (typeRefused) return typeRefused;
  const rawExt = extensionOf(name);

  // SVG sanitization — an SVG with embedded <script> or <foreignObject>
  // executes JavaScript when the browser renders it from our origin,
  // which is XSS. We strip script/handler nodes server-side before the
  // file is ever written to storage. Rejecting outright would break the
  // common "upload your company logo" path, so we sanitize instead.
  let safeBytes = buffer;
  let detectedMime: string | null = null;
  if (rawExt === 'svg') {
    try {
      const raw = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
      safeBytes = Buffer.from(sanitizeSvgString(raw), 'utf-8');
      detectedMime = 'image/svg+xml';
    } catch (err) {
      return { status: 400, body: { error: `SVG could not be parsed: ${(err as Error).message}` } };
    }
  }

  // Magic-bytes detection — the client's content type is trusted only as a
  // hint; the Content-Type we record comes from the file content so a renamed
  // `.png` can't be served as `text/html`.
  if (!detectedMime) {
    detectedMime =
      detectMimeFromMagic(buffer, rawExt) ?? input.typeHint ?? 'application/octet-stream';
  }

  const filename = `${crypto.randomUUID()}.${rawExt}`;
  const storagePath = `${isPublic ? 'public/' : ''}uploads/${new Date().getFullYear()}/${filename}`;

  const storage = getStorage();
  let url: string | undefined;
  if (storage.isConfigured()) {
    try {
      await storage.put(storagePath, safeBytes, { contentType: detectedMime });
    } catch (err) {
      // The driver's text names the store (endpoint, bucket); the caller gets none of it.
      console.error('storage: upload failed', storagePath, err);
      return { status: 502, body: { error: 'Storage upload failed' } };
    }
    // Public uploads get a bare URL; private ones a signed, expiring one. The
    // stored `storage_path` is the source of truth — callers refresh access via
    // GET /api/storage/:id/signed-url when a private link expires.
    url = isPublic
      ? storage.publicUrl(storagePath)
      : await storage.signedUrl(storagePath, 24 * 3600);
  }

  const dims = detectedMime.startsWith('image/')
    ? extractImageDimensions(safeBytes, detectedMime)
    : {};

  const insert = db
    .insertInto('zv_media_files')
    .values({
      ...(input.id ? { id: input.id } : {}),
      folder_id: folderId || null,
      filename,
      original_name: name,
      mimetype: detectedMime,
      size: safeBytes.length,
      storage_path: storagePath,
      url,
      width: dims.width,
      height: dims.height,
      created_by: actor.author,
      created_by_api_key: actor.apiKeyRow,
      tenant_id: actor.tenantId,
      // A public upload is served from a bare URL with no authentication at
      // all, so hiding it from a listing would be theatre — and it is what a
      // record's file/image field stores, since a private signed URL expires
      // in an hour. A private upload belongs to whoever made it.
      visibility: isPublic ? ('tenant' as const) : ('personal' as const),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  // A refused row must not leave its bytes behind, where nothing records them.
  const file = await insert.catch(async (err: unknown) => {
    if (storage.isConfigured()) {
      await storage
        .delete(storagePath)
        .catch((e) => console.error('storage: cleanup', storagePath, e));
    }
    throw err;
  });
  return { file };
}

/**
 * Delete file `id`: its uploader, or a tenant admin. A file the actor cannot
 * read is 404, as `readableFile` answers: a 403 would tell them it exists.
 *
 * The bytes go first: when that fails the row stays, as the only record that
 * would let anyone find the orphaned bytes, which the signed URL from upload
 * still serves.
 */
export async function removeFile(
  db: Database,
  actor: FileActor,
  id: string,
): Promise<{ ok: true } | FileRefusal> {
  const file = UUID_RE.test(id) ? await selectFile(db, actor.tenantId, id) : undefined;
  if (!file || !mayReadFile(file, actor.principalId, actor.seesAll, actor.tenantId)) {
    return { status: 404, body: { error: 'File not found' } };
  }
  if (!mayDeleteFile(file, actor.principalId, actor.seesAll, actor.tenantId)) {
    return { status: 403, body: { error: 'Forbidden' } };
  }
  const storage = getStorage();
  if (storage.isConfigured()) {
    try {
      await storage.delete(file.storage_path);
    } catch (err) {
      console.error('storage: delete failed', id, err);
      return { status: 500, body: { error: 'Failed to delete file from storage' } };
    }
  }
  await db
    .deleteFrom('zv_media_files')
    .where('id', '=', file.id)
    .where('tenant_id', '=', actor.tenantId)
    .execute();
  return { ok: true };
}
