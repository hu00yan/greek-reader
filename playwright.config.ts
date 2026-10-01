import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 8000 },
  fullyParallel: false,
  forbidOnly: false,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:4174',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npx vite preview --port 4174 --host 127.0.0.1 --strictPort',
    port: 4174,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Playwright 1.49 pins chromium-1148, which is not in this machine's
        // ms-playwright cache (1187/1243 are). Fall back to an installed
        // build so the suite runs without a fresh `playwright install`.
        launchOptions: {
          executablePath: process.env.CHROME_PATH
            || `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1187/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
        },
      },
    },
  ],
});
