import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// Starts the host with the fake-services web build, the same one the e2e suite uses. Speech, replies and Pi are canned,
// so the app runs without local models or a Pi account. Resolves with the origin once the host is ready.
export async function startDemoServer({ port = '0', log = () => {} } = {}) {
  const child = spawn(process.execPath, ['scripts/dev.mjs'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PODCASTER_WEB_BUILD_ENTRY: 'scripts/build-web-fake.mjs', PODCASTER_PORT: port },
  });
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the demo did not start within 90 s')), 90_000);
    createInterface({ input: child.stdout }).on('line', (line) => {
      log(line);
      const match = line.match(/Podcaster readiness: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.stderr.on('data', (chunk) => log(String(chunk).trimEnd()));
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the demo exited with status ${code ?? 'signal'} before it was ready`));
    });
  });
  return {
    child,
    origin,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGINT');
      await once(child, 'exit');
    },
  };
}
