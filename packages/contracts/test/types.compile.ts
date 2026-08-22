import type { CoreEvent, HostEvent, PlaybackStoppedEvent } from '../src/generated/contracts.js';

const coreEvent: CoreEvent = {
  protocolVersion: 1,
  sessionId: '018f06b5-3c8d-7b2a-9f35-8b3388a857f1',
  epoch: 0,
  eventId: '018f06b5-3c8d-7b2a-9f35-8b3388a857f2',
  type: 'session.start',
  monotonicMs: 1,
  payload: {},
};
const playbackReceipt: PlaybackStoppedEvent = {
  ...coreEvent,
  type: 'playback.stopped',
  payload: {
    playbackId: '018f06b5-3c8d-7b2a-9f35-8b3388a857f4',
    cancelledEpoch: 0,
    finalPlayedSampleOffset: 42,
    reason: 'cancelled',
  },
};
const hostEvent: HostEvent = {
  ...coreEvent,
  type: 'failure',
  payload: {
    code: 'reasoning_invalid',
    detail: 'Reasoning output was invalid.',
    correctiveAction: 'Continue listening.',
    recoverable: true,
  },
};
void coreEvent;
void playbackReceipt;
void hostEvent;

// @ts-expect-error unknown protocol event types are rejected
const unknownEvent: CoreEvent = { ...coreEvent, type: 'unknown.event' };
// @ts-expect-error event type is required
const missingType: CoreEvent = (({ type: _type, ...event }) => event)(coreEvent);
// @ts-expect-error specialized receipt payload fields are required
const incompleteReceipt: PlaybackStoppedEvent = { ...playbackReceipt, payload: { reason: 'cancelled' } };
// @ts-expect-error specialized receipt type is required
const missingReceiptType: PlaybackStoppedEvent = (({ type: _type, ...event }) => event)(playbackReceipt);
// @ts-expect-error protocol payloads must be objects, not primitives
const primitivePayload: CoreEvent = { ...coreEvent, payload: 'invalid' };
// @ts-expect-error protocol payloads must be objects, not arrays
const arrayPayload: CoreEvent = { ...coreEvent, payload: [] };
// @ts-expect-error HostEvent rejects the broad failure payload regression
const incompleteHostEvent: HostEvent = { ...hostEvent, payload: { detail: 'missing failure fields' } };
// @ts-expect-error browser commands are not HostEvent variants
const browserCommandAsHostEvent: HostEvent = { ...hostEvent, type: 'audio.start', payload: {} };
void unknownEvent;
void missingType;
void incompleteReceipt;
void missingReceiptType;
void primitivePayload;
void arrayPayload;
void incompleteHostEvent;
void browserCommandAsHostEvent;
