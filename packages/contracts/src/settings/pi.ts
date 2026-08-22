/** Pi model controls exposed by the Podcaster settings UI. */
export const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

export const DEFAULT_PI_MODEL = 'openai-codex/gpt-5.6-sol';
export const MAX_PI_MODEL_BYTES = 256;
export const DEFAULT_PI_THINKING_LEVEL: PiThinkingLevel = 'medium';

export interface PiSettings {
  /** Pi's provider/model identifier, for example openai-codex/gpt-5.6-sol. */
  model: string;
  thinkingLevel: PiThinkingLevel;
}

export const DEFAULT_PI_SETTINGS: PiSettings = Object.freeze({
  model: DEFAULT_PI_MODEL,
  thinkingLevel: DEFAULT_PI_THINKING_LEVEL,
});
