import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface DevServer { child: ChildProcess; origin: string }
export async function startDevServer(options: { fakeServices?: boolean } = {}): Promise<DevServer> {
  const env = { ...process.env, PODCASTER_PORT: '0', ...(options.fakeServices ? { PODCASTER_WEB_BUILD_ENTRY: 'scripts/build-web-fake.mjs' } : {}) };
  const child = spawn('node', ['scripts/dev.mjs'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], shell: false, env });
  const origin = await new Promise<string>((resolve, reject) => {
    const stderr: string[] = [];
    child.stderr?.on('data', chunk => stderr.push(String(chunk)));
    const timer = setTimeout(() => reject(new Error(`dev startup timeout: ${stderr.join('')}`)), 20_000);
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', line => { const match = line.match(/Podcaster readiness: (http:\/\/127\.0\.0\.1:\d+)/); if (match?.[1]) { clearTimeout(timer); resolve(match[1]); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`dev exited ${code}: ${stderr.join('')}`)); });
  });
  return { child, origin };
}
export async function stopDevServer(server: DevServer | undefined): Promise<void> {
  if (!server || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await new Promise<void>(resolve => server.child.once('exit', () => resolve()));
}
