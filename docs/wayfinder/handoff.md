# Wayfinder handoff: quota-aware multi-agent coding orchestration

## Destination

Evolve `pi-fleet` into a reliable orchestration layer for coding agents that
makes efficient use of multiple subscription-backed model pools, initially:

- ChatGPT Plus / Codex
- Claude Pro / Claude Code
- OpenCode Go

The desired end state is not simply "run several agents."

The system should intelligently decide:

- which class of agent should perform a piece of work;
- which provider/model tier should supply that agent;
- when cheap capacity should be preferred;
- when work should be escalated to scarcer, stronger reasoning capacity;
- when a different provider should review another provider's work;
- how much context should cross an agent boundary;
- how concurrent coding work is safely isolated;
- when Fleet should stop spending tokens and return the problem to the
  primary/orchestrating agent.

The primary optimisation target is:

> Maximise useful completed coding work across the user's existing subscription
> quotas while minimising duplicated reasoning, unnecessary context
> consumption, and use of scarce high-end models.

Reliability, inspectability, and bounded autonomy are more important than
maximising the number of agents.

## Why this project exists

The user has several overlapping sources of coding-agent capacity:

1. ChatGPT Plus / Codex
2. Claude Pro / Claude Code
3. OpenCode Go

These services expose models with very different:

- reasoning quality;
- coding ability;
- quotas;
- reset periods;
- cost/scarcity;
- context behaviour;
- strengths and weaknesses.

Using one premium agent for an entire development task wastes scarce capacity
on work that cheaper models could perform. Conversely, blindly handing
everything to cheap models can produce repeated failed attempts whose total
token cost exceeds escalating earlier.

The intended strategy is broadly:

```text
cheap execution
      |
      v
verification
      |
      +-- success ------------------> done
      |
      v
bounded retry/escalation
      |
      v
stronger/different provider
      |
      v
verification/review
      |
      v
done OR return to primary
```

Fleet should make this systematic.

## Existing repository

Repository: `Kylevdm/pi-fleet`

Do not assume it is a greenfield project. Inspect the current repository before
making architectural decisions. The implementation already contains
substantially more functionality than the README's short project-layout section
suggests.

### Fleet job abstraction

`src/fleet.ts` contains a durable `Fleet` abstraction.

Jobs currently have public states including:

- `admitted`
- `running`
- `waiting`
- `ready-for-acceptance`
- `returned-to-orchestrator`
- `cancelled`
- `archived`

There is already a `next` transition model controlling which actions are legal
from each state.

`returned-to-orchestrator` is intentional and should be treated as an important
architectural primitive rather than merely a failure state. It can represent:

> Fleet has reached the boundary of what it is authorised or economical to
> resolve autonomously.

### Durable local store

Fleet already has a filesystem-backed durable job store. Existing concepts
include:

- immutable job input snapshots;
- job revisions;
- optimistic mutation / compare-and-swap behaviour;
- audit records;
- schema-versioned records;
- idempotent submission;
- store capacity accounting;
- stage storage;
- supervisor leases;
- process PID tracking;
- worktree-related storage paths;
- cancellation and cleanup.

The current design strongly favours explicit durable state over hidden in-memory
orchestration. Preserve that property unless investigation reveals a compelling
reason not to.

### Detached supervisor

`src/supervisor.ts` implements a detached per-job supervisor. It currently:

- claims a fenced supervisor lease;
- renews that lease;
- acquires capacity;
- transitions job state;
- starts the current Pi execution process/stub;
- records its PID;
- waits for completion;
- releases capacity;
- seals stage evidence;
- updates the durable job record.

The source explicitly identifies routing and Git worktrees as later work. This
supervisor is likely to remain an important execution boundary, but whether
routing itself belongs directly inside it is an open design question.

### Existing capacity model

Fleet already has capacity records and per-repository concepts. Current
capacity is primarily about safe concurrent execution rather than
subscription/model quotas.

One important question is how this abstraction should evolve to represent
provider scarcity without conflating:

- process concurrency;
- repository write concurrency;
- subscription quota;
- provider availability;
- model scarcity.

### Existing waiting semantics

The durable vocabulary already includes waiting reasons such as:

- `capacity`
- `provider-recovery`
- `primary-instructions`

These may be useful foundations for model/provider orchestration. Avoid
introducing provider-specific public states unless needed. For example, Claude
quota exhaustion probably should not leak into Fleet's public API as
`claude-rate-limited` if it can instead be represented using generic Fleet
semantics.

### Existing problem vocabulary

Fleet deliberately exposes a small closed set of typed problems:

- `invalid-input`
- `policy-denied`
- `conflict`
- `not-found`
- `stale-confirmation`
- `unavailable-dependency`
- `capacity`

