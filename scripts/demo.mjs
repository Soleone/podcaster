#!/usr/bin/env node
// Runs the app with canned speech, replies and Pi, so you can look around without local models or a Pi account.
// Usage: npm run demo. Stop with Ctrl-C. Set PODCASTER_PORT to change the port (43127 by default).
import { once } from 'node:events';
import { startDemoServer } from './demo-server.mjs';

const demo = await startDemoServer({ port: process.env.PODCASTER_PORT ?? '43127', log: (line) => console.log(line) });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => demo.close());
console.log(`Open ${demo.origin}. Nothing you say is heard: the replies are canned.`);
await once(demo.child, 'exit');
