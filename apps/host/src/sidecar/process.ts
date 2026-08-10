import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

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

export async function sidecarHealth(sidecar: SidecarProcess): Promise<boolean> {
  try {
    const response = await fetch(`${sidecar.origin}/health`, { headers: { authorization: `Bearer ${sidecar.secret}` }, signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    const value = await response.json() as { status?: unknown; stt?: unknown; tts?: unknown };
    return value.status === 'ready'
      && value.stt === 'nemotron-3.5-transformers-fp32-320ms-paced-v1'
      && value.tts === 'kokoro-82m-onnx-fp32-af-heart-cuda-v1';
  } catch { return false; }
}