Preserving a provider-independent API is desirable. Provider-specific errors
should preferably be translated into Fleet semantics.

### Existing continuation seam

`Fleet.continue()` is currently intentionally incomplete and documented as
awaiting routing / multi-stage behaviour. This appears to be a natural seam for
future orchestration.

Do not assume that `continue()` must carry all routing responsibilities, but
investigate it carefully.

## Directions already discussed

The following candidate principles emerged from earlier discussion. They are
directions to investigate, not decisions that Wayfinder must blindly preserve.

### 1. Roles should probably be independent of providers

Rather than defining permanent agents such as:

```text
claude-agent
codex-agent
kimi-agent
```

a likely better abstraction is:

```text
scout
planner
worker
reviewer
debugger
integrator
```

or similar.

Providers/models would then fulfil those roles according to:

- task characteristics;
- available quota;
- historical success;
- current scarcity.

This would make Fleet resilient to frequent model-name/provider changes.
Whether these exact roles are correct is unresolved.

### 2. Routing should probably be mostly deterministic

A concern with asking a premium LLM to choose every model invocation is that
the router itself begins consuming scarce reasoning capacity and may choose
expensive models too freely.

A candidate architecture is:

```text
task classification
      |
      v
policy rules
      |
      v
available capacity
      |
      v
provider/model tier
      |
      v
execution
```

An LLM might help classify ambiguous work, but policy should enforce:

- allowed tiers;
- maximum attempts;
- escalation paths;
- provider diversity requirements;
- capacity constraints.

The appropriate split between deterministic routing and model-assisted routing
remains unresolved.

### 3. Escalation should be bounded

A strong design principle is:

> Do not let cheap agents retry indefinitely.

A candidate policy is:

```text
cheap suitable model
      |
      v failure
one retry with evidence
      |
      v failure
stronger and/or different provider
      |
      v failure
return to orchestrator
```

The current README already describes collecting compact evidence and returning
to the primary after one escalation. That constraint appears valuable and
should only be relaxed deliberately. The exact number and shape of retries are
unresolved.

### 4. Context handoffs should be compact

One of the largest likely sources of token waste is forwarding whole agent
transcripts.

The proposed direction is that each stage produces a compact durable handoff
containing things such as:

- objective;
- relevant constraints;
- files touched;
- commit SHA;
- commands run;
- check results;
- unresolved concerns;
- specific failure evidence.

The next agent should start from that bounded artifact plus the repository
state rather than inheriting the previous model's entire conversation. This
fits well with Fleet's existing immutable snapshots and stage artifacts. The
exact artifact schema needs deciding.

### 5. Git should be shared state

A candidate model is:

```text
agent conversation = disposable
Fleet records       = durable orchestration state
Git commits/diffs   = durable coding state
stage artifact      = compact reasoning handoff
```

Workers would ideally leave behind:

- base commit;
- resulting commit;
- changed paths;
- test/check results;
- concise findings.

Reviewers could inspect the diff rather than replaying implementation
reasoning. Whether agents should always commit, whether Fleet should own
commits, and how incomplete work is represented are unresolved.

### 6. Worktrees appear important

Parallel writing agents should not mutate the same checkout. A likely design is
one isolated Git worktree per writable unit of work, with Fleet tracking
ownership and cleanup.

Potentially:

```text
Fleet job
  |-- worktree: implementation
  |-- worktree: tests
  `-- worktree: repair
