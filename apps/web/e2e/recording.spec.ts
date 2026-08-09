import { expect, test } from '@playwright/test';
import { emit, enterFakeSession } from './support/fake-browser-services';
import { startDevServer, stopDevServer, type DevServer } from './support/dev-server';
let server: DevServer;
test.beforeAll(async () => { server = await startDevServer({ fakeServices: true }); });
test.afterAll(async () => { await stopDevServer(server); });

const STREAM = '018f1f32-7abf-7def-8abc-0123456789ab';
const UTTERANCE = '018f1f32-7ac0-7def-8abc-0123456789ab';

test('records a turn, exports an MP3 download, and deletes the recording', async ({ page }) => {
  await enterFakeSession(page, server.origin);
  const toggle = page.getByLabel('Record this session');
  await toggle.check();
  await expect(page.getByLabel('Recording status: 0 items')).toBeVisible();

  await emit(page, 'vad.speech_start', { streamId: STREAM, utteranceId: UTTERANCE, captureStartSequence: 0 });
  // Tap one more capture frame after the VAD relay opened the slice.
  await page.evaluate(() => window.__podcasterTest!.capture());
  await emit(page, 'vad.speech_end', { streamId: STREAM, utteranceId: UTTERANCE, captureStartSequence: 0, captureEndSequence: 1 });
  await emit(page, 'transcript.final', { turnId: UTTERANCE, text: 'Recorded words', endpointComplete: true });
  await expect(page.getByLabel('Recording status: 1 item')).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^podcaster-[0-9a-f]{8}-\d{4}-\d{2}-\d{2}\.mp3$/);

  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByLabel('Recording status: 0 items')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export' })).toBeDisabled();
});
