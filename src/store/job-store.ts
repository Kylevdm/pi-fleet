import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  acquireLock,
  appendJsonLine,
  ownerIdentity,
  readJsonFile,
  releaseLock,
  writeJsonFile,
  writeStringFileAtomic,
  writeFileExclusive,
  FileExistsError,
  LockHeldError,
  holdsLock,
} from "./atomic.ts";
import { storePath, ensureWithinRoot, repoIdFromRealpath } from "./paths.ts";
import { isValidUlid } from "../ulid.ts";
import type {
  JobRecord as JobRecordType,
  JobStatus,
  RiskClass,
  SupervisorLeaseRecord,
  CapacityRecord,
} from "./records.ts";
import {
  schemaTag,
  validateJobRecord,
  validateStoreRecord,
  validateSupervisorLeaseRecord,
  validateCapacityRecord,
} from "./records.ts";
import type { Problem } from "../envelope.ts";
import type { ValidationResult } from "./records.ts";

/** Path builders, exposed so tests can locate scratch files directly. */
export const Paths = {
  storeJson(root: string): string {
    return storePath(root, "store.json");
  },
  configJson(root: string): string {
    return storePath(root, "config.json");
  },
  jobs(root: string): string {
    return storePath(root, "jobs");
  },
  jobDir(root: string, jobId: string): string {
    return storePath(root, "jobs", jobId);
  },
  jobJson(root: string, jobId: string): string {
    return storePath(root, "jobs", jobId, "job.json");
  },
  jobLock(root: string, jobId: string): string {
    return storePath(root, "jobs", jobId, "job.lock");
  },
  jobAudit(root: string, jobId: string): string {
    return storePath(root, "jobs", jobId, "audit.jsonl");
  },
  inputSnapshot(root: string, jobId: string): string {
    return storePath(root, "jobs", jobId, "input", "snapshot.json");
  },
  inputSnapshotSha256(root: string, jobId: string): string {
    return storePath(root, "jobs", jobId, "input", "snapshot.sha256");
  },
  inputDir(root: string, jobId: string): string {
    return storePath(root, "jobs", jobId, "input");
  },
  tmpDir(root: string, jobId: string): string {
    return storePath(root, "jobs", jobId, "tmp");
  },
  supervisorLease(root: string, jobId: string): string {
    return storePath(root, "jobs", jobId, "supervisor-lease.json");
  },
  stageDir(root: string, jobId: string, stageIndex: number): string {
    return storePath(root, "jobs", jobId, "stages", String(stageIndex));
  },
  stageArtifact(root: string, jobId: string, stageIndex: number): string {
    return storePath(root, "jobs", jobId, "stages", String(stageIndex), "artifact.json");
  },
  piPid(root: string, jobId: string): string {
    return storePath(root, "jobs", jobId, "pi-pid.txt");
  },
  idempotencyIndex(root: string): string {
    return storePath(root, "index", "idempotency");
  },
  idempotencyRecord(root: string, hash: string): string {
    return storePath(root, "index", "idempotency", `${hash}.json`);
  },
  capacityDir(root: string): string {
    return storePath(root, "capacity");
  },
  capacityGlobalDir(root: string): string {
    return storePath(root, "capacity", "global");
  },
  capacityRepoDir(root: string): string {
    return storePath(root, "capacity", "repos");
  },
  capacityRepoRecord(root: string, repoId: string): string {
    return storePath(root, "capacity", "repos", `${repoId}.json`);
  },
  worktreesDir(root: string): string {
    return storePath(root, "worktrees");
  },
  indexDir(root: string): string {
    return storePath(root, "index");
  },
};

export interface StoreConfig {
  schema: "config/1";
  store: { softLimitBytes: number };
  lock?: { staleMs?: number };
}

/** Outcome returned by every JobStore method. Mirrors `Outcome` in the spec. */
export type StoreOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; problem: Problem; message: string };

/**
 * Stored config record as written on disk. `softLimitBytes` defaults to 1 GiB
 * per the brief; `staleMs` defaults to 30 seconds when absent.
 */
export interface ResolvedConfig {
  softLimitBytes: number;
  staleMs: number;
}

const DEFAULT_SOFT_LIMIT_BYTES = 1024 * 1024 * 1024; // 1 GiB
const DEFAULT_STALE_MS = 30_000;

/**
 * An idempotency claim may only be reclaimed once it is this old (60s) AND
 * its job has never become readable. A live claim is never deleted out from
 * under its owner.
 */
const IDEMPOTENCY_RECLAIM_MS = 60_000;

