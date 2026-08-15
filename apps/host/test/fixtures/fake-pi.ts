import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FakePiScenario = "normal" | "slow" | "malformed" | "oversized" | "invalid-utf8" | "unicode-separator" | "crlf" | "crash" | "login" | "rate-limit" | "async-login" | "async-rate-limit" | "too-many-words" | "stubborn-descendant" | "incompatible-model" | "unrelated-probe" | "tools";

export interface FakePi { executable: string; log: string; cleanup(): Promise<void> }

export async function makeFakePi(scenario: FakePiScenario = "normal", version = "0.84.2"): Promise<FakePi> {
  const directory = await mkdtemp(join(tmpdir(), "podcaster-fake-pi-"));
  const executable = join(directory, "pi");
  const log = join(directory, "calls.jsonl");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const scenario = ${JSON.stringify(scenario)};
const log = ${JSON.stringify(log)};
if (process.argv[2] === "--version") { process.stdout.write(${JSON.stringify(version)} + "\\n"); process.exit(0); }
fs.appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env).sort(), pid: process.pid }) + "\\n");
if (scenario === "stubborn-descendant") { const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio:"ignore" }); fs.appendFileSync(log, JSON.stringify({ descendantPid: descendant.pid }) + "\\n"); }
const send = (v) => process.stdout.write(JSON.stringify(v) + "\\n");
let buffer = ""; let timers = []; let aborted = false;
const later = (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t); };
process.stdin.on("data", chunk => { buffer += chunk; let i; while ((i = buffer.indexOf("\\n")) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (line) command(JSON.parse(line)); } });
function command(c) {
  fs.appendFileSync(log, JSON.stringify({ command: c.type, message: c.message }) + "\\n");
  if (c.type === "get_state") return send({ type:"response", id:c.id, command:c.type, success:true, data:{ model:{ provider:"openai-codex", id:"gpt-5.6-sol" }, isStreaming:false } });
  if (c.type === "get_available_models") return send({ type:"response", id:c.id, command:c.type, success:true, data:{ models: scenario === "incompatible-model" ? [] : [{ provider:"openai-codex", id:"gpt-5.6-sol" }] } });
  if (c.type === "abort") { timers.forEach(clearTimeout); timers = []; aborted = true; send({type:"message_end", message:{role:"assistant", stopReason:"aborted", errorMessage:"aborted"}}); send({type:"agent_settled"}); later(() => send({ type:"response", id:c.id, command:c.type, success:true }), 2); return; }
  if (c.type !== "prompt") return;
  if (scenario === "login") return send({type:"response", id:c.id, command:c.type, success:false, error:"sign-in required token=<secret>"});
  if (scenario === "rate-limit") return send({type:"response", id:c.id, command:c.type, success:false, error:"HTTP 429 quota"});
  send({type:"response", id:c.id, command:c.type, success:true});
  if (scenario === "malformed") return process.stdout.write("{bad\\n");
  if (scenario === "oversized") return process.stdout.write("x".repeat(1024 * 1024 + 1));
  if (scenario === "invalid-utf8") return process.stdout.write(Buffer.from([0xc3, 0x28, 0x0a]));
  if (scenario === "crlf") return process.stdout.write(JSON.stringify({type:"agent_settled"}) + "\\r\\n");
  if (scenario === "crash") return process.exit(7);
  if (scenario === "async-login" || scenario === "async-rate-limit") { send({type:"message_end", message:{role:"assistant", stopReason:"error", errorMessage: scenario === "async-login" ? "unauthorized bearer SUPERSECRET" : "HTTP 429 quota"}}); return send({type:"agent_settled"}); }
  const probe = c.message === "Reply with exactly RPC_READY and no other text.";
  aborted = false;
  const delay = scenario === "slow" ? 40 : 2;
  send({type:"agent_start"});
  if (scenario === "tools") send({type:"tool_execution_start", toolCallId:"tool-1", toolName:"grep", args:{pattern:"Metroidvania"}});
  later(() => send({type:"message_update", assistantMessageEvent:{type:"thinking_delta", delta:"PRIVATE"}}), delay);
  later(() => send({type:"message_update", assistantMessageEvent:{type:"text_delta", delta: scenario === "too-many-words" ? Array(46).fill("word").join(" ") : (probe ? (scenario === "unrelated-probe" ? "NOT_THE_MARKER" : "RPC_READY") : "Hello")}}), delay + 2);
  if (!probe) later(() => send({type:"message_update", assistantMessageEvent:{type:"text_delta", delta: scenario === "unicode-separator" ? "\\u2028world" : " world"}}), delay + 5);
  if (scenario === "tools") later(() => send({type:"tool_execution_end", toolCallId:"tool-1", toolName:"grep", result:{hits:1, secret:"PRIVATE_CONTENT"}}), delay + 4);
  later(() => { if (!aborted) { send({type:"message_end", message:{role:"assistant", stopReason:"stop"}}); send({type:"agent_settled"}); } }, delay + 8);
}
process.on("SIGTERM", () => process.exit(0));
`;
  await writeFile(executable, source, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { executable, log, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
