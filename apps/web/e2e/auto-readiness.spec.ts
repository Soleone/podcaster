import { expect, test } from '@playwright/test';
import { installFakeMicrophone } from './support/fake-browser-services';
import { startDevServer, stopDevServer, type DevServer } from './support/dev-server';

let server: DevServer;
test.beforeAll(async () => { server = await startDevServer({ fakeServices: true }); });
test.afterAll(async () => { await stopDevServer(server); });

test('keeps the home page open after all three readiness checks turn green', async ({ page }) => {
  await installFakeMicrophone(page);
  await page.route('**/api/readiness', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      capabilities: [
        { id: 'voice_input', label: 'Voice input', state: 'ready', reason: '', action: '' },
        { id: 'voice_output', label: 'Voice output', state: 'ready', reason: '', action: '' },
        { id: 'cloud_reasoning', label: 'Cloud reasoning', state: 'ready', reason: '', action: '' },
      ],
      sidecar: 'ready',
      reasoning: 'ready',
      voiceCatalog: {
        catalogId: 'test-catalog', backendId: 'test', modelId: 'test-model', runtimeConfigId: 'test-config', revision: 'test-revision', defaultVoiceId: 'af_heart',
        voices: [{ id: 'af_heart', label: 'Heart' }],
      },
    }),
  }));
  await page.goto(server.origin);
  await page.getByRole('button', { name: 'Continue and check readiness' }).click();
  await expect(page.getByText('Voice input', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Enable microphone' }).click();
  await expect(page.getByRole('heading', { name: 'Readiness' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start session' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});
