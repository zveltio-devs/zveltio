import { describe, expect, it } from 'vitest';
import { mapTiles, setMapTiles } from './map-tiles.js';

describe('map tiles (ADR 0043)', () => {
  it('keeps the template and escapes the attribution Leaflet reads as HTML', () => {
    setMapTiles({
      url: 'https://t.test/{z}/{x}/{y}.png',
      attribution: '<img src=x onerror=1> & co',
    });
    expect(mapTiles()).toEqual({
      url: 'https://t.test/{z}/{x}/{y}.png',
      attribution: '&lt;img src=x onerror=1&gt; &amp; co',
    });
  });

  it('off, absent or malformed: no tiles', () => {
    for (const v of [null, undefined, { url: 1, attribution: '' }]) {
      setMapTiles({ url: 'https://t.test/{z}/{x}/{y}.png', attribution: '' });
      setMapTiles(v);
      expect(mapTiles()).toBeNull();
    }
  });
});
