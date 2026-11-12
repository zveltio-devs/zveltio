// ADR 0043: the operator names the map tile server. Unset is OpenStreetMap, `off`
// is no tiles, and a template a map cannot draw refuses boot naming the variable.
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { mapTiles } from '../../lib/map-tiles.js';

describe('ZVELTIO_MAP_TILES', () => {
  it('unset: OpenStreetMap and its attribution', () => {
    expect(mapTiles({})).toEqual({
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '© OpenStreetMap contributors',
    });
  });

  it('off: no tiles', () => {
    expect(mapTiles({ ZVELTIO_MAP_TILES: 'off' })).toBeNull();
    expect(mapTiles({ ZVELTIO_MAP_TILES: ' OFF ', ZVELTIO_MAP_ATTRIBUTION: 'x' })).toBeNull();
  });

  it('custom: the template and its attribution', () => {
    expect(
      mapTiles({
        ZVELTIO_MAP_TILES: 'https://{s}.tiles.example.eu/{z}/{x}/{y}{r}.png',
        ZVELTIO_MAP_ATTRIBUTION: '© Example <b>',
      }),
    ).toEqual({
      url: 'https://{s}.tiles.example.eu/{z}/{x}/{y}{r}.png',
      attribution: '© Example <b>',
    });
    expect(mapTiles({ ZVELTIO_MAP_TILES: 'https://t.example/{z}/{x}/{y}.png' })?.attribution).toBe(
      '',
    );
  });

  it.each([
    ['http://t.example/{z}/{x}/{y}.png', 'is not https'],
    ['https://t.example/{z}/{x}.png', 'has no {y}'],
    ['not a url {z}{x}{y}', 'is not a URL'],
    ['https://t.example/{z}/{x}/{y}.png?k={key}', 'names {key}'],
  ])('refuses %s', (value, why) => {
    expect(() => mapTiles({ ZVELTIO_MAP_TILES: value })).toThrow(why);
    expect(() => mapTiles({ ZVELTIO_MAP_TILES: value })).toThrow('ZVELTIO_MAP_TILES=');
  });

  it('an invalid template refuses boot, before the database, naming the variable', async () => {
    const proc = Bun.spawn(['bun', join(import.meta.dir, '../../index.ts')], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        ZVELTIO_MAP_TILES: 'http://t.example/{z}/{x}/{y}.png',
        // Unreachable on purpose: a refusal must come before the database is asked.
        DATABASE_URL: 'postgresql://nobody@127.0.0.1:9/none',
      },
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    expect(code).not.toBe(0);
    expect(err).toContain('ZVELTIO_MAP_TILES=');
    expect(err).not.toContain('Database');
  }, 30_000);
});
