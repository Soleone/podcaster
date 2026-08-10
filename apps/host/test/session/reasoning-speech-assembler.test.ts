import { describe, expect, it } from "vitest";
import { ReasoningSpeechAssembler } from "../../src/session/ReasoningSpeechAssembler.js";

function sampleSplits(text: string, count: number): string[][] {
  if (text.length <= 1 || count <= 0) return [[text]];
  const results: string[][] = [[text]];
  const chars = [...text];
  for (let i = 0; i < count; i++) {
    const deltas: string[] = [];
    let start = 0;
    for (let j = 0; j < text.length; j++) {
      if (j < text.length - 1 && Math.random() < 0.3) {
        deltas.push(chars.slice(start, j + 1).join(""));
        start = j + 1;
      }
    }
    deltas.push(chars.slice(start).join(""));
    if (deltas.length > 1) results.push(deltas);
  }
  return results;
}

describe("ReasoningSpeechAssembler", () => {
  describe("basic sentence segmentation", () => {
    it("releases first sentence when next boundary confirmed", () => {
      const a = new ReasoningSpeechAssembler("riff");
      const r1 = a.append("First sentence. S");
      // Segmenter: ["First sentence. ", "S"] — first confirmed by "S"
      expect(r1.length).toBe(1);
      expect(r1[0]!.text).toBe("First sentence.");

      // "econd sentence." completes the text but still only 2 segments total
      // Second sentence has no sentence after it yet, so held for final
      const r2 = a.append("econd sentence.");
      expect(r2).toEqual([]);

      const { tail, result } = a.final("First sentence. Second sentence.");
      expect(tail!.text).toBe("Second sentence.");
      expect(result.canonical).toBe("First sentence. Second sentence.");
      expect(result.chunks).toHaveLength(2);
    });

    it("flushes single sentence only on final", () => {
      const a = new ReasoningSpeechAssembler("riff");
      expect(a.append("Just one sentence.")).toEqual([]);
      const { tail, result } = a.final("Just one sentence.");
      expect(tail!.text).toBe("Just one sentence.");
      expect(result.chunks).toHaveLength(1);
    });

    it("emits multiple sentences as boundaries are confirmed", () => {
      const a = new ReasoningSpeechAssembler("riff");
      // Segmenter: ["Hello there. ", "How are you? ", "I"]
      const r1 = a.append("Hello there. How are you? I");
      expect(r1.length).toBe(2);
      expect(r1[0]!.text).toBe("Hello there.");
      expect(r1[1]!.text).toBe("How are you?");

      // " am fine." completes: ["Hello there. ", "How are you? ", "I am fine."]
      // emitted=2, releaseCount=2, nothing new — last held for final
      const r2 = a.append(" am fine.");
      expect(r2).toEqual([]);

      const { tail, result } = a.final("Hello there. How are you? I am fine.");
      expect(tail!.text).toBe("I am fine.");
      expect(result.chunks).toHaveLength(3);
    });

    it("no period final flushes as single sentence", () => {
      const a = new ReasoningSpeechAssembler("riff");
      expect(a.append("No punctuation here")).toEqual([]);
      const { tail, result } = a.final("No punctuation here");
      expect(tail!.text).toBe("No punctuation here");
      expect(result.canonical).toBe("No punctuation here");
    });
  });

  describe("abbreviations, decimals, and initials", () => {
    it("Intl.Segmenter splits on Dr. (known limitation, accepted)", () => {
      const a = new ReasoningSpeechAssembler("riff");
      // Segmenter: ["I saw Dr. ", "Smith yesterday. ", "He"]
      const r1 = a.append("I saw Dr. Smith yesterday. He");
      expect(r1.length).toBe(2);
      expect(r1[0]!.text).toBe("I saw Dr.");
      expect(r1[1]!.text).toBe("Smith yesterday.");

      // Full: ["I saw Dr. ", "Smith yesterday. ", "He was fine."]
      // emitted=2, releaseCount=2, nothing new — last held for final
      const r2 = a.append(" was fine.");
      expect(r2).toEqual([]);

      const { tail, result } = a.final("I saw Dr. Smith yesterday. He was fine.");
      expect(tail!.text).toBe("He was fine.");
      expect(result.chunks).toHaveLength(3);
      expect(result.canonical).toBe("I saw Dr. Smith yesterday. He was fine.");
    });

    it("Intl.Segmenter handles U.S. correctly", () => {
      const a = new ReasoningSpeechAssembler("riff");
      // Segmenter: ["The U.S. is large. ", "Canada"]
      const r1 = a.append("The U.S. is large. Canada");
      expect(r1.length).toBe(1);
      expect(r1[0]!.text).toBe("The U.S. is large.");

      // Full: ["The U.S. is large. ", "Canada is too."] — 2 segments, emitted=1, release=1
      const r2 = a.append(" is too.");
      expect(r2).toEqual([]);

      const { tail, result } = a.final("The U.S. is large. Canada is too.");
      expect(tail!.text).toBe("Canada is too.");
      expect(result.chunks).toHaveLength(2);
    });

    it("does not split on decimal numbers like 3.14", () => {
      const a = new ReasoningSpeechAssembler("riff");
      expect(a.append("Pi is about 3.14 and that is fun.")).toEqual([]);
      const { tail, result } = a.final("Pi is about 3.14 and that is fun.");
      expect(tail!.text).toBe("Pi is about 3.14 and that is fun.");
      expect(result.chunks).toHaveLength(1);
    });
  });

  describe("canonical whitespace", () => {
    it("normalizes whitespace within segments", () => {
      const a = new ReasoningSpeechAssembler("riff");
      // Segmenter: ["Hello   there.   ", "How   are   you? ", "Ok."]
      const r1 = a.append("Hello   there.   How   are   you? Ok.");
      expect(r1.length).toBe(2);
      expect(r1[0]!.text).toBe("Hello there.");
      expect(r1[1]!.text).toBe("How are you?");

      const { tail, result } = a.final("Hello   there.   How   are   you? Ok.");
      expect(tail!.text).toBe("Ok.");
      expect(result.canonical).toBe("Hello there. How are you? Ok.");
    });

    it("normalizes newlines and tabs", () => {
      const a = new ReasoningSpeechAssembler("riff");
      a.append("Line one.\n\nLine\t\ttwo.\n");
      const { result } = a.final("Line one.\n\nLine\t\ttwo.\n");
      expect(result.canonical).toBe("Line one. Line two.");
    });
  });

  describe("punctuation split across deltas", () => {
    it("handles sentence boundary split mid-word", () => {
      const a = new ReasoningSpeechAssembler("riff");
      a.append("That's");
      a.append(" right.");
      a.append(" Now");
      // "That's right. Now" → segments ["That's right. ", "Now"], emits first
      // But we're appending incrementally, let me trace:
      // After "That's" + " right." → segments ["That's right."], 1 seg, release=0
      // After " Now" → segments ["That's right. ", "Now"], 2 seg, release=1, emitted=0 → emit "That's right."
      // After " what?" → segments ["That's right. ", "Now what?"], 2 seg, release=1, emitted=1 → none new
      const r3 = a.append(" what?");
      expect(r3).toEqual([]);

      const { tail, result } = a.final("That's right. Now what?");
      expect(tail!.text).toBe("Now what?");
      expect(result.chunks).toHaveLength(2);
    });

    it("handles word split across deltas", () => {
      const a = new ReasoningSpeechAssembler("riff");
      a.append("He");
      a.append("llo.");
      a.append(" Wo");
      // After "He" + "llo." → segmenter: ["Hello."], 1 seg
      // After " Wo" → segmenter: ["Hello. ", "Wo"], 2 seg, release=1, emit "Hello."
      // After "rld." → segmenter: ["Hello. ", "World."], 2 seg, release=1, emitted=1 → none
      const r3 = a.append("rld.");
      expect(r3).toEqual([]);

      const { tail, result } = a.final("Hello. World.");
      expect(tail!.text).toBe("World.");
      expect(result.chunks).toHaveLength(2);
    });
  });

  describe("emoji and special characters", () => {
    it("handles emoji as segment start", () => {
      const a = new ReasoningSpeechAssembler("riff");
      // Segmenter: ["Great job! ", "🎉 Really"]
      const r1 = a.append("Great job! 🎉 Really");
      expect(r1.length).toBe(1);
      expect(r1[0]!.text).toBe("Great job!");

      // Full: ["Great job! ", "🎉 Really cool."] — 2 seg, emitted=1, release=1
      const r2 = a.append(" cool.");
      expect(r2).toEqual([]);

      const { tail, result } = a.final("Great job! 🎉 Really cool.");
      expect(tail!.text).toBe("🎉 Really cool.");
      expect(result.canonical).toBe("Great job! 🎉 Really cool.");
    });

    it("handles apostrophes and quotes", () => {
      const a = new ReasoningSpeechAssembler("riff");
      // Segmenter: [`He said "I'm happy." `, "She"]
      const r1 = a.append("He said \"I'm happy.\" She");
      expect(r1.length).toBe(1);
      expect(r1[0]!.text).toBe("He said \"I'm happy.\"");

      // Full: 2 seg, emitted=1, release=1
      const r2 = a.append(" agreed.");
      expect(r2).toEqual([]);

      const { tail, result } = a.final("He said \"I'm happy.\" She agreed.");
      expect(tail!.text).toBe("She agreed.");
      expect(result.chunks).toHaveLength(2);
    });

    it("handles brackets", () => {
      const a = new ReasoningSpeechAssembler("riff");
      const r1 = a.append("The result (which was expected) was good. Next");
      expect(r1.length).toBe(1);
      expect(r1[0]!.text).toBe("The result (which was expected) was good.");

      // Full: 2 seg, emitted=1, release=1
      const r2 = a.append(" point.");
      expect(r2).toEqual([]);

      const { tail, result } = a.final("The result (which was expected) was good. Next point.");
      expect(tail!.text).toBe("Next point.");
      expect(result.chunks).toHaveLength(2);
    });
  });

  describe("word limit", () => {
    it("allows exactly 45 words", () => {
      const words = Array.from({ length: 45 }, (_, i) => `word${i}`);
      const text = words.join(" ") + ".";
      const a = new ReasoningSpeechAssembler("riff");
      expect(a.append(text)).toEqual([]);
      const { result } = a.final(text);
      expect(result.chunks).toHaveLength(1);
    });

    it("rejects 46 words at final", () => {
      const words = Array.from({ length: 46 }, (_, i) => `word${i}`);
      const text = words.join(" ") + ".";
      const a = new ReasoningSpeechAssembler("riff");
      expect(a.append(text)).toEqual([]);
      expect(() => a.final(text)).toThrow();
    });

    it("counts the same whitespace-delimited words as the Pi response bound", () => {
      const words = Array.from({ length: 45 }, (_, i) => `multi-part-${i}`);
      const text = words.join(" ") + ".";
      const a = new ReasoningSpeechAssembler("riff");
      a.append(text);
      expect(a.final(text).result.canonical).toBe(text);
    });
  });

  describe("question posture", () => {
    it("allows one question mark in question posture", () => {
      const a = new ReasoningSpeechAssembler("question");
      // Segmenter: ["What is your favorite color? ", "I"]
      const r1 = a.append("What is your favorite color? I");
      expect(r1.length).toBe(1);
      expect(r1[0]!.text).toBe("What is your favorite color?");

      // Full: ["What is your favorite color? ", "I like blue."], 2 seg, emitted=1, release=1
      const r2 = a.append(" like blue.");
      expect(r2).toEqual([]);

      const { tail, result } = a.final("What is your favorite color? I like blue.");
      expect(tail!.text).toBe("I like blue.");
      expect(result.chunks).toHaveLength(2);
    });

    it("blocks second question mark in question posture", () => {
      const a = new ReasoningSpeechAssembler("question");
      const r1 = a.append("What is this? And");
      expect(r1.length).toBe(1);
      expect(r1[0]!.text).toBe("What is this?");

      // Second question mark blocked by progressive guard
      const r2 = a.append(" what about that?");
      expect(r2).toEqual([]);

      expect(() => a.final("What is this? And what about that?")).toThrow();
    });
  });

  describe("forbidden prefix", () => {
    it("blocks code fence prefix", () => {
      const a = new ReasoningSpeechAssembler("riff");
      expect(a.append("```javascript\nconsole.log('hi');\n```")).toEqual([]);
      expect(() => a.final("```javascript\nconsole.log('hi');\n```")).toThrow();
    });

    it("blocks JSON-like prefix", () => {
      const a = new ReasoningSpeechAssembler("riff");
      expect(a.append('{"key": "value"}')).toEqual([]);
      expect(() => a.final('{"key": "value"}')).toThrow();
    });

    it("blocks 'assistant:' prefix", () => {
      const a = new ReasoningSpeechAssembler("riff");
      expect(a.append("assistant: hello there")).toEqual([]);
      expect(() => a.final("assistant: hello there")).toThrow();
    });

    it("blocks forbidden prefix split across deltas", () => {
      const a = new ReasoningSpeechAssembler("riff");
      a.append("```");
      a.append("javascript");
      expect(() => a.final("```javascript")).toThrow();
    });
  });

  describe("emittedText", () => {
    it("returns the joined text of append-emitted chunks only", () => {
      const a = new ReasoningSpeechAssembler("riff");
      expect(a.emittedText()).toBe("");
      const released = a.append("First sentence. Second sentence. Third.");
      expect(released.map(chunk => chunk.text)).toEqual(["First sentence.", "Second sentence."]);
      expect(a.emittedText()).toBe("First sentence. Second sentence.");
      const { tail } = a.final("First sentence. Second sentence. Third.");
      expect(tail!.text).toBe("Third.");
      // final()'s tail is appended to the TTS stream separately by the caller, so
      // emittedText() excludes it: it tracks only what append() released.
      expect(a.emittedText()).toBe("First sentence. Second sentence.");
    });

    it("still returns the streamed prefix after a throwing final", () => {
      const a = new ReasoningSpeechAssembler("riff");
      a.append("I will check that. One moment please.");
      expect(a.emittedText()).toBe("I will check that.");
      expect(() => a.final("Completely different text.")).toThrow();
      expect(a.emittedText()).toBe("I will check that.");
    });
  });

  describe("final validation", () => {
    it("detects mismatched final text", () => {
      const a = new ReasoningSpeechAssembler("riff");
      a.append("Hello world.");
      expect(() => a.final("Different text.")).toThrow();
    });

    it("validates canonical text equals chunk concatenation", () => {
      const a = new ReasoningSpeechAssembler("riff");
      a.append("Hello world. How are you?");
      const { result } = a.final("Hello world. How are you?");
      expect(a.validateFull(result.canonical)).toBe(true);
    });
  });

  describe("property tests: split invariance", () => {
    const testCases = [
      "Hello world. This is a test.",
      "I like pizza. It is tasty. Do you agree?",
      "The quick brown fox. Jumps over. The lazy dog.",
    ];

    for (const text of testCases) {
      it(`split invariance for: "${text}"`, () => {
        const samples = sampleSplits(text, 20);

        for (const deltaSeq of samples) {
          const a = new ReasoningSpeechAssembler("riff");
          const emittedChunks: string[] = [];
          for (const delta of deltaSeq) {
            const chunks = a.append(delta);
            emittedChunks.push(...chunks.map(c => c.text));
          }
          const { result } = a.final(text);

          expect(result.canonical).toBe(text.trim().replace(/\s+/gu, " "));
          expect(a.validateFull(result.canonical)).toBe(true);

          for (const chunk of result.chunks) {
            expect(chunk.text.length).toBeGreaterThan(0);
            expect(chunk.text.trim()).toBe(chunk.text);
          }

          for (const emitted of emittedChunks) {
            expect(result.chunks.some(c => c.text === emitted)).toBe(true);
          }
        }
      });
    }
  });

  describe("canonical prefix for interruption classification", () => {
    it("updates canonical prefix as deltas arrive", () => {
      const a = new ReasoningSpeechAssembler("riff");
      a.append("Hello world. How");
      expect(a.canonicalPrefix).toBe("Hello world. How");

      a.append(" are you? Good.");
      expect(a.canonicalPrefix).toBe("Hello world. How are you? Good.");
    });

    it("canonical prefix equals full canonical after final", () => {
      const a = new ReasoningSpeechAssembler("riff");
      a.append("First. Second. Third.");
      const { result } = a.final("First. Second. Third.");
      expect(a.canonicalPrefix).toBe(result.canonical);
    });
  });

  describe("challenge posture", () => {
    it("works like riff for sentence segmentation", () => {
      const a = new ReasoningSpeechAssembler("challenge");
      // Segmenter: ["That is debatable. ", "Here is why. ", "Because"]
      const r1 = a.append("That is debatable. Here is why. Because");
      expect(r1.length).toBe(2);
      expect(r1[0]!.text).toBe("That is debatable.");
      expect(r1[1]!.text).toBe("Here is why.");

      // Full: 3 seg, emitted=2, release=2 — nothing new
      const r2 = a.append(" reasons.");
      expect(r2).toEqual([]);

      const { tail, result } = a.final("That is debatable. Here is why. Because reasons.");
      expect(tail!.text).toBe("Because reasons.");
      expect(result.chunks).toHaveLength(3);
    });
  });
});
