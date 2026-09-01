#!/usr/bin/env node
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { stopDetachedProcessGroup, type ProcessGroupCleanup } from "./process-group.js";

const PI_PATH = "/home/soleone/.local/share/pnpm/bin/pi";
const PI_VERSION = "0.84.0";
const MODEL = "openai-codex/gpt-5.6-sol";
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const STARTUP_TIMEOUT_MS = 8_000;
const RUN_TIMEOUT_MS = 60_000;
const MAX_ASSISTANT_TEXT_BYTES = 1024;
const EXACT_MARKER = "RPC_READY";
const FIXTURE_DIR = resolve("spikes/pi-rpc/fixtures");

type JsonScalar = string | number | boolean | null;
type JsonValue = JsonScalar | JsonValue[] | Json;
type Json = { [key: string]: JsonValue };

function jsonObject(value: JsonValue | undefined): Json | undefined {
  return value !== null && value !== undefined && !Array.isArray(value) && Object(value) === value ? value : undefined;
}

function jsonArray(value: JsonValue | undefined): Json[] | undefined {
  return Array.isArray(value) && value.every((item) => jsonObject(item) !== undefined) ? value : undefined;
}
type Readiness = "ready" | "login_required" | "unavailable" | "incompatible" | "rate_limited";

function safeEnvironment(): NodeJS.ProcessEnv {
  // Deliberately allowlist operational variables. Credential/token variables are never read.
  const names = ["HOME", "PATH", "LANG", "LC_ALL", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"] as const;
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name];
  env.PI_SKIP_VERSION_CHECK = "1";
  env.PI_TELEMETRY = "0";
  return env;
}

