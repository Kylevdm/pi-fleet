import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROBLEMS } from "../src/envelope.ts";

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
 * Spawn the binary and return the run summary. Used by the adapter
 * conformance suite so we can run the same expectations through the CLI
 * today and through MCP tomorrow without rewriting the assertions.
 */
function runBinary(args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve, reject) => {
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
}

/**
 * Adapter contract: every adapter in this list turns a (verb, args, env)
 * triple into a `(code, envelope)` pair. Today there is only the CLI; later
 * tickets add MCP and the same assertions re-run across all of them.
 */
interface Adapter {
  readonly name: string;
  invoke(args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ code: number; envelope: unknown }>;
}

const ADAPTERS: readonly Adapter[] = [
  {
    name: "cli",
    async invoke(args, env) {
      // Documented form: verb first, --json last.
      const r = await runBinary([...args, "--json"], env);
      assert.strictEqual(r.signal, null);
      assert.strictEqual(r.stderr, "");
      const envelope = JSON.parse(r.stdout.trimEnd());
      const code = r.code ?? 2;
      return { code, envelope };
    },
  },
];

const ADAPTER_NAMES = ADAPTERS.map((a) => a.name);

function adapter(name: string): Adapter {
  const a = ADAPTERS.find((x) => x.name === name);
  if (a === undefined) throw new Error(`unknown adapter: ${name}`);
  return a;
}

/** A supervisor can advance its stage between a read and a cancellation. */
async function cancelCurrent(a: Adapter, env: NodeJS.ProcessEnv, jobId: string) {
  let current = await a.invoke(["get", jobId], env);
  let result = await a.invoke(
    ["cancel", "--job-id", jobId, "--expected-revision", String((current.envelope as Record<string, unknown>).revision)],
    env,
  );
  if (result.code !== 0) {
    current = await a.invoke(["get", jobId], env);
    result = await a.invoke(
      ["cancel", "--job-id", jobId, "--expected-revision", String((current.envelope as Record<string, unknown>).revision)],
      env,
    );
  }
  return result;
}

async function freshHome(): Promise<NodeJS.ProcessEnv> {
  const home = mkdtempSync(join(tmpdir(), "fleet-r3-"));
  return { ...process.env, PI_FLEET_HOME: home };
}

async function seedRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "fleet-r3-repo-"));
  mkdirSync(join(repo, ".git"));
  return repo;
}

/**
 * Rung 3 — adapter conformance.
 *
 * Asserts the envelope shape is identical across adapters (today: CLI),
 * `problem` never takes a value outside the seven, and `next` is always
 * legal for the reported status. The test suite is parameterised over the
 * adapter list so adding MCP (ticket 08) automatically re-checks every
 * invariant.
 */
