import { afterEach, describe, expect, it } from 'vitest';
import { activityLog, type ActivityEntry } from './activity-log';

describe('activity log', () => {
  afterEach(() => activityLog.clear());

  it('is a module-level singleton shared across imports', async () => {
    const dynamic = (await import('./activity-log')).activityLog;
    expect(dynamic).toBe(activityLog);
  });

  it('keeps at most 500 entries, dropping the oldest', () => {
    for (let index = 0; index < 600; index++)
      activityLog.append({ level: 'info', source: 'test', message: `entry ${index}` });
    const entries = activityLog.entries();
    expect(entries).toHaveLength(500);
    expect(entries[0]!.message).toBe('entry 100');
    expect(entries[499]!.message).toBe('entry 599');
  });

  it('shapes entries with ts, level, source, message, and optional detail', () => {
    activityLog.append({ level: 'warn', source: 'transport', message: 'something odd', detail: 'detail text' });
    const [warned] = activityLog.entries();
    expect(warned).toMatchObject({
      level: 'warn',
      source: 'transport',
      message: 'something odd',
      detail: 'detail text',
    });
    expect(Number.isFinite(warned!.ts)).toBe(true);
    activityLog.append({ level: 'error', source: 'controller', message: 'degraded' });
    expect(activityLog.entries()[1]!.detail).toBeUndefined();
    expect(activityLog.entries()[1]!.level).toBe('error');
  });

  it('notifies subscribers on append and stops after unsubscribe', () => {
    const seen: ActivityEntry[][] = [];
    const unsubscribe = activityLog.subscribe((entries) => seen.push(entries));
    activityLog.append({ level: 'info', source: 'test', message: 'first' });
    activityLog.append({ level: 'info', source: 'test', message: 'second' });
    unsubscribe();
    activityLog.append({ level: 'info', source: 'test', message: 'third' });
    expect(seen).toHaveLength(3); // immediate snapshot + two appends
    expect(seen[1]!.at(-1)?.message).toBe('first');
    expect(seen[2]!.at(-1)?.message).toBe('second');
    expect(activityLog.entries().at(-1)?.message).toBe('third');
  });

  it('filters toText and clear by predicate while keeping no-arg behavior unchanged', () => {
    activityLog.append({ level: 'info', source: 'transport', message: 'session socket opened' });
    activityLog.append({ level: 'warn', source: 'budget', message: 'measured handoff gap' });
    const onlyBudget = (entry: ActivityEntry) => entry.source === 'budget';
    expect(activityLog.toText(onlyBudget)).toContain('budget: measured handoff gap');
    expect(activityLog.toText(onlyBudget)).not.toContain('transport');
    expect(activityLog.toText()).toContain('session socket opened');
    activityLog.clear(onlyBudget);
    expect(activityLog.entries()).toHaveLength(1);
    expect(activityLog.entries()[0]!.source).toBe('transport');
    activityLog.clear();
    expect(activityLog.entries()).toHaveLength(0);
  });

  it('leaves entries untouched and skips notification when a filtered clear matches nothing', () => {
    activityLog.append({ level: 'info', source: 'transport', message: 'session socket opened' });
    const seen: ActivityEntry[][] = [];
    const unsubscribe = activityLog.subscribe((entries) => seen.push(entries));
    activityLog.clear((entry) => entry.source === 'budget');
    unsubscribe();
    expect(seen).toHaveLength(1); // immediate snapshot only; no clear emission
    expect(activityLog.entries()).toHaveLength(1);
  });

  it('formats toText and toJSON deterministically', () => {
    activityLog.append({
      level: 'error',
      source: 'transport',
      message: 'protocol failure',
      detail: 'the "vad.speech_start" event failed validation.',
    });
    const text = activityLog.toText();
    expect(text).toContain('ERROR transport: protocol failure');
    expect(text).toContain('vad.speech_start');
    // SAFETY: toJSON serializes the locally constructed activity entry array.
    const parsed = JSON.parse(activityLog.toJSON()) as ActivityEntry[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ level: 'error', source: 'transport', message: 'protocol failure' });
    expect(Number.isFinite(parsed[0]!.ts)).toBe(true);
  });
});
