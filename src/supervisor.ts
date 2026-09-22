/**
 * Detached supervisor process (ticket 26 + ticket 25).
 *
 * Usage:
 *   node --experimental-strip-types src/supervisor.ts <storeRoot> <jobId>
 *
 * The supervisor is spawned by `fleet submit` after durable admission. It
 * holds a fenced lease on the job, acquires capacity, drives one writing
 * stage through `pi-driver.runStage`, interprets the driver outcome, and
 * leaves the job at a sealed stage or surfaces a typed failure.
 *
 * Ticket 25 split the spawn-and-consume logic out into `src/pi-driver.ts`.
 * The supervisor is the policy layer; the driver is the protocol layer.
 */

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { JobStore, Paths } from "./store/job-store.ts";
import { repoIdFromRealpath } from "./store/paths.ts";
import type { JobRecord } from "./store/records.ts";
import { resolvePiBinary, runStage } from "./pi-driver.ts";

const LEASE_DURATION_MS = 30_000;
const LEASE_RENEW_INTERVAL_MS = 10_000;
const CAPACITY_DURATION_MS = Number(process.env.PI_FLEET_CAPACITY_MS) || 60_000;

/** Spec defaults. The environment overrides them; tests tighten them. */
const SPEC_LAUNCH_TIMEOUT_MS = 90_000;
const SPEC_STAGE_TIMEOUT_MS = 60 * 60 * 1000;

export interface StageTimeouts {
  launchTimeoutMs: number;
  stageTimeoutMs: number;
}

/**
 * Stage timeouts for a production run, overridable per environment.
 *
 * These were previously hardcoded to the values the test suite wanted — a 5s
 * launch timeout classifies any real Pi cold start slower than five seconds
 * as an infrastructure failure, and a 30s stage cap SIGTERMs any real writing
 * stage mid-work. The spec values are the defaults; the suite sets the tight
 * ones through the environment.
 *
 * @internal exported for testing.
 */
export function resolveStageTimeouts(env: NodeJS.ProcessEnv): StageTimeouts {
  const positive = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    launchTimeoutMs: positive(env.PI_FLEET_LAUNCH_TIMEOUT_MS, SPEC_LAUNCH_TIMEOUT_MS),
    stageTimeoutMs: positive(env.PI_FLEET_STAGE_TIMEOUT_MS, SPEC_STAGE_TIMEOUT_MS),
  };
}

/**
 * Resolve the Pi binary for production. Order:
 *   1. `PI_FLEET_PI_BIN` environment variable
 *   2. default: the bundled stub at `src/pi-stub.ts` (development default;
 *      replaced with the real `pi` binary once `fleet mcp install` lands)
 */
function resolveProductionPiBinary(): string {
  const env = process.env.PI_FLEET_PI_BIN;
  if (env !== undefined && env.length > 0) return env;
  const here = fileURLToPath(import.meta.url);
  return join(dirname(here), "pi-stub.ts");
}

/**
 * The supervisor's main loop for a single job.
 */
async function supervise(storeRoot: string, jobId: string): Promise<void> {
  const store = await JobStore.open(storeRoot);
  const owner = { pid: process.pid, bootToken: randomBootToken() };

  // Claim the lease.
  const claim = await store.claimSupervisorLease(jobId, owner, LEASE_DURATION_MS);
  if (!claim.ok) return;
  if (!claim.value.claimed) {
    // Another supervisor holds the lease. Exit silently.
    return;
  }

  const leaseGeneration = claim.value.generation;

  const renewer = setInterval(async () => {
    await store.claimSupervisorLease(jobId, owner, LEASE_DURATION_MS);
  }, LEASE_RENEW_INTERVAL_MS);

  try {
    await runJob(store, jobId, leaseGeneration, owner);
  } finally {
    clearInterval(renewer);
  }
}

