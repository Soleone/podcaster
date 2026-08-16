import { spawn } from 'node:child_process';

const root = new URL('..', import.meta.url);
const shutdownTimeoutMs = Number(process.env.PODCASTER_SHUTDOWN_TIMEOUT_MS ?? 3_000);
const webPort = Number(process.env.PODCASTER_WEB_PORT ?? 5_173);
const webOrigin = `http://127.0.0.1:${webPort}`;
const active = new Map();
let shuttingDown = false;

if (!Number.isInteger(webPort) || webPort < 1_024 || webPort > 65_535) {
  throw new Error('PODCASTER_WEB_PORT must be an integer from 1024 through 65535');
}

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
  const groups = [...active.values()];
  await Promise.all(groups.map(async ({ pgid }) => {
    await terminateGroup(pgid, initialSignal);
    active.delete(pgid);
  }));
}

async function handleSignal(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  await terminateActive(signal);
  process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
}
process.once('SIGINT', () => void handleSignal('SIGINT'));
process.once('SIGTERM', () => void handleSignal('SIGTERM'));

function spawnGroup(command, args, { env = process.env, pipeStdout = false, onStdout } = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: ['ignore', pipeStdout ? 'pipe' : 'inherit', 'inherit'],
    shell: false,
    detached: true,
    env,
  });
  const pgid = child.pid;
  if (pgid === undefined) throw new Error(`${command} did not provide a process id`);
  active.set(pgid, { child, pgid });
  if (pipeStdout) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => onStdout?.(String(chunk)));
  }
  return child;
}

function observeExit(child) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once('error', error => finish({ code: 1, signal: undefined, error }));
    child.once('exit', (code, signal) => finish({ code: code ?? 1, signal }));
  });
}

async function finishGroup(child) {
  const pgid = child.pid;
  if (pgid === undefined) return;
  await terminateGroup(pgid);
  active.delete(pgid);
}

async function run(command, args, options = {}) {
  const child = spawnGroup(command, args, options);
  const result = await observeExit(child);
  await finishGroup(child);
  if (result.code !== 0) throw new Error(`${command} exited with status ${result.code}`);
}

function startHost(hostEntry) {
  let output = '';
  let ready = false;
  let resolveReady;
  let rejectReady;
  const readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const host = spawnGroup(process.execPath, [hostEntry], {
    env: { ...process.env, PODCASTER_PORT: process.env.PODCASTER_PORT ?? '43127' },
    pipeStdout: true,
    onStdout(chunk) {
      output += chunk;
      const lines = output.split(/\r?\n/);
      output = lines.pop() ?? '';
      for (const line of lines) {
        process.stdout.write(`[host] ${line}\n`);
        const match = line.match(/Podcaster readiness: (https?:\/\/\S+)/);
        if (!ready && match?.[1]) {
          ready = true;
          resolveReady(new URL(match[1]).origin);
        }
      }
    },
  });
  const exit = observeExit(host);
  exit.then(result => {
    if (!ready) rejectReady(result.error ?? new Error(`host exited with status ${result.code}`));
  });
  return { child: host, ready: readyPromise, exit };
}

function startVite(env) {
  let output = '';
  let ready = false;
  let resolveReady;
  let rejectReady;
  let timer;
  const readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
    timer = setTimeout(() => reject(new Error('Vite startup timed out')), 10_000);
  });
  const vite = spawnGroup('corepack', ['pnpm', '--filter', '@app/web', 'exec', 'vite'], {
    env,
    pipeStdout: true,
    onStdout(chunk) {
      process.stdout.write(chunk);
      output += chunk;
      const lines = output.split(/\r?\n/);
      output = lines.pop() ?? '';
      for (const line of lines) {
        const cleanLine = line.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '');
        const match = cleanLine.match(/Local:\s+(https?:\/\/\S+)/);
        if (!ready && match?.[1]) {
          ready = true;
          clearTimeout(timer);
          resolveReady(new URL(match[1]).origin);
        }
      }
    },
  });
  const exit = observeExit(vite);
  exit.then(result => {
    clearTimeout(timer);
    if (!ready) rejectReady(result.error ?? new Error(`Vite exited with status ${result.code}`));
  });
  return { child: vite, ready: readyPromise, exit };
}

try {
  // The host still needs its generated contracts and server build. Vite owns
  // the browser bundle in this mode, so rebuilding the web app here would
  // defeat the fast feedback loop.
  await run('corepack', ['pnpm', '--filter', '@app/host', 'build']);
  const hostEntry = process.env.PODCASTER_HOST_ENTRY ?? 'apps/host/dist/server/main.js';
  const host = startHost(hostEntry);
  const backendOrigin = await host.ready;

  const vite = startVite({
    ...process.env,
    PODCASTER_BACKEND_ORIGIN: backendOrigin,
    PODCASTER_WEB_PORT: String(webPort),
  });
  await vite.ready;
  process.stdout.write(`Podcaster dev: ${webOrigin}\n`);

  const result = await Promise.race([
    host.exit.then(value => ({ name: 'host', ...value })),
    vite.exit.then(value => ({ name: 'vite', ...value })),
  ]);
  await terminateActive();
  if (!shuttingDown) {
    if (result.error) process.stderr.write(`${result.name}: ${result.error.message}\n`);
    process.exitCode = result.code;
  }
} catch (error) {
  await terminateActive();
  if (!shuttingDown) {
    process.stderr.write(`dev: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
