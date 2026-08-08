import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
let child: ChildProcess; let origin: string;
test.beforeAll(async () => {
  child = spawn('node', ['scripts/dev.mjs'], { cwd: process.cwd(), stdio: ['ignore','pipe','pipe'], shell:false });
  origin = await new Promise((resolve, reject) => {
    const timer=setTimeout(()=>reject(new Error('dev startup timeout')),15_000); const lines=createInterface({input:child.stdout!});
    lines.on('line',line=>{const match=line.match(/Podcaster readiness: (http:\/\/127\.0\.0\.1:\d+)/); if(match?.[1]){clearTimeout(timer);resolve(match[1]);}});
    child.once('exit',code=>reject(new Error(`dev exited ${code}`)));
  });
});
test.afterAll(async () => { if(child.exitCode===null){child.kill('SIGTERM'); await new Promise(resolve=>child.once('exit',resolve));} });
test('disclosure precedes secure readiness and capture remains unavailable', async ({page}) => {
  await page.addInitScript(() => {
    (window as unknown as { getUserMediaCalls: number }).getUserMediaCalls = 0;
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (...args) => { (window as unknown as { getUserMediaCalls: number }).getUserMediaCalls++; return original(...args); };
  });
  let bootstrapCalls=0; page.on('request',r=>{if(r.url().endsWith('/api/bootstrap')) bootstrapCalls++;});
  await page.goto(origin); await expect(page.getByRole('heading',{name:'Before you continue'})).toBeVisible();
  await expect(page.getByText(/current transcript, bounded recent conversation context/)).toBeVisible();
  await expect(page.getByText(/validated persona interpretation/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Codex data handling' })).toHaveAttribute('href', /openai\.com/);
  await expect(page.getByText('Voice input')).toHaveCount(0); expect(bootstrapCalls).toBe(0);
  await page.getByRole('button',{name:'Continue and check readiness'}).click();
  await expect(page.getByRole('heading',{name:'Readiness'})).toBeVisible(); expect(bootstrapCalls).toBe(1);
  await expect(page.getByText('Voice input', { exact: true })).toBeVisible(); await expect(page.getByText('Voice output', { exact: true })).toBeVisible(); await expect(page.getByText('Cloud reasoning', { exact: true })).toBeVisible();
  await expect(page.getByRole('button',{name:'Enable microphone'})).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as { getUserMediaCalls: number }).getUserMediaCalls)).toBe(0);
});
