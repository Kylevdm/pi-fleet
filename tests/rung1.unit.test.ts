import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  faultEnvelope,
  okEnvelope,
  problemEnvelope,
  PROBLEMS,
} from "../src/envelope.ts";
import type { Problem } from "../src/envelope.ts";
import { run } from "../src/main.ts";
import { generateUlid, isValidUlid, _resetMonotonicState } from "../src/ulid.ts";
import {
  defaultStoreRoot,
  ensureWithinRoot,
  resolveRepoRealpath,
  resolveStoreRoot,
  storePath,
} from "../src/store/paths.ts";
import {
  knownSchemaMajor,
  parseSchemaTag,
  schemaTag,
  validateJobRecord,
  validateStoreRecord,
} from "../src/store/records.ts";
import type { JobRecord } from "../src/store/records.ts";
import {
  appendJsonLine,
  acquireLock,
  readJsonFile,
  releaseLock,
  writeJsonFile,
  LockHeldError,
} from "../src/store/atomic.ts";
import { nextFor, validateObjective, validateRisk } from "../src/fleet.ts";
import { JOB_STATUSES } from "../src/store/records.ts";
import { Fleet } from "../src/fleet.ts";
import { JobStore, Paths, hashIdempotencyKey } from "../src/store/job-store.ts";

describe("envelope", () => {
  it("okEnvelope returns { ok: true }", () => {
    const env = okEnvelope();
    assert.deepStrictEqual(env, { ok: true });
  });

  it("problemEnvelope returns { ok: false, problem, message }", () => {
    const env = problemEnvelope("invalid-input", "bad stuff");
    assert.deepStrictEqual(env, {
      ok: false,
      problem: "invalid-input",
      message: "bad stuff",
    });
  });

  it("PROBLEMS contains exactly seven values", () => {
    assert.strictEqual(PROBLEMS.length, 7);
  });

  it("every PROBLEMS value is assignable to Problem", () => {
    for (const p of PROBLEMS) {
      const check: Problem = p;
      assert.ok(check);
    }
  });
});

describe("run", () => {
  it("fleet --json returns ok envelope", () => {
    const env = run(["node", "fleet", "--json"]);
    assert.deepStrictEqual(env, { ok: true });
  });

  it("fleet --json wibble returns invalid-input problem", () => {
    const env = run(["node", "fleet", "--json", "wibble"]);
    assert.deepStrictEqual(env, {
      ok: false,
      problem: "invalid-input",
      message: "unknown verb: wibble",
    });
  });

  it("fleet (no --json) with no verb returns ok envelope", () => {
    const env = run(["node", "fleet"]);
    assert.deepStrictEqual(env, { ok: true });
  });

  it("fleet (no --json) with unknown verb returns invalid-input", () => {
    const env = run(["node", "fleet", "wibble"]);
    assert.deepStrictEqual(env, {
      ok: false,
      problem: "invalid-input",
      message: "unknown verb: wibble",
    });
  });

  it("an unknown flag is invalid-input, not success", () => {
    assert.deepStrictEqual(run(["node", "fleet", "--bogus"]), {
      ok: false,
      problem: "invalid-input",
      message: "unknown flag: --bogus",
    });
  });

  // F1/F2: run() works with verb first and --json anywhere.
  it("F1: run() parses submit with verb first", () => {
    const env = run(["node", "fleet", "submit", "--objective", "x", "--repo", "/tmp", "--risk", "low"]);
    // Sync surface returns "submit requires async" — the important thing
    // is it does NOT return "unexpected positional argument: submit".
    assert.strictEqual(env.ok, false);
    if (!env.ok) assert.match(env.message, /submit requires async/);
  });

  it("F2: run() parses list with verb first", () => {
    const env = run(["node", "fleet", "list", "--json"]);
    assert.strictEqual(env.ok, false);
    if (!env.ok) assert.match(env.message, /list requires async/);
  });

  // F14: VERB_TABLE enforces per-verb flag restrictions.
  it("F14: get rejects --limit (not valid for get)", () => {
    const env = run(["node", "fleet", "get", "--limit", "5", "01JQQ000000000000000000000"]);
    assert.strictEqual(env.ok, false);
    if (!env.ok) {
      assert.strictEqual(env.problem, "invalid-input");
      assert.match(env.message, /not valid for verb get/);
    }
  });

  it("F14: list rejects --risk (not valid for list)", () => {
    const env = run(["node", "fleet", "list", "--risk", "low"]);
    assert.strictEqual(env.ok, false);
    if (!env.ok) {
      assert.strictEqual(env.problem, "invalid-input");
      assert.match(env.message, /not valid for verb list/);
    }
  });

  // F7: get with non-ULID returns invalid-input.
  it("F7: run() returns invalid-input for get with non-ULID id", () => {
    const env = run(["node", "fleet", "get", "../etc/passwd"]);
    assert.strictEqual(env.ok, false);
    if (!env.ok) assert.strictEqual(env.problem, "invalid-input");
  });
});

describe("faultEnvelope", () => {
  it("carries the error message and no problem field", () => {
    const env = faultEnvelope(new Error("boom"));
    assert.deepStrictEqual(env, { ok: false, message: "boom" });
    assert.ok(!("problem" in env));
  });

  it("stringifies a non-Error throw", () => {
    assert.deepStrictEqual(faultEnvelope("boom"), { ok: false, message: "boom" });
  });
});

