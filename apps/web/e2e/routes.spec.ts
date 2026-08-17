import { expect, test } from '@playwright/test';
import { emit, enterFakeSession } from './support/fake-browser-services';
import { startDevServer, stopDevServer, type DevServer } from './support/dev-server';
let server: DevServer;
test.beforeAll(async () => { server = await startDevServer({ fakeServices: true }); });
test.afterAll(async () => { await stopDevServer(server); });

test('the shared app header returns home from a session and stays anchored across routes', async ({ page }) => {
  await enterFakeSession(page, server.origin);
  const header = page.locator('[data-slot="app-header"]');
  const sessionHeaderBox = await header.boundingBox();
  await expect(header.getByRole('link', { name: 'Podcaster home' })).toBeVisible();
  await expect(header.getByRole('button', { name: /Open settings/ })).toBeVisible();

  await header.getByRole('link', { name: 'Podcaster home' }).click();
  await expect(page.getByRole('heading', { name: 'Your sessions' })).toBeVisible();
  const indexHeaderBox = await header.boundingBox();
  expect(indexHeaderBox).not.toBeNull();
  expect(sessionHeaderBox).not.toBeNull();
  expect(indexHeaderBox).toMatchObject({ x: sessionHeaderBox?.x, y: sessionHeaderBox?.y, width: sessionHeaderBox?.width, height: sessionHeaderBox?.height });

  await page.getByRole('link', { name: 'Open session' }).click();
  await expect(page.getByRole('heading', { name: 'Listening' })).toBeVisible();
  await header.getByRole('button', { name: /Open settings/ }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
});

test('each session lives at its own URL and appears on the index', async ({ page }) => {
  await enterFakeSession(page, server.origin);
  const sessionUrl = page.url();
  expect(sessionUrl).toMatch(/\/session\/[0-9a-f-]{36}$/);
  await emit(page, 'transcript.final', { turnId: 'turn-1', text: 'A stable thought', endpointComplete: true });
  await expect(page.getByText('A stable thought')).toBeVisible();

  await page.getByRole('button', { name: 'End session' }).click();
  await expect(page.getByRole('heading', { name: 'Session stopped' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'All sessions' })).toBeVisible();

  // Back on the index the finished session is listed with its facts and actions.
  await page.goto(server.origin);
  await expect(page.getByRole('heading', { name: 'Your sessions' })).toBeVisible();
  await expect(page.getByText('Past sessions')).toBeVisible();
  const row = page.getByRole('listitem').filter({ hasText: 'A stable thought' }).first();
  await expect(row).toContainText('1 turn');
  await expect(row.getByRole('button', { name: 'Continue' })).toBeVisible();
  // Recording is off by default, so there is nothing to re-export yet.
  await expect(row.getByRole('button', { name: 'Export' })).toBeDisabled();
});

test('a stopped session opens read-only with its conversation and can be continued', async ({ page }) => {
  await enterFakeSession(page, server.origin);
  const sessionUrl = page.url();
  await emit(page, 'transcript.final', { turnId: 'turn-1', text: 'A stable thought', endpointComplete: true });
  await emit(page, 'reasoning.final', { turnId: 'turn-1', responseId: 'response-1', posture: 'question', text: 'What matters most?' });
  await page.getByRole('button', { name: 'End session' }).click();
  await expect(page.getByRole('heading', { name: 'Session stopped' })).toBeVisible();

  // Fresh load of the session URL shows the stored conversation read-only.
  await page.goto(sessionUrl);
  await expect(page.getByText('Ended session')).toBeVisible();
  await expect(page.getByText('A stable thought')).toBeVisible();
  await expect(page.getByText('What matters most?')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue session' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export recording' })).toBeDisabled();

  // Continuing reopens the same session under the same URL.
  await page.getByRole('button', { name: 'Continue session' }).click();
  await expect(page.getByRole('heading', { name: 'Listening' })).toBeVisible();
  expect(page.url()).toBe(sessionUrl);
  await page.waitForFunction(() => Boolean(window.__podcasterTest));
  await emit(page, 'transcript.final', { turnId: 'turn-2', text: 'Carried on here', endpointComplete: true });
  await expect(page.getByText('Carried on here')).toBeVisible();
});

test('resuming an active session from the index restores its conversation', async ({ page }) => {
  await enterFakeSession(page, server.origin);
  const sessionUrl = page.url();
  await emit(page, 'transcript.final', { turnId: 'turn-1', text: 'A stable thought', endpointComplete: true });
  await emit(page, 'reasoning.final', { turnId: 'turn-1', responseId: 'response-1', posture: 'question', text: 'What matters most?' });

  await page.goto(server.origin);
  const row = page.getByRole('listitem').filter({ hasText: 'A stable thought' }).first();
  await expect(row.getByRole('button', { name: 'Resume' })).toBeVisible();
  await row.getByRole('button', { name: 'Resume' }).click();

  await expect(page.getByRole('heading', { name: 'Listening' })).toBeVisible();
  expect(page.url()).toBe(sessionUrl);
  await expect(page.getByText('A stable thought')).toBeVisible();
  await expect(page.getByText('What matters most?')).toBeVisible();
});

test('the index shows a running session and returning to it keeps it live', async ({ page }) => {
  await enterFakeSession(page, server.origin);
  const sessionUrl = page.url();
  await emit(page, 'transcript.final', { turnId: 'turn-1', text: 'A stable thought', endpointComplete: true });

  // Leaving for the index (in-app navigation) does not end the running session.
  await page.goBack();
  await expect(page.getByText('Active session')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open session' })).toBeVisible();
  await page.getByRole('link', { name: 'Open session' }).click();
  expect(page.url()).toBe(sessionUrl);
  // The session is still live: same screen, same microphone, conversation intact.
  await expect(page.getByText('Active voice session')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause session' })).toBeVisible();
  await expect(page.getByText('A stable thought')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__podcasterTest!.stats().captureRunning)).toBe(true);
});
