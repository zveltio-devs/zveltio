/**
 * GraphQL auto-generated API
 *
 * Builds a live GraphQL schema from zv_collections + zv_fields (via DDLManager)
 * and resolves relations from zvd_relations.
 *
 * GET  /api/graphql               — GraphiQL playground
 * POST /api/graphql               — Execute query/mutation (auth required)
 * POST /api/graphql/refresh-schema — Invalidate cached schema (admin only)
 */

import { Hono } from 'hono';
import {
  graphql,
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLList,
  GraphQLNonNull,
  GraphQLID,
} from 'graphql';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { DDLManager } from '../lib/ddl-manager.js';
import { auth } from '../lib/auth.js';
import { checkPermission } from '../lib/permissions.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface RelationInfo {
  id: string;
  name: string;
  type: 'm2o' | 'o2m' | 'm2m' | 'm2a';
  source_collection: string;
  source_field: string;
  target_collection: string;
  target_field?: string;
  junction_table?: string;
}

// ── Field type mapping ────────────────────────────────────────────────────────

function mapFieldType(fieldType: string): any {
  const map: Record<string, any> = {
    text:      GraphQLString,
    string:    GraphQLString,
    email:     GraphQLString,
    url:       GraphQLString,
    richtext:  GraphQLString,
    textarea:  GraphQLString,
    password:  GraphQLString,
    slug:      GraphQLString,
    color:     GraphQLString,
    phone:     GraphQLString,
    tags:      GraphQLString,
    enum:      GraphQLString,
    date:      GraphQLString,
    datetime:  GraphQLString,
    json:      GraphQLString,
    number:    GraphQLFloat,
    float:     GraphQLFloat,
    integer:   GraphQLInt,
    boolean:   GraphQLBoolean,
    uuid:      GraphQLID,
    reference: GraphQLID,
    file:      GraphQLID,
    image:     GraphQLID,
  };
  return map[fieldType] ?? GraphQLString;
}

// ── Relations loader ──────────────────────────────────────────────────────────

async function getRelations(db: Database): Promise<RelationInfo[]> {
  try {
    const result = await sql<RelationInfo>`
      SELECT id, name, type,
             source_collection, source_field,
             target_collection, target_field,
             junction_table
      FROM zvd_relations
    `.execute(db);
    return result.rows;
  } catch {
    return [];
  }
}

// ── Schema builder ────────────────────────────────────────────────────────────

