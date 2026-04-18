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
    // No default: primary `id` is added as a hardcoded column in DDLManager.
    // Setting gen_random_uuid() here would leak into FK columns (organization_id, contact_id, …)
    // and replace a legitimate NULL FK with a random UUID on INSERT, breaking referential integrity.
    db: { columnType: 'uuid' },
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
    // getColumnDDL wraps string defaults in quotes, so {} (not '{}') yields DEFAULT '{}'.
    // The previous "'{}'" produced DEFAULT ''{}'' — a syntax error that silently aborted
    // every CREATE TABLE whose schema used `tags`, including contacts and organizations.
    db: { columnType: 'text[]', defaultValue: '{}' },
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

  // ── Additional Number types ───────────────────────────────────

  registry.register({
    type: 'smallint',
    label: 'Small Integer',
    description: '2-byte integer (-32768 to 32767). Useful for small counters, status codes.',
    category: 'number',
    db: { columnType: 'smallint' },
    api: {
      filterOperators: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in', 'not_in', 'is_null', 'is_not_null'],
      deserialize: (v) => (v === '' || v === null || v === undefined ? null : Math.trunc(Number(v))),
    },
    typescript: { inputType: 'number', outputType: 'number' },
  });

  registry.register({
    type: 'real',
    label: 'Real (float4)',
    description: 'Single-precision floating-point number (4 bytes). Less precise than double.',
    category: 'number',
    db: { columnType: 'real' },
    api: {
      filterOperators: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'is_null', 'is_not_null'],
      deserialize: (v) => (v === '' || v === null || v === undefined ? null : parseFloat(v)),
    },
    typescript: { inputType: 'number', outputType: 'number' },
  });

  registry.register({
    type: 'decimal',
    label: 'Decimal',
    description: 'Exact numeric with configurable precision and scale. Use for financial data.',
    category: 'number',
    db: { columnType: 'numeric' },
    api: {
      filterOperators: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'is_null', 'is_not_null'],
      deserialize: (v) => (v === '' || v === null || v === undefined ? null : Number(v)),
    },
    typescript: { inputType: 'number', outputType: 'number' },
  });

  registry.register({
    type: 'money',
    label: 'Money',
    description: 'Monetary amount in locale currency. Note: locale-dependent; prefer decimal for portability.',
    category: 'number',
    db: { columnType: 'money' },
    api: {
      filterOperators: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'is_null', 'is_not_null'],
    },
    typescript: { inputType: 'number', outputType: 'number' },
  });

  // ── Additional Text types ─────────────────────────────────────

  registry.register({
    type: 'varchar',
    label: 'Varchar',
    description: 'Variable-length string with an optional max length constraint.',
    category: 'text',
    db: { columnType: 'character varying' },
    api: {
      filterOperators: ['eq', 'neq', 'contains', 'not_contains', 'starts_with', 'ends_with', 'is_null', 'is_not_null'],
    },
    typescript: { inputType: 'string', outputType: 'string' },
  });

  registry.register({
    type: 'char',
    label: 'Char (fixed)',
    description: 'Fixed-length character string, blank-padded to the declared length.',
    category: 'text',
    db: { columnType: 'character' },
    api: {
      filterOperators: ['eq', 'neq', 'contains', 'is_null', 'is_not_null'],
    },
    typescript: { inputType: 'string', outputType: 'string' },
  });

  // ── Additional Date & Time types ──────────────────────────────

  registry.register({
    type: 'time',
    label: 'Time',
    description: 'Time of day without date or timezone.',
    category: 'date',
    db: { columnType: 'time' },
    api: {
      filterOperators: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'is_null', 'is_not_null'],
    },
    typescript: { inputType: 'string', outputType: 'string' },
  });

  registry.register({
    type: 'timetz',
    label: 'Time with Timezone',
    description: 'Time of day including timezone offset.',
    category: 'date',
    db: { columnType: 'timetz' },
    api: {
      filterOperators: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'is_null', 'is_not_null'],
    },
    typescript: { inputType: 'string', outputType: 'string' },
  });

  registry.register({
    type: 'interval',
    label: 'Interval',
    description: "Time interval / duration (e.g. '1 year 2 months', '3 hours'). Useful for subscriptions, scheduling.",
    category: 'date',
    db: { columnType: 'interval' },
    api: {
      filterOperators: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'is_null', 'is_not_null'],
    },
    typescript: { inputType: 'string', outputType: 'string' },
  });

  // ── Advanced / PostgreSQL Native ──────────────────────────────

  registry.register({
    type: 'bytea',
    label: 'Binary (bytea)',
    description: 'Binary data stored directly in the database. Useful for thumbnails, PDFs.',
    category: 'advanced',
    db: { columnType: 'bytea' },
    api: {
      filterOperators: ['is_null', 'is_not_null'],
    },
    typescript: { inputType: 'string', outputType: 'string' },
  });

  registry.register({
    type: 'tsvector',
    label: 'Full-Text Vector',
    description: 'PostgreSQL tsvector for native full-text search indexing (GIN index auto-created).',
    category: 'advanced',
    db: { columnType: 'tsvector', indexType: 'gin' },
    api: {
      filterOperators: ['is_null', 'is_not_null'],
    },
    typescript: { inputType: 'string', outputType: 'string' },
  });

  registry.register({
    type: 'inet',
    label: 'IP Address',
    description: 'IPv4 or IPv6 host address with optional subnet.',
    category: 'advanced',
    db: { columnType: 'inet' },
    api: {
      filterOperators: ['eq', 'neq', 'contains', 'is_null', 'is_not_null'],
    },
    typescript: { inputType: 'string', outputType: 'string' },
  });

  registry.register({
    type: 'cidr',
    label: 'Network Address',
    description: 'IPv4 or IPv6 network in CIDR notation (e.g. 192.168.100.0/24).',
    category: 'advanced',
    db: { columnType: 'cidr' },
    api: {
      filterOperators: ['eq', 'neq', 'is_null', 'is_not_null'],
    },
    typescript: { inputType: 'string', outputType: 'string' },
  });

  registry.register({
    type: 'macaddr',
    label: 'MAC Address',
    description: 'Hardware MAC address (e.g. 08:00:2b:01:02:03). Useful for IoT and network inventory.',
    category: 'advanced',
    db: { columnType: 'macaddr' },
    api: {
      filterOperators: ['eq', 'neq', 'is_null', 'is_not_null'],
    },
    typescript: { inputType: 'string', outputType: 'string' },
  });

  registry.register({
    type: 'xml',
    label: 'XML',
    description: 'XML document or fragment with syntax validation.',
    category: 'advanced',
    db: { columnType: 'xml' },
    api: {
      filterOperators: ['is_null', 'is_not_null'],
    },
    typescript: { inputType: 'string', outputType: 'string' },
  });

  registry.register({
    type: 'bit',
    label: 'Bit String',
    description: 'Fixed-length sequence of bits (e.g. bit(8) for flags byte).',
    category: 'advanced',
    db: { columnType: 'bit' },
    api: {
      filterOperators: ['eq', 'neq', 'is_null', 'is_not_null'],
    },
    typescript: { inputType: 'string', outputType: 'string' },
  });

  registry.register({
    type: 'varbit',
    label: 'Bit Varying',
    description: 'Variable-length bit string. Like varchar but for bits.',
    category: 'advanced',
    db: { columnType: 'varbit' },
    api: {
      filterOperators: ['eq', 'neq', 'is_null', 'is_not_null'],
    },
    typescript: { inputType: 'string', outputType: 'string' },
  });

  // ── Range types ───────────────────────────────────────────────

  registry.register({
    type: 'int4range',
    label: 'Integer Range',
    description: 'Range of 4-byte integers. Useful for versioning, pagination ranges.',
    category: 'advanced',
    db: { columnType: 'int4range' },
    api: {
      filterOperators: ['contains', 'is_null', 'is_not_null'],
    },
    typescript: { inputType: '{ lower: number; upper: number }', outputType: '{ lower: number; upper: number }' },
  });

  registry.register({
    type: 'int8range',
    label: 'Big Integer Range',
    description: 'Range of 8-byte integers.',
    category: 'advanced',
    db: { columnType: 'int8range' },
    api: {
      filterOperators: ['contains', 'is_null', 'is_not_null'],
    },
    typescript: { inputType: '{ lower: number; upper: number }', outputType: '{ lower: number; upper: number }' },
  });

  registry.register({
    type: 'numrange',
    label: 'Numeric Range',
    description: 'Range of arbitrary-precision numbers. Useful for price brackets.',
    category: 'advanced',
    db: { columnType: 'numrange' },
    api: {
      filterOperators: ['contains', 'is_null', 'is_not_null'],
    },
    typescript: { inputType: '{ lower: number; upper: number }', outputType: '{ lower: number; upper: number }' },
  });

  registry.register({
    type: 'daterange',
    label: 'Date Range',
    description: 'Range of calendar dates. Useful for booking, event periods.',
    category: 'advanced',
    db: { columnType: 'daterange' },
    api: {
      filterOperators: ['contains', 'is_null', 'is_not_null'],
    },
    typescript: { inputType: '{ lower: string; upper: string }', outputType: '{ lower: string; upper: string }' },
  });

  registry.register({
    type: 'tsrange',
    label: 'Timestamp Range',
    description: 'Range of timestamps without timezone. Useful for scheduling, availability.',
    category: 'advanced',
    db: { columnType: 'tsrange' },
    api: {
      filterOperators: ['contains', 'is_null', 'is_not_null'],
    },
    typescript: { inputType: '{ lower: string; upper: string }', outputType: '{ lower: string; upper: string }' },
  });

  registry.register({
    type: 'tstzrange',
    label: 'Timestamp+TZ Range',
    description: 'Range of timestamps with timezone. Preferred for scheduling across timezones.',
    category: 'advanced',
    db: { columnType: 'tstzrange' },
    api: {
      filterOperators: ['contains', 'is_null', 'is_not_null'],
    },
    typescript: { inputType: '{ lower: string; upper: string }', outputType: '{ lower: string; upper: string }' },
  });
}
