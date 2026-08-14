import { describe, expect, it } from 'vitest';
import type { RecordingItemSummary } from '../storage/recording-store';
import { projectRecordingTrim } from './trim-state';

function summary(partial: Partial<RecordingItemSummary> & { itemId: string }): RecordingItemSummary {
  return { sessionId: 's', recordSeq: 0, role: 'user', turnId: null, responseId: null, partIndex: null, trimmed: false, ...partial };
}

describe('projectRecordingTrim', () => {
  it('maps a single user row to its user bubble', () => {
    const state = projectRecordingTrim([summary({ itemId: 'a', role: 'user', turnId: 't1' })], true);
    const target = state.targets.get('user:t1');
    expect(target).toEqual({ targetId: 'user:t1', itemIds: ['a'], state: 'included' });
    expect(state.totalCount).toBe(1);
    expect(state.includedCount).toBe(1);
    expect(state.bubbleCount).toBe(1);
    expect(state.includedBubbleCount).toBe(1);
  });

  it('groups every agent part sharing a responseId into one assistant target', () => {
    const state = projectRecordingTrim([
      summary({ itemId: 'p0', role: 'agent', responseId: 'r1', partIndex: 0 }),
      summary({ itemId: 'p1', role: 'agent', responseId: 'r1', partIndex: 1 }),
      summary({ itemId: 'p2', role: 'agent', responseId: 'r1', partIndex: 2 }),
    ], true);
    const target = state.targets.get('assistant:r1');
    expect(target).toEqual({ targetId: 'assistant:r1', itemIds: ['p0', 'p1', 'p2'], state: 'included' });
    expect(state.targets.size).toBe(1);
    // Three segments collapse into one bubble for the status label.
    expect(state.totalCount).toBe(3);
    expect(state.bubbleCount).toBe(1);
    expect(state.includedBubbleCount).toBe(1);
  });

  it('keeps same-turn user and assistant targets distinct', () => {
    const state = projectRecordingTrim([
      summary({ itemId: 'u', role: 'user', turnId: 't1' }),
      summary({ itemId: 'a', role: 'agent', turnId: 't1', responseId: 'r1' }),
    ], true);
    expect(state.targets.get('user:t1')).toBeDefined();
    expect(state.targets.get('assistant:r1')).toBeDefined();
    expect(state.targets.size).toBe(2);
  });

  it('keeps orphan rows exportable without creating bubble controls', () => {
    const state = projectRecordingTrim([
      summary({ itemId: 'u', role: 'user', turnId: 't1' }),
      summary({ itemId: 'orphan', role: 'user', turnId: null }),
    ], true);
    expect(state.targets.size).toBe(1);
    expect(state.totalCount).toBe(2);
    expect(state.includedCount).toBe(2);
  });

  it('aggregates included, trimmed, and mixed deterministically', () => {
    const included = projectRecordingTrim([summary({ itemId: 'a', role: 'agent', responseId: 'r1', partIndex: 0 })], true);
    expect(included.targets.get('assistant:r1')!.state).toBe('included');

    const trimmed = projectRecordingTrim([summary({ itemId: 'a', role: 'agent', responseId: 'r1', partIndex: 0, trimmed: true })], true);
    expect(trimmed.targets.get('assistant:r1')!.state).toBe('trimmed');
    expect(trimmed.includedCount).toBe(0);

    const mixed = projectRecordingTrim([
      summary({ itemId: 'a', role: 'agent', responseId: 'r1', partIndex: 0, trimmed: true }),
      summary({ itemId: 'b', role: 'agent', responseId: 'r1', partIndex: 1 }),
    ], true);
    expect(mixed.targets.get('assistant:r1')!.state).toBe('mixed');
    expect(mixed.includedCount).toBe(1);
    // A partially trimmed bubble still counts as included (audio remains).
    expect(mixed.bubbleCount).toBe(1);
    expect(mixed.includedBubbleCount).toBe(1);
  });

  it('reflects the enabled flag and hydration marker', () => {
    const state = projectRecordingTrim([], false, false);
    expect(state.enabled).toBe(false);
    expect(state.hydrated).toBe(false);
    const hydrated = projectRecordingTrim([], true, true);
    expect(hydrated.enabled).toBe(true);
    expect(hydrated.hydrated).toBe(true);
  });
});
