import type { HostEvent, PlaybackPausedEvent, PlaybackProgressEvent, PlaybackStoppedEvent } from '@app/contracts';
import { MAX_PLANNING_NOTES_BYTES, MAX_PLANNING_TOPIC_BYTES, type PlanningDepth, type PlanningStatus } from '@app/contracts/settings';
import { MAX_SESSION_TITLE_LENGTH, openPodcasterDatabase, requestResult, STORES, transactionDone, type DatabaseFactory, type SessionPreparationDraft, type StoredSession, type StoredTurn } from './schema';

export type PersistedSessionEvent = HostEvent | PlaybackProgressEvent | PlaybackPausedEvent | PlaybackStoppedEvent;
export type StableEvent = PersistedSessionEvent;
export interface StorageResult { ok: boolean; duplicate?: boolean; degradedReason?: string }
export interface PlaybackPauseCheckpoint {
  responseId: string;
  playbackId: string;
  outputEpoch: number;
  pausedSampleOffset: number;
  generatedSamples: number;
}
interface PlaybackAccounting {
  /** Composite IndexedDB key: sessionId, playbackId, and output epoch. */
  playbackId: string;
  pendingMax: number;
  terminal: null | { cancelledEpoch: number; finalPlayedSampleOffset: number; reason: 'completed' | 'cancelled' | 'stopped' | 'failed'; eventId: string };
}

const isoNow = () => new Date().toISOString();
const turnKey = (sessionId: string, turnId: string) => `${sessionId}:${turnId}`;
const accountingKey = (sessionId: string, playbackId: string, outputEpoch: number) => `${sessionId}:${outputEpoch}:${playbackId}`;
const stringValue = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const numberValue = (value: unknown): number | undefined => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;

function timestampMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Returns foreground time for a session, including the current run when it is
 * active. Older rows do not have the timer fields, so fall back to their wall
 * clock interval without making a migration destructive.
 */
export function sessionActiveDurationMs(session: StoredSession, atMs = Date.now()): number {
  const persisted = typeof session.activeDurationMs === 'number' && Number.isFinite(session.activeDurationMs)
    ? Math.max(0, session.activeDurationMs)
    : undefined;
  if (persisted !== undefined) {
    if (session.state !== 'active') return persisted;
    const runningSince = timestampMs(session.runningSince) ?? timestampMs(session.startedAt) ?? atMs;
    return persisted + Math.max(0, atMs - runningSince);
  }
  const started = timestampMs(session.startedAt) ?? atMs;
  const ended = session.state === 'active' ? atMs : timestampMs(session.endedAt) ?? timestampMs(session.updatedAt) ?? atMs;
  return Math.max(0, ended - started);
}

function blankTurn(sessionId: string, turnId: string, at: string, timelineSequence: number): StoredTurn {
  return { key: turnKey(sessionId, turnId), sessionId, turnId, stableText: null, posture: null, eligible: null, policyReason: null, responseId: null, assistantText: null, playbackId: null, outputEpoch: null, sampleRate: null, generatedSamples: 0, deliveredSampleOffset: 0, pendingDeliveredOffset: 0, terminalReason: null, interrupted: false, pausedSampleOffset: null, interruptionDisposition: null, interruptionIntent: null, interruptedResponseId: null, controlOnly: false, continuationState: 'none', timelineSequence, failures: [], createdAt: at, updatedAt: at };
}

