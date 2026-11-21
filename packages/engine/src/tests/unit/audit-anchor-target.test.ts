import { afterEach, describe, expect, it } from 'bun:test';
import { anchorTarget } from '../../lib/audit-anchor.js';

const KEYS = ['AUDIT_ANCHOR_TARGET', 'AUDIT_ANCHOR_S3_ACCESS_KEY', 'AUDIT_ANCHOR_S3_SECRET_KEY'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('anchorTarget s3 credentials', () => {
  it('refuses the anchor key without its secret, and the reverse', () => {
    process.env.AUDIT_ANCHOR_TARGET = 's3://anchors/zv';
    process.env.AUDIT_ANCHOR_S3_ACCESS_KEY = 'k';
    delete process.env.AUDIT_ANCHOR_S3_SECRET_KEY;
    expect(() => anchorTarget()).toThrow(/set together/);
    delete process.env.AUDIT_ANCHOR_S3_ACCESS_KEY;
    process.env.AUDIT_ANCHOR_S3_SECRET_KEY = 's';
    expect(() => anchorTarget()).toThrow(/set together/);
  });

  it('accepts both or neither', () => {
    process.env.AUDIT_ANCHOR_TARGET = 's3://anchors/zv';
    delete process.env.AUDIT_ANCHOR_S3_ACCESS_KEY;
    delete process.env.AUDIT_ANCHOR_S3_SECRET_KEY;
    expect(anchorTarget()).toMatchObject({ kind: 's3', prefix: 'zv/' });
    process.env.AUDIT_ANCHOR_S3_ACCESS_KEY = 'k';
    process.env.AUDIT_ANCHOR_S3_SECRET_KEY = 's';
    expect(anchorTarget()).toMatchObject({ kind: 's3', prefix: 'zv/' });
  });
});
