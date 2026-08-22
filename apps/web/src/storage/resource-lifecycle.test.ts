import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResourceOwner } from './resource-lifecycle';

afterEach(() => vi.restoreAllMocks());

describe('resource lifecycle', () => {
  it('shares an open across StrictMode-like setup/cleanup and closes after the newer owner releases', async () => {
    let resolveOpen!: (value: { id: number }) => void;
    const open = vi.fn(
      () =>
        new Promise<{ id: number }>((resolve) => {
          resolveOpen = resolve;
        }),
    );
    const close = vi.fn();
    const owner = createResourceOwner(open, close);

    const first = owner.acquire();
    expect(first.release()).toBe(true);
    const second = owner.acquire();
    resolveOpen({ id: 1 });

    expect(await first.promise).toEqual({ id: 1 });
    expect(await second.promise).toEqual({ id: 1 });
    expect(open).toHaveBeenCalledOnce();
    expect(first.isActive()).toBe(false);
    expect(second.isActive()).toBe(true);
    expect(close).not.toHaveBeenCalled();

    expect(second.release()).toBe(true);
    await Promise.resolve();
    expect(close).toHaveBeenCalledWith({ id: 1 });
  });
});
