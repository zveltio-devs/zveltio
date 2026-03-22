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
  category?: 'text' | 'number' | 'date' | 'media' | 'relation' | 'location' | 'special';

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
    serialize?: (value: any) => any;
    // Deserialization: JSON input → SQL value
    deserialize?: (value: any) => any;
    // Available filter operators
    filterOperators?: FilterOperator[];
    // API-level validation (before write to DB)
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
  | 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte'
  | 'in' | 'not_in'
  | 'contains' | 'not_contains' | 'starts_with' | 'ends_with'
  | 'is_null' | 'is_not_null'
  | 'near' | 'within' | 'intersects'; // geospatial

export interface FieldConfig {
  name: string;
  type: string;
  required?: boolean;
  unique?: boolean;
  indexed?: boolean;
  label?: string;
  description?: string;
  defaultValue?: any;
  options?: Record<string, any>;
  encrypted?: boolean;
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

    const parts = [
      `"${field.name}"`,
      typeDef.db.columnType,
    ];

    if (field.required) parts.push('NOT NULL');
    if (field.unique) parts.push('UNIQUE');

    // Default value — field-specific overrides type default
    const defaultVal = field.defaultValue ?? typeDef.db.defaultValue;
    if (defaultVal !== undefined && defaultVal !== null) {
      const val = typeof defaultVal === 'string' && !defaultVal.startsWith('gen_') && !defaultVal.startsWith('NOW')
        ? `'${defaultVal}'`
        : String(defaultVal);
      parts.push(`DEFAULT ${val}`);
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
  serialize(type: string, value: any): any {
    const typeDef = this.get(type);
    return typeDef?.api.serialize ? typeDef.api.serialize(value) : value;
  }

  // Deserialize a value for DB write
  deserialize(type: string, value: any): any {
    const typeDef = this.get(type);
    return typeDef?.api.deserialize ? typeDef.api.deserialize(value) : value;
  }

  // Validate a value
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
