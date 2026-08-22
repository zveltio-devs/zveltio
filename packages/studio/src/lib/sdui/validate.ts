/**
 * SDUI schema validation + version guard.
 *
 * The host renders extension-supplied schema. A malformed or future-version
 * schema must produce a friendly error panel, never a white screen or a
 * silently mis-rendered page. This is a focused structural check (not a full
 * type mirror) — it catches the shapes that would actually break the renderers.
 *
 * `sduiSchema` is the versioned field (source of truth). `sduiSchemaVersion` is
 * accepted as a deprecated alias and normalized onto `sduiSchema`.
 */
import { SDUI_SCHEMA_VERSION, type PageSchema, type SettingsSchema } from './types.js';

export type AnySchema = PageSchema | SettingsSchema;
export type Validated =
  | { ok: true; schema: AnySchema; kind: 'list' | 'settings' }
  | { ok: false; error: string };

const COLUMN_TYPES = new Set([
  'text',
  'mono',
  'date',
  'currency',
  'badge',
  'relation',
  'boolean',
  'tags',
  'link',
]);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Normalize deprecated `sduiSchemaVersion` onto `sduiSchema`. */
export function normalizeSduiVersion(input: Record<string, unknown>): number {
  if (typeof input.sduiSchema === 'number') return input.sduiSchema;
  if (typeof input.sduiSchemaVersion === 'number') {
    input.sduiSchema = input.sduiSchemaVersion;
    return input.sduiSchemaVersion;
  }
  return 1;
}

function validateColumns(resourceId: string, columns: unknown): string | null {
  if (!Array.isArray(columns)) {
    return `resources ("${resourceId}") is missing "columns".`;
  }
  for (const [ci, col] of columns.entries()) {
    if (!isObj(col)) return `resources ("${resourceId}") columns[${ci}] is not an object.`;
    if (typeof col.key !== 'string') {
      return `resources ("${resourceId}") columns[${ci}] needs "key".`;
    }
    if (col.type != null && (typeof col.type !== 'string' || !COLUMN_TYPES.has(col.type))) {
      return `resources ("${resourceId}") columns[${ci}] unknown type "${String(col.type)}".`;
    }
  }
  return null;
}

function validateBulk(resourceId: string, r: Record<string, unknown>): string | null {
  if (r.selectable != null && typeof r.selectable !== 'boolean') {
    return `resources ("${resourceId}") "selectable" must be a boolean.`;
  }
  if (r.bulkActions != null) {
    if (!Array.isArray(r.bulkActions)) {
      return `resources ("${resourceId}") "bulkActions" must be an array.`;
    }
    if (r.selectable !== true) {
      return `resources ("${resourceId}") "bulkActions" requires "selectable": true.`;
    }
    for (const [ai, a] of r.bulkActions.entries()) {
      if (!isObj(a) || typeof a.id !== 'string') {
        return `resources ("${resourceId}") bulkActions[${ai}] needs "id".`;
      }
    }
  }
  return null;
}

export function validateSchema(input: unknown): Validated {
  if (!isObj(input)) return { ok: false, error: 'Schema is not an object.' };

  const version = normalizeSduiVersion(input);
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
    const rid = String(r.id);

    const bulkErr = validateBulk(rid, r);
    if (bulkErr) return { ok: false, error: bulkErr };

    const isChecklist = r.layout === 'checklist' && isObj(r.checklist);
    if (isChecklist) {
      const cl = r.checklist as Record<string, unknown>;
      if (
        typeof cl.catalogDataSource !== 'string' ||
        typeof cl.loadEndpoint !== 'string' ||
        typeof cl.saveEndpoint !== 'string'
      ) {
        return {
          ok: false,
          error: `resources[${i}] ("${rid}") checklist needs catalogDataSource, loadEndpoint, saveEndpoint.`,
        };
      }
      continue;
    }
    const isBuilder = r.layout === 'builder' && isObj(r.builder);
    if (isBuilder) {
      const b = r.builder as Record<string, unknown>;
      if (typeof b.loadEndpoint !== 'string' || typeof b.saveEndpoint !== 'string') {
        return {
          ok: false,
          error: `resources[${i}] ("${rid}") builder needs loadEndpoint and saveEndpoint.`,
        };
      }
      if (!isObj(b.collection) || typeof (b.collection as { key?: unknown }).key !== 'string') {
        return {
          ok: false,
          error: `resources[${i}] ("${rid}") builder needs collection.key.`,
        };
      }
      continue;
    }
    const isDetail = r.layout === 'detail' && isObj(r.detail);
    if (isDetail) {
      const dtl = r.detail as Record<string, unknown>;
      if (
        typeof dtl.loadEndpoint !== 'string' ||
        !Array.isArray(dtl.panels) ||
        dtl.panels.length === 0
      ) {
        return {
          ok: false,
          error: `resources[${i}] ("${rid}") detail needs loadEndpoint and panels[].`,
        };
      }
      continue;
    }
    if (typeof r.dataSource !== 'string') {
      return { ok: false, error: `resources[${i}] ("${rid}") is missing "dataSource".` };
    }
    const colErr = validateColumns(rid, r.columns);
    if (colErr) return { ok: false, error: colErr };
  }
  return { ok: true, schema: input as unknown as PageSchema, kind: 'list' };
}
