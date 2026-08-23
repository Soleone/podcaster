import { DEFAULT_PI_MODEL, PODCASTER_SYSTEM_PROMPT, type PiThinkingLevel } from '@app/contracts';
import {
  AsyncQueue,
  PiRpcProcess,
  resolvePiExecutableConfiguration,
  type ActiveRequest,
  type Lifecycle,
  type ObjectValue,
} from './pi-process.js';

export const PI_MODEL = DEFAULT_PI_MODEL;

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_PROBE_RESPONSE_BYTES = 1024;
const PROBE_MARKER = 'RPC_READY';
const RESPONSE_ONLY_SYSTEM_INSTRUCTION = 'Do not use tools or attempt to read files.';
const STARTUP_DEADLINE_MS = 8_000;
const REQUEST_DEADLINE_MS = 60_000;
export const PI_PROBE_DEADLINE_MS = 10_000;

export type PiReadinessStatus = 'ready' | 'login_required' | 'unavailable' | 'incompatible' | 'rate_limited';
export interface PiReadiness {
  status: PiReadinessStatus;
  detail: string;
  correctiveAction: string;
}
export type PiPosture = 'riff' | 'question' | 'challenge';
export interface PiRequestInput {
  posture: PiPosture;
  transcript: string;
  boundedContext: string;
  maxWords: 45;
  /** Optional per-request framing prepended ahead of the data blocks (for example, the stall-hook job). */
  instruction?: string;
}
/** Part 0 of a multi-part response holds the floor with a reaction/hook, never a full answer. */
export const PI_STALL_INSTRUCTION =
  'This is part 0 of one spoken answer: a quick hook that holds the floor while the rest is prepared. It is NOT an attempt at a complete answer. React to what the user just said, take a quick position, or say what you will dig into next. Never say you cannot browse, search, or look things up, and never ask the user for facts you could look up yourself; a lookup may already be running behind this hook. At most 45 words, spoken text only.';
export type PiEvent =
  | { type: 'delta'; text: string }
  | { type: 'final'; text: string }
  | { type: 'error'; state: Exclude<PiReadinessStatus, 'ready'>; detail: string; correctiveAction: string };
export interface PiClient {
  probe(): Promise<PiReadiness>;
  request(input: PiRequestInput, signal: AbortSignal): AsyncIterable<PiEvent>;
  shutdown(): Promise<void>;
}
export interface PiClientOptions {
  executable?: string;
  model?: string;
  thinkingLevel?: PiThinkingLevel;
  systemPrompt?: string;
  personaAppend?: string;
  startupDeadlineMs?: number;
  requestDeadlineMs?: number;
  probeDeadlineMs?: number;
}
type PiActiveRequest = ActiveRequest<PiEvent>;

function readiness(status: PiReadinessStatus): PiReadiness {
  const detail = {
    ready: 'Pi is ready.',
    login_required: 'Pi sign-in is required.',
    rate_limited: 'Pi provider is rate limited.',
    incompatible: 'The installed Pi executable, version, protocol, or model is incompatible.',
    unavailable: 'Pi is unavailable.',
  }[status];
  const correctiveAction =
    status === 'login_required'
      ? "Run Pi's supported interactive sign-in flow, then retry."
      : status === 'rate_limited'
        ? 'Wait and retry, or continue transcript-only.'
        : status === 'incompatible'
          ? 'Install the pinned Pi version and model, then retry.'
          : status === 'ready'
            ? 'None.'
            : 'Retry, or continue transcript-only.';
  return { status, detail, correctiveAction };
}
function classify(error: unknown): PiReadiness {
  const lower = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (/429|rate.?limit|quota|too many requests/.test(lower)) return readiness('rate_limited');
  if (/login|sign.?in|authenticat|unauthorized|forbidden|credential/.test(lower)) return readiness('login_required');
  if (/incompatible|version|protocol|unsupported|unknown option|model not found|pinned model/.test(lower))
    return readiness('incompatible');
  return readiness('unavailable');
}
function errorEvent(error: unknown): PiEvent {
  const mapped = classify(error);
  return {
    type: 'error',
    state: mapped.status === 'ready' ? 'unavailable' : mapped.status,
    detail: mapped.detail,
    correctiveAction: mapped.correctiveAction,
  };
}
function promptFor(input: PiRequestInput): string {
  if (!(['riff', 'question', 'challenge'] as const).includes(input.posture)) throw new Error('invalid posture');
  if (input.maxWords !== 45) throw new Error('maxWords must be exactly 45');
  for (const [name, value, max] of [
    ['transcript', input.transcript, 16_384],
    ['boundedContext', input.boundedContext, 16_384],
  ] as const)
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > max)
      throw new Error(`${name} exceeds its bound`);
  let instruction = '';
  if (input.instruction !== undefined) {
    if (typeof input.instruction !== 'string' || Buffer.byteLength(input.instruction, 'utf8') > 4096)
      throw new Error('instruction exceeds its bound');
    instruction = `${input.instruction}\n`;
  }
  return `${instruction}Posture: ${input.posture}\nBounded context:\n${input.boundedContext}\nTranscript:\n${input.transcript}`;
}

