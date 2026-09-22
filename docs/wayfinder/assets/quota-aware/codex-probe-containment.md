# Prototype: Codex allowance probe and process-host containment

Ticket [#65](https://github.com/Kylevdm/pi-fleet/issues/65). Throwaway prototype — the
harness lives beside this note under `codex-probe-containment/` as a fixture, not as
code to carry into `src/`.

Measured 2026-09-22 against a live `Logged in using ChatGPT` Plus account, `codex-cli`
0.155.1, `@openai/codex-sdk` 0.155.1, Node 22.23.1, Linux 6.8 with cgroup v2 and a
running systemd user manager.

## Summary

Both facts [#52](https://github.com/Kylevdm/pi-fleet/issues/52) inferred now have
evidence, and one of them came out differently than the decision assumed.

1. **Short-lived app-server probe is viable** — 832 ms median, spawn to answer. But the
   spawn is not the expensive part, and a daemon would not make the cost go away.
   A TTL cache would; the probe is uncacheable at the source.
2. **The SDK child can be made visible to Fleet's process host, but the termination
   ladder in decision 2 does not hold.** SDK abort, SIGTERM and SIGKILL all leak
   orphans, because Codex `setsid`s every tool command into its own session. Only a
   cgroup — a transient systemd scope — contains the tree. This is a real amendment to
   the ladder, not a detail.

## 1. Allowance probe in the admission path

`account/rateLimits/read` is a v2 app-server method. It answers under ChatGPT auth with
no thread, no turn, and no model dispatch. A representative answer on this account:

```json
{
  "ordinaryUsageAllowed": true,
  "rateLimits": {
    "limitId": "codex",
    "primary":   { "usedPercent": 0,  "windowDurationMins": 300,   "resetsAt": 1790088485 },
    "secondary": { "usedPercent": 13, "windowDurationMins": 10080, "resetsAt": 1790586920 },
    "credits": { "hasCredits": false, "unlimited": false, "balance": "0" },
    "planType": "plus",
    "spendControlReached": false,
    "rateLimitReachedType": null
  },
  "rateLimitsByLimitId": { "codex": { ... } }
}
```

### Latency, eight cold spawns

| Phase | min | median | max |
| --- | --- | --- | --- |
| spawn → `initialize` answered | 204 ms | 210 ms | 230 ms |
| `account/rateLimits/read` round trip | 537 ms | 611 ms | 860 ms |
| **spawn → answer** | **752 ms** | **832 ms** | **1074 ms** |
| answer → process exited (SIGTERM) | 26 ms | 28 ms | 35 ms |

Every run exited 0. No stderr. No orphan.

### The spawn is not the cost

Six consecutive reads on a single warm server, same process, no respawn:

```
479, 407, 2333, 657, 1041, 548 ms
```

The read is **not cached server-side**. Each one is a fresh backend round trip, with
worse tail behaviour (2.3 s) than any cold spawn measured. Holding a daemon open saves
the ~210 ms of spawn and initialize and leaves the 400–2300 ms that actually dominates.

**This inverts the fallback in the ticket.** Letting the Codex adapter own a daemon was
the escape hatch if per-admission spawn proved prohibitive. It is not the escape hatch:
it buys 25% of the cost and reopens decision 2 for the other 75%. Decision 2 stands as
written — nothing outlives a stage attempt — and decision 11's short-lived spawn stays.

### What the cache has to be

A TTL cache is the only thing that makes the cost disappear, and the signal's own
resolution says the TTL can be generous. `usedPercent` is an integer against a 300-minute
primary window: one percentage point is three minutes of continuous full-rate
consumption. A snapshot is therefore still accurate to within its own quantisation for
well over a minute.

- **60 s TTL per pool** amortises 832 ms across every admission in that minute and stays
  far inside the signal's granularity.
- **Invalidate on evidence, not on time alone**: any turn that fails with a rate-limit
  error must evict the entry before the next admission decision.
- `account/rateLimits/updated` exists as a server notification, so a process that
  happened to be alive could keep a snapshot fresh for free. Fleet has no such process
  by decision 2, and per the numbers above it does not need one.

## 2. Process-host containment

### The seam

`CodexOptions.codexPathOverride` is the wrapping point. The SDK spawns
`codexPathOverride` (default `codex`) directly via `child_process.spawn`, keeps the
`ChildProcess` entirely private, and exposes exactly one lifecycle control:
`TurnOptions.signal`, an `AbortSignal` passed straight to Node's `spawn`. No pid, no
handle, no kill.

A shim at that path that records its own pid and then `exec`s the real `codex` gives
Fleet the pid of the actual process the SDK is talking to, with no extra layer in the
tree. **Fleet can hold the handle.** The invariant in
[#3](https://github.com/Kylevdm/pi-fleet/issues/3) is satisfiable.

### The tree, mid-tool-call

A turn told to run `sleep 400 & sleep 400`, observed from the recorded pid:

```
pid 2695541  pgid 2695541  sid 2695541   <- shim/exec, the pid Fleet records
  2695548    pgid 2695541  sid 2695541   codex (rust binary)
    2695915  pgid 2695915  sid 2695541   codex-security plugin
    2696295  pgid 2696295  sid 2695541   codex helper
    2696310  pgid 2696310  sid 2696310   /bin/bash -c sleep 400 & sleep 400   <-- own session
      2696311                            sleep 400
      2696312                            sleep 400
```

**Codex `setsid`s each tool command.** The tool process is in neither Fleet's process
group nor Fleet's session. This is what breaks the ladder.

### Three terminations, measured

| Mechanism | Result |
| --- | --- |
| `AbortController.abort()` (the SDK's own control) | shim and codex die; **2 orphaned `sleep 400` reparented to pid 1** |
| abort, then SIGTERM/SIGKILL to the recorded **process group** | `ESRCH` — the tool command is in a different pgid; **same 2 orphans** |
| abort, then sweep the recorded **session** | 0 processes matched; **same 2 orphans** |
| abort, then SIGTERM the **systemd scope** | **0 survivors, no stray processes** |

The first three are not near-misses. They are the same leak three times, because the
leaked processes are grandchildren of a deliberately detached tool command.

One further wrinkle: `codex` on the PATH is a Node wrapper that spawns the Rust binary
and forwards SIGINT/SIGTERM/SIGHUP to it. SIGKILL cannot be forwarded, so a SIGKILL
aimed at the recorded pid orphans the Rust process by construction. The ladder's own
last rung is unsafe against the pid it was going to be aimed at.

### What works

Run the whole tree inside a transient cgroup, and signal the cgroup:

```bash
#!/usr/bin/env bash
# One transient scope per spawn — the unit name must be unique, so the shim mints it
# and hands it back to Fleet through the handshake file alongside the pid.
scope="${FLEET_SCOPE_PREFIX:-fleet}-$$-$(date +%s%N).scope"
printf '%s\t%s\n' "$$" "$scope" >> "$FLEET_PID_FILE"
exec systemd-run --user --scope --quiet --collect --unit="$scope" codex "$@"
```

Observed through the scope's `cgroup.procs`:

```
before abort:            7 procs (shim, codex, 2 helpers, bash, 2 sleeps)
after SDK abort:         2 procs (the two setsid'd sleeps, still contained)
after scope SIGTERM:     cgroup gone, 0 survivors, no stray sleeps
```

The cgroup holds what the process group and the session both lost. SIGTERM to the scope
was sufficient here; SIGKILL to the scope remains available as the last rung.

### The amended ladder

1. `AbortController.abort()` — the SDK's cooperative stop, which ends the turn cleanly
   and lets Codex finalise its rollout.
2. SIGTERM the **scope**, not the pid — reaps the detached tool commands abort leaves.
3. SIGKILL the **scope** — unconditional, and the only rung that is safe to make
   unconditional, since it cannot orphan the Rust binary the way a pid-targeted SIGKILL
   can.

Fleet's process host therefore acquires **(pid, scope)**, not a pid. The pid stays useful
for liveness and for fenced-lease recovery; the scope is what termination acts on.

**Residual risk.** This is cgroup v2 plus a systemd user manager. Fleet's targets are
Linux, so this is a fit, but it is a new host requirement and it belongs in the runner
contract's preconditions rather than being assumed. A host without it can only fall back
to a recursive descendant sweep, which the measurements above show is racy against a
process that detaches its children.

## 3. Incidentals from #48's required-prototype list

### A thread aborted mid-tool-call is resumable

Aborted during `sleep 45`, then resumed by thread id in a fresh process:

```
RESUMED OK
final: `sleep 45`
usage: { input_tokens: 14020, cached_input_tokens: 13056, output_tokens: 9 }
```

The resumed turn recalled the interrupted tool call correctly, and 93% of the input was
cache reads — resume after abort is cheap as well as safe. Note the thread id is
available from `Thread.id` as soon as `thread.started` arrives, before the turn can fail,
so Fleet can durably record it early enough to always be able to resume.

### Expired or absent auth is cleanly distinguishable — on the probe

Probing with an unauthenticated `CODEX_HOME` returns a **JSON-RPC error**, not a quota
answer:

```json
{ "code": -32600, "message": "codex account authentication required to read rate limits" }
```

That is structurally distinct from exhaustion, which arrives as a *successful* result
carrying `ordinaryUsageAllowed: false` / a non-null `rateLimitReachedType`. The adapter
can separate `auth-expired` from `quota-exhausted` on shape alone at the probe. Good news
for the nine-class normalisation in decision 8.

### Auth failure on the execution path is neither clean nor cheap

The same unauthenticated state through `codex exec` is a different story:

```
error: Reconnecting... 2/5 (unexpected status 401 Unauthorized ... wss://api.openai.com/v1/responses)
...5/5
item.completed: Falling back from WebSockets to HTTPS transport. unexpected status 401 ...
error: Reconnecting... 1/5 ... (https://api.openai.com/v1/responses)
...5/5
turn.failed: { message: "unexpected status 401 Unauthorized: ..." }
THROWN: Error: Codex Exec exited with code 1: ...
```

Two things matter here.

- **Codex retries a permanently fatal error ten times** across two transports, roughly 45
  seconds, before surfacing it. Fleet's own retry policy would sit on top of a hidden
  internal one. [#55](https://github.com/Kylevdm/pi-fleet/issues/55) needs to account for
  this: a Codex attempt that fails has already been retried, and Fleet's timeouts must be
  wider than Codex's internal ladder or they will fire mid-retry and look like a
  different failure.
- **The error is free text.** `turn.failed.error` carries a `message` string and no code,
  no type, no status field. Adapter classification into the nine normalised classes is
  string matching against provider prose, which is version-fragile. This is a cost of
  decision 8 that was not priced in, and it argues for the adapter owning a small,
  explicitly-versioned pattern table with an `unknown` fallback that fails safe rather
  than guessing.

## What this prototype did not establish

**Plan exhaustion and transient throttling emissions were not observed.** The test
account sits at 0% primary / 13% secondary, and inducing either would mean burning the
plan. The response *schema* names the fields they would arrive in — `ordinaryUsageAllowed`,
`rateLimitReachedType` (with five variants, including workspace credit and usage-limit
cases distinct from plain `rate_limit_reached`), `spendControlReached`, `usedPercent` at
100 — but which of them the backend actually populates for a Plus account, and what the
*execution* path emits when the plan runs out versus when it is briefly throttled, is
still inference.

This is a narrower gap than #65 opened with, and it does not block
[#62](https://github.com/Kylevdm/pi-fleet/issues/62): capacity and scarcity semantics can
be designed against the probe's documented shape. It does block writing the adapter's
error-classification table with confidence, and it wants catching opportunistically —
the first time a real pool exhausts, the emission should be captured verbatim.
