import { writeFile } from 'fs/promises';

export async function generateTypesCommand(
  collection: string | undefined,
  opts: { output?: string; url?: string },
) {
  const engineUrl = opts.url || process.env.ZVELTIO_URL || 'http://localhost:3000';
  const outputPath = opts.output || './zveltio.d.ts';

  console.log(`\n📝 Generating TypeScript types from ${engineUrl}...\n`);

  try {
    const path = collection
      ? `/api/admin/types/${collection}`
      : `/api/admin/types`;

    const res = await fetch(`${engineUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${process.env.ZVELTIO_API_KEY || ''}`,
      },
    });

    if (!res.ok) {
      console.error(`❌ Failed to fetch types: ${res.status} ${res.statusText}`);
      process.exit(1);
    }

    const types = await res.text();
    await writeFile(outputPath, types, 'utf-8');

    console.log(`✅ Types generated: ${outputPath}`);
    if (collection) {
      console.log(`   Collection: ${collection}`);
    }
  } catch (err) {
    console.error('❌ Failed to generate types:', err);
    process.exit(1);
  }
}
