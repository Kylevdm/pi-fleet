# Wayfinder handoff: redesign Fleet around primary-token savings

## Purpose

Use this handoff to start a Wayfinder map in `/home/kyle/skills`. The redesign
is larger than one grilling session. Chart an implementation-ready specification
and migration route; do not implement the destination unless the map's Notes
explicitly expand its scope.

## Suggested destination

An implementation-ready specification and ordered migration plan for a Fleet
that automatically moves suitable work from Codex or Claude to cheaper Pi
agents, measures whether that delegation actually saves primary-orchestrator
tokens, escalates failed work once, and returns compact evidence for primary
acceptance.

## Start here

Read these sources before charting:

- `fleet/CONTEXT.md` — canonical vocabulary and the decisions already promoted
  into the domain model.
- `fleet/references/model-tier-research.md` — approved model pool, current
  prices, Go allowance semantics, DeepSeek peak pricing, and calibration rules.
- `fleet/references/mcp-control-design.md` — why MCP faces Codex/Claude while
  Fleet controls Pi through RPC.
- `docs/fog.md`, **Fleet / Pi migration follow-ups** — explicitly deferred
  Ollama and container-isolation work, plus stale migration follow-ups.
- `fleet/SKILL.md`, `fleet/scripts/fleet.sh`, and
  `fleet/references/mechanics.md` — current implementation; treat as evidence,
  not the desired design.
- `fleet-update/SKILL.md` and `fleet/evals/` — maintenance surfaces that must be
  replaced or updated with the redesign.

`archive/FLEET-REWORK-HANDOFF.md` describes an older CCS-era migration and is
not authoritative for this redesign.

## Settled decisions

Do not reopen these unless new evidence makes one impossible:

1. The scarce resource is Codex/Claude primary-orchestrator quota. Optimize
   first for primary tokens saved, then accepted-result cost; wall time is
   secondary.
2. The primary orchestrator automatically delegates suitable work when doing
   so is expected to use fewer primary tokens. It keeps trivial work and
   reserved decisions: architecture, domain modeling, security, destructive
   migration, breaking interfaces, production mutation, and ambiguous product
   behavior.
3. `to-tickets` owns parent-issue decomposition. Fleet normally receives one
   GitHub child ticket; its internal assignments are work units. Fleet can also
   accept a standalone objective through a discovery path.
4. A ticket-backed job has one writer. If it needs multiple writers, return it
   as oversized. A standalone discovery job may use independent writer branches
   and a deterministic assembly branch.
5. Fleet is a durable detached state machine owned by Fleet itself, not an
   `agent-pi` dependency. `agent-pi` is inspiration only.
6. Terminal autonomous states are `ready-for-acceptance` and
   `returned-to-orchestrator`. The primary accepts the whole job and performs a
   separate explicit land action. Fleet never pushes or mutates GitHub issues.
7. Direct tickets skip discovery. Unclear standalone work may use at most two
   parallel read-only scouts, one planner, isolated writers, and reviewers.
8. Low-risk work starts economy and escalates to standard. Medium-risk work
   starts standard and escalates to premium. A first quality failure escalates
   immediately; a second returns the work to the primary. There is no repair
   turn or third delegated attempt.
9. Infrastructure failures—authentication, provider outage, allowance, invalid
   endpoint—consume time/cost but not a quality attempt. Try another approved
   model in the tier first.
10. Scouts start economy because they are read-only. Other essential roles
    start at the job's risk tier. Reviewers use the writer's tier and a different
    family where possible. A reviewer rejection fails the writer attempt.
11. Process and checks scale with risk. Ticket criteria and repository
    instructions are additive and cannot be weakened by delegated agents.
12. Primary acceptance normally reads a compact report, acceptance criteria,
    diff summary, checks, and reviewer findings. It opens the full diff or runs
    a full review for medium-risk, warned, surprising, or escalated work.
    Project-level code review occurs between releases.
13. Initial limits: three active writers globally, one writer per repository by
    default, 15 minutes per scout, 15 minutes for planning, 60 minutes per
    writer, 30 minutes per reviewer, and three hours per job. The initial pilot
    has no invented token/dollar ceiling.
