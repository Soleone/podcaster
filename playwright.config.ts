import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'apps/web/e2e',
  timeout: 20_000,
  use: { browserName: 'chromium' },
  workers: 1,
  projects: [
    {
      name: 'fake-services',
      testMatch: '**/*.spec.ts',
      testIgnore: '**/readiness.spec.ts',
    },
    {
      name: 'real-readiness',
      testMatch: '**/readiness.spec.ts',
    },
  ],
});
