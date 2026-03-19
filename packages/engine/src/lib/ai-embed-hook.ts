/**
 * AI Embed Hook — auto-generare embeddings la create/update.
 *
 * Apelat non-blocking din data.ts după fiecare scriere.
 * Dacă colecția are `ai_search_enabled = true`, generează embedding
 * și îl upsertează în zvd_ai_embeddings.
 */

import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { aiProviderManager } from './ai-provider.js';

const SYSTEM_FIELDS = new Set([
  'id', 'created_at', 'updated_at', 'created_by', 'updated_by',
  '_deletedAt', 'deleted_at',
]);

/**
 * Extrage textul de embedduit dintr-un record.
 *
 * @param record          - datele înregistrării
 * @param field           - câmpul specific de embedduit (dacă e configurat)
 * @param excludedFields  - câmpuri excluse explicit (PII: cnp, salary, iban…)
 */
function extractText(
  record: Record<string, any>,
  field: string | null,
  excludedFields: Set<string>,
): string {
  if (field && record[field] != null) {
    // Single-field mode — exclusions don't apply (field was chosen explicitly)
    return String(record[field]);
  }
  // Full-record mode: concat all non-system, non-excluded string fields
  return Object.entries(record)
    .filter(([k, v]) =>
      !SYSTEM_FIELDS.has(k) &&
      !excludedFields.has(k) &&
      typeof v === 'string' &&
      v.length > 0,
    )
    .map(([, v]) => v)
    .join(' ');
}

/**
 * Triggerează generarea embedding-ului pentru un record.
 * Non-blocking — eșecul nu afectează operația principală.
 */
export async function triggerEmbedding(
  db: Database,
  collection: string,
  recordId: string,
  record: Record<string, any>,
): Promise<void> {
  // Verificăm dacă AI Search e activat pe colecție
  const collMeta = await (db as any)
    .selectFrom('zvd_collections')
    .select(['ai_search_enabled', 'ai_search_field', 'ai_embed_excluded_fields'])
    .where('name', '=', collection)
    .executeTakeFirst()
    .catch(() => null);

  if (!collMeta?.ai_search_enabled) return;

  const textField: string | null = collMeta.ai_search_field ?? null;
  // ai_embed_excluded_fields is TEXT[] from Postgres — may arrive as array or JSON string
  const rawExcluded: string[] = Array.isArray(collMeta.ai_embed_excluded_fields)
    ? collMeta.ai_embed_excluded_fields
    : [];
  const excludedFields = new Set<string>(rawExcluded);

  const rawText = extractText(record, textField, excludedFields);
  if (!rawText.trim()) return;

  const provider = aiProviderManager.getDefault();
  if (!provider?.embed) return;

  const textToEmbed = rawText.slice(0, 8000); // Truncate — majoritatea modelelor au limita de tokeni
  const { embedding, model } = await provider.embed(textToEmbed);
  const vectorLiteral = JSON.stringify(embedding);

  await sql`
    INSERT INTO zvd_ai_embeddings
      (collection, record_id, field, text_content, embedding, model, updated_at)
    VALUES (
      ${collection},
      ${recordId},
      ${textField ?? '_auto'},
      ${rawText.slice(0, 2000)},
      ${vectorLiteral}::vector,
      ${model},
      NOW()
    )
    ON CONFLICT (collection, record_id, field)
    DO UPDATE SET
      text_content = EXCLUDED.text_content,
      embedding    = EXCLUDED.embedding,
      model        = EXCLUDED.model,
      updated_at   = NOW()
  `.execute(db);
}