/** True when `error` is a Node errno error carrying exactly `code`. */
function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class JobStore {
  readonly root: string;
  readonly readOnly: boolean;
  readonly config: ResolvedConfig;
  readonly openedAt: Date;

  private constructor(
    root: string,
    readOnly: boolean,
    config: ResolvedConfig,
    openedAt: Date,
  ) {
    this.root = root;
    this.readOnly = readOnly;
    this.config = config;
    this.openedAt = openedAt;
  }

  /**
   * Open the store at `root`, initialising it if absent. The store is
   * idempotent: two concurrent first-opens both succeed and observe the
   * same final state.
   *
   * If the on-disk `store.json` carries a major version this binary does not
   * recognise, the store opens in `readOnly` mode — `get` and `list` keep
   * working, every write returns `policy-denied`.
   */
  static async open(root: string): Promise<JobStore> {
    await fs.mkdir(root, { recursive: true });
    // Detect read-only mode before creating anything. A store whose
    // store.json carries an unknown major must not gain new directories or a
    // config.json from a binary that will then refuse to write.
    const readOnly = await JobStore.detectReadOnly(root);
    if (!readOnly) {
      await fs.mkdir(Paths.jobs(root), { recursive: true });
      await fs.mkdir(Paths.capacityDir(root), { recursive: true });
      await fs.mkdir(Paths.worktreesDir(root), { recursive: true });
      await fs.mkdir(Paths.indexDir(root), { recursive: true });
      await fs.mkdir(Paths.idempotencyIndex(root), { recursive: true });
      await JobStore.ensureStoreJson(root);
    }
    const config = await JobStore.loadConfig(root, { create: !readOnly });
    return new JobStore(root, readOnly, config, new Date());
  }

  /**
   * Create `store.json` if it does not already exist. The record carries
   * `schema`, `epoch`, and `createdAt`. Subsequent re-opens leave the file
   * alone — the epoch only changes on a migration, which this ticket never
   * performs.
   */
  private static async ensureStoreJson(root: string): Promise<void> {
    const target = Paths.storeJson(root);
    if (existsSync(target)) return;
    const record = {
      schema: schemaTag("store", 1),
      epoch: 1,
      createdAt: new Date().toISOString(),
    };
    await writeJsonFile(target, record, { pretty: true });
  }

  private static async loadConfig(
    root: string,
    options: { create: boolean },
  ): Promise<ResolvedConfig> {
    const configPath = Paths.configJson(root);
    if (!existsSync(configPath)) {
      if (!options.create) {
        // A read-only store has no config.json (it was never initialised).
        // Read with defaults; do not write anything.
        return { softLimitBytes: DEFAULT_SOFT_LIMIT_BYTES, staleMs: DEFAULT_STALE_MS };
      }
      const defaults: StoreConfig = {
        schema: "config/1",
        store: { softLimitBytes: DEFAULT_SOFT_LIMIT_BYTES },
      };
      await writeJsonFile(configPath, defaults);
      return { softLimitBytes: DEFAULT_SOFT_LIMIT_BYTES, staleMs: DEFAULT_STALE_MS };
    }
    const raw = await readJsonFile(configPath);
    const validated = JobStore.parseConfig(raw);
    if (!validated.ok) {
      // A broken config is a store-level fault: refuse to open rather than
      // silently default to something the human did not choose.
      throw new Error(`unreadable config.json: ${validated.message}`);
    }
    return validated.value;
  }

  private static parseConfig(value: unknown): ValidationResult<ResolvedConfig> {
    if (value === null || typeof value !== "object") {
      return { ok: false, problem: "invalid-input", message: "config must be an object" };
    }
    const obj = value as Record<string, unknown>;
    if (obj.schema !== "config/1") {
      return { ok: false, problem: "policy-denied", message: `unknown config schema: ${String(obj.schema)}` };
    }
    const store = obj.store;
    if (store === null || typeof store !== "object") {
      return { ok: false, problem: "invalid-input", message: "config.store must be an object" };
    }
    const soft = (store as Record<string, unknown>).softLimitBytes;
    if (typeof soft !== "number" || !Number.isFinite(soft) || soft <= 0) {
      return { ok: false, problem: "invalid-input", message: "config.store.softLimitBytes must be a positive number" };
    }
    const lockObj = obj.lock;
    let staleMs = DEFAULT_STALE_MS;
    if (lockObj !== undefined) {
      if (lockObj === null || typeof lockObj !== "object") {
        return { ok: false, problem: "invalid-input", message: "config.lock must be an object" };
      }
      const v = (lockObj as Record<string, unknown>).staleMs;
      // Strictly positive: `staleMs: 0` makes every lock instantly stale, so
      // every acquire breaks the live holder's lock and mutual exclusion is gone.
      if (typeof v === "number" && Number.isFinite(v) && v > 0) staleMs = v;
    }
    return { ok: true, value: { softLimitBytes: soft, staleMs } };
  }

  private static async detectReadOnly(root: string): Promise<boolean> {
    const storeFile = Paths.storeJson(root);
    if (!existsSync(storeFile)) return false;
    let raw: unknown;
    try {
      raw = await readJsonFile(storeFile);
    } catch {
      // Unreadable store.json — conservative: refuse to write.
      return true;
    }
    const validated = validateStoreRecord(raw);
    if (!validated.ok) {
      // Any unparseable, malformed, or unknown-major store record makes
      // the store read-only. The conservative direction is the only safe one.
      return true;
    }
    return false;
  }

  /**
   * Compute the bytes used by the four top-level subtrees the spec names.
   * At pilot scale that is tens of directories; we walk them once per call
   * and do not cache.
   */
  async computeSizeBytes(): Promise<number> {
    let total = 0;
    for (const sub of ["jobs", "capacity", "index", "worktrees"]) {
      const dir = storePath(this.root, sub);
      if (!existsSync(dir)) continue;
      total += await walkSize(dir);
    }
    return total;
  }

  /**
   * List every ULID-shaped job id in `jobs/`. The brief says pre-cutover
   * directories are invisible, so anything that does not match the ULID
   * pattern is silently skipped.
   */
  async listJobIds(): Promise<string[]> {
    const jobs = Paths.jobs(this.root);
    if (!existsSync(jobs)) return [];
    const entries = await fs.readdir(jobs);
    const ulids: string[] = [];
    for (const e of entries) {
      // Cheap ULID shape check: 26 chars, all Crockford. We reuse the
      // generator's regex by composing a small predicate here rather than
      // importing from `ulid.ts` (which would re-export a pattern).
      if (e.length === 26 && /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/.test(e)) {
        ulids.push(e);
      }
    }
    return ulids;
  }

  /** Read a job record by id. Returns `not-found` if no such job. */
  async readJob(jobId: string): Promise<StoreOutcome<JobRecordType>> {
    if (!isValidUlid(jobId)) {
      return { ok: false, problem: "invalid-input", message: `invalid job id: ${jobId}` };
    }
    const target = Paths.jobJson(this.root, jobId);
    if (!ensureWithinRoot(this.root, target)) {
      return { ok: false, problem: "invalid-input", message: `path escapes root: ${jobId}` };
    }
    if (!existsSync(target)) {
      return { ok: false, problem: "not-found", message: `no job: ${jobId}` };
    }
    let raw: unknown;
    try {
      raw = await readJsonFile(target);
    } catch {
      return {
        ok: false,
        problem: "unavailable-dependency",
        message: `job ${jobId} is unreadable: invalid JSON`,
      };
    }
    const validated = validateJobRecord(raw);
    if (!validated.ok) {
      return {
        ok: false,
        problem: "unavailable-dependency",
        message: `job ${jobId} is unreadable: ${validated.message}`,
      };
    }
    return { ok: true, value: validated.value };
  }

  /** Write a brand-new job record. Refuses if the path already exists. */
  async writeJobNew(
    jobId: string,
    risk: RiskClass,
    repo: string,
    status: JobStatus,
    timestamps: { createdAt: string; updatedAt: string },
  ): Promise<StoreOutcome<JobRecordType>> {
    if (this.readOnly) {
      return { ok: false, problem: "policy-denied", message: "store is read-only (unknown schema)" };
    }
    if (!isValidUlid(jobId)) {
      return { ok: false, problem: "invalid-input", message: `invalid job id: ${jobId}` };
    }
    const record: JobRecordType = {
      schema: "job/1",
      jobId,
      revision: 1,
      status,
      risk,
      repo,
      createdAt: timestamps.createdAt,
      updatedAt: timestamps.updatedAt,
    };
    const dir = Paths.jobDir(this.root, jobId);
    const target = Paths.jobJson(this.root, jobId);
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(Paths.inputDir(this.root, jobId), { recursive: true });
    await fs.mkdir(Paths.tmpDir(this.root, jobId), { recursive: true });
    const payload = `${JSON.stringify(record, null, 2)}\n`;
    try {
      // The write-once commit must be genuinely exclusive. `fs.link` gives
      // O_EXCL semantics: exactly one concurrent writer wins, the other
      // observes EEXIST and reports conflict.
      await writeFileExclusive(target, payload, { scratchDir: Paths.tmpDir(this.root, jobId) });
    } catch (error) {
      if (error instanceof FileExistsError) {
        return { ok: false, problem: "conflict", message: `job already exists: ${jobId}` };
      }
      throw error;
    }
    // The job is committed. An audit append that fails now must not turn an
    // admitted job into a fault envelope: the caller would never learn the
    // jobId of a job that is on disk and will appear in `list` forever.
    await appendJsonLine(Paths.jobAudit(this.root, jobId), {
      schema: "audit/1",
      timestamp: timestamps.createdAt,
      action: "submit",
      revision: 1,
      reason: "admission",
    }).catch(() => {});
    return { ok: true, value: record };
  }

  /**
   * Write the immutable input snapshot. The record includes the objective,
   * repo reference, risk class, overrides, and admission timestamp; it is
   * written once and never read for write purposes again.
   */
  async writeInputSnapshot(
    jobId: string,
    payload: {
      objective: string;
      repo: string;
      risk: RiskClass;
      overrides: Record<string, unknown>;
      admittedAt: string;
      idempotencyKey: string | null;
    },
  ): Promise<StoreOutcome<void>> {
    if (this.readOnly) {
      return { ok: false, problem: "policy-denied", message: "store is read-only (unknown schema)" };
    }
    if (!isValidUlid(jobId)) {
      return { ok: false, problem: "invalid-input", message: `invalid job id: ${jobId}` };
    }
    const snapshot = {
      schema: schemaTag("input-snapshot", 1),
      ...payload,
    };
    const target = Paths.inputSnapshot(this.root, jobId);
    await fs.mkdir(Paths.inputDir(this.root, jobId), { recursive: true });
    const scratchDir = Paths.tmpDir(this.root, jobId);
    // Produce the serialized payload once, write it, and hash exactly those
    // bytes. The previous code hashed `JSON.stringify(snapshot)` (compact) but
    // wrote `JSON.stringify(snapshot, null, 2)` (pretty), so the digest never
    // matched the file on disk. Both files go through the same rename-commit
    // pattern as every other write, so a crash or ENOSPC mid-write can never
    // leave a truncated target.
    const payload_str = `${JSON.stringify(snapshot, null, 2)}\n`;
    await writeStringFileAtomic(target, payload_str, { scratchDir });
    const sha = createHash("sha256").update(payload_str).digest("hex");
    // Use a job-relative path in the checksum sidecar so the store can be
    // relocated without breaking the digest.
    const relativeTarget = `jobs/${jobId}/input/snapshot.json`;
    const checksumContent = `${sha}  ${relativeTarget}\n`;
    const checksumTarget = Paths.inputSnapshotSha256(this.root, jobId);
    await writeStringFileAtomic(checksumTarget, checksumContent, { scratchDir });
    return { ok: true, value: undefined };
  }

  /** Read the immutable input snapshot for a job. */
  async readInputSnapshot(jobId: string): Promise<StoreOutcome<unknown>> {
    if (!isValidUlid(jobId)) {
      return { ok: false, problem: "invalid-input", message: `invalid job id: ${jobId}` };
    }
    const target = Paths.inputSnapshot(this.root, jobId);
    if (!ensureWithinRoot(this.root, target)) {
      return { ok: false, problem: "invalid-input", message: `path escapes root: ${jobId}` };
    }
    if (!existsSync(target)) {
      return { ok: false, problem: "not-found", message: `no snapshot: ${jobId}` };
    }
    let raw: unknown;
    try {
      raw = await readJsonFile(target);
    } catch (error) {
      // The file can also vanish between `existsSync` and the read, which is
      // the same answer: this snapshot cannot be produced.
      const reason = isErrnoCode(error, "ENOENT") ? "it disappeared" : "invalid JSON";
      return {
        ok: false,
        problem: "unavailable-dependency",
        message: `snapshot for ${jobId} is unreadable: ${reason}`,
      };
    }
    if (raw === null || typeof raw !== "object") {
      return {
        ok: false,
        problem: "unavailable-dependency",
        message: `snapshot for ${jobId} is unreadable: not an object`,
      };
    }
    return { ok: true, value: raw };
  }

  /**
   * Compare-and-swap on the job record. Acquires `job.lock`, reads the
   * current revision, runs `fn` to compute the next record, writes it via
   * the rename-commit pattern, and appends one audit entry per accepted
   * mutation. A stale `expectedRevision` returns `conflict` without
   * writing.
   */
  async mutateJob(
    jobId: string,
    expectedRevision: number,
    fn: (current: JobRecordType) => StoreOutcome<{
      next: JobRecordType;
      reason: string;
    }>,
    options: { leaseGeneration?: number } = {},
  ): Promise<StoreOutcome<JobRecordType>> {
    if (this.readOnly) {
      return { ok: false, problem: "policy-denied", message: "store is read-only (unknown schema)" };
    }
    if (!isValidUlid(jobId)) {
      return { ok: false, problem: "invalid-input", message: `invalid job id: ${jobId}` };
    }
    // Existence before the lock. `acquireLock` mkdir -p's the lock's parent, so
    // locking first left a phantom `jobs/<ulid>/` behind for every mutation of
    // a job that does not exist — litter any caller could create at will.
    if (!existsSync(Paths.jobJson(this.root, jobId))) {
      return { ok: false, problem: "not-found", message: `no job: ${jobId}` };
    }
    const lock = Paths.jobLock(this.root, jobId);
    const audit = Paths.jobAudit(this.root, jobId);
    try {
      await acquireLock(lock, { staleMs: this.config.staleMs, audit });
    } catch (error) {
      if (error instanceof LockHeldError) {
        return { ok: false, problem: "conflict", message: "job locked by another writer" };
      }
      throw error;
    }
    try {
      const current = await this.readJob(jobId);
      if (!current.ok) return current;
      if (current.value.revision !== expectedRevision) {
        return {
          ok: false,
          problem: "conflict",
          message: `expected revision ${expectedRevision}, found ${current.value.revision}`,
        };
      }
      if (options.leaseGeneration !== undefined) {
        const lease = await this.readSupervisorLease(jobId);
        if (lease.ok && lease.value.generation !== options.leaseGeneration) {
          return {
            ok: false,
            problem: "conflict",
            message: `expected lease generation ${options.leaseGeneration}, found ${lease.value.generation}`,
          };
        }
      }
      const outcome = fn(current.value);
      if (!outcome.ok) return outcome;
      const next = outcome.value.next;
      if (next.revision !== current.value.revision + 1) {
        return {
          ok: false,
          problem: "invalid-input",
          message: "mutateJob must increment revision by exactly one",
        };
      }
      // Still ours? If this mutation outlived `staleMs`, another writer may
      // have broken the lock and read the same revision we did.
      if (!(await holdsLock(lock))) {
        return {
          ok: false,
          problem: "conflict",
          message: "lock was broken by another writer during this mutation",
        };
      }
      await writeJsonFile(Paths.jobJson(this.root, jobId), next, {
        pretty: true,
        scratchDir: Paths.tmpDir(this.root, jobId),
      });
      await appendJsonLine(audit, {
        schema: "audit/1",
        timestamp: new Date().toISOString(),
        action: "mutate",
        revision: next.revision,
        reason: outcome.value.reason,
      });
      return { ok: true, value: next };
    } finally {
      await releaseLock(lock, { audit });
    }
  }

  /**
   * Read an idempotency record by sha256 of the key. Returns `not-found`
   * when no record exists yet.
   */
  async readIdempotencyRecord(hash: string): Promise<StoreOutcome<IdempotencyRecord>> {
    if (!isHexHash(hash)) {
      return { ok: false, problem: "invalid-input", message: `invalid idempotency hash: ${hash}` };
    }
    const target = Paths.idempotencyRecord(this.root, hash);
    if (!ensureWithinRoot(this.root, target)) {
      return { ok: false, problem: "invalid-input", message: `path escapes root: ${hash}` };
    }
    if (!existsSync(target)) {
      return { ok: false, problem: "not-found", message: `no idempotency record for hash ${hash}` };
    }
    let raw: unknown;
    try {
      raw = await readJsonFile(target);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) {
        return { ok: false, problem: "not-found", message: `no idempotency record for hash ${hash}` };
      }
      return {
        ok: false,
        problem: "unavailable-dependency",
        message: `idempotency record ${hash} is unreadable: invalid JSON`,
      };
    }
    const v = parseIdempotencyRecord(raw);
    if (!v.ok) return v;
    return { ok: true, value: v.value };
  }

  /**
   * Atomically claim the idempotency slot. The `fs.link` primitive gives
   * us O_EXCL semantics without giving up the rename-commit pattern: the
   * file appears atomically and either points at a fully-written snapshot
   * or it does not exist.
   *
   * The claim records its owner (pid + boot-unique token) and its claim
   * time so a later reclaim can tell a live claim from an abandoned one.
   *
   * Returned value is `{ claimed, record }`: when `claimed` is true we
   * wrote the record, when false the slot was already held and `record`
   * is whatever the winner left there.
   */
  async writeIdempotencyRecord(
    hash: string,
    payload: { key: string; jobId: string; createdAt: string },
  ): Promise<StoreOutcome<{ claimed: boolean; record: IdempotencyRecord }>> {
    if (this.readOnly) {
      return { ok: false, problem: "policy-denied", message: "store is read-only (unknown schema)" };
    }
    if (!isHexHash(hash)) {
      return { ok: false, problem: "invalid-input", message: `invalid idempotency hash: ${hash}` };
    }
    const target = Paths.idempotencyRecord(this.root, hash);
    if (!ensureWithinRoot(this.root, target)) {
      return { ok: false, problem: "invalid-input", message: `path escapes root: ${hash}` };
    }
    const record: IdempotencyRecord = {
      schema: "idempotency-index/1",
      key: payload.key,
      jobId: payload.jobId,
      createdAt: payload.createdAt,
      owner: ownerIdentity(),
      claimedAt: new Date().toISOString(),
    };
    const tmpDir = storePath(this.root, "index", "idempotency", "tmp");
    await fs.mkdir(tmpDir, { recursive: true });
    const tmp = join(tmpDir, `${hash}.${randomUUID()}`);
    const payloadString = `${JSON.stringify(record)}\n`;
    const handle = await fs.open(tmp, "wx");
    try {
      await handle.writeFile(payloadString);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.link(tmp, target);
    } catch (error) {
      await fs.unlink(tmp).catch(() => {
        // tmp may already be gone if `link` raced; ignore.
      });
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        const existing = await this.readIdempotencyRecord(hash);
        if (existing.ok) {
          return { ok: true, value: { claimed: false, record: existing.value } };
        }
        return existing;
      }
      throw error;
    }
    await fs.unlink(tmp);
    return { ok: true, value: { claimed: true, record } };
  }

  /**
   * Reclaim an idempotency claim that is genuinely abandoned: it is older
   * than the reclaim threshold AND its job has never become readable. A live
   * claim (young, or whose job is readable) is never deleted.
   *
   * The reclaim itself is atomic: the stale record is renamed aside and only
   * the process that wins that rename may re-claim the slot. Callers race
   * this method safely — exactly one winner deletes the record.
   */
  async reclaimIdempotencyRecord(hash: string): Promise<StoreOutcome<{ reclaimed: boolean }>> {
    // This renames and unlinks index records, so it is a mutation and needs the
    // guard every other mutating method carries. A read-only store accepts no
    // writes, and "unreachable from today's CLI" is not the same as safe.
    if (this.readOnly) {
      return { ok: false, problem: "policy-denied", message: "store is read-only (unknown schema)" };
    }
    if (!isHexHash(hash)) {
      return { ok: false, problem: "invalid-input", message: `invalid idempotency hash: ${hash}` };
    }
    const target = Paths.idempotencyRecord(this.root, hash);
    if (!ensureWithinRoot(this.root, target)) {
      return { ok: false, problem: "invalid-input", message: `path escapes root: ${hash}` };
    }
    if (!existsSync(target)) {
      return { ok: true, value: { reclaimed: false } };
    }
    const current = await this.readIdempotencyRecord(hash);
    if (!current.ok) {
      if (current.problem === "not-found") return { ok: true, value: { reclaimed: false } };
      return current;
    }
    const ageMs = Date.now() - Date.parse(current.value.claimedAt);
    if (ageMs < IDEMPOTENCY_RECLAIM_MS) {
      return { ok: true, value: { reclaimed: false } };
    }
    const job = await this.readJob(current.value.jobId);
    if (job.ok) {
      return { ok: true, value: { reclaimed: false } };
    }
    const aside = `${target}.reclaim.${process.pid}.${Date.now()}`;
    try {
      await fs.rename(target, aside);
    } catch {
      // Someone else won the rename race — that winner owns the reclaim.
      return { ok: true, value: { reclaimed: false } };
    }
    await fs.unlink(aside).catch(() => {});
    return { ok: true, value: { reclaimed: true } };
  }

  // ---- Supervisor lease ----

  async readSupervisorLease(jobId: string): Promise<StoreOutcome<SupervisorLeaseRecord>> {
    if (!isValidUlid(jobId)) {
      return { ok: false, problem: "invalid-input", message: `invalid job id: ${jobId}` };
    }
    const target = Paths.supervisorLease(this.root, jobId);
    if (!existsSync(target)) {
      return { ok: false, problem: "not-found", message: `no supervisor lease: ${jobId}` };
    }
    let raw: unknown;
    try {
      raw = await readJsonFile(target);
    } catch {
      return { ok: false, problem: "unavailable-dependency", message: `supervisor lease unreadable: ${jobId}` };
    }
    const validated = validateSupervisorLeaseRecord(raw);
    if (!validated.ok) {
      return { ok: false, problem: "unavailable-dependency", message: `supervisor lease invalid: ${validated.message}` };
    }
    return { ok: true, value: validated.value };
  }

  /**
   * Claim or renew the supervisor lease for a job. If a lease exists and is
   * still live (not past expiry + grace), the claim is rejected. Otherwise
   * the old lease is replaced with a new one of the next generation.
   */
  async claimSupervisorLease(
    jobId: string,
    owner: { pid: number; bootToken: string },
    leaseDurationMs: number,
  ): Promise<StoreOutcome<{ claimed: boolean; generation: number }>> {
    if (this.readOnly) {
      return { ok: false, problem: "policy-denied", message: "store is read-only (unknown schema)" };
    }
    if (!isValidUlid(jobId)) {
      return { ok: false, problem: "invalid-input", message: `invalid job id: ${jobId}` };
    }
    const target = Paths.supervisorLease(this.root, jobId);
    const now = Date.now();
    const graceMs = 30_000;

    let nextGeneration = 1;
    if (existsSync(target)) {
      const current = await this.readSupervisorLease(jobId);
      if (current.ok) {
        const expired = now - Date.parse(current.value.expiresAt) > graceMs;
        if (!expired) {
          // Still live.
          return { ok: true, value: { claimed: false, generation: current.value.generation } };
        }
        nextGeneration = current.value.generation + 1;
      }
      // If unreadable, treat as reclaimable and start at generation 1.
    }

    const record: SupervisorLeaseRecord = {
      schema: "supervisor-lease/1",
      owner,
      generation: nextGeneration,
      claimedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + leaseDurationMs).toISOString(),
    };
    await fs.mkdir(Paths.jobDir(this.root, jobId), { recursive: true });
    await writeJsonFile(target, record, { pretty: true, scratchDir: Paths.tmpDir(this.root, jobId) });
    return { ok: true, value: { claimed: true, generation: nextGeneration } };
  }

  /**
   * Break the supervisor lease so another supervisor (or cancel) can claim
   * the job immediately. Returns true when a lease was removed.
   */
  async breakSupervisorLease(jobId: string): Promise<StoreOutcome<boolean>> {
    if (this.readOnly) {
      return { ok: false, problem: "policy-denied", message: "store is read-only (unknown schema)" };
    }
    if (!isValidUlid(jobId)) {
      return { ok: false, problem: "invalid-input", message: `invalid job id: ${jobId}` };
    }
    const target = Paths.supervisorLease(this.root, jobId);
    if (!existsSync(target)) {
      return { ok: true, value: false };
    }
    try {
      await fs.unlink(target);
      return { ok: true, value: true };
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return { ok: true, value: false };
      throw error;
    }
  }

  // ---- Capacity leases ----

  /**
   * Try to acquire both a global writer slot and a per-repository writer
   * slot. Returns the acquired capacity record or null if either is
   * unavailable. Cleans up expired leases before counting.
   */
  async acquireCapacity(
    jobId: string,
    repoId: string,
    owner: { pid: number; bootToken: string },
    leaseDurationMs: number,
  ): Promise<StoreOutcome<{ acquired: boolean; globalSlot: number; repoSlot: number }>> {
    if (this.readOnly) {
      return { ok: false, problem: "policy-denied", message: "store is read-only (unknown schema)" };
    }
    if (!isValidUlid(jobId)) {
      return { ok: false, problem: "invalid-input", message: `invalid job id: ${jobId}` };
    }

    const globalDir = Paths.capacityGlobalDir(this.root);
    const repoFile = Paths.capacityRepoRecord(this.root, repoId);
    await fs.mkdir(globalDir, { recursive: true });
    await fs.mkdir(Paths.capacityRepoDir(this.root), { recursive: true });

    const now = Date.now();
    const expiresAt = new Date(now + leaseDurationMs).toISOString();

    // Clean up expired global leases and count live ones.
    let liveGlobals = 0;
    if (existsSync(globalDir)) {
      const entries = await fs.readdir(globalDir);
      for (const e of entries) {
        if (!e.endsWith(".json")) continue;
        const p = join(globalDir, e);
        let raw: unknown;
        try {
          raw = await readJsonFile(p);
        } catch {
          await fs.unlink(p).catch(() => {});
          continue;
        }
        const v = validateCapacityRecord(raw);
        if (!v.ok || Date.parse(v.value.expiresAt) < now) {
          await fs.unlink(p).catch(() => {});
          continue;
        }
        liveGlobals += 1;
      }
    }

    // Clean up expired repo lease.
    let liveRepo = false;
    if (existsSync(repoFile)) {
      let raw: unknown;
      try {
        raw = await readJsonFile(repoFile);
      } catch {
        await fs.unlink(repoFile).catch(() => {});
      }
      if (raw !== null) {
        const v = validateCapacityRecord(raw);
        if (!v.ok || Date.parse(v.value.expiresAt) < now) {
          await fs.unlink(repoFile).catch(() => {});
        } else {
          liveRepo = true;
        }
      }
    }

    if (liveGlobals >= 3 || liveRepo) {
      return { ok: true, value: { acquired: false, globalSlot: liveGlobals, repoSlot: liveRepo ? 1 : 0 } };
    }

    const record: CapacityRecord = {
      schema: "capacity/1",
      owner,
      jobId,
      repoId,
      claimedAt: new Date(now).toISOString(),
      expiresAt,
    };

    // Write global slot.
    const globalFile = join(globalDir, `${jobId}.json`);
    await writeJsonFile(globalFile, record, { pretty: true, scratchDir: Paths.tmpDir(this.root, jobId) });

    // Write repo slot.
    await writeJsonFile(repoFile, record, { pretty: true, scratchDir: Paths.tmpDir(this.root, jobId) });

    return { ok: true, value: { acquired: true, globalSlot: liveGlobals + 1, repoSlot: 1 } };
  }

  /**
   * Release all capacity held by a job (global and any repo slots).
   */
  async releaseCapacity(jobId: string): Promise<StoreOutcome<void>> {
    if (this.readOnly) {
      return { ok: false, problem: "policy-denied", message: "store is read-only (unknown schema)" };
    }
    if (!isValidUlid(jobId)) {
      return { ok: false, problem: "invalid-input", message: `invalid job id: ${jobId}` };
    }
    const globalFile = join(Paths.capacityGlobalDir(this.root), `${jobId}.json`);
    if (existsSync(globalFile)) {
      await fs.unlink(globalFile).catch(() => {});
    }
    // Also scan repo dir for any capacity record matching this jobId.
    const repoDir = Paths.capacityRepoDir(this.root);
    if (existsSync(repoDir)) {
      const entries = await fs.readdir(repoDir).catch(() => [] as string[]);
      for (const e of entries) {
        if (!e.endsWith(".json")) continue;
        const p = join(repoDir, e);
        let raw: unknown;
        try {
          raw = await readJsonFile(p);
        } catch {
          continue;
        }
        if (raw !== null && typeof raw === "object" && (raw as Record<string, unknown>).jobId === jobId) {
          await fs.unlink(p).catch(() => {});
        }
      }
    }
    return { ok: true, value: undefined };
  }

  // ---- Stage artifacts ----

  async stageArtifactExists(jobId: string, stageIndex: number): Promise<boolean> {
    if (!isValidUlid(jobId)) return false;
    return existsSync(Paths.stageArtifact(this.root, jobId, stageIndex));
  }

  async writeStageArtifact(
    jobId: string,
    stageIndex: number,
    payload: unknown,
  ): Promise<StoreOutcome<void>> {
    if (this.readOnly) {
      return { ok: false, problem: "policy-denied", message: "store is read-only (unknown schema)" };
    }
    if (!isValidUlid(jobId)) {
      return { ok: false, problem: "invalid-input", message: `invalid job id: ${jobId}` };
    }
    const dir = Paths.stageDir(this.root, jobId, stageIndex);
    await fs.mkdir(dir, { recursive: true });
    const target = Paths.stageArtifact(this.root, jobId, stageIndex);
    await writeJsonFile(target, payload, { pretty: true, scratchDir: Paths.tmpDir(this.root, jobId) });
    return { ok: true, value: undefined };
  }

  async readStageArtifact(jobId: string, stageIndex: number): Promise<StoreOutcome<unknown>> {
    if (!isValidUlid(jobId)) {
      return { ok: false, problem: "invalid-input", message: `invalid job id: ${jobId}` };
    }
    const target = Paths.stageArtifact(this.root, jobId, stageIndex);
    if (!existsSync(target)) {
      return { ok: false, problem: "not-found", message: `no artifact for stage ${stageIndex}` };
    }
    let raw: unknown;
    try {
      raw = await readJsonFile(target);
    } catch {
      return { ok: false, problem: "unavailable-dependency", message: `artifact unreadable for stage ${stageIndex}` };
    }
    return { ok: true, value: raw };
  }

  // ---- Pi pid tracking ----

  async writePiPid(jobId: string, pid: number): Promise<StoreOutcome<void>> {
    if (this.readOnly) {
      return { ok: false, problem: "policy-denied", message: "store is read-only (unknown schema)" };
    }
    if (!isValidUlid(jobId)) {
      return { ok: false, problem: "invalid-input", message: `invalid job id: ${jobId}` };
    }
    const target = Paths.piPid(this.root, jobId);
    await writeStringFileAtomic(target, String(pid), { scratchDir: Paths.tmpDir(this.root, jobId) });
    return { ok: true, value: undefined };
  }

  async readPiPid(jobId: string): Promise<StoreOutcome<number>> {
    if (!isValidUlid(jobId)) {
      return { ok: false, problem: "invalid-input", message: `invalid job id: ${jobId}` };
    }
    const target = Paths.piPid(this.root, jobId);
    if (!existsSync(target)) {
      return { ok: false, problem: "not-found", message: `no pi pid: ${jobId}` };
    }
    const text = await fs.readFile(target, "utf8");
    const pid = Number.parseInt(text.trim(), 10);
    if (!Number.isFinite(pid)) {
      return { ok: false, problem: "unavailable-dependency", message: `invalid pi pid: ${jobId}` };
    }
    return { ok: true, value: pid };
  }

  async deletePiPid(jobId: string): Promise<void> {
    const target = Paths.piPid(this.root, jobId);
    if (existsSync(target)) {
      await fs.unlink(target).catch(() => {});
    }
  }
}

