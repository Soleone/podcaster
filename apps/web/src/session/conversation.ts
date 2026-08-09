import type { StoredTurn } from '../storage/schema';

export type ConversationItem =
  | { kind: 'user'; id: string; text: string; status: 'tentative' | 'stable' | 'control'; sequence: number }
  | { kind: 'assistant'; id: string; responseId: string; playbackId?: string; text: string; playback: 'preparing' | 'playing' | 'paused' | 'completed' | 'interrupted'; sequence: number }
  | { kind: 'continuation'; id: string; responseId: string; label: string; sequence: number }
  | { kind: 'notice'; id: string; tone: 'quiet' | 'warning'; text: string; sequence: number };

export function conversationFromStoredTurns(turns: readonly StoredTurn[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  for (const turn of [...turns].sort((a, b) => a.timelineSequence - b.timelineSequence || a.createdAt.localeCompare(b.createdAt))) {
    if (turn.stableText?.trim()) items.push({ kind: 'user', id: turn.turnId, text: turn.stableText, status: turn.controlOnly ? 'control' : 'stable', sequence: turn.timelineSequence });
    if (turn.assistantText && turn.responseId) {
      const playback: Extract<ConversationItem, { kind: 'assistant' }>['playback'] = turn.continuationState === 'paused' ? 'paused' : turn.interrupted || turn.continuationState === 'discarded' ? 'interrupted' : turn.terminalReason === 'completed' ? 'completed' : 'preparing';
      const existing = items.findIndex(item => item.kind === 'assistant' && item.responseId === turn.responseId);
      const assistant = { kind: 'assistant' as const, id: `assistant:${turn.responseId}`, responseId: turn.responseId, text: turn.assistantText, playback, sequence: turn.timelineSequence + 0.25 };
      if (existing >= 0) items[existing] = { ...assistant, sequence: items[existing]!.sequence };
      else items.push(assistant);
      if (turn.continuationState === 'paused') items.push({ kind: 'notice', id: `reload:${turn.responseId}`, tone: 'warning', text: "Previous response can’t be resumed after reload.", sequence: turn.timelineSequence + 0.5 });
    }
  }
  return items.sort((a, b) => a.sequence - b.sequence);
}
