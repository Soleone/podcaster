import { createHash } from "node:crypto";
import type { PersonaInterpretation } from "@app/contracts";

export const POLICY_VERSION = "v1.experimental" as const;
export type Posture = "riff" | "question" | "challenge" | "silence";
export type PolicyReasonCode = "empty" | "too_short" | "unfinished" | "invitation_required" | "response_budget_exhausted" | "selected";

export interface PriorPolicyDecision { turnId: string; eligible: boolean; posture: Posture }
export interface PolicyInput {
  policyVersion: typeof POLICY_VERSION;
  personaDigest: string;
  persona: PersonaInterpretation;
  sessionSeed: string;
  turnId: string;
  transcript: string;
  endpointComplete: boolean;
  stableUserTurnCount: number;
  recentDecisions: readonly PriorPolicyDecision[];
  eligibleTurnsSinceChallenge: number;
}
export interface PolicyDecision {
  policyVersion: typeof POLICY_VERSION;
  eligible: boolean;
  posture: Posture;
  reasonCodes: readonly PolicyReasonCode[];
  inputDigest: string;
}

export function normalizeTranscript(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function lexicalWords(value: string): string[] {
  return value.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
}

function explicitInvitation(value: string): boolean {
  return /\b(?:what do you think|what['’]s your take|what is your take|any thoughts|can you|could you|would you|do you agree|please (?:respond|tell me))\b/iu.test(value);
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

export function decide(input: PolicyInput): PolicyDecision {
  if (input.policyVersion !== POLICY_VERSION) throw new Error("unsupported policy version");
  const transcript = normalizeTranscript(input.transcript);
  const normalized = {
    ...input,
    transcript,
    persona: {
      ...input.persona,
      body: input.persona.body.normalize("NFKC").replace(/\r\n?/gu, "\n"),
      interests: [...input.persona.interests],
      posture_weights: { ...input.persona.posture_weights },
    },
    recentDecisions: input.recentDecisions.map(item => ({ ...item })),
  };
  const inputDigest = digest(canonicalize(normalized));
  const silence = (reason: PolicyReasonCode, eligible = false): PolicyDecision => ({ policyVersion: POLICY_VERSION, eligible, posture: "silence", reasonCodes: [reason], inputDigest });
  if (!transcript) return silence("empty");
  if (!input.endpointComplete) return silence("unfinished");
  const invited = explicitInvitation(transcript);
  if (lexicalWords(transcript).length < 4 && !invited) return silence("too_short");
  if (input.persona.invitation_only && !invited) return silence("invitation_required");

  const challengeAllowed = input.persona.challenge_enabled && input.stableUserTurnCount >= 2 && input.eligibleTurnsSinceChallenge >= 3;
  const weighted: Array<{ posture: Exclude<Posture, "silence">; weight: number }> = [
    { posture: "riff", weight: input.persona.posture_weights.riff },
    { posture: "question", weight: input.persona.posture_weights.question },
  ];
  if (challengeAllowed) weighted.push({ posture: "challenge", weight: input.persona.posture_weights.challenge });
  const choices = weighted.filter(choice => choice.weight > 0);
  if (!choices.length) return silence("response_budget_exhausted", true);
  const total = choices.reduce((sum, choice) => sum + choice.weight, 0);
  const selectionDigest = digest(`${POLICY_VERSION}${input.personaDigest}${input.sessionSeed}${input.turnId}`);
  let bucket = Number(BigInt(`0x${selectionDigest.slice(0, 13)}`) % BigInt(total));
  let selected = choices[choices.length - 1]!.posture;
  for (const choice of choices) {
    if (bucket < choice.weight) { selected = choice.posture; break; }
    bucket -= choice.weight;
  }
  return { policyVersion: POLICY_VERSION, eligible: true, posture: selected, reasonCodes: ["selected"], inputDigest };
}
