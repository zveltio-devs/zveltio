/**
 * An uploaded SVG is served from the engine's own origin as `image/svg+xml`, so
 * a top-level navigation to one executes its script same-origin as the Studio.
 * The sweep is the whole defence.
 *
 * It was a DENYLIST of three literal schemes, and three standard vectors walked
 * through it untouched — measured, byte for byte:
 *
 *   xlink:href="java&#10;script:alert(1)"                 the browser decodes, the regex does not
 *   <set attributeName="xlink:href" to="javascript:…">    SMIL re-points the link after load
 *   <animate attributeName="href" values="javascript:…">  same, other spelling
 *
 * Schemes are now allowlisted, which is what makes the obfuscations irrelevant
 * rather than enumerated: every unreadable value becomes `#`.
 */
import { describe, expect, it } from 'bun:test';
import { sanitizeSvgString } from '../../routes/storage.js';

describe('sanitizeSvgString — what must not survive', () => {
  it.each([
    ['an entity-encoded scheme', '<a xlink:href="java&#10;script:alert(1)"><text>A</text></a>'],
    ['a hex-entity scheme', '<a href="&#x6a;avascript:alert(2)">x</a>'],
    ['a tab inside the scheme', '<a href="java\tscript:alert(3)">x</a>'],
    ['a plain javascript: href', '<a xlink:href="javascript:alert(4)"><text>D</text></a>'],
    ['a data: href', '<a href="data:text/html,<b>x</b>">x</a>'],
    ['SMIL <set> re-pointing a link', '<set attributeName="xlink:href" to="javascript:alert(5)"/>'],
    [
      'SMIL <animate> re-pointing a link',
      '<animate attributeName="href" values="javascript:alert(6)"/>',
    ],
    ['an on* handler', '<svg onload="alert(7)">'],
    ['a <script> element', '<script>alert(8)</script>'],
    ['a <foreignObject>', '<foreignObject><iframe src="x"></iframe></foreignObject>'],
  ])('neutralises %s', (_name, payload) => {
    const out = sanitizeSvgString(payload);
    expect(out).not.toBe(payload);
    expect(out.toLowerCase()).not.toContain('javascript:');
  });
});

describe('sanitizeSvgString — what must survive', () => {
  // An over-refusing sanitiser produces no error and no complaint, only images
  // that quietly stop working, so the permissive half needs its own assertions.
  it.each([
    ['an internal fragment reference', '<use xlink:href="#icon"/>'],
    ['an https link', '<a href="https://example.com/x">y</a>'],
    ['a relative path', '<image href="logo.png"/>'],
    ['a root-relative path', '<image href="/assets/logo.png"/>'],
    ['a mailto link', '<a href="mailto:a@b.co">m</a>'],
    ['an animation of a harmless attribute', '<animate attributeName="opacity" values="0;1"/>'],
  ])('leaves %s alone', (_name, payload) => {
    expect(sanitizeSvgString(payload)).toBe(payload);
  });
});
