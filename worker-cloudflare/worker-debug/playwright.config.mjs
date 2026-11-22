import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = Number(process.env.LOOKME_DEBUG_TEST_PORT || 8791);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('LOOKME_DEBUG_TEST_PORT 无效');

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.mjs',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  retries: 0,
  reporter: 'list',
  outputDir: mkdtempSync(join(tmpdir(), 'lookme-debug-ui-')),
  use: {
    baseURL: `http://localhost:${port}`,
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `npm run dev -- --port ${port} --inspector-port 0 --var DEBUG_PASSWORD:local-ui-fixture`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 60000,
    env: { WRANGLER_SEND_METRICS: 'false' },
  },
});
