import { pathToFileURL } from "node:url";
import { faultEnvelope, okEnvelope, problemEnvelope } from "./envelope.ts";
import type { Envelope, FaultEnvelope } from "./envelope.ts";

/** The flags the CLI understands. Anything else is invalid input. */
const KNOWN_FLAGS = ["--json"];

/**
 * Process CLI arguments and return an envelope.
 *
 * Recognised verbs: none yet — verbs arrive with the durable store.
 * Unknown flags and unknown verbs both produce an invalid-input envelope.
 *
 * Both the `--json` and bare forms print JSON today. The human-readable render
 * of the same envelope is specified for the bare form and lands with the CLI
 * and MCP adapters, not here.
 */
export function run(argv: string[]): Envelope {
  const args = argv.slice(2); // drop node and script path
  const flags = args.filter((a) => a.startsWith("--"));
  const verbs = args.filter((a) => !a.startsWith("--"));

  const unknownFlag = flags.find(
    (flag) => !KNOWN_FLAGS.some((known) => known === flag),
  );
  if (unknownFlag !== undefined) {
    return problemEnvelope("invalid-input", `unknown flag: ${unknownFlag}`);
  }

  const unknownVerb = verbs[0];
  if (unknownVerb !== undefined) {
    return problemEnvelope("invalid-input", `unknown verb: ${unknownVerb}`);
  }

  return okEnvelope();
}

/** True when this module is the process entry point, not an import. */
function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

/**
 * Print one envelope and set the exit code.
 *
 * `process.exitCode` rather than `process.exit()`: stdout is asynchronous when
 * it is a pipe, and exiting outright abandons a pending write, which would
 * truncate the one envelope the contract promises.
 */
function emit(envelope: Envelope | FaultEnvelope, exitCode: number): void {
  process.stdout.write(JSON.stringify(envelope) + "\n");
  process.exitCode = exitCode;
}

if (isMain()) {
  // Only the envelope is computed inside the try. A throw from the write
  // itself (EPIPE on a closed pipe) must not emit a second envelope.
  let envelope: Envelope | FaultEnvelope;
  let exitCode: number;
  try {
    envelope = run(process.argv);
    exitCode = envelope.ok ? 0 : 1;
  } catch (error) {
    envelope = faultEnvelope(error);
    exitCode = 2;
  }
  emit(envelope, exitCode);
}
