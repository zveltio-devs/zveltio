// Data subsystem — schema/DDL management and the query/write pipeline. This
// barrel covers the DDL + query + field modules grouped by H-08; the H-05
// pipeline modules (types, shape, query-parse, write-pipeline, auth, handlers/)
// live alongside and are folded in as the boundary check lands. Public API;
// outside (non-test) code imports from `lib/data`, never the deep files.
export * from './query-cache.js';
export * from './query-utils.js';
export * from './query-alter.js';
export * from './ddl-manager.js';
export * from './ddl-queue.js';
export * from './ghost-ddl.js';
export * from './field-crypto.js';
export * from './field-type-conversions.js';
export * from './field-type-registry.js';
