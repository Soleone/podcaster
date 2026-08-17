import { expect, test, type Page } from '@playwright/test';
import { installFakeMicrophone } from './support/fake-browser-services';
import { startDevServer, stopDevServer, type DevServer } from './support/dev-server';

// QW-8 backend-toggle UI coverage. The readiness and preview endpoints are
// routed so the switch path is deterministic: two verified TTS models (Kokoro
// and Qwen CustomVoice) with distinct voice catalogs and speed capabilities,
// independent of which models happen to be installed on the test machine.

const kokoroCatalog = {
  catalogId: 'kokoro-catalog-v1',
  backendId: 'kokoro',
  modelId: 'kokoro-82m-onnx',
  runtimeConfigId: 'kokoro-runtime-v1',
  revision: 'kokoro-rev-1',
  defaultVoiceId: 'af_heart',
  speed: { supported: true, min: 0.5, max: 2.0, default: 1.0 },
  voices: [
    { id: 'af_heart', label: 'Heart' },
    { id: 'af_bella', label: 'Bella' },
  ],
};
const qwenCatalog = {
  catalogId: 'qwen-catalog-v1',
  backendId: 'qwen3',
  modelId: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
  runtimeConfigId: 'qwen-runtime-v1',
  revision: 'qwen-rev-1',
  defaultVoiceId: 'Ryan',
  // faster-qwen's CustomVoice generator has no playback-speed parameter; the
  // declared capability is fixed at 1.0, so any Kokoro speed must be reset.
  speed: { supported: false, min: 1.0, max: 1.0, default: 1.0 },
  voices: [
    { id: 'Ryan', label: 'Ryan' },
    { id: 'Serena', label: 'Serena' },
  ],
};

function readinessSnapshot() {
  return {
    capabilities: [
      { id: 'voice_input', label: 'Voice input', state: 'ready', reason: 'Microphone access is allowed.', action: 'No action needed.' },
      { id: 'voice_output', label: 'Voice output', state: 'ready', reason: 'Kokoro CUDA is ready. Your local audio engine is running.', action: 'No action needed.' },
      { id: 'cloud_reasoning', label: 'Cloud reasoning', state: 'ready', reason: 'Pi is ready.', action: 'No action needed.' },
    ],
    sidecar: 'ready',
    reasoning: 'ready',
    voiceCatalog: kokoroCatalog,
    ttsModels: [
      { backendId: 'kokoro', modelId: 'kokoro-82m-onnx', label: 'Kokoro CUDA', status: 'ready', speed: kokoroCatalog.speed, voiceCatalog: kokoroCatalog },
      { backendId: 'qwen3', modelId: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice', label: 'Qwen CustomVoice', status: 'ready', speed: qwenCatalog.speed, voiceCatalog: qwenCatalog },
    ],
    activeTtsModel: { backendId: 'kokoro', modelId: 'kokoro-82m-onnx' },
  };
}

/** One second of 16 kHz mono silence, a real WAV so the fake decoder sees one. */
function silentWav(): Buffer {
  const sampleRate = 16_000;
  const dataSize = sampleRate * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

async function openSettings(page: Page): Promise<void> {
  await page.goto(server.origin);
  await page.getByRole('button', { name: 'Continue and check readiness' }).click();
  await page.getByRole('button', { name: 'Enable microphone' }).click();
  await page.getByRole('button', { name: /Open settings/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.getByRole('tab', { name: 'Voice' }).click();
}

let server: DevServer;
test.beforeAll(async () => { server = await startDevServer({ fakeServices: true }); });
test.afterAll(async () => { await stopDevServer(server); });

test('switching the TTS backend reconciles voice and speed controls and previews through the selected backend', async ({ page }) => {
  await installFakeMicrophone(page);
  const previewRequests: Array<Record<string, unknown>> = [];
  await page.route('**/api/readiness', async route => { await route.fulfill({ json: readinessSnapshot() }); });
  await page.route('**/api/voice-preview', async route => {
    previewRequests.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ contentType: 'audio/wav', body: silentWav() });
  });
  await openSettings(page);

  // Kokoro is the verified default with its own catalog and speed range.
  await expect(page.getByRole('combobox', { name: 'Speech model' })).toContainText('Kokoro CUDA');
  await page.getByRole('combobox', { name: 'Voice' }).click();
  await page.getByRole('option', { name: 'Bella' }).click();
  await page.getByLabel('Speed modifier').fill('1.25');

  // Switching to Qwen swaps the authoritative catalog: the Kokoro-only voice
  // disappears, and the unsupported 1.25 speed is reset to Qwen's fixed 1.0.
  await page.getByRole('combobox', { name: 'Speech model' }).click();
  await page.getByRole('option', { name: 'Qwen CustomVoice' }).click();
  await expect(page.getByRole('combobox', { name: 'Voice' })).toContainText('Ryan');
  await expect(page.getByRole('combobox', { name: 'Voice' })).not.toContainText('Bella');
  await expect(page.getByLabel('Speed modifier')).toBeDisabled();
  await expect(page.getByLabel('Speed modifier')).toHaveValue('1');
  await expect(page.getByText('Your saved voice is no longer available on the current audio engine. The verified default was selected instead.')).toBeVisible();

  // The preview request carries the Qwen backend, model, catalog, and the
  // fixed speed, proving the selected backend reaches the adapter contract.
  await page.getByRole('button', { name: 'Preview voice' }).click();
  await expect.poll(() => previewRequests.length).toBeGreaterThan(0);
  expect(previewRequests.at(-1)).toMatchObject({
    backendId: 'qwen3',
    modelId: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
    catalogId: 'qwen-catalog-v1',
    voiceId: 'Ryan',
    speedModifier: 1,
  });

  // Switching back to Kokoro restores the still-valid per-backend profile
  // (Bella at 1.25) instead of reusing Qwen's fixed-speed default.
  await page.getByRole('combobox', { name: 'Speech model' }).click();
  await page.getByRole('option', { name: 'Kokoro CUDA' }).click();
  await expect(page.getByRole('combobox', { name: 'Voice' })).toContainText('Bella');
  await expect(page.getByLabel('Speed modifier')).toBeEnabled();
  await expect(page.getByLabel('Speed modifier')).toHaveValue('1.25');
});

test('a selected Qwen backend persists across reload and survives with its own voice profile', async ({ page }) => {
  await installFakeMicrophone(page);
  await page.route('**/api/readiness', async route => { await route.fulfill({ json: readinessSnapshot() }); });
  await page.route('**/api/voice-preview', async route => { await route.fulfill({ contentType: 'audio/wav', body: silentWav() }); });
  await openSettings(page);

  await page.getByRole('combobox', { name: 'Speech model' }).click();
  await page.getByRole('option', { name: 'Qwen CustomVoice' }).click();
  await page.getByRole('combobox', { name: 'Voice' }).click();
  await page.getByRole('option', { name: 'Serena' }).click();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The selection is a stored per-backend profile, not an in-memory choice.
  await page.reload();
  await page.getByRole('button', { name: /Open settings/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.getByRole('tab', { name: 'Voice' }).click();
  await expect(page.getByRole('combobox', { name: 'Speech model' })).toContainText('Qwen CustomVoice');
  await expect(page.getByRole('combobox', { name: 'Voice' })).toContainText('Serena');
  await expect(page.getByLabel('Speed modifier')).toBeDisabled();
  await expect(page.getByLabel('Speed modifier')).toHaveValue('1');
});