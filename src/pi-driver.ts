/**
 * Pi work-unit driver — ticket 25.
 *
 * Spawns one `pi --mode rpc` subprocess per stage, consumes its LF-only JSONL
 * event stream, classifies the outcome, sums usage, terminates via the
 * recorded ladder, and persists call intent and session bookkeeping.
 *
 * The driver is the only seam between Fleet and Pi. The supervisor calls
 * `runStage` once per stage attempt and observes a typed result.
 *
 * Public surface:
 *
 *   parseJsonlLines(buffer)         → string[]
 *   parseEvent(line)                → { type, ... } | null
 *   summarise(events)               → StageSummary
 *   resolvePiBinary(opts)           → string
 *   runStage(opts)                  → RunResult
 *
 *   classify(events)                → "infrastructure" | "quality"  (alias)
 *   sumUsage(events)                → Usage
 *   terminate(child, opts)          → TerminateRung
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidUlid } from "./ulid.ts";
import type { Problem } from "./envelope.ts";

// ---------------------------------------------------------------------------
// JSONL framing: split on LF only, drop trailing CR, drop empty lines.
// Pi emits \r\n; CR must not be a frame boundary. U+2028 (Unicode LINE
// SEPARATOR) is a character inside a string and must not split a line.
// ---------------------------------------------------------------------------

/**
 * Split a JSONL buffer into lines. Splits on LF only. Strips a trailing CR
 * (from \r\n) so a downstream JSON.parse never sees a stray carriage
 * return. Empty lines (consecutive LFs, or trailing newline) are dropped.
 *
 * @internal exported for testing.
 */
export function parseJsonlLines(buffer: string): string[] {
  if (buffer.length === 0) return [];
  const lines = buffer.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] as string;
    // Strip a trailing CR. Pi uses \r\n; the spike drive.mjs already does
    // this. Doing it here means the JSON parser never sees "\r" appended.
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.length > 0) out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Event shape and parsing.
// ---------------------------------------------------------------------------

/**
 * A single event from the Pi event stream. We accept the keys the spike
 * captured and any others Pi may emit; the driver only inspects the small
 * subset it cares about.
 */
export interface PiEvent {
  type: string;
  message?: {
    role?: string;
    usage?: PiUsage;
    model?: string;
    provider?: string;
    stopReason?: string;
  };
  toolName?: string;
  result?: {
    details?: unknown;
    isError?: boolean;
  };
  [key: string]: unknown;
}

export interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}

/**
 * Parse a single JSONL line. Returns null on any parse error — the driver
 * treats unparseable lines as protocol drift and lets the consumer (the
 * supervisor, or a test) decide whether to abort.
 *
 * @internal exported for testing.
 */
export function parseEvent(line: string): PiEvent | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed === null || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.type !== "string") return null;
    return obj as PiEvent;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Usage accumulation.
// ---------------------------------------------------------------------------

/**
 * Usage summed across every assistant `message_end`. Pi reports usage on
 * each streamed assistant message and the spec says usage is summed across
 * them, not last-write-wins.
 */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

/** A zero-valued usage record. */
export function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(target: Usage, source: PiUsage): void {
  target.input += source.input ?? 0;
  target.output += source.output ?? 0;
  target.cacheRead += source.cacheRead ?? 0;
  target.cacheWrite += source.cacheWrite ?? 0;
  target.totalTokens += source.totalTokens ?? 0;
  if (source.cost !== undefined) {
    target.cost.input += source.cost.input ?? 0;
    target.cost.output += source.cost.output ?? 0;
    target.cost.cacheRead += source.cost.cacheRead ?? 0;
    target.cost.cacheWrite += source.cost.cacheWrite ?? 0;
    target.cost.total += source.cost.total ?? 0;
  }
}

/**
 * Sum the usage on every assistant `message_end`. Returns a zero usage
 * record for an event stream with no assistant message_end (e.g. one that
 * died before any assistant text).
 */
