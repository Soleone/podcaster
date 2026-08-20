import { expect, test } from './support/dev-server';
import { installFakeMicrophone } from './support/fake-browser-services';

test('creates drafts before connecting services and keeps privacy in the Services flow', async ({ page, origin }) => {
  await installFakeMicrophone(page);
  let bootstrapCalls = 0;
  page.on('request', request => { if (request.url().endsWith('/api/bootstrap')) bootstrapCalls++; });
  await page.goto(origin);
  await expect(page.getByRole('heading', { name: 'Your sessions' })).toBeVisible();
  expect(bootstrapCalls).toBe(0);

  await page.getByRole('button', { name: 'New session' }).click();
  await expect(page.getByRole('heading', { name: 'New session' })).toBeVisible();
  await expect(page.getByText('Not started', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start session' })).toBeDisabled();

  await page.getByRole('button', { name: /Service status/ }).click();
  const services = page.getByLabel('Service status', { exact: true });
  await expect(services.getByRole('button', { name: 'Review privacy & connect' })).toBeVisible();
  await services.getByRole('button', { name: 'Review privacy & connect' }).click();
  await expect(page.getByRole('dialog')).toContainText(/Speech recognition and voice playback run locally/);
  await expect(page.getByRole('dialog')).toContainText(/Raw audio and your full local history are not sent/);
  await page.getByRole('button', { name: 'Not now' }).click();
  expect(bootstrapCalls).toBe(0);
});

test('publishes readiness through the Services app bar after privacy is accepted', async ({ page, origin }) => {
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
      voiceCatalog: { catalogId: 'test-catalog', backendId: 'test', modelId: 'test-model', runtimeConfigId: 'test-config', revision: 'test-revision', defaultVoiceId: 'af_heart', voices: [{ id: 'af_heart', label: 'Heart' }],
      },
    }),
  }));
  await page.goto(origin);
  await page.getByRole('button', { name: /Service status/ }).click();
  await page.getByRole('button', { name: 'Review privacy & connect' }).click();
  await page.getByRole('button', { name: 'Continue and connect' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: /Service status/ }).click();
  await expect(page.getByText('Audio server', { exact: true })).toBeVisible();
  await expect(page.getByText('Pi service', { exact: true })).toBeVisible();
});