export class StdioPiClient implements PiClient {
  private readonly model: string;
  private readonly thinkingLevel: PiThinkingLevel | undefined;
  private readonly systemPrompt: string;
  private readonly personaAppend: string;
  private readonly startupDeadlineMs: number;
  private readonly requestDeadlineMs: number;
  private readonly probeDeadlineMs: number;
  private readonly process: PiRpcProcess;
  private active: PiActiveRequest | undefined;
  private probeLifecycle: Lifecycle | undefined;
  private starting: Promise<void> | undefined;
  private ownership: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(options: PiClientOptions = {}) {
    const executableConfiguration = resolvePiExecutableConfiguration(options.executable);
    this.model = options.model ?? PI_MODEL;
    this.thinkingLevel = options.thinkingLevel;
    this.systemPrompt = options.systemPrompt ?? PODCASTER_SYSTEM_PROMPT;
    this.personaAppend = options.personaAppend ?? '';
    this.startupDeadlineMs = options.startupDeadlineMs ?? STARTUP_DEADLINE_MS;
    this.requestDeadlineMs = options.requestDeadlineMs ?? REQUEST_DEADLINE_MS;
    this.probeDeadlineMs = options.probeDeadlineMs ?? Math.min(this.requestDeadlineMs, PI_PROBE_DEADLINE_MS);
    this.process = new PiRpcProcess({
      ...executableConfiguration,
      args: [
        '--mode',
        'rpc',
        '--no-session',
        '--no-tools',
        '--no-extensions',
        '--no-skills',
        '--no-prompt-templates',
        '--no-context-files',
        '--no-approve',
        '--model',
        this.model,
        ...(this.thinkingLevel ? ['--thinking', this.thinkingLevel] : []),
        '--system-prompt',
        this.systemPrompt,
        '--append-system-prompt',
        [this.personaAppend, RESPONSE_ONLY_SYSTEM_INSTRUCTION].filter(Boolean).join('\n\n'),
      ],
      onMessage: (value) => this.handle(value),
      onFailure: (error, shouldTerminate) => this.processFailed(error, shouldTerminate),
    });
  }

