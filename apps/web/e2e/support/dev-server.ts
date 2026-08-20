import { expect, test as base } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

const STARTUP_TIMEOUT_MS = 20_000;
const MAX_STARTUP_STDERR = 64 * 1024;

export interface DevServer { child: ChildProcess; origin: string }

type TestFixtures = { origin: string };
type WorkerFixtures = { devServer: DevServer };

export const test = base.extend<TestFixtures, WorkerFixtures>({
  devServer: [async ({}, use, workerInfo) => {
    const server = await startDevServer({ fakeServices: workerInfo.project.name === 'fake-services' });
    try {
      await use(server);
    } finally {
      await stopDevServer(server);
    }
  }, { scope: 'worker' }],
  origin: async ({ devServer }, use) => { await use(devServer.origin); },
});
export { expect };

export async function startDevServer(options: { fakeServices?: boolean } = {}): Promise<DevServer> {
  const env: NodeJS.ProcessEnv = { ...process.env, PODCASTER_PORT: '0' };
  if (options.fakeServices) env.PODCASTER_WEB_BUILD_ENTRY = 'scripts/build-web-fake.mjs';
  else delete env.PODCASTER_WEB_BUILD_ENTRY;

  const child = spawn('node', ['scripts/dev.mjs'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], shell: false, env });
  let stderr = '';
  const startup = new Promise<string>((resolve, reject) => {
    let settled = false;
    const lines = createInterface({ input: child.stdout! });
    const timer = setTimeout(() => finish(new Error(`dev startup timeout after ${STARTUP_TIMEOUT_MS}ms`)), STARTUP_TIMEOUT_MS);
    const onStderr = (chunk: unknown) => {
      stderr = `${stderr}${String(chunk)}`.slice(-MAX_STARTUP_STDERR);
    };
    const onLine = (line: string) => {
      const match = line.match(/Podcaster readiness: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match?.[1]) finish(undefined, match[1]);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`dev exited ${code ?? `after ${signal ?? 'an unknown signal'}`}`));
    };
    const onError = (error: Error) => finish(new Error(`dev spawn error: ${error.message}`));

    function finish(error?: Error, origin?: string): void {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        const details = stderr.trim() || '(no stderr captured)';
        reject(new Error(`${error.message}\nstderr:\n${details}`, { cause: error }));
      } else {
        resolve(origin!);
      }
    }
    function cleanup(): void {
      clearTimeout(timer);
      lines.removeListener('line', onLine);
      lines.close();
      child.stdout?.resume();
      child.stderr?.removeListener('data', onStderr);
      child.stderr?.resume();
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    }

    child.stderr?.on('data', onStderr);
    lines.on('line', onLine);
    child.once('exit', onExit);
    child.once('error', onError);
  });

  try {
    return { child, origin: await startup };
  } catch (error) {
    await stopDevServer({ child, origin: '' });
    throw error;
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (hasExited(child)) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      child.removeListener('exit', finish);
      child.removeListener('close', finish);
      child.removeListener('error', finish);
      resolve();
    };
    child.once('exit', finish);
    child.once('close', finish);
    child.once('error', finish);
    if (hasExited(child)) finish();
  });
}

export async function stopDevServer(server: DevServer | undefined): Promise<void> {
  if (!server) return;
  if (!hasExited(server.child)) server.child.kill('SIGTERM');
  await waitForExit(server.child);
}
