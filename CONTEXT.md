# Fleet

The fleet moves suitable work from the primary orchestrator to lower-cost
agents while reserving the primary orchestrator for coordination and
reasoning-heavy work, and spends each subscription pool's allowance
deliberately. The Fleet module in this repository manages that work from
handoff through acceptance.

## Language

**Fleet**: the lower-cost agents and orchestration used to complete suitable
work outside the primary orchestrator. A fleet job may start from a ticket or
from a standalone request that must first be investigated and divided.
_Avoid_: agents, workers.

**Primary orchestrator**: the Codex or Claude session that owns coordination,
reasoning-heavy work, high-risk decisions, and final acceptance. Its token use
is the fleet's scarce resource. _Avoid_: primary agent, main agent.

**Suitable work**: work expected to consume fewer primary-orchestrator tokens
when handed to the fleet than when completed in the primary session. It may
include investigation, planning, implementation, testing, documentation, and
review. _Avoid_: cheap task, simple task.

**Reserved work**: decisions the primary orchestrator keeps because they
involve architecture, the domain model, security, irreversible operations,
breaking interfaces, production changes, or unresolved product intent. Fleet
may implement a bounded ticket after the decision is made. _Avoid_: hard task,
unsupported task.

**Delegated agent**: one unattended harness run in a pool, editing inside its
own worktree. It sees the repository and its conventions, and nothing of the
orchestrator's conversation. _Avoid_: sub-agent, worker.

**Parent issue**: the GitHub issue that `to-tickets` divides into tracer-bullet
tickets. Fleet usually works below this level and does not own or close the
parent issue. _Avoid_: main issue.

**Ticket**: a tracer-bullet slice produced by `to-tickets`, often published as
a GitHub sub-issue with blockers and acceptance criteria. It is sized for one
fresh context window. _Avoid_: sub-issue, chore, task.

**Fleet job**: one ticket or standalone request being completed through the
fleet. Lower-cost agents may investigate and divide it into private work units,
but the primary orchestrator accepts the fleet job as a whole. _Avoid_: run,
parent issue.

**Work unit**: a private assignment to one delegated agent inside a fleet job,
such as scouting, planning, implementation, or review. A work unit is not
published to the issue tracker. _Avoid_: ticket, subtask.

**Input snapshot**: the immutable issue or request context captured for a
fleet job before delegated work begins. Fleet acquires it itself from a bare
ticket reference rather than receiving it from the primary orchestrator, so its
fidelity is verifiable. For a GitHub ticket it holds the ticket, comments,
parent issue, and blockers, and it exposes no GitHub credential to delegated
agents. It is authoritative for the whole job: never re-fetched, never patched.
_Avoid_: brief, context dump.

**Tracker conformance**: what an issue tracker must expose for Fleet to admit
its tickets, stated as capabilities rather than as one tracker's nouns — a
machine-readable parent relation and a machine-readable blocker relation.
Blockers are mandatory, because an unbacked blocker starts a writer on
unfinished ground; the parent relation is recommended, because losing it costs
the writer scope context but nothing unsafe. _Avoid_: tracker support, GitHub
requirements.

**Unverifiable blocker**: a ticket's own claim to be gated by work that no
native tracker relation backs. Fleet refuses to admit it, distinctly from
refusing work with a genuinely open blocker, because the two ask different
things of the human: an open blocker means wait, an unverifiable one means fix
the tracker. Prose is read only to raise this refusal and never to satisfy a
gate — it can refuse admission, never grant it. _Avoid_: missing blocker,
broken dependency.

**Repository identity**: the stable identity of the repository a fleet job acts
on, unchanged by a rename or transfer. It is what Fleet deduplicates active
ticket jobs by, scopes repository writer capacity to, and records on routing
evidence. _Avoid_: repo path, remote URL.

**Direct path**: the fleet-job path for a ticket that already has enough
context and acceptance criteria for a writer to act. _Avoid_: simple path,
fast path.

