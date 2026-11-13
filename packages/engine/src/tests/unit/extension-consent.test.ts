/**
 * Capability consent — the manifest asks, an administrator decides.
 *
 * Without this, the capability contract is only as strong as the extension's
 * own manifest on the one path that matters: ship v1 declaring nothing, ship v2
 * declaring `db:admin`, and an update hands it cross-tenant database access
 * because it said so. The test named after that scenario is the point of the
 * whole module.
 */

import { describe, expect, it } from 'bun:test';
import { CapabilityDeniedError, gateInternals } from '../../lib/extensions/capabilities.js';
import { ManifestSchema } from '../../lib/extensions/manifest-schema.js';
import {
  declaredCapabilities,
  formatSlotBinding,
  parseForwardMap,
  parseGranted,
  parseSlotBinding,
  resolveCapabilities,
  resolveForwarded,
} from '../../lib/extensions/consent.js';
import { jobEgress } from '../../lib/extensions/jobs.js';
import { declaredSlots, declaredTcpSlots } from '../../lib/manifest-capabilities.js';

describe('the update-widening scenario', () => {
  it('does not grant a capability a new version added on its own say-so', () => {
    // v1 shipped and was installed asking for nothing.
    const granted = resolveCapabilities([], []).effective;
    expect(granted).toEqual([]);

    // v2 ships asking for cross-tenant database access.
    const r = resolveCapabilities(['db:admin'], granted);
    expect(r.effective).toEqual([]);
    expect(r.pending).toEqual(['db:admin']);
  });

  it('grants it once an administrator approves', () => {
    const r = resolveCapabilities(['db:admin'], ['db:admin']);
    expect(r.effective).toEqual(['db:admin']);
    expect(r.pending).toEqual([]);
  });

  it('keeps the capabilities that were already approved', () => {
    // A widening request must not cost the extension what it already had —
    // otherwise every update is an outage for unrelated features.
    const r = resolveCapabilities(['secrets', 'files', 'db:admin'], ['secrets', 'files']);
    expect(r.effective).toEqual(['secrets', 'files']);
    expect(r.pending).toEqual(['db:admin']);
  });
});

describe('consent does not accumulate', () => {
  it('drops a capability the extension stopped asking for', () => {
    const r = resolveCapabilities(['secrets'], ['secrets', 'db:admin']);
    expect(r.effective).toEqual(['secrets']);
    expect(r.dropped).toEqual(['db:admin']);
  });

  it('never grants something that was approved but is not declared', () => {
    // The intersection runs both ways: a stale grant is not authority.
    const r = resolveCapabilities([], ['db:admin', 'secrets']);
    expect(r.effective).toEqual([]);
  });
});

describe('installs predating consent tracking', () => {
  it('is grandfathered to its declared set rather than crippled', () => {
    // null = the column did not exist when this was installed. Nobody was ever
    // asked, so treating silence as refusal would break working installs on an
    // engine upgrade — a security posture that ships as an outage gets reverted.
    const r = resolveCapabilities(['secrets', 'db:admin'], null);
    expect(r.effective).toEqual(['secrets', 'db:admin']);
    expect(r.pending).toEqual([]);
    expect(r.grandfathered).toBe(true);
  });

  it('is distinguishable from an explicit grant of nothing', () => {
    const explicit = resolveCapabilities(['secrets'], []);
    expect(explicit.grandfathered).toBe(false);
    expect(explicit.effective).toEqual([]);
    expect(explicit.pending).toEqual(['secrets']);
  });
});

describe('parseGranted', () => {
  it('reads an array, and the string form some drivers return', () => {
    expect(parseGranted(['secrets'])).toEqual(['secrets']);
    expect(parseGranted('["secrets","files"]')).toEqual(['secrets', 'files']);
  });

  it('returns null for absent consent, not an empty grant', () => {
    // The difference decides whether an install is grandfathered or refused.
    expect(parseGranted(null)).toBeNull();
    expect(parseGranted(undefined)).toBeNull();
  });

  it('treats malformed JSON as absent rather than throwing at load', () => {
    expect(parseGranted('{not json')).toBeNull();
    expect(parseGranted(42)).toBeNull();
  });

  it('drops non-string members instead of trusting them', () => {
    expect(parseGranted(['secrets', 7, null, 'files'])).toEqual(['secrets', 'files']);
  });
});