export function sumUsage(events: readonly PiEvent[]): Usage {
  const total = zeroUsage();
  for (const ev of events) {
    if (ev.type !== "message_end") continue;
    if (ev.message?.role !== "assistant") continue;
    if (ev.message.usage === undefined) continue;
    addUsage(total, ev.message.usage);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Stream summary — classification either side of `agent_start`.
// ---------------------------------------------------------------------------

/**
 * Failure classification discriminator. `agent_start` is the boundary:
 *   - never seen  → infrastructure (auth, timeout before agent start, etc.)
 *   - seen, no submit_* → quality (timeout after agent start, length stop,
 *     contract violation, no result, blocked commands, transcript overrun)
 *   - seen, submit_* sealed → sealed (success)
 */
export type FailureClass = "infrastructure" | "quality" | "sealed";

export interface StageSummary {
  /** `true` if the run reached `agent_start`. */
  agentStarted: boolean;
  /** `true` if the run reached `agent_settled`. The settle event is the
   *  signal the protocol uses to end a run; `agent_end` is not. */
  settled: boolean;
  /** The schema-valid `submit_*` result that sealed the stage, if any. */
  sealed: unknown | null;
  /** The tool name that sealed the stage (`submit_write`, `submit_review`, …). */
  sealedTool: string | null;
  /** Summed usage across assistant message_end events. */
  usage: Usage;
  /** Model and provider from the last assistant message_end. */
  model: string | null;
  provider: string | null;
  /** Stop reasons observed across assistant message_end events. */
  stopReasons: readonly string[];
  /** Tool names called during the run. */
  toolCalls: readonly string[];
  /** True iff a `submit_*` was called. */
  submitted: boolean;
}

/**
 * Summarise a Pi event stream. Pure function; no I/O.
 */
export function summarise(events: readonly PiEvent[]): StageSummary {
  const summary: StageSummary = {
    agentStarted: false,
    settled: false,
    sealed: null,
    sealedTool: null,
    usage: zeroUsage(),
    model: null,
    provider: null,
    stopReasons: [],
    toolCalls: [],
    submitted: false,
  };
  for (const ev of events) {
    switch (ev.type) {
      case "agent_start":
        summary.agentStarted = true;
        break;
      case "agent_settled":
        summary.settled = true;
        break;
      case "tool_execution_start":
        if (typeof ev.toolName === "string") {
          summary.toolCalls = [...summary.toolCalls, ev.toolName];
        }
        break;
      case "tool_execution_end":
        if (typeof ev.toolName === "string" && ev.toolName.startsWith("submit_")) {
          summary.submitted = true;
          // A submit_* result only seals the stage when it (a) succeeded
          // and (b) matches the submit_* payload schema. Anything else is
          // prose masquerading as a result — the spec is explicit: prose
          // never seals.
          if (ev.result?.details !== undefined && ev.result.isError !== true) {
            if (validateSubmitPayload(ev.result.details).ok) {
              summary.sealed = ev.result.details;
              summary.sealedTool = ev.toolName;
            }
          }
        }
        break;
      case "message_end":
        if (ev.message?.role === "assistant") {
          if (ev.message.usage !== undefined) {
            addUsage(summary.usage, ev.message.usage);
          }
          if (typeof ev.message.model === "string") summary.model = ev.message.model;
          if (typeof ev.message.provider === "string") summary.provider = ev.message.provider;
          if (typeof ev.message.stopReason === "string") {
            summary.stopReasons = [...summary.stopReasons, ev.message.stopReason];
          }
        }
        break;
    }
  }
  return summary;
}

/**
 * Classify a stage run as `sealed`, `quality`, or `infrastructure`.
 *
 * The discriminator is `agent_start`:
 *   - sealed       — summary.sealed is non-null
 *   - quality      — summary.agentStarted is true but no seal
 *   - infrastructure — agent_start was never seen
 *
 * Convenience over `summarise` for callers that only need the class.
 */
export function classify(events: readonly PiEvent[]): FailureClass {
  const s = summarise(events);
  if (s.sealed !== null) return "sealed";
  if (s.agentStarted) return "quality";
  return "infrastructure";
}

// ---------------------------------------------------------------------------
// Submit_* schema validation. The schema is provided by the caller (the
// Fleet extension per role) so the driver does not own role-specific types.
// ---------------------------------------------------------------------------

/**
 * Validate a `submit_*` payload against a TypeBox-shaped schema. The
 * driver only checks the shape the spec calls out: `summary`, an array
 * of `filesTouched`, an array of `commandsRun`, a `contractMet` boolean.
 * Roles can extend with extra fields; the driver does not enforce them.
 *
 * @internal exported for testing.
 */
export interface SubmitShape {
  summary?: unknown;
  filesTouched?: unknown;
  commandsRun?: unknown;
  contractMet?: unknown;
}

export interface SubmitValidation {
  ok: boolean;
  reason: string | null;
}

const TOOL_NAME_PATTERN = /^submit_[a-z_]+$/;

export function isSubmitToolName(name: string): boolean {
  return TOOL_NAME_PATTERN.test(name);
}

/**
 * Validate that a tool result matches the `submit_*` schema. A writer's
 * sealed result must have `summary: string`, `filesTouched: string[]`,
 * `commandsRun: string[]`, `contractMet: boolean`. Anything else fails
 * with a legible reason and the stage is **not** sealed.
 */
export function validateSubmitPayload(value: unknown): SubmitValidation {
  if (value === null || typeof value !== "object") {
    return { ok: false, reason: "submit payload must be an object" };
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.summary !== "string") {
    return { ok: false, reason: "submit payload summary must be a string" };
  }
  if (!Array.isArray(obj.filesTouched) || !obj.filesTouched.every((s) => typeof s === "string")) {
    return { ok: false, reason: "submit payload filesTouched must be string[]" };
  }
  if (!Array.isArray(obj.commandsRun) || !obj.commandsRun.every((s) => typeof s === "string")) {
    return { ok: false, reason: "submit payload commandsRun must be string[]" };
  }
  if (typeof obj.contractMet !== "boolean") {
    return { ok: false, reason: "submit payload contractMet must be a boolean" };
  }
  return { ok: true, reason: null };
}

// ---------------------------------------------------------------------------
// Termination ladder.
// ---------------------------------------------------------------------------

/**
 * Which rung of the termination ladder fired. `none` means the process
 * exited cleanly before the ladder was needed.
 */
export type TerminateRung = "none" | "abort" | "sigterm" | "sigkill";

export interface TerminateOptions {
  /** Milliseconds between SIGTERM and SIGKILL. Spec: 30s. */
  sigtermToSigkillMs?: number;
  /** Optional clock for tests. */
  clock?: () => number;
}

const DEFAULT_SIGTERM_TO_SIGKILL_MS = 30_000;

/**
 * Run the termination ladder against a Pi child process.
 *
 *   1. write `{"type":"abort"}\n` to stdin
 *   2. wait up to 10s for exit
 *   3. SIGTERM, wait up to sigtermToSigkillMs (default 30s)
 *   4. SIGKILL
 *
 * Returns which rung ended the process. The first rung that ends it wins.
 * If the child has already exited before this function runs, returns `none`.
 *
 * @internal exported for testing.
 */
export async function terminate(
  child: ChildProcess,
  options: TerminateOptions = {},
): Promise<TerminateRung> {
  const sigtermWaitMs = 10_000;
  const sigkillWaitMs = options.sigtermToSigkillMs ?? DEFAULT_SIGTERM_TO_SIGKILL_MS;

  // Wait briefly to see whether the child exits on its own before we
  // engage the ladder. A child that exits cleanly in the gap between
  // spawn and the supervisor's cancel call should report `none`, not
  // `abort` just because we wrote one line to a stdin it never read.
  // The 50ms grace is small enough to be invisible to a real run but
  // long enough to catch a synchronous `process.exit(0)`.
  const exitedQuietly = await waitForExit(child, 50);
  if (exitedQuietly) return "none";

  // Step 1: cooperative abort.
  try {
    if (child.stdin !== null && child.stdin.writable) {
      child.stdin.write(`${JSON.stringify({ type: "abort" })}\n`);
    }
  } catch {
    // stdin may be closed; the ladder will catch up via SIGTERM.
  }

  // Wait up to sigtermWaitMs for an exit from the cooperative abort.
  const exitedFromAbort = await waitForExit(child, sigtermWaitMs);
  if (exitedFromAbort) return "abort";

  // Step 2: SIGTERM.
  try {
    child.kill("SIGTERM");
  } catch {
    // Already gone between waits.
    return "sigterm";
  }
  const exitedFromSigterm = await waitForExit(child, sigkillWaitMs);
  if (exitedFromSigterm) return "sigterm";

  // Step 3: SIGKILL.
  try {
    child.kill("SIGKILL");
  } catch {
    return "sigkill";
  }
  await waitForExit(child, 5_000);
  return "sigkill";
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(true);
      return;
    }
    let done = false;
    const finish = (exited: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = (): void => {
      finish(true);
    };
    const timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

// ---------------------------------------------------------------------------
// piBinary resolution.
// ---------------------------------------------------------------------------

export interface PiBinarySource {
  /** Configured path; takes precedence. */
  configured?: string | null;
  /** Process environment override; wins over `configured`. */
  env?: NodeJS.ProcessEnv;
  /** Optional default applied when neither is set. */
  defaultPath?: string;
}

/**
 * Resolve the Pi binary path. Order:
 *   1. `PI_FLEET_PI_BIN` environment variable (if non-empty)
 *   2. `configured` value (if non-empty)
 *   3. `defaultPath` (if non-empty)
 *
 * Returns `null` when nothing resolves. A configured-but-missing path is
 * a setup fault, surfaced by the supervisor before the spawn.
 */
export function resolvePiBinary(source: PiBinarySource): string | null {
  const env = source.env ?? process.env;
  const fromEnv = env.PI_FLEET_PI_BIN;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  if (typeof source.configured === "string" && source.configured.length > 0) return source.configured;
  if (typeof source.defaultPath === "string" && source.defaultPath.length > 0) return source.defaultPath;
  return null;
}

// ---------------------------------------------------------------------------
// Call intent — persisted before spawn so a recovering supervisor can
// reconcile the exact call once and never repeat a paid call.
// ---------------------------------------------------------------------------

/** Recorded before spawn. Read on resume to confirm the prior attempt. */
export interface CallIntent {
  schema: "call-intent/1";
  jobId: string;
  stageIndex: number;
  attempt: number;
  piBinary: string;
  piVersion: string;
  sessionName: string;
  sessionDir: string;
  startedAt: string;
}

/**
 * Build the deterministic session name the spec mandates:
 *   `<jobId>-<stageIndex>-<attempt>`
 *
 * The session name is what Pi uses for its `--session-dir` and what we
 * use to discover the transcript on seal.
 */
export function sessionName(jobId: string, stageIndex: number, attempt: number): string {
  return `${jobId}-${stageIndex}-${attempt}`;
}

/**
 * Detect a Pi version from the binary's output. The driver probes the
 * binary with `--version` and reads the first line. A failing probe
 * records `unknown`; the stub binary prints its own version directly so
 * the golden fixture names the version it came from.
 *
 * A `.ts` path is run via `node --experimental-strip-types`, mirroring
 * the spawn behaviour of `runStage`. A real binary path is spawned
 * directly.
 */
export async function probePiVersion(piBinary: string): Promise<string> {
  return new Promise((resolve) => {
    const spawnArgv: string[] = [];
    let spawnCommand = piBinary;
    if (piBinary.endsWith(".ts")) {
      spawnCommand = process.execPath;
      spawnArgv.push("--experimental-strip-types", piBinary);
    }
    const child = spawn(spawnCommand, [...spawnArgv, "--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    const finish = (version: string): void => {
      child.removeAllListeners("error");
      child.kill("SIGKILL");
      resolve(version);
    };
    child.once("error", () => finish("unknown"));
    child.once("exit", () => {
      const first = out.trim().split("\n")[0] ?? "";
      finish(first.length > 0 ? first : "unknown");
    });
    setTimeout(() => finish("unknown"), 2_000).unref();
  });
}

// ---------------------------------------------------------------------------
// Session file discovery.
// ---------------------------------------------------------------------------

/**
 * Discover Pi's session file inside a session directory. Pi writes its
 * session as a JSON file whose name is the session name; older Pi versions
 * wrote a nested directory. We glob for any `*.json` file under the
 * directory; if exactly one exists, that is the session.
 */
export async function discoverSessionFile(sessionDir: string, sessionName: string): Promise<string | null> {
  if (!existsSync(sessionDir)) return null;
  const entries = await fs.readdir(sessionDir, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
  // Look for a file whose name contains the session name first (newer Pi).
  const candidates: string[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith(".json")) continue;
    candidates.push(e.name);
  }
  if (candidates.length === 1) {
    return join(sessionDir, candidates[0] as string);
  }
  const exact = candidates.find((n) => n === `${sessionName}.json`);
  if (exact !== undefined) return join(sessionDir, exact);
  return null;
}

/**
 * Scrub credentials from Pi's session file in place. The spec says the
 * transcript is scrubbed at seal and at egress; this routine is called
 * at seal. The scrubber is a redact-everything-of-this-shape pass: any
 * string whose name matches a credential pattern is replaced with a
 * fixed redaction marker.
 */
const CREDENTIAL_KEY_PATTERNS = [
  /^api[-_]?key$/i,
  /^authorization$/i,
  /^bearer$/i,
  /^secret$/i,
  /^token$/i,
  /^password$/i,
  /^access[-_]?token$/i,
];

const REDACTED = "[REDACTED]";

export async function scrubSessionFile(path: string): Promise<{ redactedKeys: number }> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch {
    return { redactedKeys: 0 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { redactedKeys: 0 };
  }
  const { value, count } = redactObject(parsed);
  if (count > 0) {
    await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  }
  return { redactedKeys: count };
}

function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEY_PATTERNS.some((p) => p.test(key));
}

function redactValue(v: unknown): unknown {
  if (typeof v === "string") return REDACTED;
  return v;
}

function redactObject(v: unknown): { value: unknown; count: number } {
  let count = 0;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map((item) => walk(item));
    }
    if (node !== null && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(obj)) {
        if (isCredentialKey(k) && (typeof val === "string" || typeof val === "number")) {
          out[k] = redactValue(val);
          count += 1;
        } else {
          out[k] = walk(val);
        }
      }
      return out;
    }
    return node;
  };
  return { value: walk(v), count };
}

