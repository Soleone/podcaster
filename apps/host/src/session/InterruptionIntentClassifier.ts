import { createPiClient, type PiClient } from '../pi/PiClient.js';

export type InterruptionIntent =
  | 'non_substantive'
  | 'continue_previous'
  | 'new_request'
  | 'correction'
  | 'topic_change'
  | 'stop_previous';
export type InterruptionConfidence = 'low' | 'medium' | 'high';
export interface InterruptionIntentDecision {
  action: 'resume' | 'accept';
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

const intents = new Set<InterruptionIntent>([
  'non_substantive',
  'continue_previous',
  'new_request',
  'correction',
  'topic_change',
  'stop_previous',
]);
const confidences = new Set<InterruptionConfidence>(['low', 'medium', 'high']);

// A fixed, persona-neutral system prompt for interruption classification so the
// user's editable persona can never steer a control decision. Classifiers must
// emit compact JSON, unlike the spoken-reply podcaster client.
export const CLASSIFIER_SYSTEM_PROMPT = `You are a speech-intent classifier for a voice assistant. Decide whether a piece of user speech takes over a paused assistant answer or should resume it.
Return ONLY compact JSON with exactly these keys and no other text or code-fence: action,intent,confidence,reason.
action is \"resume\" or \"accept\". intent is one of: non_substantive, continue_previous, new_request, correction, topic_change, stop_previous.\nconfidence is one of: low, medium, high.\nUse resume only for fragments, acknowledgements, noise, or explicit requests to carry on. Use accept for a clear new request, correction, topic change, or stop.\nNegation or rejection of the paused answer (no, not, don't, wrong, different, something else, \"not those\") is a correction - accept it even when the speech is disfluent. Bare redirections like \"Fantasy setting\" are topic changes. Bias only genuinely ambiguous speech without a takeover cue to resume.`;
export function parseInterruptionDecision(value: string): InterruptionIntentDecision | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'action,confidence,intent,reason') return;
  if (
    (record.action !== 'resume' && record.action !== 'accept') ||
    !intents.has(record.intent as InterruptionIntent) ||
    !confidences.has(record.confidence as InterruptionConfidence) ||
    typeof record.reason !== 'string' ||
    record.reason.length < 1 ||
    record.reason.length > 120
  )
    return;
  if (record.action === 'resume' && !['non_substantive', 'continue_previous'].includes(String(record.intent))) return;
  if (
    record.action === 'accept' &&
    !['new_request', 'correction', 'topic_change', 'stop_previous'].includes(String(record.intent))
  )
    return;
  return record as unknown as InterruptionIntentDecision;
}

export class PiInterruptionIntentClassifier implements InterruptionIntentClassifier {
  private readonly pi: PiClient;
  constructor(pi?: PiClient) {
    this.pi = pi ?? createPiClient({ systemPrompt: CLASSIFIER_SYSTEM_PROMPT });
  }
  async decide(input: InterruptionIntentInput, signal: AbortSignal): Promise<InterruptionIntentDecision> {
    const instruction = [
      'Classify whether this speech takes over a paused answer.',
      `Paused answer: ${input.interruptedResponseText.slice(0, 1000)}`,
      `Transcript: ${input.transcript.slice(0, 1000)}`,
    ].join('\n');
    let final: string | undefined;
    let duplicate = false;
    for await (const event of this.pi.request(
      {
        posture: 'question',
        transcript: instruction,
        boundedContext: input.boundedContext.slice(0, 2000),
        maxWords: 45,
      },
      signal,
    )) {
      if (event.type === 'error') throw new Error(event.detail);
      if (event.type === 'final') {
        if (final !== undefined) duplicate = true;
        else final = event.text;
      }
    }
    const decision = !duplicate && final ? parseInterruptionDecision(final) : undefined;
    if (!decision) throw new Error('invalid interruption decision');
    return decision;
  }
}

export function hasLexicalContent(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value.normalize('NFKC'));
}

