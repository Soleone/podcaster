import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = new URL('..', import.meta.url);
const shutdownTimeoutMs = Number(process.env.PODCASTER_SHUTDOWN_TIMEOUT_MS ?? 3_000);
let active;
let shuttingDown = false;

function groupExists(pgid) {
  try { process.kill(-pgid, 0); return true; }
  catch (error) { if (error?.code === 'ESRCH') return false; if (error?.code === 'EPERM') return true; throw error; }
}

function signalGroup(pgid, signal) {
  try { process.kill(-pgid, signal); }
  catch (error) { if (error?.code !== 'ESRCH') throw error; }
}

async function waitForGroupExit(pgid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (groupExists(pgid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  return !groupExists(pgid);
}

async function terminateGroup(pgid, initialSignal = 'SIGTERM') {
  if (!groupExists(pgid)) return;
  signalGroup(pgid, initialSignal);
  if (!await waitForGroupExit(pgid, shutdownTimeoutMs)) {
    process.stderr.write('dev: process group did not stop in time; escalating to SIGKILL\n');
    signalGroup(pgid, 'SIGKILL');
    await waitForGroupExit(pgid, shutdownTimeoutMs);
  }
}

async function terminateActive(initialSignal = 'SIGTERM') {
  if (!active) return;
  const { pgid } = active;
  await terminateGroup(pgid, initialSignal);
  if (active?.pgid === pgid) active = undefined;
}

async function handleSignal(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  await terminateActive(signal);
  process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
}
process.once('SIGINT', () => void handleSignal('SIGINT'));
process.once('SIGTERM', () => void handleSignal('SIGTERM'));

function spawnGroup(command, args) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false, detached: true });
  active = { child, pgid: child.pid };
  return child;
}

async function finishGroup(child) {
  const pgid = child.pid;
  await terminateGroup(pgid);
  if (active?.pgid === pgid) active = undefined;
}

async function run(command, args) {
  const child = spawnGroup(command, args);
  const [code] = await once(child, 'exit');
  await finishGroup(child);
  if (code !== 0) throw new Error(`${command} exited with status ${code ?? 'signal'}`);
}

try {
  if (process.env.PODCASTER_WEB_BUILD_ENTRY) await run(process.execPath, [process.env.PODCASTER_WEB_BUILD_ENTRY]);
  else await run('corepack', ['pnpm', '--filter', '@app/web', 'build']);
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
