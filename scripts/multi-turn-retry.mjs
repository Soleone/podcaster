#!/usr/bin/env node
/**
 * Real-stack multi-turn retry for T5.3 (aqf).
 *
 * Spawns the BUILT host (apps/host/dist/server/main.js, owning the real
 * sidecar: Nemotron + Kokoro, and real Pi RPC), then drives the authenticated
 * browser websocket protocol with three real speech utterances:
 *   U1 baseline full turn (eligible narrative)
 *   U2 takeover ("WHY SHOULD ONE HALT ON THE WAY") fed while U1's response is
 *      still active, forcing the TTS cancellation/replacement path
 *   U3 post-replacement sanity turn (capture stayed open; runtime not poisoned)
 *
 * Historical failure being retried: "second selected response exposed TTS
 * cancellation/replacement race that closed capture".
 * Pass = 3 completed turns, zero response.failed/failure events, socket open
 * throughout, session returns to listening after each turn, replacement seen.
 *
 * Prereq: pnpm --filter @app/host build
 * Usage: node scripts/multi-turn-retry.mjs   [RETRY_U2_DELAY_MS=<ms>]
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import WebSocket from '../apps/host/node_modules/ws/wrapper.mjs';
import { encodeBinaryAudioFrame } from '../packages/contracts/dist/binary.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOST_ENTRY = `${ROOT}apps/host/dist/server/main.js`;
const FIXTURE_RAW = `${ROOT}scripts/fixtures/multi-turn-utterances.raw`;
const FIXTURE_META = JSON.parse(readFileSync(`${ROOT}scripts/fixtures/multi-turn-utterances.json`, 'utf8'));
const FRAME_SAMPLES = 320; // 20 ms at 16 kHz
const MAX_PAYLOAD = 64 * 1024 - 20;
const SESSION_ID = '018f1f32-7abc-7def-8abc-0123456789ab';
const SEED = '018f1f32-7abd-7def-8abc-0123456789ab';
const TRAILING_SILENCE_FRAMES = 75; // 1.5 s of silence after each utterance

let sequence = 0;
function command(type, payload, epoch = 0) {
  const suffix = (0x1000 + sequence++).toString(16).padStart(12, '0');
  return {
    protocolVersion: 1,
    sessionId: SESSION_ID,
    epoch,
    eventId: `018f1f32-7abf-7def-8abc-${suffix}`,
    type,
    monotonicMs: Date.now(),
    payload,
  };
}

const events = [];
const log = [];
let pcm;
let playbackBinaryFrames = 0;
const playbackDeliveredSamples = () => playbackBinaryFrames * 480; // 20 ms chunks @ 24 kHz
const stamp = (started) => Date.now() - started;

async function freePort(base) {
  const net = await import('node:net');
  for (let port = base; port < base + 20; port += 1) {
    const probe = new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      server.listen(port, '127.0.0.1');
    });
    if (await probe) return port;
  }
  throw new Error('no free port found');
}

let captureSequence = 0;
async function feedPcm(socket, srcStart, samples, started, label, stepMs = 10) {
  const frameCount = Math.ceil(samples / FRAME_SAMPLES);
  for (let f = 0; f < frameCount; f += 1) {
    const src = srcStart + f * FRAME_SAMPLES;
    const pcm16 = new Int16Array(FRAME_SAMPLES);
    const take = Math.min(FRAME_SAMPLES, Math.max(0, pcm.length / 2 - src));
    if (take > 0) pcm16.set(new Int16Array(pcm.buffer, pcm.byteOffset + src * 2, take));
    socket.send(encodeBinaryAudioFrame({ channel: 1, streamId: 7, sequence: captureSequence++, monotonicUs: BigInt(Date.now() * 1000), pcm16 }, MAX_PAYLOAD));
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  log.push({ t: stamp(started), event: `feed.${label}`, frames: frameCount });
}

async function main() {
  const started = Date.now();
  pcm = readFileSync(FIXTURE_RAW);
  const utterances = FIXTURE_META.utterances;
  const port = await freePort(43199);
  const host = spawn(process.execPath, [HOST_ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PODCASTER_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  host.stderr.setEncoding('utf8');
  host.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-3000); });
  const origin = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`host startup timed out; stderr: ${stderr.slice(-500)}`)), 20_000);
    let buffer = '';
    host.stdout.setEncoding('utf8');
    host.stdout.on('data', (chunk) => {
      buffer += chunk;
      const match = buffer.match(/Podcaster readiness: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(deadline); resolve(match[1]); }
    });
    host.once('exit', (code) => { clearTimeout(deadline); reject(new Error(`host exited early (${code}): ${stderr.slice(-500)}`)); });
  });
  log.push({ t: stamp(started), event: 'host.up', origin });

  let socket;
  try {
    const response = await fetch(`${origin}/api/bootstrap`, {
      method: 'POST',
      headers: { host: new URL(origin).host, origin, 'content-type': 'application/json' },
      body: '{"disclosureAcknowledged":true}',
    });
    const { capability } = await response.json();
    const cookie = response.headers.get('set-cookie').split(';')[0];
    log.push({ t: stamp(started), event: 'bootstrap' });

    const readinessDeadline = Date.now() + 240_000;
    let ready = false;
    while (Date.now() < readinessDeadline) {
      const probe = await fetch(`${origin}/api/readiness`, {
        method: 'POST',
        headers: { host: new URL(origin).host, origin, 'x-podcaster-capability': capability, cookie },
      }).catch(() => null);
      if (probe && probe.ok) {
        const body = await probe.json();
        if (body.sidecar === 'ready' && body.reasoning === 'ready') { ready = true; break; }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!ready) throw new Error('host never became ready (sidecar models / Pi)');
    log.push({ t: stamp(started), event: 'ready' });

    socket = new WebSocket(`${origin.replace('http', 'ws')}/ws`, { headers: { Origin: origin, Cookie: cookie } });
    socket.on('message', (raw, isBinary) => {
      if (isBinary) { playbackBinaryFrames += 1; return; }
      const message = JSON.parse(raw.toString());
      if (message.type === 'authenticated') return;
      events.push(message);
      log.push({ t: stamp(started), event: message.type, epoch: message.epoch, payload: message.payload });
    });
    await new Promise((resolve, reject) => {
      socket.once('open', () => socket.send(JSON.stringify({ capability })));
      const timer = setTimeout(() => reject(new Error('ws authentication timed out')), 10_000);
      socket.once('message', (raw) => {
        if (raw.toString().includes('"authenticated"')) { clearTimeout(timer); resolve(); }
        else reject(new Error('expected authenticated'));
      });
      socket.once('close', (code) => reject(new Error(`socket closed during connect (${code})`)));
    });
    log.push({ t: stamp(started), event: 'authenticated' });

    socket.send(JSON.stringify(command('session.start', { sessionSeed: SEED, reasoningMode: 'full' })));
    socket.send(JSON.stringify(command('audio.start', { streamId: 7, sampleRate: 16000, channels: 1, frameSamples: FRAME_SAMPLES })));

    const ackedFinals = new Set();
    const ackedPlaybacks = new Set();
    const ackLoop = setInterval(() => {
      for (const e of events) {
        if (e.type === 'transcript.final' && !ackedFinals.has(e.eventId)) {
          ackedFinals.add(e.eventId);
          socket.send(JSON.stringify(command('turn.persisted', { turnId: e.payload.turnId, finalEventId: e.eventId, persistedEpoch: e.epoch }, e.epoch)));
        }
        if (e.type === 'tts.ended') {
          const key = `${e.epoch}:${e.payload.playbackId}`;
          if (!ackedPlaybacks.has(key)) {
            ackedPlaybacks.add(key);
            const generated = Number(e.payload.generatedSamples ?? 0);
            socket.send(JSON.stringify(command('playback.progress', { playbackId: e.payload.playbackId, outputEpoch: e.epoch, playedSampleOffset: generated, generatedSamples: generated })));
            socket.send(JSON.stringify(command('playback.stopped', { playbackId: e.payload.playbackId, cancelledEpoch: e.epoch, finalPlayedSampleOffset: generated, reason: 'completed' })));
            log.push({ t: stamp(started), event: 'playback.completed', epoch: e.epoch });
          }
        }
        if (e.type === 'barge_in.confirmed') {
          const key = `b${e.payload.outputEpoch}`;
          if (!ackedPlaybacks.has(key)) {
            ackedPlaybacks.add(key);
            socket.send(JSON.stringify(command('playback.stopped', { playbackId: e.payload.responseId, cancelledEpoch: e.payload.outputEpoch, finalPlayedSampleOffset: playbackDeliveredSamples(), reason: 'barge_in' })));
            log.push({ t: stamp(started), event: 'playback.barge_in_acked', epoch: e.payload.outputEpoch });
          }
        }
      }
    }, 20);

    // Strictly sequential event consumption via per-type cursors.
    const cursor = { final: 0, policy: 0, reasoningStarted: 0, ttsStarted: 0, ttsEnded: 0, state: 0 };
    const TYPE_KEY = {
      'transcript.final': 'final',
      'policy.decision': 'policy',
      'reasoning.started': 'reasoningStarted',
      'tts.started': 'ttsStarted',
      'tts.ended': 'ttsEnded',
      'session.state': 'state',
    };
    const next = (type, label, timeoutMs = 120_000, predicate = () => true) => {
      const key = TYPE_KEY[type];
      const index = cursor[key];
      cursor[key] += 1;
      return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const scan = () => {
          const list = events.filter((e) => e.type === type && predicate(e));
          if (list.length > index) return resolve(list[index]);
          if (events.some((e) => e.type === 'failure' || e.type === 'response.failed')) {
            const bad = events.find((e) => e.type === 'failure' || e.type === 'response.failed');
            return reject(new Error(`host reported ${bad.type}: ${JSON.stringify(bad.payload).slice(0, 240)}`));
          }
          if (Date.now() > deadline) reject(new Error(`timeout waiting for ${label} (#${index + 1} ${type}; have ${list.length})`));
          else setTimeout(scan, 25);
        };
        scan();
      });
    };

    const turnLog = [];
    const notePolicy = async (finalEvent, label) => {
      const policy = await next('policy.decision', `policy ${label}`, 60_000);
      turnLog.push({ turn: label, posture: policy.payload.posture, eligible: policy.payload.eligible, transcript: finalEvent.payload.text });
      if (policy.payload.posture === 'silence') {
        throw new Error(`${label} policy=silence ("${finalEvent.payload.text}"); utterance choice does not trigger a response`);
      }
    };

    // --- Turn 0 (U1 baseline) ---
    await feedPcm(socket, utterances[0].startSample, utterances[0].samples, started, 'u0');
    await feedPcm(socket, pcm.length / 2, TRAILING_SILENCE_FRAMES * FRAME_SAMPLES, started, 'u0silence');
    const final0 = await next('transcript.final', 'final turn 0');
    log.push({ t: stamp(started), event: 'turn.0.final', text: final0.payload.text });
    await notePolicy(final0, 'turn 0');
    await next('reasoning.started', 'reasoning.started turn 0', 60_000);

    // Feed U2 while U1's response is active. Optional delay puts the utterance
    // after U1's tts.started (exercising the Kokoro worker-terminalization race);
    // default 0 exercises the mid-reasoning replacement path.
    const delay = process.env.RETRY_U2_DELAY_MS ? Number(process.env.RETRY_U2_DELAY_MS) : 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    await feedPcm(socket, utterances[1].startSample, utterances[1].samples, started, 'u1replacement', 5);
    await feedPcm(socket, pcm.length / 2, TRAILING_SILENCE_FRAMES * FRAME_SAMPLES, started, 'u1replacementsilence', 5);

    // --- Turn 1 (U2 takeover) ---
    const final1 = await next('transcript.final', 'final turn 1');
    log.push({ t: stamp(started), event: 'turn.1.final', text: final1.payload.text, epoch: final1.epoch });
    const replacement = final1.epoch === 1; // epoch advances only on cancel/supersession
    if (replacement) log.push({ t: stamp(started), event: 'replacement.observed' });
    await notePolicy(final1, 'turn 1');

    // U1's response outcome.
    const startedList = events.filter((e) => e.type === 'tts.started');
    let outcome;
    if (startedList.length === 0) {
      outcome = 'replaced-before-tts'; // U1 cancelled during reasoning, before synthesis
    } else {
      const first = startedList[0];
      const ended = events.filter((e) => e.type === 'tts.ended').find((e) => e.payload.playbackId === first.payload.playbackId);
      if (ended) {
        outcome = 'completed';
        await next('session.state', 'listening after turn 0', 30_000);
      } else {
        outcome = 'replaced-after-tts';
        ackedPlaybacks.add('b0');
        socket.send(JSON.stringify(command('playback.stopped', { playbackId: first.payload.playbackId, cancelledEpoch: 0, finalPlayedSampleOffset: playbackDeliveredSamples(), reason: 'barge_in' })));
      }
    }
    log.push({ t: stamp(started), event: 'turn.0.outcome', outcome });

    // --- Turn 1 response completion ---
    await next('tts.started', 'tts.started turn 1');
    await next('tts.ended', 'tts.ended turn 1');
    await next('session.state', 'listening after turn 1', 30_000);

    // --- Turn 2 (U3 post-replacement sanity) ---
    await feedPcm(socket, utterances[2].startSample, utterances[2].samples, started, 'u2');
    await feedPcm(socket, pcm.length / 2, TRAILING_SILENCE_FRAMES * FRAME_SAMPLES, started, 'u2silence');
    const final2 = await next('transcript.final', 'final turn 2');
    log.push({ t: stamp(started), event: 'turn.2.final', text: final2.payload.text });
    await notePolicy(final2, 'turn 2');
    await next('tts.started', 'tts.started turn 2');
    await next('tts.ended', 'tts.ended turn 2');
    await next('session.state', 'listening after turn 2', 30_000);
    clearInterval(ackLoop);

    const ttsStarted = events.filter((e) => e.type === 'tts.started').length;
    const ttsEnded = events.filter((e) => e.type === 'tts.ended').length;
    const reasoningFinals = events.filter((e) => e.type === 'reasoning.final').length;
    const failures = events.filter((e) => e.type === 'response.failed' || e.type === 'failure');

    // Pass: replacement exercised cleanly, capture stayed open, zero failures,
    // and every turn produced a non-silence policy response. When U1 is replaced
    // before its TTS starts, exactly two spoken responses exist; when U1 completes
    // and U2 still supersedes, three. Either is a valid clean-replacement result.
    const status = failures.length === 0 && replacement && turnLog.length === 3 && ttsStarted >= 2 && ttsEnded >= 2 && reasoningFinals >= 2 ? 'passed' : 'failed';
    const summary = {
      status,
      outcome,
      replacementObserved: replacement,
      turns: turnLog,
      ttsStarted,
      ttsEnded,
      reasoningFinals,
      playbackBinaryFrames,
      failures: failures.map((e) => ({ type: e.type, payload: e.payload })),
      durationMs: stamp(started),
      timeline: log.filter((e) => ['transcript.partial', 'transcript.final', 'policy.decision', 'reasoning.started', 'reasoning.final', 'tts.started', 'tts.ended', 'barge_in.confirmed', 'playback.completed', 'turn.0.outcome', 'replacement.observed', 'response.failed', 'failure'].includes(e.event))
        .map((e) => ({ t: e.t, event: e.event, epoch: e.epoch, payload: e.payload })),
    };
    console.log(JSON.stringify(summary, null, 2));

    socket.send(JSON.stringify(command('session.stop', { reason: 'user' })));
    await Promise.race([new Promise((resolve) => socket.once('close', () => resolve())), new Promise((resolve) => setTimeout(resolve, 5000))]);
    socket.close();
    return status === 'passed' ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({
      status: 'failed',
      error: String(error.message ?? error),
      stderr: stderr.slice(-800),
      recentEvents: log.slice(-45).map((e) => ({ t: e.t, event: e.event, epoch: e.epoch, payload: e.payload })),
      durationMs: stamp(started),
    }, null, 2));
    return 1;
  } finally {
    try { socket?.close(); } catch { /* noop */ }
    if (host.exitCode === null) { host.kill('SIGTERM'); await Promise.race([once(host, 'exit'), new Promise((r) => setTimeout(r, 2000))]); }
    if (host.exitCode === null) host.kill('SIGKILL');
  }
}

main().then((code) => process.exit(code));
