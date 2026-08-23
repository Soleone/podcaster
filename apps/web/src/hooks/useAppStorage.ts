import { useEffect, useRef, useState, type RefObject } from 'react';
import { CustomVoiceStore, type CustomVoiceRecord } from '../storage/custom-voice-store';
import { SettingsStore } from '../settings/settings-store';
import { createResourceOwner } from '../storage/resource-lifecycle';

export interface AppStorageResources {
  settings: SettingsStore;
  customVoices: CustomVoiceStore;
}

async function openAppStorageResources(): Promise<AppStorageResources> {
  const settings = await SettingsStore.open();
  try {
    return { settings, customVoices: await CustomVoiceStore.open() };
  } catch (error) {
    settings.close();
    throw error;
  }
}

function closeAppStorageResources(resources: AppStorageResources): void {
  try {
    resources.settings.close();
  } finally {
    resources.customVoices.close();
  }
}

export interface AppStorage {
  /** Shared resource owner; additional consumers may acquire their own lease. */
  owner: ReturnType<typeof createResourceOwner<AppStorageResources>>;
  settingsStoreRef: RefObject<SettingsStore | undefined>;
  customVoiceStoreRef: RefObject<CustomVoiceStore | undefined>;
  customVoices: CustomVoiceRecord[];
  customVoicesRef: RefObject<CustomVoiceRecord[]>;
  setCustomVoices: (voices: CustomVoiceRecord[]) => void;
  /**
   * Resolves once the current effect generation has assigned the store
   * references and loaded the stored custom voices. Resolves even when local
   * storage is unavailable so consumers can proceed with in-memory defaults.
   */
  ready: Promise<void>;
}

/**
 * Owns the browser-local stores (settings + custom voices) behind a resource
 * owner so StrictMode's setup/cleanup/setup sequence never leaks handles.
 * Store consumers read the refs synchronously; the `ready` promise gates
 * consumers that must wait for the stored rows to be loaded.
 */
export function useAppStorage(): AppStorage {
  const ownerRef = useRef<ReturnType<typeof createResourceOwner<AppStorageResources>> | undefined>(undefined);
  if (!ownerRef.current) ownerRef.current = createResourceOwner(openAppStorageResources, closeAppStorageResources);
  const settingsStoreRef = useRef<SettingsStore | undefined>(undefined);
  const customVoiceStoreRef = useRef<CustomVoiceStore | undefined>(undefined);
  const [customVoices, setCustomVoices] = useState<CustomVoiceRecord[]>([]);
  const customVoicesRef = useRef(customVoices);
  customVoicesRef.current = customVoices;

  // One ready promise per hook instance. The acquisition effect resolves it
  // for its generation; StrictMode's second setup run resolves it again,
  // which is a no-op.
  const readyRef = useRef<{ promise: Promise<void>; resolve: () => void } | undefined>(undefined);
  if (!readyRef.current) {
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => {
      resolve = settle;
    });
    readyRef.current = { promise, resolve };
  }

  useEffect(() => {
    const lease = ownerRef.current!.acquire();
    const opening = lease.promise;
    let owned: AppStorageResources | undefined;
    void (async () => {
      try {
        const resources = await opening;
        if (!lease.isActive()) return;
        owned = resources;
        settingsStoreRef.current = resources.settings;
        customVoiceStoreRef.current = resources.customVoices;
        const storedCustomVoices = await resources.customVoices.list();
        if (!lease.isActive()) return;
        customVoicesRef.current = storedCustomVoices;
        setCustomVoices(storedCustomVoices);
      } catch {
        // Keep the in-memory defaults when local storage is unavailable.
      } finally {
        if (lease.isActive()) readyRef.current!.resolve();
      }
    })();
    return () => {
      const last = lease.release();
      if (!last) return;
      // A newer effect generation still owns shared handles when release()
      // returns false. Only the last generation may clear these references.
      if (!owned || settingsStoreRef.current === owned.settings) settingsStoreRef.current = undefined;
      if (!owned || customVoiceStoreRef.current === owned.customVoices) customVoiceStoreRef.current = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    owner: ownerRef.current,
    settingsStoreRef,
    customVoiceStoreRef,
    customVoices,
    customVoicesRef,
    setCustomVoices,
    ready: readyRef.current.promise,
  };
}