  private async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prior = this.ownership;
    this.ownership = prior.then(() => next);
    await prior;
    return release;
  }
  async probe(): Promise<PiReadiness> {
    const release = await this.acquire();
    try {
      await this.ensureStarted();
      const state = await this.send('get_state');
      const models = await this.send('get_available_models');
      this.assertPinnedModel(state, models);
      const lifecycle: Lifecycle = {
        messageEnded: false,
        stopReason: undefined,
        providerError: undefined,
        settled: false,
        assistantText: '',
        responseBytes: 0,
        textExceeded: false,
      };
      this.probeLifecycle = lifecycle;
      // Readiness must not wait as long as a real spoken response. A provider
      // can spend minutes at a high thinking level on a one-line marker, which
      // otherwise leaves the UI stuck in "Starting" even though Pi spawned.
      await this.send(
        'prompt',
        { message: `Reply with exactly ${PROBE_MARKER} and no other text.` },
        this.probeDeadlineMs,
      );
      await this.waitUntil(
        () => lifecycle.messageEnded && lifecycle.settled,
        this.probeDeadlineMs,
        'probe completion timed out',
      );
      if (lifecycle.stopReason !== 'stop' || lifecycle.providerError)
        throw new Error(lifecycle.providerError ?? 'provider did not complete normally');
      if (lifecycle.textExceeded || lifecycle.assistantText !== PROBE_MARKER)
        throw new Error('provider probe returned an invalid readiness marker');
      return readiness('ready');
    } catch (error) {
      try {
        await this.terminateOwnedChild();
      } catch {
        this.closed = true;
        return readiness('unavailable');
      }
      return classify(error);
    } finally {
      this.probeLifecycle = undefined;
      release();
    }
  }

  request(input: PiRequestInput, signal: AbortSignal): AsyncIterableIterator<PiEvent> {
    let started = false;
    let cancelled = false;
    let queue!: AsyncQueue<PiEvent>;
    const cancel = () => {
      cancelled = true;
      const active = this.active;
      if (active?.queue === queue) active.abortListener();
    };
    queue = new AsyncQueue<PiEvent>(cancel, (error) => {
      const active = this.active;
      if (active?.queue === queue) this.failActive(error);
      else queue.fail(error);
    });
    const originalNext = queue.next.bind(queue);
    queue.next = async () => {
      if (!started) {
        started = true;
        if (signal.aborted || cancelled) {
          queue.end();
          return { value: undefined, done: true };
        }
        void this.beginRequest(input, signal, queue, () => cancelled);
      }
      return originalNext();
    };
    return queue;
  }

  private async beginRequest(
    input: PiRequestInput,
    signal: AbortSignal,
    queue: AsyncQueue<PiEvent>,
    isCancelled: () => boolean,
  ): Promise<void> {
    const releaseOwnership = await this.acquire();
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        releaseOwnership();
      }
    };
    try {
      if (signal.aborted || isCancelled()) {
        queue.end();
        release();
        return;
      }
      const message = promptFor(input);
      await this.ensureStarted();
      if (signal.aborted || isCancelled()) {
        queue.end();
        release();
        return;
      }
      const active: PiActiveRequest = {
        queue,
        cutoff: false,
        assistantText: '',
        responseBytes: 0,
        textExceeded: false,
        messageEnded: false,
        stopReason: undefined,
        providerError: undefined,
        settled: false,
        completed: false,
        timer: setTimeout(() => this.failActive(new Error('Pi request timed out')), this.requestDeadlineMs),
        abortListener: () => {},
        signal,
        release,
      };
      active.abortListener = () => this.cancelActive(active);
      this.active = active;
      if (signal.aborted || isCancelled()) {
        active.cutoff = true;
        queue.end();
        this.finishActive(active);
        return;
      }
      signal.addEventListener('abort', active.abortListener, { once: true });
      if (signal.aborted || isCancelled()) {
        active.abortListener();
        return;
      }
      // No asynchronous gap exists between the final cancellation check and prompt submission.
      const promptResponse = this.send('prompt', { message }, this.requestDeadlineMs);
      if (signal.aborted || isCancelled()) active.abortListener();
      await promptResponse;
      if (signal.aborted || isCancelled()) active.abortListener();
    } catch (error) {
      if (this.active?.queue === queue)
        this.failActive(error instanceof Error ? error : new Error('Pi request failed'));
      else {
        queue.push(errorEvent(error));
        queue.end();
        release();
      }
    }
  }

  private cancelActive(active: PiActiveRequest): void {
    if (active.cutoff || active.completed) return;
    active.cutoff = true;
    active.queue.end();
    void (async () => {
      try {
        const response = await this.send('abort', {}, this.requestDeadlineMs);
        if (response.success !== true) throw new Error('abort failed');
        await this.waitUntil(
          () => active.messageEnded && active.stopReason === 'aborted' && active.settled,
          this.requestDeadlineMs,
          'abort settlement timed out',
        );
        const state = await this.send('get_state', {}, this.requestDeadlineMs);
        if ((state.data as ObjectValue | undefined)?.isStreaming !== false)
          throw new Error('Pi remained streaming after abort');
        this.finishActive(active);
      } catch {
        try {
          await this.terminateOwnedChild();
        } catch {
          this.closed = true;
        }
        this.finishActive(active);
      }
    })();
  }

  private async ensureStarted(): Promise<void> {
    if (this.closed) throw new Error('Pi client is shut down');
    if (this.process.isRunning()) return;
    if (this.starting) return this.starting;
    this.starting = this.process.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  private handle(value: ObjectValue): void {
    const lifecycle = this.active ?? this.probeLifecycle;
    if (!lifecycle) return;
    if (value.type === 'message_update') {
      const update = value.assistantMessageEvent as ObjectValue | undefined;
      if (update?.type === 'text_delta' && typeof update.delta === 'string' && !lifecycle.messageEnded) {
        if (this.active) {
          if (this.active.cutoff) return;
          const bytes = Buffer.byteLength(update.delta, 'utf8');
          this.active.responseBytes += bytes;
          const combined = this.active.assistantText + update.delta;
          if (
            this.active.responseBytes > MAX_RESPONSE_BYTES ||
            combined.trim().split(/\s+/u).filter(Boolean).length > 45
          )
            return this.failActive(new Error('Pi response exceeded bound'));
          this.active.assistantText = combined;
          this.active.queue.push({ type: 'delta', text: update.delta });
        } else if (this.probeLifecycle) {
          const bytes = Buffer.byteLength(update.delta, 'utf8');
          this.probeLifecycle.responseBytes += bytes;
          if (this.probeLifecycle.responseBytes > MAX_PROBE_RESPONSE_BYTES) this.probeLifecycle.textExceeded = true;
          else this.probeLifecycle.assistantText += update.delta;
        }
      }
      return;
    }
    if (value.type === 'message_end') {
      const message = value.message as ObjectValue | undefined;
      if (message?.role === 'assistant') {
        lifecycle.messageEnded = true;
        lifecycle.stopReason = typeof message.stopReason === 'string' ? message.stopReason : undefined;
        lifecycle.providerError = typeof message.errorMessage === 'string' ? message.errorMessage : undefined;
      }
    } else if (value.type === 'agent_settled') lifecycle.settled = true;
    if (this.active && !this.active.cutoff && this.active.messageEnded && this.active.settled) {
      if (this.active.stopReason !== 'stop' || this.active.providerError)
        this.failActive(new Error(this.active.providerError ?? 'provider request failed'));
      else {
        this.active.queue.push({ type: 'final', text: this.active.assistantText });
        this.active.queue.end();
        this.finishActive(this.active);
      }
    }
  }
  private finishActive(active: PiActiveRequest, release = true): void {
    if (active.completed) return;
    active.completed = true;
    clearTimeout(active.timer);
    active.signal.removeEventListener('abort', active.abortListener);
    if (this.active === active) this.active = undefined;
    if (release) active.release();
  }
  private failActive(error: Error): void {
    const active = this.active;
    if (!active) return;
    active.cutoff = true;
    active.queue.push(errorEvent(error));
    active.queue.end();
    this.finishActive(active, false);
    void this.terminateOwnedChild()
      .catch(() => {
        this.closed = true;
      })
      .finally(active.release);
  }
  private processFailed(error: Error, shouldTerminate: boolean): void {
    if (this.active) {
      this.failActive(error);
      return;
    }
    if (shouldTerminate)
      void this.terminateOwnedChild().catch(() => {
        this.closed = true;
      });
  }
  private send(type: string, fields: ObjectValue = {}, timeoutMs = this.startupDeadlineMs): Promise<ObjectValue> {
    return this.process.send(type, fields, timeoutMs);
  }
  private assertPinnedModel(state: ObjectValue, models: ObjectValue): void {
    const selected = (state.data as ObjectValue | undefined)?.model as ObjectValue | undefined;
    const list = ((models.data as ObjectValue | undefined)?.models ?? []) as ObjectValue[];
    const [provider, id] = this.model.split('/', 2);
    if (
      selected?.provider !== provider ||
      selected?.id !== id ||
      !list.some((item) => item.provider === provider && item.id === id)
    )
      throw new Error('pinned model is incompatible');
  }
  private waitUntil(predicate: () => boolean, timeoutMs: number, detail: string): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (predicate()) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - started >= timeoutMs) {
          clearInterval(timer);
          reject(new Error(detail));
        }
      }, 2);
    });
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    await this.starting?.catch(() => {});
    await this.terminateOwnedChild();
  }
  private async terminateOwnedChild(): Promise<void> {
    await this.process.terminate();
  }
}
export function createPiClient(options: PiClientOptions = {}): PiClient {
  return new StdioPiClient(options);
}
