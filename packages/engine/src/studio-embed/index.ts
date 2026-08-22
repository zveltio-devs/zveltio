// AUTO-GENERATED stub — scripts/generate-studio-embed.ts overwrites this when
// `src/studio-dist/` exists (binary builds). The committed copy is always empty
// so the module resolves for typecheck and `bun --compile` without embedding
// the Studio UI into git. Do not commit a regenerated full embed (CI rejects
// files over ~50KB via check:studio-embed).

const BINARY_EXTENSIONS = new Set([
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.webp',
]);

const studioFiles: Record<string, string> = {};

export function getStudioFile(
  path: string,
): { content: string | Uint8Array; isBinary: boolean } | null {
  const file = studioFiles[path];
  if (!file) return null;

  const ext = path.includes('.') ? path.substring(path.lastIndexOf('.')).toLowerCase() : '';
  const isBinary = BINARY_EXTENSIONS.has(ext);

  if (isBinary) {
    const bytes = Buffer.from(file, 'base64');
    return { content: new Uint8Array(bytes), isBinary: true };
  }

  return { content: file, isBinary: false };
}

export function studioFileExists(path: string): boolean {
  return path in studioFiles;
}

/** True when generate-studio-embed inlined a real Studio build. */
export function studioEmbedActive(): boolean {
  return Object.keys(studioFiles).length > 0;
}
