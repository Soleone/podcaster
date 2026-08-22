import { spawn } from 'node:child_process';

const defaultShutdownTimeoutMs = 3_000;

function groupExists(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function waitForGroupExit(pgid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (groupExists(pgid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  return !groupExists(pgid);
}

export function createProcessGroupManager({
  cwd,
  shutdownTimeoutMs = defaultShutdownTimeoutMs,
  onEscalate = () => process.stderr.write('dev: process group did not stop in time; escalating to SIGKILL\n'),
} = {}) {
  const active = new Map();

  async function terminateGroup(pgid, initialSignal = 'SIGTERM') {
    if (!groupExists(pgid)) return;
    signalGroup(pgid, initialSignal);
    if (!(await waitForGroupExit(pgid, shutdownTimeoutMs))) {
      onEscalate();
      signalGroup(pgid, 'SIGKILL');
      await waitForGroupExit(pgid, shutdownTimeoutMs);
    }
  }

  function spawnGroup(command, args, { env = process.env, pipeStdout = false, onStdout, stdio = 'inherit' } = {}) {
    const child = spawn(command, args, {
      cwd,
      stdio: pipeStdout ? ['ignore', 'pipe', 'inherit'] : stdio,
      shell: false,
      detached: true,
      env,
    });
    const pgid = child.pid;
    if (pgid === undefined) throw new Error(`${command} did not provide a process id`);
    active.set(pgid, { child, pgid });
    if (pipeStdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => onStdout?.(String(chunk)));
    }
    return child;
  }

  async function terminateActive(initialSignal = 'SIGTERM') {
    const groups = [...active.values()];
    await Promise.all(
      groups.map(async ({ pgid }) => {
        await terminateGroup(pgid, initialSignal);
        active.delete(pgid);
      }),
    );
  }

  async function finishGroup(child) {
    const pgid = child.pid;
    if (pgid === undefined) return;
    await terminateGroup(pgid);
    active.delete(pgid);
  }

  return { spawnGroup, terminateActive, finishGroup };
}
