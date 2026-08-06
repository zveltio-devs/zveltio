import { chromium } from '@playwright/test';

/**
 * Whether a browser can actually launch here.
 *
 * `playwright install chromium` downloads the binary; `--with-deps` installs
 * the system libraries it links against, and that needs root. On a workstation
 * without them, Chromium exits 127 and every browser test fails with a stack
 * trace about process spawning — which reads like the application is broken.
 *
 * So the browser journeys skip when no browser exists. That is a dangerous kind
 * of convenience: a suite whose most valuable tests quietly disappear is worse
 * than no suite, because the green tick still arrives. Two things keep it
 * honest:
 *
 *   - The skip prints WHY, with the command that fixes it.
 *   - In CI it does not skip. `CI=true` makes this return true unconditionally,
 *     so a runner missing its dependencies fails loudly instead of reporting a
 *     pass over four tests that never ran.
 */
let cached: boolean | null = null;

export async function browserAvailable(): Promise<boolean> {
  if (process.env.CI) return true;
  if (cached !== null) return cached;

  try {
    const browser = await chromium.launch();
    await browser.close();
    cached = true;
  } catch (err) {
    cached = false;
    console.warn(
      '\n[e2e] Skipping browser journeys — Chromium cannot launch here.\n' +
        `      ${(err as Error).message.split('\n')[0]}\n` +
        '      Fix with:  sudo bun x playwright install --with-deps chromium\n' +
        '      The API journeys below still run. CI never skips these.\n',
    );
  }
  return cached;
}
