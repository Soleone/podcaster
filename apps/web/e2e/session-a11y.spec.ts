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
  const continueButton = page.getByRole('button', { name: 'Continue previous response' });
  await continueButton.focus();
  await expect(continueButton).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Respond to me instead' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await page.evaluate(() => window.__podcasterTest!.echoRecovered(true));
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__podcasterTest!.stats().commands)).toContain('reject');
  await emit(page, 'barge_in.rejected', { responseId: 'response-2', outputEpoch: 0, resumable: true });
  await expect.poll(() => page.evaluate(() => window.__podcasterTest!.stats().playbackResumes)).toBe(1);
  await expect(page.getByRole('heading', { name: 'Speaking' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop session' })).toBeVisible();
});

test('activity log panel is keyboard-operable and lists session events', async ({ page }) => {
  await enterFakeSession(page, server.origin);
  const toggle = page.getByRole('button', { name: 'Activity log' });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const region = page.getByRole('region', { name: 'Activity log entries' });
  await expect(region).toBeVisible();
  await expect(region.getByText(/session started/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(region.getByText('No activity logged yet.')).toBeVisible();
});
