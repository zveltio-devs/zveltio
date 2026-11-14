// `extension validate` checks the manifest name against the folder path. A name
// `group/name` is the last two folders, whatever the repository folder is called
// (DR-20: a worktree `wt-ext-q/analytics/quality` failed MANIFEST_NAME_MISMATCH).
import { describe, expect, it } from 'bun:test';
import { _internalForTests } from './extension-validate.js';

const { inferExpectedName } = _internalForTests;

describe('extension validate: manifest name against the folder path', () => {
  it('reads as many trailing folders as the name has segments', () => {
    expect(inferExpectedName('/w/wt-ext-q/analytics/quality', 'analytics/quality')).toBe(
      'analytics/quality',
    );
    expect(inferExpectedName('/tmp/x/extensions/ops/inv/', 'ops/inv')).toBe('ops/inv');
    expect(inferExpectedName('/a/b/c/d', 'b/c/d')).toBe('b/c/d');
    expect(inferExpectedName('/w/zveltio-extensions/crm', 'crm')).toBe('crm');
  });

  it('still names a real mismatch', () => {
    expect(inferExpectedName('/w/zveltio-extensions/analytics/qa', 'analytics/quality')).toBe(
      'analytics/qa',
    );
    expect(inferExpectedName('/w/x/quality', 'analytics/quality')).toBe('x/quality');
  });

  it('resolves a relative path before reading it', () => {
    expect(inferExpectedName('.', 'a/b').split('/')).toHaveLength(2);
  });
});
