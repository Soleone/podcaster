import { once } from 'node:events';
import { createProcessGroupManager } from './process-group.mjs';

const root = new URL('..', import.meta.url);
const shutdownTimeoutMs = Number(process.env.PODCASTER_SHUTDOWN_TIMEOUT_MS ?? 3_000);
const { spawnGroup, terminateActive, finishGroup } = createProcessGroupManager({ cwd: root, shutdownTimeoutMs });
let shuttingDown = false;

async function handleSignal(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  await terminateActive(signal);
  process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
}
process.once('SIGINT', () => void handleSignal('SIGINT'));
process.once('SIGTERM', () => void handleSignal('SIGTERM'));

async function run(command, args) {
  const child = spawnGroup(command, args);
  const [code] = await once(child, 'exit');
  await finishGroup(child);
  if (code !== 0) throw new Error(`${command} exited with status ${code ?? 'signal'}`);
}

try {
  if (process.env.PODCASTER_WEB_BUILD_ENTRY) await run(process.execPath, [process.env.PODCASTER_WEB_BUILD_ENTRY]);
  else await run('corepack', ['pnpm', '--filter', '@app/web', 'build']);
  await run('corepack', ['pnpm', '--filter', '@app/policy', 'build']);
  await run('corepack', ['pnpm', '--filter', '@app/host', 'build']);
  const hostEntry = process.env.PODCASTER_HOST_ENTRY ?? 'apps/host/dist/server/main.js';
  const host = spawnGroup(process.execPath, [hostEntry]);
  const [code] = await once(host, 'exit');
  await finishGroup(host);
  if (!shuttingDown) process.exitCode = code ?? 1;
} catch (error) {
  await terminateActive();
  process.stderr.write(`dev: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