describe('the denial tells the operator where to go', () => {
  const internals = { decryptSecret: () => 'plaintext' };

  it('says "approve it" when the manifest declares but nobody approved', () => {
    const g = gateInternals('ai', internals, [], ['secrets']);
    try {
      g.decryptSecret();
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect((e as CapabilityDeniedError).awaitingApproval).toBe(true);
      expect(msg).toContain('approve-capabilities');
      expect(msg).not.toContain('Add it to "permissions"');
    }
  });

  it('says "declare it" when the manifest does not ask at all', () => {
    // Telling an operator to edit manifest.json when the entry is already
    // there sends them to the wrong place entirely.
    const g = gateInternals('ai', internals, [], []);
    try {
      g.decryptSecret();
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect((e as CapabilityDeniedError).awaitingApproval).toBe(false);
      expect(msg).toContain('Add it to "permissions"');
      expect(msg).not.toContain('approve-capabilities');
    }
  });

  it('still denies — a pending capability is described, not granted', () => {
    const g = gateInternals('ai', internals, [], ['secrets']);
    expect(() => g.decryptSecret()).toThrow(CapabilityDeniedError);
  });
});

describe('credential forwarding needs approval of the whole map', () => {
  const fwd = { '/hook/*': ['authorization'] };

  it('forwards nothing when nothing was approved — no grandfathering', () => {
    expect(resolveForwarded(fwd, null)).toEqual({
      effective: {},
      pending: ['/hook/*: authorization'],
    });
  });

  it('forwards the declared map once every pair in it was approved', () => {
    expect(resolveForwarded(fwd, fwd)).toEqual({ effective: fwd, pending: [] });
  });

  it('a version asking for one pair more forwards nothing, not the old subset', () => {
    const wider = { '/hook/*': ['authorization', 'x-api-key'], '/in': ['cookie'] };
    expect(resolveForwarded(wider, fwd)).toEqual({
      effective: {},
      pending: ['/hook/*: x-api-key', '/in: cookie'],
    });
  });

  it('a version asking for less keeps its approval', () => {
    const approved = { '/hook/*': ['authorization', 'x-api-key'], '/in': ['cookie'] };
    expect(resolveForwarded(fwd, approved).effective).toEqual(fwd);
  });

  it('parses the stored record, and a malformed one is no approval', () => {
    expect(parseForwardMap('{"/a":["Authorization","authorization"]}')).toEqual({
      '/a': ['authorization'],
    });
    for (const bad of [null, '[]', '{"/a":"cookie"}', '{"/a":[1]}', 'nope']) {
      expect(parseForwardMap(bad)).toBeNull();
    }
  });
});

describe('job egress consent (ADR 0022 decision 5)', () => {
  const manifest = {
    permissions: ['data:system'],
    jobs: [{ name: 'send', egress: ['api.anaf.ro', 'api.x.com:8443'] }, { name: 'quiet' }],
  };

  it('asks for each declared authority as egress:<authority>', () => {
    expect(declaredCapabilities(manifest)).toEqual([
      'data:system',
      'egress:api.anaf.ro',
      'egress:api.x.com:8443',
    ]);
  });

  it('is never grandfathered: silence grants no network', () => {
    const r = resolveCapabilities(declaredCapabilities(manifest), null);
    expect(r.effective).toEqual(['data:system']);
    expect(r.pending).toEqual(['egress:api.anaf.ro', 'egress:api.x.com:8443']);
  });

  it('grants exactly what was approved', () => {
    const r = resolveCapabilities(declaredCapabilities(manifest), [
      'data:system',
      'egress:api.anaf.ro',
    ]);
    expect(r.effective).toEqual(['data:system', 'egress:api.anaf.ro']);
    expect(r.pending).toEqual(['egress:api.x.com:8443']);
  });

  it('the manifest holds egress to exact authorities, and long runs to egress jobs', () => {
    const job = (j: Record<string, unknown>) =>
      ManifestSchema.safeParse({
        name: 'x',
        jobs: [{ name: 'j', input: { type: 'object' }, ...j }],
      });
    expect(job({ egress: ['api.x.com'], timeoutSeconds: 900 }).success).toBe(true);
    expect(job({ timeoutSeconds: 61 }).success).toBe(false);
    expect(job({ egress: ['*.x.com'] }).success).toBe(false);
    expect(job({ egress: ['https://api.x.com'] }).success).toBe(false);
    expect(job({ egress: ['api.x.com'], timeoutSeconds: 901 }).success).toBe(false);
  });
});

