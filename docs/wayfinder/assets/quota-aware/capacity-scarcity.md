# Capacity and scarcity semantics

Decided 2026-09-23 in [Define provider capacity and scarcity semantics](https://github.com/Kylevdm/pi-fleet/issues/62), on the map [Quota-aware orchestration across subscription model pools](https://github.com/Kylevdm/pi-fleet/issues/47).

A design artifact, not shipped code: nothing here is implemented, and the map is planning-only until it closes.

Evidence it rests on: [quota-signals.md](./quota-signals.md) (#53), [runner-contract.md](./runner-contract.md) (#52), [codex-probe-containment.md](./codex-probe-containment.md) (#65), and the compatibility boundary in [#61](https://github.com/Kylevdm/pi-fleet/issues/61).

## Vocabulary

- **Capacity** — Fleet-local concurrency only: global process slots and the per-repository writer slot. Unchanged meaning, per #61. Never used for quota.
- **Allowance** — a provider's plan limit on a pool, over one or more provider windows. Fleet observes it; it never owns or computes it.
- **Allowance scope** — the unit allowance state is tracked at: a whole pool, or one model within a pool.
- **Ration** — the share of a pool that the user lets Fleet itself spend: a count of stage attempts per rolling window, configured per pool. Fleet counts it exactly, at dispatch.
- **Confirmed** / **unconfirmed** — whether a dispatchable scope has a fresh positive allowance snapshot behind it (only the Codex probe can give one) or merely no negative evidence.
- **Standing** — the value derived for one (pool, scope) at decision time: `confirmed`, `unconfirmed`, `cooling`, `exhausted`, `rationed` or `unauthenticated`. Only the first two are dispatchable.
- **Closure** — a recorded reason a scope is not dispatchable, with the scope it lands on and a horizon.
- **Horizon** — when a closure lapses. **Known** when the provider gave it or it is a ration's exact roll-off; **assumed** when Fleet filled it in. Only a known horizon can justify waiting.
- **Pool ledger** — the append-only per-pool record that standings are derived from.
- **Admission critical section** — the single locked step that takes a concurrency slot and a ration claim together.

## Decisions

### 1. Scarcity is enforced by rations, not by allowance estimates

Fleet gates on what it can count exactly: its own dispatched attempts, per pool, per rolling window. Remaining provider allowance is learned only from the provider — the Codex probe before dispatch, or a rejection after it. Local burn estimates are reported, never gated on, which keeps the baseline #5 rule that Go burn is never routed on.

Model scarcity is configuration: a pool's ration plus the routing rank [#57](https://github.com/Kylevdm/pi-fleet/issues/57) sorts on. It is never inferred from observations.

### 2. Allowance state is tracked per (pool, scope)

An `allowance-exhausted` failure closes the narrowest scope the provider named — a Go model via `limitName` — and the whole pool when it names none. This refines #52's "pool-fatal means the pool is out" to "the scope is out". Rations stay per pool.

### 3. An unknown probe answer makes the pool unconfirmed, not closed

`ordinaryUsageAllowed: null`, a failed or timed-out probe, and a snapshot older than the 60 s TTL all leave a Codex pool **unconfirmed** — the same standing as a pool without a probe: dispatchable, learned by rejection, ration still applies. It never becomes confirmed. An explicit `false` closes the pool until `resetsAt` and the next probe waits for that time. A probe auth error (`-32600`) is `authentication`.

### 4. A closed eligible set means a bounded wait

When every pool eligible for a stage is closed, the job waits if the earliest known reset horizon is within a configured bound (default 30 minutes), and otherwise returns to the orchestrator carrying that horizon. An unknown horizon returns. Waiting for Fleet's own concurrency slot always waits, since another job finishing frees it.

### 5. `plan-allowance` is an attestation that the account stops at its limit

Codex credits, Claude extra usage and Go's "Use balance" can each carry a run past the included allowance, so a successful run proves nothing about it. Declaring a pool `plan-allowance` attests that overflow is off; it is a documented pool precondition. Codex is enforced regardless (`ordinaryUsageAllowed: false` closes the pool even when credits would carry the run); the ration is the backstop for Claude and Go.

### 6. No per-pool concurrency limit in v1

The ration bounds drain; provider-side concurrency limits surface as `rate-limited`. The existing global and per-repository limits become configured rather than hardcoded.

### 7. Authentication failure closes a pool until an auth check passes

`claude auth status`, Codex `account/read`, or Pi `get_available_models`, re-run at dispatch at most once per recheck interval. Jobs never wait on authentication: they re-route, or return with a reason naming the fix.

### 8. Six standings per (pool, scope)

| Standing | Dispatchable | Clears |
| --- | --- | --- |
| `confirmed` | yes | TTL lapse → `unconfirmed` |
| `unconfirmed` | yes | — |
| `cooling` | no | at the cooldown horizon |
| `exhausted` | no | at the reset horizon |
| `rationed` | no | exactly, when the oldest counted attempt leaves the window |
| `unauthenticated` | no | when an auth check passes |

A closure lands on the narrowest scope its evidence names; a pool-wide closure applies to every model in the pool. With several live closures the scope reopens at the latest horizon, and every live closure is kept for the explanation. `rationed` stays distinct from `exhausted` because one is Fleet's limit and the other the provider's. Whether `confirmed` sorts ahead of `unconfirmed` is [#57](https://github.com/Kylevdm/pi-fleet/issues/57)'s call.

### 9. A ration is a set of rolling windows, counted at dispatch, and always declared

A ration is a list of `(attempts, window)` pairs, each rolling — `4 per 5h` plus `20 per 7d` mirrors Claude's two windows. A pool is `rationed` while any of its windows is full. An attempt counts at dispatch and is never refunded, even when it fails before reaching the provider: conservative, and still exact. Every pool must declare a ration; `"unlimited"` is legal but must be written, so no self-limit is never a default.

### 10. An append-only pool ledger, claimed inside one admission critical section

Each pool has an append-only ledger (`pools/<poolId>.jsonl`) of ration claims, allowance snapshots, closures, auth checks and attempt results. Standing is derived from it at decision time; no mutable file is authority, following baseline #5's rejection of a mutable stats file as sole authority. The 60 s Codex snapshot cache is simply the latest `snapshot` entry, so it is shared across supervisors and survives a crash. Compaction — rename-committed, under the lock — drops entries whose effect has lapsed and that are older than the longest ration window.

One **admission critical section**, under a store lock, takes the concurrency slot and the ration claim together, and only when a dispatchable scope exists. The current `acquireCapacity` has no lock at all; that live race is filed separately as [#69](https://github.com/Kylevdm/pi-fleet/issues/69), off this map.

### 11. Transient failures cool a scope; they never touch the job's budget here

| Class | Effect on the scope |
| --- | --- |
| `rate-limited` with `retryAfter` | `cooling` until then, on the first occurrence; the Codex snapshot is evicted (#65) |
| `rate-limited` without a hint | `cooling` for a configured default, 15 min — harnesses retry internally first (Codex ~45 s), so a surfaced one has persisted |
| `overloaded`, `provider-error` | breaker: 3 consecutive on a scope → `cooling` for 30 min; any success resets the count (baseline #5 numbers) |
| `allowance-exhausted` | `exhausted` (decision 2); never feeds the breaker (baseline #5) |
| `authentication` | `unauthenticated` (decision 7) |
| `invalid-request`, `tool-policy`, `cancelled`, `unknown` | none |

What each class does to the *job* is [#55](https://github.com/Kylevdm/pi-fleet/issues/55)'s.

### 12. A closure with no horizon gets an assumed one, which never justifies waiting

When a closure carries no horizon — a Claude limit message the pattern table cannot parse, a Go rejection without `retry-after` — the scope closes for a per-pool `assumedReset`, defaulting to the provider's shortest window (5 h for Claude and Go), then returns to `unconfirmed`; the next rejection closes it again. A horizon is therefore **known** (provider-given, or a ration's exact roll-off) or **assumed**, and for the wait decision an assumed horizon counts as unknown, so the job returns. A half-open reopening was rejected: each test costs a ration attempt and a job's time.

### 13. Two waiting reasons split by what ends the wait

- `capacity` — Fleet's own slots; ends when another job finishes; no horizon.
- `pool-recovery` — renamed from `provider-recovery`; covers `exhausted`, `rationed` and `cooling`. A spent ration is not a provider recovering, and "pool" is Fleet's own term, not a provider name.

A job waiting on `pool-recovery` records `resumesAt` and the closures it waits on. How the envelope presents them belongs to [#59](https://github.com/Kylevdm/pi-fleet/issues/59) and [#54](https://github.com/Kylevdm/pi-fleet/issues/54).

### 14. The waiting supervisor stays alive, and pool waiting is capped per stage

The supervisor keeps its fenced lease and sleeps to `resumesAt` for a pool wait, or re-checks on a short interval for a capacity wait. It gives up its concurrency slot while waiting. A crashed sleeper is recovered by the same path as any supervisor crash. No scheduler daemon; no reliance on the primary calling back.

The decision-4 bound is **cumulative per stage**: waking into a fresh horizon cannot chain 30-minute waits indefinitely. Once total pool waiting for the stage exceeds the bound, the job returns.

### 15. No Claude status-line bridge in v1

A Claude Code primary on the same account could feed `rate_limits` into the ledger as a `snapshot` through a status-line command — supported, but alive only while an interactive session is, and it ties Fleet to one primary host. Rations carry v1; the ledger already accepts snapshots from any source, so a bridge is a later addition with no schema change.

### 16. Submit never consults pool standing

Admission decides whether a job is admissible; pool standing is dispatch's concern. A job with nothing dispatchable returns within seconds of dispatch, so the primary learns in one `wait` cycle. The `capacity` problem code is defined but never emitted today; its fate is a surface question for [#59](https://github.com/Kylevdm/pi-fleet/issues/59).

### 17. Scarcity configuration is human-owned; automation only recommends

Rations, billing attestations, `assumedReset`, the wait bound, cooldown defaults, the auth recheck interval and the global and per-repository limits live in a `pools` block of `$PI_FLEET_HOME/config.json`, a sibling of the baseline's human-owned `pilot` block. No automation writes it — not the update tooling, not a delegated agent. When the update tooling runs, it reports **recommended** changes derived from ledger evidence (a ration hit every window, a pool that never closes); a human applies them. A ration is the user's statement of how much subscription they will share, and a limit automation can raise is not a limit.

## Handed on

- **Routing** ([#57](https://github.com/Kylevdm/pi-fleet/issues/57)) — receives the dispatchable set: scopes whose standing is `confirmed` or `unconfirmed`. It decides the sort among them, including whether `confirmed` leads, and owns the routing rank that expresses configured scarcity.
- **Retry and escalation** ([#55](https://github.com/Kylevdm/pi-fleet/issues/55)) — owns what each failure class does to the *job*. This note fixes only the effect on the pool. Every retry is a dispatch and counts against the ration.
- **Durable stage contract** ([#60](https://github.com/Kylevdm/pi-fleet/issues/60)) — a stage records `resumesAt`, its live closures and its cumulative pool-waiting time. The pool ledger is store-level, not job-level.
- **Handback and public contract** ([#54](https://github.com/Kylevdm/pi-fleet/issues/54), [#59](https://github.com/Kylevdm/pi-fleet/issues/59)) — how `pool-recovery`, `resumesAt` and a returned job's horizon appear in the envelope; whether a read-only pool-standing query joins the interface; the fate of the unused `capacity` problem code.
- **Telemetry** ([#49](https://github.com/Kylevdm/pi-fleet/issues/49)) — the ledger is operational state and compacts, so it is not an evidence store. Telemetry records its own facts.
- **Configuration schema** (map fog) — the `pools` block's exact shape still waits on the stage and routing decisions.
