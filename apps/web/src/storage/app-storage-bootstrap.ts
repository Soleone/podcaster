export interface ClosableStorageResource {
  close(): void;
}

export interface AppStorageBootstrap<Settings extends ClosableStorageResource, CustomVoices extends ClosableStorageResource> {
  promise: Promise<{ settings: Settings | undefined; customVoices: CustomVoices | undefined }>;
  isCurrent(): boolean;
  close(): void;
}

/**
 * Acquires the App-owned storage handles for one effect generation. A stale
 * generation closes anything it opened without touching a newer generation's
 * handles. Settings failure is independent from custom-voice storage failure.
 */
export function beginAppStorageBootstrap<Settings extends ClosableStorageResource, CustomVoices extends ClosableStorageResource>(
  generation: number,
  currentGeneration: () => number,
  openSettings: () => Promise<Settings>,
  openCustomVoices: () => Promise<CustomVoices>,
  onSettingsOpened: (store: Settings) => void,
  onCustomVoicesOpened: (store: CustomVoices) => void,
): AppStorageBootstrap<Settings, CustomVoices> {
  let cancelled = false;
  let settings: Settings | undefined;
  let customVoices: CustomVoices | undefined;
  let settingsClosed = false;
  let customVoicesClosed = false;

  const isCurrent = (): boolean => !cancelled && currentGeneration() === generation;
  const closeSettings = (): void => {
    if (!settings || settingsClosed) return;
    settingsClosed = true;
    settings.close();
  };
  const closeCustomVoices = (): void => {
    if (!customVoices || customVoicesClosed) return;
    customVoicesClosed = true;
    customVoices.close();
  };

  const acquire = async <Resource extends ClosableStorageResource>(
    open: () => Promise<Resource>,
    assign: (resource: Resource) => void,
    close: () => void,
    onOpened: (resource: Resource) => void,
  ): Promise<Resource | undefined> => {
    let resource: Resource;
    try {
      resource = await open();
    } catch {
      return undefined;
    }
    assign(resource);
    if (!isCurrent()) {
      close();
      return undefined;
    }
    onOpened(resource);
    return resource;
  };

  const promise = (async () => {
    const openedSettings = await acquire(openSettings, resource => { settings = resource; }, closeSettings, onSettingsOpened);
    const openedCustomVoices = isCurrent()
      ? await acquire(openCustomVoices, resource => { customVoices = resource; }, closeCustomVoices, onCustomVoicesOpened)
      : undefined;
    return { settings: openedSettings, customVoices: openedCustomVoices };
  })();

  return {
    promise,
    isCurrent,
    close: () => {
      cancelled = true;
      closeSettings();
      closeCustomVoices();
    },
  };
}
