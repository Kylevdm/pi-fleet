/**
 * Rung 1 — Pi work-unit driver (ticket 25).
 *
 * Seven named fixture tests over the faked Pi seam:
 *
 *   1. classification either side of `agent_start`
 *   2. usage summed with the 5,970 vs 41,503 regression fixture
 *   3. `agent_settled` (not `agent_end`) ends a run
 *   4. LF-only framing with a U+2028 fixture
 *   5. launch timeout to first `agent_start`
 *   6. termination ladder records its rung
 *   7. seal only on a schema-valid `submit_*`
 *
 * Plus a handful of supporting tests for the pure functions the
 * orchestrator is built from, so a regression in any one piece is
 * attributable to the right slice.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ATTEMPT_TRANSCRIPT_CAP_BYTES,
  JOB_TRANSCRIPT_CAP_BYTES,
  classify,
  discoverSessionFile,
  parseEvent,
  parseJsonlLines,
  resolvePiBinary,
  runStage,
  scrubSessionFile,
  sessionName,
  summarise,
  sumUsage,
  terminate,
  validateSubmitPayload,
  zeroUsage,
} from "../src/pi-driver.ts";
import type { PiEvent, RunStageOptions, StageSummary } from "../src/pi-driver.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const STUB_PATH = join(REPO_ROOT, "src", "pi-stub.ts");
const NODE_BIN = process.execPath;

function freshTmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function spawnStub(extraEnv: Record<string, string> = {}): ReturnType<typeof spawn> {
  return spawn(NODE_BIN, ["--experimental-strip-types", STUB_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
}

function buildEventStreamFixture(): PiEvent[] {
  // A canonical Pi-style stream for the orchestration tests.
  return [
    { type: "agent_start" },
    { type: "turn_start" },
    {
      type: "message_start",
      message: { role: "assistant", usage: { input: 100, output: 0 } },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        usage: {
          input: 100,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 150,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        model: "minimax-m3",
        provider: "opencode-go",
        stopReason: "tool_use",
      },
    },
    {
      type: "tool_execution_start",
      toolName: "submit_write",
    },
    {
      type: "tool_execution_end",
      toolName: "submit_write",
      result: {
        details: {
          summary: "Did the thing",
          filesTouched: ["calc.js"],
          commandsRun: ["node -e \"console.log(1)\""],
          contractMet: true,
        },
      },
    },
    { type: "agent_settled" },
  ];
}

// ---------------------------------------------------------------------------
// (4) LF-only framing.
// ---------------------------------------------------------------------------

describe("driver (4) — LF-only framing", () => {
  it("splits on LF only, leaving U+2028 inside the line", () => {
    const lines = parseJsonlLines('{"a":1}\n{"b":"x\u2028y"}\n{"c":3}\n');
    assert.deepStrictEqual(lines, ['{"a":1}', '{"b":"x\u2028y"}', '{"c":3}']);
  });

  it("strips a trailing CR (Pi uses \\r\\n) without affecting the JSON", () => {
    const lines = parseJsonlLines('{"a":1}\r\n{"b":2}\r\n');
    assert.deepStrictEqual(lines, ['{"a":1}', '{"b":2}']);
  });

  it("an empty buffer yields no lines", () => {
    assert.deepStrictEqual(parseJsonlLines(""), []);
  });

  it("consecutive LFs and trailing LFs drop empty lines", () => {
    const lines = parseJsonlLines("\n\n{\"a\":1}\n\n{\"b\":2}\n");
    assert.deepStrictEqual(lines, ['{"a":1}', '{"b":2}']);
  });

  it("a CR alone (no LF) is part of the line — frames stay merged", () => {
    // CR alone is not a frame boundary; LF is. The CR sits inside the
    // JSON string and stays there after framing.
    const lines = parseJsonlLines('{"a":"x\ry"}\n');
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0], '{"a":"x\ry"}');
  });

  it("every fixture line is parseable as a PiEvent", () => {
    for (const line of parseJsonlLines(
      '{"type":"agent_start"}\n{"type":"agent_settled"}\n',
    )) {
      const ev = parseEvent(line);
      assert.ok(ev !== null, `parse failed for ${line}`);
      assert.strictEqual(ev.type.length > 0, true);
    }
  });
});

// ---------------------------------------------------------------------------
// (1) classification either side of agent_start.
// ---------------------------------------------------------------------------

describe("driver (1) — classification either side of agent_start", () => {
  it("an event stream with no agent_start classifies as infrastructure", () => {
    const events: PiEvent[] = [
      { type: "turn_start" },
      { type: "message_start" },
    ];
    assert.strictEqual(classify(events), "infrastructure");
    const summary = summarise(events);
    assert.strictEqual(summary.agentStarted, false);
  });

  it("an event stream with agent_start but no submit_* classifies as quality", () => {
    const events: PiEvent[] = [
      { type: "agent_start" },
      { type: "message_end", message: { role: "assistant", stopReason: "length" } },
    ];
    assert.strictEqual(classify(events), "quality");
    const summary = summarise(events);
    assert.strictEqual(summary.agentStarted, true);
    assert.strictEqual(summary.sealed, null);
  });

  it("an event stream with a sealed submit_* classifies as sealed", () => {
    const events = buildEventStreamFixture();
    assert.strictEqual(classify(events), "sealed");
    const summary = summarise(events);
    assert.ok(summary.sealed !== null, "summary.sealed should be set");
    assert.strictEqual(summary.sealedTool, "submit_write");
  });

  it("summarise reports usage, model, provider, stop reasons, tool calls", () => {
    const events = buildEventStreamFixture();
    const s = summarise(events);
    assert.strictEqual(s.usage.input, 100);
    assert.strictEqual(s.usage.output, 50);
    assert.strictEqual(s.usage.totalTokens, 150);
    assert.strictEqual(s.model, "minimax-m3");
    assert.strictEqual(s.provider, "opencode-go");
    assert.deepStrictEqual([...s.stopReasons], ["tool_use"]);
    assert.deepStrictEqual([...s.toolCalls], ["submit_write"]);
    assert.strictEqual(s.settled, true);
  });
});

// ---------------------------------------------------------------------------
// (2) usage summed with regression fixture.
// ---------------------------------------------------------------------------

describe("driver (2) — usage summed across assistant message_end", () => {
  it("sums 5,970 input + 41,503 output across many messages", () => {
    // Two assistant messages with usage, plus a user message_end that must
    // be ignored (only assistant counts), plus a non-message event that
    // must be ignored.
    const events: PiEvent[] = [
      {
        type: "message_end",
        message: {
          role: "assistant",
          usage: {
            input: 1000,
            output: 20000,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 21000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          model: "x",
          provider: "y",
        },
      },
      {
        type: "message_end",
        message: {
          role: "user",
          usage: { input: 99999, output: 99999 },
        },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          usage: {
            input: 4970,
            output: 21503,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 26473,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          model: "x",
          provider: "y",
        },
      },
      { type: "tool_execution_end", toolName: "submit_write" },
    ];
    const total = sumUsage(events);
    assert.strictEqual(total.input, 5_970, "input must be the regression fixture value");
    assert.strictEqual(total.output, 41_503, "output must be the regression fixture value");
    assert.strictEqual(total.totalTokens, 47_473);
  });

  it("an empty stream yields zero usage", () => {
    assert.deepStrictEqual(sumUsage([]), zeroUsage());
  });

  it("a stream with no assistant message_end yields zero usage", () => {
    const events: PiEvent[] = [
      { type: "agent_start" },
      { type: "message_end", message: { role: "user" } },
    ];
    const total = sumUsage(events);
    assert.strictEqual(total.input, 0);
    assert.strictEqual(total.output, 0);
  });

  it("usage summing is order-independent", () => {
    const a: PiEvent[] = [
      { type: "message_end", message: { role: "assistant", usage: { input: 5, output: 7, totalTokens: 12 } } },
      { type: "message_end", message: { role: "assistant", usage: { input: 10, output: 14, totalTokens: 24 } } },
    ];
    const b: PiEvent[] = [a[1] as PiEvent, a[0] as PiEvent];
    assert.deepStrictEqual(sumUsage(a), sumUsage(b));
  });
});

// ---------------------------------------------------------------------------
// (3) agent_settled (not agent_end) ends a run.
// ---------------------------------------------------------------------------

describe("driver (3) — agent_settled ends a run; agent_end does not", () => {
  it("agent_settled marks settled: true", () => {
    const events: PiEvent[] = [
      { type: "agent_start" },
      { type: "agent_settled" },
    ];
    const s = summarise(events);
    assert.strictEqual(s.settled, true);
  });

  it("agent_end does not mark settled: true", () => {
    const events: PiEvent[] = [
      { type: "agent_start" },
      { type: "agent_end" },
    ];
    const s = summarise(events);
    assert.strictEqual(s.settled, false);
    // And without a submit_*, it remains a quality failure.
    assert.strictEqual(classify(events), "quality");
  });

  it("agent_settled followed by more events still reports settled", () => {
    const events: PiEvent[] = [
      { type: "agent_start" },
      { type: "agent_settled" },
      { type: "tool_execution_start", toolName: "bash" },
    ];
    const s = summarise(events);
    assert.strictEqual(s.settled, true);
    // The post-settled tool call is recorded — the orchestrator, not the
    // summariser, is responsible for stopping on agent_settled.
    assert.deepStrictEqual([...s.toolCalls], ["bash"]);
  });
});

// ---------------------------------------------------------------------------
// (7) seal only on schema-valid submit_*.
// ---------------------------------------------------------------------------

describe("driver (7) — seal only on schema-valid submit_*", () => {
  it("validateSubmitPayload accepts the canonical submit_write shape", () => {
    const ok = validateSubmitPayload({
      summary: "Did the thing",
      filesTouched: ["a.js"],
      commandsRun: ["node -e '1'"],
      contractMet: true,
    });
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.reason, null);
  });

  it("validateSubmitPayload rejects a non-object", () => {
    const v = validateSubmitPayload("not an object");
    assert.strictEqual(v.ok, false);
    assert.match(v.reason ?? "", /must be an object/);
  });

  it("validateSubmitPayload rejects a missing summary", () => {
    const v = validateSubmitPayload({
      filesTouched: [],
      commandsRun: [],
      contractMet: true,
    });
    assert.strictEqual(v.ok, false);
    assert.match(v.reason ?? "", /summary/);
  });

  it("validateSubmitPayload rejects a non-array filesTouched", () => {
    const v = validateSubmitPayload({
      summary: "x",
      filesTouched: "calc.js",
      commandsRun: [],
      contractMet: true,
    });
    assert.strictEqual(v.ok, false);
    assert.match(v.reason ?? "", /filesTouched/);
  });

  it("validateSubmitPayload rejects a non-string element of filesTouched", () => {
    const v = validateSubmitPayload({
      summary: "x",
      filesTouched: [1, 2, 3],
      commandsRun: [],
      contractMet: true,
    });
    assert.strictEqual(v.ok, false);
    assert.match(v.reason ?? "", /filesTouched/);
  });

  it("validateSubmitPayload rejects a missing contractMet", () => {
    const v = validateSubmitPayload({
      summary: "x",
      filesTouched: [],
      commandsRun: [],
    });
    assert.strictEqual(v.ok, false);
    assert.match(v.reason ?? "", /contractMet/);
  });

  it("summarise refuses to seal a submit_* whose payload fails validation", () => {
    const events: PiEvent[] = [
      { type: "agent_start" },
      {
        type: "tool_execution_end",
        toolName: "submit_write",
        result: {
          details: {
            summary: 42, // wrong type
            filesTouched: ["calc.js"],
            commandsRun: [],
            contractMet: true,
          },
        },
      },
    ];
    const s = summarise(events);
    assert.strictEqual(s.submitted, true);
    assert.strictEqual(s.sealed, null, "an invalid payload must not seal the stage");
    assert.strictEqual(classify(events), "quality");
  });

  it("summarise refuses to seal a submit_* whose result is marked isError", () => {
    const events: PiEvent[] = [
      { type: "agent_start" },
      {
        type: "tool_execution_end",
        toolName: "submit_write",
        result: { details: { summary: "x", filesTouched: [], commandsRun: [], contractMet: true }, isError: true },
      },
    ];
    const s = summarise(events);
    assert.strictEqual(s.sealed, null);
    assert.strictEqual(s.submitted, true);
  });
});

// ---------------------------------------------------------------------------
// (5) launch timeout.
// ---------------------------------------------------------------------------

describe("driver (5) — launch timeout to first agent_start", () => {
  it("no agent_start within the launch window classifies as infrastructure", async () => {
    const dir = freshTmp("fleet-r1-launch-");
    const stageDir = join(dir, "stage");
    const sessionDir = join(stageDir, "session");
    const artifactPath = join(stageDir, "artifact.json");

    // Spawn a stub that never emits agent_start: a Node script that emits
    // only `turn_start` and then waits. `piBinary` is therefore
    // `process.execPath` and the script path is passed as argv[0]? No — the
    // driver invokes `piBinary` with its own argv. We wrap the script as
    // the `piBinary` itself by passing a node invocation via `cwd`: simpler
    // is to make `piBinary` a one-liner script and rely on the kernel.
    // mkstemp it and chmod +x.
    const sleeper = join(dir, "sleeper.mjs");
    writeFileSync(
      sleeper,
      "#!/usr/bin/env node\n" +
      "process.stdout.write('{\"type\":\"turn_start\"}\\n');\n" +
      "setTimeout(() => process.exit(0), 60_000);\n",
    );
    const { chmodSync } = await import("node:fs");
    chmodSync(sleeper, 0o755);

    const result = await runStage({
      jobId: "01JQQ000000000000000000000",
      stageIndex: 0,
      attempt: 1,
      piBinary: sleeper,
      artifactPath,
      stageDir,
      sessionDir,
      launchTimeoutMs: 200,
      stageTimeoutMs: 60_000,
    });
    assert.strictEqual(result.outcome.kind, "infra");
    if (result.outcome.kind === "infra") {
      assert.match(result.outcome.reason, /launch/i);
    }
  });
});

// ---------------------------------------------------------------------------
// (6) termination ladder records its rung.
// ---------------------------------------------------------------------------

describe("driver (6) — termination ladder records its rung", () => {
  it("abort rung: a child that exits on abort yields rung=abort", async () => {
    // Build a tiny script that exits when it reads "abort" on stdin.
    const dir = freshTmp("fleet-r1-abort-");
    const script = join(dir, "abort.mjs");
    writeFileSync(
      script,
      "let buf = '';\n" +
      "process.stdin.setEncoding('utf8');\n" +
      "process.stdin.on('data', d => {\n" +
      "  buf += d;\n" +
      "  if (buf.includes('\"abort\"')) process.exit(0);\n" +
      "});\n" +
      "setTimeout(() => process.exit(0), 5_000);\n",
    );
    const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
    const rung = await terminate(child, { sigtermToSigkillMs: 1_000 });
    assert.strictEqual(rung, "abort");
  });

  it("SIGTERM rung: a child that ignores abort but dies on SIGTERM yields rung=sigterm", async () => {
    const dir = freshTmp("fleet-r1-sigterm-");
    const script = join(dir, "sigterm.mjs");
    writeFileSync(
      script,
      "process.stdin.on('data', () => {});\n" +
      "process.on('SIGTERM', () => process.exit(0));\n" +
      "setInterval(() => {}, 1000);\n",
    );
    const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
    const rung = await terminate(child, { sigtermToSigkillMs: 2_000 });
    assert.strictEqual(rung, "sigterm");
  });

  it("SIGKILL rung: a child that ignores abort and SIGTERM yields rung=sigkill", async () => {
    const dir = freshTmp("fleet-r1-sigkill-");
    const script = join(dir, "sigkill.mjs");
    writeFileSync(
      script,
      "process.stdin.on('data', () => {});\n" +
      "process.on('SIGTERM', () => {});\n" +
      "setInterval(() => {}, 1000);\n",
    );
    const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
    const rung = await terminate(child, { sigtermToSigkillMs: 500 });
    assert.strictEqual(rung, "sigkill");
  });

  it("none rung: a child that exits cleanly before any rung fires", async () => {
    const dir = freshTmp("fleet-r1-none-");
    const script = join(dir, "fast.mjs");
    writeFileSync(script, "process.exit(0);\n");
    const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
    const rung = await terminate(child, { sigtermToSigkillMs: 500 });
    assert.strictEqual(rung, "none");
  });

  it("none rung: a child already dead by signal is recognised, not walked down the ladder", async () => {
    // A child killed by a signal leaves exitCode null and sets signalCode.
    // Reading "exitCode === null" as "still running" means every rung waits
    // for an `exit` event that has already fired and will never fire again:
    // 50ms + 10s abort + 30s SIGTERM + 5s, then a "sigkill" verdict on a
    // process nothing in this ladder killed. Reachable from runStage's
    // launch-timeout path whenever Pi is OOM-killed or segfaults at start.
    const dir = freshTmp("fleet-r1-signalled-");
    const script = join(dir, "spin.mjs");
    writeFileSync(script, "process.stdin.on('data', () => {});\nsetInterval(() => {}, 1000);\n");
    const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });

    // Kill it out from under the ladder and wait until Node has reaped it.
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGKILL");
    });
    assert.strictEqual(child.exitCode, null, "a signalled child has no exit code");
    assert.strictEqual(child.signalCode, "SIGKILL", "it has a signal code instead");

    const started = Date.now();
    const rung = await terminate(child, { sigtermToSigkillMs: 30_000 });
    const elapsed = Date.now() - started;

    assert.strictEqual(rung, "none", "the ladder did not end this process");
    assert.ok(elapsed < 1_000, `returns promptly; took ${elapsed}ms`);
  });
});

// ---------------------------------------------------------------------------
// Supporting tests: session, scrubbing, caps, intent, binary resolution.
// ---------------------------------------------------------------------------

describe("driver — supporting helpers", () => {
  it("sessionName joins jobId, stageIndex, attempt deterministically", () => {
    assert.strictEqual(sessionName("01JQQ000000000000000000000", 0, 1), "01JQQ000000000000000000000-0-1");
    assert.strictEqual(sessionName("01JQQ000000000000000000000", 7, 2), "01JQQ000000000000000000000-7-2");
  });

  it("resolvePiBinary honours PI_FLEET_PI_BIN first", () => {
    const got = resolvePiBinary({
      configured: "/from/config",
      env: { PI_FLEET_PI_BIN: "/from/env" },
      defaultPath: "/from/default",
    });
    assert.strictEqual(got, "/from/env");
  });

  it("resolvePiBinary falls back to configured when env is absent", () => {
    const got = resolvePiBinary({
      configured: "/from/config",
      env: {},
      defaultPath: "/from/default",
    });
    assert.strictEqual(got, "/from/config");
  });

  it("resolvePiBinary falls back to defaultPath when nothing else is set", () => {
    const got = resolvePiBinary({
      configured: "",
      env: {},
      defaultPath: "/from/default",
    });
    assert.strictEqual(got, "/from/default");
  });

  it("resolvePiBinary returns null when nothing resolves", () => {
    const got = resolvePiBinary({ env: {}, defaultPath: "" });
    assert.strictEqual(got, null);
  });

  it("resolvePiBinary ignores empty PI_FLEET_PI_BIN", () => {
    const got = resolvePiBinary({
      configured: "/from/config",
      env: { PI_FLEET_PI_BIN: "" },
      defaultPath: "/from/default",
    });
    assert.strictEqual(got, "/from/config");
  });

  it("scrubSessionFile redacts credential keys and leaves others alone", async () => {
    const dir = freshTmp("fleet-r1-scrub-");
    const file = join(dir, "session.json");
    writeFileSync(
      file,
      JSON.stringify({
        messages: [{ role: "assistant", apiKey: "sk-secret" }, { role: "user" }],
        nested: { token: "abc", name: "ok" },
      }),
    );
    const { redactedKeys } = await scrubSessionFile(file);
    assert.strictEqual(redactedKeys, 2);
    const back = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const msgs = back.messages as Array<Record<string, unknown>>;
    assert.strictEqual(msgs[0]?.apiKey, "[REDACTED]");
    assert.strictEqual(msgs[0]?.role, "assistant");
    const nested = back.nested as Record<string, unknown>;
    assert.strictEqual(nested.token, "[REDACTED]");
    assert.strictEqual(nested.name, "ok");
  });

  it("scrubSessionFile on a missing file is a no-op", async () => {
    const dir = freshTmp("fleet-r1-scrub-missing-");
    const { redactedKeys } = await scrubSessionFile(join(dir, "absent.json"));
    assert.strictEqual(redactedKeys, 0);
  });

  it("scrubSessionFile on non-JSON bytes is a no-op", async () => {
    const dir = freshTmp("fleet-r1-scrub-njson-");
    const file = join(dir, "session.json");
    writeFileSync(file, "{not json");
    const { redactedKeys } = await scrubSessionFile(file);
    assert.strictEqual(redactedKeys, 0);
  });

  it("discoverSessionFile returns null on an empty or missing dir", async () => {
    const dir = freshTmp("fleet-r1-sess-");
    assert.strictEqual(await discoverSessionFile(dir, "sess"), null);
    assert.strictEqual(await discoverSessionFile(join(dir, "absent"), "sess"), null);
  });

  it("discoverSessionFile picks the unique JSON file in a directory", async () => {
    const dir = freshTmp("fleet-r1-sess2-");
    writeFileSync(join(dir, "01JQQ000000000000000000000-0-1.json"), "{}");
    const got = await discoverSessionFile(dir, "01JQQ000000000000000000000-0-1");
    assert.ok(got !== null);
    assert.ok(got!.endsWith("01JQQ000000000000000000000-0-1.json"));
  });

  it("the per-attempt and per-job caps are the spec values", () => {
    assert.strictEqual(ATTEMPT_TRANSCRIPT_CAP_BYTES, 8 * 1024 * 1024);
    assert.strictEqual(JOB_TRANSCRIPT_CAP_BYTES, 32 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// End-to-end driver test against the existing stub (ticket 26 stub;
// it is intentionally compatible with the new driver).
// ---------------------------------------------------------------------------

describe("driver — end-to-end against the stub binary", () => {
  it("runStage against the fixture-replaying stub seals and scrubs the session file", async () => {
    const dir = freshTmp("fleet-r1-e2e-");
    const stageDir = join(dir, "stage");
    const sessionDir = join(stageDir, "session");
    const artifactPath = join(stageDir, "artifact.json");

    const result = await runStage({
      jobId: "01JQQ000000000000000000000",
      stageIndex: 0,
      attempt: 1,
      piBinary: STUB_PATH,
      artifactPath,
      stageDir,
      sessionDir,
      launchTimeoutMs: 5_000,
      stageTimeoutMs: 30_000,
    });

    // The call intent is written before spawn and is readable after.
    assert.strictEqual(existsSync(result.callIntentPath), true, "call-intent was written");
    const intent = JSON.parse(readFileSync(result.callIntentPath, "utf8")) as Record<string, unknown>;
    assert.strictEqual(intent.schema, "call-intent/1");
    assert.strictEqual(intent.jobId, "01JQQ000000000000000000000");
    assert.strictEqual(intent.stageIndex, 0);
    assert.strictEqual(intent.attempt, 1);
    assert.strictEqual(intent.piBinary, STUB_PATH);
    assert.strictEqual(intent.piVersion, "minimax-m3-fixture@1");
    assert.strictEqual(intent.sessionName, "01JQQ000000000000000000000-0-1");

    // The stub replays the fixture, which ends in a schema-valid
    // submit_write tool_execution_end, so the stage seals.
    assert.strictEqual(result.outcome.kind, "sealed");
    if (result.outcome.kind === "sealed") {
      assert.strictEqual(result.outcome.tool, "submit_write");
      const payload = result.outcome.payload as Record<string, unknown>;
      assert.strictEqual(typeof payload.summary, "string");
      assert.ok((payload.filesTouched as string[]).length > 0);
      assert.strictEqual(payload.contractMet, true);
    }

    // Usage sums to the regression fixture's totals (1,000 + 4,970 = 5,970
    // input, 20,000 + 21,503 = 41,503 output).
    if (result.outcome.kind === "sealed") {
      const usage = result.outcome.summary.usage;
      assert.strictEqual(usage.input, 5_970);
      assert.strictEqual(usage.output, 41_503);
      assert.strictEqual(usage.totalTokens, 47_473);
    }

    // The session file is retained inside the stage directory.
    assert.ok(result.sessionFile !== null);
    assert.ok(result.sessionFile!.includes(sessionDir));

    // The stub wrote credentials into the session JSON. The driver
    // scrubs them at seal.
    const sessionText = readFileSync(result.sessionFile!, "utf8");
    assert.ok(!sessionText.includes("sk-fixture-secret"), "apiKey was redacted");
    assert.ok(!sessionText.includes("bearer-fixture-token"), "token was redacted");
    assert.ok(sessionText.includes("[REDACTED]"));
  });

  it("runStage persists call intent before spawn even when the binary later fails", async () => {
    const dir = freshTmp("fleet-r1-intent-");
    const stageDir = join(dir, "stage");
    const sessionDir = join(stageDir, "session");
    const artifactPath = join(stageDir, "artifact.json");
    const nonExistent = join(dir, "no-such-binary");

    const result = await runStage({
      jobId: "01JQQ000000000000000000000",
      stageIndex: 0,
      attempt: 1,
      piBinary: nonExistent,
      artifactPath,
      stageDir,
      sessionDir,
      launchTimeoutMs: 1_000,
      stageTimeoutMs: 2_000,
    });

    assert.strictEqual(existsSync(result.callIntentPath), true, "call-intent is durable across a failed spawn");
  });
});

// ---------------------------------------------------------------------------
// Regressions found by the review beat on ticket 25.
// ---------------------------------------------------------------------------

/**
 * Writes a fake Pi binary that records its own argv, floods stdout with a
 * burst big enough to outlast the pipe buffer, then emits the sealing
 * events and exits immediately. The burst is the point: a driver that
 * stops reading at `exit` rather than at stdout close will still have the
 * tail sitting unread in the pipe.
 */
