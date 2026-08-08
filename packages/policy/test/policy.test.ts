import { describe, expect, it } from "vitest";
import type { PersonaInterpretation } from "@app/contracts";
import { decide, POLICY_VERSION, type PolicyInput } from "../src/index.js";

const persona: PersonaInterpretation = {
  version: 1,
  name: "Companion",
  invitation_only: false,
  posture_weights: { riff: 50, question: 35, challenge: 15 },
  challenge_enabled: true,
  interests: [],
  body: "Be thoughtful.",
};
function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    policyVersion: POLICY_VERSION,
    personaDigest: "a".repeat(64),
    persona,
    sessionSeed: "seed",
    turnId: "turn-1",
    transcript: "This is a complete thought",
    endpointComplete: true,
    stableUserTurnCount: 3,
    recentDecisions: [],
    eligibleTurnsSinceChallenge: 3,
    interruptionCooldownActive: false,
    ...overrides,
  };
}

describe("deterministic posture policy", () => {
  it("is byte-deterministic for normalized equivalent input", () => {
    const first = decide(input({ transcript: "  This  is a complete thought  " }));
    const second = decide(input({ transcript: "This is a complete thought" }));
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.posture).toMatch(/^(riff|question|challenge)$/u);
  });

  it.each([
    ["empty", { transcript: "" }, "empty"],
    ["short", { transcript: "only three words" }, "too_short"],
    ["unfinished", { endpointComplete: false }, "unfinished"],
    ["cooldown", { interruptionCooldownActive: true }, "interruption_cooldown"],
    ["invitation", { persona: { ...persona, invitation_only: true } }, "invitation_required"],
  ] as const)("silences %s input", (_name, override, reason) => {
    expect(decide(input(override))).toMatchObject({ eligible: false, posture: "silence", reasonCodes: [reason] });
  });

  it("recognizes only clearly addressee-directed invitations", () => {
    const invitationOnly = { ...persona, invitation_only: true };
    for (const transcript of ["Could you share what you think?", "What’s your take on this idea?"]) {
      expect(decide(input({ persona: invitationOnly, transcript })).posture).not.toBe("silence");
    }
    for (const transcript of ["I keep asking myself why?", "They tell me this always happens."]) {
      expect(decide(input({ persona: invitationOnly, transcript }))).toMatchObject({ posture: "silence", reasonCodes: ["invitation_required"] });
    }
  });

  it("enforces two spoken responses in the current five eligible turns", () => {
    const recentDecisions = [
      { turnId: "1", eligible: true, posture: "riff" as const },
      { turnId: "2", eligible: true, posture: "silence" as const },
      { turnId: "3", eligible: true, posture: "question" as const },
    ];
    expect(decide(input({ recentDecisions }))).toMatchObject({ eligible: true, posture: "silence", reasonCodes: ["response_budget_exhausted"] });
    const oldestResponseFallsOut = [
      { turnId: "1", eligible: true, posture: "riff" as const },
      { turnId: "2", eligible: true, posture: "question" as const },
      { turnId: "3", eligible: true, posture: "silence" as const },
      { turnId: "4", eligible: true, posture: "silence" as const },
      { turnId: "5", eligible: true, posture: "silence" as const },
    ];
    expect(decide(input({ recentDecisions: oldestResponseFallsOut })).posture).not.toBe("silence");
  });

  it("never selects challenge until every challenge guard passes", () => {
    for (let index = 0; index < 200; index++) {
      const turnId = `turn-${index}`;
      expect(decide(input({ turnId, stableUserTurnCount: 1 })).posture).not.toBe("challenge");
      expect(decide(input({ turnId, eligibleTurnsSinceChallenge: 2 })).posture).not.toBe("challenge");
      expect(decide(input({ turnId, persona: { ...persona, challenge_enabled: false } })).posture).not.toBe("challenge");
    }
    expect(Array.from({ length: 500 }, (_, index) => decide(input({ turnId: `eligible-${index}` })).posture)).toContain("challenge");
  });

  it("always returns exactly one allowed posture under generated histories", () => {
    let seed = 17;
    for (let index = 0; index < 500; index++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const result = decide(input({ turnId: String(seed), stableUserTurnCount: seed % 10, eligibleTurnsSinceChallenge: seed % 6 }));
      expect(["riff", "question", "challenge", "silence"]).toContain(result.posture);
      expect(typeof result.posture).toBe("string");
      expect(result.inputDigest).toMatch(/^[a-f0-9]{64}$/u);
    }
  });
});
