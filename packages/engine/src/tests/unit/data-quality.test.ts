/**
 * Data Quality Engine (lib/data-quality.ts) — unit-tested over CannedDb.
 *
 * runQualityScan is the only export; it fire-and-forgets the actual scan
 * inside withTenantIsolation, so tests inject the canned Kysely via
 * initTenantManager and await the terminal zv_quality_scans UPDATE.
 * Detector logic ("given these rows → these issues") is asserted through the
 * zv_quality_issues INSERT parameters.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { runQualityScan } from '../../lib/data-quality.js';
import { DDLManager } from '../../lib/data/index.js';
import { serviceRegistry } from '../../lib/service-registry.js';
import { initTenantManager } from '../../lib/tenancy/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const SCAN_ID = '00000000-0000-4000-8000-00000000c0de';

/** Fresh CannedDb wired as both the caller db and the tenant-isolation pool. */
function setup(collection: string, fields: unknown[]): CannedDb {
  const db = new CannedDb();
  db.when(/insert into "zv_quality_scans"/, [{ id: SCAN_ID, collection, status: 'running' }]);
  db.when(/select \* from "zvd_collections" where "name" = /, [
    { name: collection, fields: JSON.stringify(fields) },
  ]);
  initTenantManager(db.kysely as unknown as Database);
  return db;
}

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

/** The terminal UPDATE always fires (completed or failed) — await it, then return it. */
async function awaitScanEnd(db: CannedDb) {
  return db.waitFor(/update "zv_quality_scans" set/);
}

beforeEach(() => {
  // DDLManager caches collection defs process-wide; scans in earlier tests
  // must not leak their fields into later ones.
  DDLManager.invalidateCache();
});

afterEach(() => {
  serviceRegistry.unregisterAs('engine', 'ai.providers');
});

