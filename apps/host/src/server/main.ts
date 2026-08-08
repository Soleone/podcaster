import { buildApp } from './app.js';
import { startSidecar } from '../sidecar/process.js';
const sidecar = await startSidecar();
const app = await buildApp({ sidecar });
try {
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  app.setCanonicalOrigin(address);
  process.stdout.write(`Podcaster readiness: ${address}\n`);
  const shutdown = async () => { await app.close(); await sidecar.stop(); process.exit(0); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
} catch (error) { await sidecar.stop(); throw error; }
