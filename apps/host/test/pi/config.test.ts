import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolvePiExecutable } from '../../src/pi/config.js';
import { StdioPiClient } from '../../src/pi/PiClient.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'podcaster-pi-config-'));
  directories.push(directory);
  return directory;
}
async function executable(path: string, mode = 0o700): Promise<void> {
  await writeFile(path, '#!/bin/sh\nexit 0\n', { mode });
  await chmod(path, mode);
}

function environment(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return values;
}

describe('Pi executable resolution', () => {
  it('accepts an absolute canonical executable override', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'pi');
    await executable(path);

    expect(resolvePiExecutable(environment({ PODCASTER_PI_EXECUTABLE: path, PATH: '' }))).toBe(path);
  });

  it('scans PATH in order and returns a canonical target', async () => {
    const directory = await temporaryDirectory();
    const first = join(directory, 'first');
    const second = join(directory, 'second');
    await mkdir(first);
    await mkdir(second);
    await executable(join(first, 'pi'), 0o600);
    const target = join(second, 'real-pi');
    await executable(target);
    await symlink(target, join(second, 'pi'));

    expect(resolvePiExecutable(environment({ PATH: [first, second].join(delimiter) }))).toBe(target);
  });

  it('rejects relative and non-canonical explicit paths', async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, 'real-pi');
    const link = join(directory, 'pi');
    await executable(target);
    await symlink(target, link);

    expect(() =>
      resolvePiExecutable(environment({ PODCASTER_PI_EXECUTABLE: './pi', PATH: '/private/secret' })),
    ).toThrow(/absolute/iu);
    expect(() => resolvePiExecutable(environment({ PODCASTER_PI_EXECUTABLE: link, PATH: '' }))).toThrow(/canonical/iu);
  });

  it('rejects absent or non-executable Pi without exposing environment values', async () => {
    const directory = await temporaryDirectory();
    const missingPath = join(directory, 'missing-pi');
    const pathEntry = join(directory, 'bin');
    await mkdir(pathEntry);
    const missing = () => resolvePiExecutable(environment({ PATH: `${pathEntry}:${missingPath}` }));
    expect(missing).toThrow(/no executable named pi/iu);
    expect(() =>
      resolvePiExecutable(environment({ PODCASTER_PI_EXECUTABLE: missingPath, PATH: '/private/token-value' })),
    ).toThrow(/executable file/iu);
    let caught: unknown;
    try {
      resolvePiExecutable(environment({ PATH: '/private/token-value' }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain('token-value');
  });

  it('keeps explicit client executables independent of the environment resolver', async () => {
    vi.stubEnv('PODCASTER_PI_EXECUTABLE', 'relative/pi');
    const client = new StdioPiClient({ executable: '/explicit/pi' });
    await client.shutdown();
  });

  it('maps an invalid default configuration to unavailable readiness', async () => {
    const directory = await temporaryDirectory();
    vi.stubEnv('PODCASTER_PI_EXECUTABLE', join(directory, 'missing-pi'));
    const client = new StdioPiClient({ startupDeadlineMs: 50, requestDeadlineMs: 50 });

    await expect(client.probe()).resolves.toMatchObject({ status: 'unavailable', detail: 'Pi is unavailable.' });
    await client.shutdown();
  });
});
