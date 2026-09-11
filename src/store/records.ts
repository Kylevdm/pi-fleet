import type { Problem } from "../envelope.ts";
import { isValidUlid } from "../ulid.ts";

/**
 * The seven public job statuses. Re-listed here rather than imported from
 * `envelope.ts` because that file is the CLI's vocabulary; the store has its
 * own vocabulary and a circular import here would be a smell.
 */
export const JOB_STATUSES = [
  "admitted",
  "running",
  "waiting",
  "ready-for-acceptance",
  "returned-to-orchestrator",
  "cancelled",
  "archived",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const STAGE_STATES = ["planned", "active", "sealed"] as const;
export type StageState = (typeof STAGE_STATES)[number];

export const WAITING_REASONS = ["capacity", "provider-recovery", "primary-instructions"] as const;
export type WaitingReason = (typeof WAITING_REASONS)[number];

/** Risk class the spec admits. Anything else is `invalid-input`. */
export const RISK_CLASSES = ["low", "medium"] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

/**
 * Schema tag format settled by ticket 03: `"<type>/<major>"`. Encode and
 * decode helpers. `parseSchemaTag` returns `null` for anything that does not
 * match the format, so callers can return `invalid-input` rather than
 * crashing on a hand-edited record.
 */
export function schemaTag(type: string, major: number): string {
  return `${type}/${major}`;
}

export interface SchemaTag {
  type: string;
  major: number;
}

/**
 * Exactly `<type>/<major>` and nothing else. Strict by design: `Number.parseInt`
 * accepts trailing garbage, so `job/1x` used to parse as major 1 and then be
 * normalised back to `job/1` — a corrupted or future tag silently adopted as a
 * known one. No trimming either: `"store/1 "` is not `store/1`. An unparseable
 * tag is the conservative outcome (read-only store, unreadable record), so the
 * only safe parse is an exact one.
 */
const SCHEMA_TAG = /^([A-Za-z0-9-]+)\/([1-9][0-9]*)$/;

export function parseSchemaTag(tag: unknown): SchemaTag | null {
  if (typeof tag !== "string") return null;
  const match = SCHEMA_TAG.exec(tag);
  if (match === null) return null;
  return { type: match[1] as string, major: Number(match[2]) };
}

/**
 * Schema majors this binary can read and write. Adding a record type means
 * adding it here; bumping a major means a new entry alongside the old one
 * during a migration window. Ticket 23 never migrates anything.
 */
const KNOWN_MAJORS: Readonly<Record<string, readonly number[]>> = {
  store: [1],
  config: [1],
  job: [1],
  "input-snapshot": [1],
  "idempotency-index": [1],
  audit: [1],
  "supervisor-lease": [1],
  capacity: [1],
  stage: [1],
};

/** True when this binary knows the (type, major) pair. */
export function knownSchemaMajor(type: string, major: number): boolean {
  // `Object.hasOwn`, not a bare index: `KNOWN_MAJORS["constructor"]` reaches
  // Object.prototype and threw `majors.includes is not a function`.
  if (!Object.hasOwn(KNOWN_MAJORS, type)) return false;
  const majors = KNOWN_MAJORS[type];
  if (majors === undefined) return false;
  return majors.includes(major);
}

/** Result of validating an unknown JSON value against a record shape. */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; problem: Problem; message: string };

function fail<T>(problem: Problem, message: string): ValidationResult<T> {
  return { ok: false, problem, message };
}

function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

/**
 * The store record that lives at `<root>/store.json`.
 *
 * `epoch` increments on a migration only. Ticket 23 ships at epoch 1 and
 * never increments it.
 */
export interface StoreRecord {
  schema: "store/1";
  epoch: number;
  createdAt: string;
}

export function validateStoreRecord(value: unknown): ValidationResult<StoreRecord> {
  if (value === null || typeof value !== "object") {
    return fail("invalid-input", "store record must be an object");
  }
  const obj = value as Record<string, unknown>;
  const tag = parseSchemaTag(obj.schema);
  if (tag === null) return fail("invalid-input", "store record missing or malformed schema tag");
  if (tag.type !== "store") {
    return fail("invalid-input", `expected a store record, found ${tag.type}`);
  }
  if (!knownSchemaMajor("store", tag.major)) {
    return fail("policy-denied", `unknown store schema major: ${tag.major}`);
  }
  if (typeof obj.epoch !== "number" || !Number.isInteger(obj.epoch) || obj.epoch < 1) {
    return fail("invalid-input", "store record epoch must be a positive integer");
  }
  if (typeof obj.createdAt !== "string") {
    return fail("invalid-input", "store record createdAt must be an ISO string");
  }
  return ok({
    schema: schemaTag("store", tag.major) as StoreRecord["schema"],
    epoch: obj.epoch,
    createdAt: obj.createdAt,
  });
}

