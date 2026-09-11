import type { Problem } from "./envelope.ts";
import type { JobStatus, RiskClass, StageState } from "./store/records.ts";
import type { StoreOutcome } from "./store/job-store.ts";
import { JobStore, hashIdempotencyKey, Paths } from "./store/job-store.ts";
import { createUlidGenerator } from "./ulid.ts";
import { resolveRepoRealpath } from "./store/paths.ts";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

/**
 * Outcome returned by every public Fleet method. Mirrors the `Outcome`
 * envelope from ticket 01: either a value or a typed problem. Exceptions
 * are reserved for unexpected faults.
 */
export type Outcome<T> = StoreOutcome<T>;

/** A single record of a job's current state. */
export interface Admission {
  jobId: string;
  revision: number;
  status: JobStatus;
  next: readonly string[];
  size: SizeBudget;
  admittedAt: string;
}

export interface JobView {
  jobId: string;
  revision: number;
  status: JobStatus;
  stage: string | null;
  stageState: StageState | null;
  waitingReason: string | null;
  next: readonly string[];
  risk: RiskClass;
  repo: string;
  objective: string;
  createdAt: string;
  updatedAt: string;
  size: SizeBudget;
}

export interface JobSummary {
  jobId: string;
  status: JobStatus;
  risk: RiskClass;
  repo: string;
  objectiveExcerpt: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface JobQuery {
  limit?: number;
  cursor?: string;
  includeArchived?: boolean;
}

export interface JobPage {
  jobs: readonly JobSummary[];
  nextCursor: string | null;
  size: SizeBudget;
  unreadable: number;
}

export interface SizeBudget {
  bytes: number;
  softLimitBytes: number;
  overBudget: boolean;
}

export interface SubmitRequest {
  objective: string;
  repo: string;
  risk: RiskClass;
  idempotencyKey?: string;
  overrides?: Record<string, unknown>;
}

export interface WaitRequest {
  jobId: string;
  timeoutMs?: number;
}

export interface MutationRequest {
  jobId: string;
  expectedRevision: number;
}

export type SupervisorSpawner = (storeRoot: string, jobId: string) => void;

const MAX_WAIT_MS = 60_000;
const WAIT_POLL_MS = 250;

/**
 * Hard cap on the objective text. The brief says "bounded"; 4 KiB matches
 * what humans paste into a ticket title and is generous for the description.
 */
const OBJECTIVE_MAX_BYTES = 4096;

/**
 * Length of the bounded excerpt on a `JobSummary`. The spec says "no
 * objective body beyond a bounded excerpt"; 120 is the brief's reading.
 */
const OBJECTIVE_EXCERPT_LEN = 120;

/**
 * How long `submit` waits for a concurrent winner's job to become readable
 * before returning `conflict`: 40 attempts at 25ms, so about one second.
 */
const SETTLE_ATTEMPTS = 40;
const SETTLE_SLEEP_MS = 25;

/**
 * Default page size for `list`. The spec says "bounded default and maximum
 * page size"; 50 and 200 are the typical pagination defaults.
 */
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/** Total `next` mapping for every one of the seven public states. */
const NEXT_TABLE: Readonly<Record<JobStatus, readonly string[]>> = {
  admitted: ["get", "wait", "cancel"],
  running: ["get", "wait", "cancel"],
  waiting: ["get", "wait", "cancel", "continue"],
  "ready-for-acceptance": ["get", "report", "diff", "checks", "accept", "cancel"],
  "returned-to-orchestrator": [
    "get",
    "report",
    "diff",
    "checks",
    "continue",
    "clean",
    "archive",
  ],
  cancelled: ["get", "report", "clean", "archive"],
  archived: ["get", "report", "purge"],
};

/**
 * The `next` verb list legal for a given status. Returned array is frozen
 * so callers cannot mutate the table by accident.
 */
export function nextFor(status: JobStatus): readonly string[] {
  return NEXT_TABLE[status];
}

/**
 * Validate a risk class. Anything other than exactly `low` or `medium` is
 * rejected — case-folding is not done, the spec is strict.
 */
export function validateRisk(value: unknown): Outcome<RiskClass> {
  if (value === "low" || value === "medium") {
    return { ok: true, value };
  }
  return {
    ok: false,
    problem: "invalid-input",
    message: `risk must be "low" or "medium", got ${JSON.stringify(value)}`,
  };
}

/**
 * Validate an objective. Required, non-empty after trimming, and bounded
 * by `OBJECTIVE_MAX_BYTES` bytes. We measure bytes, not characters, because
 * the storage path serialises the string.
 */
export function validateObjective(value: unknown): Outcome<string> {
  if (typeof value !== "string") {
    return { ok: false, problem: "invalid-input", message: "objective must be a string" };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, problem: "invalid-input", message: "objective must be non-empty" };
  }
  // Byte-length is the storage-relevant measure; we keep the original string
  // (trimming only for the emptiness check) so the caller sees exactly what
  // they submitted.
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > OBJECTIVE_MAX_BYTES) {
    return {
      ok: false,
      problem: "invalid-input",
      message: `objective exceeds ${OBJECTIVE_MAX_BYTES} bytes`,
    };
  }
  return { ok: true, value };
}

