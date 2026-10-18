// `zveltio extension validate` refuses the actions and jobs the engine would refuse at load.
import { describe, expect, it } from 'bun:test';
import { validateManifest } from '../validate/index.js';

const base = {
  name: 'a',
  displayName: 'A',
  category: 'custom',
  description: 'd',
  version: '1.0.0',
  resources: ['ext:a'],
};
const input = { type: 'object' };
const action = {
  name: 'convertLead',
  permission: { resource: 'ext:a' },
  input,
  enqueues: ['notify'],
};
const job = { name: 'notify', input, retry: { limit: 3 } };
const errors = (extra: Record<string, unknown>) =>
  validateManifest({ manifest: { ...base, ...extra } })
    .filter((e) => e.code === 'MANIFEST_BAD_ACTION' || e.code === 'MANIFEST_BAD_JOB')
    .map((e) => e.message);

describe('manifest actions and jobs', () => {
  it('accepts a well-formed action that enqueues a declared job', () => {
    expect(errors({ actions: [action], jobs: [job] })).toEqual([]);
  });

  it('refuses what the engine schema refuses', () => {
    expect(errors({ actions: [action] })).toEqual([
      'action "convertLead" enqueues "notify", which is not in jobs',
    ]);
    expect(
      errors({ actions: [{ ...action, permission: { resource: 'ext:b' } }], jobs: [job] }),
    ).toHaveLength(1);
    expect(errors({ actions: [action, action], jobs: [job] })).toHaveLength(1);
    expect(errors({ actions: [{ ...action, name: 'Convert' }], jobs: [job] })).toHaveLength(1);
    expect(errors({ actions: [{ ...action, input: 'x' }], jobs: [job] })).toHaveLength(1);
    expect(errors({ actions: [{ ...action, writes: 'contacts' }], jobs: [job] })).toHaveLength(1);
    expect(errors({ actions: {}, jobs: [job] })).toHaveLength(1);
    expect(errors({ jobs: [{ ...job, retry: { limit: 11 } }] })).toHaveLength(1);
    expect(errors({ jobs: [{ ...job, retry: { backoff: 'yes' } }] })).toHaveLength(1);
  });
});