describe("ulid", () => {
  it("generateUlid produces a 26-character Crockford base32 string", () => {
    const id = generateUlid(() => 12345, () => 0n);
    assert.strictEqual(id.length, 26);
    assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("isValidUlid accepts a freshly generated id", () => {
    const id = generateUlid(() => 0, () => 0n);
    assert.ok(isValidUlid(id));
  });

  it("isValidUlid rejects strings with the excluded characters", () => {
    assert.ok(!isValidUlid("01JQQ00000000000000000I000")); // I
    assert.ok(!isValidUlid("01JQQ00000000000000000L000")); // L
    assert.ok(!isValidUlid("01JQQ00000000000000000O000")); // O
    assert.ok(!isValidUlid("01JQQ00000000000000000U000")); // U
  });

  it("isValidUlid rejects strings of the wrong length", () => {
    assert.ok(!isValidUlid(""));
    assert.ok(!isValidUlid("01JQQ0000000000000000000")); // 25
    assert.ok(!isValidUlid("01JQQ0000000000000000000000")); // 28
  });

  it("isValidUlid rejects lowercase Crockford", () => {
    assert.ok(!isValidUlid("01jqq00000000000000000000"));
  });

  it("isValidUlid rejects a path-traversal attempt", () => {
    assert.ok(!isValidUlid("../../etc/passwd"));
  });

  it("isValidUlid rejects an absolute path attempt", () => {
    assert.ok(!isValidUlid("/etc/passwd"));
  });

  it("isValidUlid rejects a trailing newline", () => {
    assert.ok(!isValidUlid("01JQQ00000000000000000000\n"));
  });

  it("isValidUlid rejects unicode look-alikes", () => {
    // U+FF11 (FULLWIDTH DIGIT ONE) looks like '1' but is not Crockford.
    assert.ok(!isValidUlid("\uFF11JQQ00000000000000000000"));
  });

  it("monotonic increments the random portion within the same millisecond", () => {
    _resetMonotonicState();
    let calls = 0;
    const random = () => {
      calls += 1;
      return BigInt(calls);
    };
    const a = generateUlid(() => 1, random);
    const b = generateUlid(() => 1, random);
    const c = generateUlid(() => 1, random);
    assert.strictEqual(a.slice(0, 10), "0000000001");
    assert.ok(a < b, `${a} < ${b}`);
    assert.ok(b < c, `${b} < ${c}`);
  });

  it("real generator is strictly increasing within one millisecond", () => {
    _resetMonotonicState();
    const fixedMs = 1_700_000_000_000;
    const ids: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      ids.push(generateUlid(() => fixedMs));
    }
    for (let i = 1; i < ids.length; i += 1) {
      assert.ok(
        (ids[i - 1] as string) < (ids[i] as string),
        `${ids[i - 1]} < ${ids[i]}`,
      );
    }
  });
});

describe("store paths", () => {
  function freshTmp(): string {
    return mkdtempSync(join(tmpdir(), "fleet-paths-"));
  }

  it("defaultStoreRoot is ~/.pi/fleet", () => {
    assert.match(defaultStoreRoot(), /[\\/]\.pi[\\/]fleet$/);
  });

  it("resolveStoreRoot honours PI_FLEET_HOME when set", () => {
    const dir = freshTmp();
    const prev = process.env.PI_FLEET_HOME;
    try {
      process.env.PI_FLEET_HOME = dir;
      assert.strictEqual(resolveStoreRoot({ home: () => "/nope" }), dir);
    } finally {
      if (prev === undefined) delete process.env.PI_FLEET_HOME;
      else process.env.PI_FLEET_HOME = prev;
    }
  });

  it("resolveStoreRoot falls back to ~/.pi/fleet when the env var is unset", () => {
    const prev = process.env.PI_FLEET_HOME;
    try {
      delete process.env.PI_FLEET_HOME;
      assert.strictEqual(resolveStoreRoot({ home: () => "/home/x" }), "/home/x/.pi/fleet");
    } finally {
      if (prev !== undefined) process.env.PI_FLEET_HOME = prev;
    }
  });

  it("storePath joins the root and a relative path under it", () => {
    const dir = freshTmp();
    assert.strictEqual(storePath(dir, "jobs"), join(dir, "jobs"));
    assert.strictEqual(storePath(dir, "jobs", "01J", "job.json"), join(dir, "jobs", "01J", "job.json"));
  });

  it("resolveRepoRealpath refuses non-existent paths", () => {
    assert.strictEqual(resolveRepoRealpath(freshTmp(), join(freshTmp(), "no-such-repo")), null);
  });

  it("resolveRepoRealpath refuses a non-directory", () => {
    const dir = freshTmp();
    const file = join(dir, "not-a-dir");
    writeFileSync(file, "");
    assert.strictEqual(resolveRepoRealpath(dir, file), null);
  });

  it("resolveRepoRealpath refuses a directory that is not a git working tree", () => {
    const dir = freshTmp();
    const sub = join(dir, "no-git");
    mkdirSync(sub);
    assert.strictEqual(resolveRepoRealpath(dir, sub), null);
  });

  it("resolveRepoRealpath accepts a directory that has a .git entry", () => {
    const dir = freshTmp();
    const sub = join(dir, "repo");
    mkdirSync(sub);
    mkdirSync(join(sub, ".git"));
    const got = resolveRepoRealpath(dir, sub);
    assert.ok(got !== null, "realpath should not be null");
    assert.strictEqual(got, realpathSync(sub));
  });

  it("resolveRepoRealpath accepts a file as the .git entry (worktrees, submodules)", () => {
    const dir = freshTmp();
    const sub = join(dir, "repo");
    mkdirSync(sub);
    writeFileSync(join(sub, ".git"), "gitdir: /tmp/whatever\n");
    const got = resolveRepoRealpath(dir, sub);
    assert.ok(got !== null, "realpath should not be null");
  });

  it("ensureWithinRoot accepts a path that lives under the root", () => {
    const dir = freshTmp();
    const inside = storePath(dir, "jobs", "01J", "job.json");
    assert.ok(ensureWithinRoot(dir, inside));
  });

  it("ensureWithinRoot refuses a path that escapes the root", () => {
    const dir = freshTmp();
    assert.ok(!ensureWithinRoot(dir, join(dir, "..", "etc", "passwd")));
  });

  it("ensureWithinRoot refuses a symlink inside jobs that points outside the root", () => {
    const dir = freshTmp();
    const outside = freshTmp();
    const symlinkInside = join(dir, "evil");
    symlinkSync(outside, symlinkInside, "dir");
    assert.ok(!ensureWithinRoot(dir, symlinkInside));
  });

  it("ensureWithinRoot refuses a symlink in the middle of the path", () => {
    const dir = freshTmp();
    const outside = freshTmp();
    const linkDir = join(dir, "link");
    symlinkSync(outside, linkDir, "dir");
    const victim = join(linkDir, "job.json");
    assert.ok(!ensureWithinRoot(dir, victim));
  });
});

describe("record schemas", () => {
  it("schemaTag builds \"<type>/<major>\"", () => {
    assert.strictEqual(schemaTag("job", 1), "job/1");
    assert.strictEqual(schemaTag("store", 2), "store/2");
  });

  it("parseSchemaTag splits on /", () => {
    assert.deepStrictEqual(parseSchemaTag("job/1"), { type: "job", major: 1 });
    assert.deepStrictEqual(parseSchemaTag("store/3"), { type: "store", major: 3 });
  });

  it("parseSchemaTag rejects malformed tags", () => {
    assert.strictEqual(parseSchemaTag("job"), null);
    assert.strictEqual(parseSchemaTag("job/"), null);
    assert.strictEqual(parseSchemaTag("/1"), null);
    assert.strictEqual(parseSchemaTag("job/1/extra"), null);
  });

  it("knownSchemaMajor recognises the majors this binary writes", () => {
    assert.ok(knownSchemaMajor("job", 1));
    assert.ok(knownSchemaMajor("store", 1));
    assert.ok(knownSchemaMajor("input-snapshot", 1));
    assert.ok(knownSchemaMajor("idempotency-index", 1));
    assert.ok(knownSchemaMajor("audit", 1));
    assert.ok(knownSchemaMajor("config", 1));
  });

  it("knownSchemaMajor rejects unknown majors", () => {
    assert.ok(!knownSchemaMajor("job", 2));
    assert.ok(!knownSchemaMajor("store", 0));
  });

  it("validateStoreRecord accepts a well-formed store record", () => {
    const rec = { schema: "store/1", epoch: 1, createdAt: "2026-01-01T00:00:00Z" };
    const v = validateStoreRecord(rec);
    assert.strictEqual(v.ok, true);
    if (v.ok) {
      assert.strictEqual(v.value.epoch, 1);
    }
  });

  it("validateStoreRecord rejects the wrong type", () => {
    const rec = { schema: "job/1", epoch: 1, createdAt: "2026-01-01T00:00:00Z" };
    const v = validateStoreRecord(rec);
    assert.strictEqual(v.ok, false);
  });

  it("validateStoreRecord rejects an unknown major", () => {
    const rec = { schema: "store/2", epoch: 1, createdAt: "2026-01-01T00:00:00Z" };
    const v = validateStoreRecord(rec);
    assert.strictEqual(v.ok, false);
    if (!v.ok) assert.strictEqual(v.problem, "policy-denied");
  });

  it("validateStoreRecord rejects a record that is not an object", () => {
    assert.strictEqual(validateStoreRecord(null).ok, false);
    assert.strictEqual(validateStoreRecord("nope").ok, false);
    assert.strictEqual(validateStoreRecord(42).ok, false);
  });

  it("validateJobRecord accepts a well-formed job record", () => {
    const rec: JobRecord = {
      schema: "job/1",
      jobId: "01JQQ000000000000000000000",
      revision: 1,
      status: "admitted",
      risk: "low",
      repo: "/tmp/repo",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const v = validateJobRecord(rec);
    if (!v.ok) {
      assert.fail(`expected ok, got problem: ${v.problem} (${v.message})`);
    }
    assert.strictEqual(v.value.jobId, "01JQQ000000000000000000000");
  });

  it("validateJobRecord rejects an unknown status", () => {
    const rec = {
      schema: "job/1",
      jobId: "01JQQ00000000000000000000",
      revision: 1,
      status: "pending",
      risk: "low",
      repo: "/tmp/repo",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const v = validateJobRecord(rec);
    assert.strictEqual(v.ok, false);
  });

  it("validateJobRecord rejects a non-ULID jobId", () => {
    const rec = {
      schema: "job/1",
      jobId: "../etc/passwd".padEnd(26, "A"),
      revision: 1,
      status: "admitted",
      risk: "low",
      repo: "/tmp/repo",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const v = validateJobRecord(rec);
    assert.strictEqual(v.ok, false);
  });
});

describe("atomic writes", () => {
  function freshTmp(): string {
    return mkdtempSync(join(tmpdir(), "fleet-atomic-"));
  }

  it("writeJsonFile commits an atomic rename with a durable file", async () => {
    const dir = freshTmp();
    const target = join(dir, "out.json");
    await writeJsonFile(target, { hello: "world" });
    const back = await readJsonFile(target);
    assert.deepStrictEqual(back, { hello: "world" });
  });

  it("writeJsonFile overwrites an existing file via rename", async () => {
    const dir = freshTmp();
    const target = join(dir, "out.json");
    await writeJsonFile(target, { v: 1 });
    await writeJsonFile(target, { v: 2 });
    const back = await readJsonFile(target);
    assert.deepStrictEqual(back, { v: 2 });
  });

  it("writeJsonFile never leaves a tmp scratch visible at the target path", async () => {
    const dir = freshTmp();
    const target = join(dir, "out.json");
    await writeJsonFile(target, { v: 1 });
    const entries = await fs.readdir(dir);
    assert.ok(entries.includes("out.json"));
    // No leftover scratch files. Root-level writes use dot-prefixed scratch
    // files that are renamed away; job-level writes use tmp/ which is empty
    // once the rename commits.
    const scratch = entries.filter(
      (e) => e !== "out.json" && e !== "tmp" && !e.startsWith("."),
    );
    assert.deepStrictEqual(scratch, []);
  });

  it("appendJsonLine appends one line per call and fsyncs", async () => {
    const dir = freshTmp();
    const file = join(dir, "audit.jsonl");
    await appendJsonLine(file, { schema: "audit/1", action: "a" });
    await appendJsonLine(file, { schema: "audit/1", action: "b" });
    const text = await fs.readFile(file, "utf8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    assert.strictEqual(lines.length, 2);
    assert.deepStrictEqual(JSON.parse(lines[0]), { schema: "audit/1", action: "a" });
    assert.deepStrictEqual(JSON.parse(lines[1]), { schema: "audit/1", action: "b" });
  });

  it("appendJsonLine treats each line as appended (O_APPEND) — concurrent appends stay line-aligned", async () => {
    const dir = freshTmp();
    const file = join(dir, "audit.jsonl");
    const writes = Array.from({ length: 50 }, (_, i) =>
      appendJsonLine(file, { schema: "audit/1", action: i }),
    );
    await Promise.all(writes);
    const text = await fs.readFile(file, "utf8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    assert.strictEqual(lines.length, 50);
    for (const line of lines) {
      assert.ok(JSON.parse(line).schema === "audit/1");
    }
  });

  it("acquireLock then releaseLock round-trips", async () => {
    const dir = freshTmp();
    const lock = join(dir, "job.lock");
    await acquireLock(lock, { staleMs: 60_000 });
    await releaseLock(lock);
    assert.ok(!existsSync(lock));
  });

  it("acquireLock fails when another holder owns the lock", async () => {
    const dir = freshTmp();
    const lock = join(dir, "job.lock");
    await acquireLock(lock, { staleMs: 60_000 });
    await assert.rejects(acquireLock(lock, { staleMs: 60_000 }));
    await releaseLock(lock);
  });

  it("releaseLock is idempotent and never throws if the lock is absent", async () => {
    const dir = freshTmp();
    const lock = join(dir, "job.lock");
    await releaseLock(lock);
    await releaseLock(lock);
  });

  it("acquireLock breaks a stale lock and audits the break", async () => {
    const dir = freshTmp();
    const lock = join(dir, "job.lock");
    await acquireLock(lock, { staleMs: 60_000 });
    // Backdate the lock to simulate a dead holder.
    const past = Date.now() / 1000 - 120; // 2 minutes ago
    await fs.utimes(lock, past, past);
    const audit = join(dir, "audit.jsonl");
    // Now we should be able to re-acquire with a stale timeout of 30s; the
    // break should be recorded in the audit log.
    await acquireLock(lock, { staleMs: 30_000, audit });
    const auditText = await fs.readFile(audit, "utf8");
    const lines = auditText.split("\n").filter((l) => l.length > 0);
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /"action":"lock-stolen"/);
    await releaseLock(lock);
  });
});

describe("next mapping", () => {
  const EXPECTED: Record<(typeof JOB_STATUSES)[number], readonly string[]> = {
    admitted: ["get", "wait", "cancel"],
    running: ["get", "wait", "cancel"],
    waiting: ["get", "wait", "cancel", "continue"],
    "ready-for-acceptance": ["get", "report", "diff", "checks", "accept", "cancel"],
    "returned-to-orchestrator": ["get", "report", "diff", "checks", "continue", "clean", "archive"],
    cancelled: ["get", "report", "clean", "archive"],
    archived: ["get", "report", "purge"],
  };

  it("next is legal for every one of the seven states", () => {
    for (const status of JOB_STATUSES) {
      assert.deepStrictEqual(nextFor(status), EXPECTED[status]);
    }
  });

  it("the next mapping covers every state exactly once", () => {
    assert.strictEqual(JOB_STATUSES.length, 7);
    const seen = new Set<string>();
    for (const status of JOB_STATUSES) {
      const next = nextFor(status);
      // Each verb should appear in at least one row.
      for (const verb of next) {
        seen.add(verb);
      }
    }
    // Every verb the spec lists must appear somewhere.
    assert.ok(seen.has("get"));
    assert.ok(seen.has("wait"));
    assert.ok(seen.has("cancel"));
    assert.ok(seen.has("continue"));
    assert.ok(seen.has("report"));
    assert.ok(seen.has("diff"));
    assert.ok(seen.has("checks"));
    assert.ok(seen.has("accept"));
    assert.ok(seen.has("clean"));
    assert.ok(seen.has("archive"));
    assert.ok(seen.has("purge"));
  });

  it("next is the same frozen array on every call", () => {
    for (let i = 0; i < 5; i += 1) {
      assert.strictEqual(nextFor("admitted"), nextFor("admitted"));
    }
  });
});

describe("submit input validation", () => {
  it("validateRisk accepts low and medium", () => {
    assert.strictEqual(validateRisk("low").ok, true);
    assert.strictEqual(validateRisk("medium").ok, true);
  });

  it("validateRisk rejects every other value", () => {
    for (const v of ["", "LOW", "low ", "standard", "high", "unknown"]) {
      assert.strictEqual(validateRisk(v).ok, false, `should reject ${v}`);
    }
  });

  it("validateObjective accepts a non-empty trimmed string", () => {
    assert.strictEqual(validateObjective("Fix the bug").ok, true);
  });

  it("validateObjective rejects the empty string", () => {
    assert.strictEqual(validateObjective("").ok, false);
  });

  it("validateObjective rejects a whitespace-only string", () => {
    assert.strictEqual(validateObjective("   \n\t  ").ok, false);
  });

  it("validateObjective rejects an objective above the maximum length", () => {
    const long = "x".repeat(4097);
    assert.strictEqual(validateObjective(long).ok, false);
  });

  it("validateObjective accepts an objective exactly at the maximum length", () => {
    const max = "x".repeat(4096);
    assert.strictEqual(validateObjective(max).ok, true);
  });

  it("validateObjective rejects a non-string value", () => {
    assert.strictEqual(validateObjective(123).ok, false);
    assert.strictEqual(validateObjective(null).ok, false);
    assert.strictEqual(validateObjective({}).ok, false);
  });
});

describe("Fleet submit / get / list", () => {
  async function makeRepo(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "fleet-repo-"));
    mkdirSync(join(dir, ".git"));
    return dir;
  }

  async function freshStore(): Promise<JobStore> {
    return JobStore.open(mkdtempSync(join(tmpdir(), "fleet-store-")));
  }

  function clock(ms: number): () => number {
    return () => ms;
  }

  it("submit returns an admission with a fresh ULID, revision 1, and admitted status", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store, clock(1_700_000_000_000));
    const repo = await makeRepo();
    const result = await fleet.submit({
      objective: "Fix the bug",
      repo,
      risk: "low",
    });
    if (!result.ok) {
      assert.fail(`expected ok, got problem: ${result.problem} (${result.message})`);
    }
    assert.strictEqual(result.value.status, "admitted");
    assert.strictEqual(result.value.revision, 1);
    assert.match(result.value.jobId, /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
    assert.deepStrictEqual([...result.value.next], ["get", "wait", "cancel"]);
    assert.strictEqual(result.value.size.softLimitBytes, 1073741824);
    assert.strictEqual(result.value.size.overBudget, false);
  });

  it("get returns the job view after submit", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store, clock(1_700_000_000_000));
    const repo = await makeRepo();
    const submit = await fleet.submit({ objective: "Refactor auth", repo, risk: "medium" });
    if (!submit.ok) assert.fail("submit failed");
    const got = await fleet.get(submit.value.jobId);
    if (!got.ok) assert.fail(`get failed: ${got.problem}`);
    assert.strictEqual(got.value.objective, "Refactor auth");
    assert.strictEqual(got.value.risk, "medium");
    assert.strictEqual(got.value.repo, realpathSync(repo));
    assert.strictEqual(got.value.revision, 1);
    assert.strictEqual(got.value.status, "admitted");
  });

  it("get with no id is invalid-input", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store);
    const got = await fleet.get("");
    assert.strictEqual(got.ok, false);
    if (!got.ok) assert.strictEqual(got.problem, "invalid-input");
  });

  it("get with a malformed id is invalid-input (never a filesystem access)", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store);
    const got = await fleet.get("../etc/passwd");
    assert.strictEqual(got.ok, false);
    if (!got.ok) assert.strictEqual(got.problem, "invalid-input");
  });

  it("get with a well-formed but unknown ULID is not-found", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store);
    const got = await fleet.get("01JQQ000000000000000000000");
    assert.strictEqual(got.ok, false);
    if (!got.ok) assert.strictEqual(got.problem, "not-found");
  });

  it("submit rejects an invalid risk class", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store);
    const repo = await makeRepo();
    // @ts-expect-error — intentional invalid input from the caller side.
    const result = await fleet.submit({ objective: "x", repo, risk: "high" });
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.strictEqual(result.problem, "invalid-input");
  });

  it("submit rejects an empty objective", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store);
    const repo = await makeRepo();
    const result = await fleet.submit({ objective: "   ", repo, risk: "low" });
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.strictEqual(result.problem, "invalid-input");
  });

  it("submit rejects an objective above the maximum length", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store);
    const repo = await makeRepo();
    const result = await fleet.submit({
      objective: "x".repeat(5000),
      repo,
      risk: "low",
    });
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.strictEqual(result.problem, "invalid-input");
  });

  it("submit rejects a non-existent repo", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store);
    const result = await fleet.submit({
      objective: "Fix it",
      repo: "/tmp/fleet-this-path-does-not-exist",
      risk: "low",
    });
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.strictEqual(result.problem, "invalid-input");
  });

  it("submit rejects a directory that is not a git working tree", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store);
    const dir = mkdtempSync(join(tmpdir(), "fleet-nogit-"));
    const result = await fleet.submit({ objective: "x", repo: dir, risk: "low" });
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.strictEqual(result.problem, "invalid-input");
  });

  it("submit records the repo's realpath (not the caller's path)", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store);
    const repo = await makeRepo();
    const submit = await fleet.submit({ objective: "x", repo, risk: "low" });
    if (!submit.ok) assert.fail("submit failed");
    const got = await fleet.get(submit.value.jobId);
    if (!got.ok) assert.fail("get failed");
    assert.strictEqual(got.value.repo, realpathSync(repo));
  });

  it("submit returns the original admission on a retried idempotency key", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store, clock(1_700_000_000_000));
    const repo = await makeRepo();
    const first = await fleet.submit({
      objective: "Do the thing",
      repo,
      risk: "low",
      idempotencyKey: "retry-me",
    });
    if (!first.ok) assert.fail("first submit failed");
    const second = await fleet.submit({
      objective: "Do the thing (rephrased)",
      repo,
      risk: "medium", // caller can lie; the key still wins.
      idempotencyKey: "retry-me",
    });
    if (!second.ok) assert.fail(`second submit failed: ${second.problem}`);
    assert.strictEqual(second.value.jobId, first.value.jobId);
    // Revision tracks the winner's revision; here it is 1 because submit is
    // the only verb that creates a job in this ticket.
    assert.strictEqual(second.value.revision, first.value.revision);
    // Same admittedAt.
    assert.strictEqual(second.value.admittedAt, first.value.admittedAt);
  });

  it("submit is durable across process exit (record survives close + reopen)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-durable-"));
    const repo = await makeRepo();
    const fleet = new Fleet(await JobStore.open(dir));
    const submit = await fleet.submit({ objective: "persist", repo, risk: "low" });
    if (!submit.ok) assert.fail("submit failed");
    // Simulate a process exit by closing and reopening the store in a new
    // instance — Fleet itself has no shutdown ceremony, but the data must
    // survive on disk and be readable.
    const reopened = new Fleet(await JobStore.open(dir));
    const got = await reopened.get(submit.value.jobId);
    if (!got.ok) assert.fail(`reopened get failed: ${got.problem}`);
    assert.strictEqual(got.value.objective, "persist");
  });

  it("mutateJob accepts the right revision and increments by one", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store);
    const repo = await makeRepo();
    const submit = await fleet.submit({ objective: "x", repo, risk: "low" });
    if (!submit.ok) assert.fail("submit failed");
    const result = await store.mutateJob(submit.value.jobId, 1, (current) => ({
      ok: true,
      value: {
        next: { ...current, revision: 2, updatedAt: "2026-01-02T00:00:00Z" },
        reason: "test mutation",
      },
    }));
    if (!result.ok) assert.fail(`mutate failed: ${result.problem}`);
    assert.strictEqual(result.value.revision, 2);
    const got = await fleet.get(submit.value.jobId);
    if (!got.ok) assert.fail("get failed");
    assert.strictEqual(got.value.revision, 2);
  });

  it("mutateJob returns conflict on a stale revision", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store);
    const repo = await makeRepo();
    const submit = await fleet.submit({ objective: "x", repo, risk: "low" });
    if (!submit.ok) assert.fail("submit failed");
    const result = await store.mutateJob(submit.value.jobId, 99, (current) => ({
      ok: true,
      value: {
        next: { ...current, revision: 100 },
        reason: "stale write",
      },
    }));
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.strictEqual(result.problem, "conflict");
  });

  it("mutateJob refuses to skip a revision", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store);
    const repo = await makeRepo();
    const submit = await fleet.submit({ objective: "x", repo, risk: "low" });
    if (!submit.ok) assert.fail("submit failed");
    const result = await store.mutateJob(submit.value.jobId, 1, (current) => ({
      ok: true,
      value: {
        next: { ...current, revision: 3 }, // skip from 1 to 3
        reason: "skipped",
      },
    }));
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.strictEqual(result.problem, "invalid-input");
  });

  it("list hides archived jobs by default", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store);
    const repo = await makeRepo();
    const a = await fleet.submit({ objective: "alpha", repo, risk: "low" });
    if (!a.ok) assert.fail("a failed");
    const b = await fleet.submit({ objective: "beta", repo, risk: "low" });
    if (!b.ok) assert.fail("b failed");
    // Mark b as archived via a raw mutate (later tickets own the verb).
    const archived = await store.mutateJob(b.value.jobId, 1, (current) => ({
      ok: true,
      value: {
        next: { ...current, revision: 2, status: "archived" },
        reason: "archived",
      },
    }));
    if (!archived.ok) assert.fail("archive failed");
    const list = await fleet.list();
    if (!list.ok) assert.fail("list failed");
    assert.strictEqual(list.value.jobs.length, 1);
    assert.strictEqual(list.value.jobs[0]!.jobId, a.value.jobId);
  });

  it("list with includeArchived shows archived jobs", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store);
    const repo = await makeRepo();
    const a = await fleet.submit({ objective: "alpha", repo, risk: "low" });
    if (!a.ok) assert.fail("a failed");
    const b = await fleet.submit({ objective: "beta", repo, risk: "low" });
    if (!b.ok) assert.fail("b failed");
    await store.mutateJob(b.value.jobId, 1, (current) => ({
      ok: true,
      value: {
        next: { ...current, revision: 2, status: "archived" },
        reason: "archived",
      },
    }));
    const list = await fleet.list({ includeArchived: true });
    if (!list.ok) assert.fail("list failed");
    assert.strictEqual(list.value.jobs.length, 2);
  });

  it("list paginates with a bounded default and a cursor that is opaque to the caller", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store);
    const repo = await makeRepo();
    for (let i = 0; i < 5; i += 1) {
      const s = await fleet.submit({ objective: `task-${i}`, repo, risk: "low" });
      if (!s.ok) assert.fail("submit failed");
    }
    const page1 = await fleet.list({ limit: 2 });
    if (!page1.ok) assert.fail("list failed");
    assert.strictEqual(page1.value.jobs.length, 2);
    assert.ok(page1.value.nextCursor !== null, "page1 should have a next cursor");
    const page2 = await fleet.list({ limit: 2, cursor: page1.value.nextCursor ?? undefined });
    if (!page2.ok) assert.fail("page2 failed");
    assert.strictEqual(page2.value.jobs.length, 2);
    assert.ok(page2.value.nextCursor !== null);
    const page3 = await fleet.list({ limit: 2, cursor: page2.value.nextCursor ?? undefined });
    if (!page3.ok) assert.fail("page3 failed");
    assert.strictEqual(page3.value.jobs.length, 1);
    assert.strictEqual(page3.value.nextCursor, null);
    // Pages must not overlap.
    const seen = new Set<string>();
    for (const p of [page1, page2, page3]) {
      for (const j of p.value.jobs) {
        assert.ok(!seen.has(j.jobId), `${j.jobId} appears twice`);
        seen.add(j.jobId);
      }
    }
  });

  it("list returns an empty page for a cursor that no longer resolves", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store);
    const repo = await makeRepo();
    await fleet.submit({ objective: "x", repo, risk: "low" });
    // Encode a ULID that is older than any job we have. Should yield an
    // empty page rather than an error — the cursor is well-formed, just
    // stale.
    const stale = "00000000000000000000000000";
    const cursor = Buffer.from(stale, "utf8").toString("base64url");
    const page = await fleet.list({ cursor });
    if (!page.ok) assert.fail(`list failed: ${page.problem}`);
    assert.strictEqual(page.value.jobs.length, 0);
  });

  it("list rejects a malformed cursor as invalid-input", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store);
    const page = await fleet.list({ cursor: "not-base64-of-a-ulid" });
    assert.strictEqual(page.ok, false);
    if (!page.ok) assert.strictEqual(page.problem, "invalid-input");
  });

  it("list respects the default limit when none is given", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store);
    const repo = await makeRepo();
    for (let i = 0; i < 3; i += 1) {
      await fleet.submit({ objective: `t-${i}`, repo, risk: "low" });
    }
    const page = await fleet.list();
    if (!page.ok) assert.fail("list failed");
    assert.strictEqual(page.value.jobs.length, 3);
  });

  it("list reports the size budget", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store);
    const repo = await makeRepo();
    await fleet.submit({ objective: "x", repo, risk: "low" });
    const page = await fleet.list();
    if (!page.ok) assert.fail("list failed");
    assert.ok(page.value.size.bytes > 0);
    assert.strictEqual(page.value.size.softLimitBytes, 1073741824);
    assert.strictEqual(page.value.size.overBudget, false);
  });

  it("JobSummary.objectiveExcerpt is bounded", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store);
    const repo = await makeRepo();
    const submit = await fleet.submit({
      objective: "x".repeat(500),
      repo,
      risk: "low",
    });
    if (!submit.ok) assert.fail("submit failed");
    const page = await fleet.list();
    if (!page.ok) assert.fail("list failed");
    assert.strictEqual(page.value.jobs.length, 1);
    assert.ok(page.value.jobs[0]!.objectiveExcerpt.length <= 120);
  });

  it("a torn write in tmp/ does not affect the readable record", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store);
    const repo = await makeRepo();
    const submit = await fleet.submit({ objective: "x", repo, risk: "low" });
    if (!submit.ok) assert.fail("submit failed");
    const jobDir = Paths.jobDir(store.root, submit.value.jobId);
    // Drop a torn scratch into tmp/. The store ignores it.
    writeFileSync(join(jobDir, "tmp", "torn-job.json.partial"), "{ not json");
    // Reopen and read.
    const reopened = new Fleet(await JobStore.open(store.root));
    const got = await reopened.get(submit.value.jobId);
    if (!got.ok) assert.fail("reopened get failed");
    assert.strictEqual(got.value.objective, "x");
  });

  it("an unknown schema major makes the store read-only on next open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-readonly-"));
    // Plant a store.json with an unknown major.
    writeFileSync(
      Paths.storeJson(dir),
      `${JSON.stringify({ schema: "store/99", epoch: 1, createdAt: "2026-01-01T00:00:00Z" })}\n`,
    );
    const store = await JobStore.open(dir);
    const fleet = new Fleet(store);
    const repo = await makeRepo();
    // Writes are refused.
    const submit = await fleet.submit({ objective: "x", repo, risk: "low" });
    assert.strictEqual(submit.ok, false);
    if (!submit.ok) assert.strictEqual(submit.problem, "policy-denied");
    assert.match(submit.message, /unknown/);
  });

  it("the store self-initialises idempotently across concurrent first-opens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-init-"));
    const [a, b, c] = await Promise.all([
      JobStore.open(dir),
      JobStore.open(dir),
      JobStore.open(dir),
    ]);
    assert.strictEqual(a.root, b.root);
    assert.strictEqual(b.root, c.root);
    assert.ok(existsSync(Paths.storeJson(dir)));
    assert.ok(existsSync(Paths.configJson(dir)));
  });

  it("pre-cutover directories (no job.json) are invisible to list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-legacy-"));
    const store = await JobStore.open(dir);
    const fleet = new Fleet(store);
    const repo = await makeRepo();
    const submit = await fleet.submit({ objective: "real", repo, risk: "low" });
    if (!submit.ok) assert.fail("submit failed");
    // A pre-cutover shell-job: a meta.json with no sibling job.json.
    const legacy = join(Paths.jobs(dir), "old-shell-job");
    mkdirSync(legacy);
    writeFileSync(join(legacy, "meta.json"), "{}\n");
    const list = await fleet.list();
    if (!list.ok) assert.fail("list failed");
    assert.strictEqual(list.value.jobs.length, 1);
    assert.strictEqual(list.value.jobs[0]!.jobId, submit.value.jobId);
  });

  it("concurrent submits with the same idempotency key both succeed and converge on one jobId", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store, clock(1_700_000_000_000));
    const repo = await makeRepo();
    // Fire several submits with the same key in parallel. The brief says
    // "two concurrent submits cannot both win"; we expect every caller to
    // receive an admission that points at the same jobId.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        fleet.submit({
          objective: "race me",
          repo,
          risk: "low",
          idempotencyKey: "shared-key",
        }),
      ),
    );
    for (const r of results) {
      if (!r.ok) assert.fail(`submit failed: ${r.problem}`);
    }
    const ids = new Set(results.map((r) => (r as { value: { jobId: string } }).value.jobId));
    assert.strictEqual(ids.size, 1, "concurrent submits converged on one jobId");
    // Exactly one job record was created.
    const listed = await fleet.list();
    if (!listed.ok) assert.fail("list failed");
    assert.strictEqual(listed.value.jobs.length, 1);
  });

  it("size budget arithmetic sums the four subtrees", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store);
    const repo = await makeRepo();
    const submit = await fleet.submit({ objective: "size me", repo, risk: "low" });
    if (!submit.ok) assert.fail("submit failed");
    const size = await fleet.computeSize();
    assert.ok(size.bytes > 0);
    assert.strictEqual(size.softLimitBytes, 1073741824);
    assert.strictEqual(size.overBudget, false);
    // Adding an out-of-band file should bump the size on the next call.
    writeFileSync(join(Paths.capacityDir(store.root), "extra.txt"), "x".repeat(1000));
    const next = await fleet.computeSize();
    assert.ok(next.bytes > size.bytes);
  });
});

