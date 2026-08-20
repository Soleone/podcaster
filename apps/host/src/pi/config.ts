import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export class PiExecutableConfigurationError extends Error {
  constructor(detail: string) {
    super(`Pi executable configuration is invalid: ${detail}`);
    this.name = "PiExecutableConfigurationError";
  }
}

function executableAt(candidate: string, explicit: boolean): string | undefined {
  try {
    const canonical = realpathSync(candidate);
    if (explicit && canonical !== candidate) throw new PiExecutableConfigurationError("the explicit path must be canonical");
    if (!statSync(canonical).isFile()) return undefined;
    accessSync(canonical, constants.X_OK);
    return canonical;
  } catch (error) {
    if (error instanceof PiExecutableConfigurationError) throw error;
    return undefined;
  }
}

export function resolvePiExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PODCASTER_PI_EXECUTABLE;
  if (configured !== undefined) {
    if (!isAbsolute(configured)) throw new PiExecutableConfigurationError("PODCASTER_PI_EXECUTABLE must be absolute");
    const executable = executableAt(configured, true);
    if (!executable) throw new PiExecutableConfigurationError("PODCASTER_PI_EXECUTABLE must name an executable file");
    return executable;
  }

  for (const entry of (env.PATH ?? "").split(delimiter)) {
    const directory = entry ? resolve(entry) : process.cwd();
    const executable = executableAt(join(directory, "pi"), false);
    if (executable) return executable;
  }
  throw new PiExecutableConfigurationError("no executable named pi was found on PATH");
}
