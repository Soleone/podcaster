export interface Envelope<T extends string = string, P extends Record<string, unknown> = Record<string, unknown>> {
  protocolVersion: 1; sessionId: string; epoch: number; eventId: string; type: T; monotonicMs: number; payload: P;
}

export function uuidV7(now = Date.now(), randomValues: (bytes: Uint8Array) => Uint8Array = bytes => crypto.getRandomValues(bytes)): string {
  const bytes = randomValues(new Uint8Array(16));
  let timestamp = Math.max(0, Math.floor(now));
  for (let index = 5; index >= 0; index--) { bytes[index] = timestamp & 0xff; timestamp = Math.floor(timestamp / 256); }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createEnvelope<T extends string, P extends Record<string, unknown>>(input: { sessionId: string; epoch: number; type: T; payload: P; now?: () => number; idFactory?: () => string }): Envelope<T, P> {
  const monotonicMs = Math.max(0, input.now?.() ?? performance.now());
  return { protocolVersion: 1, sessionId: input.sessionId, epoch: input.epoch, eventId: input.idFactory?.() ?? uuidV7(), type: input.type, monotonicMs, payload: input.payload };
}
