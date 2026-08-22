/**
 * studio-embed stub — empty embed is inactive; getStudioFile returns null.
 */

import { describe, expect, it } from 'bun:test';
import { getStudioFile, studioEmbedActive, studioFileExists } from '../../studio-embed/index.js';

describe('studio-embed stub', () => {
  it('is inactive when no Studio was inlined', () => {
    expect(studioEmbedActive()).toBe(false);
  });

  it('returns null for any path', () => {
    expect(getStudioFile('/index.html')).toBeNull();
    expect(studioFileExists('/index.html')).toBe(false);
  });
});
