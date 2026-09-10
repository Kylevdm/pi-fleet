# Prototype: the two adapter surfaces

Rough. Made to be argued with, not shipped.

## 1. One module, two translators

```text
Codex / Claude  --stdio MCP-->  fleet-mcp  --\
                                              >--  Fleet (TS module)  --> Pi RPC, Git, store
human / scripts --argv+JSON-->  fleet CLI  --/
```

Every tool and every subcommand is a one-line translation of a `Fleet` method.
No adapter holds a state transition, a retry, a routing choice, or a bound.
The bound (how many diff bytes) is a Fleet policy value; the adapter passes the
caller's request through and renders whatever came back.

## 2. The MCP tool surface

Thirteen tools, one per method, named `fleet_<method>`. Schemas are the request
types from ticket 01 with `expectedRevision` required on every mutation.

Every tool result is the same envelope, so the orchestrator learns one shape:

```jsonc
{
  "ok": true,
  "jobId": "01JQ...",          // opaque
  "revision": 7,               // feed back as expectedRevision
  "status": "running",         // the 7 public states only
  "stage": "writing",          // current internal stage, display-only
  "next": ["fleet_get", "fleet_cancel"],   // what is legal right now
  "evidence": { "diff": "art:01JQ.../03/diff", "checks": "art:01JQ.../04/checks" }
}
```

```jsonc
{ "ok": false, "problem": "conflict", "revision": 9, "message": "job moved on" }
```

`problem` is exactly ticket 01's taxonomy: `invalid-input`, `policy-denied`,
`conflict`, `not-found`, `stale-confirmation`, `unavailable-dependency`,
`capacity`. Nothing else ever appears.

`next` is the load-bearing trick: the orchestrator never has to reason about
the state machine to know what it may call. Fleet already knows.

## 3. The CLI surface

Same thirteen verbs, `fleet <verb>`. `--json` prints the envelope above on
stdout, one object, nothing else. Without `--json`, a human-readable render of
the same envelope. Exit code is `0` for `ok`, `1` for a `problem`, `2` for an
unexpected fault.

Legacy: `launch|status|log|diff|resume|land|clean` from `fleet.sh` stay as
deprecated aliases that print a one-line notice to stderr and map onto the new
verbs. Legacy shell jobs (a `meta.json` with no `job.json`, per ticket 03)
appear in `fleet list` flagged `legacy: true` and accept only `get`, `diff`,
and `clean`; every other verb returns `policy-denied`.

## 4. What one job costs the primary orchestrator

This is the destination, so count it. Each row is a round trip through the
primary's context.

| # | Call | Tokens back |
|---|---|---|
| 1 | `fleet_submit` | ~80 (envelope) |
| 2..n | `fleet_get` poll | ~80 each |
| n+1 | `fleet_report` | ~600 (bounded) |
| n+2 | `fleet_diff` | ~1500 (bounded) |
| n+3 | `fleet_accept` | ~80 |
| n+4 | `fleet_land` | ~80 |

Fixed cost: ~2400 tokens. Variable cost: **the polls.** A 40-minute job polled
every 2 minutes is 20 calls — and the real cost is not the 1600 tokens, it is
that the primary must *wake up* 20 times and re-read its own context to decide
whether to poll again.

**Settled.** Long-poll, with no polling fallback. `fleet_wait(jobId,
timeoutSeconds)` clamps to 60 seconds, always returns a normal envelope
(`timedOut: true` on expiry, never an error), and wakes only on
`ready-for-acceptance`, `returned-to-orchestrator`, or `cancelled`.

That does not cut the turn count below a 60-second poll. It cuts hand-back
*latency* to about a second, and it spends no turn on a transition the primary
cannot act on. The ceiling is the one number to revisit if turns, not latency,
turn out to be the binding cost. See the ticket's Answer.
