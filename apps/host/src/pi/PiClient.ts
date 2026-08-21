import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { DEFAULT_PI_MODEL, PODCASTER_SYSTEM_PROMPT, type PiThinkingLevel } from "@app/contracts";
import { PiExecutableConfigurationError, resolvePiExecutable } from "./config.js";

export const PI_MODEL = DEFAULT_PI_MODEL;

const MAX_RECORD_BYTES = 256 * 1024;
const MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_QUEUE_EVENTS = 128;
const MAX_QUEUE_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_PROBE_RESPONSE_BYTES = 1024;
const PROBE_MARKER = "RPC_READY";
const RESPONSE_ONLY_SYSTEM_INSTRUCTION = "Do not use tools or attempt to read files.";
const STARTUP_DEADLINE_MS = 8_000;
const REQUEST_DEADLINE_MS = 60_000;
export const PI_PROBE_DEADLINE_MS = 10_000;

type ObjectValue = Record<string, unknown>;
export type PiReadinessStatus = "ready" | "login_required" | "unavailable" | "incompatible" | "rate_limited";
export interface PiReadiness { status: PiReadinessStatus; detail: string; correctiveAction: string }
export type PiPosture = "riff" | "question" | "challenge";
export interface PiRequestInput { posture: PiPosture; transcript: string; boundedContext: string; maxWords: 45 }
export type PiEvent =
  | { type: "delta"; text: string }
  | { type: "final"; text: string }
  | { type: "error"; state: Exclude<PiReadinessStatus, "ready">; detail: string; correctiveAction: string };
export interface PiClient { probe(): Promise<PiReadiness>; request(input: PiRequestInput, signal: AbortSignal): AsyncIterable<PiEvent>; shutdown(): Promise<void> }
export interface PiClientOptions { executable?: string; model?: string; thinkingLevel?: PiThinkingLevel; systemPrompt?: string; personaAppend?: string; startupDeadlineMs?: number; requestDeadlineMs?: number; probeDeadlineMs?: number }
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
function readiness(status: PiReadinessStatus): PiReadiness {
  const detail = ({ ready: "Pi is ready.", login_required: "Pi sign-in is required.", rate_limited: "Pi provider is rate limited.", incompatible: "The installed Pi executable, version, protocol, or model is incompatible.", unavailable: "Pi is unavailable." })[status];
  const correctiveAction = status === "login_required" ? "Run Pi's supported interactive sign-in flow, then retry." : status === "rate_limited" ? "Wait and retry, or continue transcript-only." : status === "incompatible" ? "Install the pinned Pi version and model, then retry." : status === "ready" ? "None." : "Retry, or continue transcript-only.";
  return { status, detail, correctiveAction };
}
function classify(error: unknown): PiReadiness {
  const lower = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (/429|rate.?limit|quota|too many requests/.test(lower)) return readiness("rate_limited");
  if (/login|sign.?in|authenticat|unauthorized|forbidden|credential/.test(lower)) return readiness("login_required");
  if (/incompatible|version|protocol|unsupported|unknown option|model not found|pinned model/.test(lower)) return readiness("incompatible");
  return readiness("unavailable");
}
function errorEvent(error: unknown): PiEvent {
  const mapped = classify(error); return { type: "error", state: mapped.status === "ready" ? "unavailable" : mapped.status, detail: mapped.detail, correctiveAction: mapped.correctiveAction };
}
function promptFor(input: PiRequestInput): string {
  if (!( ["riff", "question", "challenge"] as const).includes(input.posture)) throw new Error("invalid posture");
  if (input.maxWords !== 45) throw new Error("maxWords must be exactly 45");
  for (const [name, value, max] of [["transcript", input.transcript, 16_384], ["boundedContext", input.boundedContext, 16_384]] as const)
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > max) throw new Error(`${name} exceeds its bound`);
  return `Posture: ${input.posture}\nBounded context:\n${input.boundedContext}\nTranscript:\n${input.transcript}`;
}