function writeBurstPi(dir: string, burstLines: number): string {
  const path = join(dir, "burst-pi.ts");
  writeFileSync(
    path,
    `
import { writeFileSync, mkdirSync, writeSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const idx = (flag: string): string | null => {
  const i = argv.indexOf(flag);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};
const sessionDir = idx("--session-dir");
const name = idx("-n") ?? "fixture-session";
if (sessionDir !== null) mkdirSync(sessionDir, { recursive: true });
writeFileSync(join(${JSON.stringify(dir)}, "argv.json"), JSON.stringify(argv));

// writeSync, not process.stdout.write: an async write followed by
// process.exit drops whatever is still buffered, which would make this a
// test of the fixture's truncation rather than of the driver's draining.
const emit = (o: unknown): void => { writeSync(1, JSON.stringify(o) + "\\n"); };
emit({ type: "agent_start" });
for (let i = 0; i < ${burstLines}; i += 1) {
  emit({ type: "message_end", message: { role: "assistant", content: "x".repeat(200) } });
}
emit({
  type: "tool_execution_end",
  toolName: "submit_write",
  result: { isError: false, details: { summary: "burst", filesTouched: ["a.ts"], commandsRun: ["npm t"], contractMet: true } },
});
// Deliberately no trailing newline on the last event: Pi's stream ends
// where it ends, and a framing buffer that only splits on "\\n" drops it.
writeSync(1, JSON.stringify({ type: "agent_settled" }));
if (sessionDir !== null) {
  writeFileSync(join(sessionDir, name + ".json"), JSON.stringify({ schema: "session/1", name }));
}
`,
    "utf8",
  );
  return path;
}