/**
 * Validate the optional overrides map. The brief does not enumerate the
 * permitted keys; we accept any object whose values are JSON-serialisable
 * and refuse everything else. A later ticket refines the whitelist; this
 * only enforces the boundary that prevents a caller smuggling credentials
 * or paths into the store.
 */
export function validateOverrides(value: unknown): Outcome<Record<string, unknown>> {
  if (value === undefined) return { ok: true, value: {} };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, problem: "invalid-input", message: "overrides must be an object" };
  }
  const obj = value as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof k !== "string" || k.length === 0) {
      return { ok: false, problem: "invalid-input", message: "override keys must be non-empty strings" };
    }
    if (!isJsonSafe(v)) {
      return {
        ok: false,
        problem: "invalid-input",
        message: `override ${k} is not a JSON-safe value`,
      };
    }
  }
  return { ok: true, value: obj };
}

function isJsonSafe(v: unknown): boolean {
  if (v === undefined) return false;
  try {
    JSON.stringify(v);
    return true;
  } catch {
    return false;
  }
}

/**
 * A clock is any function returning the current millisecond timestamp. The
 * Fleet module takes a clock rather than reading `Date.now` so tests can
 * pin admission timestamps deterministically.
 */
export type Clock = () => number;

/** Real clock — production default. */
export const systemClock: Clock = () => Date.now();

/**
 * The Fleet module. Composed from a `JobStore` and a clock so tests can
 * build it with a fresh tmpdir; production wires the resolved store root
 * and the system clock.
 */
export class Fleet {
  readonly store: JobStore;
  readonly clock: Clock;
  private readonly jobIdGenerator: () => string;
  private readonly supervisorSpawner: SupervisorSpawner;

  constructor(
    store: JobStore,
    clock: Clock = systemClock,
    supervisorSpawner?: SupervisorSpawner,
  ) {
    this.store = store;
    this.clock = clock;
    this.jobIdGenerator = createUlidGenerator(() => this.clock());
    this.supervisorSpawner = supervisorSpawner ?? defaultSupervisorSpawner;
  }

