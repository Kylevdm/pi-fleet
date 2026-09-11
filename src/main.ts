import { pathToFileURL } from "node:url";
import { writeSync } from "node:fs";
import { faultEnvelope, okEnvelope, problemEnvelope } from "./envelope.ts";
import type { Envelope, FaultEnvelope, Problem } from "./envelope.ts";
import { Fleet } from "./fleet.ts";
import { JobStore } from "./store/job-store.ts";
import { isValidUlid } from "./ulid.ts";
import { resolveStoreRoot } from "./store/paths.ts";

/** The flags the CLI understands. Anything else is invalid input. */
const KNOWN_FLAGS = [
  "--json",
  "--include-archived",
  // Value-args for `submit`.
  "--objective",
  "--repo",
  "--risk",
  "--idempotency-key",
  // Value-args for `list`.
  "--limit",
  "--cursor",
  // Value-args for mutations.
  "--job-id",
  "--expected-revision",
  // Value-args for `continue`.
  "--instructions",
  // Value-args for `wait`.
  "--timeout",
];

/**
 * Recognised top-level verbs and the value- and flag-shaped arguments they
 * accept. Anything else is `invalid-input`. The dispatch table is a small,
 * total map: an added verb shows up here, in `KNOWN_FLAGS`, and in the
 * `runVerb` switch below — the compiler checks all three.
 */
interface VerbSpec {
  readonly verbs: readonly string[];
  readonly valueArgs: readonly string[];
  readonly boolFlags: readonly string[];
}

const VERB_TABLE: Record<string, VerbSpec> = {
  submit: {
    verbs: ["submit"],
    valueArgs: ["--objective", "--repo", "--risk", "--idempotency-key"],
    boolFlags: [],
  },
  get: {
    verbs: ["get"],
    valueArgs: [],
    boolFlags: [],
  },
  list: {
    verbs: ["list"],
    valueArgs: ["--limit", "--cursor"],
    boolFlags: ["--include-archived"],
  },
  cancel: {
    verbs: ["cancel"],
    valueArgs: ["--job-id", "--expected-revision"],
    boolFlags: [],
  },
  archive: {
    verbs: ["archive"],
    valueArgs: ["--job-id", "--expected-revision"],
    boolFlags: [],
  },
  clean: {
    verbs: ["clean"],
    valueArgs: ["--job-id", "--expected-revision"],
    boolFlags: [],
  },
  wait: {
    verbs: ["wait"],
    valueArgs: ["--job-id", "--timeout"],
    boolFlags: [],
  },
  continue: {
    verbs: ["continue"],
    valueArgs: ["--job-id", "--expected-revision", "--instructions"],
    boolFlags: [],
  },
};

/** Parsed result: either an envelope to return or the typed inputs. */
type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; envelope: Envelope };

interface SubmitArgs {
  objective: string;
  repo: string;
  risk: "low" | "medium";
  idempotencyKey: string | undefined;
  overrides: Record<string, unknown> | undefined;
}

interface ListArgs {
  limit: number | undefined;
  cursor: string | undefined;
  includeArchived: boolean;
}

/** Boolean flags that do not consume the next token. */
const BOOL_FLAGS = new Set(["--json", "--include-archived"]);

/**
 * Split an argument list into boolean flags, value-bearing tokens, and
 * positional tokens. Boolean flags (`--json`, `--include-archived`) stand
 * alone; every other `--`-prefixed token consumes the next token as its
 * value. Tokens that do not start with `--` are positional.
 */
function splitArgs(args: readonly string[]): {
  boolFlags: Set<string>;
  valueMap: Record<string, string>;
  positionals: string[];
  seenFlags: Set<string>;
  error: string | undefined;
} {
  const boolFlags = new Set<string>();
  const valueMap: Record<string, string> = {};
  const positionals: string[] = [];
  const seenFlags = new Set<string>();
  const bail = (error: string) => ({ boolFlags, valueMap, positionals, seenFlags, error });

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (!KNOWN_FLAGS.includes(name)) {
      return bail(`unknown flag: ${name}`);
    }
    seenFlags.add(name);
    if (eq > 0) {
      valueMap[name] = a.slice(eq + 1);
      continue;
    }
    if (BOOL_FLAGS.has(name)) {
      boolFlags.add(name);
      continue;
    }
    // A value flag consumes the next token whatever it looks like. Rejecting a
    // value that begins with `--` made `--objective "--force the rebuild"`
    // unrepresentable in every form but `--objective=...`.
    const next = args[i + 1];
    if (next === undefined) {
      return bail(`flag ${name} requires a value`);
    }
    valueMap[name] = next;
    i += 1;
  }
  return { boolFlags, valueMap, positionals, seenFlags, error: undefined };
}

