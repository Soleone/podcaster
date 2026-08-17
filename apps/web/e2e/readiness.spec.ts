import { expect, test, type Page } from '@playwright/test';
import { startDevServer, stopDevServer, type DevServer } from './support/dev-server';
let server: DevServer;
test.beforeAll(async () => { server = await startDevServer(); });
test.afterAll(async () => { await stopDevServer(server); });

test('disclosure precedes secure readiness and explicit microphone permission', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { getUserMediaCalls: number }).getUserMediaCalls = 0;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => {
      (window as unknown as { getUserMediaCalls: number }).getUserMediaCalls++;
      localStorage.setItem('test-microphone-granted', 'true');
      return { getTracks: () => [{ stop() {} }] };
    } } });
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: async () => ({
      state: localStorage.getItem('test-microphone-granted') === 'true' ? 'granted' : 'prompt',
    }) } });
  });
  let bootstrapCalls = 0; page.on('request', request => { if (request.url().endsWith('/api/bootstrap')) bootstrapCalls++; });
  await page.goto(server.origin);
  await expect(page.getByRole('heading', { name: 'Before you continue' })).toBeVisible();
  await expect(page.getByText(/current transcript, bounded recent conversation context/)).toBeVisible();
  await expect(page.getByText(/sent as system instructions to the configured cloud model/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Codex data handling' })).toHaveAttribute('href', /openai\.com/);
  expect(bootstrapCalls).toBe(0);
  expect(await permissionCalls(page)).toBe(0);
  await page.getByRole('button', { name: 'Continue and check readiness' }).click();
  await expect(page.getByRole('heading', { name: 'Readiness' })).toBeVisible(); expect(bootstrapCalls).toBe(1);
  await expect(page.getByText('Voice input', { exact: true })).toBeVisible();
  await expect(page.getByText('Voice output', { exact: true })).toBeVisible();
  await expect(page.getByText('Cloud reasoning', { exact: true })).toBeVisible();
  expect(await permissionCalls(page)).toBe(0);
  await page.getByRole('button', { name: 'Enable microphone' }).click();
  await expect(page.getByText(/Microphone permission is ready/)).toBeVisible();
  expect(await permissionCalls(page)).toBe(1);
  await expect(page.getByRole('button', { name: 'Start session' })).toBeDisabled();
  await expect(page.getByText(/host audio-model integration is ready/)).toBeVisible();

  await page.route('**/api/readiness', async route => {
    await new Promise(resolve => setTimeout(resolve, 500));
    await route.continue();
  });
  await page.reload();
  // Returning users see the readiness surface immediately, without waiting for
  // the local runtime and Pi probe to finish.
  await expect(page.getByRole('heading', { name: 'Readiness' })).toBeVisible({ timeout: 2_000 });
  await page.unroute('**/api/readiness');
  await expect(page.getByRole('heading', { name: 'Readiness' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Before you continue' })).toHaveCount(0);
  await expect(page.getByText(/Microphone permission is ready/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enable microphone' })).toHaveCount(0);
  await expect.poll(() => bootstrapCalls).toBe(2);
});
async function permissionCalls(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { getUserMediaCalls: number }).getUserMediaCalls);
}
