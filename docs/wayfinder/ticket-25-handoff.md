# Handoff: ticket 25 — Pi work-unit driver, stub binary, golden fixture, and the Fleet extension

This handoff picks up ticket 25 mid-stream. Two slices have landed; one
in-flight change needs a quick re-test before commit; a handful of
named-test improvements remain. The branch is `ticket-25-pi-driver`.

## Where we are

| Slice | Status | Commit |
| --- | --- | --- |
| 1 — driver module + 7 named tests + supporting helpers | landed | `84f4c89` |
| 1' — tighten summarise / terminate semantics; fix LF-only test premise | landed | `38635dd` |
| 2 — fixture-replaying stub, Fleet extension, supervisor wiring | landed | `89e1971` |
| 3 — `probePiVersion` honours `.ts`; spawn-error → infrastructure; scrub-on-seal | **uncommitted, ready** | — |

The current branch has 3 commits ahead of `origin/main`; the working
tree has one further edit on top of those (probe `.ts`, spawn-error,
scrub-on-seal, two new end-to-end tests).

## What this ticket delivers

The single seam is `src/pi-driver.ts` — `runStage(opts)` returns a
typed `RunResult`. Everything else (stub binary, golden fixture,
extension, supervisor wiring) plugs into that seam.

### Module surface (`src/pi-driver.ts`)

