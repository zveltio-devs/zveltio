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

// H-05 pipeline modules — folded into the public API now that import-boundaries
// enforces barrel-only access from outside lib/data.
export * from './types.js';
export * from './auth.js';
export * from './query-parse.js';
export * from './shape.js';
export * from './write-pipeline.js';
export * from './handlers/list.js';
export * from './handlers/bulk.js';
export * from './handlers/single.js';
