import { mkdirSync } from 'fs';
import { dirname } from 'path';

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const c = {
  bold:  (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan:  (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim:   (s: string) => `\x1b[2m${s}\x1b[0m`,
  red:   (s: string) => `\x1b[31m${s}\x1b[0m`,
};

export async function generateTypesCommand(
  collection: string | undefined,
  opts: { output?: string; url?: string },
) {
  const engineUrl = opts.url || process.env.ZVELTIO_URL || 'http://localhost:3000';
  // Default output: ./types/zveltio.d.ts  (spec requirement)
  const outputPath = opts.output || './types/zveltio.d.ts';

  console.log(`\n${c.bold('Generate Types')}\n`);
  console.log(`  Engine: ${c.dim(engineUrl)}`);
  console.log(`  Output: ${c.dim(outputPath)}`);
  if (collection) {
    console.log(`  Collection: ${c.dim(collection)}`);
  }
  console.log('');

  try {
    const path = collection
      ? `/api/admin/types/${encodeURIComponent(collection)}`
      : `/api/admin/types`;

    const res = await fetch(`${engineUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${process.env.ZVELTIO_API_KEY || ''}`,
      },
    });

    if (!res.ok) {
      console.error(c.red(`Failed to fetch types: ${res.status} ${res.statusText}`));
      if (res.status === 401) {
        console.error(c.dim('  Set ZVELTIO_API_KEY env var or use an authenticated session.'));
      } else if (res.status === 404) {
        console.error(c.dim('  Ensure the engine is running and the /api/admin/types endpoint is available.'));
      }
      process.exit(1);
    }

    const types = await res.text();

    // Create output directory if needed (using Bun.write creates it automatically,
    // but we also need to handle the mkdirSync for the parent).
    const dir = dirname(outputPath);
    if (dir && dir !== '.') {
      mkdirSync(dir, { recursive: true });
    }

    await Bun.write(outputPath, types);

    console.log(`${c.green('Types generated:')} ${outputPath}`);
    if (!collection) {
      // Count approximate type declarations
      const typeCount = (types.match(/^export (interface|type) /gm) || []).length;
      if (typeCount > 0) {
        console.log(c.dim(`  ${typeCount} type declaration(s) written`));
      }
    }
    console.log('');
  } catch (err: any) {
    console.error(c.red(`Failed to generate types: ${err.message}`));
    process.exit(1);
  }
}
