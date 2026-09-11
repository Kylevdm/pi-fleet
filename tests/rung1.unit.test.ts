import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  faultEnvelope,
  okEnvelope,
  problemEnvelope,
  PROBLEMS,
} from "../src/envelope.ts";
import type { Problem } from "../src/envelope.ts";
import { run } from "../src/main.ts";

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
