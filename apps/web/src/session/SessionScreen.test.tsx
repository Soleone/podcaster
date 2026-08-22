import { describe, expect, it } from 'vitest';
import { conversationItemStartsTurn } from '../components/conversation/conversation-item';
import type { ConversationItem } from './conversation';

describe('conversation turn anchors', () => {
  it('anchors stable and control user turns without anchoring streamed output rows', () => {
    const user: ConversationItem = { kind: 'user', id: 'user', text: 'Question', status: 'stable', sequence: 1 };
    const control: ConversationItem = { kind: 'user', id: 'control', text: 'Carry on', status: 'control', sequence: 2 };
    const assistant: ConversationItem = {
      kind: 'assistant',
      id: 'assistant',
      responseId: 'response',
      text: 'Answer',
      playback: 'playing',
      sequence: 3,
    };
    expect([user, control, assistant].map(conversationItemStartsTurn)).toEqual([true, true, false]);
  });
});