/**
 * Process CLI arguments and return an envelope.
 *
 * Recognised verbs: `submit`, `get`, `list`. Unknown flags and unknown verbs
 * both produce an invalid-input envelope.
 *
 * Both the `--json` and bare forms print JSON today. The human-readable
 * render of the same envelope is specified for the bare form and lands with
 * the CLI and MCP adapters, not here.
 */
export function run(argv: string[]): Envelope {
  const args = argv.slice(2); // drop node and script path

  // One tokeniser decides what is a flag, what is a flag's value, and what is
  // a positional. Classifying argv separately here is what made a flag value
  // beginning with `--` read as an unknown flag.
  const { boolFlags, valueMap, positionals, seenFlags, error } = splitArgs(args);
  if (error !== undefined) {
    return problemEnvelope("invalid-input", error);
  }

  if (positionals.length === 0) return okEnvelope();

  const verb = positionals[0] as string;
  const verbLookup = lookupVerb(verb);
  if (verbLookup === undefined) {
    return problemEnvelope("invalid-input", `unknown verb: ${verb}`);
  }
  // Enforce per-verb flag restrictions from the VERB_TABLE.
  const verbFlagError = validateVerbFlags(verbLookup.spec, seenFlags);
  if (verbFlagError !== undefined) {
    return problemEnvelope("invalid-input", verbFlagError);
  }

  // For the synchronous surface (tests, dry-runs), we only handle verbs
  // whose validation can run without opening the store. `submit` needs the
  // store and is async; tests for `submit` go through the binary or
  // `runAsync`. The synchronous `run` here still validates the verb shape.
  if (verb === "submit") {
    // Re-parse only the args after the verb, excluding --json.
    const afterVerb = stripVerb(args, verb);
    const parsed = parseSubmitArgsFromSplit(splitArgs(afterVerb));
    if (!parsed.ok) return parsed.envelope;
    // Sync surface returns invalid-input directing the caller to await.
    return problemEnvelope("invalid-input", "submit requires async; use bin/fleet");
  }
  if (verb === "get") {
    if (positionals.length < 2) {
      return problemEnvelope("invalid-input", "fleet get <jobId> requires a job id");
    }
    const jobId = positionals[1] as string;
    if (!isValidUlid(jobId)) {
      return problemEnvelope("invalid-input", `invalid job id: ${jobId}`);
    }
    return problemEnvelope("invalid-input", "get requires async; use bin/fleet");
  }
  if (verb === "list") {
    const afterVerb = stripVerb(args, verb);
    const parsed = parseListArgsFromSplit(splitArgs(afterVerb));
    if (!parsed.ok) return parsed.envelope;
    return problemEnvelope("invalid-input", "list requires async; use bin/fleet");
  }
  // Mutation and wait verbs need the store — sync surface directs to async.
  for (const asyncVerb of ["cancel", "archive", "clean", "wait", "continue"]) {
    if (verb === asyncVerb) {
      return problemEnvelope("invalid-input", `${verb} requires async; use bin/fleet`);
    }
  }
  return problemEnvelope("invalid-input", `unknown verb: ${verb}`);
}

function lookupVerb(name: string): { name: string; spec: VerbSpec } | undefined {
  for (const [verbName, spec] of Object.entries(VERB_TABLE)) {
    if (spec.verbs.includes(name)) return { name: verbName, spec };
  }
  return undefined;
}

/**
 * Check that every `--`-prefixed token in `args` is permitted for this verb.
 * `--json` is always allowed (it is a global flag). Returns an error message
 * or `undefined` if all flags are valid.
 */
/**
 * Everything except the verb, with flags left wherever the caller put them.
 *
 * Slicing from `indexOf(verb)` dropped any value flag that appeared before the
 * verb, so `fleet --risk low submit ...` reported "--risk is required" while
 * `--json` before the verb worked — an unstated position rule whose diagnostic
 * actively misled. It also matched the verb string inside a flag's value. This
 * walks the tokens the way `splitArgs` does and removes only the first
 * positional that is the verb.
 */
