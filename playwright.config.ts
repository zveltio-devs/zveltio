import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end smoke suite.
 *
 * This is deliberately small and will stay small. The Studio has 79 admin
 * pages; covering them here would produce a suite that is slow, brittle, and
 * mostly a re-test of SvelteKit. What browsers are for is the class of failure
 * nothing else in this repository can see:
 *
 *   - An external audit lost its whole Studio pass to a blank admin page. The
 *     HTML was valid and `curl` returned 200; the bundle was built for a
 *     different engine and the JS died on an API shape that had changed. No
 *     unit test, component test or HTTP probe observes that.
 *
 *   - Accepting an invitation as `admin` answered 500 and left a half-created
 *     account. It was found by driving the flow, not by reading it.
 *
 * So the journeys here are the ones where a real failure has actually happened,
 * plus the two boundaries worth watching continuously.
 *
 * Run separately from the main CI on purpose. E2E is the flakiest kind of test
 * and this repository has already lost time to a webhook race in a UNIT test —
 * a browser suite blocking merges would be paid for daily.
 */
export default defineConfig({
  testDir: './e2e/tests',
  // Sequential. The suite shares one engine and one database, and a login in
  // one test invalidating a session in another is a debugging cost nobody
  // asked for. It is ten journeys, not a grid.
  workers: 1,
  fullyParallel: false,
  // A failure here should be reproducible, not retried until it passes: a test
  // that only succeeds sometimes is telling us something.
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3399',
    // Both on failure only — a blank page is exactly the failure this suite
    // exists for, and a screenshot of it is worth more than the assertion text.
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // The full browser, headless — NOT the bundled headless shell.
        //
        // Since Playwright 1.49 the default is `chrome-headless-shell`, a
        // smaller binary. That binary segfaults here: `browser.newContext` fails
        // with `Target page, context or browser has been closed`, and the
        // browser stderr carries `Received signal 11 SEGV_MAPERR 0000000001b0` —
        // the same fault address every time. It failed 8 of 19 runs on master,
        // always on whatever spec sat in one particular slot: on 2026-08-27
        // 10:55 that was `zz-design-capture`, and when `zz-align-guard` was
        // added forty minutes later the identical crash moved onto it.
        //
        // We are already on the newest published Playwright (1.62.1), so there
        // is no newer shell to move to. `channel: 'chromium'` selects the full
        // Chromium build instead — a different binary, running headless via
        // `--headless=new`. The suite is ten journeys; the extra startup cost is
        // paid once per run and buys a browser that does not die mid-suite.
        //
        // A retry would also make the suite green. It would also make every
        // future crash invisible, and this one took a day to find precisely
        // because it looked like flakiness.
        // Playwright's bundled browsers need GTK/ATK libraries some machines do
        // not have. `CHROMIUM_PATH` points at a system Chromium instead; CI
        // leaves it unset and takes the bundled build through the channel.
        //
        // The two are mutually exclusive — an explicit `executablePath` is the
        // binary, and naming a channel as well asks for two different ones.
        ...(process.env.CHROMIUM_PATH
          ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } }
          : { channel: 'chromium' }),
      },
    },
  ],

  webServer: {
    command: 'bun e2e/setup/boot.ts',
    url: 'http://127.0.0.1:3399/health',
    // Migrations plus a Studio-serving boot; generous, because a timeout here
    // reads as "the app is broken" when it means "the machine was busy".
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
