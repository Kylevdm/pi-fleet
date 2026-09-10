# Git gating and ref verification for delegated writers

Companion to [the Git lifecycle spec](../06-git-lifecycle/spec.md), which
establishes the invariant this document defends: **Fleet never writes a ref
outside `refs/heads/fleet/<jobId>/`**, and Fleet's correctness depends on no
such ref moving while a job runs.

## 1. Posture: guardrail, not boundary

The command gate is a **guardrail**. It is not a security boundary and the
specification does not claim it is one.

Pi ships no sandbox, by explicit design. A writer stage holds `bash`, `write`,
and `edit`, so it can reach git through a script it authors, a package manifest
hook, a test runner, or a shell it spawns itself. Any gate that inspects tool
calls is therefore advisory against a determined agent.

What the gate buys is prevention of the *honest* failure — a model that
helpfully runs `git checkout master`, `git push`, or `git branch -f` because
that is what finishing a piece of work usually looks like. That case is common,
cheap to stop, and the only one a gate can address.

The invariant is protected instead by **detection**: a whole-repository ref
diff around every delegated stage that holds `bash` (§4). Detection holds
regardless of *how* a ref moved — through the gate, around it, or by a hand
outside Fleet entirely.

## 2. The git command rule

The Fleet extension's `tool_call` handler gains a git-specific rule, layered on
top of the accepted-command allowlist that gates the argv head.

**Deny by default over subcommands.** Git's subcommand surface is large and
almost entirely irrelevant to a writer, so the rule permits a named set and
denies everything else — including user-configured aliases, which do not appear
in the permitted set and are therefore denied without needing a rule of their
own.

Permitted:

```
status  diff  log  show  add  commit  rm  mv  restore
blame   ls-files  rev-parse  cat-file
```

Everything else is denied. The denials that matter, and why:

| Denied | Reason |
| --- | --- |
| `push`, `fetch`, `clone`, `remote` | Network, and moves refs outside the namespace |
| `branch`, `tag`, `update-ref`, `symbolic-ref` | Direct ref manipulation |
| `checkout`, `switch`, `reset` | Moves HEAD or a branch; a writer owns one worktree on one branch and never leaves it |
| `worktree` | Creates a second worktree Fleet does not own |
| `config` | Reaches `core.hooksPath` and other execution surfaces |
| `stash` | Writes `refs/stash`, which is outside `refs/heads/fleet/<jobId>/`; permitting it would create guaranteed false-positive violations under §4. A writer owning its worktree exclusively has nothing to stash — it commits instead |
| `gc`, `reflog`, `filter-branch` | Rewrites or prunes history Fleet depends on |

`commit --amend` is permitted: it moves only the stage's own branch, which §4
explicitly allows.

**Relocating flags are refused outright**, not path-resolved:

```
-C   --git-dir   --work-tree   --exec-path
GIT_DIR=…   GIT_WORK_TREE=…   (as argv-leading env assignments)
```

These defeat any subcommand rule by changing which repository the command acts
on. The writer is already `cwd`'d in its own worktree and has no legitimate need
for them. Path-containment checking is rejected as the alternative: it invites
symlink and `..` normalisation bugs in exchange for permitting nothing anyone
needs.

**Direct writes to git's own state are blocked.** The handler refuses `write`
and `edit` on any path resolving under a `.git` directory — `.git/config`,
`.git/hooks/*`, `.git/HEAD`. This is guardrail-grade, not boundary-grade: a bash
heredoc reaches the same files. It closes the case where a model edits git
configuration as a reasonable-looking step, which is the case that occurs in
practice.

**The rule is not configurable.** The accepted-command allowlist remains
extensible per repository through the `config.json` overlay, so a repo can add
`cargo` or `go`. The git subcommand rule is fixed and shipped. A repository that
can overlay `push` back into the permitted set has silently opted out of the
invariant Fleet's correctness rests on. A repository that genuinely needs a
denied subcommand gets a specification amendment with a named reason, not a
configuration knob.

The same policy applies without exception to the `integrating` stage. Conflict
resolution is `add` plus `commit` on a tree Fleet has already placed in the
conflicted state; the stage never needs to move a ref itself.

## 3. What a block costs

A denied git command is an ordinary block under the work-unit protocol:
`{block: true, reason}`, legible to the model, not fatal to the run, counting
toward the three-blocks-in-a-stage quality failure.

