export type LogLevel = 'info' | 'warn' | 'error';
export type ActivityEntryFilter = (entry: ActivityEntry) => boolean;
export interface ActivityEntry {
  ts: number;
  level: LogLevel;
  source: string;
  message: string;
  detail?: string;
}

const CAPACITY = 500;

export class ActivityLog {
  private buffer: ActivityEntry[] = [];
  private readonly listeners = new Set<(entries: ActivityEntry[]) => void>();

  append(entry: Omit<ActivityEntry, 'ts'>): void {
    const full: ActivityEntry = { ts: Date.now(), ...entry };
    this.buffer.push(full);
    if (this.buffer.length > CAPACITY) this.buffer.splice(0, this.buffer.length - CAPACITY);
    // Console mirror only; these paths must never emit console.error/warn.
    console.debug(`[activity] ${full.level} ${full.source}: ${full.message}${full.detail ? ` — ${full.detail}` : ''}`);
    this.emit();
  }

  clear(filter?: ActivityEntryFilter): void {
    if (this.buffer.length === 0) return;
    if (filter) {
      const remaining = this.buffer.filter((entry) => !filter(entry));
      if (remaining.length === this.buffer.length) return;
      this.buffer = remaining;
      this.emit();
      return;
    }
    this.buffer = [];
    this.emit();
  }

  subscribe(listener: (entries: ActivityEntry[]) => void): () => void {
    this.listeners.add(listener);
    listener([...this.buffer]);
    return () => this.listeners.delete(listener);
  }

  entries(): readonly ActivityEntry[] {
    return this.buffer;
  }

  toText(filter?: ActivityEntryFilter): string {
    const entries = filter ? this.buffer.filter(filter) : this.buffer;
    return entries
      .map((entry) => {
        const time = new Date(entry.ts).toISOString();
        return `[${time}] ${entry.level.toUpperCase()} ${entry.source}: ${entry.message}${entry.detail ? ` — ${entry.detail}` : ''}`;
      })
      .join('\n');
  }

  toJSON(): string {
    return JSON.stringify(this.buffer);
  }

  private emit(): void {
    for (const listener of this.listeners) listener([...this.buffer]);
  }
}

export const activityLog = new ActivityLog();
