#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const filterAt = args.indexOf('--filter');
let command;
if (filterAt >= 0) {
  const filter = args[filterAt + 1];
  if (!filter) {
    console.error('--filter requires a workspace package');
    process.exit(2);
  }
  const separator = args.indexOf('--', filterAt + 2);
  const forwarded = separator >= 0 ? args.slice(separator + 1) : args.slice(filterAt + 2);
  command = ['--filter', filter, 'test', ...(forwarded.length ? ['--', ...forwarded] : [])];
} else {
  command = ['--recursive', '--if-present', 'test', ...args];
}
const result = spawnSync('pnpm', command, { stdio: 'inherit', shell: false });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
