import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

if (process.argv[2] === 'grandchild') {
  process.on('SIGTERM', () => {});
  process.send?.('ready');
  setInterval(() => {}, 1_000);
} else {
  const grandchild = spawn(process.execPath, [new URL(import.meta.url).pathname, 'grandchild'], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  grandchild.once('message', () => {
    const stat = readFileSync(`/proc/${grandchild.pid}/stat`, 'utf8');
    const startTime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    process.stdout.write(`DESCENDANT_ID ${grandchild.pid} ${startTime}\n`, () => {
      process.exit(Number(process.env.FIXTURE_BUILD_EXIT_CODE ?? 0));
    });
  });
}
