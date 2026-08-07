/**
 * Depth bounds how deep one field goes. Nothing bounded how many there are.
 *
 * `list_*` already clamps every resolver to 500 rows and `checkQueryDepth`
 * already refuses deep nesting, so both of the obvious costs were priced. Width
 * was not: one POST can alias the same root field six hundred times, and each
 * alias is a separate query at the full row cap. An audit measured 600 aliases
 * answering 200 OK in 0.42 s, up to three hundred thousand rows — and the rate
 * limiter saw one request, because it counts requests and this is about cost.
 */

import { describe, expect, it } from 'bun:test';
import { checkQueryWidth } from '../../lib/graphql-dataloader.js';

const alias = (n: number) =>
  `{ ${Array.from({ length: n }, (_, i) => `a${i}: list_contacts { id }`).join(' ')} }`;

describe('graphql query width', () => {
  it('refuses the shape the audit used', () => {
    expect(checkQueryWidth(alias(600))).toContain('600 top-level fields');
  });

  it('counts an alias and its field as one selection, so the limit means what it says', () => {
    // The first version counted both and refused at half the stated number — a
    // limit documented as 50 that actually bit at 25 is a limit nobody can
    // reason about.
    expect(checkQueryWidth(alias(50), 50)).toBeNull();
    expect(checkQueryWidth(alias(51), 50)).toContain('51 top-level fields');
  });

  it('lets ordinary queries through', () => {
    for (const q of [
      '{ list_contacts { id name } list_orders { id } }',
      '{ x: list_contacts { id } y: list_contacts { id } }',
      'query Q { list_contacts { id, organization { id name } } }',
    ]) {
      expect(checkQueryWidth(q), q).toBeNull();
    }
  });

  it('does not count fields nested inside a selection', () => {
    // Those are the depth check's business. Counting them here would refuse a
    // legitimate query for asking one root field with many columns.
    const deep = `{ list_contacts { ${Array.from({ length: 200 }, (_, i) => `f${i}`).join(' ')} } }`;
    expect(checkQueryWidth(deep)).toBeNull();
  });
});
