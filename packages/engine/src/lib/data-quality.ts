/**
 * Data Quality Engine
 *
 * Detects duplicates (pg_trgm), missing/empty values, statistical outliers (3σ),
 * and AI-powered normalization suggestions.
 *
 * runQualityScan() starts an async scan and returns the scan ID immediately (202).
 */

import { sql } from 'kysely';
import type { Database } from '../db/index.js';

export type IssueType =
  | 'duplicate'
  | 'anomaly'
  | 'missing_required'
  | 'missing_recommended'
  | 'format_inconsistency'
  | 'outlier'
  | 'normalization_suggestion';

interface QualityIssue {
  issue_type: IssueType;
  severity: 'info' | 'warning' | 'error';
  record_ids: string[];
  field_name?: string;
  description: string;
  suggestion?: string;
  auto_fixable: boolean;
}

async function detectDuplicates(db: Database, tableName: string, fields: any[]): Promise<QualityIssue[]> {
  const issues: QualityIssue[] = [];
  const textFields = fields.filter((f) => ['text', 'email', 'url', 'richtext'].includes(f.type)).slice(0, 3);
  if (textFields.length === 0) return issues;

  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`.execute(db).catch(() => {});

  for (const field of textFields) {
    try {
      const pairs = await sql<{ id1: string; id2: string; sim: number; value1: string }>`
        SELECT
          a.id::text AS id1, b.id::text AS id2,
          similarity(a.${sql.id(field.name)}::text, b.${sql.id(field.name)}::text) AS sim,
          a.${sql.id(field.name)}::text AS value1
        FROM ${sql.id(tableName)} a
        JOIN ${sql.id(tableName)} b ON a.id < b.id
        WHERE a.${sql.id(field.name)} IS NOT NULL
          AND b.${sql.id(field.name)} IS NOT NULL
          AND similarity(a.${sql.id(field.name)}::text, b.${sql.id(field.name)}::text) > 0.9
        LIMIT 50
      `.execute(db);

      for (const pair of pairs.rows) {
        issues.push({
          issue_type: 'duplicate',
          severity: 'warning',
          record_ids: [pair.id1, pair.id2],
          field_name: field.name,
          description: `Possible duplicate: "${pair.value1}" (${Math.round(pair.sim * 100)}% similar on "${field.name}")`,
          suggestion: 'Review these records and merge or delete the duplicate.',
          auto_fixable: false,
        });
      }
    } catch { /* pg_trgm unavailable or field not castable */ }
  }

  return issues;
}

async function detectMissingData(db: Database, tableName: string, fields: any[]): Promise<QualityIssue[]> {
  const issues: QualityIssue[] = [];

  const totalResult = await sql<{ total: string }>`
    SELECT COUNT(*)::text AS total FROM ${sql.id(tableName)}
  `.execute(db).catch(() => ({ rows: [{ total: '0' }] }));
  const totalCount = parseInt(totalResult.rows[0]?.total || '0');
  if (totalCount === 0) return issues;

  for (const field of fields) {
    if (field.type === 'computed') continue;
    try {
      const missingResult = await sql<{ count: string; sample_ids: string[] | null }>`
        WITH missing AS (
          SELECT id::text AS id, ROW_NUMBER() OVER () AS rn
          FROM ${sql.id(tableName)}
          WHERE ${sql.id(field.name)} IS NULL
             OR CAST(${sql.id(field.name)} AS TEXT) = ''
        )
        SELECT
          COUNT(*)::text                              AS count,
          array_agg(id) FILTER (WHERE rn <= 10)      AS sample_ids
        FROM missing
      `.execute(db);

      const nullCount = parseInt(missingResult.rows[0]?.count || '0');
      if (nullCount === 0) continue;

      const pct = Math.round((nullCount / totalCount) * 100);
      if (pct < 20) continue;

      const sampleIds = { rows: (missingResult.rows[0]?.sample_ids ?? []).map((id) => ({ id })) };

      issues.push({
        issue_type: field.required ? 'missing_required' : 'missing_recommended',
        severity: field.required ? 'error' : 'warning',
        record_ids: sampleIds.rows.map((r) => r.id),
        field_name: field.name,
        description: `${nullCount} records (${pct}%) have empty "${field.name}"`,
        suggestion: field.required
          ? `"${field.name}" is required. ${nullCount} records need it populated.`
          : `Consider filling in "${field.name}" for better data completeness.`,
        auto_fixable: false,
      });
    } catch { /* field may not exist yet */ }
  }

  return issues;
}

async function detectOutliers(db: Database, tableName: string, fields: any[]): Promise<QualityIssue[]> {
  const issues: QualityIssue[] = [];
  const numericFields = fields.filter((f) => f.type === 'number');

  for (const field of numericFields) {
    try {
      const stats = await sql<{ avg: string; stddev: string; min: string; max: string }>`
        SELECT
          AVG(${sql.id(field.name)}::numeric)::text    AS avg,
          STDDEV(${sql.id(field.name)}::numeric)::text AS stddev,
          MIN(${sql.id(field.name)}::numeric)::text    AS min,
          MAX(${sql.id(field.name)}::numeric)::text    AS max
        FROM ${sql.id(tableName)}
        WHERE ${sql.id(field.name)} IS NOT NULL
      `.execute(db);

      const s = stats.rows[0];
      const avg = parseFloat(s?.avg || '0');
      const stddev = parseFloat(s?.stddev || '0');
      if (!stddev || stddev === 0) continue;

      const outliers = await sql<{ id: string; value: string }>`
        SELECT id::text, ${sql.id(field.name)}::text AS value
        FROM ${sql.id(tableName)}
        WHERE ABS(${sql.id(field.name)}::numeric - ${avg}::numeric) > 3 * ${stddev}::numeric
          AND ${sql.id(field.name)} IS NOT NULL
        LIMIT 10
      `.execute(db);

      if (outliers.rows.length === 0) continue;

      issues.push({
        issue_type: 'outlier',
        severity: 'info',
        record_ids: outliers.rows.map((r) => r.id),
        field_name: field.name,
        description: `${outliers.rows.length} outlier values in "${field.name}" (avg: ${avg.toFixed(2)}, range: ${s.min}–${s.max})`,
        suggestion: 'Review these records — values are >3σ from the mean.',
        auto_fixable: false,
      });
    } catch { /* skip non-numeric fields */ }
  }

  return issues;
}

async function aiAnalyzeQuality(
  collection: string,
  sampleRecords: any[],
  fields: any[],
): Promise<QualityIssue[]> {
  if (sampleRecords.length === 0) return [];

  const fieldList = fields.map((f) => `${f.name} (${f.type})`).join(', ');
  const sample = JSON.stringify(sampleRecords.slice(0, 5), null, 2);

  const prompt = `Analyze these sample records from collection "${collection}".
Fields: ${fieldList}

Sample data:
${sample}

Identify data quality issues: inconsistent formats, normalization problems, suspicious values.
Output ONLY a JSON array, no markdown:
[{"field_name":"field or null","issue_type":"format_inconsistency|normalization_suggestion|anomaly","description":"what is wrong","suggestion":"how to fix"}]
Maximum 5 issues. Return [] if data looks clean.`;

  try {
    const { aiProviderManager } = await import('./ai-provider.js');
    const provider = aiProviderManager.getDefault();
    if (!provider) return [];

    const response = await provider.chat(
      [{ role: 'user', content: prompt }],
      { max_tokens: 1000, temperature: 0.2 },
    );

    const text = response.content || '[]';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const aiIssues = JSON.parse(jsonMatch[0]);

    return aiIssues.map((i: any) => ({
      issue_type: (i.issue_type as IssueType) || 'anomaly',
      severity: 'info' as const,
      record_ids: [],
      field_name: i.field_name || undefined,
      description: i.description,
      suggestion: i.suggestion,
      auto_fixable: false,
    }));
  } catch {
    return [];
  }
}

async function runScanAsync(
  db: Database,
  scanId: string,
  collection: string,
  tableName: string,
  scanType: string,
): Promise<void> {
  const { DDLManager } = await import('./ddl-manager.js');
  const colDef = await DDLManager.getCollection(db, collection).catch(() => null);
  const fields: any[] = (colDef as any)?.fields || [];

  const allIssues: QualityIssue[] = [];

  const countResult = await sql<{ count: string }>`
    SELECT COUNT(*)::text AS count FROM ${sql.id(tableName)}
  `.execute(db).catch(() => ({ rows: [{ count: '0' }] }));
  const recordsScanned = parseInt(countResult.rows[0]?.count || '0');

  if (scanType === 'duplicates' || scanType === 'full') {
    allIssues.push(...(await detectDuplicates(db, tableName, fields)));
  }
  if (scanType === 'missing_data' || scanType === 'full') {
    allIssues.push(...(await detectMissingData(db, tableName, fields)));
  }
  if (scanType === 'anomalies' || scanType === 'full') {
    allIssues.push(...(await detectOutliers(db, tableName, fields)));
  }
  if (scanType === 'normalization' || scanType === 'full') {
    const sample = await (db as any)
      .selectFrom(tableName).selectAll().limit(20).execute().catch(() => []);
    allIssues.push(...(await aiAnalyzeQuality(collection, sample, fields)));
  }

  if (allIssues.length > 0) {
    await (db as any)
      .insertInto('zv_quality_issues')
      .values(allIssues.map((issue) => ({
        scan_id: scanId,
        collection,
        issue_type: issue.issue_type,
        severity: issue.severity,
        record_ids: issue.record_ids,
        field_name: issue.field_name || null,
        description: issue.description,
        suggestion: issue.suggestion || null,
        auto_fixable: issue.auto_fixable,
      })))
      .execute()
      .catch(() => {});
  }

  await (db as any)
    .updateTable('zv_quality_scans')
    .set({ status: 'completed', records_scanned: recordsScanned, issues_found: allIssues.length, completed_at: new Date() })
    .where('id', '=', scanId)
    .execute();
}

/**
 * Start an async quality scan. Returns the scan ID immediately.
 */
export async function runQualityScan(
  db: Database,
  collection: string,
  scanType: 'duplicates' | 'anomalies' | 'missing_data' | 'normalization' | 'full',
  userId: string,
  tenantSchema?: string,
): Promise<string> {
  const scan = await (db as any)
    .insertInto('zv_quality_scans')
    .values({ collection, scan_type: scanType, status: 'running', triggered_by: userId })
    .returningAll()
    .executeTakeFirst();

  const scanId: string = scan.id;
  const tableName = tenantSchema ? `${tenantSchema}.zvd_${collection}` : `zvd_${collection}`;

  runScanAsync(db, scanId, collection, tableName, scanType).catch((err) => {
    console.error(`Quality scan ${scanId} failed:`, err);
    (db as any)
      .updateTable('zv_quality_scans')
      .set({ status: 'failed', completed_at: new Date() })
      .where('id', '=', scanId)
      .execute()
      .catch(() => {});
  });

  return scanId;
}