// ---------------------------------------------------------------------------
// Caps.
// ---------------------------------------------------------------------------

/** Per-attempt transcript cap. Exceeding it is a quality failure. */
export const ATTEMPT_TRANSCRIPT_CAP_BYTES = 8 * 1024 * 1024; // 8 MiB
/** Per-job total cap. Exceeding it is a quality failure. */
export const JOB_TRANSCRIPT_CAP_BYTES = 32 * 1024 * 1024; // 32 MiB

/**
 * Compute the size of Pi's session file. Used to enforce caps.
 * Returns 0 when the file does not exist.
 */
export async function sessionFileBytes(path: string | null): Promise<number> {
  if (path === null) return 0;
  try {
    const stat = await fs.stat(path);
    return stat.size;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Run orchestration.
// ---------------------------------------------------------------------------

export interface RunStageOptions {
  jobId: string;
  stageIndex: number;
  attempt: number;
  /** Path to the Pi binary (resolved by the caller). */
  piBinary: string;
  /** Path the driver writes the schema-valid `submit_*` artifact to. */
  artifactPath: string;
  /** Stage directory; Pi's session is created inside here. */
  stageDir: string;
  /** Subdirectory under stageDir where Pi writes its session file. */
  sessionDir: string;
  /** Working directory for the Pi subprocess. */
  cwd?: string;
  /** Optional model id, forwarded as `--model`. */
  model?: string;
  /** Optional tool allowlist forwarded as `--tools`. */
  tools?: readonly string[];
  /**
   * Fleet extension forwarded as `-e`. Defaults to the `fleet-extension.ts`
   * shipped beside this module. The extension is what registers the
   * `submit_*` tools, so without it no stage can seal — the allowlist in
   * `tools` names tools that would otherwise not exist.
   */
  extensionPath?: string;
  /** Launch timeout (ms) to first `agent_start`. Spec: 90_000. */
  launchTimeoutMs?: number;
  /** Wall-clock cap for the entire stage attempt. */
  stageTimeoutMs?: number;
  /** Optional injected clock. */
  clock?: () => number;
  /** Optional log path the driver writes its parsed events to. */
  eventsLogPath?: string;
}

export interface RunResult {
  /** Input validation: a typed Problem for a bad job id. Otherwise null. */
  inputProblem: { problem: Problem; message: string } | null;
  outcome: RunOutcome;
  /** Last recorded rung of the termination ladder. `none` when not used. */
  terminateRung: TerminateRung;
  /** Path of the discovered Pi session file, if any. */
  sessionFile: string | null;
  /** Bytes used by the session file at seal. */
  sessionBytes: number;
  /** Path of the call-intent record written before spawn. */
  callIntentPath: string;
  /** Pi version recorded from the binary's `--version` probe. */
  piVersion: string;
}

export type RunOutcome =
  | { kind: "sealed"; tool: string; payload: unknown; summary: StageSummary; events: readonly PiEvent[] }
  | { kind: "infra"; reason: string; summary: StageSummary; events: readonly PiEvent[] }
  | { kind: "quality"; reason: string; summary: StageSummary; events: readonly PiEvent[] };

const DEFAULT_LAUNCH_TIMEOUT_MS = 90_000;
const DEFAULT_STAGE_TIMEOUT_MS = 60 * 60 * 1000; // one hour; stage-specific caps apply later

/**
 * Run one Pi stage attempt. The driver:
 *
 *   1. Writes a call-intent record under the stage directory (before spawn).
 *   2. Probes the binary's version (record it on the call intent).
 *   3. Spawns the binary with the resolved session name and argv.
 *   4. Consumes the LF-only JSONL event stream.
 *   5. Waits up to `launchTimeoutMs` for the first `agent_start`.
 *   6. After launch, runs until `agent_settled`, `stageTimeoutMs` elapses,
 *      or the abort ladder fires.
 *   7. Discovered session file is reported back; caps are enforced.
 *
 * The returned outcome is a discriminated union so the supervisor can act
 * on each class without re-parsing.
 */
/**
 * The Fleet extension ships beside this module. Resolved at call time so a
 * test can point `extensionPath` elsewhere without touching the default.
 */
export function defaultExtensionPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "fleet-extension.ts");
}