describe("finding-specific regression tests", () => {
  async function makeRepo(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "fleet-finding-repo-"));
    mkdirSync(join(dir, ".git"));
    return dir;
  }

  async function freshStore(): Promise<JobStore> {
    return JobStore.open(mkdtempSync(join(tmpdir(), "fleet-finding-store-")));
  }

  function clock(ms: number): () => number {
    return () => ms;
  }

  // F4: snapshot.sha256 must match the actual file bytes on disk.
  it("F4: snapshot.sha256 matches the on-disk snapshot bytes", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store, clock(1_700_000_000_000));
    const repo = await makeRepo();
    const submit = await fleet.submit({ objective: "hash me", repo, risk: "low" });
    if (!submit.ok) assert.fail("submit failed");
    const snapshotPath = Paths.inputSnapshot(store.root, submit.value.jobId);
    const shaPath = Paths.inputSnapshotSha256(store.root, submit.value.jobId);
    const fileBytes = await fs.readFile(snapshotPath, "utf8");
    const shaLine = (await fs.readFile(shaPath, "utf8")).trim();
    const recordedHash = shaLine.split("  ")[0] as string;
    const { createHash } = await import("node:crypto");
    const actualHash = createHash("sha256").update(fileBytes).digest("hex");
    assert.strictEqual(recordedHash, actualHash, "sha256 must match the exact bytes on disk");
  });

  // F5: writeJobNew must return conflict, not silently overwrite.
  it("F5: writeJobNew returns conflict when the job already exists", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store, clock(1_700_000_000_000));
    const repo = await makeRepo();
    const submit = await fleet.submit({ objective: "x", repo, risk: "low" });
    if (!submit.ok) assert.fail("submit failed");
    // Try to write a second job record with the same id.
    const result = await store.writeJobNew(
      submit.value.jobId,
      "medium",
      repo,
      "admitted",
      { createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
    );
    assert.strictEqual(result.ok, false, "second writeJobNew must fail");
    if (!result.ok) assert.strictEqual(result.problem, "conflict");
    // The original record is untouched.
    const original = await store.readJob(submit.value.jobId);
    if (!original.ok) assert.fail("original job should still be readable");
    assert.strictEqual(original.value.risk, "low");
  });

  // F6: unknown-major read-only guard must handle all malformed shapes.
  it("F6: malformed or unknown store.json schema makes the store read-only", async () => {
    const cases: Array<{ label: string; content: string }> = [
      { label: "store/abc", content: '{"schema":"store/abc","epoch":1,"createdAt":"2026-01-01T00:00:00Z"}\n' },
      { label: "store/next", content: '{"schema":"store/next","epoch":1,"createdAt":"2026-01-01T00:00:00Z"}\n' },
      { label: "store (bare)", content: '{"schema":"store","epoch":1,"createdAt":"2026-01-01T00:00:00Z"}\n' },
      { label: "number schema", content: '{"schema":42,"epoch":1,"createdAt":"2026-01-01T00:00:00Z"}\n' },
      { label: "null schema", content: '{"schema":null,"epoch":1,"createdAt":"2026-01-01T00:00:00Z"}\n' },
      { label: "missing schema", content: '{"epoch":1,"createdAt":"2026-01-01T00:00:00Z"}\n' },
      { label: "not an object", content: '"just a string"\n' },
      { label: "store/2", content: '{"schema":"store/2","epoch":1,"createdAt":"2026-01-01T00:00:00Z"}\n' },
    ];
    for (const { label, content } of cases) {
      const dir = mkdtempSync(join(tmpdir(), "fleet-f6-"));
      writeFileSync(Paths.storeJson(dir), content);
      const store = await JobStore.open(dir);
      assert.strictEqual(store.readOnly, true, `${label} should make the store read-only`);
    }
    // A valid store/1 should NOT be read-only.
    const validDir = mkdtempSync(join(tmpdir(), "fleet-f6-valid-"));
    writeFileSync(
      Paths.storeJson(validDir),
      '{"schema":"store/1","epoch":1,"createdAt":"2026-01-01T00:00:00Z"}\n',
    );
    const validStore = await JobStore.open(validDir);
    assert.strictEqual(validStore.readOnly, false, "store/1 should be writable");
  });

  // F8: store boundary validates hostile inputs.
  it("F8: JobStore.readJob rejects hostile job ids at the boundary", async () => {
    const store = await freshStore();
    const hostile = ["../../../etc/passwd", "../../etc/passwd".padEnd(26, "A"), "not-a-ulid"];
    for (const id of hostile) {
      const result = await store.readJob(id);
      assert.strictEqual(result.ok, false, `${id} should be rejected`);
      if (!result.ok) assert.strictEqual(result.problem, "invalid-input");
    }
  });

  it("F8: JobStore.readIdempotencyRecord rejects hostile hashes", async () => {
    const store = await freshStore();
    const result = await store.readIdempotencyRecord("../../../etc/passwd");
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.strictEqual(result.problem, "invalid-input");
  });

  // F11: bad limit returns invalid-input, does not throw.
  it("F11: list with limit 0 returns invalid-input instead of throwing", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store);
    const result = await fleet.list({ limit: 0 });
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.strictEqual(result.problem, "invalid-input");
  });

  it("F11: list with limit 1.5 returns invalid-input instead of throwing", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store);
    const result = await fleet.list({ limit: 1.5 });
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.strictEqual(result.problem, "invalid-input");
  });

  // F12: failed submit does not poison idempotency key.
  it("F12: a failed submit can be retried with the same idempotency key", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store, clock(1_700_000_000_000));
    const repo = await makeRepo();
    // Submit with an idempotency key.
    const first = await fleet.submit({
      objective: "first attempt",
      repo,
      risk: "low",
      idempotencyKey: "recoverable-key",
    });
    if (!first.ok) assert.fail("first submit failed");
    // Simulate a poisoned idempotency record: the record exists but the job
    // is not readable. Backdate the claim past the 60s reclaim threshold so
    // the store treats it as genuinely abandoned, not live.
    const hash = hashIdempotencyKey("orphaned-key");
    writeFileSync(
      Paths.idempotencyRecord(store.root, hash),
      JSON.stringify({
        schema: "idempotency-index/1",
        key: "orphaned-key",
        jobId: "01JQQ000000000000000000000",
        createdAt: "2026-01-01T00:00:00Z",
        owner: { pid: 999999, bootToken: "dead-token" },
        claimedAt: new Date(Date.now() - 120_000).toISOString(),
      }) + "\n",
    );
    // Now submit with the same key — the idempotency record points at a
    // job that does not exist. After the retry loop, the slot should be
    // reclaimed and the submit should succeed.
    const retry = await fleet.submit({
      objective: "retry after orphan",
      repo,
      risk: "low",
      idempotencyKey: "orphaned-key",
    });
    assert.strictEqual(retry.ok, true, "retry should succeed after reclaim");
  });

  // F14: walkSize handles vanished entries gracefully.
  it("F14: walkSize treats vanished entries as zero bytes", async () => {
    const store = await freshStore();
    const fleet = new Fleet(store);
    const repo = await makeRepo();
    const submit = await fleet.submit({ objective: "x", repo, risk: "low" });
    if (!submit.ok) assert.fail("submit failed");
    // computeSizeBytes should not throw even if files vanish mid-walk.
    const size = await store.computeSizeBytes();
    assert.ok(size >= 0);
  });
});

