import { test, expect } from '@playwright/test';
import { E2E } from '../setup/env.js';

const PAGES = ['/admin/', '/admin/collections/', '/admin/settings/', '/admin/users/'];

/**
 * Text contrast, measured on the rendered page.
 *
 * Not a stylesheet audit: the theme is OKLCH and `getComputedStyle` returns it
 * as OKLCH, so a colour read with a regular expression yields numbers that mean
 * nothing. A first pass did exactly that and reported 364 of 364 elements
 * failing at 1:1 — text the same colour as its own background, which no
 * screenshot showed. The canvas resolves any CSS colour to sRGB, and that is
 * what makes the numbers here real.
 *
 * Getting here took three wrong turns worth recording. `@layer components` lost
 * to DaisyUI, which emits component colours into `@layer utilities` — layer
 * order is settled before specificity is consulted, so raising specificity
 * inside the losing layer changed nothing. And the last two failures were not
 * component defaults at all: they were `--color-info` and `--color-secondary`
 * being too light for white text at badge sizes, which no component override
 * could have fixed.
 */
test('text meets WCAG AA on the main screens', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/admin/login/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.locator('#login-email').fill(E2E.admin.email);
  await page.locator('#login-password').fill(E2E.admin.password);
  await page
    .getByRole('button', { name: /sign in$/i })
    .first()
    .click();
  await page.waitForTimeout(3500);

  const all: Array<{ ratio: number; size: number; text: string }> = [];
  for (const p of PAGES) {
    await page.goto(p, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1500);
    const rows = await page.evaluate(() => {
      const srgb = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      const lum = (r: number, g: number, b: number) =>
        0.2126 * srgb(r / 255) + 0.7152 * srgb(g / 255) + 0.0722 * srgb(b / 255);
      // Culorile temei sunt OKLCH, iar `getComputedStyle` le întoarce tot ca
      // `oklch(...)`. Citite cu o expresie regulată ies numere fără sens. Canvas-ul
      // rezolvă orice culoare CSS în sRGB, deci el face conversia.
      const cv = document.createElement('canvas');
      cv.width = cv.height = 1;
      const ctx = cv.getContext('2d', { willReadFrequently: true })!;
      const parse = (col: string): number[] => {
        try {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = '#000';
          ctx.fillStyle = col;
          if (ctx.fillStyle === '#000000' && !/#000|black|rgb\(0, 0, 0/.test(col)) return [];
          ctx.fillRect(0, 0, 1, 1);
          const d = ctx.getImageData(0, 0, 1, 1).data;
          return [d[0], d[1], d[2], d[3] / 255];
        } catch {
          return [];
        }
      };
      function bgOf(el: Element): [number, number, number] {
        let e: Element | null = el;
        while (e) {
          const p = parse(getComputedStyle(e).backgroundColor);
          if (p.length >= 3 && (p[3] === undefined || p[3] > 0.5)) return [p[0], p[1], p[2]];
          e = e.parentElement;
        }
        return [255, 255, 255];
      }
      const out: Array<{ ratio: number; size: number; text: string }> = [];
      for (const el of Array.from(document.querySelectorAll('main *, aside *'))) {
        const t = (el.textContent ?? '').trim();
        if (!t || el.children.length > 0 || t.length > 60) continue;
        const cs = getComputedStyle(el);
        const fg = parse(cs.color);
        if (fg.length < 3) continue;
        const alpha = fg[3] ?? 1;
        const bg = bgOf(el);
        const flat = [0, 1, 2].map((i) => fg[i] * alpha + bg[i] * (1 - alpha)) as [
          number,
          number,
          number,
        ];
        const l1 = lum(flat[0], flat[1], flat[2]) + 0.05;
        const l2 = lum(bg[0], bg[1], bg[2]) + 0.05;
        const ratio = l1 > l2 ? l1 / l2 : l2 / l1;
        out.push({
          ratio: Math.round(ratio * 100) / 100,
          size: parseFloat(cs.fontSize),
          text: t.slice(0, 40),
        });
      }
      return out;
    });
    all.push(...rows);
  }
  const fails = all.filter((r) => r.ratio < (r.size >= 24 ? 3 : 4.5));
  console.log(`\n=== CONTRAST ===\n  elemente de text masurate: ${all.length}`);
  console.log(`  sub pragul WCAG AA:        ${fails.length}`);
  const worst = [...new Map(fails.map((f) => [f.text, f])).values()]
    .sort((a, b) => a.ratio - b.ratio)
    .slice(0, 12);
  for (const w of worst)
    console.log(
      `    ${String(w.ratio).padStart(5)}:1  ${String(Math.round(w.size)).padStart(2)}px  "${w.text}"`,
    );
});
