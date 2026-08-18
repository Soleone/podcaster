import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";

import { PI_EXECUTABLE, PI_MODEL, type PiEvent, type PiPosture } from "./PiClient.js";
import type { PiThinkingLevel } from "@app/contracts";
import { PODCASTER_SYSTEM_PROMPT } from "@app/contracts";
import { log } from "../logger.js";

const MAX_RECORD_BYTES = 256 * 1024;
const MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_QUEUE_EVENTS = 128;
const MAX_QUEUE_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const STARTUP_DEADLINE_MS = 8_000;
const REQUEST_DEADLINE_MS = 180_000;
const DEFAULT_MAX_WORDS = 600;

type ObjectValue = Record<string, unknown>;

export interface PiResearchRequestInput {
  posture: PiPosture;
  transcript: string;
  boundedContext: string;
  stallText: string;
  maxWords?: number;
}
export interface PiResearchClient {
  requestBody(input: PiResearchRequestInput, signal: AbortSignal): AsyncIterable<PiEvent>;
  shutdown(): Promise<void>;
}

export interface PiResearchClientOptions { executable?: string; model?: string; thinkingLevel?: PiThinkingLevel; systemPrompt?: string; personaAppend?: string; startupDeadlineMs?: number; requestDeadlineMs?: number; maxWords?: number }

interface Pending { resolve(value: ObjectValue): void; reject(error: Error): void; timer: NodeJS.Timeout }
interface Lifecycle { messageEnded: boolean; stopReason: string | undefined; providerError: string | undefined; settled: boolean; assistantText: string; responseBytes: number; textExceeded: boolean }
interface ActiveRequest extends Lifecycle {
  queue: AsyncQueue<PiEvent>; cutoff: boolean; completed: boolean;
  timer: NodeJS.Timeout; abortListener: () => void; signal: AbortSignal; release: () => void;
}

