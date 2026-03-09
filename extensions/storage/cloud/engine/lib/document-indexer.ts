import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { aiProviderManager } from '../ai-provider.js';

const INDEXABLE_MIMES = [
  'text/plain', 'text/markdown', 'text/csv', 'text/html',
  'application/json', 'application/xml',
  'application/pdf',
];

/**
 * Indexes the content of an uploaded file.
 * Fire-and-forget — called async after upload.
 * Stores embedding in zvd_ai_embeddings with collection='_media'.
 */
export async function indexFileContent(
  db: Database,
  fileId: string,
  content: string,
): Promise<void> {
  if (!content.trim()) return;

  const provider = aiProviderManager.getDefault();
  if (!provider?.embed) return;

  try {
    const textToEmbed = content.slice(0, 8000);
    const { embedding, model } = await provider.embed(textToEmbed);

    await sql`
      INSERT INTO zvd_ai_embeddings
        (collection, record_id, field, text_content, embedding, model, updated_at)
      VALUES (
        '_media',
        ${fileId},
        'content',
        ${textToEmbed.slice(0, 2000)},
        ${JSON.stringify(embedding)}::vector,
        ${model},
        NOW()
      )
      ON CONFLICT (collection, record_id, field)
      DO UPDATE SET
        text_content = EXCLUDED.text_content,
        embedding = EXCLUDED.embedding,
        model = EXCLUDED.model,
        updated_at = NOW()
    `.execute(db);
  } catch (err) {
    console.error(`Cloud indexing failed [${fileId}]:`, err);
  }
}

/**
 * Extracts text from uploaded files.
 * Supports: text/*, JSON, CSV.
 * PDF requires pdf-parse (optional).
 */
export async function extractTextFromFile(
  buffer: Buffer,
  mimeType: string,
): Promise<string | null> {
  if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') {
    return buffer.toString('utf-8');
  }

  if (mimeType === 'application/pdf') {
    try {
      const pdfParse = await import('pdf-parse').catch(() => null);
      if (pdfParse) {
        const data = await pdfParse.default(buffer);
        return data.text;
      }
    } catch {
      console.warn('PDF text extraction failed — install pdf-parse for PDF indexing');
    }
  }

  return null;
}

/**
 * Indexing hook: called from media upload route.
 */
export async function scheduleFileIndexing(
  db: Database,
  fileId: string,
  buffer: Buffer,
  mimeType: string,
): Promise<void> {
  if (!INDEXABLE_MIMES.some(m => mimeType.startsWith(m.split('/')[0]) || mimeType === m)) return;

  extractTextFromFile(buffer, mimeType).then(async (text) => {
    if (text) await indexFileContent(db, fileId, text);
  }).catch(err => {
    console.error(`File indexing schedule failed [${fileId}]:`, err);
  });
}
