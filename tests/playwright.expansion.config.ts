// E2E expansion config — runs the FULL suite (legacy 4 files + new feature
// specs) against the app served on :4010 (fresh `npm run build` +
// `npx vite preview --port 4010`). Isolated from the root playwright.config
// (:4174) so parallel agent sessions don't fight over the strictPort server.
// List-only reporter: avoids clobbering the shared playwright-report/ dir.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  expect: { timeout: 8000 },
  fullyParallel: false,
  forbidOnly: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4010',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npx vite preview --port 4010 --host 127.0.0.1 --strictPort',
    port: 4010,
    reuseExistingServer: true,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
