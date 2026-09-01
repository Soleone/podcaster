export interface ResourceOwner<T> {
  acquire(): ResourceLease<T>;
}

export interface ResourceLease<T> {
  readonly promise: Promise<T>;
  isActive(): boolean;
  /** Returns true when this release removed the last active lease. */
  release(): boolean;
}

/**
 * Shares one in-flight resource open across effect generations while keeping
 * cleanup tied to the last active owner. The microtask grace period covers
 * React StrictMode's setup/cleanup/setup sequence without retaining a handle
 * after an actual unmount.
 */
export function createResourceOwner<T>(open: () => Promise<T>, close: (resource: T) => void): ResourceOwner<T> {
  let pending: Promise<T> | undefined;
  let resource: T | undefined;
  let leaseCount = 0;
  let closeScheduled = false;

  const closeResource = (): void => {
    const current = resource;
    if (current === undefined) return;
    resource = undefined;
    pending = undefined;
    close(current);
  };

  const scheduleClose = (): void => {
    if (closeScheduled) return;
    closeScheduled = true;
    queueMicrotask(() => {
      closeScheduled = false;
      if (leaseCount !== 0) return;
      if (resource !== undefined) {
        closeResource();
        return;
      }
      const opening = pending;
      if (!opening) return;
      void opening.then(
        () => {
          if (leaseCount === 0 && pending === opening) closeResource();
        },
        () => {
          if (leaseCount === 0 && pending === opening) pending = undefined;
        },
      );
    });
  };

  const acquireResource = (): Promise<T> => {
    if (resource !== undefined) return pending ?? Promise.resolve(resource);
    if (pending) return pending;
    const opening = open().then(
      (value) => {
        if (pending === opening) resource = value;
        return value;
      },
      (error) => {
        if (pending === opening) pending = undefined;
        throw error;
      },
    );
    pending = opening;
    return opening;
  };

  return {
    acquire(): ResourceLease<T> {
      leaseCount++;
      let active = true;
      const promise = acquireResource();
      return {
        promise,
        isActive: () => active,
        release: () => {
          if (!active) return false;
          active = false;
          leaseCount--;
          const last = leaseCount === 0;
          if (last) scheduleClose();
          return last;
        },
      };
    },
  };
}
