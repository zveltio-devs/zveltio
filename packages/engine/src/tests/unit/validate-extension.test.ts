import { describe, it, expect } from 'bun:test';
import {
  validateManifest,
  validatePeerDependencies,
  validateMigrations,
  validateFilePresence,
  validateBundleSize,
  validateExtension,
} from '@zveltio/sdk/validate';

const ALLOWED = new Set(['imapflow', 'nodemailer']);

describe('validateManifest', () => {
  it('rejects non-object', () => {
    expect(validateManifest({ manifest: 'string', expectedName: 'x' })[0].code).toBe(
      'MANIFEST_NOT_OBJECT',
    );
    expect(validateManifest({ manifest: null, expectedName: 'x' })[0].code).toBe(
      'MANIFEST_NOT_OBJECT',
    );
    expect(validateManifest({ manifest: [], expectedName: 'x' })[0].code).toBe(
      'MANIFEST_NOT_OBJECT',
    );
  });

  it('flags missing required fields', () => {
    const errors = validateManifest({ manifest: { name: 'x' }, expectedName: 'x' });
    const codes = errors.map((e) => e.code);
    expect(codes.filter((c) => c === 'MANIFEST_MISSING_FIELD').length).toBeGreaterThanOrEqual(4);
  });

  it('flags name mismatch with folder', () => {
    const errors = validateManifest({
      manifest: {
        name: 'foo/bar',
        displayName: 'F',
        category: 'finance',
        description: 'desc',
        version: '1.0.0',
      },
      expectedName: 'finance/baz',
    });
    expect(errors.find((e) => e.code === 'MANIFEST_NAME_MISMATCH')).toBeDefined();
  });

  it('accepts a well-formed manifest', () => {
    const errors = validateManifest({
      manifest: {
        name: 'finance/invoicing',
        displayName: 'Invoicing',
        category: 'finance',
        description: 'Invoices.',
        version: '1.0.0',
        zveltioMinVersion: '1.0.0',
      },
      expectedName: 'finance/invoicing',
    });
    expect(errors).toEqual([]);
  });

  it('flags bad semver', () => {
    const errors = validateManifest({
      manifest: {
        name: 'a',
        displayName: 'A',
        category: 'custom',
        description: '.',
        version: 'not-semver',
      },
    });
    expect(errors.find((e) => e.code === 'MANIFEST_BAD_VERSION')).toBeDefined();
  });

  it('warns on unknown category', () => {
    const errors = validateManifest({
      manifest: {
        name: 'a',
        displayName: 'A',
        category: 'finanace', // typo
        description: '.',
        version: '1.0.0',
      },
    });
    expect(errors.find((e) => e.code === 'MANIFEST_UNKNOWN_CATEGORY')).toBeDefined();
  });

  it('accepts pre-release versions', () => {
    const errors = validateManifest({
      manifest: {
        name: 'a',
        displayName: 'A',
        category: 'custom',
        description: '.',
        version: '1.0.0-beta.1',
      },
    });
    expect(errors.find((e) => e.code === 'MANIFEST_BAD_VERSION')).toBeUndefined();
  });
});

describe('validatePeerDependencies', () => {
  it('passes when deps are on the allow-list', () => {
    const errors = validatePeerDependencies({
      peerDependencies: { imapflow: '^1.0.0', nodemailer: '^6.9.0' },
      allowedPackages: ALLOWED,
    });
    expect(errors).toEqual([]);
  });

  it('rejects packages outside the allow-list', () => {
    const errors = validatePeerDependencies({
      peerDependencies: { 'left-pad': '^1.0.0' },
      allowedPackages: ALLOWED,
    });
    expect(errors[0].code).toBe('PEERDEP_NOT_ALLOWED');
  });

  it('rejects unsafe package specs', () => {
    const errors = validatePeerDependencies({
      peerDependencies: { 'file:./local': 'whatever' as any },
      allowedPackages: ALLOWED,
    });
    expect(errors[0].code).toBe('PEERDEP_UNSAFE_NAME');
  });

  it('rejects unsafe version ranges', () => {
    const errors = validatePeerDependencies({
      peerDependencies: { imapflow: 'git+https://evil.example/imapflow.git' },
      allowedPackages: ALLOWED,
    });
    expect(errors[0].code).toBe('PEERDEP_UNSAFE_VERSION');
  });

  it('tolerates no peerDependencies', () => {
    expect(
      validatePeerDependencies({
        peerDependencies: undefined,
        allowedPackages: ALLOWED,
      }),
    ).toEqual([]);
  });
});

