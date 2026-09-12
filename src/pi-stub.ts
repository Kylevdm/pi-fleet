/**
 * Pi work-unit stub (ticket 25).
 *
 * Replays the captured golden event stream at
 * `src/fixtures/golden-pi-events.jsonl`. The fixture names its Pi version;
 * `--version` prints it. Tests and the supervisor spawn this binary in
 * place of the real Pi driver to exercise the protocol without a real
 * model.
 *
 * Usage:
 *   node --experimental-strip-types src/pi-stub.ts [--artifact <path>] [--session-dir <dir>] [--delay <ms>]
 *   node --experimental-strip-types src/pi-stub.ts --version
 *
 * The stub writes a schema-valid submit_write artifact to `--artifact`
 * (when supplied) after the final event. Tests assert on the events
 * (via the driver's event stream); the artifact is the durable record.
 *
 * The `--delay` knob is honoured only between consecutive events so the
 * supervisor's launch timeout can still fire on a non-starting run by
 * setting `--delay` to a value larger than the launch window.
 */

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

interface Args {
  artifact: string | null;
  sessionDir: string | null;
  delay: number;
  help: boolean;
  version: boolean;
}

interface ParsedFixture {
  piVersion: string;
  events: unknown[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { artifact: null, sessionDir: null, delay: 5, help: false, version: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--artifact") args.artifact = argv[++i] ?? null;
    else if (a === "--session-dir") args.sessionDir = argv[++i] ?? null;
    else if (a === "--delay") args.delay = Number.parseInt(argv[++i] ?? "5", 10);
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--version") args.version = true;
  }
  return args;
}

function fixturePath(): string {
  // `import.meta.url` is the path to this module. The fixture is a sibling
  // under `fixtures/`.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "fixtures", "golden-pi-events.jsonl");
}

function loadFixture(): ParsedFixture {
  const text = readFileSync(fixturePath(), "utf8");
  const lines = text.split("\n").filter((l) => l.length > 0);
  const events: unknown[] = [];
  let piVersion = "unknown";
  for (const line of lines) {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (typeof obj._fixture === "string" && typeof obj.piVersion === "string") {
      piVersion = obj.piVersion;
      continue;
    }
    events.push(obj);
  }
  return { piVersion, events };
}

function emit(event: unknown): void {
  console.log(JSON.stringify(event));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write("Usage: pi-stub [--artifact <path>] [--session-dir <dir>] [--delay <ms>]\n");
    return;
  }

  if (args.version) {
    const f = loadFixture();
    process.stdout.write(`${f.piVersion}\n`);
    return;
  }

  if (args.sessionDir !== null) {
    mkdirSync(args.sessionDir, { recursive: true });
  }

  const fixture = loadFixture();
  // Print the version on stderr so tests can capture it without intercepting
  // the event stream on stdout.
  process.stderr.write(`pi-stub replaying ${fixture.piVersion}\n`);

  // Backwards-compatibility with the supervisor's `PI_FLEET_PI_DELAY_MS`
  // env knob: an older supervisor still wants a long sleep between events
  // to test capacity and cancel timing. The new stub takes the per-call
  // delay from `--delay`; the env var is a recognised override.
  const envDelay = Number.parseInt(process.env.PI_FLEET_PI_DELAY_MS ?? "", 10);
  const effectiveDelay = Number.isFinite(envDelay) && envDelay > 0 ? envDelay : args.delay;

  let submitPayload: Record<string, unknown> | null = null;
  for (const ev of fixture.events) {
    if (effectiveDelay > 0) await sleep(effectiveDelay);
    emit(ev);
    const obj = ev as Record<string, unknown>;
    if (obj.type === "tool_execution_end") {
      const result = obj.result as { details?: unknown; isError?: boolean } | undefined;
      if (
        typeof obj.toolName === "string" &&
        obj.toolName.startsWith("submit_") &&
        result !== undefined &&
        result.isError !== true &&
        result.details !== undefined &&
        typeof result.details === "object"
      ) {
        submitPayload = result.details as Record<string, unknown>;
      }
    }
  }

  if (args.artifact !== null && submitPayload !== null) {
    // The artifact on disk is the durable record of the seal. It mirrors
    // the submit_* payload with a schema tag the supervisor can validate.
    const artifact = {
      schema: "stage-artifact/1",
      tool: "submit_write",
      result: submitPayload,
      sealedAt: new Date().toISOString(),
    };
    writeFileSync(args.artifact, `${JSON.stringify(artifact, null, 2)}\n`);
  }

  // Mimic Pi's session file: write a JSON file inside the session dir
  // carrying the captured transcript. The driver discovers it after
  // exit. We include a few credential keys so the driver's seal-time
  // scrubber has something to redact in tests.
  if (args.sessionDir !== null) {
    const sessionJson = {
      schema: "session/1",
      name: sessionName(),
      messages: [
        { role: "user", content: "Add a mul function." },
        { role: "assistant", apiKey: "sk-fixture-secret", content: "Done." },
      ],
      metadata: { token: "bearer-fixture-token", model: fixture.piVersion },
    };
    writeFileSync(join(args.sessionDir, `${sessionName()}.json`), `${JSON.stringify(sessionJson, null, 2)}\n`);
  }

  process.exit(0);
}

function sessionName(): string {
  // The stub mirrors the driver's session name derivation: <jobId>-<stageIndex>-<attempt>.
  // The supervisor passes --mode rpc with -n <session>; for the fixture we
  // derive from the process argv. When the driver invokes us, it includes
  // -n <name>; parse it.
  const idx = process.argv.indexOf("-n");
  if (idx >= 0) return process.argv[idx + 1] ?? "fixture-session";
  return "fixture-session";
}

main().catch((error: unknown) => {
  process.stderr.write(`pi-stub: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