```

However, concurrency should not be introduced merely because it is possible.
Questions remain around:

- worktree lifecycle;
- branch ownership;
- overlapping files;
- integration strategy;
- abandoned work;
- repo-level serialization;
- whether early Fleet versions should allow only one writer per job.

### 7. Cross-provider review could be valuable

One proposed rule is:

> The provider that reviews code should preferably differ from the provider
> that authored it.

For example:

```text
OpenCode worker -> Codex reviewer
Codex worker    -> Claude reviewer
Claude worker   -> Codex reviewer
```

The motivation is error diversity rather than merely "more review." Questions
remain around:

- when review is worthwhile;
- whether every job needs it;
- whether tests can replace review for low-risk work;
- how provider scarcity changes the rule;
- whether model family rather than provider identity is the correct boundary.

## Intended subscription strategy

The user's current working hypothesis is approximately as follows.

### OpenCode Go

Treat as the high-volume execution pool. Likely uses:

- repository exploration;
- routine implementation;
- boilerplate;
- test generation;
- mechanical refactors;
- first attempts at well-specified tasks.

### ChatGPT Plus / Codex

Likely uses:

- normal/strong coding;
- integration;
- independent review;
- more difficult repairs;
- escalation when OpenCode workers fail.

### Claude Pro

Likely conserve for:

- architecture;
- ambiguous problems;
- difficult debugging;
- high-value reasoning;
- independent review/escalation.

Claude's allowance is valuable enough that sustained bulk implementation
should probably not be its default use.

These provider assignments must remain configurable and should not become
permanent architectural assumptions. The important concept is resource
tiers/scarcity, not today's model names.

## Subscription capacity is not an API budget

The system is intended to exploit subscription-backed coding-agent access where
permitted and supported. Do not assume these subscriptions can be treated as
ordinary generic API keys.

Investigate the supported execution/authentication paths of Pi and the
individual coding agents. Prefer documented/supported mechanisms over
extracting tokens or depending on undocumented authentication internals.

One architectural question is whether Fleet should:

1. invoke everything through Pi's provider abstraction;
2. orchestrate provider-native coding CLIs;
3. support both through a common runner abstraction.

This needs an explicit decision.

## What Fleet should optimise

Do not optimise merely for lowest token count. The more useful objective is
something resembling:

> Successful verified work per unit of scarce subscription capacity.

Over time, Fleet should ideally be able to measure:

```text
task class
provider
model/tier
attempt count
input usage
output usage
wall time
check result
review findings
eventual success/failure
```

This could eventually allow empirical routing. For example:

```text
Model A:
  routine refactor      -> excellent
  ambiguous debugging   -> poor

Model B:
  routine refactor      -> unnecessary expense
  ambiguous debugging   -> excellent
```

Fleet should eventually know that from actual local outcomes rather than public
benchmark scores. How much telemetry belongs in the first version is
unresolved.

## Desired behavioural properties

### Bounded autonomy

Every autonomous loop must have an explicit termination condition. Fleet
should never silently burn quota because an agent keeps trying variations.

### Cheap-first, but not cheap-at-all-costs

Cheap capacity should handle work it is competent at. Repeated cheap failures
should trigger escalation before they become more expensive than a stronger
model would have been.

### Explicit evidence

Every stage should leave enough evidence that another model or the human can
understand:

- what was attempted;
- what changed;
- what passed;
- what failed;
- why the stage stopped.

### Disposable model context

Model sessions should be treated as temporary compute. Important knowledge
belongs in:

- Git;
- Fleet records;
- bounded stage artifacts.

### Provider independence

Fleet's public job/state/problem API should not be polluted with today's
model/provider names.

### Recoverability

The existing design takes crashes, stale leases, process termination and
durable state seriously. New orchestration behaviour should retain this
property. A crashed worker should not make the overall job unknowable.

### Human control

The human/primary agent must remain able to:

- inspect progress;
- cancel;
- resume;
- provide instructions;
- understand why escalation occurred;
- see which provider/model consumed capacity;
- take the job back.

## Questions Wayfinder should resolve

Create decision tickets for the important uncertainties uncovered by inspecting
the repository.

The following questions are known fog and likely deserve investigation. Do not
create tickets mechanically if some collapse into a single underlying
decision.

### Execution substrate

What exactly is a Fleet "agent execution"?

Should Fleet:

- run provider/model calls through Pi;
- invoke Codex/Claude/OpenCode CLIs;
- support interchangeable runner backends;
- use another mechanism?

What capabilities and limitations does each approach impose on subscriptions,
context, tools, sessions and telemetry?

### Routing model

What information should the router use? Potential inputs include:

- role/task type;
- difficulty;
- risk;
- previous failures;
- provider availability;
- remaining/scarce quota;
- measured historical success;
- expected context size;
- need for provider diversity.

Which are required for the first useful version?

### Provider capacity abstraction

How should Fleet represent the difference between:

- max concurrent workers;
- per-repository write capacity;
- provider availability;
- rolling subscription limits;
- weekly/monthly allowances;
- model-specific scarcity?

Can the existing capacity system be extended cleanly, or should quota/budget be
a separate abstraction?

### Multi-stage job model

What is the correct durable model for stages? Candidate stage kinds include:

```text
explore
plan
implement
test
review
repair
```

The right abstraction may be smaller. Determine:

- what a stage owns;
- stage state transitions;
- artifact schema;
- retry representation;
- parent/child relationships;
- whether the existing `JobRecord` should contain current-stage summary only
  while stage records hold history.

### Handoff/evidence contract

What minimum information must one stage give the next? Find the smallest useful
schema that avoids both:

- forwarding entire conversations;
- forcing every new agent to rediscover everything.

### Git/worktree lifecycle

Decide:

- when a worktree is created;
- which stage owns it;
- whether each stage gets a branch;
- when commits happen;
- how failed/uncommitted changes are preserved;
- how integration works;
- how cleanup behaves;
- whether parallel writers should initially be prohibited.

### Review policy

When should Fleet invoke an independent reviewer? Determine whether rules should
depend on:

- job risk;
- code size;
- provider used;
- checks passing;
- task class;
- escalation state.

Determine whether cross-provider review should be required, preferred, or
merely one routing signal.

### Escalation policy

Precisely define:

- what constitutes a failed attempt;
- when the same model may retry;
- what evidence accompanies retry;
- when provider/model tier changes;
- maximum autonomous attempts;
- when Fleet enters `returned-to-orchestrator`.

This is central to controlling token usage.

### Planning/decomposition

Determine how much task decomposition Fleet itself should do. A conservative
first version might be:

```text
one objective
      |
      v
