import { test } from '@playwright/test';
test('@capture designer palette', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/admin/login/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  const out = await page.evaluate(() => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1;
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    const rgb = (c: string) => {
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    const srgb = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const lum = (c: string) => {
      const [r, g, b] = rgb(c);
      return 0.2126 * srgb(r / 255) + 0.7152 * srgb(g / 255) + 0.0722 * srgb(b / 255);
    };
    const ratio = (a: string, b: string) => {
      const l1 = lum(a) + 0.05,
        l2 = lum(b) + 0.05;
      return Math.round((l1 > l2 ? l1 / l2 : l2 / l1) * 100) / 100;
    };
    // oklch din hex: masuram lightness/chroma prin conversie inversa aproximativa
    const probe = document.createElement('div');
    document.body.appendChild(probe);
    const oklch = (hexv: string) => {
      probe.style.color = hexv;
      return getComputedStyle(probe).color;
    };
    const rows: string[] = [];
    const hex = (c: string) => {
      const [r, g, b] = rgb(c);
      return (
        '#' +
        [r, g, b]
          .map((v) => v.toString(16).padStart(2, '0'))
          .join('')
          .toUpperCase()
      );
    };
    rows.push('scara: acelasi hue 250, lightness si chroma variabile');
    rows.push('  L     C    hex        alb pe el   ca text pe #F7F9FC');
    for (const L of [0.44, 0.47, 0.5, 0.53]) {
      for (const C of [0.15, 0.18, 0.21]) {
        const col = `oklch(${L} ${C} 250)`;
        rows.push(
          `  ${L.toFixed(2)}  ${C.toFixed(2)}  ${hex(col)}   ${String(ratio('#ffffff', col)).padStart(6)}:1   ${String(ratio(col, '#F7F9FC')).padStart(6)}:1`,
        );
      }
    }
    rows.push('');
    rows.push('tente pentru rand selectat / nav activ (text inchis pe ele):');
    for (const t of ['#D6E3FF', '#DCE8FB', '#E7F0F8']) {
      rows.push(`  ${t}   ${String(ratio('#192029', t)).padStart(6)}:1`);
    }
    probe.remove();
    return rows;
  });
  console.log('\n=== PAIRS ===\n' + out.map((r) => '  ' + r).join('\n'));
});