async function buildDynamicSchema(db: Database): Promise<GraphQLSchema> {
  let collections: any[] = [];
  let relations: RelationInfo[] = [];

  try {
    collections = await DDLManager.getCollections(db);
    relations = await getRelations(db);
  } catch { /* no collections yet */ }

  const baseFields = {
    id:         { type: GraphQLID },
    created_at: { type: GraphQLString },
    updated_at: { type: GraphQLString },
  };

  const queryFields:      Record<string, any>           = {};
  const mutationFields:   Record<string, any>           = {};
  const collectionTypes:  Record<string, GraphQLObjectType> = {};

  // ── First pass: create all object types (without resolvers — avoids forward-ref issues) ──
  for (const col of collections) {
    const typeName = col.name.charAt(0).toUpperCase() + col.name.slice(1);
    const scalarFields: Record<string, any> = { ...baseFields };
    for (const field of (col.fields || [])) {
      scalarFields[field.name] = { type: mapFieldType(field.type) };
    }

    const colType = new GraphQLObjectType({
      name: typeName,
      // Use a thunk so relation fields can reference types built in the same loop
      fields: () => {
        const allFields: Record<string, any> = { ...scalarFields };
        for (const rel of relations.filter((r) => r.source_collection === col.name)) {
          const targetType = collectionTypes[rel.target_collection];
          if (!targetType) continue;
          if (rel.type === 'm2o') {
            allFields[rel.source_field] = { type: targetType };
          } else if (rel.type === 'o2m' || rel.type === 'm2m') {
            allFields[rel.source_field] = { type: new GraphQLList(targetType) };
          }
        }
        return allFields;
      },
    });

    collectionTypes[col.name] = colType;
  }

  // ── Second pass: query/mutation fields + relation resolvers ──
  for (const col of collections) {
    const tableName = DDLManager.getTableName(col.name);
    const colType   = collectionTypes[col.name];

    const inputFields: Record<string, any> = {};
    for (const field of (col.fields || [])) {
      inputFields[field.name] = { type: mapFieldType(field.type) };
    }

    // list_<collection>
    queryFields[`list_${col.name}`] = {
      type: new GraphQLList(colType),
      args: {
        limit:         { type: GraphQLInt, defaultValue: 50 },
        offset:        { type: GraphQLInt, defaultValue: 0 },
        filter_id:     { type: GraphQLID },
        filter_id_in:  { type: new GraphQLList(GraphQLID) },
      },
      resolve: async (_: any, { limit, offset, filter_id, filter_id_in }: any) => {
        try {
          let q = (db as any).selectFrom(tableName).selectAll();
          if (filter_id)               q = q.where('id', '=', filter_id);
          if (filter_id_in?.length)    q = q.where('id', 'in', filter_id_in);
          return await q.limit(limit).offset(offset).execute();
        } catch { return []; }
      },
    };

    // get_<collection>
    queryFields[`get_${col.name}`] = {
      type: colType,
      args: { id: { type: new GraphQLNonNull(GraphQLID) } },
      resolve: async (_: any, { id }: any) => {
        try {
          return await (db as any)
            .selectFrom(tableName).selectAll()
            .where('id', '=', id)
            .executeTakeFirst();
        } catch { return null; }
      },
    };

    // create_<collection>
    mutationFields[`create_${col.name}`] = {
      type: colType,
      args: inputFields,
      resolve: async (_: any, args: any) => {
        try {
          return await (db as any)
            .insertInto(tableName).values(args)
            .returningAll().executeTakeFirst();
        } catch { return null; }
      },
    };

    // update_<collection>
    mutationFields[`update_${col.name}`] = {
      type: colType,
      args: { id: { type: new GraphQLNonNull(GraphQLID) }, ...inputFields },
      resolve: async (_: any, { id, ...data }: any) => {
        try {
          return await (db as any)
            .updateTable(tableName)
            .set({ ...data, updated_at: new Date() })
            .where('id', '=', id)
            .returningAll().executeTakeFirst();
        } catch { return null; }
      },
    };

    // delete_<collection>
    mutationFields[`delete_${col.name}`] = {
      type: GraphQLBoolean,
      args: { id: { type: new GraphQLNonNull(GraphQLID) } },
      resolve: async (_: any, { id }: any) => {
        try {
          const res = await (db as any)
            .deleteFrom(tableName).where('id', '=', id).executeTakeFirst();
          return (res?.numDeletedRows ?? 0n) > 0n;
        } catch { return false; }
      },
    };

    // Relation resolvers (mutate the already-built type's field map in-place)
    const collectionRelations = relations.filter((r) => r.source_collection === col.name);
    if (collectionRelations.length > 0) {
      const liveFields = colType.getFields();

      for (const rel of collectionRelations) {
        const fieldName      = rel.source_field;
        const targetTableName = DDLManager.getTableName(rel.target_collection);
        const targetType      = collectionTypes[rel.target_collection];
        if (!targetType) continue;

        if (rel.type === 'm2o') {
          (liveFields as any)[fieldName] = {
            name: fieldName,
            type: targetType,
            args: [],
            description: `Many-to-one relation → ${rel.target_collection}`,
            resolve: async (parent: any) => {
              const fk = parent[fieldName];
              if (!fk) return null;
              try {
                return await (db as any)
                  .selectFrom(targetTableName).selectAll()
                  .where('id', '=', fk).executeTakeFirst();
              } catch { return null; }
            },
          };

        } else if (rel.type === 'o2m') {
          const foreignKey = rel.target_field || `${col.name}_id`;
          (liveFields as any)[fieldName] = {
            name: fieldName,
            type: new GraphQLList(targetType),
            args: [],
            description: `One-to-many relation → ${rel.target_collection}`,
            resolve: async (parent: any) => {
              try {
                return await (db as any)
                  .selectFrom(targetTableName).selectAll()
                  .where(foreignKey, '=', parent.id).execute();
              } catch { return []; }
            },
          };

        } else if (rel.type === 'm2m') {
          const junctionTable = rel.junction_table || `zvd_${col.name}_${rel.target_collection}`;
          const sourceColumn  = `${col.name}_id`;
          const targetColumn  = `${rel.target_collection}_id`;
          (liveFields as any)[fieldName] = {
            name: fieldName,
            type: new GraphQLList(targetType),
            args: [],
            description: `Many-to-many relation → ${rel.target_collection}`,
            resolve: async (parent: any) => {
              try {
                return await (db as any)
                  .selectFrom(junctionTable)
                  .innerJoin(
                    targetTableName,
                    `${junctionTable}.${targetColumn}`,
                    `${targetTableName}.id`,
                  )
                  .selectAll(targetTableName)
                  .where(`${junctionTable}.${sourceColumn}`, '=', parent.id)
                  .execute();
              } catch { return []; }
            },
          };
        }
      }
    }
  }

  // Ensure at least one query field (GraphQL requires a non-empty Query type)
  if (Object.keys(queryFields).length === 0) {
    queryFields['_empty'] = {
      type: GraphQLString,
      resolve: () => 'No collections defined yet',
    };
  }

  return new GraphQLSchema({
    query: new GraphQLObjectType({ name: 'Query', fields: queryFields }),
    mutation: Object.keys(mutationFields).length > 0
      ? new GraphQLObjectType({ name: 'Mutation', fields: mutationFields })
      : undefined,
  });
}

