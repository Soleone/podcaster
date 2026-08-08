import { expect, test } from '@playwright/test';
import { emit, enterFakeSession } from './support/fake-browser-services';
import { startDevServer, stopDevServer, type DevServer } from './support/dev-server';
let server: DevServer;
test.beforeAll(async () => { server = await startDevServer({ fakeServices: true }); });
test.afterAll(async () => { await stopDevServer(server); });

test('restrains live announcements and keeps interruption controls keyboard accessible', async ({ page }) => {
  await enterFakeSession(page, server.origin);
  const live = page.getByRole('status');
  await expect(live).toHaveText('Listening');
  for (let index = 0; index < 12; index++) await page.evaluate(async text => window.__podcasterTest!.partial(text), `revision ${index}`);
  await expect(page.getByText('revision 11')).toBeVisible();
  await expect(live).toHaveText('Listening');
  await expect(live).not.toContainText('revision');

  await emit(page, 'reasoning.final', { turnId: 'turn', responseId: 'response', posture: 'question', text: 'A concise answer' });
  await emit(page, 'tts.started', { responseId: 'response', playbackId: 'playback', sampleRate: 24000 });
  await expect(page.getByRole('button', { name: 'Stop speaking' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Listening' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__podcasterTest!.stats().commands)).toContain('cancel');
  await expect.poll(() => page.evaluate(() => window.__podcasterTest!.stats().terminalReceipts)).toBe(1);
  await expect(page.getByRole('button', { name: 'Stop session' })).toBeVisible();

  await emit(page, 'tts.started', { responseId: 'response-2', playbackId: 'playback-2', sampleRate: 24000 });
  await emit(page, 'barge_in.provisional', { responseId: 'response-2', outputEpoch: 0, resumable: true });
  const yes = page.getByRole('button', { name: 'Yes, listen' });
  await expect(yes).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'No, continue' })).toBeFocused();
  await page.evaluate(() => window.__podcasterTest!.echoRecovered(true));
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__podcasterTest!.stats().commands)).toContain('reject');
  await emit(page, 'barge_in.rejected', { responseId: 'response-2', outputEpoch: 0, resumable: true });
  await expect.poll(() => page.evaluate(() => window.__podcasterTest!.stats().playbackResumes)).toBe(1);
  await expect(page.getByRole('heading', { name: 'Speaking' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Stop session' })).toBeVisible();
});