  /**
   * Submit a standalone objective for admission. The job sits in `admitted`
   * forever — this ticket has no supervisor to pick it up. The job id is a
   * freshly minted ULID unless `idempotencyKey` resolves to an earlier
   * admission, in which case the original id is returned.
   */
  async submit(request: SubmitRequest): Promise<Outcome<Admission>> {
    if (this.store.readOnly) {
      return { ok: false, problem: "policy-denied", message: "store is read-only (unknown schema major)" };
    }

    const riskOutcome = validateRisk(request.risk);
    if (!riskOutcome.ok) return riskOutcome;

    const objOutcome = validateObjective(request.objective);
    if (!objOutcome.ok) return objOutcome;

    const overridesOutcome = validateOverrides(request.overrides);
    if (!overridesOutcome.ok) return overridesOutcome;

    const repoRealpath = resolveRepoRealpath(this.store.root, request.repo);
    if (repoRealpath === null) {
      return {
        ok: false,
        problem: "invalid-input",
        message: `repo is not an existing git working tree: ${request.repo}`,
      };
    }

    const now = this.clock();
    const admittedAt = new Date(now).toISOString();
    const idempotencyKey = request.idempotencyKey;
    // An explicitly empty key is a caller mistake, not a request for no
    // idempotency: `--idempotency-key=` used to disable the guarantee silently.
    if (typeof idempotencyKey === "string" && idempotencyKey.trim().length === 0) {
      return {
        ok: false,
        problem: "invalid-input",
        message: "idempotency key must not be empty",
      };
    }
    const hasKey = typeof idempotencyKey === "string" && idempotencyKey.length > 0;

    // Idempotency: an existing claim either resolves to the winner's
    // admission (once its job is readable) or, when genuinely abandoned,
    // is reclaimed so this submit can re-claim the slot. A live claim is
    // never deleted out from under its owner.
    if (hasKey) {
      const settled = await this.settleIdempotency(hashIdempotencyKey(idempotencyKey));
      if (settled.kind === "winner") {
        return { ok: true, value: settled.admission };
      }
      if (settled.kind === "problem") {
        return { ok: false, problem: settled.problem, message: settled.message };
      }
      // settled.kind === "reclaimed": the key is free; create the job below.
    }

    const jobId = this.jobIdGenerator();
    const revision = 1;

    if (hasKey) {
      const hash = hashIdempotencyKey(idempotencyKey);
      const claim = await this.store.writeIdempotencyRecord(hash, {
        key: idempotencyKey,
        jobId,
        createdAt: admittedAt,
      });
      if (!claim.ok) return claim;
      if (!claim.value.claimed) {
        const settled = await this.settleIdempotency(hash);
        if (settled.kind === "winner") {
          return { ok: true, value: settled.admission };
        }
        if (settled.kind === "problem") {
          return { ok: false, problem: settled.problem, message: settled.message };
        }
        return {
          ok: false,
          problem: "conflict",
          message: "lost idempotency race and the winner's claim was reclaimed",
        };
      }
    }

    // Write the immutable input snapshot first so the job record can never
    // reference an objective that has no durable backing.
    const snapshotOutcome = await this.store.writeInputSnapshot(jobId, {
      objective: objOutcome.value,
      repo: repoRealpath,
      risk: riskOutcome.value,
      overrides: overridesOutcome.value,
      admittedAt,
      idempotencyKey: idempotencyKey ?? null,
    });
    if (!snapshotOutcome.ok) return snapshotOutcome;

    // Write the job record.
    const jobOutcome = await this.store.writeJobNew(
      jobId,
      riskOutcome.value,
      repoRealpath,
      "admitted",
      { createdAt: admittedAt, updatedAt: admittedAt },
    );
    if (!jobOutcome.ok) return jobOutcome;

    // Spawn the detached supervisor before returning.
    this.supervisorSpawner(this.store.root, jobId);

    const size = await this.computeSize();
    return {
      ok: true,
      value: {
        jobId,
        revision,
        status: "admitted",
        next: nextFor("admitted"),
        size,
        admittedAt,
      },
    };
  }

