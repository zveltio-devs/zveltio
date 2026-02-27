import type { FieldTypeRegistry } from '../lib/field-type-registry.js';

export function registerCoreFieldTypes(registry: FieldTypeRegistry): void {
  registry.register({
    type: 'text',
    label: 'Text',
    category: 'text',
    db: { columnType: 'text' },
    api: {
      filterOperators: ['eq', 'neq', 'contains', 'not_contains', 'starts_with', 'ends_with', 'is_null', 'is_not_null'],
      validate: (v, f) => {
        if (f.required && (!v || (typeof v === 'string' && v.trim() === ''))) {
          return `${f.label || f.name} is required`;
        }
        return null;
      },
    },
    typescript: { inputType: 'string', outputType: 'string' },
  });

  registry.register({
    type: 'number',
    label: 'Number',
    category: 'number',
    db: { columnType: 'numeric' },
    api: {
      filterOperators: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in', 'not_in', 'is_null', 'is_not_null'],
      deserialize: (v) => (v === '' || v === null || v === undefined ? null : Number(v)),
      validate: (v) => {
        if (v !== null && v !== undefined && v !== '' && isNaN(Number(v))) return 'Must be a number';
        return null;
      },
    },
    typescript: { inputType: 'number', outputType: 'number' },
  });

  registry.register({
    type: 'boolean',
    label: 'Boolean',
    category: 'special',
    db: { columnType: 'boolean', defaultValue: 'false' },
    api: {
      filterOperators: ['eq'],
      deserialize: (v) => v === true || v === 'true' || v === 1,
    },
    typescript: { inputType: 'boolean', outputType: 'boolean' },
  });

  registry.register({
    type: 'date',
    label: 'Date',
    category: 'date',
    db: { columnType: 'date' },
    api: {
      filterOperators: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'is_null', 'is_not_null'],
    },
    typescript: { inputType: 'string', outputType: 'string' },
  });

  registry.register({
    type: 'datetime',
    label: 'DateTime',
    category: 'date',
    db: { columnType: 'timestamptz' },
    api: {
      filterOperators: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'is_null', 'is_not_null'],
    },
    typescript: { inputType: 'string', outputType: 'string' },
  });

  registry.register({
    type: 'email',
    label: 'Email',
    category: 'text',
    db: { columnType: 'text' },
    api: {
      filterOperators: ['eq', 'neq', 'contains', 'is_null', 'is_not_null'],
      validate: (v) => {
        if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'Invalid email address';
        return null;
      },
    },
    typescript: { inputType: 'string', outputType: 'string' },
  });

  registry.register({
    type: 'url',
    label: 'URL',
    category: 'text',
    db: { columnType: 'text' },
    api: {
      filterOperators: ['eq', 'neq', 'contains', 'is_null', 'is_not_null'],
      validate: (v) => {
        if (v) {
          try { new URL(v); } catch { return 'Invalid URL'; }
        }
        return null;
      },
    },
    typescript: { inputType: 'string', outputType: 'string' },
  });

  registry.register({
    type: 'uuid',
    label: 'UUID',
    category: 'special',
    db: { columnType: 'uuid', defaultValue: 'gen_random_uuid()' },
    api: {
      filterOperators: ['eq', 'neq', 'in', 'not_in', 'is_null', 'is_not_null'],
    },
    typescript: { inputType: 'string', outputType: 'string' },
  });

  registry.register({
    type: 'json',
    label: 'JSON',
    category: 'special',
    db: { columnType: 'jsonb' },
    api: {
      serialize: (v) => (typeof v === 'string' ? JSON.parse(v) : v),
      deserialize: (v) => (typeof v === 'object' ? JSON.stringify(v) : v),
      filterOperators: ['is_null', 'is_not_null'],
    },
    typescript: { inputType: 'Record<string, any>', outputType: 'Record<string, any>' },
  });

  registry.register({
    type: 'richtext',
    label: 'Rich Text',
    category: 'text',
    db: { columnType: 'text' },
    api: {
      filterOperators: ['contains', 'is_null', 'is_not_null'],
    },
    typescript: { inputType: 'string', outputType: 'string' },
  });

  registry.register({
    type: 'file',
    label: 'File',
    category: 'media',
    db: { columnType: 'jsonb' },
    api: {
      serialize: (v) => (typeof v === 'string' ? JSON.parse(v) : v),
      filterOperators: ['is_null', 'is_not_null'],
    },
    typescript: {
      inputType: '{ url: string; name: string; size: number; type: string }',
      outputType: '{ url: string; name: string; size: number; type: string }',
    },
  });

  registry.register({
    type: 'enum',
    label: 'Enum / Select',
    category: 'special',
    db: { columnType: 'text' },
    api: {
      filterOperators: ['eq', 'neq', 'in', 'not_in', 'is_null', 'is_not_null'],
      validate: (v, f) => {
        const allowed: string[] = f.options?.values || [];
        if (v && allowed.length > 0 && !allowed.includes(v)) {
          return `Invalid value. Allowed: ${allowed.join(', ')}`;
        }
        return null;
      },
    },
    typescript: { inputType: 'string', outputType: 'string' },
  });

  registry.register({
    type: 'reference',
    label: 'Reference (Many to One)',
    category: 'relation',
    db: { columnType: 'uuid' },
    api: {
      filterOperators: ['eq', 'neq', 'in', 'not_in', 'is_null', 'is_not_null'],
    },
    typescript: { inputType: 'string', outputType: 'string' },
  });

  registry.register({
    type: 'm2o',
    label: 'Many to One',
    category: 'relation',
    db: { columnType: 'uuid' },
    api: {
      filterOperators: ['eq', 'neq', 'in', 'not_in', 'is_null', 'is_not_null'],
    },
    typescript: { inputType: 'string', outputType: 'string' },
  });

  registry.register({
    type: 'location',
    label: 'Location (Point)',
    category: 'location',
    db: {
      columnType: 'GEOGRAPHY(POINT, 4326)',
      indexType: 'gist',
      requiresExtensions: ['postgis'],
    },
    api: {
      serialize: (v) => {
        if (!v) return null;
        // PostGIS returns WKB hex — parse to {lat, lng}
        // In practice the data.ts route handles this specially
        return v;
      },
      filterOperators: ['near', 'within', 'is_null', 'is_not_null'],
    },
    typescript: {
      inputType: '{ lat: number; lng: number }',
      outputType: '{ lat: number; lng: number }',
    },
  });

  registry.register({
    type: 'computed',
    label: 'Computed Field',
    category: 'special',
    db: { columnType: 'text', virtual: true },
    api: { filterOperators: [] },
    typescript: { inputType: 'never', outputType: 'any' },
  });

  // ── Number types ─────────────────────────────────────────────

  registry.register({
    type: 'integer',
    label: 'Integer',
    category: 'number',
    db: { columnType: 'bigint' },
    api: {
      filterOperators: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in', 'not_in', 'is_null', 'is_not_null'],
      deserialize: (v) => (v === '' || v === null || v === undefined ? null : Math.trunc(Number(v))),
      validate: (v) => {
        if (v !== null && v !== undefined && v !== '' && (!Number.isInteger(Number(v)) || isNaN(Number(v)))) {
          return 'Must be an integer';
        }
        return null;
      },
    },
    typescript: { inputType: 'number', outputType: 'number' },
  });

  registry.register({
    type: 'float',
    label: 'Float',
    category: 'number',
    db: { columnType: 'double precision' },
    api: {
      filterOperators: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'is_null', 'is_not_null'],
      deserialize: (v) => (v === '' || v === null || v === undefined ? null : parseFloat(v)),
      validate: (v) => {
        if (v !== null && v !== undefined && v !== '' && isNaN(parseFloat(v))) return 'Must be a number';
        return null;
      },
    },
    typescript: { inputType: 'number', outputType: 'number' },
  });

  // ── Text variants ─────────────────────────────────────────────

  registry.register({
    type: 'textarea',
    label: 'Textarea',
    category: 'text',
    db: { columnType: 'text' },
    api: {
      filterOperators: ['contains', 'not_contains', 'is_null', 'is_not_null'],
    },
    typescript: { inputType: 'string', outputType: 'string' },
  });

  registry.register({
    type: 'password',
    label: 'Password',
    description: 'Stored as bcrypt hash. Never returned in API responses.',
    category: 'text',
    db: { columnType: 'text' },
    api: {
      filterOperators: [],
      serialize: () => undefined, // never expose password hash
      deserialize: async (v: string) => {
        if (!v || v.startsWith('$2')) return v; // already hashed
        try {
          return await (globalThis as any).Bun?.password?.hash(v) ?? v;
        } catch {
          return v;
        }
      },
      validate: (v, f) => {
        if (f.required && !v) return `${f.label || f.name} is required`;
        if (v && typeof v === 'string' && !v.startsWith('$2') && v.length < 8) {
          return 'Password must be at least 8 characters';
        }
        return null;
      },
    },
    typescript: { inputType: 'string', outputType: 'undefined' },
  });

  registry.register({
    type: 'slug',
    label: 'Slug',
    description: 'URL-safe identifier, auto-generated from a source field',
    category: 'text',
    db: { columnType: 'text', indexType: 'btree' },
    api: {
      filterOperators: ['eq', 'neq', 'contains', 'starts_with', 'is_null', 'is_not_null'],
      deserialize: (v: string) => {
        if (!v) return v;
        return v
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');
      },
    },
    typescript: { inputType: 'string', outputType: 'string' },
  });

  registry.register({
    type: 'color',
    label: 'Color',
    description: 'Hex color value (e.g. #FF5733)',
    category: 'special',
    db: { columnType: 'text' },
    api: {
      filterOperators: ['eq', 'neq', 'is_null', 'is_not_null'],
      validate: (v) => {
        if (v && !/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(v)) {
          return 'Must be a valid hex color (e.g. #FF5733)';
        }
        return null;
      },
    },
    typescript: { inputType: 'string', outputType: 'string' },
  });

  registry.register({
    type: 'phone',
    label: 'Phone',
    category: 'text',
    db: { columnType: 'text' },
    api: {
      filterOperators: ['eq', 'neq', 'contains', 'is_null', 'is_not_null'],
      validate: (v) => {
        if (v && !/^\+?[\d\s\-().]{7,20}$/.test(v)) return 'Invalid phone number';
        return null;
      },
    },
    typescript: { inputType: 'string', outputType: 'string' },
  });

  registry.register({
    type: 'tags',
    label: 'Tags',
    description: 'Array of text tags',
    category: 'special',
    db: { columnType: 'text[]', defaultValue: "'{}'" },
    api: {
      filterOperators: ['contains', 'is_null', 'is_not_null'],
      serialize: (v) => (Array.isArray(v) ? v : typeof v === 'string' ? JSON.parse(v) : []),
      deserialize: (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',').map((s: string) => s.trim()) : []),
    },
    typescript: { inputType: 'string[]', outputType: 'string[]' },
  });

  // ── Media ─────────────────────────────────────────────────────

  registry.register({
    type: 'image',
    label: 'Image',
    description: 'Image file reference with metadata',
    category: 'media',
    db: { columnType: 'jsonb' },
    api: {
      serialize: (v) => (typeof v === 'string' ? JSON.parse(v) : v),
      filterOperators: ['is_null', 'is_not_null'],
    },
    typescript: {
      inputType: '{ url: string; name: string; size: number; width?: number; height?: number; alt?: string }',
      outputType: '{ url: string; name: string; size: number; width?: number; height?: number; alt?: string }',
    },
  });

  // ── Relation types (virtual — no DB column) ───────────────────

  registry.register({
    type: 'o2m',
    label: 'One to Many',
    description: 'Reverse side of an m2o relation. No DB column — resolved via relation definition.',
    category: 'relation',
    db: { columnType: 'text', virtual: true },
    api: { filterOperators: [] },
    typescript: { inputType: 'string[]', outputType: 'any[]' },
  });

  registry.register({
    type: 'm2m',
    label: 'Many to Many',
    description: 'Junction table relation. No DB column on source table.',
    category: 'relation',
    db: { columnType: 'text', virtual: true },
    api: { filterOperators: [] },
    typescript: { inputType: 'string[]', outputType: 'any[]' },
  });

  registry.register({
    type: 'm2a',
    label: 'Many to Any',
    description: 'Polymorphic relation — references records from any collection.',
    category: 'relation',
    db: { columnType: 'text', virtual: true },
    api: { filterOperators: [] },
    typescript: { inputType: '{ collection: string; id: string }[]', outputType: '{ collection: string; id: string; record: any }[]' },
  });

  // ── Geospatial (requires PostGIS) ─────────────────────────────

  registry.register({
    type: 'geometry',
    label: 'Geometry',
    description: 'Arbitrary geometry (requires PostGIS). Stored as GEOMETRY type.',
    category: 'location',
    db: {
      columnType: 'GEOMETRY',
      indexType: 'gist',
      requiresExtensions: ['postgis'],
    },
    api: {
      filterOperators: ['near', 'within', 'intersects', 'is_null', 'is_not_null'],
    },
    typescript: {
      inputType: '{ type: string; coordinates: any }',
      outputType: '{ type: string; coordinates: any }',
    },
  });

  // ── AI / Vector (requires pgvector) ──────────────────────────

  registry.register({
    type: 'vector',
    label: 'Vector Embedding',
    description: 'Fixed-dimension float vector for semantic search (requires pgvector).',
    category: 'special',
    db: {
      columnType: 'vector(1536)',
      requiresExtensions: ['vector'],
    },
    api: {
      filterOperators: ['is_null', 'is_not_null'],
      serialize: (v) => (Array.isArray(v) ? v : typeof v === 'string' ? JSON.parse(v) : v),
      deserialize: (v) => (Array.isArray(v) ? `[${v.join(',')}]` : v),
    },
    typescript: { inputType: 'number[]', outputType: 'number[]' },
  });
}