describe("rung 3 conformance", () => {
  for (const name of ADAPTER_NAMES) {
    describe(`adapter: ${name}`, () => {
      it("submit returns an ok envelope with the seven-shape fields", async () => {
        const env = await freshHome();
        const repo = await seedRepo();
        const a = adapter(name);
        const { code, envelope } = await a.invoke(
          ["submit", "--objective", "conformance", "--repo", repo, "--risk", "low"],
          env,
        );
        assert.strictEqual(code, 0);
        const envObj = envelope as Record<string, unknown>;
        assert.strictEqual(envObj.ok, true);
        // A detached supervisor may claim the job between submit and wait;
        // the contract here is that neither non-terminal state wakes wait.
        assert.ok(["admitted", "running", "waiting"].includes(envObj.status as string));
        assert.strictEqual(typeof envObj.jobId, "string");
        assert.strictEqual(typeof envObj.revision, "number");
        assert.deepStrictEqual(envObj.next, ["get", "wait", "cancel"]);
        assert.strictEqual(typeof envObj.size, "object");
      });

      it("problem envelopes use only the closed problem set", async () => {
        const env = await freshHome();
        const a = adapter(name);
        const cases: ReadonlyArray<readonly string[]> = [
          ["submit", "--repo", "/no/such/path", "--risk", "low", "--objective", "x"],
          ["submit", "--objective", "", "--repo", "/tmp", "--risk", "low"],
          ["get"],
          ["list", "--limit", "abc"],
          ["wibble"],
        ];
        for (const args of cases) {
          const { code, envelope } = await a.invoke(args, env);
          assert.strictEqual(code, 1, `expected exit 1 for args ${args.join(" ")}, got ${code}`);
          const envObj = envelope as Record<string, unknown>;
          assert.strictEqual(envObj.ok, false);
          const problem = envObj.problem;
          assert.ok(
            (PROBLEMS as readonly string[]).includes(problem as string),
            `unknown problem: ${String(problem)}`,
          );
        }
      });

      it("submit then get returns matching fields", async () => {
        const env = await freshHome();
        const repo = await seedRepo();
        const a = adapter(name);
        const sub = await a.invoke(
          ["submit", "--objective", "round trip", "--repo", repo, "--risk", "low"],
          env,
        );
        assert.strictEqual(sub.code, 0);
        const jobId = (sub.envelope as Record<string, unknown>).jobId as string;
        const got = await a.invoke(["get", jobId], env);
        assert.strictEqual(got.code, 0);
        const view = got.envelope as Record<string, unknown>;
        assert.strictEqual(view.objective, "round trip");
        assert.strictEqual(view.risk, "low");
        assert.strictEqual(view.status, "admitted");
        assert.deepStrictEqual(view.next, ["get", "wait", "cancel"]);
      });

      it("get with a malformed id returns invalid-input, never a filesystem access", async () => {
        const env = await freshHome();
        const a = adapter(name);
        const { code, envelope } = await a.invoke(["get", "../etc/passwd"], env);
        assert.strictEqual(code, 1);
        const envObj = envelope as Record<string, unknown>;
        assert.strictEqual(envObj.problem, "invalid-input");
      });

      it("list returns a page whose shape is identical across adapters", async () => {
        const env = await freshHome();
        const repo = await seedRepo();
        const a = adapter(name);
        await a.invoke(
          ["submit", "--objective", "list me", "--repo", repo, "--risk", "low"],
          env,
        );
        const { code, envelope } = await a.invoke(["list"], env);
        assert.strictEqual(code, 0);
        const page = envelope as Record<string, unknown>;
        assert.strictEqual(page.ok, true);
        assert.ok(Array.isArray(page.jobs));
        assert.strictEqual(typeof page.nextCursor, "object"); // null is an object in JS
        assert.strictEqual(typeof page.size, "object");
        const size = page.size as Record<string, unknown>;
        assert.strictEqual(typeof size.bytes, "number");
        assert.strictEqual(typeof size.softLimitBytes, "number");
        assert.strictEqual(typeof size.overBudget, "boolean");
      });

      // F3: the documented argument order must work — verb first, --json anywhere.
      it("F3: verb first with --json last produces the same envelope as --json before verb", async () => {
        const env1 = await freshHome();
        const env2 = await freshHome();
        const repo1 = await seedRepo();
        const repo2 = await seedRepo();
        // Verb first, --json last (documented form).
        const r1 = await runBinary(
          ["submit", "--objective", "order-test", "--repo", repo1, "--risk", "low", "--json"],
          env1,
        );
        // --json before verb (legacy form).
        const r2 = await runBinary(
          ["--json", "submit", "--objective", "order-test", "--repo", repo2, "--risk", "low"],
          env2,
        );
        assert.strictEqual(r1.code, 0, "verb-first form should succeed");
        assert.strictEqual(r2.code, 0, "--json-first form should succeed");
        const e1 = JSON.parse(r1.stdout) as Record<string, unknown>;
        const e2 = JSON.parse(r2.stdout) as Record<string, unknown>;
        assert.strictEqual(e1.ok, true);
        assert.strictEqual(e2.ok, true);
        assert.strictEqual(e1.status, e2.status);
        assert.strictEqual(e1.revision, e2.revision);
        assert.deepStrictEqual(e1.next, e2.next);
      });

      it("F3: verb first with no --json produces the same envelope", async () => {
        const env = await freshHome();
        const repo = await seedRepo();
        const r = await runBinary(
          ["submit", "--objective", "no-json-flag", "--repo", repo, "--risk", "low"],
          env,
        );
        assert.strictEqual(r.code, 0, "bare form should succeed");
        const e = JSON.parse(r.stdout) as Record<string, unknown>;
        assert.strictEqual(e.ok, true);
        assert.strictEqual(e.status, "admitted");
      });

      it("F3: list works with verb first and --json last", async () => {
        const env = await freshHome();
        const r = await runBinary(["list", "--json"], env);
        assert.strictEqual(r.code, 0);
        const page = JSON.parse(r.stdout) as Record<string, unknown>;
        assert.strictEqual(page.ok, true);
      });

      // State machine verb conformance.
      it("cancel returns a cancelled envelope with the correct next list", async () => {
        const env = await freshHome();
        env.PI_FLEET_PI_DELAY_MS = "10000";
        const repo = await seedRepo();
        const a = adapter(name);
        const sub = await a.invoke(
          ["submit", "--objective", "cancel conformance", "--repo", repo, "--risk", "low"],
          env,
        );
        assert.strictEqual(sub.code, 0);
        const jobId = (sub.envelope as Record<string, unknown>).jobId as string;
        const { code, envelope } = await cancelCurrent(a, env, jobId);
        assert.strictEqual(code, 0);
        const envObj = envelope as Record<string, unknown>;
        assert.strictEqual(envObj.ok, true);
        assert.strictEqual(envObj.status, "cancelled");
        assert.ok(typeof envObj.revision === "number");
        assert.deepStrictEqual(envObj.next, ["get", "report", "clean", "archive"]);
      });

      it("cancel problem envelopes use only the closed problem set", async () => {
        const env = await freshHome();
        const a = adapter(name);
        const cases: ReadonlyArray<readonly string[]> = [
          ["cancel", "--expected-revision", "1"], // missing --job-id
          ["cancel", "--job-id", "not-a-ulid", "--expected-revision", "1"],
          ["cancel", "--job-id", "01JQQ000000000000000000000", "--expected-revision", "abc"],
        ];
        for (const args of cases) {
          const { code, envelope } = await a.invoke(args, env);
          assert.strictEqual(code, 1, `expected exit 1 for ${args.join(" ")}`);
          const envObj = envelope as Record<string, unknown>;
          assert.strictEqual(envObj.ok, false);
          assert.ok(
            (PROBLEMS as readonly string[]).includes(envObj.problem as string),
            `unknown problem: ${String(envObj.problem)}`,
          );
        }
      });

      it("archive returns an archived envelope with the correct next list", async () => {
        const env = await freshHome();
        env.PI_FLEET_PI_DELAY_MS = "10000";
        const repo = await seedRepo();
        const a = adapter(name);
        const sub = await a.invoke(
          ["submit", "--objective", "archive conformance", "--repo", repo, "--risk", "low"],
          env,
        );
        assert.strictEqual(sub.code, 0);
        const jobId = (sub.envelope as Record<string, unknown>).jobId as string;
        // Cancel first.
        const cancelled = await cancelCurrent(a, env, jobId);
        // Archive.
        const { code, envelope } = await a.invoke(
          ["archive", "--job-id", jobId, "--expected-revision", String((cancelled.envelope as Record<string, unknown>).revision)],
          env,
        );
        assert.strictEqual(code, 0);
        const envObj = envelope as Record<string, unknown>;
        assert.strictEqual(envObj.ok, true);
        assert.strictEqual(envObj.status, "archived");
        assert.ok(typeof envObj.revision === "number");
        assert.deepStrictEqual(envObj.next, ["get", "report", "purge"]);
      });

      it("wait returns a timedOut envelope for a non-terminal job", async () => {
        const env = await freshHome();
        const repo = await seedRepo();
        const a = adapter(name);
        const sub = await a.invoke(
          ["submit", "--objective", "wait conformance", "--repo", repo, "--risk", "low"],
          env,
        );
        assert.strictEqual(sub.code, 0);
        const jobId = (sub.envelope as Record<string, unknown>).jobId as string;
        const { code, envelope } = await a.invoke(
          ["wait", "--job-id", jobId, "--timeout", "100"],
          env,
        );
        assert.strictEqual(code, 0);
        const envObj = envelope as Record<string, unknown>;
        assert.strictEqual(envObj.ok, true);
        assert.strictEqual(envObj.timedOut, true);
        assert.ok(["admitted", "running", "waiting"].includes(envObj.status as string));
      });

      it("wait on a cancelled job returns timedOut false", async () => {
        const env = await freshHome();
        env.PI_FLEET_PI_DELAY_MS = "10000";
        const repo = await seedRepo();
        const a = adapter(name);
        const sub = await a.invoke(
          ["submit", "--objective", "wait wake", "--repo", repo, "--risk", "low"],
          env,
        );
        assert.strictEqual(sub.code, 0);
        const jobId = (sub.envelope as Record<string, unknown>).jobId as string;
        await cancelCurrent(a, env, jobId);
        const { code, envelope } = await a.invoke(
          ["wait", "--job-id", jobId, "--timeout", "5000"],
          env,
        );
        assert.strictEqual(code, 0);
        const envObj = envelope as Record<string, unknown>;
        assert.strictEqual(envObj.ok, true);
        assert.strictEqual(envObj.timedOut, false);
        assert.strictEqual(envObj.status, "cancelled");
      });
    });
  }
});

