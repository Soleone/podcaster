import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stopDetachedProcessGroup } from "../../../../spikes/pi-rpc/process-group.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function waitForPid(path: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await readFile(path, "utf8").catch(() => "");
    if (value) return Number(value);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("descendant PID was not written");
}

describe.skipIf(process.platform === "win32")("T1.1 spike process-group cleanup", () => {
  it("kills a stubborn descendant after the detached leader has exited", async () => {
    const directory = await mkdtemp(join(tmpdir(), "podcaster-spike-cleanup-"));
    directories.push(directory);
    const pidFile = join(directory, "descendant.pid");
    const leader = spawn(process.execPath, ["-e", `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      process.exit(0);
    `], { detached: true, stdio: "ignore" });
    let exited = false;
    leader.once("exit", () => { exited = true; });
    const descendantPid = await waitForPid(pidFile);
    for (let attempt = 0; attempt < 100 && !exited; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(exited).toBe(true);
    expect(() => process.kill(descendantPid, 0)).not.toThrow();

    await expect(stopDetachedProcessGroup(leader, () => exited, 500)).resolves.toMatchObject({ exited: true, groupGone: true });
    expect(() => process.kill(descendantPid, 0)).toThrow();
  });
});