It is deliberately *not* escalated. A writer reaching for `git push` is
overwhelmingly a model being unhelpfully thorough rather than an attempt on the
invariant, and the Pi spike demonstrated that a legible block produces an honest
report in `commandsRun` and a completed piece of work routed around the
obstacle. The harsh path is reserved for a *detected ref movement* (§5), which
differs in kind from a *blocked attempt*.

The block reason names the denied subcommand, states that Fleet owns branch and
ref management, and lists the permitted set. This costs a few dozen tokens in a
blocked tool result and prevents a writer from spending its entire three-block
budget discovering the same rule three times.

## 4. Ref verification

**Mechanism.** `git for-each-ref` over the whole repository, snapshotted at
stage launch and again at seal.

**Scope: every ref in the repository.** Verifying only
`refs/heads/fleet/<jobId>/*`, or only the namespace plus the pinned base and
current target, was rejected: the harm the invariant guards against is
*outside* the namespace, so a narrow check misses precisely the case it exists
to catch. The whole-repository scan takes milliseconds.

**Where it runs:** at the seal of every delegated stage that holds `bash` —
`writing` and `integrating` — and again at recovery, since a supervisor that
crashed has no knowledge of what happened while it was gone. It does **not**
run around Fleet's own git operations: Fleet is the actor there, and checking
one's own writes tests nothing. Landing is already covered by
`validating-current-target`.

**Baseline.** Every ref is expected unchanged, with one exception: the stage's
own branch, `refs/heads/fleet/<jobId>/<role>-<n>`, may move freely, including
non-fast-forward. Amending and squashing before submission are normal tidying,
and the Git lifecycle spec takes whatever is at the sealed sha.

**The sealed sha comes from the seal, never from the ref.** Verification reads
the ref only to confirm it points at the sha the `submit_write` result already
recorded. Inferring the sealed commit from the ref at diff time would make the
integrity check depend on the state it is checking.

## 5. Response to a violation

A ref outside `refs/heads/fleet/<jobId>/` that moved between snapshot and seal
is a violation. Fleet **returns the job to the orchestrator immediately**, with
the ref name and both shas in the return reason. The job's branches are left
intact for inspection.

It is **not a quality failure.** A quality failure means the delegated work was
bad and another attempt may do better. This means Fleet's model of the
repository is no longer trustworthy — retrying a stage inside a repository whose
refs moved underneath it compounds the damage rather than recovering from it.

It is **not `abort`.** Abort demotes the autonomy stage for every job, and a
single job encountering a moved ref — quite possibly the user's own concurrent
commit — is not evidence that the rollout is unsafe.

**Fleet never restores the moved ref.** It knows the prior sha and could reset
it back, and must not. Writing a ref outside the namespace in order to *repair*
the invariant still breaks it, and the movement may be the user's own
legitimate work. The Git lifecycle spec made the namespace rule absolute with no
exceptions; a repair exception is exactly the kind that consumes the rule.
Report and return — the orchestrator holds the context to judge whether anything
needs undoing.

### Accepted cost: false positives

A user who commits to the target branch while a stage is running will have that
job returned. This is a known and accepted cost of the guardrail.

The only mitigation applied is a **narrow window**: snapshot at stage launch
rather than at job start, so the exposure is one delegated stage rather than the
whole job.

Discriminating writer-caused movement from user-caused movement via `git
reflog` is explicitly rejected. It means parsing a local, prunable,
format-unstable log in order to decide whether to trust the repository, and a
wrong answer in the permissive direction silently defeats the entire check. The
return reason names the ref and both shas, so a user who caused the return sees
immediately that they did.

## 6. Records

| What | Where | Why |
| --- | --- | --- |
| Individual gate blocks; the verification outcome | Stage attempt record (durable schema spec) | Job facts. The §5 return reason cites them |
| Aggregate: which models trip the gate, how often, on which subcommands | Append-only evidence log (routing spec) | A model that reaches for `git push` in a third of its stages is a routing signal, and `fleet-update` is the only thing that acts on it |

## 7. Implementation notes

- The gate rule lives in the single Fleet extension's `tool_call` handler,
  alongside the accepted-command allowlist and the `raise_risk` tool. No second
  extension.
- Argv is inspected after Pi resolves it, consistent with the existing
  accepted-command check.
- `fleet/references/mechanics.md` is already noted as materially out of date on
  Pi's control surface; this document does not depend on it.