**Discovery path**: the fleet-job path for work that first needs repository
investigation or decomposition before a writer can act. _Avoid_: planning
mode, complex path.

**Acceptance**: the primary orchestrator's determination that a fleet job as a
whole satisfies the user's objective. Delegated agents may review parts of the
job, but they do not own acceptance of the whole. Work waits in its isolated
branch until the primary orchestrator accepts and lands it. _Avoid_: review,
approval.

**Acceptance contract**: the checks and review required before work can count
as complete. The contract scales with the risk and scope of the work rather
than imposing one process on every fleet job. _Avoid_: definition of done,
quality gate.

An acceptance contract is additive: ticket criteria and repository
instructions cannot be weakened by a delegated agent. Planners and reviewers
may add checks. Fleet automatically runs only repository-defined, documented,
or explicitly allowlisted commands; external mutations stay reserved.

**Risk class**: the minimum scrutiny and starting model tier for a fleet job.
Low-risk work is mechanical or tightly bounded with deterministic checks;
medium-risk work may span files or alter behavior whose intent is already
decided; reserved work stays with the primary orchestrator. A delegated agent
may raise the initial class but never lower it. _Avoid_: difficulty, model tier.

**Brief**: the prompt that assigns a work unit to a delegated agent. Because
the harness reads the repository's own conventions, briefs can stay terse.
_Avoid_: ticket, work unit.

**Handoff**: passing a work unit to an agent so it can run without the
orchestrator's conversation, trusting the repository's CLAUDE.md/AGENTS.md to
carry its conventions. _Avoid_: delegation (delegation is the act; handoff is
the artifact and its transport).

**Escalation**: after a lower-tier agent fails a work unit, Fleet gives the
work and its failure evidence to one higher-tier agent. When the failure was
failed checks or a reviewer's rejection, the escalated attempt builds on the
failed commit; otherwise it starts from the pinned base. If that attempt also
fails, the primary orchestrator takes the work back. _Avoid_: retry loop,
repair turn.

**Availability escalation**: moving a work unit to a higher tier because every
candidate tried in its own tier was unavailable, not because its work was
judged inadequate. It is counted separately from escalation, so a provider
outage never consumes the job's one quality escalation. _Avoid_: escalation,
fallback.

**Failed attempt**: an agent attempt that crashes, times out, produces no
relevant change, fails its required checks, violates its scope or acceptance
criteria, or is rejected by its reviewer. A failed attempt escalates rather
than receiving an agent repair turn. _Avoid_: error (too narrow), retry.

**Infrastructure failure**: an attempt that cannot begin because its model or
provider is unavailable, unauthenticated, out of allowance, or incorrectly
configured. It consumes elapsed-time and cost budgets but not one of the two
quality attempts. Fleet tries another approved model in the tier before moving
up. _Avoid_: failed attempt, agent failure.

**Exhaustion**: the closure of a pool scope whose plan allowance has run out.
It is a funding condition rather than a statement about the model, so it makes
the scope ineligible until its horizon without counting against the model's
reliability or feeding the cooling breaker. _Avoid_: outage, infrastructure
failure (exhaustion is one kind of it).

**Ready for acceptance**: the terminal fleet-job state in which implementation,
checks, and delegated review have completed and the primary orchestrator has
received the evidence needed to accept or reject the work. _Avoid_: done.

**Returned to orchestrator**: the terminal fleet-job state in which autonomous
work has stopped because both agent tiers failed or the job requires a decision
reserved for the primary orchestrator. _Avoid_: failed, blocked.

**Oversized job**: a ticket-backed fleet job whose planner concludes the work
needs more than one writer. It is returned to the primary orchestrator with the
proposed decomposition as evidence, spending no writer attempt; Fleet neither
splits it nor publishes tickets for it. _Avoid_: too big, failed attempt.

