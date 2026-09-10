# Git isolation, assembly, refresh, and landing

The settled specification for ticket 06 of the Fleet redesign map. It assumes
ticket 02's state machine, ticket 03's store layout, and ticket 05's Pi work-unit
protocol, and does not restate them.

## 1. Namespace and ownership

Worktrees live at `~/.pi/fleet/worktrees/<jobId>/<role>-<n>/`, per ticket 03.
They are disposable: `clean` removes them and nothing else.

Branches are `fleet/<jobId>/<role>-<n>`, with `fleet/<jobId>/assembly` and
`fleet/<jobId>/landed` as the two reserved names.

**Fleet never writes a ref outside `refs/heads/fleet/<jobId>/`.** This rule has no
exceptions, including at landing (§6). An operation that would move a ref outside
that namespace is a Fleet problem returned to the caller, not a git error surfaced
raw.

One writer per ticket-backed job is enforced at two independent layers: the
repository writer capacity lease of ticket 02, limit one, and the branch namespace
above. Two writers can never share a worktree or a ref even if a lease is
mistakenly granted twice.

`git.json` records the repository id and path, the target ref *name*, the pinned
base sha, every branch Fleet created, every commit it sealed, and the landing
outcome.

### The reviewer worktree

Ticket 05 requires the reviewer to judge the writer's sealed commit in its own
read-only worktree and defers provisioning here. Fleet adds `reviewer-1` with
`git worktree add --detach <writerSealedSha>` — detached, no branch. Detached HEAD
at the sealed sha is the mechanical guarantee that the reviewer judges the sealed
commit rather than a tree the writer may still be touching, and the absence of
`edit`, `write`, and `bash` from its toolset is what stops it mutating what it
judges.

## 2. Commit collection

The writer's brief asks it to commit. If it seals its stage with the tree dirty,
Fleet commits on its behalf using the existing `core.excludesFile` artifact filter,
and **reports the difference** between what a plain `add -A` would have taken and
what it actually took. Filtering without disclosure is worse than the original
bug it fixes: it can silently discard real work.

A writer stage seals exactly one commit sha. Several writer commits are squashed
into it, so assembly and landing always move a single unit.

An empty diff against the pinned base is a quality failure under ticket 02's
"invalid or irrelevant output", not a successful stage with nothing in it.

## 3. Assembly

For a standalone discovery job with multiple independent writers:

The assembly branch is cut from the **pinned base sha**, never from the target tip.
Assembly is deterministic in the inputs the job actually saw; catching up to a moved
target is refresh's job (§5), and doing both at once makes a conflict ambiguous
between the two causes.

Fleet cherry-picks each writer's sealed commit in the **planner's declared order**,
recorded in the sealed stage plan.

`checking` re-runs on the assembled tree. A green check on each writer's isolated
commit is not evidence that the assembled tree is green.

## 4. Integration escalation

A cherry-pick conflict during assembly climbs one rung and then stops:

1. **One delegated `integrating` stage** — writer tier, scoped to resolving that
   conflict only, followed by a mandatory re-check on the resolved tree.
2. **Return to the primary orchestrator** with the conflicting hunks as evidence.

The integration attempt is budgeted **separately** from ticket 02's two quality
attempts, in the same way availability escalation is. A textual conflict is a
property of the decomposition, not a judgement that a writer's work was inadequate,
so it must not consume the escalation a genuinely failed writer would need.

There is no auto-merge cleverness at rung 1 — a plain cherry-pick, no `-X` strategy
options. A strategy flag that resolves a conflict by preferring one side produces a
tree no agent and no human ever looked at.

## 5. Refresh: pinned base versus current target

Ticket 02's `validating-current-target` stage runs immediately before landing. It
resolves the target ref's current tip and compares it to the pinned base sha.

**Unmoved** — proceed to landing.

**Moved** — refresh: rebase the sealed job commit, or the assembly branch, onto the
new tip in a Fleet-owned worktree.

- Clean rebase: **re-run `checking` only** and seal *refreshed* evidence at the new
  sha. Delegated review is **not** re-run. The reviewer judged the change's intent
  against its own diff, and a clean rebase did not change that diff; re-reviewing
  spends the most expensive stage to re-answer a question whose inputs are
  unchanged. Failing refreshed checks return the job.
- Conflicting rebase: return the job to the primary orchestrator with the
  conflicting hunks. Refresh has no integration rung — §4's rung exists because a
  planner's decomposition is Fleet's own artifact to fix, whereas a conflict with
  the target is unrelated work Fleet has no context on.

**If the target moves again during the refreshed check, the job returns to the
orchestrator immediately.** There is no retry cycle. A retry loop on a busy branch
spends check time on each cycle and can be starved anyway, and its cost is invisible
until it has already been paid.

## 6. Landing

`land` runs after explicit primary-orchestrator acceptance, and produces a
**landing candidate**: `fleet/<jobId>/landed`, the accepted commit rebased onto the
target tip that §5 validated, with refreshed checks sealed green.

**Fleet does not move the target ref, does not merge, does not push, and does not
touch the user's checkout.** The primary orchestrator, or the user, fast-forwards or
merges as appropriate.

Two reasons, one principled and one mechanical:

- The namespace rule of §1 stays absolute. There is no carve-out at the one moment
  Fleet would most like one, and therefore no state in which Fleet has silently
  advanced a branch the user is standing on.
- Git will not let two worktrees check out the same branch. With the target checked
  out in the user's own worktree — the normal case — Fleet *cannot* `git worktree
  add` on it. The only way to move the ref would be to land detached and then write
  `refs/heads/<target>` behind the user's HEAD, which is precisely the invisible
  action the namespace rule exists to forbid.

The job record marks the job landed in the sense of **ready to fast-forward**, and
records the target sha the candidate was fast-forwardable from. If the target has
moved past that sha by the time the orchestrator acts, the fast-forward simply fails
in the orchestrator's hands, where the context to resolve it lives.

## 7. Dirty trees

Fleet never requires the user's checkout to be clean, and never runs a writing git
command in it. Every Fleet git write happens in a Fleet-owned worktree under
`~/.pi/fleet/worktrees/<jobId>/`. An unrelated dirty file in the user's checkout
cannot block a job at any stage, including landing.

## 8. Conditions that return a job instead of landing it

- Current-target validation found a moved target and the rebase conflicted.
- Refreshed checks failed at the new sha.
- The target moved again during the refreshed check.
- Assembly conflicted and the one `integrating` stage did not resolve it.
- The acceptance contract is not satisfied at the refreshed sha.
- The sealed commit is missing or unreachable — a manual branch deletion, or a purge.
- Any operation would require moving a ref outside `refs/heads/<jobId>/`.

## 9. Clean, archive, purge

- **`clean`** removes `worktrees/<jobId>/` and `tmp/`. It **keeps every branch**: the
  commits are the work, and only an explicit purge deletes work.
- **`archive`** does nothing git-side. Branches and commits survive untouched.
- **`purge`** deletes the job record and, only with the unlanded-branch
  acknowledgement ticket 03 requires, the branches listed in `git.json`.

The accepted cost is that `refs/heads/fleet/*` accumulates across every job until
purged. `git branch --list 'fleet/*'` is legible, and the alternative — deleting
refs on a cleanup verb — risks discarding unlanded work on a verb whose whole
contract is that it doesn't.
