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
  await expect(persona).toHaveCSS('max-height', '192px');
  await expect(persona).toHaveCSS('overflow-y', 'auto');
  const initial = await page.locator('#settings-persona-counter').innerText();

  // Agent name sits at the top of the Agent tab and defaults to Oliver.
  const agentName = page.getByLabel('Agent name');
  await expect(agentName).toBeVisible();
  await expect(page.locator('#settings-agent-name-counter')).toHaveCount(0);
  await expect(agentName).toHaveValue('Oliver');
  await page.getByRole('button', { name: 'Pi service' }).click();
  await expect(page.getByLabel('Model')).toHaveValue('openai-codex/gpt-5.6-sol');
  await page.getByLabel('Thinking level').click();
  await page.getByRole('option', { name: 'high', exact: true }).click();
  await agentName.fill('Ada');
  const agentFocus = await agentName.evaluate(element => {
    const panel = element.closest('[data-slot="tabs-content"]');
    return {
      boxShadow: getComputedStyle(element).boxShadow,
      leftInset: panel ? element.getBoundingClientRect().left - panel.getBoundingClientRect().left : -1,
    };
  });
  expect(agentFocus.boxShadow).not.toBe('none');
  expect(agentFocus.leftInset).toBeGreaterThanOrEqual(3);

  await persona.fill('You are a terse, curious night-owl host who loves coastal weather.');
  await expect(persona).not.toHaveCSS('box-shadow', 'none');
  await expect(page.locator('#settings-persona-counter')).not.toHaveText(initial);

  // Oversized persona disables Save with an inline error.
  await persona.fill('x'.repeat(9000));
  const personaScroll = await persona.evaluate(element => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(personaScroll.scrollHeight).toBeGreaterThan(personaScroll.clientHeight);
  await expect(page.getByText('Persona exceeds the 8 KiB limit.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save settings' })).toBeDisabled();

  // Restore a valid persona and inspect the read-only base prompt.
  await persona.fill('You are a terse, curious night-owl host who loves coastal weather.');
  await page.getByRole('button', { name: 'View base system prompt' }).click();
  const basePrompt = page.getByRole('textbox', { name: 'Base system prompt' });
  await expect(basePrompt).toBeVisible();
  await expect(basePrompt).toBeDisabled();
  await expect(basePrompt).toHaveCSS('overflow-y', 'auto');
  await expect(basePrompt).toHaveCSS('cursor', 'default');
  await expect(basePrompt).toHaveValue(/You are the voice of a live podcast companion\./);
  const baseDescription = page.getByText('Your saved persona is appended to this base prompt when the next session starts.');
  await baseDescription.scrollIntoViewIfNeeded();
  await expect(baseDescription).toBeVisible();

  // Voice tab reflects that no verified catalog exists in fake services.
  await page.getByRole('tab', { name: 'Voice' }).click();
  await expect(page.getByText(/No verified voice catalog is available yet/)).toBeVisible();
  await expect(page.getByLabel('Speed modifier')).toHaveValue('1');
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
  await page.getByLabel('Agent name').fill('Lin');
  await page.getByLabel('Persona').fill('You are a gentle storyteller.');
  await page.getByRole('button', { name: 'Pi service' }).click();
  await page.getByLabel('Thinking level').click();
  await page.getByRole('option', { name: 'high', exact: true }).click();
  await page.getByRole('tab', { name: 'Voice' }).click();
  await page.getByLabel('Speed modifier').fill('1.25');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.reload();
  await page.getByRole('button', { name: /Open settings/ }).first().click();
  await expect(page.getByLabel('Agent name')).toHaveValue('Lin');
  await expect(page.getByLabel('Persona')).toHaveValue('You are a gentle storyteller.');
  await page.getByRole('button', { name: 'Pi service' }).click();
  await expect(page.getByLabel('Model')).toHaveValue('openai-codex/gpt-5.6-sol');
  await expect(page.getByLabel('Thinking level')).toContainText('high');
  await page.getByRole('tab', { name: 'Voice' }).click();
  await expect(page.getByLabel('Speed modifier')).toHaveValue('1.25');
});
