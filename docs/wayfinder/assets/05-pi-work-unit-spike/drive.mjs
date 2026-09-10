// Minimal Fleet-shaped RPC driver: launch pi --mode rpc, send one prompt,
// consume the event stream, seal on submit_write, record usage + failure class.
import { spawn } from "node:child_process";
import fs from "node:fs";

const [, , repo, extPath, model, briefPath] = process.argv;
const brief = fs.readFileSync(briefPath, "utf8");

const child = spawn("pi", [
  "--mode", "rpc", "--model", model, "-e", extPath,
  "--tools", "read,bash,edit,write,grep,find,ls,submit_write",
  "--session-dir", `${process.cwd()}/sessions`, "-n", "spike-writer",
], { cwd: repo, stdio: ["pipe", "pipe", "pipe"] });

const state = {
  agentStarted: false, sealed: null, usage: null, model: null, provider: null,
  stopReasons: [], blocked: [], toolCalls: [], settled: false, exitCode: null,
};
const raw = fs.createWriteStream(`${process.cwd()}/events.jsonl`);

let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    raw.write(line + "\n");
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    handle(ev);
  }
});
child.stderr.on("data", (d) => process.stderr.write(`[pi:stderr] ${d}`));

function handle(ev) {
  switch (ev.type) {
    case "agent_start": state.agentStarted = true; break;
    case "tool_execution_start": state.toolCalls.push(ev.toolName); break;
    case "tool_execution_end":
      if (ev.toolName === "submit_write") state.sealed = ev.result?.details ?? null;
      if (ev.isError && /allowlist/.test(JSON.stringify(ev.result ?? ""))) state.blocked.push(ev.toolName);
      break;
    case "message_end":
      if (ev.message?.role === "assistant") {
        if (ev.message.usage) state.usage = ev.message.usage;
        state.model = ev.message.model ?? state.model;
        state.provider = ev.message.provider ?? state.provider;
        if (ev.message.stopReason) state.stopReasons.push(ev.message.stopReason);
      }
      break;
    case "agent_settled": state.settled = true; finish(); break;
  }
}

let done = false;
function finish() {
  if (done) return; done = true;
  child.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
  setTimeout(() => child.kill("SIGTERM"), 500);
}

child.on("exit", (code) => {
  state.exitCode = code;
  const failureClass = !state.agentStarted ? "infrastructure"
    : state.sealed ? "none"
    : state.stopReasons.includes("length") ? "quality:context-exhausted"
    : "quality:no-artifact";
  console.log(JSON.stringify({ ...state, failureClass }, null, 2));
  process.exit(0);
});

child.stdin.write(JSON.stringify({ type: "prompt", message: brief }) + "\n");
setTimeout(() => { console.error("launch/stage timeout"); finish(); }, 240000);