function planningSnapshot(value: unknown): StoredSession['planning'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const statuses: PlanningStatus[] = ['skipped', 'planning', 'ready', 'failed', 'cancelled', 'continued'];
  const depths: PlanningDepth[] = ['light', 'standard', 'deep'];
  if (!Object.keys(input).every(key => ['status', 'topic', 'depth', 'progress', 'detail', 'notes'].includes(key))) return undefined;
  if (!statuses.includes(input.status as PlanningStatus)) return undefined;
  if (input.topic !== undefined && (typeof input.topic !== 'string' || input.topic.length === 0 || new TextEncoder().encode(input.topic).length > MAX_PLANNING_TOPIC_BYTES)) return undefined;
  if (input.depth !== undefined && !depths.includes(input.depth as PlanningDepth)) return undefined;
  if (input.progress !== undefined && (!Number.isSafeInteger(input.progress) || Number(input.progress) < 0 || Number(input.progress) > 100)) return undefined;
  if (input.detail !== undefined && (typeof input.detail !== 'string' || input.detail.length > 512)) return undefined;
  if (input.notes !== undefined && (typeof input.notes !== 'string' || new TextEncoder().encode(input.notes).length > MAX_PLANNING_NOTES_BYTES)) return undefined;
  return {
    status: input.status as PlanningStatus,
    ...(typeof input.topic === 'string' ? { topic: input.topic } : {}),
    ...(depths.includes(input.depth as PlanningDepth) ? { depth: input.depth as PlanningDepth } : {}),
    ...(typeof input.progress === 'number' ? { progress: input.progress } : {}),
    ...(typeof input.detail === 'string' ? { detail: input.detail } : {}),
    ...(typeof input.notes === 'string' ? { notes: input.notes } : {}),
  };
}

function preparationDraft(value: SessionPreparationDraft): SessionPreparationDraft {
  const topic = value.topic.trim();
  if (new TextEncoder().encode(topic).length > MAX_PLANNING_TOPIC_BYTES) throw new DraftRejected('The preparation topic is too long.');
  if (!['light', 'standard', 'deep'].includes(value.depth)) throw new DraftRejected('The preparation depth is invalid.');
  return { enabled: Boolean(value.enabled), topic, depth: value.depth };
}

function sessionTitle(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const title = value.trim();
  if (Array.from(title).length > MAX_SESSION_TITLE_LENGTH) throw new DraftRejected('The session title is too long.');
  return title || undefined;
}

export class StableTurnWriter {
  constructor(private readonly db: IDBDatabase) {}

  static async open(factory?: DatabaseFactory, name?: string): Promise<StableTurnWriter> {
    return new StableTurnWriter(await openPodcasterDatabase(factory, name));
  }

  close(): void { this.db.close(); }

  async createDraftSession(input: { sessionId: string; sessionSeed: string; startedAt?: string; title?: string; preparation?: SessionPreparationDraft }): Promise<StorageResult> {
    return this.guard(async () => {
      const transaction = this.db.transaction(STORES.sessions, 'readwrite');
      const sessions = transaction.objectStore(STORES.sessions);
      const existing = await requestResult(sessions.get(input.sessionId)) as StoredSession | undefined;
      if (existing) { transaction.abort(); throw new DraftRejected('The session already exists.'); }
      const now = input.startedAt ?? isoNow();
      const title = sessionTitle(input.title);
      sessions.put({
        sessionId: input.sessionId,
        sessionSeed: input.sessionSeed,
        personaDigest: '',
        startedAt: now,
        updatedAt: now,
        endedAt: null,
        state: 'draft',
        activeDurationMs: 0,
        runningSince: null,
        pausedAt: null,
        ...(title ? { title } : {}),
        ...(input.preparation ? { preparation: preparationDraft(input.preparation) } : {}),
        failures: [],
      } satisfies StoredSession);
      await transactionDone(transaction);
    });
  }

  async updateDraftSession(sessionId: string, preparation: SessionPreparationDraft, title?: string): Promise<StorageResult> {
    return this.guard(async () => {
      const transaction = this.db.transaction(STORES.sessions, 'readwrite');
      const sessions = transaction.objectStore(STORES.sessions);
      const session = await requestResult(sessions.get(sessionId)) as StoredSession | undefined;
      if (!session || session.state !== 'draft') { transaction.abort(); throw new DraftRejected('Only a not-started session can be edited.'); }
      const next: StoredSession = { ...session, preparation: preparationDraft(preparation), updatedAt: isoNow() };
      if (title !== undefined) {
        const normalizedTitle = sessionTitle(title);
        if (normalizedTitle) next.title = normalizedTitle;
        else delete next.title;
      }
      sessions.put(next);
      await transactionDone(transaction);
    });
  }

