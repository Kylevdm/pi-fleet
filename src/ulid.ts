import { randomBytes } from "node:crypto";

/**
 * Crockford base32 alphabet: `0-9 A-Z` minus `I L O U`.
 * 32 symbols, single uppercase character per value 0..31.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Length of a ULID, fixed by spec. */
const ULID_LENGTH = 26;

/** Length of the timestamp portion (the first 10 characters). */
const TIMESTAMP_LENGTH = 10;

/** Length of the random portion (the last 16 characters). */
const RANDOM_LENGTH = 16;

/**
 * Crockford regex — 26 uppercase characters from the alphabet above. Same set
 * of disallowed characters (I, L, O, U) the alphabet avoids. The character
 * class lists each accepted letter explicitly so the test suite catches an
 * accidental drift in what the alphabet itself excludes.
 */
const ULID_REGEX = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

/**
 * Encode an integer into `n` Crockford characters. The caller is responsible
 * for ensuring the value fits in `n * 5` bits. The encoding is unsigned
 * big-endian: most-significant character first.
 */
function encodeChunk(value: bigint, n: number): string {
  let v = value;
  let out = "";
  for (let i = 0; i < n; i += 1) {
    const idx = Number(v & 0x1fn);
    out = ALPHABET[idx] + out;
    v >>= 5n;
  }
  return out;
}

/**
 * Encode a 48-bit millisecond timestamp into 10 Crockford characters.
 * Time is unsigned big-endian: small timestamps produce leading zero
 * characters, so a January 1970 ULID begins with `0000000000`.
 */
function encodeTimestamp(value: number): string {
  return encodeChunk(BigInt(value) & 0xffffffffffffn, TIMESTAMP_LENGTH);
}

/** Encode an 80-bit random value into 16 Crockford characters. */
function encodeRandom(value: bigint): string {
  return encodeChunk(value & 0xffffffffffffffffffffffffn, RANDOM_LENGTH);
}

/** State for monotonic generation. */
interface MonotonicState {
  /** Timestamp of the last ULID emitted. */
  lastMs: number;
  /** Random portion of the last ULID emitted (80 bits). */
  lastRandom: bigint;
}

/**
 * Compose a ULID from a timestamp and an 80-bit random value.
 *
 * Public so tests can pin the algorithm without depending on the system
 * clock. Production callers should use `generateUlid` with no arguments.
 */
export function composeUlid(ms: number, random80: bigint): string {
  return encodeTimestamp(ms) + encodeRandom(random80);
}

/**
 * Module-level monotonic state. Held here rather than as a default parameter
 * so the state is carried between calls — a default parameter would be
 * re-evaluated on every invocation and nothing would be remembered.
 */
const moduleState: MonotonicState = { lastMs: -1, lastRandom: -1n };

/**
 * Reset the monotonic state. Exported for tests only — production code
 * must never call this.
 */
export function _resetMonotonicState(): void {
  moduleState.lastMs = -1;
  moduleState.lastRandom = -1n;
}

/** Default random source: 80 bits from `node:crypto`. */
function defaultRandom(): bigint {
  const buf = randomBytes(10);
  let v = 0n;
  for (const byte of buf) v = (v << 8n) | BigInt(byte);
  return v;
}

/** Emit one ULID from `state`, keeping it monotonic within a millisecond. */
function emitUlid(
  state: MonotonicState,
  nowMs: () => number,
  random: () => bigint,
): string {
  let ms = nowMs();
  let r = random();
  if (ms === state.lastMs) {
    r = state.lastRandom + 1n;
  } else if (ms < state.lastMs) {
    // The clock went backwards. Hold the previous timestamp so the resulting
    // ULID still sorts at or after the last one we emitted; this preserves
    // ULID-as-time semantics across a backward step.
    ms = state.lastMs;
    r = state.lastRandom + 1n;
  }
  state.lastMs = ms;
  state.lastRandom = r;
  return composeUlid(ms, r);
}

/**
 * Create a fresh monotonic ULID generator with its own state and clock. A
 * caller that injects a clock (for tests or deterministic admission times)
 * gets a generator that honours exactly that clock, independent of any other
 * generator in the process.
 */
export function createUlidGenerator(
  nowMs: () => number,
  random: () => bigint = defaultRandom,
): () => string {
  const state: MonotonicState = { lastMs: -1, lastRandom: -1n };
  return () => emitUlid(state, nowMs, random);
}

/**
 * Generate a ULID from the module-level monotonic state. `nowMs` defaults to
 * `Date.now`; `random` defaults to 80 bits from `node:crypto`. Both are
 * injectable so tests can pin the algorithm.
 *
 * ULIDs are monotonic within a single millisecond: if `nowMs` equals the
 * previous call's timestamp, the random portion is incremented by one rather
 * than re-rolled. The 80-bit space is far larger than any rate of ULID
 * production the store will see in practice.
 *
 * This entry point is the real-wall-clock generator; code that needs a
 * distinct clock (Fleet's injected admission clock) uses
 * `createUlidGenerator` instead so the two do not share state.
 */
export function generateUlid(
  nowMs: () => number = () => Date.now(),
  random: () => bigint = defaultRandom,
): string {
  return emitUlid(moduleState, nowMs, random);
}

/**
 * Validate a candidate ULID. Strict: must be exactly 26 characters, all from
 * the Crockford base32 alphabet, no whitespace, no Unicode look-alikes.
 *
 * The ULID pattern is the only path safety rule for ids in the store.
 */
export function isValidUlid(value: unknown): value is string {
  return typeof value === "string" && ULID_REGEX.test(value);
}

/**
 * A more specific ULID type — a string the store has accepted as a job id.
 * Carries no runtime cost beyond what `isValidUlid` provides at the boundary.
 */
export type Ulid = string & { readonly __ulid: unique symbol };

/** Narrow a string to a `Ulid` after validation, throwing otherwise. */
export function asUlid(value: string): Ulid {
  if (!isValidUlid(value)) {
    throw new Error(`not a valid ULID: ${value}`);
  }
  return value as Ulid;
}