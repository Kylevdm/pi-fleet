/**
 * Minimal Pi stub for ticket 26.
 *
 * Usage:
 *   node --experimental-strip-types src/pi-stub.ts \
 *     --artifact <path> \
 *     --delay <ms> \
 *     [--session-dir <dir>]
 *
 * Writes a stream of JSONL events to stdout, then writes a schema-valid
 * submit_write artifact to the given path after the delay.  If killed
 * before the delay elapses, no artifact is written.
 *
 * This is a stand-in for the real Pi binary (ticket 25).  The supervisor
 * drives it; the acceptance criteria only require that the artifact
 * presence means the stage is sealed.
 */

import { writeFileSync, mkdirSync } from "node:fs";

interface Args {
  artifact: string;
  delay: number;
  sessionDir: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { artifact: "", delay: 5000, sessionDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--artifact") args.artifact = argv[++i] ?? "";
    if (a === "--delay") args.delay = Number.parseInt(argv[++i] ?? "5000", 10);
    if (a === "--session-dir") args.sessionDir = argv[++i] ?? null;
  }
  return args;
}

function emit(event: Record<string, unknown>): void {
  console.log(JSON.stringify(event));
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.sessionDir !== null) {
    mkdirSync(args.sessionDir, { recursive: true });
  }

  emit({ event: "agent_start", timestamp: Date.now() });

  const deadline = Date.now() + args.delay;

  // Heartbeat loop so SIGTERM arrives while we are alive (not blocked in
  // a single sleep).
  const interval = setInterval(() => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      clearInterval(interval);
      finish();
    } else {
      emit({ event: "heartbeat", remaining });
    }
  }, 200);

  function finish(): void {
    emit({ event: "agent_settled", timestamp: Date.now() });
    const artifact = {
      schema: "stage-artifact/1",
      tool: "submit_write",
      result: { files: [{ path: "stub.txt", content: "written by pi-stub" }] },
      sealedAt: new Date().toISOString(),
    };
    writeFileSync(args.artifact, `${JSON.stringify(artifact, null, 2)}\n`);
    process.exit(0);
  }

  // SIGTERM handler: stop gracefully without writing the artifact.
  process.once("SIGTERM", () => {
    clearInterval(interval);
    emit({ event: "terminated", signal: "SIGTERM" });
    process.exit(0);
  });
}

main();
