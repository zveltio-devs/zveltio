/**
 * The canvas and the public renderer must speak one block vocabulary.
 *
 * The page builder is Studio's front-end package (ADR 0042 decision 9); the
 * block list, the public renderer and the breakpoint keys belong to the
 * `content/pages` extension, whose client Studio carries under
 * `#lib/ext/content/pages/client`. Before the move these checks ran in the
 * extension; a block the library offered but the canvas could not preview
 * showed authors a grey box on the one screen meant to show the visitor's page.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ALL_BLOCK_TYPES, BLOCK_TYPES } from '#lib/ext/content/pages/client/block-types.js';
import { BREAKPOINTS, spanKey, styleKey } from '#lib/ext/content/pages/client/responsive.js';
import { LIBRARY } from './builder-types.js';
import {
  BREAKPOINTS as EDITOR_BREAKPOINTS,
  spanKey as editorSpanKey,
  styleKey as editorStyleKey,
} from './breakpoints.js';

const offered = new Set<string>(LIBRARY.map((b) => b.type));

describe('block vocabulary', () => {
  test('the library offers exactly the canonical list', () => {
    expect([...offered].sort()).toEqual([...BLOCK_TYPES].sort());
  });

  test('the canvas previews every type the public renderer draws', () => {
    const src = readFileSync(join(__dirname, '../components/builder/BlockPreview.svelte'), 'utf8');
    const handled = new Set([...src.matchAll(/block\.type === '([a-z_]+)'/g)].map((m) => m[1]));
    expect(ALL_BLOCK_TYPES.filter((t) => !handled.has(t))).toEqual([]);
  });
});

describe('breakpoint key parity', () => {
  test('both sides know the same sizes, in the same order', () => {
    expect([...EDITOR_BREAKPOINTS]).toEqual([...BREAKPOINTS]);
  });

  test('the style and width keys agree for every size', () => {
    for (const bp of BREAKPOINTS) {
      expect(editorStyleKey(bp)).toBe(styleKey(bp));
      expect(editorSpanKey(bp)).toBe(spanKey(bp));
    }
  });
});

describe('the canvas sanitises what an author typed', () => {
  const src = readFileSync(join(__dirname, '../components/builder/BlockPreview.svelte'), 'utf8');

  // A `javascript:` URL in a video block ran in Studio's origin when anyone
  // opened the builder: the helpers existed and the preview never called them.
  test('every iframe address goes through safeIframeSrc', () => {
    expect(src).toMatch(/embedUrl = safeIframeSrc\(/);
    expect([...src.matchAll(/<iframe src=\{(\w+)\}/g)].map((m) => m[1])).toEqual(['embedUrl']);
  });

  test('no style attribute interpolates a raw block value', () => {
    const raw = [...src.matchAll(/style="[^"]*\{(p\.[a-z_]+)[^}]*\}/g)].map((m) => m[1]);
    expect(raw).toEqual([]);
  });
});
