import { expect, test } from './support/dev-server';
import { emit, enterFakeSession } from './support/fake-browser-services';

test('restrains live announcements and resolves interruptions automatically', async ({ page, origin }) => {
  await enterFakeSession(page, origin);
  const live = page.getByRole('status');
  await expect(live).toHaveText('Listening');
  for (let index = 0; index < 12; index++)
    await page.evaluate(async (text) => window.__podcasterTest!.partial(text), `revision ${index}`);
  await expect(page.getByText('revision 11')).toBeVisible();
  await expect(live).toHaveText('Listening');
  await expect(live).not.toContainText('revision');

  await emit(page, 'reasoning.final', {
    turnId: 'turn',
    responseId: 'response',
    posture: 'question',
    text: 'A concise answer',
  });
  await emit(page, 'tts.started', { responseId: 'response', playbackId: 'playback', sampleRate: 24000 });
  await expect(page.getByRole('button', { name: 'Stop speaking' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Listening' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__podcasterTest!.stats().commands)).toContain('cancel');
  await expect.poll(() => page.evaluate(() => window.__podcasterTest!.stats().terminalReceipts)).toBe(1);
  await expect(page.getByRole('button', { name: 'Pause session' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'End session' })).toHaveCount(0);

  await emit(page, 'tts.started', { responseId: 'response-2', playbackId: 'playback-2', sampleRate: 24000 });
  await emit(page, 'barge_in.provisional', { responseId: 'response-2', outputEpoch: 0, resumable: true });
  // No pause dialog: the host resolves the interruption automatically.
  await expect(page.getByText('The previous response is paused while your intent is considered.')).toHaveCount(0);
  await emit(page, 'interruption.decision', {
    turnId: 'interruption',
    responseId: 'response-2',
    playbackId: 'playback-2',
    outputEpoch: 0,
    action: 'resume',
    intent: 'continue_previous',
    confidence: 'high',
    disposition: 'resume_requested',
    pausedSampleOffset: 0,
  });
  await expect.poll(() => page.evaluate(() => window.__podcasterTest!.stats().playbackResumes)).toBe(1);
  await expect(page.getByRole('heading', { name: 'Speaking' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause session' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'End session' })).toHaveCount(0);
});

test('activity log panel is keyboard-operable and lists session events', async ({ page, origin }) => {
  await enterFakeSession(page, origin);
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