/**
 * The job record. The brief fixes the schema as `job/1` and lists the fields
 * this ticket writes. `revision` starts at 1 and increments per accepted
 * mutation; `status` is the seven-value public enum; `risk` is `low` or
 * `medium`; `repo` is the canonical realpath; `createdAt` and `updatedAt` are
 * ISO 8601 strings.
 */
export interface JobRecord {
  schema: "job/1";
  jobId: string;
  revision: number;
  status: JobStatus;
  risk: RiskClass;
  repo: string;
  createdAt: string;
  updatedAt: string;
  stage?: string | null;
  stageState?: StageState | null;
  waitingReason?: WaitingReason | null;
}

export interface SupervisorLeaseRecord {
  schema: "supervisor-lease/1";
  owner: { pid: number; bootToken: string };
  generation: number;
  claimedAt: string;
  expiresAt: string;
}

export function validateSupervisorLeaseRecord(value: unknown): ValidationResult<SupervisorLeaseRecord> {
  if (value === null || typeof value !== "object") {
    return fail("invalid-input", "supervisor lease must be an object");
  }
  const obj = value as Record<string, unknown>;
  const tag = parseSchemaTag(obj.schema);
  if (tag === null) return fail("invalid-input", "supervisor lease missing or malformed schema tag");
  if (tag.type !== "supervisor-lease") {
    return fail("invalid-input", `expected a supervisor-lease record, found ${tag.type}`);
  }
  if (!knownSchemaMajor("supervisor-lease", tag.major)) {
    return fail("policy-denied", `unknown supervisor-lease schema major: ${tag.major}`);
  }
  const owner = obj.owner;
  if (owner === null || typeof owner !== "object") {
    return fail("invalid-input", "supervisor lease owner must be an object");
  }
  const ownerObj = owner as Record<string, unknown>;
  if (typeof ownerObj.pid !== "number" || !Number.isInteger(ownerObj.pid)) {
    return fail("invalid-input", "supervisor lease owner.pid must be an integer");
  }
  if (typeof ownerObj.bootToken !== "string" || ownerObj.bootToken.length === 0) {
    return fail("invalid-input", "supervisor lease owner.bootToken must be a non-empty string");
  }
  if (typeof obj.generation !== "number" || !Number.isInteger(obj.generation) || obj.generation < 1) {
    return fail("invalid-input", "supervisor lease generation must be a positive integer");
  }
  if (typeof obj.claimedAt !== "string" || !Number.isFinite(Date.parse(obj.claimedAt))) {
    return fail("invalid-input", "supervisor lease claimedAt must be an ISO string");
  }
  if (typeof obj.expiresAt !== "string" || !Number.isFinite(Date.parse(obj.expiresAt))) {
    return fail("invalid-input", "supervisor lease expiresAt must be an ISO string");
  }
  return ok({
    schema: schemaTag("supervisor-lease", tag.major) as SupervisorLeaseRecord["schema"],
    owner: { pid: ownerObj.pid, bootToken: ownerObj.bootToken },
    generation: obj.generation,
    claimedAt: obj.claimedAt,
    expiresAt: obj.expiresAt,
  });
}

export interface CapacityRecord {
  schema: "capacity/1";
  owner: { pid: number; bootToken: string };
  jobId: string;
  repoId: string | null;
  claimedAt: string;
  expiresAt: string;
}