14. Initial tier pools are exactly those in
    `fleet/references/model-tier-research.md`. Rotate comparable work toward the
    least-sampled model per tier, role, and risk cohort until evidence is
    sufficient and the user invokes `fleet-update`; there is no calendar
    deadline. Use normal model settings initially and record them.
15. Output-token price provides the initial ordering, but economy, standard,
    and premium are operational positions. `fleet-update` alone promotes,
    demotes, or tunes models. GLM-5.2 is initial premium recovery on Go; direct
    DeepSeek is separate-wallet premium recovery or overflow.
16. Models whose prompts or completions may be used for training are excluded.
    Qwen work stays below 256K. Direct DeepSeek Flash and Pro remain approved,
    with peak/off-peak cost recorded separately.
17. Worktrees isolate Git changes, not the filesystem or network. Delegated
    agents receive no GitHub credentials or Fleet-control tools. True worker
    isolation and local Ollama models are deferred in `docs/fog.md`.
18. Input snapshots, stage artifacts, sessions, model/token/cost telemetry,
    checks, review, reports, and commit references live outside the repository.
    Stage artifacts are immutable and schema-validated. Resume starts after the
    last sealed stage and never repeats a paid call implicitly.
19. Storage initially uses per-job directories, atomic manifests, and filesystem
    locks rather than a database. Detached per-job supervisors continue after
    CLI/MCP clients exit and coordinate global capacity through leases.
20. The Fleet module is a TypeScript deep module. A JSON CLI and local stdio MCP
    server are thin northbound adapters; Pi JSONL RPC or the Pi SDK is the
    southbound adapter. Keep `fleet.sh` only as a compatibility shim.
21. MCP exposes typed submit, list/get, report, bounded diff/check evidence,
    continue, cancel, accept, land, clean, archive, and guarded purge. Submission
    returns after durable admission. There is no generic exec tool. Pi-side MCP
    is opt-in only for a specific externally integrated work unit.
22. MCP and CLI share the Fleet module. Status/report results are bounded and
    redact credentials. MCP is local stdio, repository-root allowlisted, audits
    mutations, and registers in Codex/Claude through an explicit reversible
    setup command or snippet.
23. Pin the original base. Before acceptance, validate proposed commits in a
    temporary worktree at the current target and rerun required checks. Conflicts
    return the job; refreshed evidence requires acceptance.
24. Deduplicate active GitHub jobs by repository identity plus issue number.
    Similar standalone requests warn rather than hard-fail.
25. `clean` removes disposable worktrees but retains records and branches;
    `archive` marks a terminal record inactive; `purge` is a two-step destructive
    action. Its preview includes branches, and deleting unlanded branches needs
    explicit acknowledgement.
26. Cancellation stops active Pi processes, seals available evidence, preserves
    branches and records, and returns the job to the orchestrator.
27. Legacy shell-script jobs are read-only: list, inspect, diff, and safe clean.
    The new state machine will not resume or land them.
28. Users may force local execution, force Fleet, or select an approved starting
    tier/model. Overrides cannot bypass privacy, reserved-work, review, check, or
    attempt rules.
29. Tests cross the Fleet module's small interface with fake Pi, Git, clock, and
    provider adapters, plus adapter contract tests and a small real-worktree
    integration suite. Live provider probes are explicit maintenance checks.
30. Implementation must update the whole maintenance surface coherently: Fleet
    module, compatibility CLI, MCP and setup, `fleet`, `fleet-update`, mechanics,
    ADRs, and evals.

## Proposed map frontier

These questions are now sharp enough to consider as initial child tickets.
Wayfinder should adjust their grouping and blocking edges rather than re-grill
the settled policy above.

1. **Define the Fleet module interface** (`wayfinder:grilling` or prototype):
   exact operations, arguments, result envelopes, invariants, and errors shared
   by CLI, MCP, and tests.
2. **Specify the state machine and recovery protocol** (`wayfinder:grilling`):
   complete states and transitions, leases, cancellation, resumption,
   idempotency, terminal-state continuation, and stage sealing.
3. **Specify durable schemas and filesystem layout** (`wayfinder:prototype`):
   versioned manifests, artifacts, locks, audit records, legacy recognition,
   redaction, and atomic-write/crash behavior.
