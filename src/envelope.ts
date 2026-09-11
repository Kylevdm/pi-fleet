/** The closed set of typed problems the CLI can report. */
export type Problem =
  | "invalid-input"
  | "policy-denied"
  | "conflict"
  | "not-found"
  | "stale-confirmation"
  | "unavailable-dependency"
  | "capacity";

/** Every value the problem type may hold — used to guard exhaustive checks. */
export const PROBLEMS = [
  "invalid-input",
  "policy-denied",
  "conflict",
  "not-found",
  "stale-confirmation",
  "unavailable-dependency",
  "capacity",
] as const;

/** Success envelope. */
export type OkEnvelope = { ok: true };

/** Problem envelope — returned on typed failures. */
export type ProblemEnvelope = { ok: false; problem: Problem; message: string };

/** The union of both envelope shapes. */
export type Envelope = OkEnvelope | ProblemEnvelope;

/** Construct a success envelope. */
export function okEnvelope(): OkEnvelope {
  return { ok: true };
}

/** Construct a problem envelope. */
export function problemEnvelope(problem: Problem, message: string): ProblemEnvelope {
  return { ok: false, problem, message };
}

/**
 * Envelope for an unexpected fault. A fault is by definition not one of the
 * seven typed problems, so it carries no `problem` field — the closed set
 * stays closed — but the invocation still prints exactly one envelope.
 */
export type FaultEnvelope = { ok: false; message: string };

/** Construct a fault envelope from whatever was thrown. */
export function faultEnvelope(error: unknown): FaultEnvelope {
  return { ok: false, message: error instanceof Error ? error.message : String(error) };
}