describe('egress slot bindings (ADR 0026)', () => {
  it('parses what the bind route writes, and nothing looser', () => {
    expect(parseSlotBinding('egress:provider=api.x.com,api.y.com:8443;private')).toEqual({
      slot: 'provider',
      authorities: ['api.x.com', 'api.y.com:8443'],
      private: true,
    });
    for (const bad of [
      'egress:api.x.com',
      'egress:Provider=api.x.com',
      'egress:provider=',
      'egress:provider=https://api.x.com',
      'egress:provider=*.x.com',
      'egress:provider=api.x.com;public',
      'data:system',
    ]) {
      expect(parseSlotBinding(bad)).toBeNull();
    }
    expect(
      formatSlotBinding({
        slot: 'p',
        authorities: ['b.x.com', 'a.x.com', 'b.x.com'],
        private: false,
      }),
    ).toBe('egress:p=a.x.com,b.x.com');
  });

  it('a binding is never dropped for not being declared, nor a capability', () => {
    const r = resolveCapabilities(['data:system'], ['data:system', 'egress:provider=api.x.com']);
    expect(r.dropped).toEqual([]);
    expect(r.effective).toEqual(['data:system']);
  });

  it('a job reaches its consented static authorities and its own bound slots only', () => {
    const granted = [
      'egress:static.x.com',
      'egress:provider=api.x.com',
      'egress:local=localhost:11434;private',
      'egress:theirs=other.x.com',
    ];
    expect(
      jobEgress(
        { egress: ['static.x.com', 'unapproved.x.com'], egressSlots: ['provider', 'local'] },
        granted,
      ),
    ).toEqual({
      allowed: ['static.x.com', 'api.x.com', 'localhost:11434'],
      privateList: ['localhost:11434'],
    });
    expect(jobEgress({ egress: [], egressSlots: ['provider'] }, null)).toEqual({
      allowed: [],
      privateList: [],
    });
  });
});

describe('manifest egressSlots', () => {
  const job = (egressSlots: unknown) =>
    ManifestSchema.safeParse({
      name: 'x',
      jobs: [{ name: 'j', input: { type: 'object' }, egressSlots }],
    });
  it('takes slot names, once each, and lets the job run past 60 s', () => {
    expect(job(['provider']).success).toBe(true);
    expect(job(['Provider']).success).toBe(false);
    expect(job(['a', 'a']).success).toBe(false);
    expect(
      ManifestSchema.safeParse({
        name: 'x',
        jobs: [{ name: 'j', input: { type: 'object' }, egressSlots: ['p'], timeoutSeconds: 300 }],
      }).success,
    ).toBe(true);
  });

  it('takes { name, kind } for a tcp slot, one kind per name across jobs (ADR 0026 amendment)', () => {
    expect(job([{ name: 'mail', kind: 'tcp' }, 'provider']).success).toBe(true);
    expect(job([{ name: 'mail' }]).success).toBe(true);
    expect(job([{ name: 'mail', kind: 'udp' }]).success).toBe(false);
    expect(job([{ name: 'mail', kind: 'tcp', host: 'x' }]).success).toBe(false);
    expect(job(['mail', { name: 'mail', kind: 'tcp' }]).success).toBe(false);
    const two = (a: unknown, b: unknown) =>
      ManifestSchema.safeParse({
        name: 'x',
        jobs: [
          { name: 'a', input: { type: 'object' }, egressSlots: [a] },
          { name: 'b', input: { type: 'object' }, egressSlots: [b] },
        ],
      }).success;
    expect(two({ name: 'mail', kind: 'tcp' }, { name: 'mail', kind: 'tcp' })).toBe(true);
    expect(two('mail', { name: 'mail', kind: 'tcp' })).toBe(false);
    const manifest = { jobs: [{ egressSlots: ['provider', { name: 'mail', kind: 'tcp' }] }] };
    expect([...declaredSlots(manifest)].sort()).toEqual(['mail', 'provider']);
    expect([...declaredTcpSlots(manifest)]).toEqual(['mail']);
  });
});

describe('an action reaching any collection as its caller (ADR 0047)', () => {
  const action = (reads: string[], writes: string[] = []) => ({
    name: 'scan',
    permission: { resource: 'items' },
    input: { type: 'object' },
    reads,
    writes,
  });

  it('asks consent for "*" in an action, in reads and writes apart', () => {
    expect(declaredCapabilities({ permissions: ['data:write'], actions: [action(['*'])] })).toEqual(
      ['data:write', 'collections:any:read'],
    );
    expect(declaredCapabilities({ actions: [action(['items'], ['*']), action(['*'])] })).toEqual([
      'collections:any:write',
      'collections:any:read',
    ]);
    expect(declaredCapabilities({ actions: [action(['items'], ['items'])] })).toEqual([]);
    // A version that starts asking runs without it until approved.
    const r = resolveCapabilities(declaredCapabilities({ actions: [action(['*'])] }), []);
    expect(r.pending).toEqual(['collections:any:read']);
  });

  it('the manifest refuses it in a job, and as an action gate; it is no capability to list', () => {
    const parse = (m: Record<string, unknown>) => ManifestSchema.safeParse({ name: 'x', ...m });
    expect(parse({ actions: [action(['*'], ['*'])], resources: ['items'] }).success).toBe(true);
    for (const kind of ['reads', 'writes']) {
      const r = parse({ jobs: [{ name: 'j', input: { type: 'object' }, [kind]: ['*'] }] });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.message).toContain('lists "*" in ' + kind);
    }
    expect(parse({ actions: [{ ...action(['*']), permission: { resource: '*' } }] }).success).toBe(
      false,
    );
    expect(parse({ permissions: ['collections:any:read'] }).success).toBe(false);
  });
});