const continueCues = /\b(?:continue|carry on|go on|keep going|finish (?:that|your thought))\b/iu;
const negatedContinueCues = /\b(?:don'?t|do not|never)\s+(?:continue|carry on|go on|keep going)\b/iu;
const acknowledgementCues =
  /\b(?:no (?:problem|worries|thanks|thank you)|(?:don'?t|do not) worry|no no (?:go on|continue|keep going))\b/iu;
const correctionCues =
  /\b(?:no+|nope|nah|not|don'?t|doesn'?t|didn'?t|never|wrong|different|something else|anything else|another|try again)\b/iu;
// Speech that means "keep the paused answer going" when it appears as a lone
// word or opens a phrase: backchannels, acknowledgements, hedges, and short
// answers ("yes", "right", "thanks", "please", "more").
const resumeOpeners = new Set([
  'yes',
  'yeah',
  'yea',
  'yep',
  'yup',
  'right',
  'sure',
  'great',
  'cool',
  'awesome',
  'perfect',
  'nice',
  'wow',
  'aha',
  'okay',
  'ok',
  'okey',
  'fine',
  'good',
  'exactly',
  'absolutely',
  'definitely',
  'indeed',
  'alright',
  'true',
  'fair',
  'thanks',
  'thank',
  'please',
  'more',
  'sorry',
  'pardon',
  'oh',
  'mhm',
  'hm',
  'hmm',
  'uh',
  'umm',
  'uhh',
  'um',
  'mm',
  'mmm',
  'ah',
  'er',
  'like',
  'k',
  'one',
  'got',
  'understood',
]);
// A fragment continuing the user's own interrupted thought starts with a
// discourse connective or evaluative hedge ("and then…", "so the thing…",
// "well…", "very cool"). Such openers keep the paused answer.
const continuationStarters = new Set([
  'and',
  'but',
  'or',
  'so',
  'because',
  'then',
  'also',
  'well',
  'anyway',
  'though',
  'although',
  'if',
  'since',
  'while',
  'whereas',
  'yet',
  'plus',
  'else',
  'basically',
  'besides',
  'very',
  'really',
  'pretty',
  'quite',
  'too',
  'like',
]);
// A lone function word carries no topic ("the…", "it…", "there…").
const loneFunctionWords = new Set([
  'the',
  'a',
  'an',
  'this',
  'that',
  'it',
  'i',
  'you',
  'we',
  'they',
  'he',
  'she',
  'there',
  'here',
  'to',
  'of',
  'for',
  'with',
  'on',
  'at',
  'by',
  'from',
  'in',
]);
// Sentence scaffolding (copula, auxiliaries, common predicates) signals an
// evaluation or explanation about the paused answer rather than a bare topic
// phrase: "that's really interesting", "sounds good", "I think…".
const sentenceScaffolding =
  /\b(?:is|are|was|were|am|be|been|being|'re|'m|have|has|had|do|does|did|will|would|can|could|should|might|may|must|shall|want|need|think|know|mean|say|said|tell|talk|go|going|make|let|see|take|give|happen)\b/iu;
const copulaContraction = /\b(?:that|it|he|she|we|they|there|here|what|who)'s\b/iu;
// Evaluative acknowledgements ("sounds good", "looks fine") and comparison
// continuations ("looks like…") keep the paused answer.
const acknowledgementPhrases =
  /\b(?:sounds|feels|looks|seems) (?:good|great|right|fine|perfect|interesting|fun|cool|nice|amazing)\b/iu;
const continuationPhrases = /\b(?:looks like|sounds like|seems like|feels like)\b/iu;

/**
 * Deterministic detection of a bare content-bearing redirection: short speech
 * that names a topic or thing without sentence scaffolding ("Fantasy setting",
 * "the third chapter", "the other one") and so must take over the paused
 * answer instead of resuming it. Fillers, acknowledgements, noise, explicit
 * continue requests, corrections, and continuation fragments are excluded.
 */
export function isBareRedirection(value: string): boolean {
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  const words = normalized.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
  if (words.length === 0 || words.length > 6) return false;
  if (continueCues.test(normalized)) return false;
  if (acknowledgementCues.test(normalized)) return false;
  if (acknowledgementPhrases.test(normalized) || continuationPhrases.test(normalized)) return false;
  const lower = words.map((word) => word.toLocaleLowerCase());
  if (lower.length === 1 && (loneFunctionWords.has(lower[0]!) || resumeOpeners.has(lower[0]!))) return false;
  if (continuationStarters.has(lower[0]!) || resumeOpeners.has(lower[0]!)) return false;
  if (copulaContraction.test(normalized) || sentenceScaffolding.test(normalized)) return false;
  return true;
}

/**
 * Deterministic detection of speech that rejects or negates the paused answer
 * ("No, I don't mean that…", "No no no not those…", "That's wrong"). Explicit
 * continuation requests and acknowledgements that merely contain negation words
 * ("no problem", "don't worry", "no no, go on") are not corrections; a
 * negated continuation ("don't continue") is a correction.
 */
export function hasCorrectionIntent(value: string): boolean {
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!normalized) return false;
  if (negatedContinueCues.test(normalized)) return true;
  if (continueCues.test(normalized)) return false;
  if (acknowledgementCues.test(normalized)) return false;
  return correctionCues.test(normalized);
}

export function fallbackInterruptionDecision(value: string): InterruptionIntentDecision {
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  const words = normalized.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
  if (words.length === 0)
    return { action: 'resume', intent: 'non_substantive', confidence: 'high', reason: 'No lexical speech.' };
  if (continueCues.test(normalized)) {
    return {
      action: 'resume',
      intent: 'continue_previous',
      confidence: 'high',
      reason: 'Explicit request to continue.',
    };
  }
  if (hasCorrectionIntent(normalized)) {
    return {
      action: 'accept',
      intent: 'correction',
      confidence: 'high',
      reason: 'Rejects or negates the paused answer.',
    };
  }
  if (/\b(?:stop|wait|hold on|hold off|pause|actually|instead)\b/iu.test(normalized)) {
    return { action: 'accept', intent: 'stop_previous', confidence: 'medium', reason: 'Clear takeover cue.' };
  }
  const filler = new Set([
    'ah',
    'er',
    'hmm',
    'hm',
    'like',
    'okay',
    'ok',
    'uh',
    'umm',
    'uhh',
    'um',
    'mm',
    'yeah',
    'yep',
  ]);
  if (words.length <= 2 && words.every((word) => filler.has(word.toLocaleLowerCase()))) {
    return {
      action: 'resume',
      intent: 'non_substantive',
      confidence: 'high',
      reason: 'Only a brief filler or acknowledgement.',
    };
  }
  if (
    /\?/u.test(normalized) ||
    /\b(?:(?:can|could|would|will) you|what|why|how|tell me|explain|let(?:'s| us))\b/iu.test(normalized)
  ) {
    return { action: 'accept', intent: 'new_request', confidence: 'medium', reason: 'Explicit question or request.' };
  }
  if (isBareRedirection(normalized)) {
    return {
      action: 'accept',
      intent: 'topic_change',
      confidence: 'medium',
      reason: 'Bare content-bearing redirection.',
    };
  }
  return {
    action: 'resume',
    intent: 'non_substantive',
    confidence: 'low',
    reason: 'Ambiguous speech resumes by default.',
  };
}