describe('runQualityScan — lifecycle', () => {
  it('returns the scan id immediately and marks the scan completed', async () => {
    const db = setup('contacts', []);
    const scanId = await runQualityScan(asDb(db), 'contacts', 'full', 'user-1');
    expect(scanId).toBe(SCAN_ID);

    const end = await awaitScanEnd(db);
    expect(end.parameters).toContain('completed');
    // scan id is the WHERE parameter of the terminal update
    expect(end.parameters).toContain(SCAN_ID);
  });

  it('throws when the scan record cannot be created', async () => {
    const db = new CannedDb(); // no insert handler → returningAll yields no row
    initTenantManager(asDb(db));
    await expect(runQualityScan(asDb(db), 'contacts', 'full', 'user-1')).rejects.toThrow(
      'Failed to create quality scan record',
    );
  });

  it('marks the scan failed when the scan body throws', async () => {
    const db = setup('contacts', []);
    db.fail(/set_config/, new Error('tenant guc exploded'));

    await runQualityScan(asDb(db), 'contacts', 'full', 'user-1');
    const end = await awaitScanEnd(db);
    expect(end.parameters).toContain('failed');
  });

  it('scopes the scan to the tenant schema when one is passed', async () => {
    const db = setup('contacts', [{ name: 'email', type: 'email' }]);
    await runQualityScan(asDb(db), 'contacts', 'duplicates', 'user-1', 't_acme');
    await awaitScanEnd(db);

    const dupQueries = db.executed(/similarity/);
    expect(dupQueries.length).toBeGreaterThan(0);
    // sql.id() quotes the dotted name as ONE identifier — this pins the
    // current behavior; the tenantSchema path needs sql.table()/split to
    // actually resolve a schema-qualified table.
    expect(dupQueries[0]!.sql).toContain('"t_acme.zvd_contacts"');
  });

  it('runs the scan inside a tenant-GUC transaction', async () => {
    const db = setup('contacts', []);
    await runQualityScan(asDb(db), 'contacts', 'full', 'user-1', undefined, 'tenant-42');
    await awaitScanEnd(db);

    const guc = db.executed(/set_config\('zveltio.current_tenant'/);
    expect(guc).toHaveLength(1);
    expect(guc[0]!.parameters).toContain('tenant-42');
  });
});

describe('duplicate detection', () => {
  const fields = [
    { name: 'email', type: 'email' },
    { name: 'name', type: 'text' },
    { name: 'age', type: 'number' }, // not a text field → never queried
  ];

  it('reports similar pairs as duplicate issues with both record ids', async () => {
    const db = setup('contacts', fields);
    db.when(/similarity\(a\."email"/, [{ id1: 'r1', id2: 'r2', sim: 0.95, value1: 'a@x.com' }]);
    // count query: 0 records → missing-data short-circuits; no outliers rows

    await runQualityScan(asDb(db), 'contacts', 'full', 'user-1');
    await awaitScanEnd(db);

    const inserts = db.executed(/insert into "zv_quality_issues"/);
    expect(inserts).toHaveLength(1);
    const p = inserts[0]!.parameters;
    expect(p).toContain('duplicate');
    expect(p).toContain('warning');
    expect(p.join('|')).toContain('95% similar');
  });

  it('emits no issues and completes when nothing matches', async () => {
    const db = setup('contacts', fields);
    await runQualityScan(asDb(db), 'contacts', 'duplicates', 'user-1');
    const end = await awaitScanEnd(db);

    expect(db.executed(/insert into "zv_quality_issues"/)).toHaveLength(0);
    expect(end.parameters).toContain('completed');
    // issues_found = 0 travels in the terminal update
    expect(end.parameters).toContain(0);
  });

  it('survives a similarity query error (pg_trgm unavailable) per field', async () => {
    const db = setup('contacts', fields);
    db.fail(/similarity\(a\."email"/, new Error('function similarity does not exist'));
    db.when(/similarity\(a\."name"/, [{ id1: 'r3', id2: 'r4', sim: 0.91, value1: 'Ann' }]);

    await runQualityScan(asDb(db), 'contacts', 'duplicates', 'user-1');
    await awaitScanEnd(db);

    const inserts = db.executed(/insert into "zv_quality_issues"/);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.parameters.join('|')).toContain('name');
  });
});

describe('missing-data detection', () => {
  const fields = [
    { name: 'email', type: 'email', required: true },
    { name: 'phone', type: 'text', required: false },
    { name: 'derived', type: 'computed' }, // skipped entirely
  ];

  it('flags required fields ≥20% empty as errors with sample ids', async () => {
    const db = setup('contacts', fields);
    db.when(/SELECT COUNT\(\*\)::text AS total/i, [{ total: '100' }]);
    db.when(/WITH missing[\s\S]*"email"/i, [{ count: '40', sample_ids: ['m1', 'm2'] }]);
    db.when(/WITH missing[\s\S]*"phone"/i, [{ count: '0', sample_ids: null }]);

    await runQualityScan(asDb(db), 'contacts', 'missing_data', 'user-1');
    await awaitScanEnd(db);

    const inserts = db.executed(/insert into "zv_quality_issues"/);
    expect(inserts).toHaveLength(1);
    const joined = inserts[0]!.parameters.join('|');
    expect(inserts[0]!.parameters).toContain('missing_required');
    expect(inserts[0]!.parameters).toContain('error');
    expect(joined).toContain('40 records (40%)');
    // computed fields are never queried
    expect(db.executed(/WITH missing[\s\S]*"derived"/i)).toHaveLength(0);
  });

  it('flags optional fields as warnings and ignores <20% gaps', async () => {
    const db = setup('contacts', fields);
    db.when(/SELECT COUNT\(\*\)::text AS total/i, [{ total: '100' }]);
    db.when(/WITH missing[\s\S]*"email"/i, [{ count: '10', sample_ids: ['m1'] }]); // 10% → ignored
    db.when(/WITH missing[\s\S]*"phone"/i, [{ count: '55', sample_ids: ['p1'] }]);

    await runQualityScan(asDb(db), 'contacts', 'missing_data', 'user-1');
    await awaitScanEnd(db);

    const inserts = db.executed(/insert into "zv_quality_issues"/);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.parameters).toContain('missing_recommended');
    expect(inserts[0]!.parameters).toContain('warning');
  });

  it('short-circuits on an empty table', async () => {
    const db = setup('contacts', fields);
    db.when(/SELECT COUNT\(\*\)::text AS total/i, [{ total: '0' }]);

    await runQualityScan(asDb(db), 'contacts', 'missing_data', 'user-1');
    await awaitScanEnd(db);

    expect(db.executed(/WITH missing/)).toHaveLength(0);
    expect(db.executed(/insert into "zv_quality_issues"/)).toHaveLength(0);
  });
});

describe('outlier detection', () => {
  const fields = [
    { name: 'amount', type: 'number' },
    { name: 'note', type: 'text' },
  ];

  it('reports >3σ values as info issues', async () => {
    const db = setup('orders', fields);
    db.when(/AVG\("amount"/, [{ avg: '100', stddev: '10', min: '80', max: '500' }]);
    db.when(/ABS\("amount"/, [
      { id: 'o1', value: '500' },
      { id: 'o2', value: '480' },
    ]);

    await runQualityScan(asDb(db), 'orders', 'anomalies', 'user-1');
    await awaitScanEnd(db);

    const inserts = db.executed(/insert into "zv_quality_issues"/);
    expect(inserts).toHaveLength(1);
    const p = inserts[0]!.parameters;
    expect(p).toContain('outlier');
    expect(p).toContain('info');
    expect(p.join('|')).toContain('2 outlier values in "amount"');
    // text fields never get stats queries
    expect(db.executed(/AVG\("note"/)).toHaveLength(0);
  });

  it('skips constant fields (stddev 0) without querying outliers', async () => {
    const db = setup('orders', fields);
    db.when(/AVG\("amount"/, [{ avg: '100', stddev: '0', min: '100', max: '100' }]);

    await runQualityScan(asDb(db), 'orders', 'anomalies', 'user-1');
    await awaitScanEnd(db);

    expect(db.executed(/ABS\("amount"/)).toHaveLength(0);
    expect(db.executed(/insert into "zv_quality_issues"/)).toHaveLength(0);
  });
});

describe('AI normalization pass', () => {
  const fields = [{ name: 'phone', type: 'text' }];

  function fakeAiProvider(content: string) {
    return {
      getDefault: () => ({
        chat: async () => ({ content }),
      }),
    };
  }

  it('maps AI-suggested issues into normalization issues', async () => {
    const db = setup('contacts', fields);
    db.when(/select \* from "zvd_contacts" limit/, [
      { id: 's1', phone: '+40 721 111 222' },
      { id: 's2', phone: '0721111333' },
    ]);
    serviceRegistry.registerAs(
      'engine',
      'ai.providers',
      fakeAiProvider(
        'Here you go: [{"field_name":"phone","issue_type":"format_inconsistency","description":"Mixed phone formats","suggestion":"Normalize to E.164"}]',
      ),
    );

    await runQualityScan(asDb(db), 'contacts', 'normalization', 'user-1');
    await awaitScanEnd(db);

    const inserts = db.executed(/insert into "zv_quality_issues"/);
    expect(inserts).toHaveLength(1);
    const p = inserts[0]!.parameters;
    expect(p).toContain('format_inconsistency');
    expect(p).toContain('Mixed phone formats');
    expect(p).toContain('Normalize to E.164');
  });

  it('skips the AI pass silently when no provider is registered', async () => {
    const db = setup('contacts', fields);
    db.when(/select \* from "zvd_contacts" limit/, [{ id: 's1', phone: 'x' }]);

    await runQualityScan(asDb(db), 'contacts', 'normalization', 'user-1');
    const end = await awaitScanEnd(db);

    expect(db.executed(/insert into "zv_quality_issues"/)).toHaveLength(0);
    expect(end.parameters).toContain('completed');
  });

  it('ignores unparseable AI output', async () => {
    const db = setup('contacts', fields);
    db.when(/select \* from "zvd_contacts" limit/, [{ id: 's1', phone: 'x' }]);
    serviceRegistry.registerAs('engine', 'ai.providers', fakeAiProvider('sorry, no JSON here'));

    await runQualityScan(asDb(db), 'contacts', 'normalization', 'user-1');
    await awaitScanEnd(db);

    expect(db.executed(/insert into "zv_quality_issues"/)).toHaveLength(0);
  });

  it('skips the AI pass when the sample is empty', async () => {
    const db = setup('contacts', fields);
    let chatCalled = false;
    serviceRegistry.registerAs('engine', 'ai.providers', {
      getDefault: () => ({
        chat: async () => {
          chatCalled = true;
          return { content: '[]' };
        },
      }),
    });

    await runQualityScan(asDb(db), 'contacts', 'normalization', 'user-1');
    await awaitScanEnd(db);

    expect(chatCalled).toBe(false);
  });
});

describe('scan-type routing', () => {
  const fields = [
    { name: 'email', type: 'email', required: true },
    { name: 'amount', type: 'number' },
  ];

  it('duplicates scan runs only the duplicate detector', async () => {
    const db = setup('contacts', fields);
    await runQualityScan(asDb(db), 'contacts', 'duplicates', 'user-1');
    await awaitScanEnd(db);

    expect(db.executed(/similarity/).length).toBeGreaterThan(0);
    expect(db.executed(/WITH missing/)).toHaveLength(0);
    expect(db.executed(/AVG\(/)).toHaveLength(0);
    expect(db.executed(/select \* from "zvd_contacts" limit/)).toHaveLength(0);
  });

  it('full scan runs every detector', async () => {
    const db = setup('contacts', fields);
    db.when(/SELECT COUNT\(\*\)::text AS total/i, [{ total: '10' }]);

    await runQualityScan(asDb(db), 'contacts', 'full', 'user-1');
    await awaitScanEnd(db);

    expect(db.executed(/similarity/).length).toBeGreaterThan(0);
    expect(db.executed(/WITH missing/).length).toBeGreaterThan(0);
    expect(db.executed(/AVG\(/).length).toBeGreaterThan(0);
    expect(db.executed(/select \* from "zvd_contacts" limit/).length).toBeGreaterThan(0);
  });

  it('records the scanned record count in the terminal update', async () => {
    const db = setup('contacts', []);
    db.when(/SELECT COUNT\(\*\)::text AS count/i, [{ count: '1234' }]);

    await runQualityScan(asDb(db), 'contacts', 'full', 'user-1');
    const end = await awaitScanEnd(db);
    expect(end.parameters).toContain(1234);
  });
});