export function validateCapacityRecord(value: unknown): ValidationResult<CapacityRecord> {
  if (value === null || typeof value !== "object") {
    return fail("invalid-input", "capacity record must be an object");
  }
  const obj = value as Record<string, unknown>;
  const tag = parseSchemaTag(obj.schema);
  if (tag === null) return fail("invalid-input", "capacity record missing or malformed schema tag");
  if (tag.type !== "capacity") {
    return fail("invalid-input", `expected a capacity record, found ${tag.type}`);
  }
  if (!knownSchemaMajor("capacity", tag.major)) {
    return fail("policy-denied", `unknown capacity schema major: ${tag.major}`);
  }
  const owner = obj.owner;
  if (owner === null || typeof owner !== "object") {
    return fail("invalid-input", "capacity record owner must be an object");
  }
  const ownerObj = owner as Record<string, unknown>;
  if (typeof ownerObj.pid !== "number" || !Number.isInteger(ownerObj.pid)) {
    return fail("invalid-input", "capacity record owner.pid must be an integer");
  }
  if (typeof ownerObj.bootToken !== "string" || ownerObj.bootToken.length === 0) {
    return fail("invalid-input", "capacity record owner.bootToken must be a non-empty string");
  }
  if (typeof obj.jobId !== "string" || !isValidUlid(obj.jobId)) {
    return fail("invalid-input", "capacity record jobId must be a ULID");
  }
  if (obj.repoId !== null && (typeof obj.repoId !== "string" || obj.repoId.length === 0)) {
    return fail("invalid-input", "capacity record repoId must be a non-empty string or null");
  }
  if (typeof obj.claimedAt !== "string" || !Number.isFinite(Date.parse(obj.claimedAt))) {
    return fail("invalid-input", "capacity record claimedAt must be an ISO string");
  }
  if (typeof obj.expiresAt !== "string" || !Number.isFinite(Date.parse(obj.expiresAt))) {
    return fail("invalid-input", "capacity record expiresAt must be an ISO string");
  }
  return ok({
    schema: schemaTag("capacity", tag.major) as CapacityRecord["schema"],
    owner: { pid: ownerObj.pid, bootToken: ownerObj.bootToken },
    jobId: obj.jobId,
    repoId: obj.repoId as string | null,
    claimedAt: obj.claimedAt,
    expiresAt: obj.expiresAt,
  });
}

export function validateJobRecord(value: unknown): ValidationResult<JobRecord> {
  if (value === null || typeof value !== "object") {
    return fail("invalid-input", "job record must be an object");
  }
  const obj = value as Record<string, unknown>;
  const tag = parseSchemaTag(obj.schema);
  if (tag === null) return fail("invalid-input", "job record missing or malformed schema tag");
  if (tag.type !== "job") {
    return fail("invalid-input", `expected a job record, found ${tag.type}`);
  }
  if (!knownSchemaMajor("job", tag.major)) {
    return fail("policy-denied", `unknown job schema major: ${tag.major}`);
  }
  if (typeof obj.jobId !== "string" || !isValidUlid(obj.jobId)) {
    return fail("invalid-input", "job record jobId must be a ULID");
  }
  if (typeof obj.revision !== "number" || !Number.isInteger(obj.revision) || obj.revision < 1) {
    return fail("invalid-input", "job record revision must be a positive integer");
  }
  if (typeof obj.status !== "string" || !(JOB_STATUSES as readonly string[]).includes(obj.status)) {
    return fail("invalid-input", `job record status must be one of the seven public states, got ${String(obj.status)}`);
  }
  if (typeof obj.risk !== "string" || !(RISK_CLASSES as readonly string[]).includes(obj.risk)) {
    return fail("invalid-input", `job record risk must be low or medium, got ${String(obj.risk)}`);
  }
  if (typeof obj.repo !== "string" || obj.repo.length === 0) {
    return fail("invalid-input", "job record repo must be a non-empty string");
  }
  if (typeof obj.createdAt !== "string") {
    return fail("invalid-input", "job record createdAt must be an ISO string");
  }
  if (typeof obj.updatedAt !== "string") {
    return fail("invalid-input", "job record updatedAt must be an ISO string");
  }
  const stage = obj.stage === undefined ? null : obj.stage;
  if (stage !== null && typeof stage !== "string") {
    return fail("invalid-input", "job record stage must be a string or null");
  }
  const rawStageState = obj.stageState === undefined ? null : obj.stageState;
  const stageState: StageState | null =
    rawStageState === null ? null :
    (STAGE_STATES as readonly string[]).includes(rawStageState as string) ? (rawStageState as StageState) :
    null;
  if (rawStageState !== null && stageState === null) {
    return fail("invalid-input", `job record stageState must be planned, active, or sealed, got ${String(rawStageState)}`);
  }
  const rawWaitingReason = obj.waitingReason === undefined ? null : obj.waitingReason;
  const waitingReason: WaitingReason | null =
    rawWaitingReason === null ? null :
    (WAITING_REASONS as readonly string[]).includes(rawWaitingReason as string) ? (rawWaitingReason as WaitingReason) :
    null;
  if (rawWaitingReason !== null && waitingReason === null) {
    return fail("invalid-input", `job record waitingReason must be capacity, provider-recovery, or primary-instructions, got ${String(rawWaitingReason)}`);
  }
  return ok({
    schema: schemaTag("job", tag.major) as JobRecord["schema"],
    jobId: obj.jobId,
    revision: obj.revision,
    status: obj.status as JobStatus,
    risk: obj.risk as RiskClass,
    repo: obj.repo,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
    stage: stage as string | null,
    stageState: stageState as StageState | null,
    waitingReason: waitingReason as WaitingReason | null,
  });
}
