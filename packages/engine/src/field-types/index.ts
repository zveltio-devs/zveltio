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
}
