import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JobStore, Paths } from "../src/store/job-store.ts";

// The production stage timeouts are 90s to launch and an hour of wall clock.
// This suite drives a fixture-replaying stub, so it tightens both: a slow
// stage here is a slow test, and a stub still running when a test ends
// lingers, since cancel has no pid to signal. Set on process.env so the
// spawned CLI and its detached supervisor inherit it.
process.env.PI_FLEET_LAUNCH_TIMEOUT_MS = "5000";
process.env.PI_FLEET_STAGE_TIMEOUT_MS = "30000";


const binary = fileURLToPath(new URL("../bin/fleet", import.meta.url));

type Run = { code: number | null; signal: string | null; stdout: string; stderr: string };

/**
 * Rung 2 — integration tests.
 *
 * These spawn the real binary, so they are the only thing proving a fresh
 * clone runs from source with no build step. Later tickets extend this suite
 * as verbs arrive.
 */
function runBinary(args: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, (error, stdout, stderr) => {
      if (error && typeof error.code === "string") {
        // Spawn failure (ENOENT, EACCES) — never a legitimate exit status.
        reject(error);
        return;
      }
      const code = error && typeof error.code === "number" ? error.code : error ? null : 0;
      const signal = error && "signal" in error ? (error.signal ?? null) : null;
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/** Assert one envelope on stdout, a clean stderr, and an exact exit status. */
async function expectEnvelope(args: string[], code: number): Promise<unknown> {
  const result = await runBinary(args);
  assert.strictEqual(result.signal, null, "binary was killed by a signal");
  assert.strictEqual(result.stderr, "", "binary wrote to stderr");
  assert.strictEqual(result.code, code);
  assert.strictEqual(result.stdout.trimEnd().split("\n").length, 1);
  return JSON.parse(result.stdout);
}

describe("rung 2 integration", () => {
  it("prints exactly one envelope and exits 0 on success", async () => {
    assert.deepStrictEqual(await expectEnvelope(["--json"], 0), { ok: true });
  });

  it("prints one problem envelope and exits 1 on an unknown verb", async () => {
    assert.deepStrictEqual(await expectEnvelope(["--json", "wibble"], 1), {
      ok: false,
      problem: "invalid-input",
      message: "unknown verb: wibble",
    });
  });

  it("rejects an unknown flag rather than reporting success", async () => {
    assert.deepStrictEqual(await expectEnvelope(["--jsonn"], 1), {
      ok: false,
      problem: "invalid-input",
      message: "unknown flag: --jsonn",
    });
  });

  it("submit persists a record that survives process exit", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-r2-home-"));
    const repo = mkdtempSync(join(tmpdir(), "fleet-r2-repo-"));
    mkdirSync(join(repo, ".git"));
    const args = [
      "--json",
      "submit",
      "--objective",
      "Make it work",
      "--repo",
      repo,
      "--risk",
      "low",
    ];
    const env = { ...process.env, PI_FLEET_HOME: home };
    const result = await new Promise<Run>((resolve, reject) => {
      execFile(binary, args, { env }, (error, stdout, stderr) => {
        if (error && typeof error.code === "string") {
          reject(error);
          return;
        }
        const code = error && typeof error.code === "number" ? error.code : error ? null : 0;
        const signal = error && "signal" in error ? (error.signal ?? null) : null;
        resolve({ code, signal, stdout, stderr });
      });
    });
    assert.strictEqual(result.signal, null);
    assert.strictEqual(result.stderr, "");
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout.trimEnd().split("\n").length, 1);
    const submission = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.strictEqual(submission.ok, true);
    assert.strictEqual(submission.status, "admitted");
    const jobId = submission.jobId as string;
    assert.match(jobId, /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);

    // Re-open the store in a second process and read the job back.
    const getResult = await new Promise<Run>((resolve, reject) => {
      execFile(binary, ["get", jobId, "--json"], { env }, (error, stdout, stderr) => {
        if (error && typeof error.code === "string") {
          reject(error);
          return;
        }
        const code = error && typeof error.code === "number" ? error.code : error ? null : 0;
        const signal = error && "signal" in error ? (error.signal ?? null) : null;
        resolve({ code, signal, stdout, stderr });
      });
    });
    assert.strictEqual(getResult.stderr, "");
    assert.strictEqual(getResult.code, 0);
    const view = JSON.parse(getResult.stdout) as Record<string, unknown>;
    assert.strictEqual(view.ok, true);
    assert.strictEqual(view.objective, "Make it work");
    assert.strictEqual(view.risk, "low");
  });

  it("submit rejects a missing --objective", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-r2-"));
    const repo = mkdtempSync(join(tmpdir(), "fleet-r2-"));
    mkdirSync(join(repo, ".git"));
    const env = { ...process.env, PI_FLEET_HOME: home };
    const out = await expectEnvelope(
      ["--json", "submit", "--repo", repo, "--risk", "low"],
      1,
    );
    void env;
    assert.deepStrictEqual(out, {
      ok: false,
      problem: "invalid-input",
      message: "--objective is required",
    });
  });

  it("list reports an empty page when no jobs exist", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-r2-"));
    const env = { ...process.env, PI_FLEET_HOME: home };
    const result = await new Promise<Run>((resolve, reject) => {
      execFile(binary, ["--json", "list"], { env }, (error, stdout, stderr) => {
        if (error && typeof error.code === "string") {
          reject(error);
          return;
        }
        const code = error && typeof error.code === "number" ? error.code : error ? null : 0;
        const signal = error && "signal" in error ? (error.signal ?? null) : null;
        resolve({ code, signal, stdout, stderr });
      });
    });
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stderr, "");
    const page = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.strictEqual(page.ok, true);
    assert.deepStrictEqual(page.jobs, []);
    assert.strictEqual(page.nextCursor, null);
  });

  it("get with no id is invalid-input", async () => {
    const env = { ...process.env, PI_FLEET_HOME: mkdtempSync(join(tmpdir(), "fleet-r2-")) };
    const out = await expectEnvelope(["--json", "get"], 1);
    void env;
    assert.deepStrictEqual(out, {
      ok: false,
      problem: "invalid-input",
      message: "fleet get <jobId> requires a job id",
    });
  });

  it("get with a well-formed unknown id is not-found", async () => {
    const env = { ...process.env, PI_FLEET_HOME: mkdtempSync(join(tmpdir(), "fleet-r2-")) };
    const out = await expectEnvelope(["get", "01JQQ000000000000000000000", "--json"], 1);
    void env;
    assert.deepStrictEqual(out, {
      ok: false,
      problem: "not-found",
      message: "no job: 01JQQ000000000000000000000",
    });
  });

  // Rung 2 manifest item 10: a torn write leaves the last good revision
  // readable. The test writes a record via the Fleet module, drops torn
  // scratch into the job's `tmp/`, and confirms `get` returns the good
  // record in a fresh store.
  it("a torn write leaves the last good job revision readable", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-r2-torn-"));
    const repo = mkdtempSync(join(tmpdir(), "fleet-r2-repo-"));
    mkdirSync(join(repo, ".git"));
    const env = { ...process.env, PI_FLEET_HOME: home };

    // Submit through the binary to populate the store.
    const submit = await new Promise<Run>((resolve, reject) => {
      execFile(
        binary,
        ["--json", "submit", "--objective", "Survive a torn write", "--repo", repo, "--risk", "low"],
        { env },
        (error, stdout, stderr) => {
          if (error && typeof error.code === "string") {
            reject(error);
            return;
          }
          const code = error && typeof error.code === "number" ? error.code : error ? null : 0;
          const signal = error && "signal" in error ? (error.signal ?? null) : null;
          resolve({ code, signal, stdout, stderr });
        },
      );
    });
    assert.strictEqual(submit.code, 0);
    const submission = JSON.parse(submit.stdout) as Record<string, unknown>;
    const jobId = submission.jobId as string;

    // Plant torn scratch files: one truncated and one corrupted. Neither
    // is a job.json; both are safely discardable.
    const tmpDir = Paths.tmpDir(home, jobId);
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "job.json.partial"), "{ not json");
    writeFileSync(join(tmpDir, "snapshot.json.torn"), '{"schema":');

    // Re-open the store and confirm the good record is readable.
    const store = await JobStore.open(home);
    const readResult = await store.readJob(jobId);
    if (!readResult.ok) {
      assert.fail(`readJob failed: ${readResult.problem} (${readResult.message})`);
    }
    assert.strictEqual(readResult.value.jobId, jobId);
    assert.strictEqual(readResult.value.revision, 1);

    // The scratch is still there (the store does not auto-clean); it is
    // simply ignored. The fact that readJob succeeded proves it.
    assert.ok(existsSync(join(tmpDir, "job.json.partial")));

    // Through the binary's `get`, the same record is observable.
    const get = await new Promise<Run>((resolve, reject) => {
      execFile(binary, ["get", jobId, "--json"], { env }, (error, stdout, stderr) => {
        if (error && typeof error.code === "string") {
          reject(error);
          return;
        }
        const code = error && typeof error.code === "number" ? error.code : error ? null : 0;
        const signal = error && "signal" in error ? (error.signal ?? null) : null;
        resolve({ code, signal, stdout, stderr });
      });
    });
    assert.strictEqual(get.code, 0);
    const view = JSON.parse(get.stdout) as Record<string, unknown>;
    assert.strictEqual(view.objective, "Survive a torn write");
  });

  it("submit then get round-trip through the binary records every entry in audit.jsonl", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-r2-audit-"));
    const repo = mkdtempSync(join(tmpdir(), "fleet-r2-repo-"));
    mkdirSync(join(repo, ".git"));
    const env = { ...process.env, PI_FLEET_HOME: home };

    const submit = await new Promise<Run>((resolve, reject) => {
      execFile(
        binary,
        ["--json", "submit", "--objective", "audit me", "--repo", repo, "--risk", "low"],
        { env },
        (error, stdout, stderr) => {
          if (error && typeof error.code === "string") {
            reject(error);
            return;
          }
          const code = error && typeof error.code === "number" ? error.code : error ? null : 0;
          const signal = error && "signal" in error ? (error.signal ?? null) : null;
          resolve({ code, signal, stdout, stderr });
        },
      );
    });
    assert.strictEqual(submit.code, 0);
    const submission = JSON.parse(submit.stdout) as Record<string, unknown>;
    const jobId = submission.jobId as string;

    const audit = Paths.jobAudit(home, jobId);
    assert.ok(existsSync(audit));
    const text = readFileSync(audit, "utf8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    assert.strictEqual(lines.length, 1);
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    assert.strictEqual(entry.schema, "audit/1");
    assert.strictEqual(entry.action, "submit");
    assert.strictEqual(entry.revision, 1);
  });

  // F1/F2: CLI works with documented argument order (verb first).
  it("F1: fleet submit works with verb first and --json last", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-r2-f1-"));
    const repo = mkdtempSync(join(tmpdir(), "fleet-r2-repo-"));
    mkdirSync(join(repo, ".git"));
    const env = { ...process.env, PI_FLEET_HOME: home };
    const result = await new Promise<{ code: number; stdout: string }>((resolve, reject) => {
      execFile(
        binary,
        ["submit", "--objective", "hello", "--repo", repo, "--risk", "low", "--json"],
        { env },
        (error, stdout) => {
          if (error && typeof error.code === "string") { reject(error); return; }
          const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
          resolve({ code, stdout });
        },
      );
    });
    assert.strictEqual(result.code, 0, "submit with verb first should succeed");
    const env_ = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.strictEqual(env_.ok, true);
    assert.strictEqual(env_.status, "admitted");
  });

  it("F2: fleet list works with verb first and --json last", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-r2-f2-"));
    const env = { ...process.env, PI_FLEET_HOME: home };
    const result = await new Promise<{ code: number; stdout: string }>((resolve, reject) => {
      execFile(
        binary,
        ["list", "--json"],
        { env },
        (error, stdout) => {
          if (error && typeof error.code === "string") { reject(error); return; }
          const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
          resolve({ code, stdout });
        },
      );
    });
    assert.strictEqual(result.code, 0, "list with verb first should succeed");
    const page = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.strictEqual(page.ok, true);
  });

  it("F2: fleet list bare (no --json) works with verb first", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-r2-f2b-"));
    const env = { ...process.env, PI_FLEET_HOME: home };
    const result = await new Promise<{ code: number; stdout: string }>((resolve, reject) => {
      execFile(
        binary,
        ["list"],
        { env },
        (error, stdout) => {
          if (error && typeof error.code === "string") { reject(error); return; }
          const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
          resolve({ code, stdout });
        },
      );
    });
    assert.strictEqual(result.code, 0, "bare list should succeed");
    const page = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.strictEqual(page.ok, true);
  });

  // F10: lock file records holder identity (pid + boot token).
  it("F10: lock file contains holder pid and boot token", async () => {
    const { acquireLock, releaseLock } = await import("../src/store/atomic.ts");
    const dir = mkdtempSync(join(tmpdir(), "fleet-r2-lock-"));
    const lock = join(dir, "job.lock");
    await acquireLock(lock, { staleMs: 60_000 });
    const content = readFileSync(lock, "utf8");
    const holder = JSON.parse(content) as Record<string, unknown>;
    assert.strictEqual(holder.pid, process.pid);
    assert.strictEqual(typeof holder.bootToken, "string");
    assert.ok((holder.bootToken as string).length > 0);
    await releaseLock(lock);
  });

  // F14: submit does not create a fifth top-level entry (no root tmp/).
  it("F14: submit does not create a tmp/ directory at the store root", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-r2-notmp-"));
    const repo = mkdtempSync(join(tmpdir(), "fleet-r2-repo-"));
    mkdirSync(join(repo, ".git"));
    const env = { ...process.env, PI_FLEET_HOME: home };
    const submit = await new Promise<{ code: number; stdout: string }>((resolve, reject) => {
      execFile(
        binary,
        ["submit", "--objective", "no root tmp", "--repo", repo, "--risk", "low", "--json"],
        { env },
        (error, stdout) => {
          if (error && typeof error.code === "string") { reject(error); return; }
          const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
          resolve({ code, stdout });
        },
      );
    });
    assert.strictEqual(submit.code, 0);
    const topLevel = readdirSync(home);
    // The four spec subtrees plus store.json and config.json. No tmp/.
    assert.ok(!topLevel.includes("tmp"), `root should not contain tmp/, found: ${topLevel.join(", ")}`);
  });
});