- **Pure functions (no I/O):**
  - `parseJsonlLines(buffer)` — LF-only framing, strips CR, drops empty lines, U+2028 stays in line.
  - `parseEvent(line)` — returns `null` on bad JSON / non-object / missing `type`.
  - `sumUsage(events)` — sums `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, and `cost.{input,output,cacheRead,cacheWrite,total}` over `message_end` with `role === "assistant"`.
  - `classify(events)` — `infrastructure | quality | sealed` discriminator.
  - `summarise(events)` — full summary: agentStarted, settled, sealed, sealedTool, usage, model, provider, stopReasons, toolCalls, submitted.
  - `validateSubmitPayload(value)` — schema check: `summary: string`, `filesTouched: string[]`, `commandsRun: string[]`, `contractMet: boolean`.
  - `isSubmitToolName(name)` — `/^submit_[a-z_]+$/`.
  - `resolvePiBinary(source)` — `PI_FLEET_PI_BIN` > configured > defaultPath; empty string is ignored.
  - `sessionName(jobId, stageIndex, attempt)` — `<jobId>-<stageIndex>-<attempt>`.

- **Lifecycle functions (I/O):**
  - `probePiVersion(piBinary)` — spawns with `--version`; reads first line; falls back to `"unknown"` after 2s. Honours `.ts` paths by running under `node --experimental-strip-types`.
  - `discoverSessionFile(sessionDir, sessionName)` — returns the unique `*.json` in `sessionDir`, preferring exact `<name>.json` match.
  - `scrubSessionFile(path)` — credential-key redaction (`apiKey`, `authorization`, `bearer`, `secret`, `token`, `password`, `accessToken`) with `[REDACTED]`. Returns `{ redactedKeys }`.
  - `terminate(child, opts)` — three-rung ladder with a 50ms pre-flight: `none` if child exits quietly, else `abort` (stdin `{"type":"abort"}\n`, 10s wait) → `sigterm` (30s default) → `sigkill` (5s wait).
  - `runStage(opts)` — full orchestrator: call-intent → probe version → spawn → LF-only JSONL parse → 90s launch timeout → settle/wait/timeout → session discovery → cap checks → classify → scrub on seal → typed `RunResult`.

- **Cap constants:**
  - `ATTEMPT_TRANSCRIPT_CAP_BYTES = 8 MiB`
  - `JOB_TRANSCRIPT_CAP_BYTES = 32 MiB`

### Golden fixture (`src/fixtures/golden-pi-events.jsonl`)

14 lines. First line is a header: `{"_fixture":"fleet-driver-golden/1","piVersion":"minimax-m3-fixture@1","capturedFrom":"spike 05"}`. The fixture names its own Pi version — `probePiVersion` reads the same header when the stub runs `--version`.

The remaining 13 lines trace the canonical lifecycle: `agent_start` → `turn_start` → `message_start` (assistant) → two `message_update` (thinking) → `message_end` (assistant, usage 1000/20000) → `tool_execution_start/end` (`bash`) → another `message_start/end` (usage 4970/21503) → `tool_execution_start/end` (`submit_write` with schema-valid `details`) → `agent_settled`. **Summed usage across the two assistant message_ends is exactly 5,970 input / 41,503 output / 47,473 totalTokens** — the regression fixture from ticket 25's named-test 2.

### Stub binary (`src/pi-stub.ts`)

Reads the fixture, emits each event to stdout with `--delay` ms between events (default 5ms; override via `--delay N` or `PI_FLEET_PI_DELAY_MS=N`), prints the fixture version to stderr, writes a `stage-artifact/1` artifact to `--artifact` if a schema-valid `submit_*` was emitted, and writes a `session/1` JSON to `<sessionDir>/<name>.json` with credential keys so the scrubber has work to do.

`--version` prints the fixture version on stdout. The `--help` flag prints usage.

### Extension (`src/fleet-extension.ts`)

Default-exported function taking Pi's `ExtensionAPI`. Registers five tools with TypeBox schemas:

- `submit_write`, `submit_review`, `submit_scout`, `submit_plan` — all share the same four-field payload (`summary`, `filesTouched`, `commandsRun`, `contractMet`); each is `terminate: true` so a call seals the stage.
- `raise_risk` — `from`, `to`, `reason` payload; not terminating.

Registers a `tool_call` listener that blocks `bash` commands whose head is not in the shipped allowlist (`git, node, npm, pnpm, python3, make, rg, ls, cat`) with reason `fleet: command '<head>' is not on the accepted-command allowlist`.

Package deps: `typebox` and `@earendil-works/pi-coding-agent` are dev deps — they provide types for `tsc --noEmit` and are not bundled into the runtime.

### Supervisor integration (`src/supervisor.ts`)

The supervisor still owns the policy layer (lease, capacity, job-record mutations, cancel). It delegates spawn-and-consume to `runStage`. `resolvePiBinary({ env: process.env, defaultPath: <bundled stub> })` returns the binary path; `runStage` handles `.ts` paths by running under `node --experimental-strip-types`.

The driver's `outcome.kind` is mapped to job-record reasons:

| outcome.kind | reason | status / stageState |
| --- | --- | --- |
| `sealed` | `stage-sealed` | `running` / `sealed` if artifact present |
| `quality` | `quality:<reason>` | `returned-to-orchestrator` / `planned` |
| `infra` | `infrastructure:<reason>` | `returned-to-orchestrator` / `planned` |

`runStage.inputProblem` is surfaced as `markReturned` with the message.

## Tests (`tests/rung1.driver.test.ts`)

43 tests, organised by named test then supporting helpers:

- **`(1) classification either side of agent_start`** — 4 tests, pure events.
- **`(2) usage summed with the 5,970 vs 41,503 regression fixture`** — 4 tests.
- **`(3) agent_settled ends a run; agent_end does not`** — 3 tests.
- **`(4) LF-only framing`** — 6 tests, including U+2028 and bare-CR-in-string.
- **`(5) launch timeout to first agent_start`** — 1 test that spawns a sleeping executable and asserts `outcome.kind === "infra"` with `launch timeout after 200ms`.
- **`(6) termination ladder records its rung`** — 4 tests, one per rung (`abort`, `sigterm`, `sigkill`, `none`).
- **`(7) seal only on schema-valid submit_*`** — 8 tests covering each schema field plus `isError: true`.
- **Supporting helpers** — `sessionName`, `resolvePiBinary` (5 tests), `scrubSessionFile` (3 tests), `discoverSessionFile` (2 tests), cap constants.
- **End-to-end against the stub** — 2 tests: full `runStage` against the fixture-replaying stub asserts sealed outcome, regression-fixture usage, scrubbed session, and durable call-intent; and a second test asserts call-intent durability across a failed spawn (ENONENT).

## The in-flight edit

These three additions are made but uncommitted:

1. **`probePiVersion` handles `.ts` paths** — the original probed the binary directly; the fix mirrors `runStage`'s `.ts` detection.
2. **`runStage` returns `{ kind: "infra", reason: "spawn failed: …" }` on `child.on("error")`** — needed because the e2e "binary later fails" test was throwing `ENOENT` instead of producing a typed result. Without this, the supervisor would receive an unhandled exception and the typed-return contract breaks.
3. **`runStage` scrubs the session file when the stage seals** — the spec says "scrubbed at seal and at egress"; the seal step is in the driver, the egress step is the consumer's (the supervisor / a report).
4. **The fixture-replaying stub writes a `session/1` JSON to `<sessionDir>/<name>.json`** with credential keys so the seal-time scrubber has work to do. The stub also parses `-n <name>` from argv so the session file matches what the driver discovers.

The combined commit message should look like:

```
Ticket 25 (slice 3): seal-time scrub, .ts probe, spawn-error typing

