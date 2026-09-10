# Verification and rollout gates

Settled by [Define verification and rollout
gates](../../tickets/10-define-verification-and-rollout-gates.md), 2026-09-10.

Two structures. A **ladder** of standing suites that every build ticket must
leave green, and a **staircase** of four rollout stages whose advances are
gated on pilot evidence. The ladder proves the module against itself; the
staircase proves it against real work.

## The ladder

A fixed ladder, not per-ticket criteria. A bespoke gate cannot catch a
regression a later ticket causes, and the ladder is what actually gets re-run.
Each build ticket says which rungs it extends; none defines its own notion of
done.

| Rung | What runs | Where |
| --- | --- | --- |
| 0 | `tsc --noEmit` | CI + local |
| 1 | Fixture suite over the faked Pi and GitHub seams | CI + local |
| 2 | Real-worktree integration invariants | CI + local |
| 3 | Adapter conformance, parameterised over CLI and MCP | CI + local |
| 4 | Live Pi smoke and fixture-drift check | Hand-run only |
| 5 | Module evals (`evals/evals.json`) | Hand-run, blocks stage advance |

Rungs 0-3 are hermetic and run on push and PR through a minimal GitHub Actions
workflow. Rungs 4 and 5 never run in CI: `pi-fleet` is public, and a PR must
not be able to spend the maintainer's allowance.

### Faked and real

Real filesystem, real git, real Node child processes. Ticket 03's safety
argument is rename-commit and `O_APPEND` semantics, and ticket 06's namespace
rule is a claim about refs — a fake store or fake git would paper over exactly
the properties under test. Tmpdirs are cheap; fidelity here is not optional.

Two seams are faked:

- **Pi** — a scriptable stand-in binary emitting a recorded JSONL event
  stream, seeded from the ticket 05 spike's live capture and pinned as a
  golden fixture.
- **GitHub** — recorded issue-snapshot fixtures, which ticket 07's
  fetch-its-own-trusted-snapshot design already makes the natural seam.

The clock is injected, never faked globally.

### Substituting the fake

One resolved `piBinary` (config, overridden by `PI_FLEET_PI_BIN`), resolved
once at supervisor start and **recorded in the call intent alongside the
detected Pi version**. Tests point it at the stub. An attempt record that
cannot say which binary produced it is not evidence.

The golden fixture names the Pi version it was captured from. Rung 4's
drift check fails when the live binary's version differs from the fixture's,
which turns a Pi upgrade into a gate event rather than a silent divergence —
the failure mode that already left `references/mechanics.md` stale.

## Rung 1 manifest

The mechanical claims of the closed tickets, each cheap to prove against
fixtures. A missing test is as red as a failing one.

1. Failure classification either side of `agent_start` — infrastructure before,
   quality after (ticket 05).
2. Usage summed across every assistant message. The spike's final-message
   under-count (5,970 vs 41,503 tokens) ships as a regression fixture.
3. `agent_settled`, not `agent_end`, ends a run.
4. JSONL framing splits on LF only. A U+2028 inside a JSON string is a fixture
   that must not split the frame.
5. Launch timeout to first `agent_start`.
6. Termination escalates `abort` → SIGTERM → SIGKILL and records the rung
   reached.
7. A stage seals only on a schema-valid `submit_*` tool result. Prose in the
   final assistant message never seals.
8. Three blocked commands in one stage is a quality failure; one or two are
   recorded and legible to the model.
9. The four-key routing sort is deterministic and explainable from one log line
   (ticket 04).
10. Three consecutive non-exhaustion infrastructure failures put a model in
    cooldown; `exhausted` does not.
11. An availability escalation never consumes a quality attempt.
12. Admission is refused while a GitHub blocker is open, and the dedup key is
    held through acceptance (ticket 07).

## Rung 2 manifest

Real git, real refs, each test traceable to the ticket that decided it.

1. **Namespace rule** — all refs snapshotted before and after a job; nothing
   outside `refs/heads/fleet/<jobId>/` changes, including at landing.
2. Single-writer lease per ticket-backed job.
3. Reviewer worktree is detached at the writer's sealed sha and cannot mutate
   what it judges.
4. Assembly cherry-picks in the planner's declared order and re-checks the
   assembled tree.
5. A moved target rebases and **re-checks only** — delegated review is not
   re-run.
6. A second target move during a refreshed check returns the job immediately.
7. `land` produces a fast-forwardable candidate and moves no ref.
8. `clean` keeps every branch; `purge` deletes them only behind ticket 03's
   acknowledgement.
9. `SIGKILL` of the supervisor mid-stage resumes from the last seal and never
   re-runs a sealed stage.
10. A torn write leaves the last good revision readable.

A new invariant decided later means a new named test. That is the mechanical
link between a decision and its proof.

## Rung 3: adapter conformance

One suite, parameterised over both adapters, because a contract tested twice
drifts. It asserts:

- the envelope shape is identical across CLI `--json` and MCP;
- `problem` never takes a value outside ticket 01's seven;
- `next` is always legal for the reported state;
- `wait` returns `ok` with `timedOut: true` at the 60-second clamp, never an
  error.

Anything an adapter can do that the module cannot is a bug this suite must be
able to see.

## Skill evaluations

Two gates on different clocks, following ticket 09's split of the eval files.

- `evals/evals.json` (module behaviour) moves to `pi-fleet` and is rung 5. It
  blocks a stage advance.
- `evals/trigger-evals.json` (skill triggering) stays in `~/skills` and blocks
  only the step-5 deletion commit — the moment `fleet/SKILL.md` is rewritten
  and triggering can regress.

They are not coupled.

## Provider preflight

