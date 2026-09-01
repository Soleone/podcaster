import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../../src/server/app.js';

interface SecurityRequestHeaders {
  host: string;
  origin?: string;
}
import { startSidecar, type SidecarProcess } from '../../src/sidecar/process.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let sidecar: SidecarProcess;
let origin: string;
let currentTime = 1_000;
const headers = () => ({ host: new URL(origin).host, origin });

beforeAll(async () => {
  sidecar = await startSidecar();
  app = await buildApp({ sidecar, now: () => currentTime });
  origin = await app.listen({ host: '127.0.0.1', port: 0 });
  app.setCanonicalOrigin(origin);
});
afterAll(async () => {
  await app?.close();
  await sidecar?.stop();
});

async function bootstrap() {
  const response = await fetch(`${origin}/api/bootstrap`, {
    method: 'POST',
    headers: { ...headers(), 'content-type': 'application/json' },
    body: '{"disclosureAcknowledged":true}',
  });
  return {
    response,
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    body: (await response.json()) as { capability: string },
    cookie: response.headers.get('set-cookie')!.split(';')[0]!,
  };
}

describe('loopback HTTP boundary', () => {
  it('binds host and owned sidecar to assigned IPv4 loopback ports', () => {
    expect(new URL(origin).hostname).toBe('127.0.0.1');
    expect(Number(new URL(origin).port)).toBeGreaterThan(0);
    expect(new URL(sidecar.origin).hostname).toBe('127.0.0.1');
    expect(Number(new URL(sidecar.origin).port)).toBeGreaterThan(0);
  });
  it.each([undefined, 'http://evil.example', 'null'])(
    'rejects missing or mismatched API Origin: %s',
    async (badOrigin) => {
      const requestHeaders: SecurityRequestHeaders = { host: new URL(origin).host };
      if (badOrigin) requestHeaders.origin = badOrigin;
      expect((await fetch(`${origin}/api/readiness`, { method: 'POST', headers: requestHeaders })).status).toBe(403);
    },
  );
  it('rejects non-exact Host', async () => {
    expect(
      (await app.inject({ method: 'POST', url: '/api/readiness', headers: { host: 'localhost', origin } })).statusCode,
    ).toBe(421);
  });
  it('fails API requests closed before canonical origin is installed', async () => {
    const uninitialized = await buildApp({ sidecar });
    expect(
      (await uninitialized.inject({ method: 'POST', url: '/api/bootstrap', payload: { disclosureAcknowledged: true } }))
        .statusCode,
    ).toBe(503);
    expect((await uninitialized.inject({ method: 'GET', url: '/ws' })).statusCode).toBe(503);
    await uninitialized.close();
  });
  it('sets no CORS and emits a strict first-party CSP', async () => {
    const response = await fetch(`${origin}/api/readiness`, { method: 'POST', headers: headers() });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    const csp = response.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/https?:|\*/);
  });
  it('requires explicit disclosure and limits request bodies', async () => {
    expect(
      (
        await fetch(`${origin}/api/bootstrap`, {
          method: 'POST',
          headers: { ...headers(), 'content-type': 'application/json' },
          body: '{"disclosureAcknowledged":false}',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${origin}/api/bootstrap`, {
          method: 'POST',
          headers: { ...headers(), 'content-type': 'application/json' },
          body: JSON.stringify({ disclosureAcknowledged: true, padding: 'x'.repeat(17000) }),
        })
      ).status,
    ).toBe(413);
  });
  it('issues 256-bit capability and strict HttpOnly cookie only after acknowledgement', async () => {
    const { response, body } = await bootstrap();
    const cookie = response.headers.get('set-cookie')!;
    expect(Buffer.from(body.capability, 'base64url')).toHaveLength(32);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });
  it('requires cookie, capability, and exact Origin for mutation; stop invalidates it', async () => {
    const { body, cookie } = await bootstrap();
    expect(
      (
        await fetch(`${origin}/api/stop`, {
          method: 'POST',
          headers: { ...headers(), 'x-podcaster-capability': body.capability },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${origin}/api/stop`, {
          method: 'POST',
          headers: { ...headers(), cookie, 'x-podcaster-capability': 'wrong' },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${origin}/api/stop`, {
          method: 'POST',
          headers: { ...headers(), cookie, 'x-podcaster-capability': body.capability },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${origin}/api/stop`, {
          method: 'POST',
          headers: { ...headers(), cookie, 'x-podcaster-capability': body.capability },
        })
      ).status,
    ).toBe(401);
  });
  it('expires capabilities at twelve hours', async () => {
    currentTime = 5_000;
    const { body, cookie } = await bootstrap();
    currentTime += 12 * 60 * 60 * 1000 + 1;
    expect(
      (
        await fetch(`${origin}/api/stop`, {
          method: 'POST',
          headers: { ...headers(), cookie, 'x-podcaster-capability': body.capability },
        })
      ).status,
    ).toBe(401);
    currentTime = 1_000;
  });
});

describe('WebSocket authentication', () => {
  function connect(cookie: string, path = '/ws') {
    return new WebSocket(origin.replace('http', 'ws') + path, { headers: { Origin: origin, Cookie: cookie } });
  }
  function closed(ws: WebSocket) {
    return new Promise<number>((resolve, reject) => {
      ws.once('close', resolve);
      ws.once('error', reject);
    });
  }
  it('rejects a WebSocket handshake without exact Origin', async () => {
    const { cookie } = await bootstrap();
    const response = await app.inject({
      method: 'GET',
      url: '/ws',
      headers: {
        host: new URL(origin).host,
        cookie,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': Buffer.alloc(16).toString('base64'),
      },
    });
    expect(response.statusCode).toBe(403);
  });
  it('accepts capability only in first message and never in query', async () => {
    const { body, cookie } = await bootstrap();
    const query = connect(cookie, `/ws?capability=${body.capability}`);
    expect(await closed(query)).toBeGreaterThanOrEqual(1000);
    const ws = connect(cookie);
    const message = new Promise<string>((resolve) => ws.once('message', (value) => resolve(value.toString())));
    ws.once('open', () => ws.send(JSON.stringify({ capability: body.capability })));
    expect(await message).toContain('authenticated');
    const didClose = closed(ws);
    ws.close();
    await didClose;
  });
  it('rejects missing, wrong, and replayed first-message authentication', async () => {
    const { body, cookie } = await bootstrap();
    const wrong = connect(cookie);
    wrong.once('open', () => wrong.send('{"capability":"wrong"}'));
    expect(await closed(wrong)).toBe(1008);
    const first = connect(cookie);
    await new Promise<void>((resolve) => {
      first.once('message', () => resolve());
      first.once('open', () => first.send(JSON.stringify({ capability: body.capability })));
    });
    const firstClosed = closed(first);
    first.close();
    await firstClosed;
    const replay = connect(cookie);
    const replayMessage = new Promise<string>((resolve) =>
      replay.once('message', (value) => resolve(value.toString())),
    );
    replay.once('open', () => replay.send(JSON.stringify({ capability: body.capability })));
    expect(await replayMessage).toContain('authenticated');
    const replayClosed = closed(replay);
    replay.close();
    await replayClosed;
  });
  async function authenticatedSocket(body: { capability: string }, cookie: string) {
    const ws = connect(cookie);
    await new Promise<void>((resolve) => {
      ws.once('message', () => resolve());
      ws.once('open', () => ws.send(JSON.stringify({ capability: body.capability })));
    });
    return ws;
  }
  it('closes an authenticated live socket when its session is stopped', async () => {
    const { body, cookie } = await bootstrap();
    const ws = await authenticatedSocket(body, cookie);
    const didClose = closed(ws);
    expect(
      (
        await fetch(`${origin}/api/stop`, {
          method: 'POST',
          headers: { ...headers(), cookie, 'x-podcaster-capability': body.capability },
        })
      ).status,
    ).toBe(200);
    expect(await didClose).toBe(1008);
  });
  it('suppresses authenticated socket traffic after fake-clock expiry', async () => {
    currentTime = 10_000;
    const { body, cookie } = await bootstrap();
    const ws = await authenticatedSocket(body, cookie);
    const didClose = closed(ws);
    currentTime += 12 * 60 * 60 * 1000 + 1;
    ws.send('after-expiry');
    expect(await didClose).toBe(1008);
    currentTime = 1_000;
  });
  it('closes an idle authenticated socket at a short configured TTL', async () => {
    const short = await buildApp({ sidecar, sessionTtlMs: 30 });
    const shortOrigin = await short.listen({ host: '127.0.0.1', port: 0 });
    short.setCanonicalOrigin(shortOrigin);
    const h = { host: new URL(shortOrigin).host, origin: shortOrigin, 'content-type': 'application/json' };
    const response = await fetch(`${shortOrigin}/api/bootstrap`, {
      method: 'POST',
      headers: h,
      body: '{"disclosureAcknowledged":true}',
    });
    // SAFETY: this test fixture is constructed in this file with the asserted shape.
    const body = (await response.json()) as { capability: string };
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const ws = new WebSocket(shortOrigin.replace('http', 'ws') + '/ws', {
      headers: { Origin: shortOrigin, Cookie: cookie },
    });
    ws.once('open', () => ws.send(JSON.stringify({ capability: body.capability })));
    await new Promise((resolve) => ws.once('message', resolve));
    expect(await closed(ws)).toBe(1008);
    await short.close();
  });
  it('rejects oversized frames', async () => {
    const { body, cookie } = await bootstrap();
    const ws = await authenticatedSocket(body, cookie);
    ws.send(Buffer.alloc(70 * 1024));
    expect(await closed(ws)).toBe(1009);
  });
});
