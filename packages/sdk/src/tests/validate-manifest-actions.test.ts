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

  it('takes fromPublicRoutes naming publicRoutes entries only (ADR 0018)', () => {
    const hooked = { ...job, fromPublicRoutes: ['/webhooks/stripe'] };
    expect(errors({ jobs: [hooked], publicRoutes: ['/webhooks/stripe'] })).toEqual([]);
    expect(errors({ jobs: [hooked] })).toEqual([
      'job "notify" names "/webhooks/stripe" in fromPublicRoutes, which is not a publicRoutes entry',
    ]);
    expect(errors({ jobs: [{ ...job, fromPublicRoutes: '/webhooks/stripe' }] })).toHaveLength(1);
    expect(
      errors({
        jobs: [{ ...job, fromPublicRoutes: ['/webhooks/*'] }],
        publicRoutes: ['/webhooks/*'],
      }),
    ).toEqual([
      'job "notify" names "/webhooks/*" in fromPublicRoutes; name one route, without "*"',
    ]);
  });

  it('takes calls of a required dependency’s actions, as <extension>.<action> (ADR 0014)', () => {
    const calling = { ...action, calls: ['finance/invoicing.recordPayment'] };
    const deps = [{ name: 'finance/invoicing' }];
    expect(errors({ actions: [calling], jobs: [job], dependencies: deps })).toEqual([]);
    expect(errors({ actions: [calling], jobs: [job] })).toEqual([
      'action "convertLead" calls "finance/invoicing.recordPayment", but "finance/invoicing" is not in dependencies or optionalDependencies',
    ]);
    expect(errors({ actions: [calling], jobs: [job], optionalDependencies: deps })).toEqual([]);
    const bad = (calls: unknown) =>
      errors({ actions: [{ ...action, calls }], jobs: [job], dependencies: deps });
    expect(bad(['finance/invoicing'])).toHaveLength(1);
    expect(bad(['finance/invoicing.Pay'])).toHaveLength(1);
    expect(bad('finance/invoicing.recordPayment')).toHaveLength(1);
  });

  it('accepts an action gated on a collection the actions or jobs read or write', () => {
    const gated = { ...action, permission: { resource: 'leads' } };
    expect(errors({ actions: [{ ...gated, writes: ['leads'] }], jobs: [job] })).toEqual([]);
    expect(errors({ actions: [gated], jobs: [{ ...job, reads: ['leads'] }] })).toEqual([]);
    expect(errors({ actions: [gated], jobs: [job] })).toHaveLength(1);
  });
});

describe('manifest collections', () => {
  const bad = (collections: unknown) =>
    validateManifest({ manifest: { ...base, collections } }).filter(
      (e) => e.code === 'MANIFEST_BAD_COLLECTIONS',
    );
  it('takes collection names, once each', () => {
    expect(bad(['tasks', 'task_lists'])).toEqual([]);
    expect(bad('tasks')).toHaveLength(1);
    expect(bad(['Tasks'])).toHaveLength(1);
    expect(bad(['tasks', 'tasks'])).toHaveLength(1);
  });

  it('takes tcp slots as { name, kind }, one kind per name (ADR 0026 amendment)', () => {
    const slots = (egressSlots: unknown[]) => ({ ...job, egressSlots });
    expect(errors({ jobs: [slots([{ name: 'mail', kind: 'tcp' }, 'provider'])] })).toEqual([]);
    expect(errors({ jobs: [slots([{ name: 'mail', kind: 'udp' }])] })).toHaveLength(1);
    expect(errors({ jobs: [slots([{ name: 'mail', port: 993 }])] })).toHaveLength(1);
    expect(errors({ jobs: [slots(['mail', { name: 'mail', kind: 'tcp' }])] })).toHaveLength(1);
    expect(
      errors({
        jobs: [slots(['mail']), { ...slots([{ name: 'mail', kind: 'tcp' }]), name: 'other' }],
      }),
    ).toEqual(['job "other": slot "mail" is declared both "http" and "tcp"']);
  });

  it('refuses "*" in a job, and as an action\'s gate (ADR 0047)', () => {
    const any = { ...action, enqueues: [], reads: ['*'], writes: ['*'] };
    expect(errors({ actions: [any] })).toEqual([]);
    expect(errors({ actions: [action], jobs: [{ ...job, reads: ['*'] }] })).toEqual([
      'job "notify" lists "*" in reads: only an action reaches any collection, as its caller; a job lists each one',
    ]);
    expect(errors({ actions: [{ ...any, permission: { resource: '*' } }] })).toHaveLength(1);
  });
});
