import type { PiClient } from "../pi/PiClient.js";

export type InterruptionIntent = "non_substantive" | "continue_previous" | "new_request" | "correction" | "topic_change" | "stop_previous";
export type InterruptionConfidence = "low" | "medium" | "high";
export interface InterruptionIntentDecision {
  action: "resume" | "accept";
  intent: InterruptionIntent;
  confidence: InterruptionConfidence;
  reason: string;
}
export interface InterruptionIntentInput {
  interruptedResponseText: string;
  deliveredSampleOffset: number;
  generatedSamples: number;
  transcript: string;
  boundedContext: string;
}
export interface InterruptionIntentClassifier {
  decide(input: InterruptionIntentInput, signal: AbortSignal): Promise<InterruptionIntentDecision>;
}

const intents = new Set<InterruptionIntent>(["non_substantive", "continue_previous", "new_request", "correction", "topic_change", "stop_previous"]);
const confidences = new Set<InterruptionConfidence>(["low", "medium", "high"]);
export function parseInterruptionDecision(value: string): InterruptionIntentDecision | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "action,confidence,intent,reason") return;
  if ((record.action !== "resume" && record.action !== "accept") || !intents.has(record.intent as InterruptionIntent) || !confidences.has(record.confidence as InterruptionConfidence) || typeof record.reason !== "string" || record.reason.length < 1 || record.reason.length > 120) return;
  if (record.action === "resume" && !["non_substantive", "continue_previous"].includes(String(record.intent))) return;
  if (record.action === "accept" && !["new_request", "correction", "topic_change", "stop_previous"].includes(String(record.intent))) return;
  return record as unknown as InterruptionIntentDecision;
}

export class PiInterruptionIntentClassifier implements InterruptionIntentClassifier {
  constructor(private readonly pi: PiClient) {}
  async decide(input: InterruptionIntentInput, signal: AbortSignal): Promise<InterruptionIntentDecision> {
    const instruction = [
      "Classify whether this speech takes over a paused answer. Return ONLY compact JSON with exactly action,intent,confidence,reason.",
      "action is resume or accept. intent is non_substantive,continue_previous,new_request,correction,topic_change,stop_previous.",
      "Use resume for fragments, acknowledgements, uncertainty, noise, or requests to carry on. Use accept only for a clear new request, correction, topic change, or stop. Bias ambiguous cases to resume.",
      `Paused answer: ${input.interruptedResponseText.slice(0, 1000)}`,
      `Transcript: ${input.transcript.slice(0, 1000)}`,
    ].join("\n");
    let final: string | undefined;
    let duplicate = false;
    for await (const event of this.pi.request({ posture: "question", transcript: instruction, boundedContext: input.boundedContext.slice(0, 2000), personaInterpretation: "{}", maxWords: 45 }, signal)) {
      if (event.type === "error") throw new Error(event.detail);
      if (event.type === "final") { if (final !== undefined) duplicate = true; else final = event.text; }
    }
    const decision = !duplicate && final ? parseInterruptionDecision(final) : undefined;
    if (!decision) throw new Error("invalid interruption decision");
    return decision;
  }
}

export function hasLexicalContent(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value.normalize("NFKC"));
}

export function fallbackInterruptionDecision(value: string): InterruptionIntentDecision {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const words = normalized.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
  if (words.length === 0) return { action: "resume", intent: "non_substantive", confidence: "high", reason: "No lexical speech." };
  if (/\b(?:continue|carry on|go on|keep going|finish (?:that|your thought))\b/iu.test(normalized)) {
    return { action: "resume", intent: "continue_previous", confidence: "high", reason: "Explicit request to continue." };
  }
  if (/\b(?:stop|wait|hold on|hold off|pause|actually|instead)\b/iu.test(normalized)) {
    return { action: "accept", intent: "stop_previous", confidence: "medium", reason: "Clear takeover cue." };
  }
  const filler = new Set(["ah", "er", "hmm", "hm", "like", "okay", "ok", "uh", "um", "yeah", "yep"]);
  if (words.length <= 2 && words.every(word => filler.has(word.toLocaleLowerCase()))) {
    return { action: "resume", intent: "non_substantive", confidence: "high", reason: "Only a brief filler or acknowledgement." };
  }
  if (/\?/u.test(normalized) || /\b(?:(?:can|could|would|will) you|what|why|how|tell me|explain|let(?:'s| us))\b/iu.test(normalized)) {
    return { action: "accept", intent: "new_request", confidence: "medium", reason: "Explicit question or request." };
  }
  return { action: "resume", intent: "non_substantive", confidence: "low", reason: "Ambiguous speech resumes by default." };
}
