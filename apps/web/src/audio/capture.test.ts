import { describe, expect, it, vi } from 'vitest';
import { BrowserCapture } from './capture';

const connector = () => ({ connect: vi.fn(), disconnect: vi.fn() });

describe('BrowserCapture', () => {
  it('requests mono audio only when start is called and releases every owned resource', async () => {
    const track = { stop: vi.fn(), addEventListener: vi.fn() };
    const stream = { getTracks: () => [track] };
    const getUserMedia = vi.fn(async () => stream);
    const source = connector(); const gain = { ...connector(), gain: { value: 1 } };
    const context = {
      sampleRate: 48_000, audioWorklet: { addModule: vi.fn(async () => undefined) },
      createMediaStreamSource: vi.fn(() => source), createGain: vi.fn(() => gain), destination: {}, close: vi.fn(async () => undefined),
    };
    const node = { ...connector(), port: { onmessage: null as ((event: MessageEvent) => void) | null } };
    const capture = new BrowserCapture({ mediaDevices: { getUserMedia } as unknown as MediaDevices, createAudioContext: () => context as unknown as AudioContext, createWorkletNode: () => node as unknown as AudioWorkletNode, streamId: () => 9 });
    expect(getUserMedia).not.toHaveBeenCalled();
    const send = vi.fn(); const handle = await capture.start({ send, degraded: vi.fn() });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
    node.port.onmessage?.({ data: new Float32Array(960) } as MessageEvent);
    await Promise.resolve(); expect(send).toHaveBeenCalled();
    await handle.stop();
    expect(track.stop).toHaveBeenCalledOnce(); expect(context.close).toHaveBeenCalledOnce();
  });

  it('releases the acquired microphone when AudioContext construction fails', async () => {
    const track = { stop: vi.fn(), addEventListener: vi.fn() };
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }));
    const capture = new BrowserCapture({
      mediaDevices: { getUserMedia } as unknown as MediaDevices,
      createAudioContext: () => { throw new Error('audio context unavailable'); },
    });
    await expect(capture.start({ send: vi.fn(), degraded: vi.fn() })).rejects.toThrow('audio context unavailable');
    expect(track.stop).toHaveBeenCalledOnce();
  });
});