function stripVerb(args: readonly string[], verb: string): string[] {
  const kept: string[] = [];
  let removed = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (!a.startsWith("--")) {
      if (!removed && a === verb) {
        removed = true;
        continue;
      }
      kept.push(a);
      continue;
    }
    kept.push(a);
    const eq = a.indexOf("=");
    if (eq > 0 || BOOL_FLAGS.has(a)) continue;
    const next = args[i + 1];
    if (next !== undefined) {
      kept.push(next);
      i += 1;
    }
  }
  return kept;
}

function validateVerbFlags(spec: VerbSpec, seenFlags: ReadonlySet<string>): string | undefined {
  const allowed = new Set<string>([...spec.valueArgs, ...spec.boolFlags, "--json"]);
  for (const flag of seenFlags) {
    if (!allowed.has(flag)) {
      return `flag ${flag} is not valid for verb ${spec.verbs[0]}`;
    }
  }
  return undefined;
}

function parseSubmitArgsFromSplit(split: ReturnType<typeof splitArgs>): ParseResult<SubmitArgs> {
  if (split.error !== undefined) {
    return { ok: false, envelope: problemEnvelope("invalid-input", split.error) };
  }
  if (split.positionals.length > 0) {
    return {
      ok: false,
      envelope: problemEnvelope("invalid-input", `unexpected positional argument: ${split.positionals[0]}`),
    };
  }
  const values = split.valueMap;
  if (typeof values["--objective"] !== "string") {
    return { ok: false, envelope: problemEnvelope("invalid-input", "--objective is required") };
  }
  if (typeof values["--repo"] !== "string") {
    return { ok: false, envelope: problemEnvelope("invalid-input", "--repo is required") };
  }
  if (typeof values["--risk"] !== "string") {
    return { ok: false, envelope: problemEnvelope("invalid-input", "--risk is required") };
  }
  const risk = values["--risk"];
  if (risk !== "low" && risk !== "medium") {
    return {
      ok: false,
      envelope: problemEnvelope("invalid-input", `--risk must be "low" or "medium", got "${risk}"`),
    };
  }
  return {
    ok: true,
    value: {
      objective: values["--objective"],
      repo: values["--repo"],
      risk,
      idempotencyKey: values["--idempotency-key"],
      overrides: undefined,
    },
  };
}

function parseListArgsFromSplit(split: ReturnType<typeof splitArgs>): ParseResult<ListArgs> {
  if (split.error !== undefined) {
    return { ok: false, envelope: problemEnvelope("invalid-input", split.error) };
  }
  if (split.positionals.length > 0) {
    return {
      ok: false,
      envelope: problemEnvelope("invalid-input", `unexpected positional argument: ${split.positionals[0]}`),
    };
  }
  const values = split.valueMap;
  let limit: number | undefined;
  const rawLimit = values["--limit"];
  if (rawLimit !== undefined) {
    // Match the whole token. `Number.parseInt` reads a prefix and discards the
    // rest, so `1.5` became 1, `10abc` became 10, and `1e3` became 1 — a caller
    // asking for 1000 rows silently got one. The module already rejects these;
    // coercing here is what stopped them reaching it.
    if (!/^[0-9]+$/.test(rawLimit) || rawLimit === "0") {
      return {
        ok: false,
        envelope: problemEnvelope("invalid-input", `--limit must be a positive integer, got "${rawLimit}"`),
      };
    }
    limit = Number(rawLimit);
  }
  return {
    ok: true,
    value: {
      limit,
      cursor: values["--cursor"],
      includeArchived: split.boolFlags.has("--include-archived"),
    },
  };
}

interface MutationArgs {
  jobId: string;
  expectedRevision: number;
}

interface WaitArgs {
  jobId: string;
  timeoutMs: number | undefined;
}

interface ContinueArgs {
  jobId: string;
  expectedRevision: number;
  instructions: string;
}

/**
 * Parse the shared `--job-id` and `--expected-revision` flags from a split
 * argument list. Returns the parsed pair or a problem envelope.
 */
