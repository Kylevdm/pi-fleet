# Fog ledger

Fog is the dim view ahead of an active map: in-scope areas you can tell are coming but cannot yet phrase sharply enough to ticket. The map's **Not yet specified** section is the store for active-map fog. This ledger is the live index across maps and sessions.

Last swept: 2026-09-24.

## Where to put things

| It is… | It goes… |
| --- | --- |
| Unsharp and in scope for an active map | That map's **Not yet specified** |
| Sharp enough to state as a question | A ticket on its map, even if blocked |
| Already decided | The map's **Decisions so far**, linking the resolution |
| Past one map's destination but wanted and owned by no current map | **Deferred efforts** |
| Conditional, within a closing map's destination, unowned, and not triggered | Mark **CARRIED** on the map and index it under **Carried** |
| A random wanted idea with no source map or owner | **Deferred efforts** |

Closing a map requires marking every patch in **Not yet specified**:

- **ANSWERED** — current evidence resolved it; state and link the answer.
- **REHOMED** — another map, ticket, or scope owns it; link the owner.
- **CARRIED** — still within the destination, still unowned, and its trigger did not fire; preserve the human's rationale and index it below.

A patch that blocks the destination prevents closure. Work explicitly beyond the destination is never Carried.

Every live row states what it is, cites where it touches the build when applicable, and names the observable event that makes it ready for owned work. `Trigger: none yet` is valid.

## Carried

Live conditional fog from closed maps, grouped by the map that raised it.

<!--
### From [Map title](map link) (closed)

| Patch | Trigger |
| --- | --- |
| What remains unknown, with evidence such as `path:line` or a linked issue | Observable trigger, or none yet |
-->

## Triaged

Closed maps whose **Not yet specified** patches are all marked. Record maps with zero patches too.

- [Fleet redesign around primary-token savings](https://github.com/Kylevdm/pi-fleet/issues/1) — triaged 2026-09-24: 0 ANSWERED, 0 REHOMED, 0 CARRIED.

## Deferred efforts

Wanted work outside every current map's destination and owned by nobody. An idea that never came from a map belongs here too. Group into subject subsections once there are enough entries to scan; other entries then refer to them by name.

- **Evaluate local Ollama models as a Fleet pool.** Nothing in the TypeScript
  Fleet touches Ollama. Under the quota-aware design a local endpoint would be
  one more pool — an account plus an execution path that declares its billing
  ([Choose the execution-backend boundary](https://github.com/Kylevdm/pi-fleet/issues/52),
  decision 7) — most plausibly behind the Pi RPC adapter.
  [Fleet redesign around primary-token savings](https://github.com/Kylevdm/pi-fleet/issues/1)
  ruled local routing out of its first release so the first evaluation measures
  the approved pools, and
  [Quota-aware orchestration across subscription model pools](https://github.com/Kylevdm/pi-fleet/issues/47)
  names only Codex, Claude Code, and OpenCode Go. Moved here from the
  `Kylevdm/skills` ledger on 2026-09-24. Trigger: routing evidence shows poor
  acceptance at the cheapest tier, or the pool ledger shows the Go pool closing
  on exhaustion often enough to hold up work.

- **Evaluate containerized workers for an isolation boundary Fleet enforces.**
  A delegated agent still runs with the launching user's filesystem and network
  access; its worktree separates Git changes only (**Worktree quarantine** in
  `CONTEXT.md`, arriving with [#71](https://github.com/Kylevdm/pi-fleet/pull/71)).
  The quota-aware design narrowed this without closing it. Sandboxing is now an
  abstract policy each adapter translates or declares missing, so a job whose
  `isolation` is `required` refuses a Pi pool before dispatch and runs only where
  a harness's native sandbox provides it
  ([Choose the execution-backend boundary](https://github.com/Kylevdm/pi-fleet/issues/52),
  decisions 6 and 9). The cgroup scope
  [Define the process-host containment contract and its host preconditions](https://github.com/Kylevdm/pi-fleet/issues/66)
  puts around each attempt contains process lifetime for termination, not
  access. Still open: a boundary Fleet enforces itself, independent of any
  harness. [Fleet redesign around primary-token savings](https://github.com/Kylevdm/pi-fleet/issues/1)
  ruled containerized workers out of its first release. Moved here from the
  `Kylevdm/skills` ledger on 2026-09-24. Trigger: Fleet must run against a
  repository that cannot safely be exposed to an approved provider, or a
  security review requires filesystem, credential, or network isolation.
