/**
 * ResearchPartAssembler accumulates research-client text deltas for a body
 * response and deterministically splits the canonical text into ordered parts
 * (body indices 1-7) under word/character/sentence limits. It withholds the
 * incomplete trailing sentence and releases only sentence-complete parts.
 *
 * Design invariants:
 * - Raw deltas are append-only and must exactly equal the research final text.
 * - Canonical whitespace is applied incrementally without revising emitted parts.
 * - Sentence segmentation uses Intl.Segmenter with next-sentence confirmation.
 * - A single sentence exceeding the per-part word limit is invalid rather than
 *   split mid-sentence.
 * - Parts are released in ascending index order; the orchestrator starts TTS for
 *   a part as soon as it is released (prefetch) but playback order is the cursor.
 */
export interface PartChunk {
  /** Canonical text of this completed part. Never empty or whitespace-only. */
  text: string;
  /** Zero-based body part index within the response (starts at 1). */
  partIndex: number;
}

export type ResearchPartPosture = "riff" | "question" | "challenge";

export interface ResearchPartLimits {
  maxPartWords: number;
  maxPartChars: number;
  maxPartSentences: number;
  maxParts: number;
}

// Short riffs and questions should stay quick; a respectful challenge earns a
// deeper 2-3-part answer without permitting a rambling research monologue.
export const RESEARCH_PART_LIMITS: Readonly<Record<ResearchPartPosture, ResearchPartLimits>> = {
  riff: { maxPartWords: 90, maxPartChars: 4_096, maxPartSentences: 3, maxParts: 7 },
  question: { maxPartWords: 90, maxPartChars: 4_096, maxPartSentences: 3, maxParts: 7 },
  challenge: { maxPartWords: 120, maxPartChars: 4_096, maxPartSentences: 3, maxParts: 7 },
};

export interface ResearchAssemblerResult {
  /** Exact concatenation of all delta texts. */
  raw: string;
  /** Canonicalized full body text. */
  canonical: string;
  /** Every released part in index order. */
  parts: PartChunk[];
}

export function researchPartLimits(posture: ResearchPartPosture): ResearchPartLimits {
  return RESEARCH_PART_LIMITS[posture];
}

export class ResearchPartAssembler {
  private raw = "";
  private processed = 0;
  private pendingSentences: string[] = [];
  private currentPart: string[] = [];
  private parts: PartChunk[] = [];
  private segmenter: Intl.Segmenter;

  constructor(
    private readonly maxPartWords = 90,
    private readonly maxPartChars = 4096,
    private readonly maxPartSentences = 3,
    private readonly maxParts = 7,
  ) {
    this.segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  }

  private segments(): Intl.SegmentData[] {
    return [...this.segmenter.segment(this.canonicalize(this.raw))];
  }

  append(delta: string): PartChunk[] {
    this.raw += delta;
    const segments = this.segments();
    const end = Math.max(0, segments.length - 1);
    for (let index = this.processed; index < end; index++) this.addSentence(segments[index]!.segment);
    return this.flushComplete();
  }

  final(finalText: string): { parts: PartChunk[]; result: ResearchAssemblerResult } {
    if (finalText !== this.raw) throw new MismatchedFinalError(finalText, this.raw);
    const segments = this.segments();
    for (let index = this.processed; index < segments.length; index++) this.addSentence(segments[index]!.segment);
    const released = [...this.flushComplete()];
    if (this.currentPart.length) released.push(this.emitPart());
    const result: ResearchAssemblerResult = { raw: this.raw, canonical: this.canonicalize(this.raw), parts: [...this.parts] };
    return { parts: released, result };
  }

  private addSentence(segmentText: string): void {
    const text = segmentText.trim().replace(/\s+/gu, " ");
    this.processed++;
    if (text.length === 0) return;
    this.pendingSentences.push(text);
    if (this.pendingSentences.length > 1000) throw new InvalidPartError("research body exceeded sentence bound");
  }

  private flushComplete(): PartChunk[] {
    const released: PartChunk[] = [];
    while (this.pendingSentences.length > 0) {
      const sentence = this.pendingSentences[0]!;
      if (this.currentPart.length === 0) {
        if (this.wordCount(sentence) > this.maxPartWords || this.charCount(sentence) > this.maxPartChars) throw new InvalidPartError("a single research sentence exceeds the part limits");
        this.currentPart.push(sentence);
        this.pendingSentences.shift();
        if (this.currentPart.length >= this.maxPartSentences) { released.push(this.emitPart()); }
        continue;
      }
      const candidate = [...this.currentPart, sentence];
      if (this.wordCount(candidate) <= this.maxPartWords && this.charCount(candidate) <= this.maxPartChars) {
        this.currentPart.push(sentence);
        this.pendingSentences.shift();
        if (this.currentPart.length >= this.maxPartSentences) { released.push(this.emitPart()); }
        continue;
      }
      released.push(this.emitPart());
    }
    return released;
  }

  private emitPart(): PartChunk {
    if (this.currentPart.length === 0) throw new InvalidPartError("cannot emit an empty part");
    const nextIndex = this.parts.length + 1;
    if (nextIndex > this.maxParts) throw new InvalidPartError("research body exceeds the part count bound");
    const text = this.currentPart.join(" ").trim();
    this.currentPart = [];
    const chunk: PartChunk = { text, partIndex: nextIndex };
    this.parts.push(chunk);
    return chunk;
  }

  private canonicalize(text: string): string {
    return text.trim().replace(/\s+/gu, " ");
  }
  private wordCount(text: string | string[]): number {
    const joined = Array.isArray(text) ? text.join(" ") : text;
    return joined.split(/\s+/u).filter(Boolean).length;
  }
  private charCount(text: string | string[]): number {
    return (Array.isArray(text) ? text.join(" ") : text).length;
  }
}

export class MismatchedFinalError extends Error {
  constructor(
    readonly finalText: string,
    readonly accumulatedDeltas: string,
  ) {
    super("Pi research final text does not match accumulated deltas");
  }
}

export class InvalidPartError extends Error {
  constructor(message: string) {
    super(message);
  }
}