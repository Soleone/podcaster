import { spawn } from 'node:child_process';

if (process.argv[2] === 'grandchild') {
  process.on('SIGTERM', () => {});
  process.on('SIGINT', () => {});
  process.send?.('ready');
  setInterval(() => {}, 1_000);
} else {
  const grandchild = spawn(process.execPath, [new URL(import.meta.url).pathname, 'grandchild'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  grandchild.once('message', () => {
    process.stdout.write(`DESCENDANT_PIDS ${process.pid} ${grandchild.pid}\n`);
    process.stdout.write(process.env.FIXTURE_MODE === 'build' ? 'BUILD_WEDGED\n' : 'Podcaster readiness: http://127.0.0.1:1\n');
  });
  setInterval(() => {}, 1_000);
}
