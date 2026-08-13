import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PI_MODEL, type PiEvent } from "../../src/pi/PiClient.js";
import { StdioPiResearchClient, type PiResearchRequestInput } from "../../src/pi/PiResearchClient.js";
import { makeFakePi, type FakePiScenario } from "../fixtures/fake-pi.js";

const input: PiResearchRequestInput = { posture: "question", transcript: "A stable transcript", boundedContext: "Prior local context", stallText: "Let me look that up.", maxWords: 600 };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });
async function client(scenario: FakePiScenario = "normal", version = "0.84.0") {
  const fake = await makeFakePi(scenario, version); cleanups.push(fake.cleanup);
  return { fake, value: new StdioPiResearchClient({ executable: fake.executable, startupDeadlineMs: 300, requestDeadlineMs: 500 }) };
}
async function events(value: StdioPiResearchClient, signal = new AbortController().signal): Promise<PiEvent[]> {
  const result: PiEvent[] = [];
  for await (const event of value.requestBody(input, signal)) result.push(event);
  return result;
}

describe("production Pi research RPC boundary", () => {
  it("spawns with the read-only research tool allowlist, never the write/shell tools, and no --no-tools", async () => {
    const { value, fake } = await client();
    const iterator = value.requestBody(input, new AbortController().signal);
    await iterator.next();
    await value.shutdown();
    const calls = (await readFile(fake.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const argv = calls[0].argv;
    expect(argv).toContain("--tools");
    expect(argv).toContain("read,grep,find,ls");
    expect(argv).not.toContain("--no-tools");
    expect(argv).not.toContain("write");
    expect(argv).not.toContain("bash");
    expect(argv).not.toContain("edit");
    expect(argv).toContain("--model");
    expect(argv).toContain(PI_MODEL);
  });

  it("exposes only assistant text delta/final and never thinking or tool content", async () => {
    const { value } = await client();
    const result = await events(value);
    expect(result).toEqual([{ type: "delta", text: "Hello" }, { type: "delta", text: " world" }, { type: "final", text: "Hello world" }]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    await value.shutdown();
  });

  it("logs sanitized research tool lifecycle without leaking args or results", async () => {
    const { value } = await client("tools");
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { writes.push(String(chunk)); return true; });
    try {
      const result = await events(value);
      expect(result).toEqual([{ type: "delta", text: "Hello" }, { type: "delta", text: " world" }, { type: "final", text: "Hello world" }]);
    } finally { spy.mockRestore(); }
    const logs = writes.filter(line => line.startsWith("[research]"));
    expect(logs.some(line => line.includes("tool start grep tool-1"))).toBe(true);
    expect(logs.some(line => line.includes("tool end grep tool-1") && line.includes("ok"))).toBe(true);
    const joined = writes.join("\n");
    expect(joined).not.toContain("Metroidvania");
    expect(joined).not.toContain("PRIVATE_CONTENT");
    expect(joined).not.toContain("PRIVATE");
    await value.shutdown();
  });

  it("rejects assistant output beyond the configured research word bound", async () => {
    const fake = await makeFakePi("too-many-words"); cleanups.push(fake.cleanup);
    const value = new StdioPiResearchClient({ executable: fake.executable, startupDeadlineMs: 300, requestDeadlineMs: 500, maxWords: 1 });
    const result: PiEvent[] = [];
    for await (const event of value.requestBody(input, new AbortController().signal)) result.push(event);
    expect(result.at(-1)).toMatchObject({ type: "error", state: "unavailable" });
    await value.shutdown();
  });

  it("fails safely on malformed or crashing child output", async () => {
    for (const scenario of ["malformed", "crash"] as const) {
      const { value } = await client(scenario);
      const result = await events(value);
      expect(result.at(-1)).toMatchObject({ type: "error", state: "unavailable" });
      await value.shutdown();
    }
  });

  it("cancels via abort and never accepts text after the local cutoff", async () => {
    const { value } = await client();
    const controller = new AbortController();
    const iterator = value.requestBody(input, controller.signal);
    const first = await iterator.next();
    expect(first.value.type).toBe("delta");
    controller.abort();
    const rest: PiEvent[] = [];
    for await (const event of iterator) rest.push(event);
    expect(rest.length).toBe(0);
    await value.shutdown();
  });
});