**Job record**: the retained input, stage outputs, sessions, usage, check and
review results, and branch references for one fleet job. Cleaning working
directories does not delete this record. _Avoid_: log, report.

**Stage artifact**: a schema-validated, immutable result from one completed
orchestration stage. Fleet seals it before advancing and resumes after failure
from the last sealed stage rather than repeating paid work. _Avoid_: agent
message, transcript.

**Transcript**: the record Fleet writes for one stage attempt from its runner
adapter's events. It records how a stage reached its artifact and is never the
artifact itself, never the sealed evidence, and never read to determine an
outcome. A harness's own session file is at most a diagnostic pointer.
_Avoid_: log, session, event stream.

**Event stream**: the live runner events Fleet consumes during a stage to
classify failure and sum usage, then discards. _Avoid_: transcript, log.

**Stage plan**: the ordered set of orchestration stages recorded at admission.
A direct job omits discovery stages. A discovery job may include read-only
scouting and planning before writing. _Avoid_: workflow, pipeline.

**Stage state**: the durable state of one planned stage. A stage is `planned`,
`active`, or `sealed`. Fleet never reruns a sealed stage. _Avoid_: job state,
attempt.

**Supervisor lease**: an expiring ownership record for a job supervisor. Its
owner and generation fence state writes, so a replacement supervisor can resume
a job after the old lease expires without allowing two supervisors to act.
_Avoid_: lock, daemon lease.

**Capacity lease**: a durable claim on a configured role limit. A writer holds
one global writer lease and one repository writer lease only while its writer
stage is active. _Avoid_: job slot, quota.

**Call intent**: the atomically recorded identity and timeout of an external
paid call — a stage attempt or a helper — before Fleet starts it. A recovering
supervisor reconciles that exact call once and never submits a replacement
paid call implicitly. _Avoid_: retry record, request log.

**Assembly branch**: the integration branch for a standalone discovery-path
job with multiple independent writers. Fleet cherry-picks their successful
commits in the planner's declared order; conflicts enter the normal integration
escalation ladder. _Avoid_: primary branch, shared worktree.

**Job budget**: the maximum fan-out, attempts, tokens or catalog cost, and
elapsed time allowed for one fleet job. An essential work unit gets at most two
quality attempts on adjacent tiers. The initial pilot uses structural and time
limits while it gathers evidence for credible token and cost ceilings. _Avoid_:
quota, timeout.

**Model tier**: an operational routing position based on the role a model has
proven it can perform at acceptable cost: economy, standard, or premium. Output
price orders candidates for evaluation, but evidence may move a model to a
different routing position. _Avoid_: price band, quality label.

During calibration, Fleet rotates comparable work toward the least-sampled
eligible model for the same role and risk class. Rotation has no calendar
deadline: it continues until the evidence threshold is met and the user invokes
`fleet-update` to change routing.

**Economy tier**: the cheapest evaluated routing position trusted for a first
attempt on low-risk suitable work. If it does not produce acceptable work, the
work escalates immediately. _Avoid_: weak model, disposable attempt.

**Standard tier**: the normal implementation position and the first escalation
target for failed economy work. Medium-risk suitable work starts here. _Avoid_:
default model, mid-tier price band.

**Premium tier**: the allowlisted recovery position for work that fails at the
standard tier. It includes proven OpenCode Go or direct DeepSeek models; a
second delegated failure returns the work to the primary orchestrator. _Avoid_:
frontier model, unlimited retry.

**Model registry**: the routing table of approved models and their tiers,
roles, families, prices, rate bands, and context limits. Fleet ships a default
registry; a user overlay may adjust placement, eligibility, and prices, and
only `fleet-update` writes it. _Avoid_: model list, config.

**Comparable-work cohort**: the equivalence class rotation and evaluation
measure, exactly one model tier, one role, and one risk class. Repository and
language are recorded on every attempt but are not part of the cohort.
_Avoid_: bucket, sample group.