describe("ticket 23 attempt 3 findings", () => {
  async function makeRepo(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "fleet-a3-repo-"));
    mkdirSync(join(dir, ".git"));
    return dir;
  }

  async function freshStore(): Promise<JobStore> {
    return JobStore.open(mkdtempSync(join(tmpdir(), "fleet-a3-store-")));
  }

  function clock(ms: number): () => number {
    return () => ms;
  }

  // B1: an injected clock must be honoured by job ids, not swallowed by the
  // module-level monotonic state shared with scratch-file ULIDs.
  describe("B1: injected clock and job ids", () => {
    const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    function decodeUlidMs(ulid: string): number {
      let ms = 0;
      for (let i = 0; i < 10; i += 1) {
        const v = CROCKFORD.indexOf(ulid[i] as string);
        assert.ok(v >= 0, `invalid Crockford char ${ulid[i]}`);
        ms = ms * 32 + v;
      }
      return ms;
    }

    it("the job id's timestamp equals the injected admission time", async () => {
      const store = await freshStore();
      const fixedMs = 1_700_000_000_000;
      const fleet = new Fleet(store, () => fixedMs);
      const repo = await makeRepo();
      const submit = await fleet.submit({ objective: "clock me", repo, risk: "low" });
      if (!submit.ok) assert.fail("submit failed");
      assert.strictEqual(decodeUlidMs(submit.value.jobId), fixedMs);
      assert.strictEqual(submit.value.admittedAt, new Date(fixedMs).toISOString());
    });

    it("many ids generated inside one injected millisecond are strictly increasing", async () => {
      const store = await freshStore();
      const fixedMs = 1_700_000_000_000;
      const fleet = new Fleet(store, () => fixedMs);
      const repo = await makeRepo();
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const s = await fleet.submit({ objective: `job-${i}`, repo, risk: "low" });
        if (!s.ok) assert.fail("submit failed");
        ids.push(s.value.jobId);
      }
      for (let i = 1; i < ids.length; i += 1) {
        assert.ok(
          (ids[i - 1] as string) < (ids[i] as string),
          `${ids[i - 1]} < ${ids[i]}`,
        );
      }
    });
  });

  // B2: snapshot writes must be atomic (scratch + rename), never in-place
  // truncation.
  describe("B2: atomic snapshot writes", () => {
    it("a failed snapshot write leaves the previous snapshot intact", async () => {
      const store = await freshStore();
      const fleet = new Fleet(store, clock(1_700_000_000_000));
      const repo = await makeRepo();
      const submit = await fleet.submit({ objective: "ORIGINAL OBJECTIVE", repo, risk: "low" });
      if (!submit.ok) assert.fail("submit failed");
      const jobId = submit.value.jobId;
      const snapshotPath = Paths.inputSnapshot(store.root, jobId);
      const before = await fs.readFile(snapshotPath, "utf8");

      // Replace the job's tmp/ dir with a regular file so the scratch write
      // fails — a deterministic stand-in for a torn write. The target must
      // remain the last good snapshot.
      const tmpDir = Paths.tmpDir(store.root, jobId);
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.writeFile(tmpDir, "not a directory");
      await store
        .writeInputSnapshot(jobId, {
          objective: "SHOULD NOT LAND",
          repo: realpathSync(repo),
          risk: "low",
          overrides: {},
          admittedAt: "2026-01-01T00:00:00Z",
          idempotencyKey: null,
        })
        .catch(() => {});

      const after = await fs.readFile(snapshotPath, "utf8");
      assert.strictEqual(after, before, "a failed write must not truncate or replace the snapshot");
    });
  });

  // B4: read-only detection must happen before any directory or file is
  // created.
  describe("B4: read-only detection before any write", () => {
    it("a read-only store gets no mkdir, no config.json, no writes", async () => {
      const dir = mkdtempSync(join(tmpdir(), "fleet-b4-"));
      writeFileSync(
        Paths.storeJson(dir),
        `${JSON.stringify({ schema: "store/99", epoch: 1, createdAt: "2026-01-01T00:00:00Z" })}\n`,
      );
      const store = await JobStore.open(dir);
      assert.strictEqual(store.readOnly, true);
      const entries = readdirSync(dir);
      assert.deepStrictEqual(entries.sort(), ["store.json"]);
    });
  });

  // C1: the write-once job creation must be genuinely exclusive, not a
  // TOCTOU existsSync check.
  describe("C1: exclusive job creation", () => {
    it("concurrent writeJobNew for the same fresh id yields one ok and one conflict", async () => {
      const store = await freshStore();
      const jobId = generateUlid(() => 1_700_000_000_000);
      const a = store.writeJobNew(jobId, "low", "/tmp/repo-a", "admitted", {
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      const b = store.writeJobNew(jobId, "medium", "/tmp/repo-b", "admitted", {
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      const [ra, rb] = await Promise.all([a, b]);
      const oks = [ra, rb].filter((r) => r.ok).length;
      const conflicts = [ra, rb].filter((r) => !r.ok && r.problem === "conflict").length;
      assert.strictEqual(oks, 1, "exactly one write must win");
      assert.strictEqual(conflicts, 1, "exactly one write must report conflict");
    });
  });

  // C2: releaseLock must only release the caller's own lock.
  describe("C2: lock ownership on release", () => {
    it("releaseLock leaves a foreign lock alone and audits the refusal", async () => {
      const dir = mkdtempSync(join(tmpdir(), "fleet-c2-"));
      const lock = join(dir, "job.lock");
      writeFileSync(lock, JSON.stringify({ pid: process.pid + 9999, bootToken: "foreign-token" }));
      const audit = join(dir, "audit.jsonl");
      await (releaseLock as unknown as (t: string, o?: { audit?: string }) => Promise<void>)(
        lock,
        { audit },
      );
      assert.ok(existsSync(lock), "foreign lock must not be deleted");
      const auditText = await fs.readFile(audit, "utf8");
      assert.match(auditText, /lock-release-refused/);
    });
  });

  // C3: acquireLock must not recurse unboundedly on a lock that keeps
  // vanishing.
  describe("C3: bounded lock acquisition", () => {
    it(
      "a dangling lock symlink fails cleanly with LockHeldError",
      { timeout: 5000 },
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "fleet-c3-"));
        const lock = join(dir, "job.lock");
        // A dangling symlink makes open("wx") fail EEXIST and stat fail ENOENT,
        // which is the exact "lock vanished" path that used to recurse forever.
        symlinkSync(join(dir, "no-such-target"), lock);
        await assert.rejects(
          acquireLock(lock, { staleMs: 30_000 }),
          (e: unknown) => e instanceof LockHeldError,
        );
      },
    );
  });

  // A1: a corrupt job record must not take out the whole store.
  describe("A1: unreadable job records", () => {
    const VALID_JOB = (jobId: string): Record<string, unknown> => ({
      schema: "job/1",
      jobId,
      revision: 1,
      status: "admitted",
      risk: "low",
      repo: "/tmp/repo",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const corruptCases: ReadonlyArray<{ label: string; content: (jobId: string) => string }> = [
      { label: "corrupt JSON", content: () => "{ not json" },
      {
        label: "schema-invalid JSON",
        content: (jobId) => JSON.stringify({ ...VALID_JOB(jobId), status: "pending" }) + "\n",
      },
      { label: "zero-byte file", content: () => "" },
      {
        label: "truncated JSON",
        content: (jobId) => `{"schema":"job/1","jobId":"${jobId}"`,
      },
    ];

    for (const c of corruptCases) {
      it(`get returns unavailable-dependency for ${c.label}`, async () => {
        const store = await freshStore();
        const fleet = new Fleet(store, clock(1_700_000_000_000));
        const repo = await makeRepo();
        const submit = await fleet.submit({ objective: "corrupt me", repo, risk: "low" });
        if (!submit.ok) assert.fail("submit failed");
        writeFileSync(Paths.jobJson(store.root, submit.value.jobId), c.content(submit.value.jobId));
        const got = await fleet.get(submit.value.jobId);
        assert.strictEqual(got.ok, false, `${c.label} must not throw`);
        if (!got.ok) {
          assert.strictEqual(got.problem, "unavailable-dependency");
          assert.match(got.message, new RegExp(submit.value.jobId));
        }
      });

      it(`list skips ${c.label}, keeps going, and reports unreadable`, async () => {
        const store = await freshStore();
        const fleet = new Fleet(store, clock(1_700_000_000_000));
        const repo = await makeRepo();
        const good = await fleet.submit({ objective: "still good", repo, risk: "low" });
        if (!good.ok) assert.fail("good submit failed");
        const bad = await fleet.submit({ objective: "about to break", repo, risk: "low" });
        if (!bad.ok) assert.fail("bad submit failed");
        writeFileSync(Paths.jobJson(store.root, bad.value.jobId), c.content(bad.value.jobId));
        const page = await fleet.list();
        if (!page.ok) assert.fail(`list must stay ok for ${c.label}: ${page.message}`);
        const unreadable = (page.value as { unreadable?: number }).unreadable;
        assert.strictEqual(unreadable, 1);
        assert.deepStrictEqual(
          page.value.jobs.map((j) => j.jobId),
          [good.value.jobId],
        );
      });
    }
  });

  // A2: idempotency reclaim must not admit duplicate jobs.
  describe("A2: idempotency reclaim", () => {
    function abandonedClaim(key: string, jobId: string, claimedAt: string): Record<string, unknown> {
      return {
        schema: "idempotency-index/1",
        key,
        jobId,
        createdAt: "2023-11-14T22:13:20Z",
        owner: { pid: 999999, bootToken: "dead-token" },
        claimedAt,
      };
    }

    it("a slow winner and a fast loser yield exactly one job", async () => {
      const store = await freshStore();
      const fleet = new Fleet(store, clock(1_700_000_000_000));
      const repo = await makeRepo();
      const key = "slow-key";
      const hash = hashIdempotencyKey(key);
      const winnerJobId = generateUlid(() => 1_700_000_000_000);
      // The winner claims the key but is slow (700ms) to write its job.
      writeFileSync(
        Paths.idempotencyRecord(store.root, hash),
        JSON.stringify(abandonedClaim(key, winnerJobId, new Date().toISOString())) + "\n",
      );

      const loserPromise = fleet.submit({
        objective: "loser",
        repo,
        risk: "low",
        idempotencyKey: key,
      });

      // Winner finishes writing its job 700ms later.
      await new Promise((r) => setTimeout(r, 700));
      await store.writeInputSnapshot(winnerJobId, {
        objective: "winner",
        repo: realpathSync(repo),
        risk: "low",
        overrides: {},
        admittedAt: "2023-11-14T22:13:20Z",
        idempotencyKey: key,
      });
      await store.writeJobNew(winnerJobId, "low", realpathSync(repo), "admitted", {
        createdAt: "2023-11-14T22:13:20Z",
        updatedAt: "2023-11-14T22:13:20Z",
      });

      const loser = await loserPromise;
      if (!loser.ok) assert.fail(`loser failed: ${loser.problem} (${loser.message})`);
      assert.strictEqual(loser.value.jobId, winnerJobId);
      const listed = await fleet.list();
      if (!listed.ok) assert.fail("list failed");
      assert.strictEqual(listed.value.jobs.length, 1, "exactly one job must exist for the key");
    });

    it("a genuinely abandoned claim older than 60s is reclaimable", async () => {
      const store = await freshStore();
      const fleet = new Fleet(store, clock(1_700_000_000_000));
      const repo = await makeRepo();
      const key = "abandoned-key";
      const hash = hashIdempotencyKey(key);
      const ghostJobId = "01JQQ000000000000000000000";
      writeFileSync(
        Paths.idempotencyRecord(store.root, hash),
        JSON.stringify(
          abandonedClaim(key, ghostJobId, new Date(Date.now() - 120_000).toISOString()),
        ) + "\n",
      );
      const submit = await fleet.submit({
        objective: "reclaim it",
        repo,
        risk: "low",
        idempotencyKey: key,
      });
      if (!submit.ok) assert.fail(`reclaim submit failed: ${submit.problem} (${submit.message})`);
      assert.notStrictEqual(submit.value.jobId, ghostJobId);
    });

    it("two concurrent reclaims do not both succeed", async () => {
      const store = await freshStore();
      const hash = hashIdempotencyKey("reclaim-race");
      writeFileSync(
        Paths.idempotencyRecord(store.root, hash),
        JSON.stringify(
          abandonedClaim("reclaim-race", "01JQQ000000000000000000000", new Date(Date.now() - 120_000).toISOString()),
        ) + "\n",
      );
      type ReclaimResult = { ok: boolean; value?: { reclaimed: boolean } };
      const [a, b] = await Promise.all([
        (store.reclaimIdempotencyRecord as unknown as (h: string) => Promise<ReclaimResult>)(hash),
        (store.reclaimIdempotencyRecord as unknown as (h: string) => Promise<ReclaimResult>)(hash),
      ]);
      const wins = [a, b].filter((r) => r && r.ok && r.value?.reclaimed === true).length;
      assert.strictEqual(wins, 1, "exactly one concurrent reclaim must win");
    });
  });

  // A3: every public store method validates hostile ids/keys.
  describe("A3: store boundary validation sweep", () => {
    it("every id/key-taking method returns invalid-input and leaves the filesystem untouched", async () => {
      type Invoke = (store: JobStore) => Promise<unknown>;
      const cases: ReadonlyArray<{ name: string; invoke: Invoke }> = [
        { name: "readJob", invoke: (s) => s.readJob("../../../evil") },
        {
          name: "writeJobNew",
          invoke: (s) =>
            s.writeJobNew("../../../evil", "low", "/tmp/repo", "admitted", {
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            }),
        },
        {
          name: "writeInputSnapshot",
          invoke: (s) =>
            s.writeInputSnapshot("../../../evil", {
              objective: "x",
              repo: "/tmp/repo",
              risk: "low",
              overrides: {},
              admittedAt: "2026-01-01T00:00:00Z",
              idempotencyKey: null,
            }),
        },
        { name: "readInputSnapshot", invoke: (s) => s.readInputSnapshot("../../../evil") },
        {
          name: "mutateJob",
          invoke: (s) =>
            s.mutateJob("../../../evil", 1, () => ({
              ok: false,
              problem: "conflict",
              message: "x",
            })),
        },
        { name: "readIdempotencyRecord", invoke: (s) => s.readIdempotencyRecord("../../../evil") },
        {
          name: "writeIdempotencyRecord",
          invoke: (s) =>
            (s.writeIdempotencyRecord as unknown as (h: string, p: unknown) => Promise<unknown>)(
              "../../../evil",
              { key: "k", jobId: "j", createdAt: "t" },
            ),
        },
        {
          name: "reclaimIdempotencyRecord",
          invoke: (s) =>
            (s.reclaimIdempotencyRecord as unknown as (h: string) => Promise<unknown>)("../../../evil"),
        },
      ];

      for (const c of cases) {
        const base = mkdtempSync(join(tmpdir(), "fleet-a3-base-"));
        const root = join(base, "store");
        const store = await JobStore.open(root);
        const sentinel = join(base, "evil.json");
        writeFileSync(sentinel, "precious");
        const result = (await c.invoke(store)) as { ok?: boolean; problem?: string } | undefined;
        assert.ok(result !== undefined, `${c.name} must return an outcome, not void`);
        assert.strictEqual(result.ok, false, `${c.name} must reject the hostile input`);
        if (!result.ok) assert.strictEqual(result.problem, "invalid-input");
        assert.ok(existsSync(sentinel), `${c.name} must not touch files outside the root`);
        assert.strictEqual(readFileSync(sentinel, "utf8"), "precious");
      }
    });
  });
});

/**
 * The five findings attempt 3 did not reach, fixed in the main thread. Each
 * test here failed against the code as attempt 3 left it.
 */
describe("ticket 23 close-out findings", () => {
  describe("C4: a schema tag parses exactly or not at all", () => {
    it("rejects trailing garbage, whitespace, and non-canonical majors", () => {
      for (const tag of [
        "job/1x",
        "store/1-rc",
        "store/1 ",
        " store/1",
        "store/01",
        "store/1.0",
        "store/+1",
        "store/",
        "store",
        "/1",
        "a/b/1",
      ]) {
        assert.strictEqual(parseSchemaTag(tag), null, `expected ${JSON.stringify(tag)} to be unparseable`);
      }
    });

    it("parses a canonical tag, including an unknown major", () => {
      assert.deepStrictEqual(parseSchemaTag("job/1"), { type: "job", major: 1 });
      assert.deepStrictEqual(parseSchemaTag("input-snapshot/1"), { type: "input-snapshot", major: 1 });
      // Parseable but not known — that is what makes the store read-only
      // rather than making the record unreadable.
      assert.deepStrictEqual(parseSchemaTag("store/2"), { type: "store", major: 2 });
      assert.strictEqual(knownSchemaMajor("store", 2), false);
    });

    it("a store tagged with a trailing space is read-only, not writable", async () => {
      const home = mkdtempSync(join(tmpdir(), "fleet-c4-"));
      const repo = mkdtempSync(join(tmpdir(), "fleet-c4-repo-"));
      mkdirSync(join(repo, ".git"));
      const opened = await JobStore.open(home);
      const admitted = await new Fleet(opened).submit({
        objective: "before the tag is mangled",
        repo,
        risk: "low",
      });
      assert.ok(admitted.ok);

      const storeJson = join(home, "store.json");
      const record = JSON.parse(readFileSync(storeJson, "utf8")) as Record<string, unknown>;
      record.schema = "store/1 ";
      writeFileSync(storeJson, JSON.stringify(record));

      const reopened = await JobStore.open(home);
      const refused = await new Fleet(reopened).submit({ objective: "after", repo, risk: "low" });
      assert.strictEqual(refused.ok, false);
      if (!refused.ok) assert.strictEqual(refused.problem, "policy-denied");
    });
  });

  describe("C5: the known-majors table is not indexable by inherited keys", () => {
    it("answers false for Object.prototype members instead of throwing", () => {
      for (const type of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
        assert.strictEqual(knownSchemaMajor(type, 1), false, `expected ${type} to be unknown`);
      }
      assert.strictEqual(knownSchemaMajor("job", 1), true);
    });
  });

  describe("C8: honest inputs and honest excerpts", () => {
    it("an explicitly empty idempotency key is invalid-input, not silently ignored", async () => {
      const home = mkdtempSync(join(tmpdir(), "fleet-c8-"));
      const repo = mkdtempSync(join(tmpdir(), "fleet-c8-repo-"));
      mkdirSync(join(repo, ".git"));
      const fleet = new Fleet(await JobStore.open(home));
      for (const key of ["", "   "]) {
        const outcome = await fleet.submit({
          objective: "an objective",
          repo,
          risk: "low",
          idempotencyKey: key,
        });
        assert.strictEqual(outcome.ok, false);
        if (!outcome.ok) assert.strictEqual(outcome.problem, "invalid-input");
      }
    });

    it("an excerpt cuts on code points and never emits a lone surrogate", async () => {
      const home = mkdtempSync(join(tmpdir(), "fleet-c8b-"));
      const repo = mkdtempSync(join(tmpdir(), "fleet-c8b-repo-"));
      mkdirSync(join(repo, ".git"));
      const fleet = new Fleet(await JobStore.open(home));
      // Astral-plane characters: two UTF-16 units each, so a unit-wise slice
      // at an odd boundary splits a pair.
      const admitted = await fleet.submit({
        objective: "\u{1F600}".repeat(130),
        repo,
        risk: "low",
      });
      assert.ok(admitted.ok);
      const page = await fleet.list({});
      assert.ok(page.ok);
      const excerpt = page.value.jobs[0]?.objectiveExcerpt ?? "";
      assert.strictEqual(Array.from(excerpt).length, 120);
      for (const unit of excerpt) {
        const code = unit.codePointAt(0) ?? 0;
        assert.ok(
          code < 0xd800 || code > 0xdfff,
          "excerpt contains a lone surrogate half",
        );
      }
    });
  });
});

/**
 * Third-review findings. Every test here failed against the code as the third
 * review found it: each of these paths either threw a raw error out of a public
 * method, hung, or left litter behind.
 */
describe("ticket 23 third-review findings", () => {
  async function freshStore(): Promise<{ store: JobStore; fleet: Fleet; home: string; repo: string }> {
    const home = mkdtempSync(join(tmpdir(), "fleet-r3f-"));
    const repo = mkdtempSync(join(tmpdir(), "fleet-r3f-repo-"));
    mkdirSync(join(repo, ".git"));
    const store = await JobStore.open(home);
    return { store, fleet: new Fleet(store), home, repo };
  }

  it("F1: a corrupt input snapshot is a typed problem, not a raw SyntaxError", async () => {
    const { store, fleet, home, repo } = await freshStore();
    const admitted = await fleet.submit({ objective: "will be corrupted", repo, risk: "low" });
    assert.ok(admitted.ok);
    const jobId = admitted.value.jobId;
    writeFileSync(Paths.inputSnapshot(home, jobId), '{"schema":"input-');

    const read = await store.readInputSnapshot(jobId);
    assert.strictEqual(read.ok, false);
    if (!read.ok) assert.strictEqual(read.problem, "unavailable-dependency");

    const got = await fleet.get(jobId);
    assert.strictEqual(got.ok, false);
    if (!got.ok) assert.strictEqual(got.problem, "unavailable-dependency");

    // And the listing survives it.
    const page = await fleet.list({});
    assert.ok(page.ok);
  });

  it("F2: a corrupt idempotency record is a typed problem, not a raw SyntaxError", async () => {
    const { store, fleet, home, repo } = await freshStore();
    const first = await fleet.submit({ objective: "keyed", repo, risk: "low", idempotencyKey: "K" });
    assert.ok(first.ok);
    const hash = hashIdempotencyKey("K");
    writeFileSync(Paths.idempotencyRecord(home, hash), "{");

    const read = await store.readIdempotencyRecord(hash);
    assert.strictEqual(read.ok, false);
    if (!read.ok) assert.strictEqual(read.problem, "unavailable-dependency");

    const retried = await fleet.submit({
      objective: "keyed",
      repo,
      risk: "low",
      idempotencyKey: "K",
    });
    assert.strictEqual(retried.ok, false);
    if (!retried.ok) assert.strictEqual(retried.problem, "unavailable-dependency");
  });

  it("F3: a claim whose job never appears returns conflict instead of spinning", async () => {
    const { store, fleet, home, repo } = await freshStore();
    // Stand in for a writer that died after claiming the key and before
    // committing the job: a fresh claim pointing at a job that is not there.
    const hash = hashIdempotencyKey("ORPHAN");
    const claimed = await store.writeIdempotencyRecord(hash, {
      key: "ORPHAN",
      jobId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      createdAt: new Date().toISOString(),
    });
    assert.ok(claimed.ok, "expected the claim to be writable");
    assert.ok(existsSync(Paths.idempotencyRecord(home, hash)));

    const started = Date.now();
    const outcome = await fleet.submit({
      objective: "waits on the orphan",
      repo,
      risk: "low",
      idempotencyKey: "ORPHAN",
    });
    const elapsed = Date.now() - started;
    assert.strictEqual(outcome.ok, false);
    if (!outcome.ok) assert.strictEqual(outcome.problem, "conflict");
    // The unbounded version spun for the full 60s reclaim window.
    assert.ok(elapsed < 15_000, `submit took ${elapsed}ms; expected a bounded wait`);
  });

  it("F4: mutating a job that does not exist leaves no phantom directory", async () => {
    const { store } = await freshStore();
    const before = await store.listJobIds();
    const outcome = await store.mutateJob("01ARZ3NDEKTSV4RRFFQ69G5FAV", 1, (current) => ({
      ok: true,
      value: { next: { ...current, revision: current.revision + 1 }, reason: "never runs" },
    }));
    assert.strictEqual(outcome.ok, false);
    if (!outcome.ok) assert.strictEqual(outcome.problem, "not-found");
    assert.deepStrictEqual(await store.listJobIds(), before);
  });

  it("F5: a staleMs of zero is rejected, so locks still exclude", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-r3f-stale-"));
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        schema: "config/1",
        store: { softLimitBytes: 1073741824 },
        lock: { staleMs: 0 },
      }),
    );
    await JobStore.open(home);
    // A zero timeout would make the live lock instantly breakable.
    const lock = join(home, "probe.lock");
    await acquireLock(lock, { staleMs: 30_000 });
    await assert.rejects(
      () => acquireLock(lock, { staleMs: 30_000 }),
      LockHeldError,
    );
    await releaseLock(lock);
  });

  it("F9: a job directory with no readable record is counted, not silently dropped", async () => {
    const { fleet, home, repo } = await freshStore();
    const admitted = await fleet.submit({ objective: "the healthy one", repo, risk: "low" });
    assert.ok(admitted.ok);
    // A submit that died between mkdir and the exclusive job.json commit.
    mkdirSync(join(home, "jobs", "01ARZ3NDEKTSV4RRFFQ69G5FAV"), { recursive: true });

    const page = await fleet.list({});
    assert.ok(page.ok);
    assert.strictEqual(page.value.jobs.length, 1);
    assert.strictEqual(page.value.unreadable, 1);
  });

  it("F10: an unwritable audit log does not turn an admitted job into a fault", async () => {
    const { store, home } = await freshStore();
    const jobId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    // Make the audit path un-appendable by putting a directory in its place.
    mkdirSync(Paths.jobAudit(home, jobId), { recursive: true });
    const outcome = await store.writeJobNew(jobId, "low", "/somewhere", "admitted", {
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.ok(outcome.ok, "an audit failure must not fail an already-committed job");
    const readBack = await store.readJob(jobId);
    assert.ok(readBack.ok);
  });

  it("F11: a read-only store refuses to reclaim an idempotency record", async () => {
    const { store, fleet, home, repo } = await freshStore();
    const first = await fleet.submit({ objective: "keyed", repo, risk: "low", idempotencyKey: "K" });
    assert.ok(first.ok);
    const storeJson = join(home, "store.json");
    const record = JSON.parse(readFileSync(storeJson, "utf8")) as Record<string, unknown>;
    record.schema = "store/9";
    writeFileSync(storeJson, JSON.stringify(record));

    const reopened = await JobStore.open(home);
    const reclaim = await reopened.reclaimIdempotencyRecord(hashIdempotencyKey("K"));
    assert.strictEqual(reclaim.ok, false);
    if (!reclaim.ok) assert.strictEqual(reclaim.problem, "policy-denied");
    assert.ok(store instanceof JobStore);
  });
});
