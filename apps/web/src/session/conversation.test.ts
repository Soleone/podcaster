import { describe, expect, it } from 'vitest';
import type { StoredTurn } from '../storage/schema';
import { conversationFromStoredTurns } from './conversation';

const turn = (overrides: Partial<StoredTurn>): StoredTurn => ({
  key: 's:t',
  sessionId: 's',
  turnId: 't',
  stableText: 'hello',
  posture: null,
  eligible: null,
  responseId: null,
  assistantText: null,
  playbackId: null,
  outputEpoch: null,
  sampleRate: null,
  generatedSamples: 0,
  deliveredSampleOffset: 0,
  pendingDeliveredOffset: 0,
  terminalReason: null,
  interrupted: false,
  pausedSampleOffset: null,
  interruptionDisposition: null,
  interruptionIntent: null,
  interruptedResponseId: null,
  controlOnly: false,
  continuationState: 'none',
  timelineSequence: 1,
  failures: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

describe('chronological conversation selector', () => {
  it('restores control-only turns without continuation markers', () => {
    const items = conversationFromStoredTurns([
      turn({
        key: 's:2',
        turnId: '2',
        stableText: 'carry on from there',
        controlOnly: true,
        interruptedResponseId: 'r1',
        interruptionDisposition: 'resume_requested',
        timelineSequence: 20,
      }),
      turn({
        key: 's:1',
        turnId: '1',
        stableText: 'first question',
        responseId: 'r1',
        assistantText: 'original answer',
        continuationState: 'resumed',
        timelineSequence: 10,
      }),
    ]);
    expect(items.map((item) => `${item.kind}:${item.id}`)).toEqual(['user:1', 'assistant:assistant:r1', 'user:2']);
    expect(items.find((item) => item.kind === 'user' && item.id === '2')).toMatchObject({ status: 'control' });
    expect(items).not.toContainEqual(expect.objectContaining({ kind: 'notice' }));
  });
});