/**
 * CLI argument handling that the module cannot express on its own: a value
 * that looks like a flag, and a malformed number the CLI used to coerce
 * before the module could judge it.
 */
describe("ticket 23 close-out: CLI argument handling", () => {
  function freshEnv(): { env: NodeJS.ProcessEnv; repo: string } {
    const home = mkdtempSync(join(tmpdir(), "fleet-r3-closeout-"));
    const repo = mkdtempSync(join(tmpdir(), "fleet-r3-closeout-repo-"));
    mkdirSync(join(repo, ".git"));
    return { env: { ...process.env, PI_FLEET_HOME: home }, repo };
  }

  it("C7: a flag value may begin with -- in every documented form", async () => {
    const { env, repo } = freshEnv();
    const objective = "--force the rebuild";
    for (const args of [
      ["submit", "--objective", objective, "--repo", repo, "--risk", "low", "--json"],
      ["submit", "--json", "--objective", objective, "--repo", repo, "--risk", "low"],
      ["submit", `--objective=${objective}`, "--repo", repo, "--risk", "low", "--json"],
    ]) {
      const run = await runBinary(args, env);
      const envelope = JSON.parse(run.stdout.trimEnd()) as Record<string, unknown>;
      assert.strictEqual(envelope.ok, true, `form failed: ${args.join(" ")} -> ${run.stdout}`);
      assert.strictEqual(run.code, 0);
    }
  });

  it("C7: a value that is exactly a known flag is still a value", async () => {
    const { env, repo } = freshEnv();
    const run = await runBinary(
      ["submit", "--objective", "--json", "--repo", repo, "--risk", "low"],
      env,
    );
    const envelope = JSON.parse(run.stdout.trimEnd()) as Record<string, unknown>;
    assert.strictEqual(envelope.ok, true, run.stdout);
  });

  it("C6: a malformed --limit is refused, never coerced", async () => {
    const { env } = freshEnv();
    for (const value of ["1.5", "10abc", "1e3", "0", "-3", " 5", ""]) {
      const run = await runBinary(["list", "--limit", value, "--json"], env);
      const envelope = JSON.parse(run.stdout.trimEnd()) as Record<string, unknown>;
      assert.strictEqual(envelope.ok, false, `expected ${JSON.stringify(value)} to be refused`);
      assert.strictEqual(envelope.problem, "invalid-input");
      assert.strictEqual(run.code, 1);
    }
    const good = await runBinary(["list", "--limit", "5", "--json"], env);
    assert.strictEqual((JSON.parse(good.stdout.trimEnd()) as Record<string, unknown>).ok, true);
  });
});