one routed worker
      |
      v
verification
      |
      v
optional review
      |
      v
optional repair/escalation
      |
      v
success OR returned-to-orchestrator
```

before introducing autonomous DAG decomposition.

Investigate whether this should remain the initial scope. Avoid jumping
directly to an "agent swarm" architecture without demonstrating why it is
necessary.

### Telemetry

What should be measured from day one so future routing can improve without
requiring a schema redesign? Prefer recording raw facts from which later metrics
can be derived.

### Primary-agent boundary

Clarify the contract between Fleet and the primary coding agent. When Fleet
returns `returned-to-orchestrator`:

- what evidence is presented;
- what decisions can the primary make;
- how `continue` feeds new instructions back in;
- whether a resumed job retains its previous routing history;
- when resumption represents a new stage versus a new attempt.

## Scope guidance

Avoid turning this immediately into a huge distributed-agent platform.

The first valuable milestone should probably prove:

```text
objective
    |
    v
deterministic routing
    |
    v
one isolated worker
    |
    v
structured evidence
    |
    v
verification
    |
    v
optional different-provider review
    |
    v
at most one controlled escalation
    |
    v
success OR returned-to-orchestrator
```

The map should explicitly determine whether this is in fact the correct first
vertical slice. Parallel decomposition can come later.

## Likely non-goals for the first version

Treat these as hypotheses to verify:

- general-purpose distributed task queues;
- arbitrary unbounded agent-to-agent chat;
- large autonomous swarms;
- sophisticated learned routing;
- dynamic market-style bidding between models;
- replacing Git with an agent-specific state system;
- forwarding full conversations between workers;
- provider-specific states throughout the public API;
- unrestricted autonomous retry loops.

## Existing qualities worth protecting

While investigating changes, protect the repository's existing emphasis on:

- strict TypeScript;
- zero/minimal runtime dependencies where practical;
- explicit schemas;
- atomic filesystem operations;
- durable evidence;
- fenced leases;
- optimistic concurrency;
- bounded storage;
- clear typed failure semantics;
- CLI/MCP conformance;
- deterministic tests;
- dependency injection at important process boundaries.

Do not sacrifice these casually in pursuit of agent sophistication.

## Wayfinder instruction

Treat everything above in three categories.

### Settled destination

`pi-fleet` should efficiently orchestrate coding work across multiple
model/provider subscription pools using cheap execution where appropriate,
controlled escalation, compact handoffs, verification, and a clear
return-to-primary boundary.

### Known current state

Inspect the repository to validate the concrete implementation details
described above and use the code as the source of truth.

### Fog

The particular routing, stage, capacity, worktree, review, execution-backend,
telemetry and escalation designs remain open questions.

Create a Wayfinder map whose tickets resolve those decisions. Do not
prematurely turn the map into implementation tickets.

The destination is reached when the architecture and behavioural contracts are
clear enough that the result can be handed to `/to-spec`, then `/to-tickets`,
and implemented without major unresolved design decisions.

When choosing the frontier, prioritise questions that unblock several
downstream decisions. For example, the execution-substrate decision is likely
to affect routing, telemetry and quota handling.

Where uncertainty depends on the existing code, investigate the code rather
than debating abstractions. Where uncertainty depends on how Pi, Claude Code,
Codex or OpenCode Go actually behave, use current authoritative documentation
or a focused prototype/research ticket rather than assumptions.

Preserve a strong distinction between:

- **what Fleet knows and controls**; and
- **what an individual model session happens to know**.

The resulting architecture should make expensive reasoning capacity an
explicit scarce resource rather than the default execution environment.

## Suggested workflow

Run the repository's Matt Pocock skills setup first if it has not already been
run. Then invoke `/wayfinder` with this handoff as the initial context. After the
map clears, use `/to-spec`, followed by `/to-tickets`, before implementation.
