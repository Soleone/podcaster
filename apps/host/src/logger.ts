/**
 * Minimal host-side diagnostic logger. One parseable line per call, written to
 * stdout so `pnpm dev` and the scripted harnesses capture it. Kept tiny and
 * side-effect free for unit tests (they spy on process.stdout.write).
 */
export function log(source: string, message: string): void {
  process.stdout.write(`[${source}] ${message}\n`);
}
