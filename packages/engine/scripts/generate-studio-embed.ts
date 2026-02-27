// Rulat înainte de bun build --compile
// Transformă toate fișierele din studio-dist/ într-un obiect TypeScript embedded în binar

import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { join, relative } from 'path';
import { existsSync } from 'fs';

const STUDIO_DIST = join(import.meta.dir, '../src/studio-dist');
const OUTPUT_FILE = join(import.meta.dir, '../src/studio-embed/index.ts');

const BINARY_EXTENSIONS = new Set([
  '.woff', '.woff2', '.ttf', '.eot',
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp',
]);

async function generateEmbed() {
  if (!existsSync(STUDIO_DIST)) {
    console.error('❌ studio-dist/ not found. Run: cd ../studio && bun run build first.');
    process.exit(1);
  }

  const files: Record<string, string> = {};

  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        const key = '/' + relative(STUDIO_DIST, fullPath).replace(/\\/g, '/');
        const ext = entry.name.substring(entry.name.lastIndexOf('.')).toLowerCase();
        const isBinary = BINARY_EXTENSIONS.has(ext);
        const content = await readFile(fullPath);
        files[key] = isBinary ? content.toString('base64') : content.toString('utf-8');
      }
    }
  }

  await walk(STUDIO_DIST);
  await mkdir(join(OUTPUT_FILE, '..'), { recursive: true });

  const fileCount = Object.keys(files).length;

  const output = `// AUTO-GENERATED — nu edita manual
// Generat de scripts/generate-studio-embed.ts
// ${fileCount} fișiere embedded

const BINARY_EXTENSIONS = new Set(['.woff', '.woff2', '.ttf', '.eot', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp']);

const studioFiles: Record<string, string> = ${JSON.stringify(files, null, 2)};

export function getStudioFile(path: string): { content: string | Uint8Array; isBinary: boolean } | null {
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
`;

  await writeFile(OUTPUT_FILE, output, 'utf-8');
  console.log(`✅ Studio embed generat: ${fileCount} fișiere → ${OUTPUT_FILE}`);
}

await generateEmbed();
