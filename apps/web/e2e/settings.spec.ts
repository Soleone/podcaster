import { expect, test } from '@playwright/test';
import { installFakeMicrophone } from './support/fake-browser-services';
import { startDevServer, stopDevServer, type DevServer } from './support/dev-server';

let server: DevServer;
test.beforeAll(async () => { server = await startDevServer({ fakeServices: true }); });
test.afterAll(async () => { await stopDevServer(server); });

async function openSettings(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(server.origin);
  await page.getByRole('button', { name: 'Continue and check readiness' }).click();
  await page.getByRole('button', { name: 'Enable microphone' }).click();
  await page.getByRole('button', { name: /Open settings/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
}

test('settings dialog edits persona with a byte counter and inspects the base prompt', async ({ page }) => {
  await installFakeMicrophone(page);
  await openSettings(page);

  await expect(page.getByText('These apply to the next session you start.')).toBeVisible();
  const dialog = page.getByRole('dialog');
  const persona = page.getByLabel('Persona');
  await expect(persona).toBeVisible();
  const initial = await page.locator('#settings-persona-counter').innerText();

  await persona.fill('You are a terse, curious night-owl host who loves coastal weather.');
  await expect(page.locator('#settings-persona-counter')).not.toHaveText(initial);

  // Oversized persona disables Save with an inline error.
  await persona.fill('x'.repeat(9000));
  await expect(page.getByText('Persona exceeds the 8 KiB limit.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save settings' })).toBeDisabled();

  // Restore a valid persona and inspect the read-only base prompt.
  await persona.fill('You are a terse, curious night-owl host who loves coastal weather.');
  await page.getByRole('button', { name: 'View base system prompt' }).click();
  await expect(page.getByText('You are the voice of a live podcast companion.')).toBeVisible();

  // Voice tab reflects that no verified catalog exists in fake services.
  await page.getByRole('tab', { name: 'Voice' }).click();
  await expect(page.getByText(/No verified voice catalog is available yet/)).toBeVisible();
  const voiceDialogBox = await dialog.boundingBox();
  expect(voiceDialogBox).not.toBeNull();

  // Switching back keeps the fixed dialog height instead of reflowing around the persona.
  await page.getByRole('tab', { name: 'Agent' }).click();
  await expect(persona).toBeVisible();
  const agentDialogBox = await dialog.boundingBox();
  expect(agentDialogBox).not.toBeNull();
  expect(agentDialogBox?.height).toBeCloseTo(voiceDialogBox?.height ?? 0, 3);

  // Save persists and closes the dialog.
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('settings survive a reload on the same browser', async ({ page }) => {
  await installFakeMicrophone(page);
  await openSettings(page);
  await page.getByLabel('Persona').fill('You are Lin, a gentle storyteller.');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.reload();
  await page.getByRole('button', { name: /Open settings/ }).first().click();
  await expect(page.getByLabel('Persona')).toHaveValue('You are Lin, a gentle storyteller.');
});
