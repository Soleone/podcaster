import { expect, test } from '@playwright/test';
import { emit, enterFakeSession } from './support/fake-browser-services';
import { startDevServer, stopDevServer, type DevServer } from './support/dev-server';

let server: DevServer;
test.beforeAll(async () => { server = await startDevServer({ fakeServices: true }); });
test.afterAll(async () => { await stopDevServer(server); });

test('streams a dimmed assistant preview before audio and solidifies it on final', async ({ page }) => {
  await enterFakeSession(page, server.origin);
  await expect(page.getByRole('heading', { name: 'Listening' })).toBeVisible();

  await emit(page, 'transcript.final', { turnId: 'turn-1', text: 'Tell me about perceived latency', endpointComplete: true });
  await emit(page, 'policy.decision', { turnId: 'turn-1', posture: 'question', eligible: true, reasonCodes: ['selected'] });
  await emit(page, 'reasoning.started', { turnId: 'turn-1', responseId: 'response-1', posture: 'question' });

  // Before the first preview arrives, the typing shimmer is the only signal and no
  // assistant bubble is rendered yet.
  await expect(page.locator('.assistant-activity')).toContainText('is typing…');
  expect(await page.locator('.assistant-bubble').count()).toBe(0);

  // The first preview renders the assistant row early, dimmed/tentative, and the
  // typing shimmer hands off to it.
  await emit(page, 'reasoning.delta', { turnId: 'turn-1', responseId: 'response-1', text: 'Perceived latency' });
  const preview = page.locator('.assistant-bubble.tentative');
  await expect(preview).toContainText('Perceived latency');
  await expect(page.locator('.assistant-activity')).toHaveCount(0);

  // Subsequent previews grow the same dimmed row in place.
  await emit(page, 'reasoning.delta', { turnId: 'turn-1', responseId: 'response-1', text: 'Perceived latency drops when text streams' });
  await expect(preview).toContainText('Perceived latency drops when text streams');
  expect(await page.locator('.assistant-bubble').count()).toBe(1);

  // The preview solidifies on reasoning.final, before any audio has started.
  await emit(page, 'reasoning.final', { turnId: 'turn-1', responseId: 'response-1', posture: 'question', text: 'Perceived latency drops when text streams first.' });
  await expect(page.locator('.assistant-bubble.tentative')).toHaveCount(0);
  await expect(page.locator('.assistant-bubble', { hasText: 'Perceived latency drops when text streams first.' })).toBeVisible();

  // Audio then starts and the row persists.
  await emit(page, 'tts.started', { responseId: 'response-1', playbackId: 'playback-1', sampleRate: 24000 });
  await expect(page.getByRole('heading', { name: 'Speaking' })).toBeVisible();
  await expect(page.locator('.assistant-bubble', { hasText: 'Perceived latency drops when text streams first.' })).toBeVisible();
});

test('drops a streaming preview when the response fails before finalizing', async ({ page }) => {
  await enterFakeSession(page, server.origin);
  await expect(page.getByRole('heading', { name: 'Listening' })).toBeVisible();

  await emit(page, 'transcript.final', { turnId: 'turn-1', text: 'Say something risky', endpointComplete: true });
  await emit(page, 'policy.decision', { turnId: 'turn-1', posture: 'riff', eligible: true, reasonCodes: ['selected'] });
  await emit(page, 'reasoning.started', { turnId: 'turn-1', responseId: 'response-1', posture: 'riff' });
  await emit(page, 'reasoning.delta', { turnId: 'turn-1', responseId: 'response-1', text: 'A preview that will not land' });
  await expect(page.locator('.assistant-bubble.tentative')).toContainText('A preview that will not land');

  await emit(page, 'response.failed', { turnId: 'turn-1', responseId: 'response-1', reasonCode: 'reasoning_invalid' });
  await expect(page.locator('.assistant-bubble')).toHaveCount(0);
});
