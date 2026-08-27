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
        // Playwright's bundled headless shell needs GTK/ATK libraries this box
        // does not have. `CHROMIUM_PATH` points at a system Chromium instead;
        // CI leaves it unset and keeps the bundled, pinned browser.
        ...(process.env.CHROMIUM_PATH
          ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } }
          : {}),
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
