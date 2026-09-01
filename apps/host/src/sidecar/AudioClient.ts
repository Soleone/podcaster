import { createHash, randomUUID } from 'node:crypto';
import {
  CONTRACT_VALIDATORS,
  decodeBinaryAudioFrame,
  DEFAULT_TTS_MODEL,
  DEFAULT_VOICE_SPEED_MODIFIER,
  type SidecarMessageSpeedCapability,
  type SidecarMessageWarmup,
} from '@app/contracts';
import WebSocket, { type RawData } from 'ws';
import type { SidecarProcess } from './process.js';
import {
  isJsonNumber,
  isJsonString,
  readArray,
  readBoolean,
  readNumber,
  readRecord,
  readString,
  type JsonValue,
} from './json-values.js';
import type { SpeechOutputPort, SpeechOutputStream, SpeechSynthesisStart } from '../session/SessionOrchestrator.js';

const MAX_PAYLOAD = 64 * 1024;
const MAX_BUFFERED_OUTPUT_CHUNKS = 64;
// Decision 007 two-stream prefetch: never open more than two nonterminal TTS
// streams on the sidecar; a third begin() waits (FIFO) for the oldest to
// terminalize before its tts.open is sent. The sidecar keeps a defensive
// len(state.tts) >= 2 bound for uncoordinated clients.
const MAX_ADMITTED_TTS = 2;
// AudioClient is a WebSocket *client* to the sidecar, so its closes must use
// client-valid application codes (3000-4999); 1008/1011 are server-only.
// node ws accepts any code, so these are symmetry/hygiene only.
const CLOSE_PROTOCOL_VIOLATION = 4001;
const CLOSE_SIDECAR_FAILURE = 4002;
function rawBytes(raw: RawData): Uint8Array {
  if (Buffer.isBuffer(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  if (Array.isArray(raw)) {
    const value = Buffer.concat(raw);
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(raw);
}
// The generated SidecarMessage runtime validator only enforces
// `{type: string, payload: object}`, so every payload this client consumes is
// decoded into the named types below at the socket boundary (handleMessage),
// and every payload it emits is constructed from the named shapes below. The
// sidecar (services/audio) is version-matched with this client and echoes the
// optional partIndex the client sends on tts.* messages.
export interface VadStartEvent {
  streamId: string;
  utteranceId: string;
  captureStartSequence: number;
}
export interface VadEndEvent {
  streamId: string;
  utteranceId: string;
  captureStartSequence: number;
  captureEndSequence: number;
}
export interface SttPartial {
  streamId: string;
  utteranceId: string;
  epoch: number;
  sequence: number;
  text: string;
  replacedCharacters: number;
}
export interface SttFinal {
  streamId: string;
  utteranceId: string;
  epoch: number;
  text: string;
  endpointComplete: true;
}
export type AudioEngineSubstep = 'starting' | 'warming' | 'ready' | 'failed';
export type AudioEngineStatus = 'starting' | 'warming' | 'ready' | 'failed' | 'retrying';
export interface AudioEngineStatusSnapshot {
  status: AudioEngineStatus;
  capture: 'starting' | 'ready' | 'failed';
  vad: AudioEngineSubstep;
  tts: AudioEngineSubstep;
  detail?: string;
}
export interface AudioClientVoiceSelection {
  catalogId: string;
  voiceId: string;
  speedModifier?: number;
  tonePrompt?: string;
  language?: string;
  backendId?: string;
  modelId?: string;
}
export interface AudioClientEvents {
  status?(snapshot: AudioEngineStatusSnapshot): void;
  speechStart?(event: VadStartEvent): void;
  speechEnd?(event: VadEndEvent): void;
  partial?(event: SttPartial): void;
  final?(event: SttFinal): void;
  failure?(code: string): void;
}
interface SidecarWarmup {
  vad: AudioEngineSubstep;
  tts: AudioEngineSubstep;
}
type SidecarEngineStatus = 'starting' | 'ready' | 'failed';
interface ReadinessSnapshotPayload {
  status: SidecarEngineStatus;
  warmup?: SidecarMessageWarmup;
  ttsModels?: TtsModelDescriptor[];
  voiceCatalog?: VoiceCatalog;
}
interface StreamOpenedPayload {
  streamId: string;
  backendId?: string;
  modelId?: string;
  voiceCatalog?: VoiceCatalog;
}
interface VadStartPayload {
  streamId: string;
  utteranceId: string;
  captureStartSequence: number;
}
interface VadEndPayload {
  streamId: string;
  utteranceId: string;
  captureStartSequence: number;
  captureEndSequence: number;
}
interface SttPartialPayload {
  streamId: string;
  utteranceId: string;
  epoch: number;
  sequence: number;
  text: string;
  replacedCharacters: number;
}
interface SttFinalPayload {
  streamId: string;
  utteranceId: string;
  epoch: number;
  text: string;
  endpointComplete: true;
}
interface TtsStartedPayload {
  streamId: string;
  responseId: string;
  epoch: number;
  partIndex?: number;
  playbackId: string;
  outputStreamId: number;
  sampleRate: number;
  voiceId: string;
  backendId?: string;
  modelId?: string;
}
interface TtsEndedPayload {
  streamId: string;
  responseId: string;
  epoch: number;
  partIndex?: number;
  playbackId: string;
  generatedSamples: number;
}
interface TtsCancelledPayload {
  streamId: string;
  responseId: string;
  epoch: number;
  partIndex?: number;
}
interface SidecarFailurePayload {
  code: string;
  recoverable: boolean;
}
// A catalog is decoded leniently to the fields the host consumes: the
// generated contract type is stricter than what legacy sidecars send.
interface VoiceCatalog {
  catalogId: string;
  backendId?: string;
  modelId?: string;
  speed?: SidecarMessageSpeedCapability;
  voices?: Array<{ id: string }>;
}
interface TtsModelDescriptor {
  backendId: string;
  modelId: string;
  status?: 'ready' | 'unavailable';
  speed?: SidecarMessageSpeedCapability;
  voiceCatalog?: VoiceCatalog;
}
interface HealthSnapshotPayload {
  status: 'ready' | 'failed';
  warmup?: SidecarMessageWarmup;
}
type SidecarWireMessage =
  | { type: 'readiness.snapshot'; payload: ReadinessSnapshotPayload }
  | { type: 'stream.opened'; payload: StreamOpenedPayload }
  | { type: 'vad.speech_start'; payload: VadStartPayload }
  | { type: 'vad.speech_end'; payload: VadEndPayload }
  | { type: 'stt.partial'; payload: SttPartialPayload }
  | { type: 'stt.final'; payload: SttFinalPayload }
  | { type: 'tts.started'; payload: TtsStartedPayload }
  | { type: 'tts.ended'; payload: TtsEndedPayload }
  | { type: 'tts.cancelled'; payload: TtsCancelledPayload }
  | { type: 'sidecar.failure'; payload: SidecarFailurePayload };

function decodeWarmup(record: Record<string, JsonValue>): SidecarMessageWarmup | undefined {
  const vad = record['vad'];
  const tts = record['tts'];
  if (vad !== 'starting' && vad !== 'warming' && vad !== 'ready' && vad !== 'failed') return undefined;
  if (tts !== 'starting' && tts !== 'warming' && tts !== 'ready' && tts !== 'failed') return undefined;
  return { vad, tts };
}
function decodeSpeedCapability(record: Record<string, JsonValue>): SidecarMessageSpeedCapability | undefined {
  const supported = readBoolean(record, 'supported');
  const min = readNumber(record, 'min');
  const max = readNumber(record, 'max');
  const defaultSpeed = readNumber(record, 'default');
  if (supported === undefined || min === undefined || max === undefined || defaultSpeed === undefined) return undefined;
  return { supported, min, max, default: defaultSpeed };
}
function decodeVoiceCatalog(record: Record<string, JsonValue>): VoiceCatalog | undefined {
  const catalogId = readString(record, 'catalogId');
  if (catalogId === undefined) return undefined;
  const catalog: VoiceCatalog = { catalogId };
  const backendId = readString(record, 'backendId');
  if (backendId !== undefined) catalog.backendId = backendId;
  const modelId = readString(record, 'modelId');
  if (modelId !== undefined) catalog.modelId = modelId;
  const speedRecord = readRecord(record, 'speed');
  if (speedRecord !== undefined) {
    const speed = decodeSpeedCapability(speedRecord);
    if (speed === undefined) return undefined;
    catalog.speed = speed;
  }
  const voices = readArray(record, 'voices');
  if (voices !== undefined) {
    const decodedVoices: Array<{ id: string }> = [];
    for (const voice of voices) {
      if (voice === null || voice === true || voice === false) return undefined;
      if (Number.isFinite(voice)) return undefined;
      if (String(voice) === voice) return undefined;
      if (Array.isArray(voice)) return undefined;
      // SAFETY: the JSON value universe is null, booleans, numbers, strings,
      // arrays, and plain objects; every other case is excluded above.
      const voiceRecord = voice as Record<string, JsonValue>;
      const id = readString(voiceRecord, 'id');
      if (id === undefined) return undefined;
      decodedVoices.push({ id });
    }
    catalog.voices = decodedVoices;
  }
  return catalog;
}
function decodeTtsModelDescriptor(record: Record<string, JsonValue>): TtsModelDescriptor | undefined {
  const backendId = readString(record, 'backendId');
  const modelId = readString(record, 'modelId');
  if (backendId === undefined || modelId === undefined) return undefined;
  const descriptor: TtsModelDescriptor = { backendId, modelId };
  const status = record['status'];
  if (status !== undefined) {
    if (status !== 'ready' && status !== 'unavailable') return undefined;
    descriptor.status = status;
  }
  const speedRecord = readRecord(record, 'speed');
  if (speedRecord !== undefined) {
    const speed = decodeSpeedCapability(speedRecord);
    if (speed !== undefined) descriptor.speed = speed;
  }
  const catalogRecord = readRecord(record, 'voiceCatalog');
  if (catalogRecord !== undefined) {
    const catalog = decodeVoiceCatalog(catalogRecord);
    if (catalog !== undefined) descriptor.voiceCatalog = catalog;
  }
  return descriptor;
}
function decodeTtsModels(record: Record<string, JsonValue>): TtsModelDescriptor[] | undefined {
  const entries = readArray(record, 'ttsModels');
  if (entries === undefined) return undefined;
  const models: TtsModelDescriptor[] = [];
  for (const entry of entries) {
    if (entry === null || entry === true || entry === false) continue;
    if (Number.isFinite(entry)) continue;
    if (String(entry) === entry) continue;
    if (Array.isArray(entry)) continue;
    // SAFETY: the JSON value universe is null, booleans, numbers, strings,
    // arrays, and plain objects; every other case is excluded above.
    const descriptor = decodeTtsModelDescriptor(entry as Record<string, JsonValue>);
    if (descriptor !== undefined) models.push(descriptor);
  }
  return models;
}
function decodeReadinessSnapshot(record: Record<string, JsonValue>): ReadinessSnapshotPayload | undefined {
  const status = record['status'];
  if (status !== 'starting' && status !== 'ready' && status !== 'failed') return undefined;
  const payload: ReadinessSnapshotPayload = { status };
  const warmupRecord = readRecord(record, 'warmup');
  if (warmupRecord !== undefined) {
    const warmup = decodeWarmup(warmupRecord);
    if (warmup !== undefined) payload.warmup = warmup;
  }
  const models = decodeTtsModels(record);
  if (models !== undefined) payload.ttsModels = models;
  const catalogRecord = readRecord(record, 'voiceCatalog');
  if (catalogRecord !== undefined) {
    const catalog = decodeVoiceCatalog(catalogRecord);
    if (catalog !== undefined) payload.voiceCatalog = catalog;
  }
  return payload;
}
function decodeStreamOpened(record: Record<string, JsonValue>): StreamOpenedPayload | undefined {
  const streamId = readString(record, 'streamId');
  if (streamId === undefined) return undefined;
  const payload: StreamOpenedPayload = { streamId };
  const backendId = readString(record, 'backendId');
  if (backendId !== undefined) payload.backendId = backendId;
  const modelId = readString(record, 'modelId');
  if (modelId !== undefined) payload.modelId = modelId;
  const catalogValue = record['voiceCatalog'];
  if (catalogValue !== undefined) {
    const catalogRecord = readRecord(record, 'voiceCatalog');
    if (catalogRecord === undefined) return undefined;
    const catalog = decodeVoiceCatalog(catalogRecord);
    if (catalog === undefined) return undefined;
    payload.voiceCatalog = catalog;
  }
  return payload;
}
function decodeVadStart(record: Record<string, JsonValue>): VadStartPayload | undefined {
  const streamId = readString(record, 'streamId');
  const utteranceId = readString(record, 'utteranceId');
  const captureStartSequence = readNumber(record, 'captureStartSequence');
  if (streamId === undefined || utteranceId === undefined || captureStartSequence === undefined) return undefined;
  return { streamId, utteranceId, captureStartSequence };
}
function decodeVadEnd(record: Record<string, JsonValue>): VadEndPayload | undefined {
  const streamId = readString(record, 'streamId');
  const utteranceId = readString(record, 'utteranceId');
  const captureStartSequence = readNumber(record, 'captureStartSequence');
  const captureEndSequence = readNumber(record, 'captureEndSequence');
  if (
    streamId === undefined ||
    utteranceId === undefined ||
    captureStartSequence === undefined ||
    captureEndSequence === undefined
  )
    return undefined;
  return { streamId, utteranceId, captureStartSequence, captureEndSequence };
}
function decodeSttPartial(record: Record<string, JsonValue>): SttPartialPayload | undefined {
  const streamId = readString(record, 'streamId');
  const utteranceId = readString(record, 'utteranceId');
  const epoch = readNumber(record, 'epoch');
  const sequence = readNumber(record, 'sequence');
  const text = readString(record, 'text');
  const replacedCharacters = readNumber(record, 'replacedCharacters');
  if (
    streamId === undefined ||
    utteranceId === undefined ||
    epoch === undefined ||
    sequence === undefined ||
    text === undefined ||
    replacedCharacters === undefined
  )
    return undefined;
  return { streamId, utteranceId, epoch, sequence, text, replacedCharacters };
}
function decodeSttFinal(record: Record<string, JsonValue>): SttFinalPayload | undefined {
  const streamId = readString(record, 'streamId');
  const utteranceId = readString(record, 'utteranceId');
  const epoch = readNumber(record, 'epoch');
  const text = readString(record, 'text');
  if (streamId === undefined || utteranceId === undefined || epoch === undefined || text === undefined)
    return undefined;
  if (record['endpointComplete'] !== true) return undefined;
  return { streamId, utteranceId, epoch, text, endpointComplete: true };
}
function decodeTtsStarted(record: Record<string, JsonValue>): TtsStartedPayload | undefined {
  const streamId = readString(record, 'streamId');
  const responseId = readString(record, 'responseId');
  const epoch = readNumber(record, 'epoch');
  const playbackId = readString(record, 'playbackId');
  const outputStreamId = readNumber(record, 'outputStreamId');
  const sampleRate = readNumber(record, 'sampleRate');
  const voiceId = readString(record, 'voiceId');
  if (
    streamId === undefined ||
    responseId === undefined ||
    epoch === undefined ||
    playbackId === undefined ||
    outputStreamId === undefined ||
    sampleRate === undefined ||
    voiceId === undefined
  )
    return undefined;
  const payload: TtsStartedPayload = { streamId, responseId, epoch, playbackId, outputStreamId, sampleRate, voiceId };
  const partIndex = readNumber(record, 'partIndex');
  if (partIndex !== undefined) payload.partIndex = partIndex;
  const backendId = readString(record, 'backendId');
  if (backendId !== undefined) payload.backendId = backendId;
  const modelId = readString(record, 'modelId');
  if (modelId !== undefined) payload.modelId = modelId;
  return payload;
}
function decodeTtsEnded(record: Record<string, JsonValue>): TtsEndedPayload | undefined {
  const streamId = readString(record, 'streamId');
  const responseId = readString(record, 'responseId');
  const epoch = readNumber(record, 'epoch');
  const playbackId = readString(record, 'playbackId');
  const generatedSamples = readNumber(record, 'generatedSamples');
  if (
    streamId === undefined ||
    responseId === undefined ||
    epoch === undefined ||
    playbackId === undefined ||
    generatedSamples === undefined
  )
    return undefined;
  const payload: TtsEndedPayload = { streamId, responseId, epoch, playbackId, generatedSamples };
  const partIndex = readNumber(record, 'partIndex');
  if (partIndex !== undefined) payload.partIndex = partIndex;
  return payload;
}
function decodeTtsCancelled(record: Record<string, JsonValue>): TtsCancelledPayload | undefined {
  const streamId = readString(record, 'streamId');
  const responseId = readString(record, 'responseId');
  const epoch = readNumber(record, 'epoch');
  if (streamId === undefined || responseId === undefined || epoch === undefined) return undefined;
  const payload: TtsCancelledPayload = { streamId, responseId, epoch };
  const partIndex = readNumber(record, 'partIndex');
  if (partIndex !== undefined) payload.partIndex = partIndex;
  return payload;
}
function decodeSidecarFailure(record: Record<string, JsonValue>): SidecarFailurePayload | undefined {
  const code = readString(record, 'code');
  const recoverable = readBoolean(record, 'recoverable');
  if (code === undefined || recoverable === undefined) return undefined;
  return { code, recoverable };
}
function decodeHealthSnapshot(value: JsonValue): HealthSnapshotPayload | undefined {
  if (value === null || value === true || value === false) return undefined;
  if (Number.isFinite(value)) return undefined;
  if (String(value) === value) return undefined;
  if (Array.isArray(value)) return undefined;
  // SAFETY: the JSON value universe is null, booleans, numbers, strings,
  // arrays, and plain objects; every other case is excluded above.
  const record = value as Record<string, JsonValue>;
  const status = record['status'];
  if (status !== 'ready' && status !== 'failed') return undefined;
  const payload: HealthSnapshotPayload = { status };
  const warmupRecord = readRecord(record, 'warmup');
  if (warmupRecord !== undefined) {
    const warmup = decodeWarmup(warmupRecord);
    if (warmup !== undefined) payload.warmup = warmup;
  }
  return payload;
}
function decodeSidecarMessage(record: Record<string, JsonValue>): SidecarWireMessage | undefined {
  const payload = readRecord(record, 'payload');
  if (payload === undefined) return undefined;
  switch (record['type']) {
    case 'readiness.snapshot': {
      const snapshot = decodeReadinessSnapshot(payload);
      return snapshot === undefined ? undefined : { type: 'readiness.snapshot', payload: snapshot };
    }
    case 'stream.opened': {
      const opened = decodeStreamOpened(payload);
      return opened === undefined ? undefined : { type: 'stream.opened', payload: opened };
    }
    case 'vad.speech_start': {
      const event = decodeVadStart(payload);
      return event === undefined ? undefined : { type: 'vad.speech_start', payload: event };
    }
    case 'vad.speech_end': {
      const event = decodeVadEnd(payload);
      return event === undefined ? undefined : { type: 'vad.speech_end', payload: event };
    }
    case 'stt.partial': {
      const event = decodeSttPartial(payload);
      return event === undefined ? undefined : { type: 'stt.partial', payload: event };
    }
    case 'stt.final': {
      const event = decodeSttFinal(payload);
      return event === undefined ? undefined : { type: 'stt.final', payload: event };
    }
    case 'tts.started': {
      const event = decodeTtsStarted(payload);
      return event === undefined ? undefined : { type: 'tts.started', payload: event };
    }
    case 'tts.ended': {
      const event = decodeTtsEnded(payload);
      return event === undefined ? undefined : { type: 'tts.ended', payload: event };
    }
    case 'tts.cancelled': {
      const event = decodeTtsCancelled(payload);
      return event === undefined ? undefined : { type: 'tts.cancelled', payload: event };
    }
    case 'sidecar.failure': {
      const failure = decodeSidecarFailure(payload);
      return failure === undefined ? undefined : { type: 'sidecar.failure', payload: failure };
    }
    default:
      // Inbound stream.open, stream.reset, stream.close, stream.closed,
      // stt.bind_epoch, tts.request/append/commit/cancel, and voice.* messages
      // are protocol violations; the previous dispatcher failed closed on all
      // of them, so they are rejected here instead.
      return undefined;
  }
}
interface StreamIdPayload {
  streamId: string;
}
interface StreamOpenFields {
  captureStreamId: number;
  sampleRate: 16000;
  frameSamples: 320;
  streamMode: 'capture' | 'preview';
  catalogId?: string;
  backendId?: string;
  modelId?: string;
}
interface SttBindEpochFields {
  utteranceId: string;
  epoch: number;
}
interface TtsOpenFields {
  responseId: string;
  epoch: number;
  voiceId: string;
  speedModifier: number;
  tonePrompt?: string;
  language?: string;
  partIndex?: number;
  partId?: string;
}
interface TtsAppendFields {
  responseId: string;
  epoch: number;
  sequence: number;
  text: string;
  partIndex?: number;
  partId?: string;
}
interface TtsCommitFields {
  responseId: string;
  epoch: number;
  nextSequence: number;
  textSha256: string;
  partIndex?: number;
  partId?: string;
}
interface TtsCancelFields {
  responseId: string;
  epoch: number;
  partIndex?: number;
}
type SidecarStreamFields = SttBindEpochFields | TtsOpenFields | TtsAppendFields | TtsCommitFields | TtsCancelFields;
interface OutboundSidecarMessage {
  type: string;
  payload: object;
}
interface TtsRequestInput {
  sessionId: string;
  epoch: number;
  responseId: string;
  partIndex?: number;
  partId?: string;
  signal: AbortSignal;
  onGeneratedSamples?: (total: number) => void;
}
interface TtsSynthesizeInput extends TtsRequestInput {
  text: string;
}
interface TtsRefInput {
  responseId: string;
  epoch: number;
  partIndex?: number;
  partId?: string;
}
interface PendingTts {
  key: string;
  responseId: string;
  partIndex?: number;
  partId?: string;
  epoch: number;
  resolveStart(value: SpeechSynthesisStart): void;
  rejectStart(error: Error): void;
  resolveCompletion(value: { generatedSamples: number }): void;
  rejectCompletion(error: Error): void;
  completion: Promise<{ generatedSamples: number }>;
  startSettled: boolean;
  sidecarStarted: boolean;
  completionSettled: boolean;
  remoteTerminal: boolean;
  playbackId?: string;
  outputStreamId?: number;
  sampleRate?: number;
  expectedSequence: number;
  receivedSamples: number;
  cutoff: boolean;
  onGeneratedSamples: ((total: number) => void) | undefined;
  released: boolean;
  chunks: Uint8Array[];
  queued: boolean;
  bufferedAppends: string[];
  bufferedCommit: { nextSequence: number; textSha256: string } | undefined;
  detachAbort(): void;
}
interface ActiveUtterance {
  utteranceId: string;
  captureStartSequence: number;
  epoch?: number;
  expectedPartialSequence: number;
  speechEnded: boolean;
}
interface OpenWaiter {
  resolve(): void;
  reject(error: Error): void;
}

function pendingKey(responseId: string, partIndex?: number): string {
  return partIndex === undefined ? responseId : `${responseId}:${partIndex}`;
}

export class AudioClient implements SpeechOutputPort {
  private socket: WebSocket | undefined;
  private streamId: string | undefined;
  private captureStreamId: number | undefined;
  private streamOpened = false;
  private openWaiter: OpenWaiter | undefined;
  private utterance: ActiveUtterance | undefined;
  private pending = new Map<string, PendingTts>();
  private admitted: PendingTts[] = [];
  private queued: PendingTts[] = [];
  private usedOutputStreams = new Set<number>();
  private readyStatus: 'starting' | 'ready' | 'failed' = 'starting';
  private sidecarWarmup: SidecarWarmup = { vad: 'starting', tts: 'starting' };
  private readinessSeen = false;
  private failed = false;
  private closing = false;
  private connectPromise: Promise<void> | undefined;
  private readonly sidecar: SidecarProcess;
  private readonly events: AudioClientEvents;
  private readonly binarySink: (frame: Uint8Array) => void;
  private readonly selection: AudioClientVoiceSelection | undefined;
  private readonly voiceId: string;
  private readonly speedModifier: number;
  private readonly tonePrompt: string | undefined;
  private readonly language: string | undefined;
  private readonly backendId: string;
  private readonly modelId: string;
  private readonly explicitModelSelection: boolean;

  constructor(
    sidecar: SidecarProcess,
    events: AudioClientEvents = {},
    binarySink: (frame: Uint8Array) => void = () => {},
    selection?: AudioClientVoiceSelection,
  ) {
    this.sidecar = sidecar;
    this.events = events;
    this.binarySink = binarySink;
    this.selection = selection;
    this.voiceId = selection?.voiceId ?? 'af_heart';
    this.speedModifier = selection?.speedModifier ?? DEFAULT_VOICE_SPEED_MODIFIER;
    this.tonePrompt = selection?.tonePrompt;
    this.language = selection?.language;
    this.backendId = selection?.backendId ?? DEFAULT_TTS_MODEL.backendId;
    this.modelId = selection?.modelId ?? DEFAULT_TTS_MODEL.modelId;
    this.explicitModelSelection = selection?.backendId !== undefined || selection?.modelId !== undefined;
  }

  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.reportStatus({ status: 'starting', capture: 'starting', vad: 'starting', tts: 'starting' });
    this.connectPromise = new Promise((resolve, reject) => {
      const socket = new WebSocket(`${this.sidecar.origin.replace(/^http/, 'ws')}/stream`, {
        headers: { authorization: `Bearer ${this.sidecar.secret}` },
        origin: undefined,
        maxPayload: MAX_PAYLOAD,
        perMessageDeflate: false,
      });
      this.socket = socket;
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error('audio sidecar connection timed out'));
      }, 5_000);
      socket.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.on('message', (data, binary) => this.handleMessage(data, binary));
      socket.once('error', (error) => {
        clearTimeout(timer);
        this.connectionFailure('audio sidecar unavailable');
        reject(error);
      });
      socket.once('close', () => {
        if (!this.closing) this.connectionFailure('audio sidecar closed');
      });
    });
    return this.connectPromise;
  }

  readiness(): 'starting' | 'ready' | 'failed' {
    return this.readyStatus;
  }

  async open(captureStreamId: number, streamMode: 'capture' | 'preview' = 'capture'): Promise<string> {
    await this.connect();
    this.reportStatus({
      status: this.streamId ? 'retrying' : 'warming',
      capture: 'starting',
      vad: this.sidecarWarmup.vad,
      tts: this.sidecarWarmup.tts,
      detail: this.streamId ? 'Re-initializing the microphone stream.' : 'Opening the microphone stream.',
    });
    try {
      await this.waitUntilReady();
    } catch (error) {
      this.reportStatus({
        status: 'failed',
        capture: 'failed',
        vad: this.sidecarWarmup.vad,
        tts: this.sidecarWarmup.tts,
        detail: error instanceof Error ? error.message : 'The local audio engine is not ready.',
      });
      throw error;
    }
    if (this.failed || this.readyStatus !== 'ready') throw new Error('audio sidecar is not ready for a stream');
    // The sidecar owns one long-lived stream per AudioClient. Browser pause
    // stops microphone capture, but must not try to open a second sidecar stream
    // on resume. Rebind the capture stream id and reset VAD state instead.
    if (this.streamId && this.streamOpened) {
      if (streamMode !== 'capture') throw new Error('audio sidecar stream mode cannot change');
      this.captureStreamId = captureStreamId;
      this.reset();
      this.reportStatus({
        status: 'ready',
        capture: 'ready',
        vad: this.sidecarWarmup.vad,
        tts: this.sidecarWarmup.tts,
      });
      return this.streamId;
    }
    if (this.streamId) throw new Error('audio sidecar stream is still opening');
    const streamId = randomUUID();
    this.streamId = streamId;
    this.captureStreamId = captureStreamId;
    const opened = new Promise<void>((resolve, reject) => {
      this.openWaiter = { resolve, reject };
    });
    const fields: StreamOpenFields = {
      captureStreamId,
      sampleRate: 16_000,
      frameSamples: 320,
      streamMode,
    };
    // The catalog identity is part of the selectable-model extension. Keep
    // the legacy Kokoro stream shape unchanged for older sidecars; Qwen and
    // other non-default backends must carry it so the sidecar can reject
    // stale catalog-bound preferences before TTS admission.
    if (
      this.selection &&
      (this.backendId !== DEFAULT_TTS_MODEL.backendId || this.modelId !== DEFAULT_TTS_MODEL.modelId)
    ) {
      fields.catalogId = this.selection.catalogId;
    }
    if (
      this.explicitModelSelection &&
      (this.backendId !== DEFAULT_TTS_MODEL.backendId || this.modelId !== DEFAULT_TTS_MODEL.modelId)
    ) {
      fields.backendId = this.backendId;
      fields.modelId = this.modelId;
    }
    this.sendMessage({ type: 'stream.open', payload: { streamId, ...fields } });
    await opened;
    this.reportStatus({ status: 'ready', capture: 'ready', vad: this.sidecarWarmup.vad, tts: this.sidecarWarmup.tts });
    return streamId;
  }

  input(frame: Uint8Array): void {
    // After a sidecar failure the stream is terminal; drop capture frames so the
    // session degrades gracefully instead of throwing (which would surface as a
    // browser protocol error and close the browser socket).
    if (this.failed) return;
    if (!this.streamId || !this.streamOpened) throw new Error('audio stream is not open');
    const decoded = decodeBinaryAudioFrame(frame, MAX_PAYLOAD - 20);
    if (decoded.channel !== 1 || decoded.streamId !== this.captureStreamId || decoded.pcm16.length !== 320)
      throw new Error('invalid capture frame');
    this.readySocket().send(frame, { binary: true });
  }

  bindEpoch(utteranceId: string, epoch: number): void {
    const utterance = this.utterance;
    if (!utterance || utterance.utteranceId !== utteranceId || utterance.epoch !== undefined)
      throw new Error('unknown, stale, or bound utterance');
    utterance.epoch = epoch;
    this.sendStream('stt.bind_epoch', { utteranceId, epoch });
  }
  reset(): void {
    this.requireOpened();
    this.utterance = undefined;
    this.sendStream('stream.reset');
  }

  synthesize(input: TtsSynthesizeInput): Promise<SpeechSynthesisStart> {
    const request: TtsRequestInput = {
      sessionId: input.sessionId,
      epoch: input.epoch,
      responseId: input.responseId,
      signal: input.signal,
    };
    if (input.partIndex !== undefined) request.partIndex = input.partIndex;
    if (input.partId) request.partId = input.partId;
    if (input.onGeneratedSamples) request.onGeneratedSamples = input.onGeneratedSamples;
    const stream = this.begin(request);
    stream.append(input.text);
    stream.finish();
    return stream.started;
  }

  begin(input: TtsRequestInput): SpeechOutputStream {
    void input.sessionId;
    this.requireOpened();
    const key = pendingKey(input.responseId, input.partIndex);
    if (this.pending.has(key)) throw new Error('duplicate TTS response');
    let resolveStart!: (value: SpeechSynthesisStart) => void;
    let rejectStart!: (error: Error) => void;
    let resolveCompletion!: (value: { generatedSamples: number }) => void;
    let rejectCompletion!: (error: Error) => void;
    const started = new Promise<SpeechSynthesisStart>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    // Mirror the completion guard: started can be rejected before any caller
    // attaches a handler (cancel/failAll races, or an aborted signal that makes
    // synthesize() throw out of append() before returning started). Swallow the
    // potential unhandled rejection; awaited copies still surface errors.
    void started.catch(() => undefined);
    const completion = new Promise<{ generatedSamples: number }>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    void completion.catch(() => undefined);
    const abort = () => this.cancel(input.responseId, input.partIndex);
    const pending: PendingTts = {
      key,
      responseId: input.responseId,
      epoch: input.epoch,
      resolveStart,
      rejectStart,
      resolveCompletion,
      rejectCompletion,
      completion,
      startSettled: false,
      sidecarStarted: false,
      completionSettled: false,
      remoteTerminal: false,
      expectedSequence: 0,
      receivedSamples: 0,
      cutoff: false,
      onGeneratedSamples: input.onGeneratedSamples,
      released: false,
      chunks: [],
      queued: false,
      bufferedAppends: [],
      bufferedCommit: undefined,
      detachAbort: () => input.signal.removeEventListener('abort', abort),
    };
    if (input.partIndex !== undefined) pending.partIndex = input.partIndex;
    if (input.partId) pending.partId = input.partId;
    this.pending.set(key, pending);
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) {
      pending.cutoff = true;
      this.rejectPending(pending, new Error('TTS cancelled'));
      this.pending.delete(key);
    } else if (this.admitted.length < MAX_ADMITTED_TTS) {
      // A slot is free: admit immediately and open on the sidecar. The stall
      // (part 0) is always the first begin() so it always gets the first slot.
      this.admitted.push(pending);
      this.sendStream('tts.open', this.ttsFields(input));
    } else {
      // Both slots are held by nonterminal streams. Queue FIFO and buffer the
      // stream locally; append()/finish() will be flushed when the oldest
      // admitted stream reports terminal (tts.ended / tts.cancelled).
      pending.queued = true;
      this.queued.push(pending);
    }
    let appendSequence = 0;
    const hasher = createHash('sha256');
    const client = this;

    const stream: SpeechOutputStream = {
      started,
      append(text: string): void {
        if (pending.cutoff || pending.remoteTerminal) throw new Error('TTS stream is terminated');
        if (!text.trim()) throw new Error('empty append');
        hasher.update(text, 'utf8');
        if (pending.queued) {
          // No wire commands while queued; the flush replays these in order.
          pending.bufferedAppends.push(text);
          return;
        }
        const fields: TtsAppendFields = {
          responseId: input.responseId,
          epoch: input.epoch,
          sequence: appendSequence,
          text,
        };
        if (input.partIndex !== undefined) fields.partIndex = input.partIndex;
        if (input.partId) fields.partId = input.partId;
        client.sendStream('tts.append', fields);
        appendSequence++;
      },
      finish(): void {
        if (pending.cutoff || pending.remoteTerminal) throw new Error('TTS stream is terminated');
        const sha256 = hasher.digest('hex');
        if (pending.queued) {
          pending.bufferedCommit = { nextSequence: pending.bufferedAppends.length, textSha256: sha256 };
          return;
        }
        const fields: TtsCommitFields = {
          responseId: input.responseId,
          epoch: input.epoch,
          nextSequence: appendSequence,
          textSha256: sha256,
        };
        if (input.partIndex !== undefined) fields.partIndex = input.partIndex;
        if (input.partId) fields.partId = input.partId;
        client.sendStream('tts.commit', fields);
      },
    };

    return stream;
  }

  private ttsFields(input: TtsRefInput): TtsOpenFields {
    const fields: TtsOpenFields = {
      responseId: input.responseId,
      epoch: input.epoch,
      voiceId: this.voiceId,
      speedModifier: this.speedModifier,
    };
    if (this.tonePrompt) fields.tonePrompt = this.tonePrompt;
    if (this.language && this.backendId === 'qwen3') fields.language = this.language;
    if (input.partIndex !== undefined) fields.partIndex = input.partIndex;
    if (input.partId) fields.partId = input.partId;
    return fields;
  }

  private removeAdmitted(pending: PendingTts): void {
    const index = this.admitted.indexOf(pending);
    if (index >= 0) this.admitted.splice(index, 1);
  }

  private flushQueue(): void {
    while (this.admitted.length < MAX_ADMITTED_TTS && this.queued.length > 0) {
      const pending = this.queued.shift()!;
      pending.queued = false;
      this.admitted.push(pending);
      this.sendStream('tts.open', this.ttsFields(pending));
      for (let index = 0; index < pending.bufferedAppends.length; index++) {
        const fields: TtsAppendFields = {
          responseId: pending.responseId,
          epoch: pending.epoch,
          sequence: index,
          text: pending.bufferedAppends[index]!,
        };
        if (pending.partIndex !== undefined) fields.partIndex = pending.partIndex;
        if (pending.partId) fields.partId = pending.partId;
        this.sendStream('tts.append', fields);
      }
      if (pending.bufferedCommit) {
        const fields: TtsCommitFields = {
          responseId: pending.responseId,
          epoch: pending.epoch,
          nextSequence: pending.bufferedCommit.nextSequence,
          textSha256: pending.bufferedCommit.textSha256,
        };
        if (pending.partIndex !== undefined) fields.partIndex = pending.partIndex;
        if (pending.partId) fields.partId = pending.partId;
        this.sendStream('tts.commit', fields);
      }
    }
  }

  release(responseId: string, partIndex?: number): void {
    const wantKey = pendingKey(responseId, partIndex);
    const pending = this.pending.get(wantKey);
    if (!pending || pending.cutoff || pending.released || !pending.playbackId) return;
    pending.released = true;
    for (const chunk of pending.chunks) this.binarySink(chunk);
    pending.chunks.length = 0;
  }

  pause(_responseId: string): void {
    /* browser is the audible pause authority */
  }
  resume(_responseId: string, _rewindMs?: number): void {
    /* browser is the audible resume authority */
  }
  cancel(responseId: string, partIndex?: number): void {
    if (partIndex !== undefined) {
      const pending = this.pending.get(pendingKey(responseId, partIndex));
      if (!pending || pending.cutoff) return;
      pending.cutoff = true;
      pending.chunks.length = 0;
      if (pending.queued) {
        this.removeQueued(pending);
        this.rejectPending(pending, new Error('TTS cancelled'));
        this.pending.delete(pending.key);
        return;
      }
      if (this.streamOpened && this.socket?.readyState === WebSocket.OPEN)
        this.sendStream('tts.cancel', { responseId, epoch: pending.epoch, partIndex });
      this.rejectPending(pending, new Error('TTS cancelled'));
      return;
    }
    for (const pending of this.pending.values()) {
      if (pending.responseId !== responseId || pending.cutoff) continue;
      pending.cutoff = true;
      pending.chunks.length = 0;
      if (pending.queued) {
        this.removeQueued(pending);
        this.rejectPending(pending, new Error('TTS cancelled'));
        this.pending.delete(pending.key);
        continue;
      }
      if (this.streamOpened && this.socket?.readyState === WebSocket.OPEN) {
        const fields: TtsCancelFields = { responseId, epoch: pending.epoch };
        if (pending.partIndex !== undefined) fields.partIndex = pending.partIndex;
        this.sendStream('tts.cancel', fields);
      }
      this.rejectPending(pending, new Error('TTS cancelled'));
    }
  }

  private removeQueued(pending: PendingTts): void {
    const index = this.queued.indexOf(pending);
    if (index >= 0) this.queued.splice(index, 1);
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.streamId && this.streamOpened && this.socket?.readyState === WebSocket.OPEN)
      this.sendStream('stream.close');
    this.streamId = undefined;
    this.captureStreamId = undefined;
    this.streamOpened = false;
    this.utterance = undefined;
    this.failAll(new Error('audio client closed'));
    const socket = this.socket;
    this.socket = undefined;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.close(1000, 'stream closed');
      setTimeout(() => {
        socket.terminate();
        resolve();
      }, 500);
    });
  }

  private reportStatus(snapshot: AudioEngineStatusSnapshot): void {
    this.events.status?.(snapshot);
  }

  private handleMessage(raw: RawData, binary: boolean): void {
    if (this.failed || this.closing) return;
    if (binary) {
      this.handleBinary(rawBytes(raw));
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw.toString());
    } catch {
      this.protocolFailure();
      return;
    }
    if (!CONTRACT_VALIDATORS.SidecarMessage(value)) {
      this.protocolFailure();
      return;
    }
    // SAFETY: JSON.parse output holds only JSON values, and the Ajv
    // SidecarMessage validator just accepted `value` as an object.
    const message = decodeSidecarMessage(value as Record<string, JsonValue>);
    if (message === undefined) {
      this.protocolFailure();
      return;
    }
    switch (message.type) {
      case 'readiness.snapshot':
        return this.readinessSnapshot(message.payload);
      case 'stream.opened':
        return this.streamOpenedMessage(message.payload);
      case 'sidecar.failure':
        return this.sidecarFailureMessage(message.payload);
      case 'vad.speech_start': {
        const payload = message.payload;
        if (!this.streamOpened || payload.streamId !== this.streamId) return this.protocolFailure();
        return this.speechStart(payload);
      }
      case 'vad.speech_end': {
        const payload = message.payload;
        if (!this.streamOpened || payload.streamId !== this.streamId) return this.protocolFailure();
        return this.speechEnd(payload);
      }
      case 'stt.partial': {
        const payload = message.payload;
        if (!this.streamOpened || payload.streamId !== this.streamId) return this.protocolFailure();
        return this.sttPartial(payload);
      }
      case 'stt.final': {
        const payload = message.payload;
        if (!this.streamOpened || payload.streamId !== this.streamId) return this.protocolFailure();
        return this.sttFinal(payload);
      }
      case 'tts.started': {
        const payload = message.payload;
        if (!this.streamOpened || payload.streamId !== this.streamId) return this.protocolFailure();
        return this.ttsStarted(payload);
      }
      case 'tts.ended': {
        const payload = message.payload;
        if (!this.streamOpened || payload.streamId !== this.streamId) return this.protocolFailure();
        return this.ttsEnded(payload);
      }
      case 'tts.cancelled': {
        const payload = message.payload;
        if (!this.streamOpened || payload.streamId !== this.streamId) return this.protocolFailure();
        return this.ttsCancelled(payload);
      }
      default:
        return this.protocolFailure();
    }
  }

  private readinessSnapshot(payload: ReadinessSnapshotPayload): void {
    if (this.readinessSeen || this.streamId) return this.protocolFailure();
    this.readinessSeen = true;
    this.readyStatus = payload.status;
    if (payload.warmup !== undefined) {
      this.sidecarWarmup = { vad: payload.warmup.vad, tts: payload.warmup.tts };
    } else if (this.readyStatus === 'ready') {
      this.sidecarWarmup = { vad: 'ready', tts: 'ready' };
    }
    const status: AudioEngineStatusSnapshot = {
      status: this.readyStatus === 'ready' ? 'warming' : this.readyStatus,
      capture: 'starting',
      vad: this.sidecarWarmup.vad,
      tts: this.sidecarWarmup.tts,
    };
    if (this.readyStatus === 'starting') {
      status.detail = 'The local speech models are still warming up.';
    }
    this.reportStatus(status);
    // Fail closed when a session voice/model selection cannot be reconciled
    // against the current verified catalog before any stream opens. Older
    // sidecars expose only the default Kokoro catalog, which remains valid for
    // legacy clients.
    if (this.readyStatus === 'ready' && this.selection) {
      const selection = this.selection;
      const models = payload.ttsModels ?? [];
      const descriptor = models.find((model) => model.backendId === this.backendId && model.modelId === this.modelId);
      const catalog =
        descriptor?.voiceCatalog ??
        (this.backendId === DEFAULT_TTS_MODEL.backendId && this.modelId === DEFAULT_TTS_MODEL.modelId
          ? payload.voiceCatalog
          : undefined);
      const voices = catalog?.voices;
      const speed = descriptor?.speed ?? catalog?.speed;
      const modelAvailable = descriptor === undefined || descriptor.status === 'ready';
      const catalogMatches = catalog?.catalogId === selection.catalogId;
      const voicePresent = voices !== undefined && voices.some((voice) => voice.id === selection.voiceId);
      const speedValid =
        speed === undefined ||
        (Number.isFinite(this.speedModifier) &&
          this.speedModifier >= speed.min &&
          this.speedModifier <= speed.max &&
          (speed.supported || this.speedModifier === speed.default));
      if (!modelAvailable) {
        this.failed = true;
        this.readyStatus = 'failed';
        this.reportStatus({
          status: 'failed',
          capture: 'failed',
          vad: this.sidecarWarmup.vad,
          tts: 'failed',
          detail: 'The selected voice engine is unavailable.',
        });
        this.events.failure?.('tts_model_unavailable');
        this.failAll(new Error('selected TTS model is unavailable; Kokoro remains available as the fallback'));
        this.socket?.close(CLOSE_SIDECAR_FAILURE, 'selected TTS model unavailable');
      } else if (!catalogMatches || !voicePresent) {
        this.failed = true;
        this.readyStatus = 'failed';
        this.reportStatus({
          status: 'failed',
          capture: 'failed',
          vad: this.sidecarWarmup.vad,
          tts: 'failed',
          detail: 'The selected voice catalog changed.',
        });
        this.events.failure?.('catalog_mismatch');
        this.failAll(new Error('audio sidecar catalog drifted from the session voice selection'));
        this.socket?.close(CLOSE_SIDECAR_FAILURE, 'audio voice catalog mismatch');
      } else if (!speedValid) {
        this.failed = true;
        this.readyStatus = 'failed';
        this.reportStatus({
          status: 'failed',
          capture: 'failed',
          vad: this.sidecarWarmup.vad,
          tts: 'failed',
          detail: 'The selected voice speed is unsupported.',
        });
        this.events.failure?.('unsupported_speed');
        this.failAll(new Error('selected TTS speed is not supported by the active model'));
        this.socket?.close(CLOSE_SIDECAR_FAILURE, 'unsupported TTS speed');
      }
    }
  }

  private streamOpenedMessage(payload: StreamOpenedPayload): void {
    if (!this.streamId || this.streamOpened || !this.openWaiter || payload.streamId !== this.streamId)
      return this.protocolFailure();
    if (payload.backendId !== undefined && payload.backendId !== this.backendId) return this.protocolFailure();
    if (payload.modelId !== undefined && payload.modelId !== this.modelId) return this.protocolFailure();
    if (
      (this.backendId !== DEFAULT_TTS_MODEL.backendId || this.modelId !== DEFAULT_TTS_MODEL.modelId) &&
      (payload.backendId !== this.backendId || payload.modelId !== this.modelId)
    )
      return this.protocolFailure();
    if (this.selection && payload.voiceCatalog !== undefined) {
      const catalog = payload.voiceCatalog;
      if (
        catalog.catalogId !== this.selection.catalogId ||
        catalog.backendId !== this.backendId ||
        catalog.modelId !== this.modelId
      )
        return this.protocolFailure();
    }
    this.streamOpened = true;
    const waiter = this.openWaiter;
    this.openWaiter = undefined;
    waiter.resolve();
  }
  private sidecarFailureMessage(payload: SidecarFailurePayload): void {
    this.failed = true;
    this.readyStatus = 'failed';
    this.reportStatus({
      status: 'failed',
      capture: 'failed',
      vad: this.sidecarWarmup.vad,
      tts: 'failed',
      detail: 'The local audio engine failed.',
    });
    this.events.failure?.(payload.code);
    this.failAll(new Error('audio sidecar runtime failed'));
    this.socket?.close(CLOSE_SIDECAR_FAILURE, 'audio sidecar runtime failed');
  }
  private speechStart(payload: VadStartPayload): void {
    if (this.utterance) return this.protocolFailure();
    this.utterance = {
      utteranceId: payload.utteranceId,
      captureStartSequence: payload.captureStartSequence,
      expectedPartialSequence: 0,
      speechEnded: false,
    };
    this.events.speechStart?.({
      streamId: payload.streamId,
      utteranceId: payload.utteranceId,
      captureStartSequence: payload.captureStartSequence,
    });
  }
  private speechEnd(payload: VadEndPayload): void {
    const utterance = this.utterance;
    const captureEndSequence = payload.captureEndSequence;
    if (
      !utterance ||
      utterance.speechEnded ||
      payload.utteranceId !== utterance.utteranceId ||
      payload.captureStartSequence !== utterance.captureStartSequence
    )
      return this.protocolFailure();
    if (
      !Number.isSafeInteger(captureEndSequence) ||
      captureEndSequence < 0 ||
      captureEndSequence < utterance.captureStartSequence
    )
      return this.protocolFailure();
    utterance.speechEnded = true;
    this.events.speechEnd?.({
      streamId: payload.streamId,
      utteranceId: payload.utteranceId,
      captureStartSequence: payload.captureStartSequence,
      captureEndSequence,
    });
  }
  private sttPartial(payload: SttPartialPayload): void {
    const utterance = this.utterance;
    if (
      !utterance ||
      utterance.epoch === undefined ||
      payload.utteranceId !== utterance.utteranceId ||
      payload.epoch !== utterance.epoch ||
      payload.sequence !== utterance.expectedPartialSequence
    )
      return this.protocolFailure();
    utterance.expectedPartialSequence++;
    this.events.partial?.({
      streamId: payload.streamId,
      utteranceId: payload.utteranceId,
      epoch: payload.epoch,
      sequence: payload.sequence,
      text: payload.text,
      replacedCharacters: payload.replacedCharacters,
    });
  }
  private sttFinal(payload: SttFinalPayload): void {
    const utterance = this.utterance;
    if (
      !utterance ||
      !utterance.speechEnded ||
      utterance.epoch === undefined ||
      payload.utteranceId !== utterance.utteranceId ||
      payload.epoch !== utterance.epoch
    )
      return this.protocolFailure();
    this.events.final?.({
      streamId: payload.streamId,
      utteranceId: payload.utteranceId,
      epoch: payload.epoch,
      text: payload.text,
      endpointComplete: payload.endpointComplete,
    });
    this.utterance = undefined;
  }

  private ttsStarted(payload: TtsStartedPayload): void {
    const pending = this.pending.get(pendingKey(payload.responseId, payload.partIndex));
    const outputStreamId = payload.outputStreamId;
    if (
      !pending ||
      pending.sidecarStarted ||
      pending.epoch !== payload.epoch ||
      this.usedOutputStreams.has(outputStreamId)
    )
      return this.protocolFailure();
    if (this.selection && payload.voiceId !== this.selection.voiceId) return this.protocolFailure();
    if ((payload.backendId === undefined) !== (payload.modelId === undefined)) return this.protocolFailure();
    if (payload.backendId !== undefined && payload.backendId !== this.backendId) return this.protocolFailure();
    if (payload.modelId !== undefined && payload.modelId !== this.modelId) return this.protocolFailure();
    if (
      (this.backendId !== DEFAULT_TTS_MODEL.backendId || this.modelId !== DEFAULT_TTS_MODEL.modelId) &&
      (payload.backendId !== this.backendId || payload.modelId !== this.modelId)
    )
      return this.protocolFailure();
    pending.playbackId = payload.playbackId;
    pending.outputStreamId = outputStreamId;
    pending.sampleRate = payload.sampleRate;
    pending.sidecarStarted = true;
    this.usedOutputStreams.add(outputStreamId);
    if (!pending.cutoff) {
      pending.startSettled = true;
      const start: SpeechSynthesisStart = {
        playbackId: pending.playbackId,
        sampleRate: pending.sampleRate,
        completion: pending.completion,
      };
      if (payload.backendId !== undefined) start.backendId = payload.backendId;
      if (payload.modelId !== undefined) start.modelId = payload.modelId;
      if (pending.partIndex !== undefined) start.partIndex = pending.partIndex;
      if (pending.partId) start.partId = pending.partId;
      if (pending.outputStreamId !== undefined) start.outputStreamId = pending.outputStreamId;
      pending.resolveStart(start);
    }
  }

  private handleBinary(frame: Uint8Array): void {
    let decoded;
    try {
      decoded = decodeBinaryAudioFrame(frame, MAX_PAYLOAD - 20);
    } catch {
      this.protocolFailure();
      return;
    }
    const pending = [...this.pending.values()].find((item) => item.outputStreamId === decoded.streamId);
    if (
      !pending ||
      !pending.sidecarStarted ||
      pending.remoteTerminal ||
      decoded.channel !== 2 ||
      decoded.sequence !== pending.expectedSequence
    )
      return this.protocolFailure();
    pending.expectedSequence++;
    pending.receivedSamples += decoded.pcm16.length;
    if (pending.cutoff) return;
    pending.onGeneratedSamples?.(pending.receivedSamples);
    if (pending.released) this.binarySink(frame.slice());
    else {
      pending.chunks.push(frame.slice());
      if (pending.chunks.length > MAX_BUFFERED_OUTPUT_CHUNKS) this.protocolFailure();
    }
  }

  private ttsEnded(payload: TtsEndedPayload): void {
    const pending = this.pending.get(pendingKey(payload.responseId, payload.partIndex));
    if (
      !pending ||
      pending.remoteTerminal ||
      !pending.playbackId ||
      pending.playbackId !== payload.playbackId ||
      pending.epoch !== payload.epoch ||
      !pending.sampleRate
    )
      return this.protocolFailure();
    const generatedSamples = payload.generatedSamples;
    if (
      !Number.isSafeInteger(generatedSamples) ||
      generatedSamples <= 0 ||
      generatedSamples !== pending.receivedSamples
    )
      return this.protocolFailure();
    pending.remoteTerminal = true;
    pending.detachAbort();
    if (pending.cutoff) {
      pending.chunks.length = 0;
      this.rejectPending(pending, new Error('TTS cancelled'));
    } else if (!pending.completionSettled) {
      // The part is remotely complete. If the browser-facing release has not
      // happened yet (a multi-part body part commits synchronously right after
      // begin), flush the buffered PCM now so it is never dropped with the
      // pending entry. release() later is a no-op because the pending is gone.
      if (!pending.released) {
        for (const chunk of pending.chunks) this.binarySink(chunk);
        pending.chunks.length = 0;
      }
      pending.completionSettled = true;
      pending.resolveCompletion({ generatedSamples });
    }
    this.pending.delete(pending.key);
    this.removeAdmitted(pending);
    this.flushQueue();
  }
  private ttsCancelled(payload: TtsCancelledPayload): void {
    const pending = this.pending.get(pendingKey(payload.responseId, payload.partIndex));
    if (!pending || !pending.cutoff || pending.remoteTerminal || payload.epoch !== pending.epoch)
      return this.protocolFailure();
    pending.remoteTerminal = true;
    pending.chunks.length = 0;
    this.rejectPending(pending, new Error('TTS cancelled'));
    this.pending.delete(pending.key);
    this.removeAdmitted(pending);
    this.flushQueue();
  }

  private sendStream(type: string, payload?: SidecarStreamFields): void {
    const streamId = this.streamId;
    if (streamId === undefined) throw new Error('audio stream is not open');
    const message: OutboundSidecarMessage =
      payload === undefined ? { type, payload: { streamId } } : { type, payload: { streamId, ...payload } };
    this.sendMessage(message);
  }
  private sendMessage(message: OutboundSidecarMessage): void {
    this.readySocket().send(JSON.stringify(message));
  }
  private readySocket(): WebSocket {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('audio sidecar is not connected');
    return this.socket;
  }
  private requireOpened(): void {
    if (this.failed || !this.streamId || !this.streamOpened) throw new Error('audio stream is not open');
  }
  private async waitUntilReady(): Promise<void> {
    // A sidecar can announce `starting` once when its background prepare thread
    // begins. Poll health while waiting so starting never races stream admission.
    const deadline = Date.now() + 30_000;
    while (!this.failed && Date.now() < deadline) {
      if (this.readinessSeen && this.readyStatus === 'ready') return;
      if (this.readinessSeen && this.readyStatus === 'starting') {
        try {
          const response = await fetch(`${this.sidecar.origin}/health`, {
            headers: { authorization: `Bearer ${this.sidecar.secret}` },
            signal: AbortSignal.timeout(500),
          });
          if (response.ok) {
            // SAFETY: response.json() output is a JSON value by construction
            // (the fetch boundary); decodeHealthSnapshot re-validates its shape.
            const health = decodeHealthSnapshot((await response.json()) as JsonValue);
            if (health !== undefined) {
              this.readyStatus = health.status;
              if (health.warmup !== undefined) {
                this.sidecarWarmup = { vad: health.warmup.vad, tts: health.warmup.tts };
              }
              this.reportStatus({
                status: health.status === 'ready' ? 'warming' : 'failed',
                capture: 'starting',
                vad: this.sidecarWarmup.vad,
                tts: this.sidecarWarmup.tts,
                detail:
                  health.status === 'ready'
                    ? 'Speech models are ready; opening the microphone stream.'
                    : 'The local speech engine failed to warm up.',
              });
              if (this.readyStatus === 'failed') break;
              continue;
            }
          }
        } catch {
          /* keep waiting; the websocket failure path remains authoritative */
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!this.readinessSeen || this.readyStatus !== 'ready') throw new Error('audio sidecar is not ready');
  }
  private protocolFailure(): void {
    if (this.failed) return;
    this.failed = true;
    this.readyStatus = 'failed';
    this.reportStatus({
      status: 'failed',
      capture: 'failed',
      vad: this.sidecarWarmup.vad,
      tts: 'failed',
      detail: 'The local audio engine sent an invalid status.',
    });
    this.events.failure?.('invalid_message');
    this.failAll(new Error('invalid sidecar protocol'));
    this.socket?.close(CLOSE_PROTOCOL_VIOLATION, 'invalid sidecar protocol');
  }
  private connectionFailure(message: string): void {
    if (this.failed) return;
    this.failed = true;
    this.readyStatus = 'failed';
    this.reportStatus({
      status: 'failed',
      capture: 'failed',
      vad: this.sidecarWarmup.vad,
      tts: 'failed',
      detail: message,
    });
    this.events.failure?.('sidecar_unavailable');
    this.failAll(new Error(message));
  }
  private rejectPending(pending: PendingTts, error: Error): void {
    pending.detachAbort();
    if (!pending.startSettled) {
      pending.startSettled = true;
      pending.rejectStart(error);
    }
    if (!pending.completionSettled) {
      pending.completionSettled = true;
      pending.rejectCompletion(error);
    }
  }
  private failAll(error: Error): void {
    this.openWaiter?.reject(error);
    this.openWaiter = undefined;
    for (const pending of this.pending.values()) {
      pending.cutoff = true;
      this.rejectPending(pending, error);
    }
    this.pending.clear();
    this.admitted.length = 0;
    this.queued.length = 0;
  }
}
