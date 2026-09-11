import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

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
});
