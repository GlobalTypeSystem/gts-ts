import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/csp',
  testMatch: '**/*.spec.ts',
  outputDir: '.tmp/playwright-results',
  reporter: 'list',
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
