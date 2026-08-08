import { expect, test } from '@playwright/test';
import { emit, enterFakeSession } from './support/fake-browser-services';
import { startDevServer, stopDevServer, type DevServer } from './support/dev-server';
let server: DevServer;
test.beforeAll(async () => { server = await startDevServer({ fakeServices: true }); });
test.afterAll(async () => { await stopDevServer(server); });

test('runs stable session states and recovers stable work after refresh', async ({ page }) => {
  await enterFakeSession(page, server.origin);
  await expect(page.getByRole('heading', { name: 'Listening' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__podcasterTest!.stats().captureFrames)).toBe(1);
  expect(await page.evaluate(() => ({ running: window.__podcasterTest!.stats().captureRunning, mediaCalls: (window as unknown as { getUserMediaCalls: number }).getUserMediaCalls }))).toEqual({ running: true, mediaCalls: 2 });
  await page.evaluate(async () => window.__podcasterTest!.partial('tentative words'));
  await expect(page.locator('.tentative')).toContainText('tentative words');
  await emit(page, 'transcript.final', { turnId: 'turn-1', text: 'A stable thought', endpointComplete: true });
  await expect(page.getByText('A stable thought')).toBeVisible();
  await expect(page.locator('.tentative')).toHaveCount(0);
  await emit(page, 'policy.decision', { turnId: 'turn-1', posture: 'silence', eligible: true, reasonCodes: ['response_budget_exhausted'] });
  await expect(page.getByRole('heading', { name: 'Giving you space' })).toBeVisible();
  await expect(page.getByText('Companion stayed quiet · response limit')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Listening' })).toBeVisible({ timeout: 2_000 });

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Listening' })).toBeVisible();
  await expect(page.getByText('A stable thought')).toBeVisible();
  await expect(page.getByText('Companion stayed quiet · response limit')).toBeVisible();

  await emit(page, 'transcript.final', { turnId: 'turn-empty', text: '', endpointComplete: true });
  await emit(page, 'policy.decision', { turnId: 'turn-empty', posture: 'silence', eligible: false, reasonCodes: ['empty'] });
  await expect(page.locator('.conversation article')).toHaveCount(1);
  await emit(page, 'transcript.final', { turnId: 'turn-2', text: 'Please respond to this thought', endpointComplete: true });
  await emit(page, 'policy.decision', { turnId: 'turn-2', posture: 'question', eligible: true, reasonCodes: ['selected'] });
  await expect(page.getByText('Reply selected')).toBeVisible();

  await emit(page, 'reasoning.final', { turnId: 'turn-1', responseId: 'response-1', posture: 'question', text: 'What matters most?' });
  await emit(page, 'tts.started', { responseId: 'response-1', playbackId: 'playback-1', sampleRate: 24000 });
  await emit(page, 'tts.ended', { responseId: 'response-1', playbackId: 'playback-1', generatedSamples: 1000 });
  await page.evaluate(() => window.__podcasterTest!.audio('playback-1', 0, 400));
  await expect.poll(() => page.evaluate(() => window.__podcasterTest!.stats().progressReports)).toBe(1);
  await expect(page.getByRole('heading', { name: 'Speaking' })).toBeVisible();
  await emit(page, 'barge_in.provisional', { responseId: 'response-1', outputEpoch: 0, resumable: true });
  await expect.poll(() => page.evaluate(() => window.__podcasterTest!.stats().playbackPauses)).toBe(1);
  await expect(page.getByRole('button', { name: 'Stop response and listen' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop response and listen' }).click();
  await expect(page.getByRole('heading', { name: 'Listening' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__podcasterTest!.stats().terminalReceipts)).toBe(1);
  const stats = await page.evaluate(() => window.__podcasterTest!.stats());
  expect(stats).toMatchObject({ playbackStops: ['cancelled'] });
  expect(stats.commands.at(-1)).toBe('confirm');
  await page.getByRole('button', { name: 'Stop session' }).click();
  await expect(page.getByRole('heading', { name: 'Session stopped' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__podcasterTest!.stats().captureStops)).toBe(1);
  await expect(page.getByRole('button', { name: 'Stop session' })).toBeVisible();
});
