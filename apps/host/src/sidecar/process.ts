import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  isValidTtsModelDescriptor,
  isValidVoiceCatalog,
  type TtsModelDescriptor,
  type TtsModelSelection,
  type VoiceCatalog,
} from '@app/contracts';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

export interface SidecarProcess {
  child: ChildProcessByStdio<null, Readable, Readable>;
  origin: string;
  secret: string;
  stop(): Promise<void>;
}

export async function startSidecar(
  python = process.env.PYTHON ?? `${repositoryRoot}.venv/bin/python`,
): Promise<SidecarProcess> {
  const secret = randomBytes(32).toString('base64url');
  const child = spawn(python, ['-m', 'services.audio.src.server', '--host', '127.0.0.1', '--port', '0'], {
    cwd: repositoryRoot,
    env: { ...process.env, PODCASTER_SIDECAR_SECRET: secret },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-2000);
    process.stderr.write(`[sidecar] ${chunk}`);
  });
  let line: string;
  try {
    line = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Sidecar startup timed out')), 5000);
      const reader = createInterface({ input: child.stdout });
      reader.once('line', (value) => {
        clearTimeout(timer);
        reader.close();
        resolve(value);
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`Sidecar failed to start: ${error.message}`));
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Sidecar exited (${code}): ${stderr}`));
      });
    });
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
  let parsed: { host?: string; port?: number };
  try {
    parsed = JSON.parse(line) as { host?: string; port?: number };
  } catch {
    child.kill();
    throw new Error('Invalid sidecar startup response');
  }
  if (parsed.host !== '127.0.0.1' || !Number.isInteger(parsed.port) || parsed.port! <= 0) {
    child.kill();
    throw new Error('Sidecar did not bind an assigned loopback port');
  }
  return {
    child,
    secret,
    origin: `http://127.0.0.1:${parsed.port}`,
    stop: async () => {
      if (child.exitCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))]);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    },
  };
}

export type SidecarRuntimeStatus = 'starting' | 'ready' | 'failed';
export type SidecarWarmupStatus = 'starting' | 'warming' | 'ready' | 'failed';
export interface SidecarWarmupSnapshot {
  vad: SidecarWarmupStatus;
  tts: SidecarWarmupStatus;
}
export interface SidecarRuntimeSnapshot {
  status: SidecarRuntimeStatus;
  stt: string;
  tts: string;
  warmup?: SidecarWarmupSnapshot;
  voiceCatalog?: VoiceCatalog;
  ttsModels?: TtsModelDescriptor[];
  activeTtsModel?: TtsModelSelection;
}

/**
 * Strict /health snapshot parser. Returns undefined when the sidecar is
 * unreachable or emits a malformed runtime snapshot. A ready snapshot without a
 * valid voice catalog is treated as not ready so the browser never over-promises
 * voices.
 */
export async function sidecarSnapshot(sidecar: SidecarProcess): Promise<SidecarRuntimeSnapshot | undefined> {
  try {
    const response = await fetch(`${sidecar.origin}/health`, {
      headers: { authorization: `Bearer ${sidecar.secret}` },
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return undefined;
    const value = (await response.json()) as {
      status?: unknown;
      stt?: unknown;
      tts?: unknown;
      warmup?: unknown;
      voiceCatalog?: unknown;
      ttsModels?: unknown;
      activeTtsModel?: unknown;
    };
    if (value.status !== 'starting' && value.status !== 'ready' && value.status !== 'failed') return undefined;
    const snapshot: SidecarRuntimeSnapshot = {
      status: value.status,
      stt: String(value.stt ?? ''),
      tts: String(value.tts ?? ''),
    };
    if (value.warmup !== undefined) {
      if (!value.warmup || typeof value.warmup !== 'object' || Array.isArray(value.warmup)) return undefined;
      const warmup = value.warmup as { vad?: unknown; tts?: unknown };
      const valid = (item: unknown): item is SidecarWarmupStatus =>
        item === 'starting' || item === 'warming' || item === 'ready' || item === 'failed';
      if (!valid(warmup.vad) || !valid(warmup.tts) || Object.keys(warmup).some((key) => key !== 'vad' && key !== 'tts'))
        return undefined;
      snapshot.warmup = { vad: warmup.vad, tts: warmup.tts };
    }
    if (value.status === 'ready') {
      if (!isValidVoiceCatalog(value.voiceCatalog)) return undefined;
      snapshot.voiceCatalog = value.voiceCatalog;
    }
    if (value.ttsModels !== undefined) {
      if (!Array.isArray(value.ttsModels) || !value.ttsModels.every(isValidTtsModelDescriptor)) return undefined;
      snapshot.ttsModels = value.ttsModels;
    }
    if (value.activeTtsModel !== undefined) {
      const active = value.activeTtsModel;
      if (
        !active ||
        typeof active !== 'object' ||
        Array.isArray(active) ||
        typeof (active as { backendId?: unknown }).backendId !== 'string' ||
        typeof (active as { modelId?: unknown }).modelId !== 'string'
      )
        return undefined;
      snapshot.activeTtsModel = {
        backendId: (active as { backendId: string }).backendId,
        modelId: (active as { modelId: string }).modelId,
      };
    }
    return snapshot;
  } catch {
    return undefined;
  }
}