runStage now scrubs the session file when the stage seals. The
credential redactor is invoked inside the orchestrator at the moment
the schema-valid submit_* result is recorded; egress scrubbing is
the consumer's job (the supervisor / a report).

probePiVersion mirrors runStage's .ts handling: a path ending in .ts
is run under node --experimental-strip-types, the same as a real
spawn. Without this the stub's --version came back as "unknown"
because spawn cannot exec a script file directly.

runStage now classifies a failed spawn as infrastructure. ENOENT and
the like previously surfaced as uncaught exceptions; the call intent
was already on disk and the supervisor could not observe the typed
failure. The driver now returns { kind: "infra", reason: "spawn
failed: …" } so the supervisor can mark the job returned with a
typed reason.

The fixture-replaying stub writes a session/1 JSON file inside the
session directory after replay, with credential keys seeded so the
seal-time scrubber has work to do. The stub parses -n <name> from
argv to give the file the name the driver discovers.

Two new end-to-end tests in tests/rung1.driver.test.ts:
  - the full runStage against the fixture-replaying stub seals,
    records the regression-fixture usage, and scrubs credentials;
  - runStage persists the call intent before spawn even when the
    binary later fails (ENONENT).
```

## What's still outstanding for ticket 25

- **Real tests on the extension.** The extension is a TypeBox module imported only at typecheck time; we don't run Pi, so we can't exercise it directly. Rung 4 is "live Pi smoke and version-drift check, hand-run only" — that belongs to the human.
- **`piBinary` config not from disk yet.** Today the driver reads `PI_FLEET_PI_BIN` and a hardcoded default. The shipped registry, the per-repo overlay, and the four-key selection sort are ticket 31. Ticket 25's contract is the resolution function plus the default fallback.
- **`raise_risk` integration.** The extension tool exists; the supervisor / state machine reaction (reroute, escalate, return) is ticket 31 or 32. Ticket 25 only requires the tool to be registered with a schema — the runtime reaction is not in scope here.
- **The "discovery path" tools** (`submit_scout`, `submit_plan`) are registered in the extension. Their integration with the discovery state machine is ticket 38. Ticket 25 only requires the tools exist with terminating submit_* behaviour.

## Quick reference

```bash
# Typecheck (rung 0)
npm run rung:0

# Unit tests (rung 1, ~33s on a 4-core box — most of that is the termination-ladder SIGKILL tests)
npm run rung:1

# Full ladder
npm test

# Manual stub smoke
node --experimental-strip-types src/pi-stub.ts --version
# → minimax-m3-fixture@1
node --experimental-strip-types src/pi-stub.ts --delay 0 --artifact /tmp/a.json --session-dir /tmp/s -n my-sess
# → emits fixture events; writes /tmp/a.json and /tmp/s/my-sess.json
```

## Acceptance-criteria status

| Criterion | Status |
| --- | --- |
| Rung 1 named tests 1–7 pass | ✓ — all seven green |
| Stub binary replays golden fixture | ✓ |
| Fixture names its Pi version | ✓ — `minimax-m3-fixture@1` |
| Call intent before spawn with binary path + version | ✓ — durable across failed spawn |
| Session file retained inside stage dir | ✓ |
| Session scrubbed at seal | ✓ (slice 3) |
| 8MB / 32MB caps as quality failure | ✓ — both caps checked in `runStage` |
| Extension exposes `submit_*`, `raise_risk`, `tool_call` gate | ✓ |

## Files touched

- `src/pi-driver.ts` (new, ~960 lines)
- `src/pi-stub.ts` (replaced, ~130 lines)
- `src/fixtures/golden-pi-events.jsonl` (new, 14 lines)
- `src/fleet-extension.ts` (new, ~170 lines)
- `src/supervisor.ts` (refactored to delegate to driver)
- `tests/rung1.driver.test.ts` (new, ~750 lines, 43 tests)
- `package.json` — `rung:1` now runs both `rung1.unit.test.ts` and `rung1.driver.test.ts`
- `package.json` + `package-lock.json` — added `@earendil-works/pi-coding-agent` and `typebox` as dev deps