  /**
   * Resolve an existing idempotency claim. Returns the winner's admission
   * once its job is readable; returns `reclaimed` when the claim is a
   * genuinely abandoned one that the store has now released; returns a
   * typed problem for a record the store cannot parse.
   */
  private async settleIdempotency(
    hash: string,
  ): Promise<
    | { kind: "winner"; admission: Admission }
    | { kind: "reclaimed" }
    | { kind: "problem"; problem: Problem; message: string }
  > {
    // Bounded. An unbounded `for(;;)` with a 10ms sleep turned a crashed
    // winner into a CLI invocation that silently spun for the full reclaim
    // window (60s) at ~100 filesystem round-trips a second. A caller is better
    // served by `conflict` and its own retry than by a command that hangs.
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
      const current = await this.store.readIdempotencyRecord(hash);
      if (!current.ok) {
        if (current.problem === "not-found") return { kind: "reclaimed" };
        return { kind: "problem", problem: current.problem, message: current.message };
      }
      const job = await this.store.readJob(current.value.jobId);
      if (job.ok) {
        const size = await this.computeSize();
        return {
          kind: "winner",
          admission: {
            jobId: job.value.jobId,
            revision: job.value.revision,
            status: job.value.status,
            next: nextFor(job.value.status),
            size,
            admittedAt: current.value.createdAt,
          },
        };
      }
      const reclaim = await this.store.reclaimIdempotencyRecord(hash);
      if (!reclaim.ok) {
        return { kind: "problem", problem: reclaim.problem, message: reclaim.message };
      }
      if (reclaim.value.reclaimed) return { kind: "reclaimed" };
      await sleep(SETTLE_SLEEP_MS);
    }
    return {
      kind: "problem",
      problem: "conflict",
      message:
        "another submit holds this idempotency key and its job is not yet readable; retry",
    };
  }

  /** Read a job by id. Returns `not-found` for unknown ids. */
  async get(jobId: string): Promise<Outcome<JobView>> {
    if (typeof jobId !== "string" || jobId.length === 0) {
      return { ok: false, problem: "invalid-input", message: "job id required" };
    }
    if (!isJobIdWellFormed(jobId)) {
      return { ok: false, problem: "invalid-input", message: `invalid job id: ${jobId}` };
    }
    const job = await this.store.readJob(jobId);
    if (!job.ok) return job;
    const snapshot = await this.store.readInputSnapshot(jobId);
    if (!snapshot.ok) {
      return {
        ok: false,
        problem: snapshot.problem,
        message: `job ${jobId} has no readable input snapshot: ${snapshot.message}`,
      };
    }
    const size = await this.computeSize();
    const obj = (snapshot.value as Record<string, unknown>).objective;
    const objective = typeof obj === "string" ? obj : "";
    return {
      ok: true,
      value: {
        jobId: job.value.jobId,
        revision: job.value.revision,
        status: job.value.status,
        stage: job.value.stage ?? null,
        stageState: job.value.stageState ?? null,
        waitingReason: job.value.waitingReason ?? null,
        next: nextFor(job.value.status),
        risk: job.value.risk,
        repo: job.value.repo,
        objective,
        createdAt: job.value.createdAt,
        updatedAt: job.value.updatedAt,
        size,
      },
    };
  }

  /**
   * Wait for a job to reach a terminal-ish state.  Blocks up to 60 seconds
   * (clamped).  Returns immediately if the job is already in one of the
   * wake states.  The envelope carries `timedOut: true` when the deadline
   * expires without a wake state.
   */
  async wait(request: WaitRequest): Promise<Outcome<JobView & { timedOut?: boolean }>> {
    const jobId = request.jobId;
    if (typeof jobId !== "string" || jobId.length === 0) {
      return { ok: false, problem: "invalid-input", message: "job id required" };
    }
    if (!isJobIdWellFormed(jobId)) {
      return { ok: false, problem: "invalid-input", message: `invalid job id: ${jobId}` };
    }

    const timeoutMs = Math.min(request.timeoutMs ?? MAX_WAIT_MS, MAX_WAIT_MS);
    const deadline = this.clock() + timeoutMs;
    const wakeStates = new Set<JobStatus>([
      "ready-for-acceptance",
      "returned-to-orchestrator",
      "cancelled",
    ]);

    while (this.clock() < deadline) {
      const job = await this.store.readJob(jobId);
      if (!job.ok) {
        if (job.problem === "not-found") return job;
        // On unreadable records, keep polling — the record may heal.
      } else if (wakeStates.has(job.value.status)) {
        const view = await this.get(jobId);
        if (!view.ok) return view;
        return { ok: true, value: { ...view.value, timedOut: false } };
      }
      const remaining = deadline - this.clock();
      if (remaining <= 0) break;
      await sleep(Math.min(WAIT_POLL_MS, remaining));
    }

    const view = await this.get(jobId);
    if (!view.ok) return view;
    return { ok: true, value: { ...view.value, timedOut: true } };
  }

  /**
   * Cancel a job.  Breaks the supervisor lease, terminates the Pi process,
   * releases capacity, and preserves every record.
   */
  async cancel(request: MutationRequest): Promise<Outcome<JobView>> {
    if (typeof request.jobId !== "string" || request.jobId.length === 0) {
      return { ok: false, problem: "invalid-input", message: "job id required" };
    }
    if (!isJobIdWellFormed(request.jobId)) {
      return { ok: false, problem: "invalid-input", message: `invalid job id: ${request.jobId}` };
    }

    // Break the lease so the supervisor (if alive) knows it has lost ownership.
    await this.store.breakSupervisorLease(request.jobId);

    // Terminate the Pi process via the ladder.
    const pidResult = await this.store.readPiPid(request.jobId);
    if (pidResult.ok) {
      await terminatePi(pidResult.value);
    }
    await this.store.deletePiPid(request.jobId);

    // Release capacity.
    await this.store.releaseCapacity(request.jobId);

    // Seal any recoverable evidence: if a stage artifact exists, mark it.
    const artifactExists = await this.store.stageArtifactExists(request.jobId, 0);

    const mutate = await this.store.mutateJob(
      request.jobId,
      request.expectedRevision,
      (current) => ({
        ok: true,
        value: {
          next: {
            ...current,
            revision: current.revision + 1,
            status: "cancelled" as const,
            stage: current.stage ?? "writing",
            stageState: artifactExists ? ("sealed" as const) : ("planned" as const),
            updatedAt: new Date().toISOString(),
          },
          reason: "cancel",
        },
      }),
    );
    if (!mutate.ok) {
      if (mutate.problem === "conflict") {
        return {
          ok: false,
          problem: "stale-confirmation",
          message: mutate.message,
        };
      }
      return mutate;
    }

    return this.get(request.jobId);
  }

  /**
   * Continue a returned or waiting job.  Stub for ticket 26 — a full
   * implementation arrives with routing and multi-stage jobs.
   */
  async continue(request: MutationRequest): Promise<Outcome<JobView>> {
    if (typeof request.jobId !== "string" || request.jobId.length === 0) {
      return { ok: false, problem: "invalid-input", message: "job id required" };
    }
    if (!isJobIdWellFormed(request.jobId)) {
      return { ok: false, problem: "invalid-input", message: `invalid job id: ${request.jobId}` };
    }
    const mutate = await this.store.mutateJob(
      request.jobId,
      request.expectedRevision,
      (current) => ({
        ok: true,
        value: {
          next: {
            ...current,
            revision: current.revision + 1,
            updatedAt: new Date().toISOString(),
          },
          reason: "continue",
        },
      }),
    );
    if (!mutate.ok) {
      if (mutate.problem === "conflict") {
        return {
          ok: false,
          problem: "stale-confirmation",
          message: mutate.message,
        };
      }
      return mutate;
    }
    // For ticket 26, continue simply respawns the supervisor.
    this.supervisorSpawner(this.store.root, request.jobId);
    return this.get(request.jobId);
  }

  /**
   * Paginate job summaries, newest first. Archived jobs are hidden by
   * default. The cursor is the base64url-encoded ULID of the last job in
   * the previous page; a malformed cursor is `invalid-input`, an empty page
   * after a valid cursor is success with `nextCursor: null`.
   */
  async list(query: JobQuery = {}): Promise<Outcome<JobPage>> {
    const limitResult = validateLimit(query.limit);
    if (!limitResult.ok) return limitResult;
    const limit = limitResult.value;
    const cursorJobId = decodeCursor(query.cursor);
    if (cursorJobId === "invalid") {
      return { ok: false, problem: "invalid-input", message: "malformed cursor" };
    }

    const allIds = await this.store.listJobIds();
    // Newest first = reverse lexicographic.
    allIds.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

    // Cursor is the first id of the next page in the descending order. We
    // find where it sits (or would have sat) and start there.
    let startIdx = 0;
    if (cursorJobId !== null) {
      const idx = allIds.indexOf(cursorJobId);
      if (idx >= 0) {
        startIdx = idx;
      } else {
        // The cursor is well-formed but the job it referred to is gone.
        // Find the slot where it would have been inserted in the descending
        // order and start there — a cursor older than every job yields an
        // empty page, a cursor newer than every job starts at index 0.
        let pos = 0;
        for (; pos < allIds.length; pos += 1) {
          if ((allIds[pos] as string) < cursorJobId) break;
        }
        startIdx = pos;
      }
    }

    const summaries: JobSummary[] = [];
    let nextCursor: string | null = null;
    let iterated = 0;
    let unreadable = 0;
    for (let i = startIdx; i < allIds.length; i += 1) {
      const id = allIds[i] as string;
      const job = await this.store.readJob(id);
      if (!job.ok) {
        // An unreadable record is skipped so one corrupt file cannot take out
        // the whole list. The count is reported so the caller is told rather
        // than quietly handed a short page.
        // `not-found` counts too: a submit that died between `mkdir` and the
        // exclusive `job.json` commit leaves a directory whose id is listed but
        // has no record. Counting only corruption handed the caller a short
        // page and told it nothing — the thing this field exists to prevent.
        unreadable += 1;
        continue;
      }
      if (!query.includeArchived && job.value.status === "archived") continue;
      summaries.push({
        jobId: job.value.jobId,
        status: job.value.status,
        risk: job.value.risk,
        repo: job.value.repo,
        objectiveExcerpt: await this.excerptFor(id),
        createdAt: job.value.createdAt,
        updatedAt: job.value.updatedAt,
        revision: job.value.revision,
      });
      iterated += 1;
      if (iterated === limit) {
        // Cursor for the next page = the first id we have NOT included in
        // this page. When there is no such id, nextCursor stays null.
        if (i + 1 < allIds.length) {
          nextCursor = encodeCursor(allIds[i + 1] as string);
        }
        break;
      }
    }

    const size = await this.computeSize();
    return { ok: true, value: { jobs: summaries, nextCursor, size, unreadable } };
  }

  /** Compute the soft size budget from the store. */
  async computeSize(): Promise<SizeBudget> {
    const bytes = await this.store.computeSizeBytes();
    return {
      bytes,
      softLimitBytes: this.store.config.softLimitBytes,
      overBudget: bytes > this.store.config.softLimitBytes,
    };
  }

  private async excerptFor(jobId: string): Promise<string> {
    const snapshot = await this.store.readInputSnapshot(jobId);
    if (!snapshot.ok) return "";
    const obj = (snapshot.value as Record<string, unknown>).objective;
    if (typeof obj !== "string") return "";
    // Cut on code points. `slice` counts UTF-16 units and would split a
    // surrogate pair, emitting a lone half into the envelope.
    const points = Array.from(obj);
    if (points.length <= OBJECTIVE_EXCERPT_LEN) return obj;
    return points.slice(0, OBJECTIVE_EXCERPT_LEN).join("");
  }
}

