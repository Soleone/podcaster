import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { StdioPiClient, type PiEvent, type PiRequestInput } from "../../src/pi/PiClient.js";
import { makeFakePi } from "../fixtures/fake-pi.js";

const input: PiRequestInput = { posture: "question", transcript: "What should we test next?", boundedContext: "", personaInterpretation: "Curious", maxWords: 45 };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });
async function setup() {
  const fake = await makeFakePi("slow"); cleanups.push(fake.cleanup);
  return { fake, client: new StdioPiClient({ executable: fake.executable, startupDeadlineMs: 300, requestDeadlineMs: 600 }) };
}
async function collect(client: StdioPiClient, signal: AbortSignal, onEvent?: (event: PiEvent) => void) {
  const found: PiEvent[] = [];
  for await (const event of client.request(input, signal)) { found.push(event); onEvent?.(event); }
  return found;
}

describe("Pi cancellation races", () => {
  it("cancels before the first token and suppresses every late delta", async () => {
    const { client, fake } = await setup();
    const controller = new AbortController();
    controller.abort();
    const iterable = client.request(input, controller.signal);
    expect(iterable[Symbol.asyncIterator]()).toBe(iterable);
    expect(await collect(client, controller.signal)).toEqual([]);
    const log = await readFile(fake.log, "utf8").catch(() => "");
    expect(log).not.toContain('"command":"prompt"');
    expect(log).not.toContain('"command":"abort"');
    await client.shutdown();
  });

  it("establishes the cutoff synchronously when aborted midstream", async () => {
    const { client } = await setup();
    const controller = new AbortController();
    const found = await collect(client, controller.signal, event => {
      if (event.type === "delta") controller.abort();
    });
    expect(found).toEqual([{ type: "delta", text: "Hello" }]);
    await client.shutdown();
  });

  it("does nothing to an already authoritative final", async () => {
    const { client } = await setup();
    const controller = new AbortController();
    const found = await collect(client, controller.signal);
    controller.abort();
    expect(found.at(-1)).toEqual({ type: "final", text: "Hello world" });
    await client.shutdown();
  });

  it("handles simultaneous abort and stop without leaking its owned child", async () => {
    const { client, fake } = await setup();
    const controller = new AbortController();
    const collecting = collect(client, controller.signal);
    let log = "";
    for (let attempt = 0; attempt < 30 && !log; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      log = await readFile(fake.log, "utf8").catch(() => "");
    }
    expect(log).not.toBe("");
    controller.abort();
    await Promise.all([client.shutdown(), collecting]);
    const first = JSON.parse(log.split("\n")[0]!);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(() => process.kill(first.pid, 0)).toThrow();
  });

  it("requires settled before reuse", async () => {
    const { client } = await setup();
    const controller = new AbortController();
    const first = collect(client, controller.signal);
    await new Promise(resolve => setTimeout(resolve, 20));
    const secondPromise = collect(client, new AbortController().signal);
    controller.abort();
    await first;
    const second = await secondPromise;
    expect(second.at(-1)).toMatchObject({ type: "final" });
    await client.shutdown();
  });

  it("persists return while queued behind probe without prompting or deadlocking ownership", async () => {
    const { client, fake } = await setup();
    const probe = client.probe();
    await new Promise(resolve => setTimeout(resolve, 10));
    const iterator = client.request(input, new AbortController().signal)[Symbol.asyncIterator]();
    const next = iterator.next();
    await iterator.return?.();
    expect((await next).done).toBe(true);
    expect(await probe).toMatchObject({ status: "ready" });
    expect(await client.probe()).toMatchObject({ status: "ready" });
    const calls = (await readFile(fake.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(call => call.command === "prompt")).toHaveLength(2);
    expect(calls.some(call => String(call.message).includes(input.transcript))).toBe(false);
    await client.shutdown();
  });

  it("persists throw while queued behind probe without prompting or deadlocking ownership", async () => {
    const { client, fake } = await setup();
    const probe = client.probe();
    await new Promise(resolve => setTimeout(resolve, 10));
    const iterator = client.request(input, new AbortController().signal)[Symbol.asyncIterator]();
    const next = iterator.next();
    const thrown = iterator.throw?.(new Error("consumer stopped"));
    await expect(thrown).rejects.toThrow("consumer stopped");
    await expect(next).rejects.toThrow("consumer stopped");
    expect(await probe).toMatchObject({ status: "ready" });
    expect(await client.probe()).toMatchObject({ status: "ready" });
    const calls = (await readFile(fake.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(call => call.command === "prompt")).toHaveLength(2);
    expect(calls.some(call => String(call.message).includes(input.transcript))).toBe(false);
    await client.shutdown();
  });

  it("consumer return immediately cuts off and cancels remote work", async () => {
    const { client, fake } = await setup();
    const iterator = client.request(input, new AbortController().signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    await iterator.return?.();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(await readFile(fake.log, "utf8")).toContain('"command":"abort"');
    await client.shutdown();
  });
});