/** Idempotency index record format. */
export interface IdempotencyRecord {
  schema: "idempotency-index/1";
  key: string;
  jobId: string;
  createdAt: string;
  owner: { pid: number; bootToken: string };
  claimedAt: string;
}

export function parseIdempotencyRecord(value: unknown): ValidationResult<IdempotencyRecord> {
  if (value === null || typeof value !== "object") {
    return { ok: false, problem: "invalid-input", message: "idempotency record must be an object" };
  }
  const obj = value as Record<string, unknown>;
  if (obj.schema !== "idempotency-index/1") {
    return { ok: false, problem: "policy-denied", message: `unknown idempotency schema: ${String(obj.schema)}` };
  }
  if (typeof obj.key !== "string" || obj.key.length === 0) {
    return { ok: false, problem: "invalid-input", message: "idempotency key must be a non-empty string" };
  }
  if (typeof obj.jobId !== "string" || obj.jobId.length === 0) {
    return { ok: false, problem: "invalid-input", message: "idempotency jobId must be a non-empty string" };
  }
  if (typeof obj.createdAt !== "string") {
    return { ok: false, problem: "invalid-input", message: "idempotency createdAt must be an ISO string" };
  }
  const owner = obj.owner;
  if (owner === null || typeof owner !== "object") {
    return { ok: false, problem: "invalid-input", message: "idempotency owner must be an object" };
  }
  const ownerObj = owner as Record<string, unknown>;
  if (typeof ownerObj.pid !== "number" || !Number.isInteger(ownerObj.pid)) {
    return { ok: false, problem: "invalid-input", message: "idempotency owner.pid must be an integer" };
  }
  if (typeof ownerObj.bootToken !== "string" || ownerObj.bootToken.length === 0) {
    return { ok: false, problem: "invalid-input", message: "idempotency owner.bootToken must be a non-empty string" };
  }
  if (typeof obj.claimedAt !== "string" || !Number.isFinite(Date.parse(obj.claimedAt))) {
    return { ok: false, problem: "invalid-input", message: "idempotency claimedAt must be an ISO string" };
  }
  return {
    ok: true,
    value: {
      schema: "idempotency-index/1",
      key: obj.key,
      jobId: obj.jobId,
      createdAt: obj.createdAt,
      owner: { pid: ownerObj.pid, bootToken: ownerObj.bootToken },
      claimedAt: obj.claimedAt,
    },
  };
}

  /** Walk a directory tree and sum file sizes. Symlinks are not followed. */
async function walkSize(dir: string): Promise<number> {
  let total = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    // Directory vanished between listing and reading (concurrent delete).
    return 0;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      total += await walkSize(full);
    } else if (e.isFile()) {
      try {
        const stat = await fs.stat(full);
        total += stat.size;
      } catch {
        // Entry vanished between readdir and stat — treat as zero bytes.
      }
    }
  }
  return total;
}

/** Validate that a string looks like a hex hash (SHA-256 = 64 hex chars). */
function isHexHash(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/** SHA-256 hex of an idempotency key. */
export function hashIdempotencyKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}