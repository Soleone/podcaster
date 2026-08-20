import { buildApp } from './app.js';
import { startSidecar } from '../sidecar/process.js';
import { createPiClient } from '../pi/PiClient.js';
const sidecar = await startSidecar();
const app = await buildApp({
  sidecar,
  createProbeClient: piSettings => createPiClient({ model: piSettings.model, thinkingLevel: piSettings.thinkingLevel }),
});
const configuredPort = process.env.PODCASTER_PORT ?? '43127';
const port = Number(configuredPort);
if (!/^\d+$/.test(configuredPort) || (port !== 0 && port < 1_024) || port > 65_535) {
  await sidecar.stop();
  throw new Error('PODCASTER_PORT must be 0 or an integer from 1024 through 65535');
}
try {
  const address = await app.listen({ host: '127.0.0.1', port });
  app.setCanonicalOrigin(address);
  process.stdout.write(`Podcaster readiness: ${address}\n`);
  const shutdown = async () => { await app.close(); await sidecar.stop(); process.exit(0); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
} catch (error) { await sidecar.stop(); throw error; }