export async function runStage(opts: RunStageOptions): Promise<RunResult> {
  if (!isValidUlid(opts.jobId)) {
    return {
      inputProblem: { problem: "invalid-input", message: `invalid job id: ${opts.jobId}` },
      outcome: { kind: "infra", reason: "invalid-input", summary: summarise([]), events: [] },
      terminateRung: "none",
      sessionFile: null,
      sessionBytes: 0,
      callIntentPath: "",
      piVersion: "unknown",
    };
  }
  const clock = opts.clock ?? ((): number => Date.now());
  const launchTimeoutMs = opts.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
  const stageTimeoutMs = opts.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;

  // 1. Build and persist call intent before spawn.
  const session = sessionName(opts.jobId, opts.stageIndex, opts.attempt);
  await fs.mkdir(opts.sessionDir, { recursive: true });
  const piVersion = await probePiVersion(opts.piBinary);
  const callIntentPath = join(opts.stageDir, "call-intent.json");
  const callIntent: CallIntent = {
    schema: "call-intent/1",
    jobId: opts.jobId,
    stageIndex: opts.stageIndex,
    attempt: opts.attempt,
    piBinary: opts.piBinary,
    piVersion,
    sessionName: session,
    sessionDir: opts.sessionDir,
    startedAt: new Date(clock()).toISOString(),
  };
  await atomicWriteJson(callIntentPath, callIntent);

  // 2. Spawn. A `.ts` path is run under Node's strip-types flag (the
  // package's default execution mode). A real binary path is spawned
  // directly. The supervisor never sees this distinction.
  const spawnArgv: string[] = [];
  let spawnCommand = opts.piBinary;
  if (opts.piBinary.endsWith(".ts")) {
    spawnCommand = process.execPath;
    spawnArgv.push("--experimental-strip-types", opts.piBinary);
  }
  // The extension registers the terminating `submit_*` tools. It must be
  // loaded or the allowlist below names tools Pi has never heard of, and no
  // stage can seal.
  const extensionPath = opts.extensionPath ?? defaultExtensionPath();
  const argv: string[] = [
    ...spawnArgv,
    "--mode", "rpc",
    "--session-dir", opts.sessionDir,
    "-n", session,
    "-e", extensionPath,
  ];
  if (typeof opts.model === "string" && opts.model.length > 0) {
    argv.push("--model", opts.model);
  }
  if (Array.isArray(opts.tools) && opts.tools.length > 0) {
    argv.push("--tools", opts.tools.join(","));
  }
  // The artifact path is delivered via stdin (after spawn). The convention
  // is the first non-protocol message after `agent_start` carries the path;
  // here we pass it as argv instead so the stub binary can be kept simple.
  argv.push("--artifact", opts.artifactPath);

  const child = spawn(spawnCommand, argv, {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // A spawn that fails before any output is an infrastructure failure:
  // the binary path is wrong, the binary is not executable, or some
  // resource is missing. We classify it as such and bail out so the
  // supervisor never sees an unhandled exception. The call intent has
  // already been written — durable evidence of the attempt.
  // Held in an object rather than a bare `let` so the assignment inside
  // the listener stays visible to the typechecker at the read below.
  const spawnFailure: { error: Error | null } = { error: null };
  child.once("error", (err: Error) => {
    spawnFailure.error = err;
  });

  // 3. Consume the event stream with LF-only framing.
  const collected: PiEvent[] = [];
  const parseState: { buffer: string } = { buffer: "" };
  let agentStartSeen = false;
  let settled = false;

  const eventsFile = opts.eventsLogPath !== undefined
    ? await fs.open(opts.eventsLogPath, "a").catch(() => null)
    : null;

  const onChunk = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    parseState.buffer += text;
    let nlIdx = parseState.buffer.indexOf("\n");
    while (nlIdx >= 0) {
      const raw = parseState.buffer.slice(0, nlIdx);
      parseState.buffer = parseState.buffer.slice(nlIdx + 1);
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line.length > 0) {
        const ev = parseEvent(line);
        if (ev !== null) {
          collected.push(ev);
          if (eventsFile !== null) {
            eventsFile.write(`${JSON.stringify(ev)}\n`).catch(() => {});
          }
          if (ev.type === "agent_start") agentStartSeen = true;
          if (ev.type === "agent_settled") settled = true;
        }
      }
      nlIdx = parseState.buffer.indexOf("\n");
    }
  };

  child.stdout?.on("data", onChunk);
  // A final line without a trailing newline is still an event. Flush what is
  // left in the framing buffer once stdout ends.
  child.stdout?.once("end", () => {
    const tail = parseState.buffer;
    parseState.buffer = "";
    const line = tail.endsWith("\r") ? tail.slice(0, -1) : tail;
    if (line.length === 0) return;
    const ev = parseEvent(line);
    if (ev === null) return;
    collected.push(ev);
    if (eventsFile !== null) {
      eventsFile.write(`${JSON.stringify(ev)}\n`).catch(() => {});
    }
    if (ev.type === "agent_start") agentStartSeen = true;
    if (ev.type === "agent_settled") settled = true;
  });
  // stderr is captured for diagnostics but not parsed.
  child.stderr?.setEncoding("utf8");

  // 4. Launch timeout.
  let launchTimer: NodeJS.Timeout | null = null;
  let stageTimer: NodeJS.Timeout | null = null;
  let launchInterval: NodeJS.Timeout | null = null;
  let stageInterval: NodeJS.Timeout | null = null;
  let terminateRung: TerminateRung = "none";

  // Both waits poll a flag and race a deadline. Whichever arm wins, the
  // losing arm's handle is still armed, so every exit path below has to
  // go through clearTimers() — a leaked 50ms interval (or the one-hour
  // stage deadline) keeps the event loop alive long after the stage is
  // done, which in a long-lived supervisor accumulates per run.
  const clearTimers = (): void => {
    if (launchTimer !== null) clearTimeout(launchTimer);
    if (stageTimer !== null) clearTimeout(stageTimer);
    if (launchInterval !== null) clearInterval(launchInterval);
    if (stageInterval !== null) clearInterval(stageInterval);
  };

  const launchPromise = new Promise<"launched" | "timeout">((resolve) => {
    launchTimer = setTimeout(() => resolve("timeout"), launchTimeoutMs);
    const poll = setInterval(() => {
      if (agentStartSeen) {
        clearInterval(poll);
        resolve("launched");
      }
    }, 50);
    launchInterval = poll;
    // Watch for an early exit. `close` rather than `exit`: `exit` fires when
    // the child is reaped, which can be before its stdout has been drained,
    // so an `agent_start` still sitting in the pipe would read as a launch
    // timeout.
    child.once("close", () => {
      clearInterval(poll);
      resolve(agentStartSeen ? "launched" : "timeout");
    });
  });

  const stagePromise = new Promise<"settled" | "killed" | "exit">((resolve) => {
    stageTimer = setTimeout(() => resolve("killed"), stageTimeoutMs);
    const poll = setInterval(() => {
      if (settled) {
        clearInterval(poll);
        resolve("settled");
      }
    }, 50);
    stageInterval = poll;
    // Same reason as the launch wait, and it matters more here: the sealing
    // `tool_execution_end` and `agent_settled` are the last things Pi writes,
    // so classifying at `exit` drops exactly the events that decide whether a
    // paid stage sealed.
    child.once("close", () => {
      clearInterval(poll);
      resolve("exit");
    });
  });

  try {
    const launched = await launchPromise;
    if (spawnFailure.error !== null) {
      // Spawn failed. The child never produced output; the call intent
      // is already on disk. This is infrastructure: the binary path was
      // bad or the host could not exec it.
      if (eventsFile !== null) await eventsFile.close().catch(() => {});
      return {
        inputProblem: null,
        outcome: { kind: "infra", reason: `spawn failed: ${spawnFailure.error.message}`, summary: summarise(collected), events: collected },
        terminateRung: "none",
        sessionFile: null,
        sessionBytes: 0,
        callIntentPath,
        piVersion,
      };
    }
    if (!agentStartSeen && launched === "timeout") {
      // No agent_start within launchTimeoutMs. This is an infrastructure
      // failure: classify and stop. The ladder still runs to record the rung.
      terminateRung = await terminate(child, { sigtermToSigkillMs: 30_000 });
      if (eventsFile !== null) await eventsFile.close().catch(() => {});
      const summary = summarise(collected);
      return {
        inputProblem: null,
        outcome: { kind: "infra", reason: `launch timeout after ${launchTimeoutMs}ms`, summary, events: collected },
        terminateRung,
        sessionFile: null,
        sessionBytes: 0,
        callIntentPath,
        piVersion,
      };
    }

    const stopped = await stagePromise;

    if (stopped === "killed") {
      terminateRung = await terminate(child, { sigtermToSigkillMs: 30_000 });
    }

    if (eventsFile !== null) await eventsFile.close().catch(() => {});

    // Wait for the child to fully exit *and* for its pipes to close, so the
    // classification below sees every event. `exitCode === null` alone is not
    // "still running": a signal-killed child leaves `exitCode` null and sets
    // `signalCode`, and its `exit` event has already fired and will not fire
    // again.
    const stillRunning = child.exitCode === null && child.signalCode === null;
    if (stillRunning || child.stdout?.readableEnded === false) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 5_000);
        child.once("close", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }

    // 5. Discover session file.
    const sessionFile = await discoverSessionFile(opts.sessionDir, session);
    const sessionBytes = await sessionFileBytes(sessionFile);

    // 6. Caps.
    if (sessionBytes > ATTEMPT_TRANSCRIPT_CAP_BYTES) {
      const summary = summarise(collected);
      return {
        inputProblem: null,
        outcome: { kind: "quality", reason: `attempt transcript over ${ATTEMPT_TRANSCRIPT_CAP_BYTES} bytes`, summary, events: collected },
        terminateRung,
        sessionFile,
        sessionBytes,
        callIntentPath,
        piVersion,
      };
    }
    if (sessionBytes > JOB_TRANSCRIPT_CAP_BYTES) {
      const summary = summarise(collected);
      return {
        inputProblem: null,
        outcome: { kind: "quality", reason: `job transcript over ${JOB_TRANSCRIPT_CAP_BYTES} bytes`, summary, events: collected },
        terminateRung,
        sessionFile,
        sessionBytes,
        callIntentPath,
        piVersion,
      };
    }

    // 7. Classify.
    const summary = summarise(collected);
    const validated = summary.sealed !== null ? validateSubmitPayload(summary.sealed) : null;
    if (summary.sealed !== null && validated !== null && validated.ok && summary.sealedTool !== null) {
      // The stage sealed: scrub the session file in place. The spec says
      // "scrubbed at seal and at egress"; this is the seal step. Egress
      // scrubbing is the consumer's job (the supervisor / a report).
      if (sessionFile !== null) {
        await scrubSessionFile(sessionFile);
      }
      return {
        inputProblem: null,
        outcome: { kind: "sealed", tool: summary.sealedTool, payload: summary.sealed, summary, events: collected },
        terminateRung,
        sessionFile,
        sessionBytes,
        callIntentPath,
        piVersion,
      };
    }
    if (summary.agentStarted) {
      return {
        inputProblem: null,
        outcome: { kind: "quality", reason: validated?.reason ?? "no sealed submit_*", summary, events: collected },
        terminateRung,
        sessionFile,
        sessionBytes,
        callIntentPath,
        piVersion,
      };
    }
    return {
      inputProblem: null,
      outcome: { kind: "infra", reason: "no agent_start observed", summary, events: collected },
      terminateRung,
      sessionFile,
      sessionBytes,
      callIntentPath,
      piVersion,
    };
  } finally {
    clearTimers();
  }
}

/** Minimal atomic JSON write — same shape as the store's writeJsonFile. */
async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tmp, path);
}

// Re-export Problem for adapter convenience.
export type { Problem };

// Silence "unused" for helpers kept for future tickets.
void createHash;
