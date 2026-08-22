import type { RecordingItemSummary } from '../storage/recording-store';

export type RecordingPartTrimTargetId = `assistant-part:${string}:${number}`;
export type RecordingTrimTargetId = `user:${string}` | `assistant:${string}` | RecordingPartTrimTargetId;
export type RecordingTrimState = 'included' | 'trimmed' | 'mixed';

export interface RecordingTrimTarget {
  targetId: RecordingTrimTargetId;
  itemIds: string[];
  state: RecordingTrimState;
}

export interface RecordingSessionViewState {
  hydrated: boolean;
  enabled: boolean;
  /** Number of persisted recording messages, including each assistant part. */
  totalCount: number;
  /** Number of persisted recording messages that remain in the export. */
  includedCount: number;
  /** Number of visible bubbles (rows grouped by turn/response), excluding orphans. */
  bubbleCount: number;
  /** Number of bubbles with at least some selected audio. */
  includedBubbleCount: number;
  /** Whole-bubble trim targets. */
  targets: ReadonlyMap<string, RecordingTrimTarget>;
  /** Individual assistant-part trim targets. */
  partTargets: ReadonlyMap<string, RecordingTrimTarget>;
  pendingTargetId: string | null;
  notice: string;
  error: string;
}

export function emptyRecordingSessionView(): RecordingSessionViewState {
  return {
    hydrated: false,
    enabled: false,
    totalCount: 0,
    includedCount: 0,
    bubbleCount: 0,
    includedBubbleCount: 0,
    targets: new Map(),
    partTargets: new Map(),
    pendingTargetId: null,
    notice: '',
    error: '',
  };
}

/**
 * Maps a recording row to the visible bubble it belongs to. User rows group by
 * turnId; agent rows group by parent responseId (a multi-part assistant bubble
 * can contain several rows that share one responseId). Rows with neither key
 * stay orphaned and never expose a bubble control.
 */
function targetKey(summary: RecordingItemSummary): RecordingTrimTargetId | null {
  if (summary.role === 'user') return summary.turnId ? `user:${summary.turnId}` : null;
  return summary.responseId ? `assistant:${summary.responseId}` : null;
}

export function assistantPartTargetId(responseId: string, partIndex: number): RecordingPartTrimTargetId {
  return `assistant-part:${responseId}:${partIndex}`;
}

function partTargetKey(summary: RecordingItemSummary): RecordingPartTrimTargetId | null {
  return summary.role === 'agent' && summary.responseId && summary.partIndex !== null
    ? assistantPartTargetId(summary.responseId, summary.partIndex)
    : null;
}

function mergeState(accumulated: RecordingTrimState, member: 'included' | 'trimmed'): RecordingTrimState {
  if (accumulated === 'mixed') return 'mixed';
  return accumulated === member ? accumulated : 'mixed';
}

function addTarget(
  targets: Map<string, RecordingTrimTarget>,
  targetId: RecordingTrimTargetId,
  itemId: string,
  trimmed: boolean,
): void {
  const memberState = trimmed ? 'trimmed' : 'included';
  const existing = targets.get(targetId);
  if (existing) {
    existing.itemIds.push(itemId);
    existing.state = mergeState(existing.state, memberState);
  } else {
    targets.set(targetId, { targetId, itemIds: [itemId], state: memberState });
  }
}

/** Pure projection from stored recording summaries to UI trim targets. */
export function projectRecordingTrim(
  summaries: readonly RecordingItemSummary[],
  enabled: boolean,
  hydrated = true,
): RecordingSessionViewState {
  const targets = new Map<string, RecordingTrimTarget>();
  const partTargets = new Map<string, RecordingTrimTarget>();
  let totalCount = 0;
  let includedCount = 0;
  for (const summary of summaries) {
    totalCount++;
    if (!summary.trimmed) includedCount++;
    const bubbleTargetId = targetKey(summary);
    if (bubbleTargetId) addTarget(targets, bubbleTargetId, summary.itemId, summary.trimmed);
    const partTargetId = partTargetKey(summary);
    if (partTargetId) addTarget(partTargets, partTargetId, summary.itemId, summary.trimmed);
  }
  // Bubble-level counts: at least some audio selected counts a bubble as included.
  let includedBubbleCount = 0;
  for (const target of targets.values()) {
    if (target.state !== 'trimmed') includedBubbleCount++;
  }
  return {
    hydrated,
    enabled,
    totalCount,
    includedCount,
    bubbleCount: targets.size,
    includedBubbleCount,
    targets,
    partTargets,
    pendingTargetId: null,
    notice: '',
    error: '',
  };
}
