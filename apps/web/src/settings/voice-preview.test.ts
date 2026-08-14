import { afterEach, describe, expect, it, vi } from 'vitest';

interface FakeSource {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  buffer: unknown;
  onended: (() => void) | null;
}

interface FakeContext {
  state: AudioContextState;
  destination: symbol;
  resume: ReturnType<typeof vi.fn>;
  decodeAudioData: ReturnType<typeof vi.fn>;
  createBufferSource: ReturnType<typeof vi.fn>;
}

function installAudioMock() {
  const sources: FakeSource[] = [];
  const context: FakeContext = {
    state: 'running',
    destination: Symbol('destination'),
    resume: vi.fn(async () => { context.state = 'running'; }),
    decodeAudioData: vi.fn(async () => ({} as AudioBuffer)),
    createBufferSource: vi.fn(() => {
      const source: FakeSource = { start: vi.fn(), stop: vi.fn(() => { source.onended?.(); }), connect: vi.fn(), buffer: undefined, onended: null };
      sources.push(source);
      return source;
    }),
  };
  vi.stubGlobal('AudioContext', vi.fn(() => context));
  return { context, sources };
}

function installFetchMock(overrides: { ok?: boolean; status?: number; error?: string } = {}) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const response = {
      ok: overrides.ok ?? true,
      status: overrides.status ?? 200,
      arrayBuffer: async () => new ArrayBuffer(8),
      json: async () => (overrides.error ? { error: overrides.error } : {}),
    };
    return response as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// The player keeps a module-level AudioContext and active source, so each test
// loads a fresh module instance.
async function loadPlayer() {
  vi.resetModules();
  return import('./voice-preview');
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('startVoicePreview', () => {
  it('posts the voice to the preview endpoint and plays the returned audio', async () => {
    const { context, sources } = installAudioMock();
    const fetchMock = installFetchMock();
    const player = await loadPlayer();
    const handle = await player.startVoicePreview({ voiceId: 'af_bella', capability: 'cap-1' });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/voice-preview');
    expect(init!.method).toBe('POST');
    expect(init!.credentials).toBe('same-origin');
    expect((init!.headers as Record<string, string>)['x-podcaster-capability']).toBe('cap-1');
    expect(init!.body).toBe(JSON.stringify({ voiceId: 'af_bella', speedModifier: 1.0 }));

    expect(context.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.connect).toHaveBeenCalledWith(context.destination);
    expect(sources[0]!.start).toHaveBeenCalledTimes(1);

    let settled = false;
    void handle.finished.then(() => { settled = true; });
    sources[0]!.onended?.();
    await Promise.resolve();
    expect(settled).toBe(true);
  });

  it('stops a preview still playing when the next preview starts', async () => {
    const { sources } = installAudioMock();
    installFetchMock();
    const player = await loadPlayer();
    const first = await player.startVoicePreview({ voiceId: 'af_heart', capability: 'cap-1' });
    await player.startVoicePreview({ voiceId: 'af_bella', capability: 'cap-1' });
    expect(sources).toHaveLength(2);
    expect(sources[0]!.stop).toHaveBeenCalledTimes(1);
    expect(sources[1]!.start).toHaveBeenCalledTimes(1);
    first.stop();
  });

  it('resolves finished and stops playback when stop() is called', async () => {
    const { sources } = installAudioMock();
    installFetchMock();
    const player = await loadPlayer();
    const handle = await player.startVoicePreview({ voiceId: 'af_heart', capability: 'cap-1' });
    let settled = false;
    void handle.finished.then(() => { settled = true; });
    handle.stop();
    expect(sources[0]!.stop).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(settled).toBe(true);
  });

  it('surfaces the server error code when the preview is rejected', async () => {
    installAudioMock();
    installFetchMock({ ok: false, status: 503, error: 'preview_unavailable' });
    const player = await loadPlayer();
    await expect(player.startVoicePreview({ voiceId: 'af_heart', capability: 'cap-1' })).rejects.toThrow('preview_unavailable');
  });

  it('resumes a suspended AudioContext before playback', async () => {
    const { context } = installAudioMock();
    context.state = 'suspended';
    installFetchMock();
    const player = await loadPlayer();
    await player.startVoicePreview({ voiceId: 'af_heart', capability: 'cap-1' });
    expect(context.resume).toHaveBeenCalledTimes(1);
  });
});