/** A local regex to keep the Fleet module's ULID check co-located with its use. */
const ULID_REGEX = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

function isJobIdWellFormed(value: string): boolean {
  return ULID_REGEX.test(value);
}

type LimitOutcome =
  | { ok: true; value: number }
  | { ok: false; problem: "invalid-input"; message: string };

function validateLimit(limit: number | undefined): LimitOutcome {
  if (limit === undefined) return { ok: true, value: DEFAULT_LIST_LIMIT };
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
    return { ok: false, problem: "invalid-input", message: `invalid limit: ${String(limit)}` };
  }
  return { ok: true, value: Math.min(limit, MAX_LIST_LIMIT) };
}

function encodeCursor(jobId: string): string {
  return Buffer.from(jobId, "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): string | null | "invalid" {
  if (cursor === undefined) return null;
  if (typeof cursor !== "string" || cursor.length === 0) return "invalid";
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return "invalid";
  }
  if (!isJobIdWellFormed(decoded)) return "invalid";
  return decoded;
}

/** Re-export `Paths` so CLI callers can locate files for diagnostics. */
export { Paths };

/** Tiny sleep helper, used by the idempotency loser-waits loop and wait. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSupervisorSpawner(storeRoot: string, jobId: string): void {
  const here = fileURLToPath(import.meta.url);
  const supervisorPath = join(dirname(here), "supervisor.ts");
  const child = spawn(process.execPath, [
    "--experimental-strip-types",
    supervisorPath,
    storeRoot,
    jobId,
  ], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

/**
 * Termination ladder for the Pi process: SIGTERM, wait 10s, SIGKILL.
 * Returns once the process has exited or the ladder is complete.
 */
async function terminatePi(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
    return;
  }
  const exited = await waitForExit(pid, 10_000);
  if (exited) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      try {
        process.kill(pid, 0);
      } catch {
        clearInterval(timer);
        resolve(true);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 100);
  });
}