describe('validateMigrations', () => {
  it('passes a simple UP-only migration', () => {
    expect(
      validateMigrations({
        files: [{ filename: '001.sql', sql: 'CREATE TABLE t (id UUID PRIMARY KEY);' }],
      }),
    ).toEqual([]);
  });

  it('flags empty file', () => {
    const errors = validateMigrations({
      files: [{ filename: '002_blank.sql', sql: '   \n' }],
    });
    expect(errors[0].code).toBe('MIGRATION_EMPTY');
  });

  it('flags missing UP section', () => {
    const errors = validateMigrations({
      files: [{ filename: '003.sql', sql: '-- DOWN\nDROP TABLE t;' }],
    });
    expect(errors[0].code).toBe('MIGRATION_NO_UP');
  });

  it('flags destructive DDL without DOWN section when requested', () => {
    const errors = validateMigrations({
      files: [{ filename: '004_drop.sql', sql: 'DROP TABLE old_data;' }],
      requireDownForDestructive: true,
    });
    expect(errors[0].code).toBe('MIGRATION_DESTRUCTIVE_NO_DOWN');
  });

  it('accepts destructive DDL with a DOWN section', () => {
    const errors = validateMigrations({
      files: [
        {
          filename: '005_drop.sql',
          sql: 'DROP TABLE old_data;\n-- DOWN\nCREATE TABLE old_data (id UUID PRIMARY KEY);',
        },
      ],
      requireDownForDestructive: true,
    });
    expect(errors).toEqual([]);
  });

  it('does NOT flag non-destructive migrations', () => {
    const errors = validateMigrations({
      files: [
        {
          filename: '006_add.sql',
          sql: 'ALTER TABLE t ADD COLUMN x TEXT;',
        },
      ],
      requireDownForDestructive: true,
    });
    expect(errors).toEqual([]);
  });
});

describe('validateFilePresence', () => {
  it('passes when all required files exist', () => {
    expect(
      validateFilePresence({
        paths: { 'a.txt': true, 'b.txt': true },
        required: ['a.txt'],
      }),
    ).toEqual([]);
  });

  it('flags each missing required file', () => {
    const errors = validateFilePresence({
      paths: { 'a.txt': false, 'b.txt': true },
      required: ['a.txt', 'b.txt', 'c.txt'],
    });
    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.code === 'FILE_MISSING')).toBe(true);
  });
});

describe('validateBundleSize', () => {
  it('passes within quota', () => {
    expect(validateBundleSize({ bundleBytes: 10_000 })).toEqual([]);
  });

  it('flags above quota', () => {
    const errors = validateBundleSize({
      bundleBytes: 60_000 * 1024, // 60 MB
    });
    expect(errors[0].code).toBe('BUNDLE_TOO_LARGE');
  });

  it('respects custom cap', () => {
    const errors = validateBundleSize({
      bundleBytes: 200 * 1024, // 200 KB
      bundleSizeKbMax: 100,
    });
    expect(errors[0].code).toBe('BUNDLE_TOO_LARGE');
  });
});

describe('validateExtension composite', () => {
  it('aggregates errors across categories with ok=false', () => {
    const result = validateExtension({
      manifest: {
        manifest: {
          name: 'wrong',
          displayName: 'X',
          category: 'finance',
          description: 'd',
          version: '1.0.0',
        },
        expectedName: 'right',
      },
      peerDeps: {
        peerDependencies: { evil: '^1.0.0' },
        allowedPackages: ALLOWED,
      },
      migrations: { files: [] },
      filePresence: { paths: { 'manifest.json': false }, required: ['manifest.json'] },
      stats: { tables: 0, migrations: 0 },
    });
    expect(result.ok).toBe(false);
    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain('MANIFEST_NAME_MISMATCH');
    expect(codes).toContain('PEERDEP_NOT_ALLOWED');
    expect(codes).toContain('FILE_MISSING');
  });

  it('returns ok=true when everything passes', () => {
    const result = validateExtension({
      manifest: {
        manifest: {
          name: 'finance/invoicing',
          displayName: 'Inv',
          category: 'finance',
          description: 'd',
          version: '1.0.0',
          zveltioMinVersion: '1.0.0',
        },
        expectedName: 'finance/invoicing',
      },
      peerDeps: {
        peerDependencies: { imapflow: '^1.0.0' },
        allowedPackages: ALLOWED,
      },
      migrations: {
        files: [{ filename: '001.sql', sql: 'CREATE TABLE t (id UUID PRIMARY KEY);' }],
        requireDownForDestructive: true,
      },
      filePresence: { paths: { 'manifest.json': true }, required: ['manifest.json'] },
      bundleSize: { bundleBytes: 5_000 },
      stats: { tables: 1, migrations: 1 },
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.stats).toEqual({ tables: 1, migrations: 1, peerDeps: 1 });
  });
});
