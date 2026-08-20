import { describe, expect, it } from 'vitest';
import { beginAppStorageBootstrap } from './app-storage-bootstrap';

interface FakeResource {
  closeCount: number;
  close(): void;
}

function resource(): FakeResource {
  return {
    closeCount: 0,
    close() { this.closeCount++; },
  };
}

describe('App storage bootstrap', () => {
  it('opens custom storage once across StrictMode-like setup and cleanup', async () => {
    let generation = 1;
    let settingsOpens = 0;
    let customVoiceOpens = 0;
    const firstSettingsResource = resource();
    const secondSettingsResource = resource();
    const secondCustomVoiceResource = resource();
    let resolveFirstSettings!: (value: FakeResource) => void;
    const firstSettings = new Promise<FakeResource>(resolve => { resolveFirstSettings = resolve; });

    const openSettings = (): Promise<FakeResource> => {
      settingsOpens++;
      return settingsOpens === 1 ? firstSettings : Promise.resolve(secondSettingsResource);
    };
    const openCustomVoices = (): Promise<FakeResource> => {
      customVoiceOpens++;
      return Promise.resolve(secondCustomVoiceResource);
    };

    const first = beginAppStorageBootstrap(1, () => generation, openSettings, openCustomVoices, () => undefined, () => undefined);
    first.close();
    generation = 2;
    const second = beginAppStorageBootstrap(2, () => generation, openSettings, openCustomVoices, () => undefined, () => undefined);
    resolveFirstSettings(firstSettingsResource);

    await Promise.all([first.promise, second.promise]);
    expect(settingsOpens).toBe(2);
    expect(customVoiceOpens).toBe(1);
    expect(firstSettingsResource.closeCount).toBe(1);
    expect(secondSettingsResource.closeCount).toBe(0);
    expect(secondCustomVoiceResource.closeCount).toBe(0);

    second.close();
    expect(secondSettingsResource.closeCount).toBe(1);
    expect(secondCustomVoiceResource.closeCount).toBe(1);
  });
});
