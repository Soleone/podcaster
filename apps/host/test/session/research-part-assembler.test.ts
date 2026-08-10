import { describe, expect, it } from "vitest";
import { InvalidPartError, ResearchPartAssembler } from "../../src/session/ResearchPartAssembler.js";

function assembleAppendThenFinal(deltas: string[], options?: { maxPartWords?: number; maxPartSentences?: number; maxParts?: number }) {
  const assembler = new ResearchPartAssembler(options?.maxPartWords, 4096, options?.maxPartSentences, options?.maxParts);
  let released: string[] = [];
  for (const delta of deltas) released.push(...assembler.append(delta).map(part => part.text));
  const finalized = assembler.final(deltas.join(""));
  return { released, final: finalized.result };
}

describe("ResearchPartAssembler", () => {
  it("releases incomplete trailing sentences only on final", () => {
    const { released, final } = assembleAppendThenFinal(["This is the first sentence. This is the second sen"]);
    expect(released).toEqual([]);
    expect(final.parts.map(part => part.text)).toEqual(["This is the first sentence. This is the second sen"]);
  });

  it("splits a body into parts at the word limit", () => {
    const fox = "The quick brown fox jumps over the lazy dog. ";
    const text = fox.repeat(15);
    const { final } = assembleAppendThenFinal([text], { maxPartWords: 30 });
    expect(final.parts.length).toBeGreaterThanOrEqual(2);
    for (const part of final.parts) {
      expect(part.text.split(/\s+/u).filter(Boolean).length).toBeLessThanOrEqual(30);
    }
    expect(final.parts[0]!.partIndex).toBe(1);
    expect(final.parts[1]!.partIndex).toBe(2);
  });

  it("limits parts to three sentences and bounded sentence count", () => {
    const text = "One. Two. Three. Four. Five. ";
    const { final } = assembleAppendThenFinal([text], { maxPartSentences: 3 });
    for (const part of final.parts) {
      const sentences = part.text.split(/[.!?](?:\s|$)/u).filter(Boolean).length;
      expect(sentences).toBeLessThanOrEqual(3);
    }
    expect(final.canonical.trim()).toBe("One. Two. Three. Four. Five.");
    expect(final.parts.map(part => part.partIndex)).toEqual([1, 2]);
  });

  it("rejects a single sentence exceeding the per-part word limit", () => {
    const long = Array.from({ length: 95 }, () => "word").join(" ") + ". ";
    const text = "Intro sentence. " + long;
    const assembler = new ResearchPartAssembler(90, 4096, 3, 7);
    assembler.append(text);
    expect(() => assembler.final(text)).toThrow(InvalidPartError);
  });

  it("rejects more parts than the configured maximum", () => {
    const many = Array.from({ length: 40 }, (_, index) => `${index + 1}.`).join(" ");
    const assembler = new ResearchPartAssembler(90, 4096, 1, 2);
    expect(() => assembler.append(many)).toThrow(InvalidPartError);
  });

  it("rejects a mismatched final", () => {
    const assembler = new ResearchPartAssembler();
    assembler.append("Hello world. ");
    expect(() => assembler.final("different")).toThrow(/does not match/);
  });
});