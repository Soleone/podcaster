// Voice preview phrases shared by the host (which picks the randomized sample
// text for POST /api/voice-preview) and the browser (which may want to render
// diagnostics). This module is imported from the browser as well as Node, so it
// must stay free of Node built-ins.

/** How many distinct phrases a single voice preview speaks. */
export const VOICE_PREVIEW_PHRASE_COUNT = 3 as const;

/** Upper bound on one preview phrase, in characters. */
export const VOICE_PREVIEW_MAX_PHRASE_CHARS = 200 as const;

/**
 * Upper bound on the concatenated preview text. Mirrors the sidecar TTS
 * per-response character cap so a preview can never be rejected by the engine.
 */
export const VOICE_PREVIEW_MAX_TEXT_CHARS = 4000 as const;

/**
 * Short, prosodically varied sample sentences for voice previews. They exercise
 * greetings, questions, numbers, and punctuation so a listener can judge a
 * voice beyond monotone reading.
 */
export const VOICE_PREVIEW_PHRASES: readonly string[] = Object.freeze([
  "Hello there! How are you today?",
  "Welcome back. It's good to hear from you.",
  "The quick brown fox jumps over the lazy dog.",
  "Seventy-two percent of the votes were counted by nine thirty.",
  "I was wondering, what made you think of that?",
  "Take a deep breath. We've got time.",
  "Rainy mornings are my favorite time for a long conversation.",
  "Could you say that again, a little slower this time?",
  "Three, two, one. Here we go!",
  "That's a great question. Let me think out loud for a moment.",
]);

function assertPreviewPhrases(phrases: readonly string[]): void {
  if (phrases.length < 1) throw new RangeError("at least one preview phrase is required");
  const total = phrases.reduce((sum, phrase) => sum + phrase.length, 0);
  if (phrases.some(phrase => phrase.length === 0 || phrase.length > VOICE_PREVIEW_MAX_PHRASE_CHARS)) {
    throw new RangeError(`preview phrases must be 1..${VOICE_PREVIEW_MAX_PHRASE_CHARS} characters`);
  }
  if (total > VOICE_PREVIEW_MAX_TEXT_CHARS) {
    throw new RangeError(`preview text exceeds ${VOICE_PREVIEW_MAX_TEXT_CHARS} characters`);
  }
}

/**
 * Picks `count` distinct phrases from the pool in randomized order, ready to be
 * joined into a single preview sentence. Throws when the pool cannot satisfy
 * the requested count.
 */
export function randomVoicePreviewPhrases(count: number = VOICE_PREVIEW_PHRASE_COUNT): string[] {
  if (!Number.isInteger(count) || count < 1 || count > VOICE_PREVIEW_PHRASES.length) {
    throw new RangeError(`cannot pick ${count} distinct phrases from a pool of ${VOICE_PREVIEW_PHRASES.length}`);
  }
  const pool = VOICE_PREVIEW_PHRASES.slice();
  for (let index = pool.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1));
    const holder = pool[index]!;
    pool[index] = pool[swap]!;
    pool[swap] = holder;
  }
  const phrases = pool.slice(0, count);
  assertPreviewPhrases(phrases);
  return phrases;
}

/** Joins preview phrases into the single speakable sentence sent to TTS. */
export function joinPreviewPhrases(phrases: readonly string[]): string {
  assertPreviewPhrases(phrases);
  return phrases.join(" ");
}