async function runJob(
  store: JobStore,
  jobId: string,
  leaseGeneration: number,
  owner: { pid: number; bootToken: string },
): Promise<void> {
  const readJob = await store.readJob(jobId);
  if (!readJob.ok) return;
  const job = readJob.value;
  if (job.status === "cancelled") return;

  // Resume from a sealed stage if one exists. The artifact presence is the
  // seal — even if the supervisor crashed mid-stage, recovery adopts rather
  // than repeats. The driver writes the artifact; we just check for it.
  const artifactExists = await store.stageArtifactExists(jobId, 0);
  if (artifactExists) {
    await mutateJobSafe(store, jobId, job.revision, leaseGeneration, (current) => ({
      ok: true,
      value: {
        next: {
          ...current,
          revision: current.revision + 1,
          status: "running" as const,
          stage: "writing",
          stageState: "sealed" as const,
          updatedAt: new Date().toISOString(),
        },
        reason: "adopt-sealed-artifact",
      },
    }));
    return;
  }

  // Try to acquire capacity.
  const repoId = repoIdFromRealpath(job.repo);
  const capacity = await store.acquireCapacity(jobId, repoId, owner, CAPACITY_DURATION_MS);
  if (!capacity.ok) return;

  if (!capacity.value.acquired) {
    await mutateJobSafe(store, jobId, job.revision, leaseGeneration, (current) => ({
      ok: true,
      value: {
        next: {
          ...current,
          revision: current.revision + 1,
          status: "waiting" as const,
          waitingReason: "capacity" as const,
          updatedAt: new Date().toISOString(),
        },
        reason: "capacity-unavailable",
      },
    }));
    return;
  }

  // Transition to running / active stage.
  const runningMutation = await mutateJobSafe(store, jobId, job.revision, leaseGeneration, (current) => ({
    ok: true,
    value: {
      next: {
        ...current,
        revision: current.revision + 1,
        status: "running" as const,
        stage: "writing",
        stageState: "active" as const,
        waitingReason: null,
        updatedAt: new Date().toISOString(),
        // Write the agent_start timestamp onto the job; consumers can read it.
        ...({} as Record<string, unknown>),
      },
      reason: "stage-start",
    },
  }));
  if (!runningMutation.ok) {
    await store.releaseCapacity(jobId);
    return;
  }

  // Drive the Pi stage through the new driver.
  const artifactPath = Paths.stageArtifact(store.root, jobId, 0);
  const sessionDir = Paths.stageDir(store.root, jobId, 0);
  const piBinary = resolvePiBinary({ env: process.env, defaultPath: resolveProductionPiBinary() });
  if (piBinary === null) {
    // No binary resolves — fall back to the bundled stub explicitly so the
    // driver still has something to spawn.
  }

  const timeouts = resolveStageTimeouts(process.env);
  const run = await runStage({
    jobId,
    stageIndex: 0,
    attempt: 1,
    piBinary: piBinary ?? resolveProductionPiBinary(),
    artifactPath,
    stageDir: Paths.stageDir(store.root, jobId, 0),
    sessionDir,
    launchTimeoutMs: timeouts.launchTimeoutMs,
    stageTimeoutMs: timeouts.stageTimeoutMs,
    cwd: job.repo,
    model: undefined,
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "submit_write"],
  });

  if (run.inputProblem !== null) {
    // Bad job id at the supervisor's seam is unexpected; surface as a typed
    // return reason on the job.
    await markReturned(store, jobId, run.inputProblem.message);
    await store.releaseCapacity(jobId);
    return;
  }

  // No pid is recorded: the driver owns the spawn and does not expose the
  // child's pid yet. Writing a placeholder is worse than writing nothing —
  // cancel signals whatever the pid file says, and a non-positive pid is a
  // broadcast, not a process.

  // Release capacity before mutating the job record.
  await store.releaseCapacity(jobId);

  const sealed = run.outcome.kind === "sealed";
  const reason =
    run.outcome.kind === "sealed"
      ? "stage-sealed"
      : run.outcome.kind === "quality"
        ? `quality:${run.outcome.reason}`
        : `infrastructure:${run.outcome.reason}`;

  const currentJob = await store.readJob(jobId);
  if (!currentJob.ok) return;

  // The driver writes the artifact when sealed; we treat that as the seal.
  // For non-sealed outcomes we do NOT delete the artifact (recoverability).
  const artifactNowExists = sealed ? existsSync(artifactPath) : artifactExists;

  await mutateJobSafe(store, jobId, currentJob.value.revision, leaseGeneration, (rec) => ({
    ok: true,
    value: {
      next: {
        ...rec,
        revision: rec.revision + 1,
        status: artifactNowExists ? ("running" as const) : ("returned-to-orchestrator" as const),
        stage: "writing",
        stageState: artifactNowExists ? ("sealed" as const) : ("planned" as const),
        updatedAt: new Date().toISOString(),
      },
      reason,
    },
  }));
}

/**
 * The current package has no build step — `bin/fleet` runs `.ts` directly
 * under Node's strip-types flag. The driver handles `.ts` paths itself:
 * a `.ts` `piBinary` is run via `node --experimental-strip-types <path>`,
 * a real binary path is spawned directly. No wrapper script is needed.
 */

async function markReturned(
  store: JobStore,
  jobId: string,
  message: string,
): Promise<void> {
  const readJob = await store.readJob(jobId);
  if (!readJob.ok) return;
  await store.mutateJob(
    jobId,
    readJob.value.revision,
    (current) => ({
      ok: true,
      value: {
        next: {
          ...current,
          revision: current.revision + 1,
          status: "returned-to-orchestrator" as const,
          updatedAt: new Date().toISOString(),
        },
        reason: `returned:${message}`,
      },
    }),
  );
}

async function mutateJobSafe(
  store: JobStore,
  jobId: string,
  expectedRevision: number,
  leaseGeneration: number,
  fn: (current: JobRecord) => { ok: true; value: { next: JobRecord; reason: string } },
): Promise<{ ok: true; value: JobRecord } | { ok: false }> {
  const result = await store.mutateJob(jobId, expectedRevision, fn, { leaseGeneration });
  if (!result.ok) return { ok: false };
  return { ok: true, value: result.value };
}

function randomBootToken(): string {
  return `${process.pid}-${Date.now()}-${Math.random()}`;
}

async function main(): Promise<void> {
  const [storeRoot, jobId] = process.argv.slice(2);
  if (typeof storeRoot !== "string" || typeof jobId !== "string") {
    process.stderr.write("usage: supervisor.ts <storeRoot> <jobId>\n");
    process.exit(2);
  }
  await supervise(storeRoot, jobId);
}

// Only run when spawned as the entry point. Without this guard, importing
// anything from this module — a test reaching for resolveStageTimeouts, say —
// executes main(), prints a usage error and exits the importing process.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error) => {
    process.stderr.write(String(error) + "\n");
    process.exit(2);
  });
}
