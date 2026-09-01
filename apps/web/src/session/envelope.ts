import type { BrowserCommand, HostEvent } from '@app/contracts';

type EventForType<Event, T extends string> = Event extends infer Candidate
  ? Candidate extends { type: infer Type }
    ? T extends Type
      ? Candidate
      : never
    : never
  : never;
type EventPayloadForType<Event, T extends string> =
  EventForType<Event, T> extends infer Candidate
    ? Candidate extends { payload: infer Payload }
      ? Payload
      : never
    : never;

export type ProtocolEvent = HostEvent | BrowserCommand;
export type ProtocolEventFor<T extends ProtocolEvent['type']> = EventForType<ProtocolEvent, T>;
export type HostEventFor<T extends HostEvent['type']> = EventForType<HostEvent, T>;
export type HostEventPayload<T extends HostEvent['type']> = EventPayloadForType<HostEvent, T>;
export type BrowserCommandFor<T extends BrowserCommand['type']> = EventForType<BrowserCommand, T>;
export type BrowserCommandPayload<T extends BrowserCommand['type']> = EventPayloadForType<BrowserCommand, T>;
export type Envelope<T extends ProtocolEvent['type'] = ProtocolEvent['type']> = ProtocolEventFor<T>;

/** Per-type resolved envelope and payload contracts, keyed by event type. */
export type EnvelopeByType = { [K in ProtocolEvent['type']]: EventForType<ProtocolEvent, K> };
export type PayloadByType = { [K in ProtocolEvent['type']]: EventPayloadForType<ProtocolEvent, K> };

export function uuidV7(
  now = Date.now(),
  randomValues: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes),
): string {
  const bytes = randomValues(new Uint8Array(16));
  let timestamp = Math.max(0, Math.floor(now));
  for (let index = 5; index >= 0; index--) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface EnvelopeInput {
  sessionId: string;
  epoch: number;
  eventId: string;
  monotonicMs: number;
}
type EnvelopeFactoryInput<K extends ProtocolEvent['type']> = EnvelopeInput & { payload: PayloadByType[K] };

/**
 * One constructor per event type. Each factory returns a literal whose type
 * property is the concrete event type, so TypeScript can verify the produced
 * object satisfies the union member for that type without any assertion.
 */
type EnvelopeFactoryMap = {
  [K in ProtocolEvent['type']]: (input: EnvelopeFactoryInput<K>) => EnvelopeByType[K];
};

const envelopeFactories: EnvelopeFactoryMap = {
  'session.state': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'session.state',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'vad.speech_start': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'vad.speech_start',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'vad.speech_end': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'vad.speech_end',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'transcript.partial': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'transcript.partial',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'transcript.final': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'transcript.final',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'policy.decision': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'policy.decision',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'barge_in.provisional': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'barge_in.provisional',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'barge_in.confirmed': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'barge_in.confirmed',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'barge_in.rejected': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'barge_in.rejected',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'barge_in.timed_out': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'barge_in.timed_out',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'interruption.decision': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'interruption.decision',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'reasoning.started': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'reasoning.started',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'reasoning.delta': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'reasoning.delta',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'reasoning.final': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'reasoning.final',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'response.failed': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'response.failed',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'response.cancelled': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'response.cancelled',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'tts.started': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'tts.started',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'tts.ended': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'tts.ended',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'tool.activity': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'tool.activity',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  failure: (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'failure',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'session.open': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'session.open',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'session.begin': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'session.begin',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'planning.cancel': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'planning.cancel',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'planning.retry': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'planning.retry',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'audio.start': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'audio.start',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'audio.stop': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'audio.stop',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'turn.cancel': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'turn.cancel',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'barge_in.confirm': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'barge_in.confirm',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'barge_in.reject': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'barge_in.reject',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'turn.persisted': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'turn.persisted',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'turn.persistence_failed': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'turn.persistence_failed',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'session.stop': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'session.stop',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'playback.progress': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'playback.progress',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'playback.paused': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'playback.paused',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'playback.stopped': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'playback.stopped',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
  'session.rollback_begin': (input) => ({
    protocolVersion: 1,
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.eventId,
    type: 'session.rollback_begin',
    monotonicMs: input.monotonicMs,
    payload: input.payload,
  }),
};

export function createEnvelope<T extends ProtocolEvent['type']>(input: {
  sessionId: string;
  epoch: number;
  type: T;
  payload: PayloadByType[T];
  now?: () => number;
  idFactory?: () => string;
}): EnvelopeByType[T] {
  const monotonicMs = Math.max(0, input.now?.() ?? performance.now());
  return envelopeFactories[input.type]({
    sessionId: input.sessionId,
    epoch: input.epoch,
    eventId: input.idFactory?.() ?? uuidV7(),
    monotonicMs,
    payload: input.payload,
  });
}
