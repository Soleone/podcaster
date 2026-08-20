import type { BrowserCommand, HostEvent } from '@app/contracts';

type EventForType<Event, T extends string> = Event extends infer Candidate
  ? Candidate extends { type: infer Type }
    ? T extends Type ? Candidate : never
    : never
  : never;
type EventPayloadForType<Event, T extends string> = EventForType<Event, T> extends infer Candidate
  ? Candidate extends { payload: infer Payload } ? Payload : never
  : never;

export type ProtocolEvent = HostEvent | BrowserCommand;
export type ProtocolEventFor<T extends ProtocolEvent['type']> = EventForType<ProtocolEvent, T>;
export type HostEventFor<T extends HostEvent['type']> = EventForType<HostEvent, T>;
export type HostEventPayload<T extends HostEvent['type']> = EventPayloadForType<HostEvent, T>;
export type BrowserCommandFor<T extends BrowserCommand['type']> = EventForType<BrowserCommand, T>;
export type BrowserCommandPayload<T extends BrowserCommand['type']> = EventPayloadForType<BrowserCommand, T>;
export type Envelope<T extends ProtocolEvent['type'] = ProtocolEvent['type']> = ProtocolEventFor<T>;

export function uuidV7(now = Date.now(), randomValues: (bytes: Uint8Array) => Uint8Array = bytes => crypto.getRandomValues(bytes)): string {
  const bytes = randomValues(new Uint8Array(16));
  let timestamp = Math.max(0, Math.floor(now));
  for (let index = 5; index >= 0; index--) { bytes[index] = timestamp & 0xff; timestamp = Math.floor(timestamp / 256); }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createEnvelope<T extends ProtocolEvent['type']>(input: { sessionId: string; epoch: number; type: T; payload: EventPayloadForType<ProtocolEvent, T>; now?: () => number; idFactory?: () => string }): ProtocolEventFor<T> {
  const monotonicMs = Math.max(0, input.now?.() ?? performance.now());
  return { protocolVersion: 1, sessionId: input.sessionId, epoch: input.epoch, eventId: input.idFactory?.() ?? uuidV7(), type: input.type, monotonicMs, payload: input.payload } as unknown as ProtocolEventFor<T>;
}
