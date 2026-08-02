/**
 * FieldTypeDefinition — a field type knows everything about itself:
 * - how it exists in PostgreSQL (column, index)
 * - how it behaves in the API (serialization, filters, validation)
 * - what TypeScript type it generates
 *
 * Studio UI and display are in packages/studio/src/field-types/
 * and link through the same `type` key.
 */
export interface FieldTypeDefinition {
  // Unique identifier
  type: string;

  // Metadata
  label: string;
  description?: string;
  icon?: string;
  category?:
    | 'text'
    | 'number'
    | 'date'
    | 'media'
    | 'relation'
    | 'location'
    | 'special'
    | 'advanced';

  // ── DB Layer ──────────────────────────────────────────────
  db: {
    // PostgreSQL column type
    columnType: string;
    // Nullable by default?
    nullable?: boolean;
    // Index type if needed
    indexType?: 'btree' | 'gin' | 'gist' | 'hash';
    // Required PostgreSQL extensions
    requiresExtensions?: string[];
    // Default value SQL
    defaultValue?: string;
    // Whether to skip DDL generation (computed fields)
    virtual?: boolean;
  };

  // ── API Layer ─────────────────────────────────────────────
  api: {
    // Serialization: DB value → JSON response
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    serialize?: (value: any) => any;
    // Deserialization: JSON input → SQL value.
    // May be async — `password` hashes here. Always awaited by the registry.
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    deserialize?: (value: any) => any | Promise<any>;
    // Available filter operators
    filterOperators?: FilterOperator[];
    // API-level validation (before write to DB)
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    validate?: (value: any, field: FieldConfig) => string | null;
  };

  // ── TypeScript Layer ──────────────────────────────────────
  typescript: {
    // Type for input (create/update)
    inputType: string;
    // Type for output (read)
    outputType: string;
  };
}

export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'in'
  | 'not_in'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'is_null'
  | 'is_not_null'
  | 'near'
  | 'within'
  | 'intersects'; // geospatial

export interface FieldConfig {
  name: string;
  type: string;
  required?: boolean;
  unique?: boolean;
  indexed?: boolean;
  label?: string;
  description?: string;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  defaultValue?: any;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  options?: Record<string, any>;
  encrypted?: boolean;
}

/**
 * The bare SQL expressions a column DEFAULT may contain. Anything not on this
 * list is emitted as a quoted literal, never as SQL.
 */
const SQL_DEFAULT_EXPRESSIONS: ReadonlySet<string> = new Set([
  'now()',
  'current_timestamp',
  'current_date',
  'current_time',
  'gen_random_uuid()',
  'uuid_generate_v4()',
  'null',
  'true',
  'false',
]);

/**
 * Render a column default for inclusion in DDL.
 *
 * A DEFAULT clause cannot be parameterised, so the value is interpolated — which
 * makes this the one place a caller-supplied string reaches raw SQL. It used to
 * be wrapped in `'${value}'` with no escaping, and any string beginning `gen_`
 * or `NOW` skipped quoting entirely, so both a quote and a crafted prefix
 * injected arbitrary SQL. That matters more than a normal DDL path: the route
 * that creates fields is reachable by a tenant admin, who is deliberately NOT
 * given the SQL editor, and Bun's simple-query protocol accepts multiple
 * statements per command.
 *
 * Numbers and booleans render as themselves; a known SQL expression renders
 * verbatim; everything else becomes a string literal with quotes doubled.
 */
export function renderSqlDefault(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  const raw = String(value);
  if (SQL_DEFAULT_EXPRESSIONS.has(raw.trim().toLowerCase())) return raw;

  return `'${raw.replace(/'/g, "''")}'`;
}

export class FieldTypeRegistry {
  private types = new Map<string, FieldTypeDefinition>();

  register(definition: FieldTypeDefinition): void {
    this.types.set(definition.type, definition);
  }

  get(type: string): FieldTypeDefinition | undefined {
    return this.types.get(type);
  }

  has(type: string): boolean {
    return this.types.has(type);
  }

  list(): string[] {
    return [...this.types.keys()];
  }

  getAll(): FieldTypeDefinition[] {
    return [...this.types.values()];
  }

  // Generate DDL for a column
  getColumnDDL(field: FieldConfig): string | null {
    const typeDef = this.get(field.type);
    if (!typeDef) throw new Error(`Unknown field type: ${field.type}`);
    if (typeDef.db.virtual) return null; // computed — no real column

    const parts = [`"${field.name}"`, typeDef.db.columnType];

    if (field.required) parts.push('NOT NULL');
    if (field.unique) parts.push('UNIQUE');

    // Default value — field-specific overrides type default
    const defaultVal = field.defaultValue ?? typeDef.db.defaultValue;
    if (defaultVal !== undefined && defaultVal !== null) {
      parts.push(`DEFAULT ${renderSqlDefault(defaultVal)}`);
    }

    return parts.join(' ');
  }

  // Generate index DDL for a field
  getIndexDDL(tableName: string, field: FieldConfig): string | null {
    const typeDef = this.get(field.type);
    if (!typeDef || typeDef.db.virtual) return null;
    if (!field.indexed && !typeDef.db.indexType) return null;

    const indexType = typeDef.db.indexType || 'btree';
    const method = indexType === 'btree' ? '' : `USING ${indexType.toUpperCase()} `;
    return `CREATE INDEX IF NOT EXISTS idx_${tableName}_${field.name} ON ${tableName} ${method}("${field.name}")`;
  }

  // Get required PostgreSQL extensions for a set of fields
  getRequiredExtensions(fields: FieldConfig[]): string[] {
    const extensions = new Set<string>();
    for (const field of fields) {
      const typeDef = this.get(field.type);
      typeDef?.db.requiresExtensions?.forEach((ext) => extensions.add(ext));
    }
    return [...extensions];
  }

  // Serialize a value for API output
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  serialize(type: string, value: any): any {
    const typeDef = this.get(type);
    return typeDef?.api.serialize ? typeDef.api.serialize(value) : value;
  }

  /**
   * Deserialize a value for DB write.
   *
   * `async` on purpose, even though most implementations are synchronous: the
   * `password` type hashes with `Bun.password.hash`, which is not. When this
   * returned `any`, a caller that forgot to await got a Promise and TypeScript
   * had nothing to say about it — the `any` swallowed the mismatch — so the
   * pending Promise was written to the column and the password was never
   * hashed. Returning `Promise<any>` makes the await the only thing that
   * compiles into a usable value.
   */
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  async deserialize(type: string, value: any): Promise<any> {
    const typeDef = this.get(type);
    return typeDef?.api.deserialize ? await typeDef.api.deserialize(value) : value;
  }

  // Validate a value
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  validate(type: string, value: any, field: FieldConfig): string | null {
    const typeDef = this.get(type);
    return typeDef?.api.validate ? typeDef.api.validate(value, field) : null;
  }

  // Generate TypeScript type for a collection
  generateTypeScript(collectionName: string, fields: FieldConfig[]): string {
    const typeName = collectionName.charAt(0).toUpperCase() + collectionName.slice(1);

    const inputFields = fields
      .map((f) => {
        const typeDef = this.get(f.type);
        const tsType = typeDef?.typescript.inputType || 'any';
        const optional = !f.required ? '?' : '';
        return `  ${f.name}${optional}: ${tsType};`;
      })
      .join('\n');

    return `
export interface ${typeName}Input {
${inputFields}
}

export interface ${typeName} extends ${typeName}Input {
  id: string;
  created_at: string;
  updated_at: string;
  status: string;
}
`.trim();
  }
}

export const fieldTypeRegistry = new FieldTypeRegistry();