**Rate band**: the time-of-day pricing window a provider billed an attempt
under. Only direct DeepSeek has one; Fleet records the band on every attempt
and treats a peak band as a reason to prefer another eligible model. _Avoid_:
price band, tier.

**Routing evidence**: the recorded attempts, their outcomes, and the
per-cohort aggregates that `fleet-update` reads when deciding whether to move
a model's routing position. Fleet collects and reports it but never acts on it
automatically. _Avoid_: telemetry, metrics, stats.

**Clean**: remove a fleet job's worktrees and disposable build state while
retaining its job record. _Avoid_: delete, purge.

**Archive**: mark a completed job record inactive without deleting its
evidence. _Avoid_: clean, purge.

**Purge**: permanently delete one explicitly identified job record. _Avoid_:
clean, archive.

**Land**: after explicit primary-orchestrator acceptance, produce a landing
candidate — the accepted job commit or assembly branch rebased onto the
validated target tip with refreshed checks green. Fleet moves no ref outside its
own `fleet/<jobId>/` namespace, merges nothing, pushes nothing, and changes no
GitHub issue; the primary orchestrator fast-forwards or merges it. _Avoid_:
accept (acceptance is the decision; landing prepares it), merge.

**Landing candidate**: the `fleet/<jobId>/landed` branch a completed land
produces, recorded with the target sha it was fast-forwardable from. If the
target has moved past that sha, the fast-forward fails in the orchestrator's
hands rather than being resolved blind by Fleet. _Avoid_: landed branch.

**Harness**: the agent loop that turns a model plus tools into an editing
agent — Pi, Codex, or Claude Code. Each pool fixes one harness. _Avoid_: ccs
(the retired launcher, not the loop), runner adapter (Fleet's integration
around a harness).

**Provider**: the company that serves and bills a model — OpenAI, Anthropic,
OpenCode. Fleet reaches a provider only through a pool, so provider names never
appear in Fleet's public vocabulary. _Avoid_: profile (retired ccs term),
backend, pool.

**Worktree quarantine**: each agent edits inside its own git worktree and
branch, so its changes stay isolated and reviewable until the user lands them.
It separates ordinary Git changes but does not restrict the agent's filesystem
or network access. _Avoid_: sandbox, container, security boundary.

**Orchestration**: the lifecycle that shapes a fleet job, assigns its work,
collects evidence, escalates failures, and presents the whole job to the
primary orchestrator for acceptance. _Avoid_: management, CLI glue.

**Fleet module**: the deep module that owns orchestration policy, durable job
state, leases, model selection, worktrees, evidence, and state transitions. Its
small typed interface is shared by the CLI and MCP adapters. _Avoid_: fleet
service, fleet script.

**Fleet problem**: an expected condition that prevents a requested Fleet
operation from succeeding, returned as a typed result rather than an exception.
Examples include invalid input, policy denial, a stale confirmation, a state
conflict, a missing job, an unavailable dependency, and a capacity limit.
_Avoid_: failed attempt, infrastructure failure.

**Fleet MCP adapter**: the local stdio adapter through which Codex or Claude
submits and queries Fleet jobs using compact typed results. It does not own job
logic and is never offered to delegated agents. _Avoid_: Pi MCP, Fleet server
(too ambiguous), helper endpoint.

**Runner adapter**: the Fleet module's integration with one execution path —
Pi RPC, the Codex SDK, or the Claude Code CLI — behind one runner contract. It
translates Fleet's tool and sandbox policy, classifies provider failures, and
declares its capabilities; the Fleet core owns every process, the transcript,
and termination. _Avoid_: MCP (MCP faces the primary orchestrator), backend,
the runner.

**opencode go**: the fleet's daily provider — opencode's $10/mo subscription,
billed against one model-weighted monthly allowance. _Avoid_: opencode (the
company), zen (the separate PAYG product).

