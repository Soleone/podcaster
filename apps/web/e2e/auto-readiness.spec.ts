import { expect, test } from './support/dev-server';
import { installFakeMicrophone } from './support/fake-browser-services';

test('keeps the home page open after all three readiness checks turn green', async ({ page, origin }) => {
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
  await page.goto(origin);
  await page.getByRole('button', { name: 'Continue and check readiness' }).click();
  await expect(page.getByText('Voice input', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Enable microphone' }).click();
  await expect(page.getByRole('heading', { name: 'Readiness' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start session' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test('offers bounded optional preparation settings without changing the direct start default', async ({ page, origin }) => {
  await installFakeMicrophone(page);
  await page.route('**/api/readiness', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      capabilities: [
        { id: 'voice_input', label: 'Voice input', state: 'ready', reason: '', action: '' },
        { id: 'voice_output', label: 'Voice output', state: 'ready', reason: '', action: '' },
        { id: 'cloud_reasoning', label: 'Cloud reasoning', state: 'ready', reason: '', action: '' },
      ], sidecar: 'ready', reasoning: 'ready', voiceCatalog: { catalogId: 'test-catalog', backendId: 'test', modelId: 'test-model', runtimeConfigId: 'test-config', revision: 'test-revision', defaultVoiceId: 'af_heart', voices: [{ id: 'af_heart', label: 'Heart' }] },
    }),
  }));
  await page.goto(origin);
  await page.getByRole('button', { name: 'Continue and check readiness' }).click();
  await page.getByRole('button', { name: 'Enable microphone' }).click();
  await expect(page.getByRole('button', { name: 'Start session' })).toBeVisible();
  await page.getByLabel('Prepare before going live').check();
  await page.getByLabel('Rough topic').fill('The future of local radio');
  await page.getByLabel('Preparation depth').selectOption('deep');
  await expect(page.getByRole('button', { name: 'Prepare and start session' })).toBeVisible();
  await page.getByRole('button', { name: 'Prepare and start session' }).click();
  await expect(page).toHaveURL(/\/session\//);
  await expect(page.getByRole('heading', { name: 'Listening' })).toBeVisible();
  await expect(page.getByText('Fake services are ready to go live.')).toBeVisible();
});
