#!/usr/bin/env node
// Records the README loop and the showcase hero from the demo. The loop clicks "Play sample exchange" like a visitor
// would: the question is heard (partial, then final), the reply appears and plays, and the app goes back to listening.
// The hero is the reply mid-playback. Usage: npm run media:capture. Needs agent-browser (with its browser installed)
// and FFmpeg on the PATH.
import { mkdir, readFile } from 'node:fs/promises';
import { record } from '@soleone/showcase/capture';
import { startDemoServer } from './demo-server.mjs';

// Fake camera and microphone: the page asks for the microphone, and the demo does not hear it anyway.
process.env.AGENT_BROWSER_ARGS = '--use-fake-ui-for-media-stream,--use-fake-device-for-media-stream';

// Reads the frame count and total length from the WebP's own container, so a short encode is caught before it is kept.
function webpTiming(buffer) {
  let frames = 0;
  let durationMs = 0;
  for (let offset = 12; offset + 8 <= buffer.length; ) {
    const type = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (type === 'ANMF') {
      frames += 1;
      durationMs += buffer.readUIntLE(offset + 8 + 12, 3);
    }
    offset += 8 + size + (size % 2);
  }
  return { frames, durationMs };
}

// The app renders each step after a click, so wait for the next button before pressing it.
const buttonReady = (name) =>
  `[...document.querySelectorAll('button')].some((button) => button.textContent.trim() === '${name}' && !button.disabled)`;

await mkdir('docs/media', { recursive: true });
const demo = await startDemoServer();
const take = () =>
  record({
    url: demo.origin,
    out: 'docs/media/conversation.webp',
    attempts: 5,
    async start(page) {
      await page.click('New session');
      await page.waitFor(
        `[...document.querySelectorAll('button')].some((button) => ['Enable microphone', 'Start session'].includes(button.textContent.trim()))`,
      );
      // The first take asks for the microphone; later takes in the same profile may already have it.
      if (
        await page.eval(
          `[...document.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Enable microphone')`,
        )
      ) {
        await page.click('Enable microphone');
      }
      await page.waitFor(buttonReady('Start session'));
      await page.click('Start session');
      await page.waitFor(`window.__podcasterTest !== undefined`, { timeoutMs: 30_000 });
      await page.sleep(1500);
    },
    async drive(page) {
      await page.sleep(1000);
      await page.click('Play sample exchange');
      await page.waitFor(`document.body.innerText.includes('is speaking')`, { timeoutMs: 15_000 });
      await page.sleep(900);
      await page.run('screenshot', 'docs/media/hero.png');
      await page.waitFor(`!document.body.innerText.includes('is speaking')`, { timeoutMs: 15_000 });
      await page.sleep(1500);
    },
    async verify(page) {
      if (!(await page.eval(`document.body.innerText.includes('Try the one on workshop acoustics')`)))
        return 'the reply did not appear';
    },
  });

try {
  let result;
  for (let run = 1; !result; run += 1) {
    try {
      const attemptResult = await take();
      if (attemptResult.frames < 6) throw new Error(`The take has only ${attemptResult.frames} stream frames`);
      const timing = webpTiming(await readFile('docs/media/conversation.webp'));
      if (timing.frames < 6 || Math.abs(timing.durationMs - attemptResult.durationMs) > 500) {
        throw new Error(
          `The loop has ${timing.frames} frames and ${timing.durationMs} ms, not the ${attemptResult.durationMs} ms take`,
        );
      }
      result = attemptResult;
    } catch (error) {
      if (run >= 3) throw error;
      console.error(`${error.message}. Recording again.`);
    }
  }
  const { frames, durationMs, grid } = result;
  console.log(
    `Wrote docs/media/conversation.webp (${frames} frames, ${(durationMs / 1000).toFixed(1)} s). Check the frames in ${grid}.`,
  );
  console.log('Wrote docs/media/hero.png.');
} finally {
  await demo.close();
}
