import { expect, test } from '@playwright/test';
import { emit, enterFakeSession } from './support/fake-browser-services';
import { startDevServer, stopDevServer, type DevServer } from './support/dev-server';
let server: DevServer;
test.beforeAll(async () => { server = await startDevServer({ fakeServices: true }); });
test.afterAll(async () => { await stopDevServer(server); });

const STREAM = '018f1f32-7abf-7def-8abc-0123456789ab';
const UTTERANCE = '018f1f32-7ac0-7def-8abc-0123456789ab';

async function recordUserTurn(page: import('@playwright/test').Page): Promise<void> {
  await emit(page, 'vad.speech_start', { streamId: STREAM, utteranceId: UTTERANCE, captureStartSequence: 0 });
  // Tap one more capture frame after the VAD relay opened the slice.
  await page.evaluate(() => window.__podcasterTest!.capture());
  await emit(page, 'vad.speech_end', { streamId: STREAM, utteranceId: UTTERANCE, captureStartSequence: 0, captureEndSequence: 1 });
  await emit(page, 'transcript.final', { turnId: UTTERANCE, text: 'Recorded words', endpointComplete: true });
}

test('trims completed agent output with a compact in-bubble action', async ({ page }) => {
  await enterFakeSession(page, server.origin);
  await page.getByLabel('Record this session').click();

  await emit(page, 'reasoning.started', { turnId: 'turn-1', responseId: 'response-1', posture: 'question' });
  await emit(page, 'reasoning.final', { turnId: 'turn-1', responseId: 'response-1', posture: 'question', text: 'A recorded answer' });
  await emit(page, 'tts.started', { responseId: 'response-1', playbackId: 'playback-1', sampleRate: 24000 });
  await page.evaluate(() => window.__podcasterTest!.audio('playback-1', 0, 480));
  await emit(page, 'playback.stopped', { playbackId: 'playback-1', cancelledEpoch: 0, finalPlayedSampleOffset: 480, reason: 'completed' });

  await expect(page.getByText('A recorded answer')).toBeVisible();
  const remove = page.getByRole('button', { name: "Remove Assistant's response from recording" });
  await expect(remove).toBeVisible();
  await emit(page, 'tts.started', { responseId: 'response-1', playbackId: 'playback-2', sampleRate: 24000, partIndex: 1 });
  await expect(remove).toBeEnabled();
  await expect(remove.locator('xpath=ancestor::*[@data-slot="bubble-content"]')).toHaveCount(1);
  await expect(remove).toHaveCSS('height', '24px');
  await remove.click();
  await expect(page.getByRole('button', { name: "Undo removal of Assistant's response" })).toBeVisible();
  await expect(page.locator('.conversation-bubble.assistant-bubble.trimmed')).toHaveAttribute('data-trimmed', 'true');
});

