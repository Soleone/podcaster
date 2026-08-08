import { describe, expect, it } from 'vitest';
import { createEnvelope, uuidV7 } from './envelope';

describe('browser event envelopes', () => {
  it('creates UUIDv7 identifiers with correct version and variant', () => {
    let value = 0;
    const random = (bytes: Uint8Array) => { bytes.fill(value++); return bytes; };
    const first = uuidV7(1_700_000_000_000, random);
    const second = uuidV7(1_700_000_000_000, random);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
  });
  it('clamps monotonic time and freezes the expected protocol shape', () => {
    expect(createEnvelope({ sessionId: 's', epoch: 3, type: 'x', payload: { ok: true }, now: () => -5, idFactory: () => 'id' })).toEqual({ protocolVersion: 1, sessionId: 's', epoch: 3, eventId: 'id', type: 'x', monotonicMs: 0, payload: { ok: true } });
  });
});
