import { spawnSync } from 'node:child_process';
const result = spawnSync('corepack', ['pnpm', '--filter', '@app/web', 'exec', 'vite', 'build', '--mode', 'fake-services'], { stdio: 'inherit', shell: false });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