`probe` spends real money per candidate, so it is a **stage-advance gate, not a
ladder rung**. Before each advance, every `enabled` model in the shipped
registry must probe green, or be disabled in the overlay first. A failing model
does not block the advance; it blocks being enabled during it. Re-run on any
registry change, never on a schedule — scheduled `fleet-update` is out of
scope for this map.

## The staircase

Autonomy is staged, not features.

| Stage | Delegation | Risk ceiling | Concurrency | Repos |
| --- | --- | --- | --- | --- |
| S0 | Hand-submitted only | `low` | 1 | 1 |
| S1 | Primary may delegate | `low` | 1 | 1 |
| S2 | Primary may delegate | `standard` | 2 | 2 |
| S3 | Default for suitable work | per risk class | configured | configured |

### Advance criteria

Acceptance is the human's accept, not Fleet's own reviewer verdict.

- **S0 → S1**: full ladder green, rung 4 smoke green, probe clean, and 5
  hand-submitted jobs accepted with zero namespace violations and no
  unexplained return.
- **S1 → S2**: 10 delegated `low`-risk jobs, acceptance at or above 70%
  first-pass or after one escalation, no halt trigger fired in the window, no
  record-integrity incident.
- **S2 → S3**: 20 further jobs across at least two repositories and both risk
  classes, cohort maturity at least `provisional` for the writer cohorts in
  use, and a trailing acceptance rate that does not fall across the window.

The thresholds are the cheapest defensible ones. The scheme is small-N by
design — ticket 04 already sets 10 and 20 for cohort maturity — so the gate is
the shape of the evidence, and the numbers are meant to be argued down rather
than up.

### The cutover is the S0 → S1 advance

Ticket 09's step 5 — the single deletion commit — **is** this advance, on the
same evidence, as one event. During S0 every job is hand-submitted, so the
frozen `fleet.sh` costs nothing by continuing to exist; after the commit the
fallback is the `pre-fleet-ts` revert. Two separate readiness judgements would
drift apart.

## Halt and abort

Two severities.

**Halt** demotes the pilot one stage; delegation continues under tighter
limits. Triggers, with defaults:

- trailing acceptance below 60% over the last 5 jobs;
- 2 consecutive jobs returned with the same failure class;
- delegated spend above $5 in a day.

Re-advancing after a halt runs the same advance criteria as a first advance,
with the window reset to jobs after the halt. A halt is a demotion in every
sense, not a pause — otherwise a flapping pilot ratchets back up on noise.

**Abort** is the integrity class: any ref written outside the Fleet namespace,
any write outside Fleet's four subtrees, or any record loss or corruption. On
detection Fleet refuses further admission with `policy-denied`; the human runs
ticket 09's rollback surface — revert the deletion commit or reset to
`pre-fleet-ts`, `npm unlink`, `fleet mcp uninstall`. Abort is
manual-but-mandatory: Fleet undoing its own installation unattended is a worse
failure mode than the one it would be reacting to.

## Pilot limits

A `pilot` block in `$PI_FLEET_HOME/config.json`, a sibling of — never inside —
ticket 04's registry overlay. Different lifecycle: human-owned, and
`fleet-update` never touches it.

```jsonc
"pilot": {
  "stage": "S1",
  "riskCeiling": "low",
  "maxConcurrentJobs": 1,
  "repoAllowlist": ["/home/kyle/skills"],
  "dailySpendCeiling": 5.00
}
```

Enforced at `submit` admission, refusing with `policy-denied` naming the limit
hit. A limit a human has to remember is not a gate.

The active stage is stamped on **every attempt record**, so the evidence log can
be sliced by stage. Without it, S1 and S3 attempts blur and the acceptance-rate
trend becomes unreadable.

## The stage report

`fleet evidence --stage-report` computes the advance and halt numbers: jobs in
the window, first-pass and post-escalation acceptance rates, halt-trigger
status, probe freshness, and the current stage's limits. Every field is already
in the log. A gate a human has to tally by hand stops being run around S2.

## Warnings and review depth

The signals that currently have nowhere to land — an agent raising the risk
class, an escalation consumed, the reviewer family constraint dropped, the
integration rung used, a blocked command, a refresh rebase, `overridden: true`
— reach the primary as a closed enum on ticket 08's envelope, plus a derived
`reviewDepth`.

| Code | Effect |
| --- | --- |
| `risk-raised-by-agent` | elevates |
| `escalation-consumed` | elevates |
| `reviewer-family-constraint-dropped` | elevates |
| `integration-rung-used` | elevates |
| `command-blocked` | elevates |
| `availability-rotation` | informational |
| `refresh-rebased` | informational |
| `model-overridden` | informational |

`reviewDepth: "elevated"` means the primary reads the diff itself rather than
accepting on summary plus green checks. The enum is closed under the same
discipline as ticket 01's `problem` taxonomy — nothing else ever appears, and
adding a code is an interface amendment.

## Test runner

`node:test` and `node:assert`, no dependencies, run under the same
`--experimental-strip-types` flag as `bin/fleet`. The repository's premise is
that the source is the shipped code; a runner with its own transform pipeline
reintroduces precisely the staleness that premise exists to prevent. Swapping
to Vitest later is reversible if the ergonomics bite.

## Depends on an open decision

Every gate that mentions checks — rung 2's assembly and refresh re-checks, and
the acceptance rates in the advance criteria — runs the repository's real check
command. Where that command comes from is not settled by any closed ticket and
is not settled here; see [Specify check-command discovery and the checking
stage contract](../../tickets/16-specify-check-command-discovery.md). Gates
require only that it is the real command and never a stand-in.
