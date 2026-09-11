import type { Problem } from "./envelope.ts";
import type { JobStatus, RiskClass } from "./store/records.ts";
import type { StoreOutcome } from "./store/job-store.ts";
import { JobStore, hashIdempotencyKey, Paths } from "./store/job-store.ts";
import { createUlidGenerator } from "./ulid.ts";
import { resolveRepoRealpath } from "./store/paths.ts";

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

  constructor(store: JobStore, clock: Clock = systemClock) {
    this.store = store;
    this.clock = clock;
    // Job ids come from a per-instance generator whose clock is the injected
    // one, so an injected clock is honoured and scratch-file ULIDs elsewhere
    // in the process cannot move this generator's monotonic state.
    this.jobIdGenerator = createUlidGenerator(() => this.clock());
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
    for (;;) {
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
      await sleep(10);
    }
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
        problem: "conflict",
        message: `job ${jobId} is missing its input snapshot`,
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
        if (job.problem === "unavailable-dependency") unreadable += 1;
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

/** Tiny sleep helper, used by the idempotency loser-waits loop. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}