4. **Specify routing and evaluation mechanics** (`wayfinder:grilling`): exact
   registry schema, cohort selection, risk classification inputs, availability
   fallback, Go normalized-burn accounting, DeepSeek rate bands, and the data
   consumed by `fleet-update`.
5. **Specify the Pi work-unit protocol** (`wayfinder:prototype`): Pi RPC
   lifecycle, role briefs, tool policy, structured output schemas, timeouts,
   usage capture, process termination, and failure classification.
6. **Specify Git isolation, assembly, refresh, and landing**
   (`wayfinder:prototype`): branch naming, one-writer enforcement, deterministic
   assembly, integration escalation, current-target validation, dirty-tree
   safety, cleanup, archive, and purge.
7. **Specify GitHub ingestion and deduplication** (`wayfinder:grilling`): trusted
   snapshot acquisition, parent/ticket/blocker representation, blocker refresh,
   credential separation, and active-job identity.
8. **Design the CLI and MCP adapters** (`wayfinder:prototype`): compact schemas,
   asynchronous polling, output bounds, destructive-operation confirmation,
   Codex/Claude registration, and CLI compatibility.
9. **Plan the TypeScript packaging and migration** (`wayfinder:grilling`): build
   and installation path, shell shim, old-job behavior, configuration migration,
   atomic cutover, and rollback.
10. **Define verification and rollout gates** (`wayfinder:grilling`): interface
    tests, Git integration fixtures, adapter contracts, provider preflights,
    skill evals, acceptance criteria, and evidence required before automatic
    delegation becomes the default.

Likely dependency shape: module interface first; state and schema can then run
in parallel; routing, Pi protocol, Git, and ingestion depend on those; CLI/MCP
depends on the interface and state; packaging and verification close the map.

## Not yet specified

- Whether detailed design reveals a need for a long-lived scheduler rather than
  detached per-job supervisors. The settled default remains no daemon.
- Whether Pi tool restriction is strong enough for the accepted command policy
  without a custom extension. Resolve while specifying the Pi work-unit
  protocol.
- Exact TypeScript build/distribution mechanics and dependency policy.
- Exact threshold calculation when cohorts receive sparse or non-comparable
  work; the minimum evidence remains 10 comparable attempts, with 20 preferred.
- How refreshed target-branch validation interacts with acceptance when checks
  are expensive or nondeterministic.

## Out of scope for this map

- Depending on or copying `agent-pi`.
- Local Ollama routing in the first release.
- Containerized/process-sandboxed workers in the first release.
- Automatic tier promotion or scheduled `fleet-update`.
- GitHub issue mutation, pushing, or closing by Fleet.
- Replacing project-level release reviews.

## Workspace state

No Fleet implementation has been started. The grilling session changed or
created only design artifacts:

- modified: `fleet/CONTEXT.md`
- modified: `docs/fog.md`
- untracked: `fleet/references/model-tier-research.md`
- untracked: `fleet/references/mcp-control-design.md`

Pre-existing unrelated user changes move the `fog` skill into
`.agents/skills/fog/`. Preserve them:

```text
R  fog/SKILL.md -> .agents/skills/fog/SKILL.md
R  fog/assets/fog.md -> .agents/skills/fog/assets/fog.md
R  fog/docs/adr/0001-standalone-cross-map-fog-ledger.md -> .agents/skills/fog/docs/adr/0001-standalone-cross-map-fog-ledger.md
R  fog/references/glossary.md -> .agents/skills/fog/references/glossary.md
```

## Suggested skills

- `wayfinder` to chart and work the map.
- `grilling` and `domain-modeling` for decision tickets.
- `codebase-design` for the Fleet module interface and seams.
- `prototype` for schemas, state transitions, Pi RPC, and Git assembly behavior
  that need concrete validation.
- `research` only when a ticket needs current external facts.
- `writing-for-agents` and `skill-creator` when the map reaches skill design.
- `fleet-update` during implementation, after it has been redesigned as part of
  the planned cutover.
- `unslop` for every written artifact.

## Completion criterion for the Wayfinder map

The route is clear when every external interface, state transition, storage and
recovery invariant, routing rule, Git operation, security guardrail, migration
step, and verification gate is decided and indexed by the map, with no remaining
implementation-blocking fog. The resulting artifact must be sufficient for a
fresh implementation session to execute without inventing product or
architecture policy.
