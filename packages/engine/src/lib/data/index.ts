// Data subsystem — schema/DDL management and the query/write pipeline. This
// barrel covers the DDL + query + field modules grouped by H-08; the H-05
// pipeline modules (types, shape, query-parse, write-pipeline, auth, handlers/)
// live alongside and are folded in as the boundary check lands. Public API;
// outside (non-test) code imports from `lib/data`, never the deep files.
export * from './query-cache.js';
export * from './query-utils.js';
export * from './query-alter.js';
export * from './ddl-manager.js';
export * from './import-logs-contract.js';
export * from './ddl-queue.js';
export * from './ghost-ddl.js';
export * from './field-crypto.js';
export * from './field-type-conversions.js';
export * from './field-type-registry.js';

// Named re-exports rather than `export *`, because the pipeline modules are
// still being folded in one at a time and a blanket re-export of two files that
// both define request/DB helpers is how a name collision arrives silently.
// These three are what routes outside the subsystem need:
//   - `processInput` so import and sync go through the same field pipeline as
//     the API write path (they used to insert straight to the table, so no
//     field type's deserialize ran and `encrypted: true` was ignored);
//   - `validateApiKey` so every route that accepts `X-API-Key` runs the same
//     checks, including the tenant comparison edge functions had left out.
export { processInput } from './write-pipeline.js';
//   - `afterWrite` so sync push produces the same revisions, webhooks and
//     realtime events a bulk write does, instead of landing rows silently.
export { afterWrite } from './write-pipeline.js';
// Why a write was refused, for the routes that have to explain it. `/api/sync`
// used to hand back the raw Postgres string; both paths now say the same thing.
export { describeWriteRefusal, isRlsRefusal } from './write-pipeline.js';
//   - `normalizeFields` so the extension write proxy can tell a collection's
//     declared fields from the system columns an extension passes alongside
//     them (`id`, `created_by`); `processInput` returns only the former.
export { normalizeFields } from './shape.js';
//   - `serializeRecord` so the sync PULL path shapes rows the way every other
//     read does — it was shipping `enc:v1:…` to offline clients that have no
//     key to read it with.
export { serializeRecord } from './shape.js';
export { validateApiKey } from './auth.js';
//   - `checkAccess` so the zones render path asks the same question the data
//     API asks. It used to scope collection reads by `tenant_id` alone, which
//     re-implemented the authorisation model as a single predicate: a view on
//     a page published its collection to everyone who could open the page.
export { checkAccess } from './auth.js';
