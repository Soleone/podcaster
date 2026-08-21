import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

interface ToolDefinition {
  name: string;
  parameters: Record<string, unknown>;
  execute: (toolCallId: string, params: { url: string }, signal: AbortSignal) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
}

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function registeredTool(): Promise<ToolDefinition> {
  const tools: ToolDefinition[] = [];
  const extension = await import(new URL("../../pi-extensions/webfetch.mjs", import.meta.url).href) as { default: (pi: { registerTool(tool: ToolDefinition): void }) => void };
  extension.default({ registerTool(tool) { tools.push(tool); } });
  return tools.find(tool => tool.name === "webfetch")!;
}

describe("research webfetch extension", () => {
  it("registers one bounded tool and returns readable untrusted text", async () => {
    const fetchMock = vi.fn(async () => new Response("<html><head><script>ignore me</script></head><body><h1>Release dates</h1><p>New game on Friday.</p></body></html>", { headers: { "content-type": "text/html" } }));
    vi.stubGlobal("fetch", fetchMock);
    cleanups.push(() => vi.unstubAllGlobals());

    const tool = await registeredTool();
    const result = await tool.execute("call-1", { url: "https://example.test/releases" }, new AbortController().signal);

    expect(tool.parameters).toMatchObject({ type: "object", required: ["url"] });
    expect(fetchMock).toHaveBeenCalledWith(new URL("https://example.test/releases"), expect.objectContaining({ redirect: "follow", signal: expect.any(AbortSignal) }));
    expect(result.content[0]?.text).toContain("[UNTRUSTED WEB CONTENT]");
    expect(result.content[0]?.text).toContain("Release dates\nNew game on Friday.");
    expect(result.content[0]?.text).not.toContain("ignore me");
  });

  it("rejects non-web schemes and oversized responses without shell access", async () => {
    const fetchMock = vi.fn(async () => new Response("x".repeat(256 * 1024 + 1)));
    vi.stubGlobal("fetch", fetchMock);
    cleanups.push(() => vi.unstubAllGlobals());

    const tool = await registeredTool();
    await expect(tool.execute("call-2", { url: "file:///etc/passwd" }, new AbortController().signal)).rejects.toThrow("only permits http and https");
    await expect(tool.execute("call-3", { url: "https://example.test/large" }, new AbortController().signal)).rejects.toThrow("size limit");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const source = await readFile(new URL("../../pi-extensions/webfetch.mjs", import.meta.url), "utf8");
    expect(source).not.toMatch(/child_process|process\.env|\bexec\b/);
  });
});
