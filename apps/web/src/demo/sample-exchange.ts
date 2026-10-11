import type { LiveRuntimeTestApi } from '../session/live-runtime';

export const sampleQuestion = 'What should I listen to after the Tuesday episode?';
export const sampleAnswer =
  'Try the one on workshop acoustics. It picks up where Tuesday left off, and the host answers the listener questions you would have had.';

const sampleChunks = 12;
const chunkSamples = 4800;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// One canned turn in the order the host sends it: the question is heard, the reply is written, spoken and finished.
// Only the fake-services build has the test API, so the demo can run without speech models or a Pi account.
export async function playSampleExchange(api: LiveRuntimeTestApi): Promise<void> {
  const turnId = `sample-${Date.now()}`;
  const responseId = `${turnId}-reply`;
  const playbackId = `${turnId}-playback`;
  const stream = { streamId: `${turnId}-stream`, utteranceId: turnId };
  await api.emit('vad.speech_start', { ...stream, captureStartSequence: 0 });
  await api.partial('What should I listen');
  await pause(700);
  await api.partial(sampleQuestion);
  await pause(700);
  await api.emit('vad.speech_end', { ...stream, captureStartSequence: 0, captureEndSequence: 1 });
  await api.emit('transcript.final', { turnId, text: sampleQuestion, endpointComplete: true });
  await api.emit('reasoning.started', { turnId, responseId, posture: 'question' });
  await pause(600);
  await api.emit('reasoning.final', { turnId, responseId, posture: 'question', text: sampleAnswer });
  await api.emit('tts.started', { responseId, playbackId, sampleRate: 24000 });
  // Twelve 200 ms chunks at 24 kHz, sent a little apart, so the reply plays for about 2.4 s before playback ends by itself.
  for (let chunk = 0; chunk < sampleChunks; chunk += 1) {
    await api.audio(playbackId, chunk * chunkSamples, chunkSamples);
    await pause(200);
  }
  await api.emit('tts.ended', { responseId, playbackId, generatedSamples: sampleChunks * chunkSamples });
}
