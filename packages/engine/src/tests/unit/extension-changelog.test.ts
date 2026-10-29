/** changelogBetween: which CHANGELOG.md entries the "What's new" dialog shows. */

import { describe, expect, it } from 'bun:test';
import { changelogBetween } from '../../lib/extensions/extension-download.js';

const MD = `# Changelog

## Unreleased

- not yet

## [v2.0.0-beta.1] - 2026-10-29

- beta

## 1.10.0

- ten

## 1.9.0 (2026-01-01)

- nine
`;

describe('changelogBetween', () => {
  it('compares versions numerically, not as text, and skips non-version headings', () => {
    expect(changelogBetween(MD, '1.9.0', '1.10.0').map((e) => e.version)).toEqual(['1.10.0']);
  });

  it('takes `[vX]` headings and prereleases; null `after` means everything up to the catalog', () => {
    expect(changelogBetween(MD, null, '2.0.0-beta.1')).toEqual([
      { version: '2.0.0-beta.1', title: '- 2026-10-29', body: '- beta' },
      { version: '1.10.0', title: '', body: '- ten' },
      { version: '1.9.0', title: '(2026-01-01)', body: '- nine' },
    ]);
  });

  it('is empty when the installed version is the catalog one', () => {
    expect(changelogBetween(MD, '1.10.0', '1.10.0')).toEqual([]);
  });
});
