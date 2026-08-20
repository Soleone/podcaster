import { expect, test } from './support/dev-server';
import { installFakeMicrophone } from './support/fake-browser-services';

const readySnapshot = {
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
};

test('creates a not-started draft while Services owns readiness', async ({ page, origin }) => {
  await installFakeMicrophone(page);
  await page.route('**/api/readiness', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(readySnapshot) }));
  await page.goto(origin);
  await expect(page.getByRole('heading', { name: 'Your sessions' })).toBeVisible();
  await page.getByRole('button', { name: /Service status/ }).click();
  await expect(page.getByRole('heading', { name: 'Service status' })).toBeVisible();
  await expect(page.getByText('Audio server', { exact: true })).toBeVisible();
  await expect(page.getByText('Pi service', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'New session' }).click();
  await expect(page.getByRole('heading', { name: 'New session' })).toBeVisible();
  await expect(page.getByText('Not started', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start session' })).toBeDisabled();
  await expect(page.getByText(/Microphone access is the only remaining step/)).toBeVisible();
});

test('saves preparation on a draft and starts it only after services are ready', async ({ page, origin }) => {
  await installFakeMicrophone(page);
  await page.route('**/api/readiness', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(readySnapshot) }));
  await page.goto(origin);
  await page.getByRole('button', { name: 'New session' }).click();
  await page.getByRole('button', { name: 'Enable microphone' }).click();
  await page.getByLabel('Prepare before going live').check();
  await page.getByLabel('Rough topic').fill('The future of local radio');
  await page.getByLabel('Preparation depth').selectOption('deep');
  await expect(page.getByRole('button', { name: 'Prepare and start' })).toBeEnabled();
  await page.getByRole('button', { name: 'Prepare and start' }).click();
  await expect(page).toHaveURL(/\/session\//);
  await expect(page.getByRole('heading', { name: 'Listening' })).toBeVisible();
  await expect(page.getByText('Fake services are ready to go live.')).toBeVisible();
});
