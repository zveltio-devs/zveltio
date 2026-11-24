/**
 * `zveltio extension validate` runs the SDK's `validateManifest`; the engine
 * loads with `ManifestSchema`. An author whose manifest passes the first and is
 * refused by the second finds out at install. Same fixtures through both: each
 * must accept or refuse alike.
 */
import { describe, expect, it } from 'bun:test';
import { validateManifest } from '@zveltio/sdk/validate';
import { ManifestSchema } from '../../lib/extensions/manifest-schema.js';

type M = Record<string, any>;
const base = (): M => ({
  name: 'acme',
  displayName: 'Acme',
  category: 'developer',
  description: 'd',
  version: '1.0.0',
  permissions: ['data:system'],
  actions: [
    {
      name: 'doIt',
      permission: { resource: 'things' },
      input: { type: 'object' },
      writes: ['things'],
    },
  ],
  jobs: [{ name: 'tick', input: { type: 'object' }, reads: ['things'] }],
});
const job = (patch: M) => (m: M) => Object.assign(m.jobs[0], patch);

// [the engine refuses it, the edit]
const cases: Record<string, [boolean, (m: M) => void]> = {
  plain: [false, () => {}],
  'cron hourly': [false, job({ schedule: '0 * * * *' })],
  'cron n/step': [false, job({ schedule: '5/10 * * * *' })],
  'cron dow 7': [false, job({ schedule: '0 0 * * 7' })],
  'cron feb 29': [false, job({ schedule: '0 0 29 2 *' })],
  'cron 31st of jan or apr': [false, job({ schedule: '0 0 31 1,4 *' })],
  'cron feb 30 or a monday': [false, job({ schedule: '0 0 30 2 1' })],
  'cron feb 30': [true, job({ schedule: '0 0 30 2 *' })],
  'cron apr 31': [true, job({ schedule: '0 0 31 4 *' })],
  'cron feb 30 stepped dow': [true, job({ schedule: '0 0 30 2 */2' })],
  'cron six fields': [true, job({ schedule: '0 0 * * * *' })],
  'scheduled, input requires a field': [
    true,
    job({
      schedule: '0 * * * *',
      input: { type: 'object', required: ['x'], properties: { x: { type: 'string' } } },
    }),
  ],
  'scheduled, input accepts {}': [
    false,
    job({
      schedule: '0 * * * *',
      input: { type: 'object', properties: { x: { type: 'string' } } },
    }),
  ],
  'egress host:port': [false, job({ egress: ['api.x.com:8443', 'api.y.com'] })],
  'egress ipv6 canonical': [false, job({ egress: ['[2001:db8::1]'] })],
  'egress port too big': [true, job({ egress: ['api.x.com:99999'] })],
  'egress dots': [true, job({ egress: ['..'] })],
  'egress ipv6 not canonical': [true, job({ egress: ['[2001:0db8::1]'] })],
  'egress leading zero ipv4': [true, job({ egress: ['010.0.0.1'] })],
  'egress scheme': [true, job({ egress: ['https://api.x.com'] })],
  'action input not a schema': [
    true,
    (m) => {
      m.actions[0].input = { type: 'nonsense' };
    },
  ],
  'job input not a schema': [true, job({ input: { type: 'nonsense' } })],
};

describe('SDK validateManifest refuses what the engine ManifestSchema refuses', () => {
  for (const [label, [refused, edit]] of Object.entries(cases)) {
    it(label, () => {
      const m = base();
      edit(m);
      const engine = ManifestSchema.safeParse(m);
      const sdk = validateManifest({ manifest: m }).filter((e) => e.severity !== 'warning');
      expect({ engine: engine.success ? [] : engine.error.issues.map((i) => i.message) }).toEqual(
        refused ? { engine: expect.arrayContaining([expect.any(String)]) } : { engine: [] },
      );
      expect({ sdk: sdk.map((e) => e.message) }).toEqual(
        refused ? { sdk: expect.arrayContaining([expect.any(String)]) } : { sdk: [] },
      );
    });
  }
});
