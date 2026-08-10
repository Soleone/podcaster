/**
 * ReasoningSpeechAssembler accumulates Pi deltas and releases completed sentences
 * for progressive TTS synthesis while generation is still in progress.
 *
 * Design invariants:
 * - Raw deltas are append-only and must exactly equal the Pi final text.
 * - Canonical whitespace is applied incrementally without revising already-emitted text.
 * - Sentence segmentation uses Intl.Segmenter with next-sentence confirmation,
 *   avoiding abbreviation splits without handwritten lists.
 * - The 45-word limit, forbidden-output prefix, and question posture rules
 *   are enforced before releasing any chunk.
 */
export interface SentenceChunk {
  /** Canonical text of this completed sentence. Never empty or whitespace-only. */
  text: string;
  /** Zero-based sentence index within the response. */
  index: number;
}

export interface AssemblerResult {
  /** Exact concatenation of all delta texts. */
  raw: string;
  /** Canonicalized full text: raw.trim().replace(/\s+/gu, " "). */
  canonical: string;
  /** Every completed sentence chunk that was emitted during generation. */
  chunks: SentenceChunk[];
}

export class ReasoningSpeechAssembler {
  private raw = "";
  private emitted = 0;
  private chunks: SentenceChunk[] = [];
  /** Chunks released by append() only — exactly what callers streamed to TTS. */
  private appendEmitted: SentenceChunk[] = [];
  private segmenter: Intl.Segmenter;
  private _canonicalPrefix = "";

  constructor(private readonly posture: "riff" | "question" | "challenge") {
    this.segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  }

  /** The canonical text accumulated so far. Usable by interruption classifiers. */
  get canonicalPrefix(): string {
    return this._canonicalPrefix;
  }

  /**
   * Append a raw delta from Pi. Returns any newly completed sentence chunks
   * that are safe to synthesize.
   */
  append(delta: string): SentenceChunk[] {
    this.raw += delta;
    const fullCanonical = this.canonicalize(this.raw);

    // Build the full canonical but hold the last segment if it might be incomplete.
    const segments = [...this.segmenter.segment(fullCanonical)];
    if (segments.length === 0) return [];

    const newChunks: SentenceChunk[] = [];

    // Emit all segments except possibly the last one.
    // The last segment is only released when a following segment confirms the boundary,
    // or on final.
    const releaseCount = segments.length > 1 ? segments.length - 1 : 0;

    for (let i = this.emitted; i < releaseCount; i++) {
      const segment = segments[i]!;
      const text = segment.segment.trim().replace(/\s+/gu, " ");
      if (text.length === 0) continue;
      if (!this.isValidChunk(text)) {
        // Invalid text detected: stop emitting and mark as poisoned.
        // The assembler will continue accumulating but won't emit more chunks.
        // The final validation will catch this and reject the response.
        return newChunks;
      }
      this.chunks.push({ text, index: this.emitted });
      this.appendEmitted.push({ text, index: this.emitted });
      newChunks.push({ text, index: this.emitted });
      this.emitted++;
    }

    // Update canonical prefix for interruption classification
    this._canonicalPrefix = this.chunks.map(c => c.text).join(" ") +
      (this.chunks.length > 0 ? " " : "") +
      (segments.length > this.emitted ? segments.slice(this.emitted).map(s => s.segment).join("").trim().replace(/\s+/gu, " ") : "");

    // Trim the prefix
    this._canonicalPrefix = this._canonicalPrefix.trim();

    return newChunks;
  }

  /**
   * Signal Pi generation is complete. Returns the remaining tail chunk (if any)
   * and the full result for validation.
   */
  final(finalText: string): { tail?: SentenceChunk; result: AssemblerResult } {
    // Verify raw delta equality
    if (finalText !== this.raw) {
      throw new MismatchedFinalError(finalText, this.raw);
    }

    const canonical = this.canonicalize(this.raw);
    const segments = [...this.segmenter.segment(canonical)];

    let tail: SentenceChunk | undefined;

    // Emit remaining segments
    for (let i = this.emitted; i < segments.length; i++) {
      const segment = segments[i]!;
      const text = segment.segment.trim().replace(/\s+/gu, " ");
      if (text.length === 0) continue;
      if (!this.isValidChunk(text)) {
        throw new InvalidResponseError(canonical, this.posture);
      }
      const chunk: SentenceChunk = { text, index: this.emitted };
      this.chunks.push(chunk);
      if (i >= this.emitted) {
        tail = chunk;
        this.emitted++;
      }
    }

    this._canonicalPrefix = canonical;

    const result: AssemblerResult = { raw: this.raw, canonical, chunks: [...this.chunks] };
    return tail ? { tail, result } : { result };
  }

  /**
   * Exact text of the chunks released by append() — i.e. precisely what a caller
   * appended to the TTS stream as they were released. Excludes any tail chunk
   * pushed by final() (the caller appends that separately on the success path),
   * so on a fail-soft path where final() never runs this is exactly the text
   * the TTS stream received.
   */
  emittedText(): string {
    return this.appendEmitted.map(chunk => chunk.text).join(" ");
  }

  /**
   * Validate that the given full canonical text equals the concatenation of emitted chunks.
   */
  validateFull(canonical: string): boolean {
    const reconstructed = this.chunks.map(c => c.text).join(" ").trim();
    return canonical === reconstructed;
  }

  private canonicalize(text: string): string {
    return text.trim().replace(/\s+/gu, " ");
  }

  private isValidChunk(text: string): boolean {
    if (text.length === 0) return false;
    // 45-word limit (check on the canonical prefix + this chunk)
    const words = (this.chunks.map(c => c.text).join(" ") + " " + text).trim().split(/\s+/u).filter(Boolean);
    if (words.length > 45) return false;
    // For question posture, restrict to at most one question mark total
    if (this.posture === "question") {
      // This is a progressive guard. The full check happens at final.
      // We're conservative: if we already emitted a question mark or this chunk contains one,
      // we count. But we only check total across all emitted + this new one.
      const totalQuestions = (this.chunks.map(c => c.text).join(" ") + " " + text).match(/\?/gu) ?? [];
      if (totalQuestions.length > 1) return false;
    }
    // Forbidden output prefix check
    if (/^(?:```|\{|\[|assistant\s*:|system\s*:|<\/?(?:script|iframe)\b)/iu.test(text)) return false;
    return true;
  }
}

export class MismatchedFinalError extends Error {
  constructor(
    readonly finalText: string,
    readonly accumulatedDeltas: string,
  ) {
    super("Pi final text does not match accumulated deltas");
  }
}

export class InvalidResponseError extends Error {
  constructor(
    readonly text: string,
    readonly posture: string,
  ) {
    super(`Response text is invalid for posture "${posture}"`);
  }
}
