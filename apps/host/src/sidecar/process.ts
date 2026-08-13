import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { isValidVoiceCatalog, type VoiceCatalog } from '@app/contracts';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

export interface SidecarProcess { child: ChildProcessByStdio<null, Readable, Readable>; origin: string; secret: string; stop(): Promise<void>; }

export async function startSidecar(python = process.env.PYTHON ?? `${repositoryRoot}.venv/bin/python`): Promise<SidecarProcess> {
  const secret = randomBytes(32).toString('base64url');
  const child = spawn(python, ['-m', 'services.audio.src.server', '--host', '127.0.0.1', '--port', '0'], {
    cwd: repositoryRoot, env: { ...process.env, PODCASTER_SIDECAR_SECRET: secret }, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000); process.stderr.write(`[sidecar] ${chunk}`); });
  let line: string;
  try {
    line = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Sidecar startup timed out')), 5000);
      const reader = createInterface({ input: child.stdout });
      reader.once('line', (value) => { clearTimeout(timer); reader.close(); resolve(value); });
      child.once('error', (error) => { clearTimeout(timer); reject(new Error(`Sidecar failed to start: ${error.message}`)); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Sidecar exited (${code}): ${stderr}`)); });
    });
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
  let parsed: { host?: string; port?: number };
  try { parsed = JSON.parse(line) as { host?: string; port?: number }; } catch { child.kill(); throw new Error('Invalid sidecar startup response'); }
  if (parsed.host !== '127.0.0.1' || !Number.isInteger(parsed.port) || parsed.port! <= 0) { child.kill(); throw new Error('Sidecar did not bind an assigned loopback port'); }
  return {
    child, secret, origin: `http://127.0.0.1:${parsed.port}`,
    stop: async () => {
      if (child.exitCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1000))]);
      if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
    },
  };
}

export type SidecarRuntimeStatus = 'starting' | 'ready' | 'failed';
export interface SidecarRuntimeSnapshot {
  status: SidecarRuntimeStatus;
  stt: string;
  tts: string;
  voiceCatalog?: VoiceCatalog;
}

/**
 * Strict /health snapshot parser. Returns undefined when the sidecar is
 * unreachable or emits a malformed runtime snapshot. A ready snapshot without a
 * valid voice catalog is treated as not ready so the browser never over-promises
 * voices.
 */
export async function sidecarSnapshot(sidecar: SidecarProcess): Promise<SidecarRuntimeSnapshot | undefined> {
  try {
    const response = await fetch(`${sidecar.origin}/health`, { headers: { authorization: `Bearer ${sidecar.secret}` }, signal: AbortSignal.timeout(1000) });
    if (!response.ok) return undefined;
    const value = await response.json() as { status?: unknown; stt?: unknown; tts?: unknown; voiceCatalog?: unknown };
    if (value.status !== 'starting' && value.status !== 'ready' && value.status !== 'failed') return undefined;
    const snapshot: SidecarRuntimeSnapshot = { status: value.status, stt: String(value.stt ?? ''), tts: String(value.tts ?? '') };
    if (value.status === 'ready') {
      if (!isValidVoiceCatalog(value.voiceCatalog)) return undefined;
      snapshot.voiceCatalog = value.voiceCatalog;
    }
    return snapshot;
  } catch { return undefined; }
}

export async function sidecarHealth(sidecar: SidecarProcess): Promise<boolean> {
  const snapshot = await sidecarSnapshot(sidecar);
  return Boolean(
    snapshot?.status === 'ready'
    && snapshot.voiceCatalog !== undefined
    && snapshot.stt === 'nemotron-3.5-transformers-fp32-320ms-paced-v1'
    && snapshot.tts === 'kokoro-82m-onnx-fp32-af-heart-cuda-v1'
  );
}