export class StdioPiClient implements PiClient {
  private readonly executable: string | undefined; private readonly executableError: Error | undefined; private readonly model: string; private readonly thinkingLevel: PiThinkingLevel | undefined;
  private readonly systemPrompt: string; private readonly personaAppend: string;
  private readonly startupDeadlineMs: number; private readonly requestDeadlineMs: number; private readonly probeDeadlineMs: number;
  private child: ChildProcessWithoutNullStreams | undefined; private buffer = Buffer.alloc(0); private stderrBytes = 0;
  private pending = new Map<string, Pending>(); private sequence = 0; private active: ActiveRequest | undefined; private probeLifecycle: Lifecycle | undefined;
  private starting: Promise<void> | undefined; private ownership: Promise<void> = Promise.resolve(); private closed = false;
  constructor(options: PiClientOptions = {}) {
    if (options.executable !== undefined) {
      this.executable = options.executable;
      this.executableError = undefined;
    } else {
      try {
        this.executable = resolvePiExecutable();
        this.executableError = undefined;
      } catch (error) {
        this.executable = undefined;
        this.executableError = error instanceof PiExecutableConfigurationError ? error : new PiExecutableConfigurationError("could not resolve the executable");
      }
    }
    this.model = options.model ?? PI_MODEL; this.thinkingLevel = options.thinkingLevel; this.systemPrompt = options.systemPrompt ?? PODCASTER_SYSTEM_PROMPT; this.personaAppend = options.personaAppend ?? ""; this.startupDeadlineMs = options.startupDeadlineMs ?? STARTUP_DEADLINE_MS; this.requestDeadlineMs = options.requestDeadlineMs ?? REQUEST_DEADLINE_MS; this.probeDeadlineMs = options.probeDeadlineMs ?? Math.min(this.requestDeadlineMs, PI_PROBE_DEADLINE_MS);
  }

  private async acquire(): Promise<() => void> {
    let release!: () => void; const next = new Promise<void>(resolve => { release = resolve; });
    const prior = this.ownership; this.ownership = prior.then(() => next); await prior; return release;
  }
  async probe(): Promise<PiReadiness> {
    const release = await this.acquire();
    try {
      await this.ensureStarted();
      const state = await this.send("get_state"); const models = await this.send("get_available_models"); this.assertPinnedModel(state, models);
      const lifecycle: Lifecycle = { messageEnded: false, stopReason: undefined, providerError: undefined, settled: false, assistantText: "", responseBytes: 0, textExceeded: false }; this.probeLifecycle = lifecycle;
      // Readiness must not wait as long as a real spoken response. A provider
      // can spend minutes at a high thinking level on a one-line marker, which
      // otherwise leaves the UI stuck in "Starting" even though Pi spawned.
      await this.send("prompt", { message: `Reply with exactly ${PROBE_MARKER} and no other text.` }, this.probeDeadlineMs);
      await this.waitUntil(() => lifecycle.messageEnded && lifecycle.settled, this.probeDeadlineMs, "probe completion timed out");
      if (lifecycle.stopReason !== "stop" || lifecycle.providerError) throw new Error(lifecycle.providerError ?? "provider did not complete normally");
      if (lifecycle.textExceeded || lifecycle.assistantText !== PROBE_MARKER) throw new Error("provider probe returned an invalid readiness marker");
      return readiness("ready");
    } catch (error) {
      try { await this.terminateOwnedChild(); } catch { this.closed = true; return readiness("unavailable"); }
      return classify(error);
    }
    finally { this.probeLifecycle = undefined; release(); }
  }

