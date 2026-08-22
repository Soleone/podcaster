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
    expect(typeof warned!.ts).toBe('number');
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
    const parsed = JSON.parse(activityLog.toJSON()) as ActivityEntry[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ level: 'error', source: 'transport', message: 'protocol failure' });
    expect(typeof parsed[0]!.ts).toBe('number');
  });
});