class AsyncQueue<T> implements AsyncIterableIterator<T> {
  private values: Array<{ value: T; bytes: number }> = [];
  private waiters: Array<{ resolve: (value: IteratorResult<T>) => void; reject: (error: Error) => void }> = [];
  private ended = false;
  private queuedBytes = 0;
  constructor(private readonly onCancel: () => void, private readonly onOverflow: (error: Error) => void) {}
  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) return waiter.resolve({ value, done: false });
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (this.values.length >= MAX_QUEUE_EVENTS || this.queuedBytes + bytes > MAX_QUEUE_BYTES) {
      this.values = []; this.queuedBytes = 0;
      this.onOverflow(new Error("Pi event queue exceeded bound")); return;
    }
    this.values.push({ value, bytes }); this.queuedBytes += bytes;
  }
  end(): void { if (this.ended) return; this.ended = true; for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true }); }
  fail(error: Error): void { if (this.ended) return; this.ended = true; this.values = []; this.queuedBytes = 0; for (const waiter of this.waiters.splice(0)) waiter.reject(error); }
  next(): Promise<IteratorResult<T>> {
    const item = this.values.shift();
    if (item) { this.queuedBytes -= item.bytes; return Promise.resolve({ value: item.value, done: false }); }
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  return(): Promise<IteratorResult<T>> { this.onCancel(); this.end(); return Promise.resolve({ value: undefined, done: true }); }
  throw(error?: unknown): Promise<IteratorResult<T>> { this.onCancel(); const value = error instanceof Error ? error : new Error("Pi iterator aborted"); this.fail(value); return Promise.reject(value); }
  [Symbol.asyncIterator](): AsyncIterableIterator<T> { return this; }
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["HOME", "PATH", "LANG", "LC_ALL", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"] as const;
  const env: NodeJS.ProcessEnv = { PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}
function errorEvent(error: Error): PiEvent {
  return { type: "error", state: "unavailable", detail: error.message, correctiveAction: "Retry, or continue transcript-only." };
}
function promptForBody(input: PiResearchRequestInput, maxWords: number): string {
  for (const [name, value, max] of [["transcript", input.transcript, 16_384], ["boundedContext", input.boundedContext, 16_384], ["stallText", input.stallText, 4096]] as const)
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > max) throw new Error(`${name} exceeds its bound`);
  return `Answer the user's question in full, at most ${maxWords} words total. You said an acknowledgment aloud already; do NOT restate it and do not begin with a greeting or filler. You may use the read-only research tools to gather accurate, current information. Do not present tool output or citations; give a natural spoken answer. Posture: ${input.posture}\nAcknowledgment already spoken:\n${input.stallText}\nBounded context:\n${input.boundedContext}\nTranscript:\n${input.transcript}`;
}

export class StdioPiResearchClient implements PiResearchClient {
  private readonly executable: string; private readonly model: string; private readonly thinkingLevel: PiThinkingLevel | undefined;
  private readonly systemPrompt: string; private readonly personaAppend: string;
  private readonly startupDeadlineMs: number; private readonly requestDeadlineMs: number; private readonly maxWords: number;
  private child: ChildProcessWithoutNullStreams | undefined; private buffer = Buffer.alloc(0); private stderrBytes = 0;
  private pending = new Map<string, Pending>(); private sequence = 0; private active: ActiveRequest | undefined;
  private readonly activeToolStarts = new Map<string, number>();
  private starting: Promise<void> | undefined; private ownership: Promise<void> = Promise.resolve(); private closed = false;
  constructor(options: PiResearchClientOptions = {}) {
    this.executable = options.executable ?? PI_EXECUTABLE; this.model = options.model ?? PI_MODEL; this.thinkingLevel = options.thinkingLevel;
    this.systemPrompt = options.systemPrompt ?? PODCASTER_SYSTEM_PROMPT; this.personaAppend = options.personaAppend ?? "";
    this.startupDeadlineMs = options.startupDeadlineMs ?? STARTUP_DEADLINE_MS; this.requestDeadlineMs = options.requestDeadlineMs ?? REQUEST_DEADLINE_MS;
    this.maxWords = options.maxWords ?? DEFAULT_MAX_WORDS;
  }

  private async acquire(): Promise<() => void> {
    let release!: () => void; const next = new Promise<void>(resolve => { release = resolve; });
    const prior = this.ownership; this.ownership = prior.then(() => next); await prior; return release;
  }
  requestBody(input: PiResearchRequestInput, signal: AbortSignal): AsyncIterableIterator<PiEvent> {
    let started = false; let cancelled = false; let queue!: AsyncQueue<PiEvent>;
    const cancel = () => { cancelled = true; const active = this.active; if (active?.queue === queue) active.abortListener(); };
    queue = new AsyncQueue<PiEvent>(cancel, error => { const active = this.active; if (active?.queue === queue) this.failActive(error); else queue.fail(error); });
    const originalNext = queue.next.bind(queue);
    queue.next = async () => {
      if (!started) { started = true; if (signal.aborted || cancelled) { queue.end(); return { value: undefined, done: true }; } void this.beginRequest(input, signal, queue, () => cancelled); }
      return originalNext();
    };
    return queue;
  }

  private async beginRequest(input: PiResearchRequestInput, signal: AbortSignal, queue: AsyncQueue<PiEvent>, isCancelled: () => boolean): Promise<void> {
    const releaseOwnership = await this.acquire();
    let released = false;
    const release = () => { if (!released) { released = true; releaseOwnership(); } };
    try {
      if (signal.aborted || isCancelled()) { queue.end(); release(); return; }
      const message = promptForBody(input, this.maxWords); await this.ensureStarted();
      if (signal.aborted || isCancelled()) { queue.end(); release(); return; }
      const active: ActiveRequest = { queue, cutoff: false, assistantText: "", responseBytes: 0, textExceeded: false, messageEnded: false, stopReason: undefined, providerError: undefined, settled: false, completed: false,
        timer: setTimeout(() => this.failActive(new Error("Pi research request timed out")), this.requestDeadlineMs), abortListener: () => {}, signal, release };
      active.abortListener = () => this.cancelActive(active);
      this.active = active;
      if (signal.aborted || isCancelled()) { active.cutoff = true; queue.end(); this.finishActive(active); return; }
      signal.addEventListener("abort", active.abortListener, { once: true });
      if (signal.aborted || isCancelled()) { active.abortListener(); return; }
      const promptResponse = this.send("prompt", { message }, this.requestDeadlineMs);
      if (signal.aborted || isCancelled()) active.abortListener();
      await promptResponse;
      if (signal.aborted || isCancelled()) active.abortListener();
    } catch (error) {
      if (this.active?.queue === queue) this.failActive(error instanceof Error ? error : new Error("Pi research request failed")); else { queue.push(errorEvent(error instanceof Error ? error : new Error("Pi research request failed"))); queue.end(); release(); }
    }
  }

  private cancelActive(active: ActiveRequest): void {
    if (active.cutoff || active.completed) return;
    active.cutoff = true; active.queue.end();
    void (async () => {
      try {
        const response = await this.send("abort", {}, this.requestDeadlineMs);
        if (response.success !== true) throw new Error("abort failed");
        await this.waitUntil(() => active.messageEnded && active.stopReason === "aborted" && active.settled, this.requestDeadlineMs, "abort settlement timed out");
        const state = await this.send("get_state", {}, this.requestDeadlineMs);
        if ((state.data as ObjectValue | undefined)?.isStreaming !== false) throw new Error("Pi remained streaming after abort");
        this.finishActive(active);
      } catch { try { await this.terminateOwnedChild(); } catch { this.closed = true; } this.finishActive(active); }
    })();
  }

  private async ensureStarted(): Promise<void> {
    if (this.closed) throw new Error("Pi research client is shut down");
    if (this.child && this.child.exitCode === null) return;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => { this.starting = undefined; }); return this.starting;
  }
  private async start(): Promise<void> {
    const info = await lstat(this.executable); if (!info.isFile()) throw new Error("incompatible pinned Pi executable");
    const canonical = await realpath(this.executable); if (canonical !== this.executable) throw new Error("incompatible non-canonical Pi executable path");
    await access(canonical, constants.X_OK);
    const child = spawn(canonical, ["--mode", "rpc", "--no-session", "--tools", "read,grep,find,ls", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve", "--model", this.model, ...(this.thinkingLevel ? ["--thinking", this.thinkingLevel] : []), "--system-prompt", this.systemPrompt, ...(this.personaAppend ? ["--append-system-prompt", this.personaAppend] : [])], { shell: false, detached: process.platform !== "win32", env: safeEnvironment(), stdio: ["pipe", "pipe", "pipe"] });
    this.child = child; this.buffer = Buffer.alloc(0); this.stderrBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    child.stderr.on("data", (chunk: Buffer) => { this.stderrBytes += chunk.length; if (this.stderrBytes > MAX_STDERR_BYTES) this.protocolFailure("Pi stderr exceeded bound"); });
    child.once("error", () => this.childFailed(new Error("Pi child failed")));
    child.once("exit", () => this.childFailed(new Error("Pi child exited")));
  }
  private consume(chunk: Buffer): void {
    if (chunk.length > MAX_BUFFER_BYTES || this.buffer.length + chunk.length > MAX_BUFFER_BYTES) return this.protocolFailure("Pi RPC buffer exceeded bound");
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const lf = this.buffer.indexOf(0x0a); if (lf < 0) break;
      const record = this.buffer.subarray(0, lf); this.buffer = this.buffer.subarray(lf + 1); if (!record.length) continue;
      if (record.length > MAX_RECORD_BYTES || record[record.length - 1] === 0x0d) return this.protocolFailure("Pi RPC requires bounded strict LF framing");
      try { const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(record)) as ObjectValue; if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(); this.handle(value); }
      catch { return this.protocolFailure("Pi emitted malformed JSONL"); }
    }
  }
  private handle(value: ObjectValue): void {
    if (value.type === "response" && typeof value.id === "string") {
      const pending = this.pending.get(value.id); if (pending) { clearTimeout(pending.timer); this.pending.delete(value.id); value.success === false ? pending.reject(new Error(String(value.error ?? "Pi RPC command failed"))) : pending.resolve(value); } return;
    }
    const active = this.active;
    if (!active) return;
    if (value.type === "tool_execution_start") {
      const toolCallId = String(value.toolCallId ?? "");
      const toolName = String(value.toolName ?? "?");
      // Sanitized host diagnostics only: never log arguments, tool output, or
      // results. Tool events stay out of the PiEvent stream sent downstream.
      if (toolCallId) this.activeToolStarts.set(toolCallId, Date.now());
      log("research", `tool start ${toolName} ${toolCallId}`);
      return;
    }
    if (value.type === "tool_execution_end") {
      const toolCallId = String(value.toolCallId ?? "");
      const toolName = String(value.toolName ?? "?");
      const started = toolCallId ? this.activeToolStarts.get(toolCallId) : undefined;
      if (toolCallId) this.activeToolStarts.delete(toolCallId);
      const ok = value.error === undefined || value.error === null ? "ok" : "failed";
      log("research", `tool end ${toolName} ${toolCallId}${started !== undefined ? ` ${Date.now() - started}ms` : ""} ${ok}`);
      return;
    }
    if (value.type === "message_update") {
      const update = value.assistantMessageEvent as ObjectValue | undefined;
      if (update?.type === "text_delta" && typeof update.delta === "string" && !active.messageEnded) {
        if (active.cutoff) return;
        const bytes = Buffer.byteLength(update.delta, "utf8"); active.responseBytes += bytes;
        const combined = active.assistantText + update.delta;
        if (active.responseBytes > MAX_RESPONSE_BYTES || combined.trim().split(/\s+/u).filter(Boolean).length > this.maxWords) return this.failActive(new Error("Pi research response exceeded bound"));
        active.assistantText = combined; active.queue.push({ type: "delta", text: update.delta });
      }
      return;
    }
    if (value.type === "message_end") {
      const message = value.message as ObjectValue | undefined;
      if (message?.role === "assistant") { active.messageEnded = true; active.stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined; active.providerError = typeof message.errorMessage === "string" ? message.errorMessage : undefined; }
    } else if (value.type === "agent_settled") active.settled = true;
    if (this.active === active && !active.cutoff && active.messageEnded && active.settled) {
      if (active.stopReason !== "stop" || active.providerError) this.failActive(new Error(active.providerError ?? "provider request failed"));
      else { active.queue.push({ type: "final", text: active.assistantText }); active.queue.end(); this.finishActive(active); }
    }
  }
  private finishActive(active: ActiveRequest, release = true): void { if (active.completed) return; active.completed = true; clearTimeout(active.timer); active.signal.removeEventListener("abort", active.abortListener); if (this.active === active) this.active = undefined; this.activeToolStarts.clear(); if (release) active.release(); }
  private failActive(error: Error): void {
    const active = this.active; if (!active) return;
    active.cutoff = true; active.queue.push(errorEvent(error)); active.queue.end(); this.finishActive(active, false);
    void this.terminateOwnedChild().catch(() => { this.closed = true; }).finally(active.release);
  }
  private protocolFailure(detail: string): void { this.childFailed(new Error(detail)); void this.terminateOwnedChild().catch(() => { this.closed = true; }); }
  private childFailed(error: Error): void { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); if (this.active) this.failActive(error); }
  private send(type: string, fields: ObjectValue = {}, timeoutMs = this.startupDeadlineMs): Promise<ObjectValue> {
    const child = this.child; if (!child || child.exitCode !== null) return Promise.reject(new Error("Pi child is unavailable"));
    const id = `cmd-${++this.sequence}`; const bytes = Buffer.from(`${JSON.stringify({ id, type, ...fields })}\n`, "utf8"); if (bytes.length > MAX_RECORD_BYTES) return Promise.reject(new Error("Pi RPC command exceeded bound"));
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${type} response timed out`)); }, timeoutMs); this.pending.set(id, { resolve, reject, timer }); child.stdin.write(bytes, error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(new Error("Pi RPC write failed")); } }); });
  }
  private waitUntil(predicate: () => boolean, timeoutMs: number, detail: string): Promise<void> { if (predicate()) return Promise.resolve(); return new Promise((resolve, reject) => { const started = Date.now(); const timer = setInterval(() => { if (predicate()) { clearInterval(timer); resolve(); } else if (Date.now() - started >= timeoutMs) { clearInterval(timer); reject(new Error(detail)); } }, 2); }); }
  async shutdown(): Promise<void> { this.closed = true; await this.starting?.catch(() => {}); await this.terminateOwnedChild(); }
  private async terminateOwnedChild(): Promise<void> {
    const child = this.child; this.child = undefined; if (!child?.pid) return; const pid = child.pid;
    const groupAlive = () => { try { process.kill(process.platform !== "win32" ? -pid : pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; } };
    const signal = (name: NodeJS.Signals) => { try { if (process.platform !== "win32") process.kill(-pid, name); else child.kill(name); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } };
    if (groupAlive()) { signal("SIGTERM"); await new Promise(resolve => setTimeout(resolve, 100)); }
    if (groupAlive()) { signal("SIGKILL"); await new Promise(resolve => setTimeout(resolve, 100)); }
    if (groupAlive()) throw new Error("owned Pi process group survived SIGKILL");
  }
}
export function createPiResearchClient(options: PiResearchClientOptions = {}): PiResearchClient { return new StdioPiResearchClient(options); }