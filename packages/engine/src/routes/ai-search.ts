import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { aiProviderManager } from '../lib/ai-provider.js';
import { checkPermission } from '../lib/permissions.js';

const searchSchema = z.object({
  query: z.string().min(1).max(1000),
  collection: z.string().optional(),
  limit: z.number().min(1).max(50).default(10),
  threshold: z.number().min(0).max(1).default(0.7),
  explain: z.boolean().default(false),
});

export function aiSearchRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', session.user);
    await next();
  });

  app.post('/', zValidator('json', searchSchema), async (c) => {
    const { query, collection, limit, threshold, explain } = c.req.valid('json');
    const user = c.get('user') as any;

    try {
      const provider = aiProviderManager.getDefault();
      if (!provider?.embed) {
        return c.json({ error: 'No AI provider with embedding support configured' }, 503);
      }

      // 1. Generate embedding from user query
      const { embedding: queryEmbedding } = await provider.embed(query);
      if (!queryEmbedding || queryEmbedding.length === 0) {
        return c.json({ error: 'Failed to generate query embedding' }, 500);
      }

      // 2. Check if pgvector extension is installed
      const pgvectorCheck = await sql<{ has_pgvector: boolean }>`
        SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'vector') AS has_pgvector
      `.execute(db);
      const hasPgvector = pgvectorCheck.rows[0]?.has_pgvector;

      let rows: any[] = [];

      if (hasPgvector) {
        // pgvector available — native cosine similarity search
        const vectorLiteral = `[${queryEmbedding.join(',')}]`;
        const result = await sql`
          SELECT
            collection,
            record_id,
            field,
            text_content,
            1 - (embedding <=> ${sql.raw(`'${vectorLiteral}'::vector`)}) AS similarity
          FROM zvd_ai_embeddings
          WHERE 1 - (embedding <=> ${sql.raw(`'${vectorLiteral}'::vector`)}) >= ${threshold}
          ${collection ? sql`AND collection = ${collection}` : sql``}
          ORDER BY similarity DESC
          LIMIT ${limit}
        `.execute(db);
        rows = result.rows as any[];
      } else {
        // Fallback: load all candidates and compute cosine similarity in JS
        const result = await sql`
          SELECT collection, record_id, field, text_content, embedding
          FROM zvd_ai_embeddings
          ${collection ? sql`WHERE collection = ${collection}` : sql``}
        `.execute(db);

        rows = (result.rows as any[])
          .map((row) => {
            const storedVec: number[] = Array.isArray(row.embedding)
              ? row.embedding
              : JSON.parse(row.embedding ?? '[]');
            return { ...row, similarity: cosineSimilarity(queryEmbedding, storedVec) };
          })
          .filter((r) => r.similarity >= threshold)
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, limit);
      }

      // 3. Apply Casbin — filter collections the user cannot read
      const filtered: any[] = [];
      for (const row of rows) {
        const canRead = await checkPermission(user.id, row.collection, 'read');
        if (canRead) filtered.push(row);
      }

      // 4. Optional: AI explains the results
      let explanation: string | null = null;
      if (explain && filtered.length > 0 && provider.chat) {
        const context = filtered
          .slice(0, 5)
          .map((r) => `[${r.collection}/${r.record_id}] ${String(r.text_content).substring(0, 200)}`)
          .join('\n');

        const chatResult = await provider.chat([
          {
            role: 'system',
            content:
              'You are a data analyst assistant. Summarize the search results concisely in relation to the user query. Be specific and actionable. Respond in the same language as the query.',
          },
          {
            role: 'user',
            content: `Query: "${query}"\n\nResults:\n${context}\n\nExplain these results briefly.`,
          },
        ]);
        explanation = chatResult.content ?? null;
      }

      return c.json({
        query,
        results: filtered.map((r) => ({
          collection: r.collection,
          recordId: r.record_id,
          field: r.field,
          content: r.text_content,
          similarity: Math.round(r.similarity * 1000) / 1000,
        })),
        explanation,
        total: filtered.length,
      });
    } catch (err: any) {
      console.error('AI Search error:', err);
      return c.json({ error: 'Search failed', details: err.message }, 500);
    }
  });

  return app;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