describe("rung 2 — attempt 3 findings", () => {
  // A1: a corrupt record yields typed envelopes, never exit 2.
  it("A1: corrupt job record — get exits 1 with unavailable-dependency, list exits 0 with unreadable", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-r2-a1-"));
    const repo = mkdtempSync(join(tmpdir(), "fleet-r2-a1-repo-"));
    mkdirSync(join(repo, ".git"));
    const env = { ...process.env, PI_FLEET_HOME: home };

    const submit = await new Promise<Run>((resolve, reject) => {
      execFile(
        binary,
        ["--json", "submit", "--objective", "corrupt me", "--repo", repo, "--risk", "low"],
        { env },
        (error, stdout, stderr) => {
          if (error && typeof error.code === "string") { reject(error); return; }
          const code = error && typeof error.code === "number" ? error.code : error ? null : 0;
          const signal = error && "signal" in error ? (error.signal ?? null) : null;
          resolve({ code, signal, stdout, stderr });
        },
      );
    });
    assert.strictEqual(submit.code, 0);
    const jobId = (JSON.parse(submit.stdout) as Record<string, unknown>).jobId as string;
    writeFileSync(Paths.jobJson(home, jobId), "{ not json");

    const runWithEnv = (args: string[]): Promise<Run> =>
      new Promise((resolve, reject) => {
        execFile(binary, args, { env }, (error, stdout, stderr) => {
          if (error && typeof error.code === "string") { reject(error); return; }
          const code = error && typeof error.code === "number" ? error.code : error ? null : 0;
          const signal = error && "signal" in error ? (error.signal ?? null) : null;
          resolve({ code, signal, stdout, stderr });
        });
      });

    const gotRun = await runWithEnv(["get", jobId, "--json"]);
    assert.strictEqual(gotRun.code, 1);
    assert.strictEqual(gotRun.stderr, "");
    assert.deepStrictEqual(JSON.parse(gotRun.stdout), {
      ok: false,
      problem: "unavailable-dependency",
      message: `job ${jobId} is unreadable: invalid JSON`,
    });

    const listRun = await runWithEnv(["list", "--json"]);
    assert.strictEqual(listRun.code, 0);
    const page = JSON.parse(listRun.stdout) as Record<string, unknown>;
    assert.strictEqual(page.ok, true);
    assert.strictEqual(page.unreadable, 1);
    assert.deepStrictEqual(page.jobs, []);
  });

  // B3: job-level vs root-level scratch placement must come from the caller,
  // not from looking for the literal "jobs" segment in the path.
  it("B3: a store root containing a 'jobs' segment gains no stray tmp/ entry", async () => {
    const base = mkdtempSync(join(tmpdir(), "fleet-r2-jobsseg-"));
    const home = join(base, "jobs", "store");
    const repo = mkdtempSync(join(tmpdir(), "fleet-r2-jobsseg-repo-"));
    mkdirSync(join(repo, ".git"));
    const env = { ...process.env, PI_FLEET_HOME: home };
    const result = await new Promise<Run>((resolve, reject) => {
      execFile(
        binary,
        ["submit", "--objective", "jobs in path", "--repo", repo, "--risk", "low", "--json"],
        { env },
        (error, stdout, stderr) => {
          if (error && typeof error.code === "string") { reject(error); return; }
          const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
          const signal = error && "signal" in error ? (error.signal ?? null) : null;
          resolve({ code, signal, stdout, stderr });
        },
      );
    });
    assert.strictEqual(result.code, 0);
    const topLevel = readdirSync(home);
    assert.ok(!topLevel.includes("tmp"), `root should not contain tmp/, found: ${topLevel.join(", ")}`);
  });
});

