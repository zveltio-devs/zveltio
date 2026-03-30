/**
 * AI Prompt-to-Backend (P5)
 *
 * POST /api/ai/preview-schema  — Generate schema preview (no DDL executed), returns confirm_token
 * POST /api/ai/generate-schema — Execute DDL; accepts confirm_token to skip re-generation
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { createHash } from 'node:crypto';
import type { Database } from '../db/index.js';
import { DDLManager } from '../lib/ddl-manager.js';
import { fieldTypeRegistry } from '../lib/field-type-registry.js';
import { enqueueDDLJob } from '../lib/ddl-queue.js';
import { aiProviderManager } from '../lib/ai-provider.js';
import { auth } from '../lib/auth.js';
import { checkPermission } from '../lib/permissions.js';

// In-memory preview cache: token → { schema, expiresAt }
const previewCache = new Map<string, { schema: any; expiresAt: number }>();
const PREVIEW_TTL_MS = 10 * 60 * 1000; // 10 minutes

function makeConfirmToken(schema: any): string {
  return createHash('sha256').update(JSON.stringify(schema)).digest('hex').slice(0, 32);
}

function cleanExpiredPreviews() {
  const now = Date.now();
  for (const [k, v] of previewCache) {
    if (v.expiresAt < now) previewCache.delete(k);
  }
}

const PreviewSchema = z.object({
  description: z.string().min(10).max(4000),
});

const GenerateSchema = z.object({
  description: z.string().min(10).max(4000).optional(),
  seed: z.boolean().optional().default(false),
  seed_count: z.number().int().min(1).max(50).optional().default(5),
  confirm_token: z.string().optional(),
});

const CollectionSpecSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  displayName: z.string().optional(),
  description: z.string().optional(),
  fields: z.array(
    z.object({
      name: z.string().regex(/^[a-z][a-z0-9_]*$/),
      type: z.string(),
      required: z.boolean().optional(),
      label: z.string().optional(),
    }),
  ),
});

const AISchemaResponseSchema = z.object({
  collections: z.array(CollectionSpecSchema),
  seed_data: z.record(z.string(), z.array(z.record(z.string(), z.any()))).optional(),
});

function buildSystemPrompt(availableTypes: string[]): string {
  return `You are a database schema designer for Zveltio, a Backend-as-a-Service platform.

When given a description of an application, generate a JSON schema with:
1. A list of collections (database tables) — names must be lowercase_snake_case
2. Fields for each collection with appropriate types
3. Optional: seed data examples

AVAILABLE FIELD TYPES: ${availableTypes.join(', ')}

NAMING RULES:
- Collection names: lowercase letters, numbers, underscores only (e.g. blog_posts, user_profiles)
- Field names: same rules as collection names
- Every collection automatically gets id, created_at, updated_at — DO NOT add these manually
- For text use: text, email, url, richtext, textarea, password, slug, color, phone
- For numbers: integer, float, number
- For dates: date, datetime
- For other: boolean, json, uuid, file, image, tags, enum

RESPONSE FORMAT (JSON only, no markdown):
{
  "collections": [
    {
      "name": "blog_posts",
      "displayName": "Blog Posts",
      "description": "...",
      "fields": [
        { "name": "title", "type": "text", "required": true, "label": "Title" },
        { "name": "content", "type": "richtext", "required": false, "label": "Content" },
        { "name": "status", "type": "enum", "required": true, "label": "Status" }
      ]
    }
  ],
  "seed_data": {
    "blog_posts": [
      { "title": "Hello World", "content": "<p>First post</p>", "status": "published" }
    ]
  }
}

Generate realistic, complete schemas. Keep to 2-6 collections unless the description demands more.`;
}

export function aiSchemaGenRoutes(db: Database, _appAuth: any): Hono {
  const router = new Hono();

  // Admin-only
  router.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    const isAdmin = await checkPermission(session.user.id, 'admin', '*');
    if (!isAdmin) return c.json({ error: 'Admin required' }, 403);
    c.set('user', { ...session.user, role: (session.user as any).role ?? 'admin' });
    await next();
  });

  // POST /preview-schema — generate schema preview without executing DDL
  router.post('/preview-schema', zValidator('json', PreviewSchema), async (c) => {
    const { description } = c.req.valid('json');

    const provider = aiProviderManager.getDefault();
    if (!provider) return c.json({ error: 'No AI provider configured.' }, 503);

    const availableTypes = fieldTypeRegistry.getAll().map((t) => t.type);
    const systemPrompt = buildSystemPrompt(availableTypes);

    let rawSchema: any;
    try {
      const result = await provider.chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Design a Zveltio schema for the following application:\n\n${description}` },
      ], { temperature: 0.3, max_tokens: 3000 });

      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('LLM did not return valid JSON');
      rawSchema = JSON.parse(jsonMatch[0]);
    } catch (err) {
      return c.json({ error: `AI generation failed: ${err instanceof Error ? err.message : String(err)}` }, 422);
    }

    const parsed = AISchemaResponseSchema.safeParse(rawSchema);
    if (!parsed.success) {
      return c.json({ error: 'AI returned invalid schema structure', details: parsed.error.flatten() }, 422);
    }

    const token = makeConfirmToken(parsed.data);
    cleanExpiredPreviews();
    previewCache.set(token, { schema: parsed.data, expiresAt: Date.now() + PREVIEW_TTL_MS });

    const totalFields = parsed.data.collections.reduce((acc, c) => acc + c.fields.length, 0);
    return c.json({
      preview: parsed.data,
      collections_count: parsed.data.collections.length,
      estimated_fields: totalFields,
      confirm_token: token,
    });
  });

  // POST /generate-schema — generate schema from natural language description
  router.post('/generate-schema', zValidator('json', GenerateSchema), async (c) => {
    const { description, seed, seed_count, confirm_token } = c.req.valid('json');

    // If confirm_token provided, use cached preview schema (skip LLM)
    const provider = aiProviderManager.getDefault();
    let rawSchema: any;
    if (confirm_token) {
      cleanExpiredPreviews();
      const cached = previewCache.get(confirm_token);
      if (!cached) return c.json({ error: 'Preview token expired or invalid. Please generate a new preview.' }, 422);
      rawSchema = cached.schema;
      previewCache.delete(confirm_token);
    } else {
      if (!description) return c.json({ error: 'description is required when not using confirm_token' }, 400);

      if (!provider) {
        return c.json({ error: 'No AI provider configured. Add one in Settings → AI.' }, 503);
      }

      const availableTypes = fieldTypeRegistry.getAll().map((t) => t.type);
      const systemPrompt = buildSystemPrompt(availableTypes);

      // Step 1: Generate schema from LLM
      try {
        const result = await provider.chat([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Design a Zveltio schema for the following application:\n\n${description}` },
        ], { temperature: 0.3, max_tokens: 3000 });

        const jsonMatch = result.content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('LLM did not return valid JSON');
        rawSchema = JSON.parse(jsonMatch[0]);
      } catch (err) {
        return c.json({ error: `AI generation failed: ${err instanceof Error ? err.message : String(err)}` }, 422);
      }
    }

    // Step 2: Validate schema structure
    const parsed = AISchemaResponseSchema.safeParse(rawSchema);
    if (!parsed.success) {
      return c.json({ error: 'AI returned invalid schema structure', details: parsed.error.flatten() }, 422);
    }

    const { collections: colSpecs, seed_data } = parsed.data;
    const jobIds: string[] = [];
    const created: string[] = [];
    const skipped: string[] = [];

    // Step 3: Enqueue DDL jobs for each collection
    for (const col of colSpecs) {
      // Filter out unknown field types
      const validFields = col.fields.filter((f) => {
        if (fieldTypeRegistry.has(f.type)) return true;
        console.warn(`[ai-schema-gen] Unknown field type "${f.type}" in collection "${col.name}" — skipping field`);
        return false;
      });

      if (validFields.length === 0) {
        // Add a minimal placeholder field
        validFields.push({ name: 'title', type: 'text', required: true });
      }

      try {
        // Check if collection already exists
        const exists = await DDLManager.tableExists(db, col.name);
        if (exists) {
          skipped.push(col.name);
          continue;
        }

        const jobId = await enqueueDDLJob(db, 'create_collection', {
          name: col.name,
          displayName: col.displayName || col.name,
          description: col.description,
          fields: validFields,
        });
        jobIds.push(jobId);
        created.push(col.name);
      } catch (err) {
        console.error(`[ai-schema-gen] Failed to enqueue collection "${col.name}":`, err);
        skipped.push(col.name);
      }
    }

    // Step 4: If seed requested, generate seed data via LLM
    let seedRecords: Record<string, any[]> = seed_data || {};
    if (seed && created.length > 0 && !seed_data) {
      try {
        const seedPrompt = `Generate ${seed_count} realistic sample records for each of these collections in JSON format (no markdown):
${created.map((name) => {
  const col = colSpecs.find((c) => c.name === name);
  return `${name}: fields = ${col?.fields.map((f) => `${f.name}(${f.type})`).join(', ')}`;
}).join('\n')}

Response format:
{"collection_name": [{"field": "value", ...}, ...]}`;

        const seedResult = await provider!.chat([
          { role: 'system', content: 'You generate realistic sample data for database tables. Return only JSON.' },
          { role: 'user', content: seedPrompt },
        ], { temperature: 0.7, max_tokens: 2000 });

        const seedJson = seedResult.content.match(/\{[\s\S]*\}/)?.[0];
        if (seedJson) seedRecords = JSON.parse(seedJson);
      } catch {
        // Non-fatal: schema was created, seed data just wasn't generated
      }
    }

    return c.json({
      success: true,
      collections: created,
      skipped,
      job_ids: jobIds,
      seed_data: seedRecords,
      message: `Created ${created.length} collection(s)${skipped.length > 0 ? `, skipped ${skipped.length} (already exist)` : ''}.`,
    });
  });

  // GET /generate-schema/field-types — return available types for the frontend
  router.get('/generate-schema/field-types', (c) => {
    const types = fieldTypeRegistry.getAll().map((t) => ({
      type: t.type,
      label: t.label,
      category: t.category,
    }));
    return c.json({ field_types: types });
  });

  return router;
}
