import { describe, expect, it } from 'vitest';
import { maintainConversationScroll } from './SessionScreen';

describe('conversation scroll retention', () => {
  it('does not let appended messages steal scroll after the user scrolls upward', () => {
    const viewport = { scrollTop: 240, scrollHeight: 1200 };
    maintainConversationScroll(viewport, false);
    expect(viewport.scrollTop).toBe(240);

    maintainConversationScroll(viewport, true);
    expect(viewport.scrollTop).toBe(1200);
  });
});