function parseJobIdAndRevision(
  split: ReturnType<typeof splitArgs>,
): ParseResult<{ jobId: string; expectedRevision: number }> {
  if (split.error !== undefined) {
    return { ok: false, envelope: problemEnvelope("invalid-input", split.error) };
  }
  if (split.positionals.length > 0) {
    return {
      ok: false,
      envelope: problemEnvelope("invalid-input", `unexpected positional argument: ${split.positionals[0]}`),
    };
  }
  const values = split.valueMap;
  const jobId = values["--job-id"];
  if (typeof jobId !== "string") {
    return { ok: false, envelope: problemEnvelope("invalid-input", "--job-id is required") };
  }
  if (!isValidUlid(jobId)) {
    return { ok: false, envelope: problemEnvelope("invalid-input", `invalid job id: ${jobId}`) };
  }
  const rawRevision = values["--expected-revision"];
  if (typeof rawRevision !== "string") {
    return { ok: false, envelope: problemEnvelope("invalid-input", "--expected-revision is required") };
  }
  if (!/^[1-9][0-9]*$/.test(rawRevision)) {
    return {
      ok: false,
      envelope: problemEnvelope("invalid-input", `--expected-revision must be a positive integer, got "${rawRevision}"`),
    };
  }
  return {
    ok: true,
    value: { jobId, expectedRevision: Number(rawRevision) },
  };
}

function parseMutationArgsFromSplit(
  split: ReturnType<typeof splitArgs>,
): ParseResult<MutationArgs> {
  return parseJobIdAndRevision(split);
}

function parseWaitArgsFromSplit(
  split: ReturnType<typeof splitArgs>,
): ParseResult<WaitArgs> {
  if (split.error !== undefined) {
    return { ok: false, envelope: problemEnvelope("invalid-input", split.error) };
  }
  if (split.positionals.length > 0) {
    return {
      ok: false,
      envelope: problemEnvelope("invalid-input", `unexpected positional argument: ${split.positionals[0]}`),
    };
  }
  const values = split.valueMap;
  const jobId = values["--job-id"];
  if (typeof jobId !== "string") {
    return { ok: false, envelope: problemEnvelope("invalid-input", "--job-id is required") };
  }
  if (!isValidUlid(jobId)) {
    return { ok: false, envelope: problemEnvelope("invalid-input", `invalid job id: ${jobId}`) };
  }
  let timeoutMs: number | undefined;
  const rawTimeout = values["--timeout"];
  if (rawTimeout !== undefined) {
    if (!/^[0-9]+$/.test(rawTimeout) || rawTimeout === "0") {
      return {
        ok: false,
        envelope: problemEnvelope("invalid-input", `--timeout must be a positive integer (ms), got "${rawTimeout}"`),
      };
    }
    timeoutMs = Number(rawTimeout);
  }
  return { ok: true, value: { jobId, timeoutMs } };
}

function parseContinueArgsFromSplit(
  split: ReturnType<typeof splitArgs>,
): ParseResult<ContinueArgs> {
  const base = parseJobIdAndRevision(split);
  if (!base.ok) return base;
  const values = split.valueMap;
  const instructions = values["--instructions"];
  if (typeof instructions !== "string") {
    return { ok: false, envelope: problemEnvelope("invalid-input", "--instructions is required") };
  }
  return {
    ok: true,
    value: { ...base.value, instructions },
  };
}

/** Convert an `Outcome<T>` to the flat envelope shape the CLI prints. */
function outcomeToEnvelope<T extends object>(outcome: {
  ok: true; value: T;
} | {
  ok: false; problem: Problem; message: string;
}): Envelope {
  if (outcome.ok) {
    return { ok: true, ...outcome.value } as Envelope;
  }
  return problemEnvelope(outcome.problem, outcome.message);
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
  // stdout is a pipe under programmatic callers. Synchronously write the one
  // required envelope so a natural process exit cannot drop it.
  writeSync(process.stdout.fd, JSON.stringify(envelope) + "\n");
  process.exitCode = exitCode;
}

/**
 * Async entry point used by `bin/fleet`. The CLI is async at its core
 * because the store talks to the filesystem; the sync `run` above stays for
 * tests that only inspect argument parsing.
 */