describe("driver — stdout is drained before the stage is classified", () => {
  it("reads a final event that arrives without a trailing newline", async () => {
    const dir = freshTmp("fleet-r1-drain-");
    const stageDir = join(dir, "stage");
    const sessionDir = join(stageDir, "session");
    const piBinary = writeBurstPi(dir, 5_000);

    const result = await runStage({
      jobId: "01JQQ000000000000000000000",
      stageIndex: 0,
      attempt: 1,
      piBinary,
      artifactPath: join(stageDir, "artifact.json"),
      stageDir,
      sessionDir,
      launchTimeoutMs: 10_000,
      stageTimeoutMs: 30_000,
    });

    // The sealing events are the last thing on a ~1MB stream. Resolving the
    // stage wait on `exit` loses them and misreports a paid, sealed stage as
    // a quality failure worth re-running.
    assert.strictEqual(
      result.outcome.kind,
      "sealed",
      `expected the trailing events to be read; got ${result.outcome.kind}: ${"reason" in result.outcome ? result.outcome.reason : ""}`,
    );
    assert.strictEqual(result.outcome.summary.settled, true, "agent_settled was read");
    assert.ok(result.outcome.events.length >= 5_003, `all events read, got ${result.outcome.events.length}`);
  });
});

describe("driver — the Fleet extension is loaded into Pi", () => {
  it("passes -e <extension> so the submit_* tools exist", async () => {
    const dir = freshTmp("fleet-r1-ext-");
    const stageDir = join(dir, "stage");
    const sessionDir = join(stageDir, "session");
    const piBinary = writeBurstPi(dir, 1);

    await runStage({
      jobId: "01JQQ000000000000000000000",
      stageIndex: 0,
      attempt: 1,
      piBinary,
      artifactPath: join(stageDir, "artifact.json"),
      stageDir,
      sessionDir,
      launchTimeoutMs: 10_000,
      stageTimeoutMs: 30_000,
      tools: ["read", "submit_write"],
    });

    const argv = JSON.parse(readFileSync(join(dir, "argv.json"), "utf8")) as string[];
    const eIdx = argv.indexOf("-e");
    assert.ok(eIdx >= 0, `argv carries -e; got ${argv.join(" ")}`);
    const extPath = argv[eIdx + 1] ?? "";
    assert.ok(extPath.endsWith("fleet-extension.ts"), `-e points at the extension; got ${extPath}`);
    assert.strictEqual(existsSync(extPath), true, "the extension path exists on disk");
  });

  it("honours an explicit extensionPath override", async () => {
    const dir = freshTmp("fleet-r1-ext2-");
    const stageDir = join(dir, "stage");
    const sessionDir = join(stageDir, "session");
    const piBinary = writeBurstPi(dir, 1);
    const custom = join(dir, "custom-extension.ts");
    writeFileSync(custom, "export default function (): void {}\n", "utf8");

    await runStage({
      jobId: "01JQQ000000000000000000000",
      stageIndex: 0,
      attempt: 1,
      piBinary,
      artifactPath: join(stageDir, "artifact.json"),
      stageDir,
      sessionDir,
      launchTimeoutMs: 10_000,
      stageTimeoutMs: 30_000,
      extensionPath: custom,
    });

    const argv = JSON.parse(readFileSync(join(dir, "argv.json"), "utf8")) as string[];
    assert.strictEqual(argv[argv.indexOf("-e") + 1], custom);
  });
});

// Silence unused warning on imports kept for cross-reference.
void spawnStub;
void buildEventStreamFixture;
type _Summary = StageSummary;