function redact(value: string): string {
  return value
    .replace(/(["']?(?:authorization|bearer|oauth|api[_-]?key|access[_-]?token|refresh[_-]?token|cookie)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi, "$1<redacted>")
    .replace(/(bearer\s+)[^\s,;]+/gi, "$1<redacted>")
    .replace(/([?&](?:code|key|secret|token)=)[^&\s]+/gi, "$1<redacted>")
    .replace(/\b[A-Za-z0-9_\-]{48,}\b/g, "<opaque-redacted>");
}

function classify(message: string): Readiness {
  const text = message.toLowerCase();
  if (/429|rate.?limit|quota|too many requests/.test(text)) return "rate_limited";
  if (/login|sign.?in|authenticat|unauthorized|forbidden|credential/.test(text)) return "login_required";
  if (/version|protocol|unsupported|unknown option|model not found/.test(text)) return "incompatible";
  return "unavailable";
}

async function runCapture(file: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { shell: false, env: safeEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`process timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < 4096) stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => { clearTimeout(timer); resolvePromise({ stdout, stderr: redact(stderr), code }); });
  });
}

async function validateExecutable(): Promise<string> {
  const lst = lstatSync(PI_PATH);
  if (!lst.isFile()) throw new Error("pinned Pi path is not a regular file");
  const canonical = realpathSync(PI_PATH);
  if (canonical !== PI_PATH) throw new Error(`pinned Pi path is not canonical: ${canonical}`);
  if (!statSync(canonical).isFile()) throw new Error("canonical Pi path is not a regular file");
  accessSync(canonical, constants.X_OK);
  const result = await runCapture(canonical, ["--version"], STARTUP_TIMEOUT_MS);
  const actual = result.stdout.trim();
  if (result.code !== 0 || actual !== PI_VERSION) throw new Error(`incompatible Pi executable (expected ${PI_VERSION}, got ${redact(actual) || "no version"})`);
  return canonical;
}

class RpcProbe {
  readonly child: ChildProcessWithoutNullStreams;
  readonly records: Json[] = [];
  private pending = new Map<string, { resolve: (value: Json) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private listeners = new Set<() => void>();
  private stdoutBuffer = Buffer.alloc(0);
  private stderr = "";
  private sequence = 0;
  private exited = false;
  cancellationCutoff = false;
  suppressedAfterCutoff = 0;
  assistantText = "";
  assistantTextBytes = 0;
  assistantTextExceeded = false;

  constructor(file: string) {
    const args = [
      "--mode", "rpc", "--no-session", "--no-tools", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-context-files", "--no-approve", "--model", MODEL,
    ];
    this.child = spawn(file, args, {
      shell: false,
      detached: process.platform !== "win32",
      env: safeEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      if (this.stderr.length < MAX_STDERR_BYTES) this.stderr += chunk.toString("utf8", 0, MAX_STDERR_BYTES - this.stderr.length);
    });
    this.child.once("exit", () => {
      this.exited = true;
      const error = new Error(`Pi child exited; stderr=${redact(this.stderr) || "<empty>"}`);
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
      this.pending.clear();
      this.notify();
    });
    this.child.once("error", (error) => {
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
      this.pending.clear();
    });
  }

  private consume(chunk: Buffer): void {
    if (chunk.length > MAX_BUFFER_BYTES || this.stdoutBuffer.length + chunk.length > MAX_BUFFER_BYTES) {
      this.failProtocol(new Error("RPC stdout buffer exceeded bound"));
      return;
    }
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    while (true) {
      const lf = this.stdoutBuffer.indexOf(0x0a);
      if (lf < 0) break;
      const record = this.stdoutBuffer.subarray(0, lf);
      this.stdoutBuffer = this.stdoutBuffer.subarray(lf + 1);
      if (record.length === 0) continue;
      if (record[record.length - 1] === 0x0d) {
        this.failProtocol(new Error("RPC requires strict LF framing"));
        return;
      }
      if (record.length > MAX_RECORD_BYTES) {
        this.failProtocol(new Error("RPC record exceeded bound"));
        return;
      }
      let value: Json;
      try {
        const parsed: JsonValue = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(record));
        const message = jsonObject(parsed);
        if (!message) throw new Error('RPC record must be an object');
        value = message;
      }
      catch {
        this.failProtocol(new Error("Pi emitted malformed JSONL"));
        return;
      }
      this.handle(value);
    }
  }

  private failProtocol(error: Error): void {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    this.child.kill("SIGKILL");
  }

  private handle(value: Json): void {
    if (value.type === "response" && String(value.id) === value.id) {
      const item = this.pending.get(value.id);
      if (item) {
        clearTimeout(item.timer);
        this.pending.delete(value.id);
        if (value.success === false) item.reject(new Error(redact(String(value.error ?? "RPC command failed"))));
        else item.resolve(value);
      }
    }
    if (value.type === "message_update" && !this.cancellationCutoff) {
      const update = jsonObject(value.assistantMessageEvent);
      if (update?.type === "text_delta" && String(update.delta) === update.delta) {
        this.assistantTextBytes += Buffer.byteLength(update.delta, "utf8");
        if (this.assistantTextBytes > MAX_ASSISTANT_TEXT_BYTES) this.assistantTextExceeded = true;
        else this.assistantText += update.delta;
      }
    }
    const event = sanitizeEvent(value, this.cancellationCutoff);
    if (event.suppressed) this.suppressedAfterCutoff++;
    else if (event.value) this.records.push(event.value);
    this.notify();
  }

  send(type: string, fields: Json = {}, timeoutMs = STARTUP_TIMEOUT_MS): Promise<Json> {
    if (this.exited) return Promise.reject(new Error("Pi child is not running"));
    const id = `cmd-${++this.sequence}`;
    const command = { id, type, ...fields };
    const encoded = Buffer.from(`${JSON.stringify(command)}\n`, "utf8");
    if (encoded.length > MAX_RECORD_BYTES) return Promise.reject(new Error("RPC command exceeded bound"));
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${type} response timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.child.stdin.write(encoded, (error) => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
    });
  }

  async waitFor(predicate: (record: Json) => boolean, timeoutMs = RUN_TIMEOUT_MS): Promise<Json> {
    const existing = this.records.find(predicate);
    if (existing) return existing;
    return await new Promise((resolvePromise, reject) => {
      const check = () => {
        const match = this.records.find(predicate);
        if (match) { cleanup(); resolvePromise(match); }
        else if (this.exited) { cleanup(); reject(new Error("Pi child exited before expected event")); }
      };
      const cleanup = () => { clearTimeout(timer); this.listeners.delete(check); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("RPC event timed out")); }, timeoutMs);
      this.listeners.add(check);
    });
  }

  private notify(): void { for (const listener of [...this.listeners]) listener(); }

  async stop(): Promise<ProcessGroupCleanup> {
    return stopDetachedProcessGroup(this.child, () => this.exited);
  }
}

function sanitizeEvent(value: Json, cutoff: boolean) {
  if (value.type === "response") return { value: { type: "response", id: value.id, command: value.command, success: value.success } };
  if (value.type === "message_update") {
    const update = jsonObject(value.assistantMessageEvent);
    if (!update) return { value: { type: "message_update", updateStatus: "missing_update" } };
    if (update.type === "text_delta") {
      if (cutoff) return { suppressed: true };
      return { value: { type: "message_update", updateType: "text_delta", contentIndex: update.contentIndex, text: "<model-text>", chars: String(update.delta ?? "").length } };
    }
    // Thinking and tool-call content is intentionally neither copied nor logged.
    return { value: { type: "message_update", updateType: update.type, contentIndex: update.contentIndex } };
  }
  if (value.type === "message_end" || value.type === "turn_end") {
    const message = jsonObject(value.message);
    return { value: { type: value.type, role: message?.role, stopReason: message?.stopReason, hasError: Boolean(message?.errorMessage) } };
  }
  if (value.type === "agent_end") return { value: { type: "agent_end", willRetry: value.willRetry } };
  return { value: { type: String(value.type ?? "unknown") } };
}

function fixture(name: string, body: Json): void {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(resolve(FIXTURE_DIR, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o644 });
}

function modelSummary(response: Json) {
  const data = jsonObject(response.data);
  const model = data && jsonObject(data.model);
  return { provider: model?.provider, id: model?.id, available: Boolean(model) };
}

async function execute(mode: string): Promise<void> {
  const executable = await validateExecutable();
  const rpc = new RpcProbe(executable);
  let cleanup: ProcessGroupCleanup = { exited: false, groupSignalUsed: false, groupGone: false };
  try {
    const state = await rpc.send("get_state");
    const models = await rpc.send("get_available_models");
    const selected = modelSummary(state);
    const modelData = jsonObject(models.data);
    const modelList = jsonArray(modelData?.models) ?? [];
    const selectedListed = modelList.some((item) => item.provider === "openai-codex" && item.id === "gpt-5.6-sol");
    if (!selected.available || selected.provider !== "openai-codex" || selected.id !== "gpt-5.6-sol" || !selectedListed) {
      throw new Error("selected pinned model is unavailable or incompatible");
    }

    if (mode === "probe") {
      const settled = rpc.waitFor((record) => record.type === "agent_settled");
      await rpc.send("prompt", { message: `Reply with exactly ${EXACT_MARKER} and no other text.` }, RUN_TIMEOUT_MS);
      await settled;
      const end = rpc.records.find((record) => record.type === "message_end" && record.role === "assistant");
      if (end?.stopReason !== "stop" || end.hasError) throw new Error("provider did not complete normally");
      if (rpc.assistantTextExceeded || rpc.assistantText !== EXACT_MARKER) throw new Error("provider probe response was incompatible");
      cleanup = await rpc.stop();
      const result = {
        command: "probe", executable, version: PI_VERSION, protocol: "strict LF-delimited JSONL with fatal UTF-8", model: MODEL,
        readiness: "ready", authReadiness: "bounded live request completed normally",
        correlatedCommands: ["get_state", "get_available_models", "prompt"], childCleanup: cleanup,
        records: rpc.records,
      };
      fixture("probe", result);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (mode === "request") {
      const settled = rpc.waitFor((record) => record.type === "agent_settled");
      await rpc.send("prompt", { message: `Reply with exactly ${EXACT_MARKER} and no other text.` });
      await settled;
      const end = rpc.records.find((record) => record.type === "message_end" && record.role === "assistant");
      if (end?.stopReason !== "stop" || end.hasError) throw new Error("request did not stop normally");
      if (rpc.assistantTextExceeded || rpc.assistantText !== EXACT_MARKER) throw new Error("provider request response was incompatible");
      cleanup = await rpc.stop();
      const result = { command: "request", readiness: "ready", boundedPrompt: true, toolsDisabled: true, childCleanup: cleanup, records: rpc.records };
      fixture("request", result);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (mode === "cancel") {
      const firstDelta = rpc.waitFor((record) => record.type === "message_update" && record.updateType === "text_delta");
      await rpc.send("prompt", { message: "Write the integers from 1 through 200, one per line, with no other text." });
      await firstDelta;
      rpc.cancellationCutoff = true;
      const abortResponse = await rpc.send("abort");
      await rpc.waitFor((record) => record.type === "agent_settled");
      const finalState = await rpc.send("get_state");
      const end = rpc.records.find((record) => record.type === "message_end" && record.role === "assistant");
      const stateData = jsonObject(finalState.data);
      if (abortResponse.success !== true || end?.stopReason !== "aborted" || stateData?.isStreaming !== false) {
        throw new Error("abort was not confirmed by response, aborted message, and settled non-streaming state");
      }
      cleanup = await rpc.stop();
      const result = {
        command: "cancel", readiness: "ready", cancellationCutoff: "first text delta", abortResponse: "success",
        authoritativeStopReason: end.stopReason, authoritativeSettled: true, finalIsStreaming: stateData.isStreaming,
        acceptedTextAfterCutoff: 0, suppressedTextDeltasAfterCutoff: rpc.suppressedAfterCutoff,
        childCleanup: cleanup, records: rpc.records,
      };
      fixture("cancel", result);
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    throw new Error("usage: probe.ts <probe|request|cancel>");
  } catch (error) {
    cleanup = await rpc.stop().catch(() => cleanup);
    const readiness = classify(error instanceof Error ? error.message : String(error));
    const detail = readiness === "login_required" ? "Pi sign-in is required." : readiness === "rate_limited" ? "Pi provider is rate limited." : readiness === "incompatible" ? "The pinned Pi executable, protocol, or model is incompatible." : "Pi is unavailable.";
    console.error(JSON.stringify({ command: mode, readiness, detail, correctiveAction: readiness === "login_required" ? "Run Pi's supported interactive sign-in flow, then retry." : readiness === "rate_limited" ? "Wait and retry." : "Retry or inspect the installed Pi/model configuration.", childCleanup: cleanup }, null, 2));
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "";
  if (!new Set(["probe", "request", "cancel"]).has(mode)) {
    console.error("usage: pnpm tsx spikes/pi-rpc/probe.ts <probe|request|cancel>");
    process.exitCode = 2;
  } else {
    await execute(mode);
  }
}

void main().catch(() => {
  console.error(JSON.stringify({ readiness: "unavailable", detail: "Pi is unavailable.", correctiveAction: "Retry or inspect the installed Pi/model configuration." }, null, 2));
  process.exitCode = 1;
});
