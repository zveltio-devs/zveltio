import { describe, expect, test } from 'vitest';
import { type MediaFile, publicImages } from './builder-types.js';

const file = (storage_path: string, mimetype = 'image/png'): MediaFile => ({
  id: storage_path,
  url: `https://cdn.example/${storage_path}`,
  storage_path,
  original_name: 'x.png',
  mimetype,
});

describe('publicImages', () => {
  test('offers only images under a public key', () => {
    const files = [
      file('public/uploads/2026/a.png'),
      file('media/b.png'),
      // A private upload: its url is a signed link that expires in a day.
      file('uploads/2026/c.png'),
      file('public/uploads/2026/d.pdf', 'application/pdf'),
    ];
    expect(publicImages(files).map((f) => f.storage_path)).toEqual([
      'public/uploads/2026/a.png',
      'media/b.png',
    ]);
  });
});
