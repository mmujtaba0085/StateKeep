// @ts-check
import { defineConfig } from '@playwright/test';

// Ensure test runner sees the same admin key and a real sk_-format API key as the webServer
process.env.STATEKEEP_ADMIN_KEY ??= 'test-admin-key';
process.env.STATEKEEP_API_KEY   ??= 'sk_ab12cd34_0000000000000000000000000000000000000000';

const PORT    = process.env.PORT ?? '3001';
const BASE_URL = process.env.STATEKEEP_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  globalSetup: './test/globalSetup.js',
  testDir:     './test/e2e',
  timeout:   30_000,
  retries:   process.env.CI ? 2 : 0,
  workers:   1,   // Sequential — tests share a single server instance

  reporter: [
    ['list'],
    ['html', { outputFolder: 'test/e2e/reports', open: 'never' }],
  ],

  use: {
    baseURL:           BASE_URL,
    extraHTTPHeaders:  { 'x-api-key': process.env.STATEKEEP_API_KEY ?? '' },
  },

  webServer: {
    command:             'node src/api/server.js',
    url:                 `${BASE_URL}/v1/health`,
    reuseExistingServer: true,
    timeout:             15_000,
    env: {
      PORT,
      NODE_ENV:                 'test',
      STATEKEEP_DB_PATH:        'statekeep-test.db',
      STATEKEEP_ENCRYPTION_KEY: '0'.repeat(64),
      STATEKEEP_ADMIN_KEY:      'test-admin-key',
      STATEKEEP_API_KEY:        process.env.STATEKEEP_API_KEY,
      STATEKEEP_DATA_DIR:       process.env.STATEKEEP_DATA_DIR ?? '/tmp/sk-test-data',
      // Use local engine when path is set (inherits from shell via run-tests.sh)
      ...(process.env.STATEKEEP_ENGINE_PATH ? { STATEKEEP_ENGINE_PATH: process.env.STATEKEEP_ENGINE_PATH } : {}),
    },
  },

  projects: [
    {
      name: 'api',
      testMatch: /.*(?<!dashboard)\.(api|spec)\.js$/,
      use: {},
    },
    {
      name: 'dashboard',
      testMatch: /.*dashboard\.spec\.js$/,
      use: { browserName: 'chromium' },
    },
  ],
});
