import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { PODCASTER_SYSTEM_PROMPT } from '@app/contracts';
import { PI_MODEL, StdioPiClient, type PiEvent, type PiRequestInput } from '../../src/pi/PiClient.js';
import { makeFakePi, type FakePiScenario } from '../fixtures/fake-pi.js';

const input: PiRequestInput = {
  posture: 'riff',
  transcript: 'A stable transcript',
  boundedContext: 'Prior local context',
  maxWords: 45,
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
async function client(scenario: FakePiScenario = 'normal') {
  const fake = await makeFakePi(scenario);
  cleanups.push(fake.cleanup);
  return {
    fake,
    value: new StdioPiClient({ executable: fake.executable, startupDeadlineMs: 300, requestDeadlineMs: 500 }),
  };
}

async function events(value: StdioPiClient, signal = new AbortController().signal): Promise<PiEvent[]> {
  const result: PiEvent[] = [];
  for await (const event of value.request(input, signal)) result.push(event);
  return result;
}

describe('production Pi RPC boundary', () => {
  it('passes a configured model and thinking level to Pi', async () => {
    const { value, fake } = await client();
    const configured = new StdioPiClient({
      executable: fake.executable,
      model: 'anthropic/claude-sonnet',
      thinkingLevel: 'high',
      startupDeadlineMs: 300,
      requestDeadlineMs: 500,
    });
    expect(await configured.probe()).toMatchObject({ status: 'incompatible' });
    await configured.shutdown();
    const calls = (await readFile(fake.log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls[0].argv).toContain('--thinking');
    expect(calls[0].argv).toContain('high');
    expect(calls[0].argv).toContain('anthropic/claude-sonnet');
  });

  it('maps ready and keeps executable, model and disabled-resource argv pinned', async () => {
    const { value, fake } = await client();
    expect(await value.probe()).toMatchObject({ status: 'ready', correctiveAction: 'None.' });
    await value.shutdown();
    const calls = (await readFile(fake.log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls[0].argv).toEqual([
      '--mode',
      'rpc',
      '--no-session',
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--no-approve',
      '--model',
      PI_MODEL,
      '--system-prompt',
      PODCASTER_SYSTEM_PROMPT,
      '--append-system-prompt',
      'Do not use tools or attempt to read files.',
    ]);
    expect(calls[0].env).not.toContain('OPENAI_API_KEY');
  });

  it('bounds a provider readiness probe separately from the normal request deadline', async () => {
    const fake = await makeFakePi('hanging-probe');
    cleanups.push(fake.cleanup);
    const value = new StdioPiClient({
      executable: fake.executable,
      startupDeadlineMs: 300,
      requestDeadlineMs: 5_000,
      probeDeadlineMs: 50,
    });
    const startedAt = Date.now();
    await expect(value.probe()).resolves.toMatchObject({ status: 'unavailable' });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await value.shutdown();
  });

  it.each([
    ['login', 'login_required'],
    ['rate-limit', 'rate_limited'],
    ['incompatible-model', 'incompatible'],
  ] as const)('maps %s readiness safely', async (scenario, expected) => {
    const { value } = await client(scenario);
    const status = await value.probe();
    expect(status.status).toBe(expected);
    expect(status.detail).not.toMatch(/secret|token=/i);
  });

  it('does not accept unrelated normally settled assistant text as readiness or mislabel it as an installation mismatch', async () => {
    const { value } = await client('unrelated-probe');
    expect(await value.probe()).toMatchObject({ status: 'unavailable' });
    await value.shutdown();
  });

  it('exposes only text delta/final and never thinking content', async () => {
    const { value } = await client();
    const result = await events(value);
    expect(result).toEqual([
      { type: 'delta', text: 'Hello' },
      { type: 'delta', text: ' world' },
      { type: 'final', text: 'Hello world' },
    ]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    await value.shutdown();
  });

  it('treats U+2028 as content rather than a JSONL separator', async () => {
    const { value } = await client('unicode-separator');
    expect(await events(value)).toContainEqual({ type: 'delta', text: '\u2028world' });
    await value.shutdown();
  });

  it.each(['malformed', 'oversized', 'invalid-utf8', 'crlf', 'crash', 'too-many-words'] as const)(
    'fails safely on %s child output',
    async (scenario) => {
      const { value } = await client(scenario);
      const result = await events(value);
      expect(result.at(-1)).toMatchObject({ type: 'error', state: 'unavailable' });
      expect(JSON.stringify(result)).not.toMatch(/authorization|bearer|api[_-]?key/i);
      await value.shutdown();
    },
  );

  it.each([
    ['async-login', 'login_required'],
    ['async-rate-limit', 'rate_limited'],
  ] as const)('classifies sanitized asynchronous provider failure %s', async (scenario, state) => {
    const { value } = await client(scenario);
    const result = await events(value);
    expect(result.at(-1)).toEqual(expect.objectContaining({ type: 'error', state }));
    expect(JSON.stringify(result)).not.toMatch(/SUPERSECRET|bearer|HTTP 429/i);
    await value.shutdown();
  });

  it('serializes a probe behind request ownership', async () => {
    const { value } = await client('slow');
    const request = events(value);
    const probe = value.probe();
    expect((await request).at(-1)).toMatchObject({ type: 'final' });
    expect(await probe).toMatchObject({ status: 'ready' });
    await value.shutdown();
  });

  it('kills a stubborn descendant in the owned process group', async () => {
    const { value, fake } = await client('stubborn-descendant');
    expect(await value.probe()).toMatchObject({ status: 'ready' });
    const calls = (await readFile(fake.log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const descendantPid = calls.find((item) => item.descendantPid)?.descendantPid as number;
    expect(descendantPid).toBeTypeOf('number');
    await value.shutdown();
    expect(() => process.kill(descendantPid, 0)).toThrow();
  });

  it('has no provider fallback or API-key path', async () => {
    const source = await readFile(new URL('../../src/pi/PiClient.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/OPENAI_API_KEY|ANTHROPIC_API_KEY|fallbackProvider|alternateProvider/);
  });
});