test('trims one assistant part without removing the rest of its bubble', async ({ page }) => {
  await enterFakeSession(page, server.origin);
  await page.getByLabel('Record this session').click();

  await emit(page, 'reasoning.started', { turnId: 'turn-parts', responseId: 'response-parts', posture: 'riff', partIndex: 0 });
  await emit(page, 'reasoning.final', { turnId: 'turn-parts', responseId: 'response-parts', posture: 'riff', text: 'The quick acknowledgement.', partIndex: 0 });
  await emit(page, 'tts.started', { responseId: 'response-parts', playbackId: 'playback-part-0', sampleRate: 24000, partIndex: 0 });
  await page.evaluate(() => window.__podcasterTest!.audio('playback-part-0', 0, 480));
  await emit(page, 'tts.ended', { responseId: 'response-parts', playbackId: 'playback-part-0', generatedSamples: 480, partIndex: 0 });
  await page.waitForTimeout(25);

  await emit(page, 'reasoning.started', { turnId: 'turn-parts', responseId: 'response-parts', posture: 'riff', partIndex: 1 });
  await emit(page, 'reasoning.final', { turnId: 'turn-parts', responseId: 'response-parts', posture: 'riff', text: 'The longer body response.', partIndex: 1 });
  await emit(page, 'tts.started', { responseId: 'response-parts', playbackId: 'playback-part-1', sampleRate: 24000, partIndex: 1 });
  await page.evaluate(() => window.__podcasterTest!.audio('playback-part-1', 0, 480));
  await emit(page, 'tts.ended', { responseId: 'response-parts', playbackId: 'playback-part-1', generatedSamples: 480, partIndex: 1 });

  await expect(page.getByLabel('Recording status: 2 of 2 messages included')).toBeVisible();
  await expect(page.getByText('The quick acknowledgement.')).toBeVisible();
  await expect(page.getByText('The longer body response.')).toBeVisible();

  const removePart = page.getByRole('button', { name: "Remove Assistant's part 2 from recording" });
  await expect(removePart).toBeVisible();
  await removePart.click();

  await expect(page.getByLabel('Recording status: 1 of 2 messages included')).toBeVisible();
  await expect(page.locator('[data-part-index="1"][data-trimmed="true"]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: "Undo removal of Assistant's part 2" })).toBeVisible();
  await expect(page.getByText('The quick acknowledgement.')).toBeVisible();

  await page.getByRole('button', { name: "Undo removal of Assistant's part 2" }).click();
  await expect(page.getByLabel('Recording status: 2 of 2 messages included')).toBeVisible();
  await expect(page.getByRole('button', { name: "Remove Assistant's part 2 from recording" })).toBeVisible();
});

test('records a turn, trims the bubble, restores it after reload, exports, and deletes', async ({ page }) => {
  await enterFakeSession(page, server.origin);
  const toggle = page.getByLabel('Record this session');
  await toggle.click();
  await expect(page.getByLabel('Recording status: 0 items')).toBeVisible();

  await recordUserTurn(page);
  await expect(page.getByLabel('Recording status: 1 of 1 messages included')).toBeVisible();

  // The persisted user message exposes a trim control.
  const remove = page.getByRole('button', { name: 'Remove your message from recording' });
  await expect(remove).toBeVisible();

  // Remove the message from the recording.
  await remove.click();
  await expect(page.getByRole('button', { name: 'Undo removal of your message' })).toBeVisible();
  // The message stays in the transcript.
  await expect(page.getByText('Recorded words')).toBeVisible();
  // Trimmed presentation: state text, dimmed/line-through styling, data attribute.
  await expect(page.getByText('Not included in recording')).toBeVisible();
  const trimmedBubble = page.locator('.conversation-bubble.user-bubble.trimmed');
  await expect(trimmedBubble).toHaveAttribute('data-trimmed', 'true');
  // It was the only included item, so Export is disabled; Delete stays enabled.
  await expect(page.getByRole('button', { name: 'Export' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Delete' })).toBeEnabled();
  await expect(page.getByLabel('Recording status: 0 of 1 messages included')).toBeVisible();

  // Reload the active fake session: trimmed presentation and Undo are restored
  // from IndexedDB before actions are exposed.
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__podcasterTest));
  await expect(page.getByRole('button', { name: 'Undo removal of your message' })).toBeVisible();
  await expect(page.getByText('Not included in recording')).toBeVisible();
  await expect(page.locator('.conversation-bubble.user-bubble.trimmed')).toHaveAttribute('data-trimmed', 'true');
  await expect(page.getByLabel('Recording status: 0 of 1 messages included')).toBeVisible();

  // Undo restores the message and re-enables export.
  await page.getByRole('button', { name: 'Undo removal of your message' }).click();
  await expect(page.getByRole('button', { name: 'Remove your message from recording' })).toBeVisible();
  await expect(page.getByLabel('Recording status: 1 of 1 messages included')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export' })).toBeEnabled();

  // Export an MP3 download.
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^podcaster-[0-9a-f]{8}-\d{4}-\d{2}-\d{2}\.mp3$/);

  // Whole-recording delete stays available even after all this.
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByLabel('Recording status: 0 items')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export' })).toBeDisabled();
});
