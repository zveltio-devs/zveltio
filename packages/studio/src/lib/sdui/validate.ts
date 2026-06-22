/**
 * SDUI schema validation + version guard.
 *
 * The host renders extension-supplied schema. A malformed or future-version
 * schema must produce a friendly error panel, never a white screen or a
 * silently mis-rendered page. This is a focused structural check (not a full
 * type mirror) — it catches the shapes that would actually break the renderers.
 */
import { SDUI_SCHEMA_VERSION, type PageSchema, type SettingsSchema } from './types.js';

export type AnySchema = PageSchema | SettingsSchema;
export type Validated =
  | { ok: true; schema: AnySchema; kind: 'list' | 'settings' }
  | { ok: false; error: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validateSchema(input: unknown): Validated {
  if (!isObj(input)) return { ok: false, error: 'Schema is not an object.' };

  const version = typeof input.sduiSchema === 'number' ? input.sduiSchema : 1;
  if (version > SDUI_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `This page needs a newer Studio (schema v${version}; this host supports v${SDUI_SCHEMA_VERSION}). Update Zveltio.`,
    };
  }
  if (typeof input.title !== 'string' || !input.title) {
    return { ok: false, error: 'Schema is missing a "title".' };
  }

  // Settings archetype
  if (input.kind === 'settings') {
    if (typeof input.dataSource !== 'string' || typeof input.saveEndpoint !== 'string') {
      return { ok: false, error: 'Settings schema needs "dataSource" and "saveEndpoint".' };
    }
    return { ok: true, schema: input as unknown as SettingsSchema, kind: 'settings' };
  }

  // List + form archetype
  const resources = input.resources;
  if (!Array.isArray(resources) || resources.length === 0) {
    return { ok: false, error: 'Page schema needs a non-empty "resources" array.' };
  }
  for (const [i, r] of resources.entries()) {
    if (!isObj(r)) return { ok: false, error: `resources[${i}] is not an object.` };
    if (typeof r.id !== 'string') return { ok: false, error: `resources[${i}] is missing "id".` };
    if (typeof r.dataSource !== 'string') {
      return { ok: false, error: `resources[${i}] ("${String(r.id)}") is missing "dataSource".` };
    }
    if (!Array.isArray(r.columns)) {
      return { ok: false, error: `resources[${i}] ("${String(r.id)}") is missing "columns".` };
    }
  }
  return { ok: true, schema: input as unknown as PageSchema, kind: 'list' };
}