describe("ticket 26 rung 2 integration", () => {
  async function submitJob(home: string, repo: string, envOverride?: Record<string, string>): Promise<{ jobId: string; revision: number }> {
    const env = { ...process.env, PI_FLEET_HOME: home, ...envOverride };
    const result = await new Promise<Run>((resolve, reject) => {
      execFile(
        binary,
        ["submit", "--objective", "integration test", "--repo", repo, "--risk", "low", "--json"],
        { env },
        (error, stdout, stderr) => {
          if (error && typeof error.code === "string") { reject(error); return; }
          const code = error && typeof error.code === "number" ? error.code : error ? null : 0;
          const signal = error && "signal" in error ? (error.signal ?? null) : null;
          resolve({ code, signal, stdout, stderr });
        },
      );
    });
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stderr, "");
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.strictEqual(envelope.ok, true);
    return { jobId: envelope.jobId as string, revision: envelope.revision as number };
  }

  async function getJob(home: string, jobId: string): Promise<Record<string, unknown>> {
    const env = { ...process.env, PI_FLEET_HOME: home };
    const result = await new Promise<Run>((resolve, reject) => {
      execFile(binary, ["get", jobId, "--json"], { env }, (error, stdout, stderr) => {
        if (error && typeof error.code === "string") { reject(error); return; }
        const code = error && typeof error.code === "number" ? error.code : error ? null : 0;
        const signal = error && "signal" in error ? (error.signal ?? null) : null;
        resolve({ code, signal, stdout, stderr });
      });
    });
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stderr, "");
    return JSON.parse(result.stdout) as Record<string, unknown>;
  }

  async function cancelJob(home: string, jobId: string, revision: number): Promise<Record<string, unknown>> {
    const env = { ...process.env, PI_FLEET_HOME: home };
    const result = await new Promise<Run>((resolve, reject) => {
      execFile(
        binary,
        ["cancel", "--job-id", jobId, "--expected-revision", String(revision), "--json"],
        { env },
        (error, stdout, stderr) => {
          if (error && typeof error.code === "string") { reject(error); return; }
          const code = error && typeof error.code === "number" ? error.code : error ? null : 0;
          const signal = error && "signal" in error ? (error.signal ?? null) : null;
          resolve({ code, signal, stdout, stderr });
        },
      );
    });
    assert.strictEqual(result.stderr, "");
    return JSON.parse(result.stdout) as Record<string, unknown>;
  }

  function runSupervisor(home: string, jobId: string): void {
    const env = { ...process.env, PI_FLEET_HOME: home };
    const supervisor = fileURLToPath(new URL("../src/supervisor.ts", import.meta.url));
    spawn(process.execPath, ["--experimental-strip-types", supervisor, home, jobId], {
      detached: true,
      stdio: "ignore",
      env,
    });
  }

  async function readLease(home: string, jobId: string): Promise<{ owner: { pid: number } } | null> {
    const path = Paths.supervisorLease(home, jobId);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as { owner: { pid: number } };
    } catch {
      return null;
    }
  }

  async function pollFor(
    predicate: () => Promise<boolean>,
    timeoutMs: number,
    intervalMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
  }

  it("submit returns before the supervisor finishes (status is admitted immediately)", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-r26-submit-"));
    const repo = mkdtempSync(join(tmpdir(), "fleet-r26-repo-"));
    mkdirSync(join(repo, ".git"));
    const { jobId } = await submitJob(home, repo);
    const view = await getJob(home, jobId);
    assert.strictEqual(view.status, "admitted");
  });

  it("SIGKILL of the supervisor mid-stage resumes from the last seal", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-r26-kill-"));
    const repo = mkdtempSync(join(tmpdir(), "fleet-r26-repo-"));
    mkdirSync(join(repo, ".git"));
    const { jobId } = await submitJob(home, repo);

    // Wait for the supervisor to claim the lease.
    const hasLease = await pollFor(async () => (await readLease(home, jobId)) !== null, 5_000, 100);
    assert.ok(hasLease, "supervisor should claim the lease");

    // Wait for the stage to go active.
    const isActive = await pollFor(async () => {
      const j = await getJob(home, jobId);
      return j.stageState === "active";
    }, 5_000, 100);
    assert.ok(isActive, "stage should go active");

    // Kill the supervisor.
    const lease = await readLease(home, jobId);
    assert.ok(lease !== null);
    try {
      process.kill(lease!.owner.pid, "SIGKILL");
    } catch {
      // Already gone.
    }

    // Clean up the old lease and capacity so the new supervisor can proceed.
    const store = await JobStore.open(home);
    await store.breakSupervisorLease(jobId);
    await store.releaseCapacity(jobId);

    // Spawn a new supervisor.
    runSupervisor(home, jobId);

    // The new supervisor should resume and seal the stage.
    const isSealed = await pollFor(async () => {
      const j = await getJob(home, jobId);
      return j.stageState === "sealed";
    }, 10_000, 200);
    assert.ok(isSealed, "new supervisor should seal the stage after resume");
  });

  it("a sealed stage is never re-run by a new supervisor", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-r26-norepeat-"));
    const repo = mkdtempSync(join(tmpdir(), "fleet-r26-repo-"));
    mkdirSync(join(repo, ".git"));
    const { jobId } = await submitJob(home, repo);

    // Let the first supervisor finish and seal the stage.
    const isSealed = await pollFor(async () => {
      const j = await getJob(home, jobId);
      return j.stageState === "sealed";
    }, 15_000, 200);
    assert.ok(isSealed, "first supervisor should seal the stage");

    // Record the artifact mtime.
    const artifactPath = Paths.stageArtifact(home, jobId, 0);
    assert.ok(existsSync(artifactPath), "artifact should exist");
    const beforeMtime = statSync(artifactPath).mtimeMs;

    // Manually revert the job record to active so a naive supervisor would re-run.
    const store = await JobStore.open(home);
    const job = await store.readJob(jobId);
    assert.ok(job.ok);
    await store.mutateJob(jobId, job.value.revision, (current) => ({
      ok: true,
      value: {
        next: { ...current, revision: current.revision + 1, stageState: "active", updatedAt: new Date().toISOString() },
        reason: "test-reset",
      },
    }));

    // Break lease and spawn a new supervisor.
    await store.breakSupervisorLease(jobId);
    runSupervisor(home, jobId);

    // Wait a bit for the new supervisor to do its work.
    await new Promise((r) => setTimeout(r, 2_000));

    // The artifact must not have been overwritten.
    const afterMtime = statSync(artifactPath).mtimeMs;
    assert.strictEqual(afterMtime, beforeMtime, "artifact must not be re-written");
  });

  it("single writer per repository via the per-repository capacity lease", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-r26-cap-"));
    const repo = mkdtempSync(join(tmpdir(), "fleet-r26-repo-"));
    mkdirSync(join(repo, ".git"));

    // Submit first job with a very long Pi delay so it holds capacity.
    const first = await submitJob(home, repo, { PI_FLEET_PI_DELAY_MS: "60000" });
    const firstRunning = await pollFor(async () => {
      const j = await getJob(home, first.jobId);
      return j.status === "running";
    }, 5_000, 200);
    assert.ok(firstRunning, "first job should start running");

    // Now submit the second job for the same repo.
    const second = await submitJob(home, repo);

    // The second job should end up waiting on capacity because the first
    // holds the repo slot.
    const secondWaiting = await pollFor(async () => {
      const j = await getJob(home, second.jobId);
      return j.status === "waiting" && j.waitingReason === "capacity";
    }, 5_000, 200);
    assert.ok(secondWaiting, "second job in same repo should wait on capacity");
  });

  it("cancel through the binary stops the job and preserves records", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-r26-cancel-"));
    const repo = mkdtempSync(join(tmpdir(), "fleet-r26-repo-"));
    mkdirSync(join(repo, ".git"));
    const { jobId } = await submitJob(home, repo);

    // Wait for the job to start running.
    const isRunning = await pollFor(async () => {
      const j = await getJob(home, jobId);
      return j.status === "running";
    }, 5_000, 200);
    assert.ok(isRunning, "job should start running");

    // Read the current revision — the supervisor may have bumped it.
    let currentRevision = (await getJob(home, jobId)).revision as number;

    let result = await cancelJob(home, jobId, currentRevision);

    // If the supervisor moved the revision under us, fetch the latest and retry once.
    if (result.ok === false && (result.problem === "stale-confirmation" || result.problem === "conflict")) {
      currentRevision = (await getJob(home, jobId)).revision as number;
      result = await cancelJob(home, jobId, currentRevision);
    }

    assert.strictEqual(result.ok, true, `cancel failed: ${JSON.stringify(result)}`);
    assert.strictEqual(result.status, "cancelled");

    // Capacity should be released: a new job in the same repo should run.
    const next = await submitJob(home, repo);
    const nextSealed = await pollFor(async () => {
      const j = await getJob(home, next.jobId);
      return j.stageState === "sealed";
    }, 15_000, 200);
    assert.ok(nextSealed, "capacity should be freed after cancel");
  });
});