  async beginSession(input: { sessionId: string; sessionSeed: string; personaDigest: string; settings?: StoredSession['settings']; planning?: StoredSession['planning']; startedAt?: string }): Promise<StorageResult> {
    return this.guard(async () => {
      const transaction = this.db.transaction([STORES.sessions, STORES.meta], 'readwrite');
      const sessions = transaction.objectStore(STORES.sessions);
      const existing = await requestResult(sessions.get(input.sessionId)) as StoredSession | undefined;
      const now = input.startedAt ?? isoNow();
      const nowMs = timestampMs(now) ?? Date.now();
      const activeDurationMs = existing ? sessionActiveDurationMs(existing, nowMs) : 0;
      const draftPlanning = existing?.state === 'draft'
        && existing.planning
        && input.planning
        && existing.planning.topic === input.planning.topic
        && existing.planning.depth === input.planning.depth
        ? existing.planning
        : input.planning;
      if (!existing) {
        sessions.put({ sessionId: input.sessionId, sessionSeed: input.sessionSeed, personaDigest: input.personaDigest, startedAt: now, updatedAt: now, endedAt: null, state: 'active', activeDurationMs, runningSince: now, pausedAt: null, ...(input.settings ? { settings: input.settings } : {}), ...(input.planning ? { planning: input.planning } : {}), failures: [] } satisfies StoredSession);
      } else {
        const preserveRuntimeIdentity = existing.state === 'active' || existing.state === 'paused';
        const preserveSeed = existing.state !== 'stopped';
        sessions.put({
          ...existing,
          sessionSeed: preserveSeed ? existing.sessionSeed : input.sessionSeed,
          personaDigest: preserveRuntimeIdentity ? existing.personaDigest : input.personaDigest,
          state: 'active', endedAt: null, updatedAt: now, activeDurationMs, runningSince: now, pausedAt: null,
          ...(preserveRuntimeIdentity ? ((existing.settings ?? input.settings) ? { settings: existing.settings ?? input.settings } : {}) : (input.settings ? { settings: input.settings } : {})),
          ...(preserveRuntimeIdentity ? ((existing.planning ?? input.planning) ? { planning: existing.planning ?? input.planning } : {}) : { planning: draftPlanning }),
        });
      }
      transaction.objectStore(STORES.meta).put({ key: 'activeSession', sessionId: input.sessionId });
      await transactionDone(transaction);
    });
  }

  async getSession(sessionId: string): Promise<StoredSession | undefined> {
    const transaction = this.db.transaction(STORES.sessions, 'readonly');
    return await requestResult(transaction.objectStore(STORES.sessions).get(sessionId)) as StoredSession | undefined;
  }

