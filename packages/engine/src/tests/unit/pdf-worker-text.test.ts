/**
 * pdf-worker — HTML to the text the PDF draws.
 *
 * The entity and heading checks used to grep the worker's source for
 * `.replace(/&lt;/g` and friends, so a replacement with the wrong right-hand
 * side passed, and a pass that never ran passed too: the heading pass sat after
 * the line that turns `</hN>` into blank lines, found nothing to pair, and every
 * heading was drawn as body text. They call the function now.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { htmlToText } from '../../workers/pdf-text.js';

describe('htmlToText', () => {
  it('decodes the entities a template carries', () => {
    expect(htmlToText('<p>a&lt;b&gt;c &quot;d&quot; e&#39;s&nbsp;f &amp; g</p>')).toBe(
      'a<b>c "d" e\'s f & g',
    );
  });

  it('decodes &amp; last, so &amp;lt; stays the text "&lt;" rather than becoming a tag', () => {
    expect(htmlToText('<p>&amp;lt;script&amp;gt;</p>')).toBe('&lt;script&gt;');
  });

  it('marks headings so the PDF draws them as headings', () => {
    expect(htmlToText('<h1>Invoice <b>42</b></h1><p>Body</p><h3>Notes</h3>')).toBe(
      '__H1__Invoice 42__END__\nBody\n\n__H3__Notes__END__',
    );
  });

  it('drops scripts and styles with their contents', () => {
    expect(htmlToText('<style>p{}</style><script>alert(1)</script><p>x</p>')).toBe('x');
  });
});

describe('pdf-worker page sizes', () => {
  const SRC = readFileSync(new URL('../../workers/pdf-worker.ts', import.meta.url), 'utf8');

  it('gives A5 its own dimensions rather than A4’s', () => {
    const a5 = /A5:\s*\[([\d.]+),\s*([\d.]+)\]/.exec(SRC);
    expect(a5, 'A5 missing from the page-size map').not.toBeNull();
    expect(Number(a5![1])).toBeCloseTo(419.53, 1);
    expect(Number(a5![2])).toBeCloseTo(595.28, 1);
  });
});
