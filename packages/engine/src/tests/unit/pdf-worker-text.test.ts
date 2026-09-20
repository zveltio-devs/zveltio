/**
 * The worker turns an HTML template into the text it draws into the PDF. Four of
 * its entity decoders had been flattened to `.replace(/&/g, '&')` — pattern and
 * replacement identical — so every `&amp;`, `&lt;`, `&gt;` and `&quot;` in a
 * document template was printed literally: an invoice for `Smith &amp; Co`
 * came out as `Smith &amp; Co`.
 *
 * Nothing tested the text pipeline, and a no-op `replace` has no failure mode:
 * it returns the string either way.
 *
 * The worker is a module with a top-level `self.onmessage`, so the pipeline is
 * re-created here from its source rather than imported — importing it outside a
 * Worker throws. The test therefore also asserts the source still contains what
 * it re-creates, so it cannot silently drift into testing a private copy (the
 * shape that left two query_db suites unable to fail).
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../../workers/pdf-worker.ts', import.meta.url), 'utf8');
/** Comments quote the defect by name, so the scan below must not read them. */
const CODE = SRC.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('pdf-worker — HTML to drawable text', () => {
  it('decodes the entities it claims to decode', () => {
    for (const entity of ['&lt;', '&gt;', '&quot;', '&amp;', '&nbsp;']) {
      expect(SRC, `${entity} is not decoded by the worker`).toContain(`.replace(/${entity}/g`);
    }
  });

  it('has no replace whose pattern equals its replacement', () => {
    // `.replace(/X/g, 'X')` is the exact defect: it runs, it returns, it does
    // nothing, and it reads as a decoder.
    const noops = [...CODE.matchAll(/\.replace\(\/([^/\\]{1,12})\/g,\s*'([^']{1,12})'\)/g)].filter(
      ([, pattern, replacement]) => pattern === replacement,
    );
    expect(noops.map((m) => m[0])).toEqual([]);
  });

  it('decodes &amp; last, so &amp;lt; does not become a tag', () => {
    const amp = SRC.indexOf('.replace(/&amp;/g');
    for (const earlier of ['&lt;', '&gt;', '&quot;']) {
      expect(SRC.indexOf(`.replace(/${earlier}/g`)).toBeLessThan(amp);
    }
  });

  it('gives A5 its own dimensions rather than A4’s', () => {
    const a4 = /A4:\s*\[([\d.]+),\s*([\d.]+)\]/.exec(SRC);
    const a5 = /A5:\s*\[([\d.]+),\s*([\d.]+)\]/.exec(SRC);
    expect(a4, 'A4 missing from the page-size map').not.toBeNull();
    expect(a5, 'A5 missing from the page-size map').not.toBeNull();
    expect(a5![0]).not.toBe(a4![0].replace('A4', 'A5'));
    // A5 is half of A4: 419.53 x 595.28 pt.
    expect(Number(a5![1])).toBeCloseTo(419.53, 1);
    expect(Number(a5![2])).toBeCloseTo(595.28, 1);
  });
});