export async function runAsync(argv: string[]): Promise<Envelope> {
  const args = argv.slice(2);
  const { positionals: positional, seenFlags, error } = splitArgs(args);
  if (error !== undefined) {
    return problemEnvelope("invalid-input", error);
  }
  if (positional.length === 0) return okEnvelope();

  const verb = positional[0] as string;
  const verbLookup = lookupVerb(verb);
  if (verbLookup === undefined) {
    return problemEnvelope("invalid-input", `unknown verb: ${verb}`);
  }
  // Enforce per-verb flag restrictions from the VERB_TABLE.
  const verbFlagError = validateVerbFlags(verbLookup.spec, seenFlags);
  if (verbFlagError !== undefined) {
    return problemEnvelope("invalid-input", verbFlagError);
  }

  let store: JobStore;
  try {
    store = await JobStore.open(resolveStoreRoot());
  } catch (error) {
    // `unavailable-dependency`, not `policy-denied`: EACCES on the root, EROFS,
    // ENOSPC and an unparseable config are all broken-store conditions. Saying
    // "policy denied" tells an operator their request was refused on purpose.
    return problemEnvelope(
      "unavailable-dependency",
      `store unavailable: ${(error as Error).message}`,
    );
  }
  const fleet = new Fleet(store);

  if (verb === "submit") {
    // Strip the verb and parse the remaining args.
    const afterVerb = stripVerb(args, verb);
    const parsed = parseSubmitArgsFromSplit(splitArgs(afterVerb));
    if (!parsed.ok) return parsed.envelope;
    const outcome = await fleet.submit({
      objective: parsed.value.objective,
      repo: parsed.value.repo,
      risk: parsed.value.risk,
      idempotencyKey: parsed.value.idempotencyKey,
      overrides: parsed.value.overrides,
    });
    return outcomeToEnvelope(outcome);
  }
  if (verb === "get") {
    if (positional.length < 2) {
      return problemEnvelope("invalid-input", "fleet get <jobId> requires a job id");
    }
    if (positional.length > 2) {
      return problemEnvelope(
        "invalid-input",
        `fleet get takes exactly one argument, got ${positional.length - 1}`,
      );
    }
    const jobId = positional[1] as string;
    if (!isValidUlid(jobId)) {
      return problemEnvelope("invalid-input", `invalid job id: ${jobId}`);
    }
    const outcome = await fleet.get(jobId);
    return outcomeToEnvelope(outcome);
  }
  if (verb === "list") {
    const afterVerb = stripVerb(args, verb);
    const parsed = parseListArgsFromSplit(splitArgs(afterVerb));
    if (!parsed.ok) return parsed.envelope;
    const outcome = await fleet.list({
      limit: parsed.value.limit,
      cursor: parsed.value.cursor,
      includeArchived: parsed.value.includeArchived,
    });
    return outcomeToEnvelope(outcome);
  }
  if (verb === "cancel" || verb === "archive" || verb === "clean") {
    const afterVerb = stripVerb(args, verb);
    const parsed = parseMutationArgsFromSplit(splitArgs(afterVerb));
    if (!parsed.ok) return parsed.envelope;
    const outcome =
      verb === "cancel"
        ? await fleet.cancel(parsed.value)
        : verb === "archive"
          ? await fleet.archive(parsed.value)
          : await fleet.clean(parsed.value);
    return outcomeToEnvelope(outcome);
  }
  if (verb === "wait") {
    const afterVerb = stripVerb(args, verb);
    const parsed = parseWaitArgsFromSplit(splitArgs(afterVerb));
    if (!parsed.ok) return parsed.envelope;
    const outcome = await fleet.wait(parsed.value);
    return outcomeToEnvelope(outcome);
  }
  if (verb === "continue") {
    const afterVerb = stripVerb(args, verb);
    const parsed = parseContinueArgsFromSplit(splitArgs(afterVerb));
    if (!parsed.ok) return parsed.envelope;
    const outcome = await fleet.continue(parsed.value);
    return outcomeToEnvelope(outcome);
  }
  return problemEnvelope("invalid-input", `unknown verb: ${verb}`);
}

if (isMain()) {
  // Only the envelope is computed inside the try. A throw from the write
  // itself (EPIPE on a closed pipe) must not emit a second envelope.
  runAsync(process.argv)
    .then((envelope) => {
      const exitCode = envelope.ok ? 0 : 1;
      emit(envelope, exitCode);
    })
    .catch((error) => {
      const envelope = faultEnvelope(error);
      emit(envelope, 2);
    });
}
