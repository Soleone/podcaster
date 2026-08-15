import { openPodcasterDatabase, requestResult, STORES, transactionDone, type DatabaseFactory, type StoredSession, type StoredTurn } from './schema';

export interface StableEvent {
  eventId: string;
  sessionId: string;
  epoch: number;
  monotonicMs: number;
  type: string;
  payload: Record<string, unknown>;
}
export interface StorageResult { ok: boolean; duplicate?: boolean; degradedReason?: string }
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

function blankTurn(sessionId: string, turnId: string, at: string, timelineSequence: number): StoredTurn {
  return { key: turnKey(sessionId, turnId), sessionId, turnId, stableText: null, posture: null, eligible: null, policyReason: null, responseId: null, assistantText: null, playbackId: null, outputEpoch: null, sampleRate: null, generatedSamples: 0, deliveredSampleOffset: 0, pendingDeliveredOffset: 0, terminalReason: null, interrupted: false, pausedSampleOffset: null, interruptionDisposition: null, interruptionIntent: null, interruptedResponseId: null, controlOnly: false, continuationState: 'none', timelineSequence, failures: [], createdAt: at, updatedAt: at };
}

export class StableTurnWriter {
  constructor(private readonly db: IDBDatabase) {}

  static async open(factory?: DatabaseFactory, name?: string): Promise<StableTurnWriter> {
    return new StableTurnWriter(await openPodcasterDatabase(factory, name));
  }

  close(): void { this.db.close(); }

  async beginSession(input: { sessionId: string; sessionSeed: string; personaDigest: string; startedAt?: string }): Promise<StorageResult> {
    return this.guard(async () => {
      const transaction = this.db.transaction([STORES.sessions, STORES.meta], 'readwrite');
      const sessions = transaction.objectStore(STORES.sessions);
      const existing = await requestResult(sessions.get(input.sessionId)) as StoredSession | undefined;
      const now = input.startedAt ?? isoNow();
      if (!existing) sessions.put({ sessionId: input.sessionId, sessionSeed: input.sessionSeed, personaDigest: input.personaDigest, startedAt: now, updatedAt: now, endedAt: null, state: 'active', failures: [] } satisfies StoredSession);
      else sessions.put({ ...existing, sessionSeed: input.sessionSeed, personaDigest: input.personaDigest, state: 'active', endedAt: null, updatedAt: now });
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

  async endSession(sessionId: string, endedAt = isoNow()): Promise<StorageResult> {
    return this.guard(async () => {
      const transaction = this.db.transaction([STORES.sessions, STORES.meta], 'readwrite');
      const store = transaction.objectStore(STORES.sessions);
      const session = await requestResult(store.get(sessionId)) as StoredSession | undefined;
      if (session) store.put({ ...session, state: 'stopped', endedAt, updatedAt: endedAt });
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
      const at = isoNow();
      let turn: StoredTurn | undefined;
      const turnId = stringValue(event.payload.turnId);
      if (turnId) turn = (await requestResult(turns.get(turnKey(event.sessionId, turnId))) as StoredTurn | undefined) ?? blankTurn(event.sessionId, turnId, at, event.monotonicMs);
      const responseId = stringValue(event.payload.responseId);
      if (!turn && responseId) {
        const matches = await requestResult(turns.index('responseId').getAll(responseId)) as StoredTurn[];
        turn = matches.find(candidate => candidate.sessionId === event.sessionId);
      }
      const playbackId = stringValue(event.payload.playbackId);
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
        const code = stringValue(event.payload.code) ?? 'unknown_failure';
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
      if (error instanceof DuplicateEvent) return { ok: true, duplicate: true };
      const name = error instanceof DOMException ? error.name : 'StorageError';
      return { ok: false, degradedReason: name === 'QuotaExceededError' ? 'Local storage is full. Earlier stable turns are preserved.' : 'Stable local storage is unavailable. Earlier saved work was not changed.' };
    }
  }
}
class DuplicateEvent extends Error {}