**Go monthly allowance**: the shared normalized usage available to all go
models. A model's published dollar limit is what the allowance would buy if
used exclusively on that model. Spending half of one model's exclusive-use
limit leaves half of every other model's limit. _Avoid_: shared $60 cap,
per-model allowance.

**agy**: Antigravity, an independent app used for research and frontier reach.
Not part of the delivery fleet — it fails mid-delivery too often — and not
orchestrated by the fleet. _Avoid_: Antigravity CLI, backend.

**ccs**: the retired launcher that used to stand up headless Claude Code per
provider profile. Retired because per-machine setup was fragile and it dragged
Claude Code's interactive plugins and skills into headless runs where they
served nothing. Records now drive the harness directly.

**Estimated input**: the crude pre-dispatch tripwire Fleet computes over the
bytes it assembles for one stage brief — role brief, input snapshot, depended-on
sealed artifacts, repository context files — divided by a fixed constant. It
gates eligibility against a model's hard context limit and its band threshold.
It is an estimate, never a measurement, and never evidence about a model's
quality; the summed per-message `input` is the measurement. _Avoid_: token
count, context size.

**Band violation**: an attempt whose true summed usage crossed a model's pricing
band threshold despite an estimate that said it would not. Recorded on the
attempt, excluded from the cost cohort, and a `fleet-update` signal that the
divisor or margin is too loose. _Avoid_: overrun, context overflow (that is a
`length` quality failure, which is a different condition).

## Pools and scarcity

**Pool**: one account reached through one execution path, such as a ChatGPT
Plus account through the Codex SDK. The runner adapter is fixed per pool, and
each pool declares whether it bills against a plan allowance or per token.
_Avoid_: provider, backend, subscription.

**Allowance**: a provider's own limit on a pool, opaque to Fleet except through
a probe or a rejection. _Avoid_: quota, capacity, budget.

**Capacity**: Fleet's own concurrency — the global and per-repository slots its
capacity leases claim. It says nothing about any provider's allowance.
_Avoid_: quota, allowance.

**Ration**: the share of a pool the user lets Fleet spend, counted in
dispatches per rolling window and configured by a human for every pool. Fleet
counts it exactly, so it is the scarcity lever Fleet can actually enforce.
_Avoid_: quota, budget, allowance.

**Dispatch**: one paid call Fleet starts in a pool — a stage attempt or a
helper — counted against the pool's ration at the moment it starts and never
refunded. _Avoid_: request, attempt (an attempt is one kind of dispatch).

**Standing**: the dispatchability of one pool scope — the whole pool, or one
model in it — at decision time: `confirmed` or `unconfirmed` (dispatchable),
or `cooling`, `exhausted`, `rationed`, or `unauthenticated`. _Avoid_: health,
status, model cooldown.

**Pool ledger**: the append-only per-pool record of ration claims, allowance
snapshots, closures, and attempt results from which standing is derived. It is
operational state, not evidence. _Avoid_: usage log, stats.

**Pool recovery**: the waiting reason for a job whose eligible pools are all
closed with a known horizon inside the wait bound. _Avoid_: provider recovery,
rate limited.

## Helpers and the harness

**Helper**: a read-only sub-task — search, read, summarise — that a writer or
reviewer hands to a cheaper model mid-attempt. It is not a stage: it seals
nothing, spends no quality attempt, never writes, and its answer is context,
never evidence. _Avoid_: sub-agent, scout (a scout is a stage), worker.

**Helper endpoint**: the Fleet-served tool through which a delegated agent
asks for a helper. It offers nothing of Fleet's lifecycle interface.
_Avoid_: Fleet MCP adapter, agent-to-agent channel.

**Clean harness**: a harness run with none of the user's or repository's
skills, plugins, hooks, MCP servers, or native sub-agents — only the
repository's instruction files and the helper endpoint. A pool whose runner
adapter cannot provide one is refused. _Avoid_: safe mode, sandbox.
