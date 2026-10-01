/**
 * Playwright configuration for the milestone-A browser smoke (ruling R69).
 *
 * Chromium only — the spec asks for a smoke, not a browser matrix. Each
 * `webServer` **builds and previews** its app, so the smoke exercises the
 * shipped bundle rather than a dev server with its own transform pipeline.
 *
 * Two projects since milestone B Task 8 split the laboratory out of the
 * client: `chromium` drives the engine-free client (`e2e/client.spec.ts`) and
 * `lab` drives the laboratory (`e2e/laboratory.spec.ts`, milestone A's smoke,
 * unchanged) on its own port.
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
const LAB_PORT = 4174;
const LAB_URL = `http://127.0.0.1:${LAB_PORT}`;
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
  projects: [
    {
      name: 'chromium',
      testMatch: 'client.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: BASE_URL },
    },
    {
      name: 'lab',
      testMatch: 'laboratory.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: LAB_URL },
    },
  ],
  webServer: [
    {
      // `--host 127.0.0.1` is load-bearing: vite preview's default binds only to
      // the IPv6 loopback, so a plain 127.0.0.1 readiness probe never connects.
      command: `pnpm --filter @narok/client build && pnpm --filter @narok/client preview --port ${PORT} --strictPort --host 127.0.0.1`,
      url: `${BASE_URL}/`,
      reuseExistingServer: !isCI,
      timeout: 180_000,
    },
    {
      command: `pnpm --filter @narok/lab build && pnpm --filter @narok/lab preview --port ${LAB_PORT} --strictPort --host 127.0.0.1`,
      url: `${LAB_URL}/`,
      reuseExistingServer: !isCI,
      timeout: 180_000,
    },
  ],
});