  /** Every local session, most recently active first. */
  async listSessions(): Promise<StoredSession[]> {
    const transaction = this.db.transaction(STORES.sessions, 'readonly');
    const sessions = await requestResult(transaction.objectStore(STORES.sessions).getAll()) as StoredSession[];
    return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async countTurns(sessionId: string): Promise<number> {
    const transaction = this.db.transaction(STORES.turns, 'readonly');
    return await requestResult(transaction.objectStore(STORES.turns).index('sessionId').count(sessionId)) as number;
  }

  async recoverActiveSession(): Promise<StoredSession | undefined> {
    const transaction = this.db.transaction([STORES.sessions, STORES.meta], 'readonly');
    const active = await requestResult(transaction.objectStore(STORES.meta).get('activeSession')) as { sessionId?: string } | undefined;
    if (!active?.sessionId) return;
    return await requestResult(transaction.objectStore(STORES.sessions).get(active.sessionId)) as StoredSession | undefined;
  }

  /** Checkpoints a live session without ending it or discarding its transcript. */
  async pauseSession(sessionId: string, pausedAt = isoNow(), playbacks: readonly PlaybackPauseCheckpoint[] = []): Promise<StorageResult> {
    return this.guard(async () => {
      const transaction = this.db.transaction([STORES.sessions, STORES.turns, STORES.meta], 'readwrite');
      const store = transaction.objectStore(STORES.sessions);
      const session = await requestResult(store.get(sessionId)) as StoredSession | undefined;
      if (!session) { transaction.abort(); throw new PauseRejected('The session could not be found.'); }
      if (session.state === 'draft') { transaction.abort(); throw new PauseRejected('The session has not started yet.'); }
      if (session.state === 'stopped') { transaction.abort(); throw new PauseRejected('The session has already ended.'); }
      const atMs = timestampMs(pausedAt) ?? Date.now();
        const turns = await requestResult(transaction.objectStore(STORES.turns).index('sessionId').getAll(sessionId)) as StoredTurn[];
        for (const turn of turns) {
          const checkpoint = playbacks.find(candidate => candidate.responseId === turn.responseId && candidate.playbackId === turn.playbackId && candidate.outputEpoch === turn.outputEpoch);
          let changed = false;
          if (checkpoint) {
            turn.pausedSampleOffset = Math.max(turn.pausedSampleOffset ?? 0, checkpoint.pausedSampleOffset);
            turn.pendingDeliveredOffset = Math.max(turn.pendingDeliveredOffset, checkpoint.pausedSampleOffset);
            if (checkpoint.generatedSamples > 0) turn.generatedSamples = Math.max(turn.generatedSamples, checkpoint.generatedSamples);
            turn.deliveredSampleOffset = turn.generatedSamples > 0 ? Math.min(turn.pendingDeliveredOffset, turn.generatedSamples) : turn.deliveredSampleOffset;
            changed = true;
          }
          // Pause tears down the host and browser playback. Mark any response
          // without a durable terminal receipt as interrupted so a later
          // rehydrate never presents it as if it could continue automatically.
          // A response can still be in reasoning before tts.started, so the
          // response identity is part of the in-flight check as well.
          const responseInFlight = turn.responseId !== null && turn.failures.length === 0;
          if ((turn.assistantText !== null || responseInFlight || turn.playbackId !== null || checkpoint) && turn.terminalReason === null) {
            turn.terminalReason = 'stopped';
            turn.interrupted = true;
            turn.continuationState = 'discarded';
            changed = true;
          }
          if (changed) {
            turn.updatedAt = pausedAt;
            transaction.objectStore(STORES.turns).put(turn);
          }
        }
        store.put({ ...session, state: 'paused', endedAt: null, updatedAt: pausedAt, activeDurationMs: sessionActiveDurationMs(session, atMs), runningSince: null, pausedAt });
      transaction.objectStore(STORES.meta).put({ key: 'activeSession', sessionId });
      await transactionDone(transaction);
    });
  }

  async endSession(sessionId: string, endedAt = isoNow()): Promise<StorageResult> {
    return this.guard(async () => {
      const transaction = this.db.transaction([STORES.sessions, STORES.meta], 'readwrite');
      const store = transaction.objectStore(STORES.sessions);
      const session = await requestResult(store.get(sessionId)) as StoredSession | undefined;
      if (session) {
        const atMs = timestampMs(endedAt) ?? Date.now();
        store.put({ ...session, state: 'stopped', endedAt, updatedAt: endedAt, activeDurationMs: sessionActiveDurationMs(session, atMs), runningSince: null, pausedAt: null });
      }
      const meta = transaction.objectStore(STORES.meta);
      const active = await requestResult(meta.get('activeSession')) as { sessionId?: string } | undefined;
      if (active?.sessionId === sessionId) meta.delete('activeSession');
      await transactionDone(transaction);
    });
  }

  async apply(event: StableEvent): Promise<StorageResult> {
    if (event.type === 'transcript.partial' || event.type === 'reasoning.delta') return { ok: true };
    return this.guard(async () => {
      const transaction = this.db.transaction([STORES.sessions, STORES.turns, STORES.appliedEvents, STORES.terminalReceipts], 'readwrite');
      const applied = transaction.objectStore(STORES.appliedEvents);
      if (await requestResult(applied.get(event.eventId))) {
        transaction.abort();
        throw new DuplicateEvent();
      }
      const turns = transaction.objectStore(STORES.turns);
      const sessions = transaction.objectStore(STORES.sessions);
      const at = isoNow();
      if (event.type === 'session.state') {
        const session = await requestResult(sessions.get(event.sessionId)) as StoredSession | undefined;
        const planning = planningSnapshot(event.payload.planning);
        if (session && planning) {
          const prior = session.planning;
          const identityMatches = (!prior?.topic || !planning.topic || prior.topic === planning.topic)
            && (!prior?.depth || !planning.depth || prior.depth === planning.depth);
          // Once a plan is ready, a late event from an old host must not replace
          // the frozen notes during reconnect.
          const notStale = prior?.status !== 'ready';
          if (identityMatches && notStale) sessions.put({ ...session, planning: { ...prior, ...planning }, updatedAt: at });
        }
      }
      let turn: StoredTurn | undefined;
      const turnId = 'turnId' in event.payload ? stringValue(event.payload.turnId) : undefined;
      if (turnId) turn = (await requestResult(turns.get(turnKey(event.sessionId, turnId))) as StoredTurn | undefined) ?? blankTurn(event.sessionId, turnId, at, event.monotonicMs);
      const responseId = 'responseId' in event.payload ? stringValue(event.payload.responseId) : undefined;
      if (!turn && responseId) {
        const matches = await requestResult(turns.index('responseId').getAll(responseId)) as StoredTurn[];
        turn = matches.find(candidate => candidate.sessionId === event.sessionId);
      }
      const playbackId = 'playbackId' in event.payload ? stringValue(event.payload.playbackId) : undefined;
      const playbackEpoch = event.type === 'playback.progress'
        ? numberValue(event.payload.outputEpoch) ?? event.epoch
        : event.type === 'playback.stopped'
          ? numberValue(event.payload.cancelledEpoch) ?? event.epoch
          : event.epoch;
      if (!turn && playbackId) {
        const matches = await requestResult(turns.index('playbackId').getAll(playbackId)) as StoredTurn[];
        turn = matches.find(candidate => candidate.sessionId === event.sessionId && candidate.outputEpoch === playbackEpoch);
      }

      if (event.type === 'transcript.final' && turn) {
        const text = stringValue(event.payload.text);
        if (text !== undefined) turn.stableText = text;
      } else if (event.type === 'policy.decision' && turn) {
        const posture = event.payload.posture;
        if (posture === 'riff' || posture === 'question' || posture === 'challenge' || posture === 'silence') turn.posture = posture;
        if (typeof event.payload.eligible === 'boolean') turn.eligible = event.payload.eligible;
        const reasonCodes = Array.isArray(event.payload.reasonCodes) ? event.payload.reasonCodes : [];
        if (typeof reasonCodes[0] === 'string') turn.policyReason = reasonCodes[0];
      } else if (event.type === 'reasoning.started' && turn && responseId) {
        // Associate the response identity with the user turn before any early
        // tts.started needs to reconcile playback accounting against it.
        turn.responseId = responseId;
      } else if (event.type === 'reasoning.final' && turn) {
        if (responseId) turn.responseId = responseId;
        const text = stringValue(event.payload.text);
        if (text !== undefined) {
          const partIndex = numberValue(event.payload.partIndex);
          turn.assistantText = partIndex === undefined || !turn.assistantText
            ? text
            : `${turn.assistantText}\n\n${text}`;
        }
      } else if (event.type === 'response.failed' && turn) {
        // Scope the failure to the matching turn instead of session-level storage.
        const code = stringValue(event.payload.reasonCode) ?? 'response_failed';
        if (!turn.failures.includes(code)) turn.failures.push(code);
        turn.interrupted = true;
      } else if (event.type === 'tts.started' && turn && playbackId) {
        turn.playbackId = playbackId;
        turn.outputEpoch = event.epoch;
        const sampleRate = numberValue(event.payload.sampleRate);
        if (sampleRate && sampleRate > 0) turn.sampleRate = sampleRate;
        await this.reconcileAccounting(transaction, turn, event.sessionId, playbackId, event.epoch);
      } else if (event.type === 'tts.ended' && turn) {
        const generated = numberValue(event.payload.generatedSamples);
        if (generated !== undefined) turn.generatedSamples = Math.max(turn.generatedSamples, generated);
        if (playbackId) await this.reconcileAccounting(transaction, turn, event.sessionId, playbackId, event.epoch);
      } else if (event.type === 'playback.progress' && playbackId) {
        const outputEpoch = numberValue(event.payload.outputEpoch) ?? event.epoch;
        const accounting = await this.accounting(transaction, event.sessionId, playbackId, outputEpoch);
        const offset = numberValue(event.payload.playedSampleOffset) ?? 0;
        if (!accounting.terminal) {
          accounting.pendingMax = Math.max(accounting.pendingMax, offset);
          transaction.objectStore(STORES.terminalReceipts).put(accounting);
          if (turn) this.mergeDelivered(turn, offset);
        }
      } else if (event.type === 'playback.stopped' && playbackId) {
        const cancelledEpoch = numberValue(event.payload.cancelledEpoch) ?? event.epoch;
        const accounting = await this.accounting(transaction, event.sessionId, playbackId, cancelledEpoch);
        const offset = numberValue(event.payload.finalPlayedSampleOffset) ?? 0;
        const reason = event.payload.reason;
        if (!accounting.terminal && (reason === 'completed' || reason === 'cancelled' || reason === 'stopped' || reason === 'failed')) {
          accounting.terminal = { cancelledEpoch, finalPlayedSampleOffset: offset, reason, eventId: event.eventId };
          accounting.pendingMax = offset;
          transaction.objectStore(STORES.terminalReceipts).put(accounting);
        }
        if (turn && accounting.terminal) {
          this.applyTerminalDelivered(turn, accounting.terminal.finalPlayedSampleOffset);
          turn.terminalReason ??= accounting.terminal.reason;
          turn.interrupted ||= accounting.terminal.reason !== 'completed';
        }
      } else if (event.type === 'playback.paused' && turn) {
        const offset = numberValue(event.payload.pausedSampleOffset);
        if (offset !== undefined) turn.pausedSampleOffset = Math.max(turn.pausedSampleOffset ?? 0, offset);
        turn.continuationState = 'paused';
      } else if (event.type === 'interruption.decision' && turn) {
        const disposition = event.payload.disposition;
        if (disposition === 'resume_noise' || disposition === 'resume_fragment' || disposition === 'resume_requested' || disposition === 'accept_takeover') turn.interruptionDisposition = disposition;
        const intent = event.payload.intent;
        if (intent === 'non_substantive' || intent === 'continue_previous' || intent === 'new_request' || intent === 'correction' || intent === 'topic_change' || intent === 'stop_previous') turn.interruptionIntent = intent;
        turn.controlOnly = event.payload.action === 'resume';
        turn.interruptedResponseId = responseId ?? null;
        const interruptedMatches = responseId ? await requestResult(turns.index('responseId').getAll(responseId)) as StoredTurn[] : [];
        const interrupted = interruptedMatches.find(candidate => candidate.sessionId === event.sessionId);
        if (interrupted && interrupted.key !== turn.key) {
          interrupted.pausedSampleOffset = numberValue(event.payload.pausedSampleOffset) ?? interrupted.pausedSampleOffset;
          interrupted.continuationState = event.payload.action === 'resume' ? 'resumed' : 'discarded';
          interrupted.interrupted ||= event.payload.action === 'accept';
          interrupted.updatedAt = at;
          turns.put(interrupted);
        }
      } else if (event.type === 'barge_in.confirmed' && turn) {
        turn.interrupted = true;
        turn.continuationState = 'discarded';
      } else if (event.type === 'failure') {
        const code = event.payload.code;
        if (turn) { if (!turn.failures.includes(code)) turn.failures.push(code); }
        else {
          const sessions = transaction.objectStore(STORES.sessions);
          const session = await requestResult(sessions.get(event.sessionId)) as StoredSession | undefined;
          if (session && !session.failures.includes(code)) sessions.put({ ...session, failures: [...session.failures, code], updatedAt: isoNow() });
        }
      }
      if (turn) { turn.updatedAt = at; turns.put(turn); }
      applied.put({ eventId: event.eventId, type: event.type, sessionId: event.sessionId });
      await transactionDone(transaction);
    });
  }

  async getTurns(sessionId: string): Promise<StoredTurn[]> {
    const transaction = this.db.transaction(STORES.turns, 'readonly');
    return await requestResult(transaction.objectStore(STORES.turns).index('sessionId').getAll(sessionId)) as StoredTurn[];
  }

  private mergeDelivered(turn: StoredTurn, offset: number): void {
    turn.pendingDeliveredOffset = Math.max(turn.pendingDeliveredOffset, offset);
    if (turn.generatedSamples > 0) turn.deliveredSampleOffset = Math.max(turn.deliveredSampleOffset, Math.min(turn.pendingDeliveredOffset, turn.generatedSamples));
  }

  private applyTerminalDelivered(turn: StoredTurn, offset: number): void {
    turn.pendingDeliveredOffset = offset;
    turn.deliveredSampleOffset = turn.generatedSamples > 0 ? Math.min(offset, turn.generatedSamples) : 0;
  }

  private async accounting(transaction: IDBTransaction, sessionId: string, playbackId: string, outputEpoch: number): Promise<PlaybackAccounting> {
    const key = accountingKey(sessionId, playbackId, outputEpoch);
    return (await requestResult(transaction.objectStore(STORES.terminalReceipts).get(key)) as PlaybackAccounting | undefined)
      ?? { playbackId: key, pendingMax: 0, terminal: null };
  }

  private async reconcileAccounting(transaction: IDBTransaction, turn: StoredTurn, sessionId: string, playbackId: string, outputEpoch: number): Promise<void> {
    const accounting = await this.accounting(transaction, sessionId, playbackId, outputEpoch);
    if (accounting.terminal) {
      this.applyTerminalDelivered(turn, accounting.terminal.finalPlayedSampleOffset);
      turn.terminalReason ??= accounting.terminal.reason;
      turn.interrupted ||= accounting.terminal.reason !== 'completed';
    } else {
      this.mergeDelivered(turn, accounting.pendingMax);
    }
  }

  private async guard(operation: () => Promise<void>): Promise<StorageResult> {
    try { await operation(); return { ok: true }; }
    catch (error) {
      if (error instanceof PauseRejected || error instanceof DraftRejected) return { ok: false, degradedReason: error.message };
      if (error instanceof DuplicateEvent) return { ok: true, duplicate: true };
      const name = error instanceof DOMException ? error.name : 'StorageError';
      return { ok: false, degradedReason: name === 'QuotaExceededError' ? 'Local storage is full. Earlier stable turns are preserved.' : 'Stable local storage is unavailable. Earlier saved work was not changed.' };
    }
  }
}
class DuplicateEvent extends Error {}
class PauseRejected extends Error {}
class DraftRejected extends Error {}
