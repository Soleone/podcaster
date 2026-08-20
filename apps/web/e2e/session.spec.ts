import { expect, test } from './support/dev-server';
import { emit, enterFakeSession } from './support/fake-browser-services';

test('pauses and resumes the full session without ending it', async ({ page, origin }) => {
  await enterFakeSession(page, origin);
  await expect.poll(() => page.evaluate(() => window.__podcasterTest!.stats().captureRunning)).toBe(true);
  await emit(page, 'transcript.final', { turnId: 'pause-turn', text: 'Keep this transcript', endpointComplete: true });
  await expect(page.getByText('Keep this transcript')).toBeVisible();
  await page.getByRole('button', { name: 'Pause session' }).click();
  await expect(page.getByRole('heading', { name: 'Session paused' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume session' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop session' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'End session' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__podcasterTest!.stats().captureRunning)).toBe(false);
  await page.getByRole('button', { name: 'Resume session' }).click();
  await expect(page.getByRole('button', { name: 'Pause session' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__podcasterTest!.stats().captureRunning)).toBe(true);
  await expect(page.getByText('Keep this transcript')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Listening' })).toBeVisible();
});

test('keeps a paused session resumable after refresh', async ({ page, origin }) => {
  await enterFakeSession(page, origin);
  await emit(page, 'transcript.final', { turnId: 'refresh-turn', text: 'Survive the pause', endpointComplete: true });
  await page.getByRole('button', { name: 'Pause session' }).click();
  await expect(page.getByRole('heading', { name: 'Session paused' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Session paused' })).toBeVisible();
  await expect(page.getByText('Survive the pause')).toBeVisible();
  await page.getByRole('button', { name: 'Resume session' }).click();
  await expect(page.getByRole('heading', { name: 'Listening' })).toBeVisible();
  await expect(page.getByText('Survive the pause')).toBeVisible();
});

test('keeps a short conversation message on one line at narrow widths', async ({ page, origin }) => {
  await page.setViewportSize({ width: 238, height: 285 });
  await enterFakeSession(page, origin);
  await emit(page, 'transcript.final', { turnId: 'turn-short', text: 'Hello', endpointComplete: true });
  const metrics = await page.locator('.user-bubble p').evaluate(element => {
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
    return { height: element.getBoundingClientRect().height, lineHeight };
  });
  expect(metrics.height).toBeLessThanOrEqual(metrics.lineHeight + 0.5);
});

test('runs stable session states and recovers stable work after refresh', async ({ page, origin }) => {
  await enterFakeSession(page, origin);
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
  await expect(page.getByText('response_budget_exhausted')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Listening' })).toBeVisible({ timeout: 2_000 });

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Listening' })).toBeVisible();
  await expect(page.getByText('A stable thought')).toBeVisible();
  await expect(page.getByText('response_budget_exhausted')).toHaveCount(0);

  await emit(page, 'transcript.final', { turnId: 'turn-empty', text: '', endpointComplete: true });
  await emit(page, 'policy.decision', { turnId: 'turn-empty', posture: 'silence', eligible: false, reasonCodes: ['empty'] });
  await expect(page.locator('.conversation-bubble')).toHaveCount(1);
  await emit(page, 'transcript.final', { turnId: 'turn-2', text: 'Please respond to this thought', endpointComplete: true });
  await emit(page, 'policy.decision', { turnId: 'turn-2', posture: 'question', eligible: true, reasonCodes: ['selected'] });
  await expect(page.getByText('Please respond to this thought')).toBeVisible();

  await emit(page, 'reasoning.final', { turnId: 'turn-1', responseId: 'response-1', posture: 'question', text: 'What matters most?' });
  await emit(page, 'tts.started', { responseId: 'response-1', playbackId: 'playback-1', sampleRate: 24000 });
  await emit(page, 'tts.ended', { responseId: 'response-1', playbackId: 'playback-1', generatedSamples: 1000 });
  await page.evaluate(() => window.__podcasterTest!.audio('playback-1', 0, 400));
  await expect.poll(() => page.evaluate(() => window.__podcasterTest!.stats().progressReports)).toBe(1);
  await expect(page.getByRole('heading', { name: 'Speaking' })).toBeVisible();
  await emit(page, 'barge_in.provisional', { responseId: 'response-1', outputEpoch: 0, resumable: true });
  await expect.poll(() => page.evaluate(() => window.__podcasterTest!.stats().playbackPauses)).toBe(1);
  // Interruption is automatic: no pause dialog, the host's decision drives it.
  await expect(page.getByText('The previous response is paused while your intent is considered.')).toHaveCount(0);
  const timelineText = await page.locator('.conversation-list').innerText();
  expect(timelineText.indexOf('Please respond to this thought')).toBeLessThan(timelineText.indexOf('What matters most?'));
  await emit(page, 'interruption.decision', { turnId: 'turn-2', responseId: 'response-1', playbackId: 'playback-1', outputEpoch: 0, action: 'accept', intent: 'new_request', confidence: 'high', disposition: 'accept_takeover', pausedSampleOffset: 0 });
  await emit(page, 'barge_in.confirmed', { responseId: 'response-1', outputEpoch: 0, resumable: false });
  await expect(page.getByRole('heading', { name: 'Listening' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__podcasterTest!.stats().terminalReceipts)).toBe(1);
  const stats = await page.evaluate(() => window.__podcasterTest!.stats());
  expect(stats).toMatchObject({ playbackStops: ['cancelled'] });
  expect(stats.commands).not.toContain('confirm');
  await page.getByRole('button', { name: 'Pause session' }).click();
  await expect(page.getByRole('heading', { name: 'Session paused' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume session' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'End session' })).toHaveCount(0);
});
