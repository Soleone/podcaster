#!/usr/bin/env node
// Records the README loop and the showcase hero from the demo. The loop shows a question being heard (partial, then
// final), the reply appearing and playing, and the app going back to listening. The hero is the reply mid-playback.
// Usage: npm run media:capture. Needs agent-browser (with its browser installed) and FFmpeg on the PATH.
import { mkdir, readFile } from 'node:fs/promises';
import { record } from '@soleone/showcase/capture';
import { startDemoServer } from './demo-server.mjs';

const question = 'What should I listen to after the Tuesday episode?';
const answer =
  'Try the one on workshop acoustics. It picks up where Tuesday left off, and the host answers the listener questions you would have had.';

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

const buttonPresent = (name) =>
  `[...document.querySelectorAll('button')].some((button) => button.textContent.trim() === '${name}')`;
// The app renders each step after a click, so wait for the next button before pressing it.
const buttonReady = (name) =>
  `[...document.querySelectorAll('button')].some((button) => button.textContent.trim() === '${name}' && !button.disabled)`;

// Runs a turn's events through the page's fake transport, the same entry points the e2e suite uses.
async function emit(page, type, payload) {
  await page.eval(
    `(async () => { await window.__podcasterTest.emit(${JSON.stringify(type)}, ${JSON.stringify(payload)}); return true; })()`,
  );
}

const demo = await startDemoServer();
const stream = { streamId: 'demo-stream', utteranceId: 'demo-turn' };
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
      if (await page.eval(buttonPresent('Enable microphone'))) await page.click('Enable microphone');
      await page.waitFor(buttonReady('Start session'));
      await page.click('Start session');
      await page.waitFor(`window.__podcasterTest !== undefined`, { timeoutMs: 30_000 });
      await page.sleep(1500);
    },
    async drive(page) {
      await page.sleep(1000);
      await emit(page, 'vad.speech_start', { ...stream, captureStartSequence: 0 });
      await page.eval(`(async () => { await window.__podcasterTest.partial('What should I listen'); return true; })()`);
      await page.sleep(700);
      await page.eval(
        `(async () => { await window.__podcasterTest.partial(${JSON.stringify(question)}); return true; })()`,
      );
      await page.sleep(700);
      await emit(page, 'vad.speech_end', { ...stream, captureStartSequence: 0, captureEndSequence: 1 });
      await emit(page, 'transcript.final', { turnId: stream.utteranceId, text: question, endpointComplete: true });
      await emit(page, 'reasoning.started', {
        turnId: stream.utteranceId,
        responseId: 'demo-reply',
        posture: 'question',
      });
      await page.sleep(600);
      await emit(page, 'reasoning.final', {
        turnId: stream.utteranceId,
        responseId: 'demo-reply',
        posture: 'question',
        text: answer,
      });
      await emit(page, 'tts.started', { responseId: 'demo-reply', playbackId: 'demo-playback', sampleRate: 24000 });
      await page.eval(`(async () => { await window.__podcasterTest.audio('demo-playback', 0, 480); return true; })()`);
      await page.sleep(500);
      await page.run('screenshot', 'docs/media/hero.png');
      await page.sleep(2300);
      await emit(page, 'playback.stopped', {
        playbackId: 'demo-playback',
        cancelledEpoch: 0,
        finalPlayedSampleOffset: 480,
        reason: 'completed',
      });
      await page.sleep(2000);
    },
    async verify(page) {
      if (!(await page.eval(`document.body.innerText.includes(${JSON.stringify(answer.slice(0, 40))})`)))
        return 'the reply did not appear';
    },
  });

await mkdir('docs/media', { recursive: true });
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
