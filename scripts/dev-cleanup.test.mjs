import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

async function identity(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).split(' ');
    return { state: fields[0], startTime: fields[19] };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertProcessesGone(recorded) {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const live = [];
    for (const item of recorded) {
      const current = await identity(item.pid);
      if (current && current.startTime === item.startTime && current.state !== 'Z') live.push(item.pid);
    }
    if (live.length === 0) return;
    if (Date.now() >= deadline) assert.fail(`descendants still alive: ${live.join(', ')}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function runDev(hostEntry, trigger, timeout = '50', extraEnv = {}, launcher = 'scripts/dev.mjs') {
  const child = spawn(process.execPath, [launcher], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PODCASTER_HOST_ENTRY: hostEntry, PODCASTER_SHUTDOWN_TIMEOUT_MS: timeout, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = ''; let signalled = false; let recorded = false; const pids = []; const recordedIds = new Set();
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', async chunk => {
    stdout += chunk;
    for (const match of stdout.matchAll(/DESCENDANT_ID (\d+) (\d+)/g)) {
      const pid = Number(match[1]);
      if (!recordedIds.has(pid)) { recordedIds.add(pid); pids.push({ pid, startTime: match[2] }); }
    }
    const match = stdout.match(/DESCENDANT_PIDS (\d+) (\d+)/);
    if (match && !recorded) {
      recorded = true;
      for (const raw of match.slice(1)) { const pid = Number(raw); pids.push({ pid, ...(await identity(pid)) }); }
    }
    if (!signalled && trigger?.(stdout)) { signalled = true; child.kill('SIGTERM'); }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('dev cleanup test timed out')); }, 15_000);
    child.once('exit', value => { clearTimeout(timer); resolve(value); });
  });
  return { code, stderr, pids };
}

const host = await runDev('scripts/fixtures/wedged-descendants.mjs', stdout => stdout.includes('Podcaster readiness:'));
assert.equal(host.code, 143);
assert.match(host.stderr, /escalating to SIGKILL/);
assert.equal(host.pids.length, 2);
await assertProcessesGone(host.pids);

const hmrHost = await runDev('scripts/fixtures/wedged-descendants.mjs', stdout => stdout.includes('[backend] internal host:'), '50', {}, 'scripts/dev-hmr.mjs');
assert.equal(hmrHost.code, 143);
assert.match(hmrHost.stderr, /escalating to SIGKILL/);
assert.equal(hmrHost.pids.length, 2);
await assertProcessesGone(hmrHost.pids);

const build = await runDev('unused', stdout => stdout.includes('BUILD_WEDGED'), '50', {
  PODCASTER_WEB_BUILD_ENTRY: 'scripts/fixtures/wedged-descendants.mjs', FIXTURE_MODE: 'build',
});
assert.equal(build.code, 143);
assert.match(build.stderr, /escalating to SIGKILL/);
assert.equal(build.pids.length, 2);
await assertProcessesGone(build.pids);

const successfulBuildAndNormalHost = await runDev('scripts/fixtures/spontaneous-host-descendant.mjs', null, '50', {
  PODCASTER_WEB_BUILD_ENTRY: 'scripts/fixtures/spontaneous-build-descendant.mjs',
});
assert.equal(successfulBuildAndNormalHost.code, 0);
assert.equal(successfulBuildAndNormalHost.pids.length, 2);
assert.match(successfulBuildAndNormalHost.stderr, /escalating to SIGKILL/);
await assertProcessesGone(successfulBuildAndNormalHost.pids);

const failedBuild = await runDev('unused', null, '50', {
  PODCASTER_WEB_BUILD_ENTRY: 'scripts/fixtures/spontaneous-build-descendant.mjs', FIXTURE_BUILD_EXIT_CODE: '7',
});
assert.equal(failedBuild.code, 1);
assert.equal(failedBuild.pids.length, 1);
assert.match(failedBuild.stderr, /exited with status 7/);
await assertProcessesGone(failedBuild.pids);

const crashedHost = await runDev('scripts/fixtures/spontaneous-host-descendant.mjs', null, '50', {
  PODCASTER_WEB_BUILD_ENTRY: 'scripts/fixtures/spontaneous-build-descendant.mjs', FIXTURE_HOST_EXIT_CODE: '9',
});
assert.equal(crashedHost.code, 9);
assert.equal(crashedHost.pids.length, 2);
assert.match(crashedHost.stderr, /escalating to SIGKILL/);
await assertProcessesGone(crashedHost.pids);

const failed = await runDev('scripts/fixtures/does-not-exist.mjs');
assert.equal(failed.code, 1);
assert.match(failed.stderr, /MODULE_NOT_FOUND/);
process.stdout.write('dev cleans stubborn descendants after interruption and spontaneous leader exits; startup failure: passed\n');
