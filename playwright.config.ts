/**
 * Playwright configuration for the milestone-A browser smoke (ruling R69).
 *
 * Chromium only — the spec asks for a smoke, not a browser matrix. The
 * `webServer` **builds and previews** the client, so the smoke exercises the
 * shipped bundle rather than a dev server with its own transform pipeline.
 *
 * `testDir` stays `e2e`, which is already excluded from vitest
 * (`vitest.config.ts`) and from `tsconfig.json`'s `include`, so the two runners
 * never collect each other's files.
 *
 * `expect.timeout` is raised to 15 s because playback is deliberately buffered:
 * at the default 1x speed the clock's 2,000 simulation-ms buffer means the
 * elapsed readout only leaves `0 s` about two seconds of wall time after the
 * first frame (`apps/client/src/clock.ts`). That is a longer *condition* wait,
 * not a fixed sleep — no spec in `e2e/` uses `waitForTimeout`.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const isCI = process.env.CI !== undefined && process.env.CI !== '';

export default defineConfig({
  testDir: 'e2e',
  // Bulk output (traces, screenshots on failure) lands in the gitignored artifacts tree.
  outputDir: 'artifacts/playwright',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: isCI ? 1 : undefined,
  reporter: [['list']],
  expect: { timeout: 15_000 },
  timeout: 90_000,
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // `--host 127.0.0.1` is load-bearing: vite preview's default binds only to
    // the IPv6 loopback, so a plain 127.0.0.1 readiness probe never connects.
    command: `pnpm --filter @narok/client build && pnpm --filter @narok/client preview --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `${BASE_URL}/`,
    reuseExistingServer: !isCI,
    timeout: 180_000,
  },
});
