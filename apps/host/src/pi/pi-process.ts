import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { PiExecutableConfigurationError, resolvePiExecutable } from "./config.js";

export type ObjectValue = Record<string, unknown>;

export const MAX_RECORD_BYTES = 256 * 1024;
export const MAX_BUFFER_BYTES = 1024 * 1024;
export const MAX_STDERR_BYTES = 64 * 1024;
export const MAX_QUEUE_EVENTS = 128;
export const MAX_QUEUE_BYTES = 256 * 1024;

export interface Pending {
  resolve(value: ObjectValue): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface Lifecycle {
  messageEnded: boolean;
  stopReason: string | undefined;
  providerError: string | undefined;
  settled: boolean;
  assistantText: string;
  responseBytes: number;
  textExceeded: boolean;
}

export interface ActiveRequest<T> extends Lifecycle {
  queue: AsyncQueue<T>;
  cutoff: boolean;
  completed: boolean;
  timer: NodeJS.Timeout;
  abortListener: () => void;
  signal: AbortSignal;
  release: () => void;
}

export class AsyncQueue<T> implements AsyncIterableIterator<T> {
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
      this.values = [];
      this.queuedBytes = 0;
      this.onOverflow(new Error("Pi event queue exceeded bound"));
      return;
    }
    this.values.push({ value, bytes });
    this.queuedBytes += bytes;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  clearAndEnd(): void {
    this.values = [];
    this.queuedBytes = 0;
    this.end();
  }

  fail(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.values = [];
    this.queuedBytes = 0;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.values.shift();
    if (item) {
      this.queuedBytes -= item.bytes;
      return Promise.resolve({ value: item.value, done: false });
    }
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  return(): Promise<IteratorResult<T>> {
    this.onCancel();
    this.end();
    return Promise.resolve({ value: undefined, done: true });
  }

  throw(error?: unknown): Promise<IteratorResult<T>> {
    this.onCancel();
    const value = error instanceof Error ? error : new Error("Pi iterator aborted");
    this.fail(value);
    return Promise.reject(value);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

export interface PiExecutableConfiguration {
  executable: string | undefined;
  executableError: Error | undefined;
}

export function resolvePiExecutableConfiguration(executable?: string): PiExecutableConfiguration {
  if (executable !== undefined) return { executable, executableError: undefined };
  try {
    return { executable: resolvePiExecutable(), executableError: undefined };
  } catch (error) {
    return {
      executable: undefined,
      executableError: error instanceof PiExecutableConfigurationError ? error : new PiExecutableConfigurationError("could not resolve the executable"),
    };
  }
}

export interface PiRpcProcessOptions {
  executable: string | undefined;
  executableError: Error | undefined;
  args: string[];
  onMessage: (value: ObjectValue) => void;
  onFailure: (error: Error, shouldTerminate: boolean) => void;
}

export class PiRpcProcess {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = Buffer.alloc(0);
  private stderrBytes = 0;
  private pending = new Map<string, Pending>();
  private sequence = 0;

  constructor(private readonly options: PiRpcProcessOptions) {}

  isRunning(): boolean {
    return this.child !== undefined && this.child.exitCode === null;
  }

  async start(): Promise<void> {
    if (this.options.executableError) throw this.options.executableError;
    const executable = this.options.executable;
    if (!executable) throw new Error("Pi executable is unavailable");
    const info = await lstat(executable);
    if (!info.isFile()) throw new Error("incompatible pinned Pi executable");
    const canonical = await realpath(executable);
    if (canonical !== executable) throw new Error("incompatible non-canonical Pi executable path");
    await access(canonical, constants.X_OK);
    const child = spawn(canonical, this.options.args, { shell: false, detached: process.platform !== "win32", env: safeEnvironment(), stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.buffer = Buffer.alloc(0);
    this.stderrBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > MAX_STDERR_BYTES) this.fail(new Error("Pi stderr exceeded bound"), true);
    });
    child.once("error", () => this.fail(new Error("Pi child failed"), false));
    child.once("exit", () => this.fail(new Error("Pi child exited"), false));
  }

  send(type: string, fields: ObjectValue = {}, timeoutMs = 8_000): Promise<ObjectValue> {
    const child = this.child;
    if (!child || child.exitCode !== null) return Promise.reject(new Error("Pi child is unavailable"));
    const id = `cmd-${++this.sequence}`;
    const bytes = Buffer.from(`${JSON.stringify({ id, type, ...fields })}\n`, "utf8");
    if (bytes.length > MAX_RECORD_BYTES) return Promise.reject(new Error("Pi RPC command exceeded bound"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${type} response timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(bytes, error => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error("Pi RPC write failed"));
        }
      });
    });
  }

  async terminate(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child?.pid) return;
    const pid = child.pid;
    const groupAlive = () => {
      try {
        process.kill(process.platform !== "win32" ? -pid : pid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
      }
    };
    const signal = (name: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32") process.kill(-pid, name);
        else child.kill(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    if (groupAlive()) {
      signal("SIGTERM");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (groupAlive()) {
      signal("SIGKILL");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (groupAlive()) throw new Error("owned Pi process group survived SIGKILL");
  }

  private consume(chunk: Buffer): void {
    if (chunk.length > MAX_BUFFER_BYTES || this.buffer.length + chunk.length > MAX_BUFFER_BYTES) return this.fail(new Error("Pi RPC buffer exceeded bound"), true);
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const lf = this.buffer.indexOf(0x0a);
      if (lf < 0) break;
      const record = this.buffer.subarray(0, lf);
      this.buffer = this.buffer.subarray(lf + 1);
      if (!record.length) continue;
      if (record.length > MAX_RECORD_BYTES || record[record.length - 1] === 0x0d) return this.fail(new Error("Pi RPC requires bounded strict LF framing"), true);
      try {
        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(record)) as ObjectValue;
        if (!value || Array.isArray(value) || typeof value !== "object") throw new Error();
        this.handle(value);
      } catch {
        return this.fail(new Error("Pi emitted malformed JSONL"), true);
      }
    }
  }

  private handle(value: ObjectValue): void {
    if (value.type === "response" && typeof value.id === "string") {
      const pending = this.pending.get(value.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(value.id);
        value.success === false ? pending.reject(new Error(String(value.error ?? "Pi RPC command failed"))) : pending.resolve(value);
      }
      return;
    }
    this.options.onMessage(value);
  }

  private fail(error: Error, shouldTerminate: boolean): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.options.onFailure(error, shouldTerminate);
  }
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["HOME", "PATH", "LANG", "LC_ALL", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"] as const;
  const env: NodeJS.ProcessEnv = { PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}