// ── Schema cache (TTL 60 s) ───────────────────────────────────────────────────

let _cachedSchema: GraphQLSchema | null = null;
let _schemaBuildTime = 0;
const SCHEMA_TTL_MS = 60_000;

async function getSchema(db: Database): Promise<GraphQLSchema> {
  const now = Date.now();
  if (!_cachedSchema || now - _schemaBuildTime > SCHEMA_TTL_MS) {
    _cachedSchema = await buildDynamicSchema(db);
    _schemaBuildTime = now;
  }
  return _cachedSchema;
}

// ── GraphiQL playground ───────────────────────────────────────────────────────

const PLAYGROUND_HTML = `<!DOCTYPE html>
<html>
  <head>
    <title>Zveltio GraphQL</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/graphiql/3.0.6/graphiql.min.css" />
  </head>
  <body style="margin:0">
    <div id="graphiql" style="height:100vh"></div>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/graphiql/3.0.6/graphiql.min.js"></script>
    <script>
      const fetcher = GraphiQL.createFetcher({ url: '/api/graphql' });
      ReactDOM.render(React.createElement(GraphiQL, { fetcher }), document.getElementById('graphiql'));
    </script>
  </body>
</html>`;

// ── Route factory ─────────────────────────────────────────────────────────────

export function graphqlRoutes(db: Database, _auth: any): Hono {
  const app = new Hono();

  // GET / — GraphiQL playground (public)
  app.get('/', (c) => c.html(PLAYGROUND_HTML));

  // POST / — Execute GraphQL query (auth required)
  app.post('/', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ errors: [{ message: 'Unauthorized' }] }, 401);

    let body: { query?: string; variables?: Record<string, any>; operationName?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ errors: [{ message: 'Invalid JSON body' }] }, 400);
    }

    const { query, variables, operationName } = body;
    if (!query) return c.json({ errors: [{ message: 'query is required' }] }, 400);

    try {
      const schema = await getSchema(db);
      const result = await graphql({
        schema,
        source: query,
        variableValues: variables,
        operationName,
        contextValue: { user: session.user, db },
      });
      return c.json(result);
    } catch (err) {
      return c.json({ errors: [{ message: String(err) }] }, 400);
    }
  });

  // POST /refresh-schema — admin only, force cache invalidation
  app.post('/refresh-schema', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    const isAdmin = await checkPermission(session.user.id, 'admin', '*');
    if (!isAdmin) return c.json({ error: 'Admin required' }, 403);

    _cachedSchema = null;
    await getSchema(db);
    return c.json({ success: true, message: 'Schema refreshed' });
  });

  return app;
}
