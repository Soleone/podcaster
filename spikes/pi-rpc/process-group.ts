import type { ChildProcess } from "node:child_process";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface ProcessGroupCleanup { exited: boolean; groupSignalUsed: boolean; groupGone: boolean }

export async function stopDetachedProcessGroup(
  child: ChildProcess,
  leaderExited: () => boolean,
  timeoutMs = 1_200,
): Promise<ProcessGroupCleanup> {
  const pid = child.pid;
  if (!pid) return { exited: leaderExited(), groupSignalUsed: false, groupGone: true };
  const groupSignalUsed = process.platform !== "win32";
  const target = groupSignalUsed ? -pid : pid;
  const alive = () => {
    try { process.kill(target, 0); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };
  const signal = (name: NodeJS.Signals) => {
    try { if (groupSignalUsed) process.kill(target, name); else child.kill(name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  const waitForGone = async () => {
    const deadline = Date.now() + timeoutMs;
    while (alive() && Date.now() < deadline) await wait(10);
    return !alive();
  };

  if (alive()) signal("SIGTERM");
  if (!(await waitForGone())) {
    signal("SIGKILL");
    if (!(await waitForGone())) throw new Error("detached process group survived SIGKILL");
  }
  return { exited: true, groupSignalUsed, groupGone: true };
}