/**
 * CLI-level outcomes from the third review: a broken store is a dependency
 * failure, and a value flag is honoured wherever it appears.
 */
describe("ticket 23 third-review: CLI outcomes", () => {
  it("F6: an unparseable config reports unavailable-dependency, not policy-denied", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-r3-cfg-"));
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), "oops");
    const run = await runBinary(["list", "--json"], { ...process.env, PI_FLEET_HOME: home });
    const envelope = JSON.parse(run.stdout.trimEnd()) as Record<string, unknown>;
    assert.strictEqual(envelope.ok, false);
    assert.strictEqual(envelope.problem, "unavailable-dependency");
    assert.strictEqual(run.code, 1);
  });

  it("F7: a value flag before the verb is honoured, not silently dropped", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-r3-pre-"));
    const repo = mkdtempSync(join(tmpdir(), "fleet-r3-pre-repo-"));
    mkdirSync(join(repo, ".git"));
    const env = { ...process.env, PI_FLEET_HOME: home };
    const run = await runBinary(
      ["--risk", "low", "submit", "--objective", "flags before the verb", "--repo", repo, "--json"],
      env,
    );
    const envelope = JSON.parse(run.stdout.trimEnd()) as Record<string, unknown>;
    assert.strictEqual(envelope.ok, true, run.stdout);
    assert.strictEqual(run.code, 0);
  });
});
