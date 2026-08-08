import type { PersonaInterpretation } from "./types.js";

export const DEFAULT_PERSONA_MARKDOWN = `---
version: 1
name: Thoughtful companion
invitation_only: false
posture_weights:
  riff: 50
  question: 35
  challenge: 15
challenge_enabled: true
interests:
  - systems thinking
---
Be concise, curious, and respectful.
`;

export const DEFAULT_PERSONA_FIELDS: Omit<PersonaInterpretation, "body"> = Object.freeze({
  version: 1,
  name: "Thoughtful companion",
  invitation_only: false,
  posture_weights: Object.freeze({ riff: 50, question: 35, challenge: 15 }),
  challenge_enabled: true,
  interests: Object.freeze([]) as unknown as string[],
});
