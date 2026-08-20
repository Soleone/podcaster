import { spawnSync } from 'node:child_process';

const contracts = spawnSync('corepack', ['pnpm', '--filter', '@app/contracts', 'build'], { stdio: 'inherit', shell: false });
if (contracts.error) throw contracts.error;
if (contracts.status !== 0) process.exit(contracts.status ?? 1);

const result = spawnSync('corepack', ['pnpm', '--filter', '@app/web', 'exec', 'vite', 'build', '--mode', 'fake-services'], { stdio: 'inherit', shell: false });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