  request(input: PiRequestInput, signal: AbortSignal): AsyncIterableIterator<PiEvent> {
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

  private async beginRequest(input: PiRequestInput, signal: AbortSignal, queue: AsyncQueue<PiEvent>, isCancelled: () => boolean): Promise<void> {
    const releaseOwnership = await this.acquire();
    let released = false;
    const release = () => { if (!released) { released = true; releaseOwnership(); } };
    try {
      if (signal.aborted || isCancelled()) { queue.end(); release(); return; }
      const message = promptFor(input); await this.ensureStarted();
      if (signal.aborted || isCancelled()) { queue.end(); release(); return; }
      const active: ActiveRequest = { queue, cutoff: false, assistantText: "", responseBytes: 0, textExceeded: false, messageEnded: false, stopReason: undefined, providerError: undefined, settled: false, completed: false,
        timer: setTimeout(() => this.failActive(new Error("Pi request timed out")), this.requestDeadlineMs), abortListener: () => {}, signal, release };
      active.abortListener = () => this.cancelActive(active);
      this.active = active;
      if (signal.aborted || isCancelled()) { active.cutoff = true; queue.end(); this.finishActive(active); return; }
      signal.addEventListener("abort", active.abortListener, { once: true });
      if (signal.aborted || isCancelled()) { active.abortListener(); return; }
      // No asynchronous gap exists between the final cancellation check and prompt submission.
      const promptResponse = this.send("prompt", { message }, this.requestDeadlineMs);
      if (signal.aborted || isCancelled()) active.abortListener();
      await promptResponse;
      if (signal.aborted || isCancelled()) active.abortListener();
    } catch (error) {
      if (this.active?.queue === queue) this.failActive(error instanceof Error ? error : new Error("Pi request failed")); else { queue.push(errorEvent(error)); queue.end(); release(); }
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
    if (this.closed) throw new Error("Pi client is shut down");
    if (this.child && this.child.exitCode === null) return;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => { this.starting = undefined; }); return this.starting;
  }
  private async start(): Promise<void> {
    if (this.executableError) throw this.executableError;
    const executable = this.executable;
    if (!executable) throw new Error("Pi executable is unavailable");
    const info = await lstat(executable); if (!info.isFile()) throw new Error("incompatible pinned Pi executable");
    const canonical = await realpath(executable); if (canonical !== executable) throw new Error("incompatible non-canonical Pi executable path");
    await access(canonical, constants.X_OK);
    const appendSystemPrompt = [this.personaAppend, RESPONSE_ONLY_SYSTEM_INSTRUCTION].filter(Boolean).join("\n\n");
    const child = spawn(canonical, ["--mode", "rpc", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve", "--model", this.model, ...(this.thinkingLevel ? ["--thinking", this.thinkingLevel] : []), "--system-prompt", this.systemPrompt, "--append-system-prompt", appendSystemPrompt], { shell: false, detached: process.platform !== "win32", env: safeEnvironment(), stdio: ["pipe", "pipe", "pipe"] });
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
    const lifecycle = this.active ?? this.probeLifecycle;
    if (!lifecycle) return;
    if (value.type === "message_update") {
      const update = value.assistantMessageEvent as ObjectValue | undefined;
      if (update?.type === "text_delta" && typeof update.delta === "string" && !lifecycle.messageEnded) {
        if (this.active) {
          if (this.active.cutoff) return;
          const bytes = Buffer.byteLength(update.delta, "utf8"); this.active.responseBytes += bytes;
          const combined = this.active.assistantText + update.delta;
          if (this.active.responseBytes > MAX_RESPONSE_BYTES || combined.trim().split(/\s+/u).filter(Boolean).length > 45) return this.failActive(new Error("Pi response exceeded bound"));
          this.active.assistantText = combined; this.active.queue.push({ type: "delta", text: update.delta });
        } else if (this.probeLifecycle) {
          const bytes = Buffer.byteLength(update.delta, "utf8");
          this.probeLifecycle.responseBytes += bytes;
          if (this.probeLifecycle.responseBytes > MAX_PROBE_RESPONSE_BYTES) this.probeLifecycle.textExceeded = true;
          else this.probeLifecycle.assistantText += update.delta;
        }
      }
      return;
    }
    if (value.type === "message_end") {
      const message = value.message as ObjectValue | undefined;
      if (message?.role === "assistant") { lifecycle.messageEnded = true; lifecycle.stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined; lifecycle.providerError = typeof message.errorMessage === "string" ? message.errorMessage : undefined; }
    } else if (value.type === "agent_settled") lifecycle.settled = true;
    if (this.active && !this.active.cutoff && this.active.messageEnded && this.active.settled) {
      if (this.active.stopReason !== "stop" || this.active.providerError) this.failActive(new Error(this.active.providerError ?? "provider request failed"));
      else { this.active.queue.push({ type: "final", text: this.active.assistantText }); this.active.queue.end(); this.finishActive(this.active); }
    }
  }
  private finishActive(active: ActiveRequest, release = true): void { if (active.completed) return; active.completed = true; clearTimeout(active.timer); active.signal.removeEventListener("abort", active.abortListener); if (this.active === active) this.active = undefined; if (release) active.release(); }
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
  private assertPinnedModel(state: ObjectValue, models: ObjectValue): void { const selected = (state.data as ObjectValue | undefined)?.model as ObjectValue | undefined; const list = ((models.data as ObjectValue | undefined)?.models ?? []) as ObjectValue[]; const [provider, id] = this.model.split("/", 2); if (selected?.provider !== provider || selected?.id !== id || !list.some(item => item.provider === provider && item.id === id)) throw new Error("pinned model is incompatible"); }
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
export function createPiClient(options: PiClientOptions = {}): PiClient { return new StdioPiClient(options); }
