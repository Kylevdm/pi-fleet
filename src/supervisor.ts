/**
 * Detached supervisor process.
 *
 * Usage:
 *   node --experimental-strip-types src/supervisor.ts <storeRoot> <jobId>
 *
 * The supervisor is spawned by `fleet submit` after durable admission.  It
 * holds a fenced lease on the job, acquires capacity, drives one writing
 * stage against the Pi stub, seals the stage artifact, and leaves the job
 * at a sealed stage.
 *
 * Ticket 26: Git worktrees and routing are not yet implemented; the Pi
 * model and stub path come from the store config or environment.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JobStore, Paths } from "./store/job-store.ts";
import { repoIdFromRealpath } from "./store/paths.ts";
import type { JobRecord } from "./store/records.ts";

const LEASE_DURATION_MS = 30_000;
const LEASE_RENEW_INTERVAL_MS = 10_000;
const CAPACITY_DURATION_MS = Number(process.env.PI_FLEET_CAPACITY_MS) || 60_000;

/**
 * Resolve the path to the Pi stub binary.  Ticket 26 uses a fixed minimal
 * config; the stub ships in the same package.
 */
function resolvePiStubPath(): string {
  const env = process.env.PI_FLEET_PI_BIN;
  if (env !== undefined && env.length > 0) return env;
  // `import.meta.url` is the path to this module; the stub is a sibling.
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
  if (!claim.ok) {
    // Store-level problem (read-only, invalid id, etc.).  Nothing to do.
    return;
  }
  if (!claim.value.claimed) {
    // Another supervisor holds the lease.  Exit silently.
    return;
  }

  const leaseGeneration = claim.value.generation;

  // Start lease renewer.
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
  // Read the job.
  const readJob = await store.readJob(jobId);
  if (!readJob.ok) return;
  const job = readJob.value;

  // If the job is already cancelled, do nothing.
  if (job.status === "cancelled") return;

  // Resume from a sealed stage if one exists.
  const artifactExists = await store.stageArtifactExists(jobId, 0);
  if (artifactExists) {
    // Adopt the artifact and mark the stage sealed.
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
    // Hold in waiting.
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
      },
      reason: "stage-start",
    },
  }));
  if (!runningMutation.ok) {
    await store.releaseCapacity(jobId);
    return;
  }

  // Drive the Pi stub.
  const artifactPath = Paths.stageArtifact(store.root, jobId, 0);
  const sessionDir = Paths.stageDir(store.root, jobId, 0);
  const pi = spawnPi(resolvePiStubPath(), artifactPath, sessionDir);

  // Record the Pi pid so cancel can target it.
  if (pi.pid !== undefined) {
    await store.writePiPid(jobId, pi.pid);
  }

  // Wait for Pi to finish or be terminated.
  const exitCode = await waitForPi(pi);

  // Remove pid file.
  await store.deletePiPid(jobId);

  // Release capacity before mutating the job record.
  await store.releaseCapacity(jobId);

  // Check if artifact was produced.
  const sealed = existsSync(artifactPath);

  const currentJob = await store.readJob(jobId);
  if (!currentJob.ok) return;

  await mutateJobSafe(store, jobId, currentJob.value.revision, leaseGeneration, (rec) => ({
    ok: true,
    value: {
      next: {
        ...rec,
        revision: rec.revision + 1,
        status: sealed ? ("running" as const) : ("returned-to-orchestrator" as const),
        stage: "writing",
        stageState: sealed ? ("sealed" as const) : ("planned" as const),
        updatedAt: new Date().toISOString(),
      },
      reason: sealed ? "stage-sealed" : "stage-failed",
    },
  }));
}

function spawnPi(
  piPath: string,
  artifactPath: string,
  sessionDir: string,
): ChildProcess {
  const delay = process.env.PI_FLEET_PI_DELAY_MS ?? "3000";
  return spawn(process.execPath, [
    "--experimental-strip-types",
    piPath,
    "--artifact", artifactPath,
    "--delay", delay,
    "--session-dir", sessionDir,
  ], {
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function waitForPi(pi: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    pi.on("exit", (code) => resolve(code));
    pi.on("error", () => resolve(null));
  });
}

/**
 * Wrapper around mutateJob that ignores store-level faults after the
 * initial check.  The supervisor cannot recover from a stale lease or
 * revision mismatch; it simply exits.
 */
async function mutateJobSafe(
  store: JobStore,
  jobId: string,
  expectedRevision: number,
  leaseGeneration: number,
  fn: (current: JobRecord) => { ok: true; value: { next: JobRecord; reason: string } },
): Promise<{ ok: true; value: JobRecord } | { ok: false }> {
  const result = await store.mutateJob(jobId, expectedRevision, fn, { leaseGeneration });
  if (!result.ok) {
    return { ok: false };
  }
  return { ok: true, value: result.value };
}

function randomBootToken(): string {
  return `${process.pid}-${Date.now()}-${Math.random()}`;
}

// ---- entry point ----

async function main(): Promise<void> {
  const [storeRoot, jobId] = process.argv.slice(2);
  if (typeof storeRoot !== "string" || typeof jobId !== "string") {
    process.stderr.write("usage: supervisor.ts <storeRoot> <jobId>\n");
    process.exit(2);
  }
  await supervise(storeRoot, jobId);
}

main().catch((error) => {
  process.stderr.write(String(error) + "\n");
  process.exit(2);
});
