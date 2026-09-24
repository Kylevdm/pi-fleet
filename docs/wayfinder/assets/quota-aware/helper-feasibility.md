# Cheap-helper feasibility: tool injection (A) vs native sub-agents (B)

Researched 2026-09-24 against `pi` 0.85.1, `codex` 0.156.1 (`@openai/codex` npm package),
`claude` 2.1.281, installed locally. Labels: **verified** (seen in `--help`, installed
package docs/source, or official docs — cited) or **inferred** (reasoned from verified
facts, not directly stated). Unestablished facts are flagged explicitly rather than guessed.

No model-spending commands were run (no `claude -p`, `codex exec`, or `pi` prompts).

---

## 1. Tool injection for (A)

### Pi RPC — **verified, and there is a shipped reference implementation of exactly this pattern**

- Extensions register custom tools via `pi.registerTool({ ..., async execute(toolCallId, params, signal, onUpdate, ctx) {...} })`.
  `execute` is async and can await arbitrary I/O (fetch, spawn, sockets) with no
  Pi-imposed timeout documented anywhere in `docs/extensions.md`. Fleet already does
  exactly this: `src/fleet-extension.ts` registers `submit_write`/`submit_review`/
  `submit_scout`/`submit_plan`/`raise_risk` via `defineTool` from
  `@earendil-works/pi-coding-agent`, loaded into the RPC subprocess via `pi --mode rpc
  -e <path>` (see `src/pi-driver.ts` argv construction). — verified, repo source.
- Cancellation is cooperative via the `signal` (`AbortSignal`) parameter; a tool can
  check `signal.aborted` or pass `signal` through to nested I/O. — verified,
  `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`.
- **No documented tool-execution timeout.** The only timeout in the extensions docs is
  the caller-supplied one on `pi.exec()` (shell helper) and on UI dialog methods
  (`ctx.ui.confirm(..., {timeout})`), both optional and set by the extension author, not
  imposed by Pi. — verified (absence confirmed by full-text read of `extensions.md`).
- **RPC-mode blocking round trip already exists as a protocol primitive.** In `--mode
  rpc`, `ctx.ui.select/confirm/input/editor` calls emit an `extension_ui_request` on
  stdout and **block until** the RPC client (Fleet, which already owns the stdin/stdout
  pipes per `pi-driver.ts`) sends back `extension_ui_response` on stdin — with no
  Pi-imposed default timeout if the extension doesn't pass one. This is a working
  "call back to Fleet and block" channel that predates any custom `ask_helper` tool. —
  verified, `docs/rpc.md` (Extension UI Protocol section).
- **A shipped first-party example does exactly the (A) pattern**, including running the
  helper on a *cheaper model*: `examples/extensions/subagent/` registers a tool that
  spawns a **separate `pi` child process** (`node:child_process.spawn`, called directly
  inside `execute()`) per delegated task, with per-role model pinning in the agent's
  frontmatter (`model: claude-haiku-4-5`; the shipped `scout` role uses Haiku), streams
  progress, tracks turns/tokens/cost/context per sub-task, and **returns each
  completed task's output to the parent model capped at 50 KB**. Parallel mode: up to
  8 tasks queued, 4 concurrent. — verified, read in full
  (`examples/extensions/subagent/index.ts`, `agents.ts`, `README.md`).
- **Architectural caveat (inferred, important for Fleet):** that example's `spawn()`
  call happens *inside* the Pi extension process, i.e. as a grandchild of the Fleet
  process, invisible to Fleet's own process handle. The runner-contract decision 2
  (`docs/wayfinder/assets/quota-aware/runner-contract.md`, fetched from
  `origin/wayfinder/runner-contract`) requires "Adapters must acquire child processes
  through a core-supplied process host, so Fleet retains the handle and kill
  authority." If Fleet copied this example's pattern verbatim inside
  `fleet-extension.ts`, the helper process would violate that invariant. The
  RPC-blocking-dialog channel (previous bullet) avoids this: the *Fleet process itself*
  dispatches the helper (as a normal Fleet-owned `pi-driver.runStage()` call, on
  whatever pool/model Fleet chooses) and answers the extension's blocking
  `extension_ui_request` when the helper completes — keeping Fleet as the sole process
  owner. — inferred from the two verified facts above plus the runner-contract text.
- Pi itself ships **no built-in sub-agent/MCP feature** at all: `docs/usage.md` states
  the RPC/headless surface "intentionally does not include built-in MCP, sub-agents,
  permission popups, plan mode, to-dos, or background bash." Sub-agents are only
  achievable by building/installing an extension (as above). — verified,
  `docs/usage.md` line 309.

### Codex — **verified: real, but only as an out-of-process MCP server; no in-process custom-tool callback API found**

- Codex's only documented "custom tool" surface is external **MCP servers**, configured
  in `~/.codex/config.toml` (or project `.codex/config.toml`) under
  `[mcp_servers.<name>]` with `command`/`args`/`env`/`cwd` (stdio) or `url` (HTTP), plus
  `enabled_tools`/`disabled_tools` allow/deny lists and
  `default_tools_approval_mode`. — verified, `learn.chatgpt.com/docs/config-file/config-reference`
  (redirected from `developers.openai.com/codex/config-reference`).
- `codex mcp add <name> [--url <url> | -- <command>...] [--env K=V]` is the supported
  CLI path to register a server (writes to config.toml). — verified, `codex mcp add --help`.
- **Timeouts, both overridable, are documented defaults, not hard caps:**
  `startup_timeout_sec` — "Override the default 10s startup timeout for an MCP server."
  `tool_timeout_sec` — "Override the default 60s per-tool timeout for an MCP server."
  So a long-blocking `ask_helper` MCP tool needs `tool_timeout_sec` raised (e.g. to
  several hundred seconds) in that server's config block, or the default 60 s kills it. —
  verified, `learn.chatgpt.com/docs/config-file/config-reference`.
- `codex`/`codex exec` accepts `-c key=value` with arbitrary **dotted-path** TOML
  overrides ("Use a dotted path (`foo.bar.baz`) to override nested values") — verified,
  `codex exec --help`. Applying this to `mcp_servers.<name>.tool_timeout_sec=300` etc.
  is a straightforward instance of a documented general mechanism, but no doc example
  shows it applied specifically to `mcp_servers.*`; the redirected MCP doc page
  explicitly says CLI `-c` overrides for MCP config are "not mentioned." — **inferred**
  (mechanism verified, this specific application not directly demonstrated).
- No in-process/callback custom-tool API was found in the Codex SDK docs
  (`learn.chatgpt.com/docs/codex-sdk`): the SDK is thread/exec-oriented (`run()`,
  `startThread()`, `resumeThread()`); it references external MCP servers only, and
  notes the standalone `codex mcp-server` binary / `codex mcp-server` command were
  **removed** in favor of the app-server. — verified (by the docs actually consulted;
  cannot rule out an undocumented API).
- Whether `codex exec` (the non-interactive surface the Codex SDK wraps, and what
  Fleet's runner-contract names as the Codex adapter) actually loads and offers
  MCP-provided tools to the model is **not explicitly confirmed** by the non-interactive
  mode doc; it does say a `required = true` MCP server that fails to init causes
  `codex exec` to exit with an error, which is only meaningful if `codex exec` does load
  MCP servers. — **inferred** (strong circumstantial evidence, not a direct statement).

### Claude Code — **verified: two real mechanisms, one out-of-process, one genuinely in-process**

- **Out-of-process:** `--mcp-config <configs...>` loads MCP servers from JSON
  files/strings; `--strict-mcp-config` restricts Claude Code to *only* those servers
  (ignoring project `.mcp.json`). Works with `-p`. — verified, `claude --help` +
  `code.claude.com/docs/en/headless`.
- **In-process (the strongest match to Pi's `defineTool`):** the TypeScript/Python Agent
  SDK exposes `tool(name, description, zodSchema, handler, extras?)` plus
  `createSdkMcpServer({ name, tools, timeout, ... })`. The `handler` is
  `async (args, extra) => Promise<CallToolResult>` — can await arbitrary I/O. Passed
  into `query()` via `options.mcpServers`; runs **in the SDK host process**, not a
  subprocess, so it has no MCP stdio/HTTP transport startup cost. —
  verified, `code.claude.com/docs/en/agent-sdk/typescript`.
- **Timeouts, three independent layers, all documented with concrete defaults:**
  - `MCP_TIMEOUT` env var — MCP **server startup** timeout, default **30 s**
    (`headless.md`: "Claude Code waits for still-pending servers... up to the
    `MCP_TIMEOUT` startup timeout, 30 seconds by default"). — verified.
  - `MCP_TOOL_TIMEOUT` env var — global **per-tool-call** timeout, default **~28
    hours** (100,000,000 ms) when unset — i.e. effectively unbounded for a
    minutes-long helper call. — verified via search of docs/GitHub issue text; treat
    the exact "~28h" figure as **inferred/secondary-sourced** (not re-confirmed on an
    official page during this pass) rather than primary-verified.
  - Per-server `timeout` field in `.mcp.json` (ms, minimum 1000) overrides
    `MCP_TOOL_TIMEOUT` for that one server. — verified (secondary source; consistent
    with `createSdkMcpServer({ timeout })`'s documented "must be ≥1000, ignored
    otherwise" rule, which **is** primary-verified from `agent-sdk/typescript`).
  - `createSdkMcpServer({ timeout })` — per-SDK-server tool-call timeout in ms,
    minimum 1000, requires SDK ≥ v0.3.248. — verified,
    `code.claude.com/docs/en/agent-sdk/typescript`.
  - Separately, an **idle timeout** (no response/progress notification, not overall
    wall-clock) defaults to 5 min for HTTP/SSE/WS servers and 30 min for stdio servers,
    configurable via `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`. A long-blocking `ask_helper`
    call must emit MCP progress notifications periodically or risks being aborted by
    the idle timer even under a generous wall-clock timeout. — verified (secondary
    source; flagged as not re-confirmed on an official page this pass).
  - Net: a Claude-side `ask_helper` tool blocking for tens of seconds to several
    minutes is well within all documented defaults/ceilings, and every relevant
    timeout is independently configurable upward. — verified/inferred combination as above.
- `--safe-mode` (interactive) / `--bare` (headless, the SDK's recommended flag)
  disable auto-discovered MCP servers/hooks/etc but **`--mcp-config` still works** to
  add servers explicitly even under `--bare`. — verified, `code.claude.com/docs/en/agent-sdk/headless`.

---

## 2. Native sub-agents for (B)

### Pi — **verified: none built in**

`docs/usage.md`: RPC/headless mode "intentionally does not include built-in MCP,
sub-agents, ..." Confirmed by full-text grep of all installed Pi docs for
"subagent"/"sub-agent"/"delegate": the only hits are (a) that usage.md disclaimer, (b)
`docs/sdk.md`'s mention that the SDK lets you "build custom tools that spawn
sub-agents" (i.e. build it yourself, see §1), and (c) the `examples/extensions/subagent/`
example itself. No native, Pi-core sub-agent feature exists. — verified.

### Codex — **verified: yes, a real native multi-agent feature, on by default in the installed version, with per-role model pinning**

- Locally verified via `codex features list` (installed 0.156.1): `multi_agent`
  → stage `stable`, state **`true` (enabled by default)**. `multi_agent_v2` → stable but
  `false` (opt-in, and community reports — e.g. GitHub issue "MultiAgentV2 is
  fundamentally broken as a forced runtime" — suggest it is not yet reliable). —
  verified, direct CLI output.
- Config surface (`learn.chatgpt.com/docs/config-file/config-reference`, `[agents]`
  table) — verified:
  - `agents.enabled` (default true) — enable/disable multi-agent tools entirely.
  - `agents.default_subagent_model` — default model for spawned agents.
  - `agents.default_subagent_reasoning_effort` — default reasoning effort for spawned agents.
  - `agents.max_concurrent_threads_per_session` — concurrency cap.
  - `agents.<name>.description` / `agents.<name>.config_file` — custom named roles,
    each with its own model via a layered TOML config file.
- Per-role model pinning is documented on the dedicated subagents page
  (`learn.chatgpt.com/docs/agent-configuration/subagents`, fetched): custom agent
  `.toml` files under `~/.codex/agents/` carry a `model` field; the docs suggest a
  cheap/fast model (`gpt-6-luna`) for "fast, narrowly scoped agents" vs. a stronger one
  (`gpt-6-sol`) for demanding work — i.e. the exact cheap-helper pattern the design
  question is asking about, natively. — verified.
- Concurrency: subagents "run in parallel... Codex waits until all requested results
  are available, then returns a consolidated response," capped by
  `agents.max_concurrent_threads_per_session`. — verified.
- Disable: `agents.enabled = false`. — verified. No CLI-flag equivalent to Claude's
  `--disallowedTools` was found for Codex; disabling appears to be config-only.
- **Gap — non-interactive availability not confirmed.** The `codex exec`/non-interactive
  docs page does not mention subagent spawning at all, and the interactive `/agent`
  slash command described elsewhere is TUI-specific. Since `agents.*` is read from the
  same `config.toml` any invocation loads, it is **plausible** `codex exec` exposes the
  same `spawn_agent`-style tool to the model (a tool name confirmed to exist from a
  GitHub bug report: "`spawn_agent` encrypted-tools 400" under `multi_agent_v2`) — but
  this is **inferred, not directly documented**, and is exactly the kind of fact this
  repo's own research methodology (see `execution-paths.md`) would flag as
  "Prototype: behavior the documentation does not settle."
- **Gap — daemon dependency (inferred risk for Fleet).** `codex agents` browses
  "agent sessions on the shared local app-server daemon" (verified, `codex agents
  --help`), suggesting spawned-agent threads may be owned by a persistent app-server
  daemon rather than living purely inside the one `codex exec` child process Fleet
  spawns. The runner-contract's own "Required live prototypes" list already flags "an
  SDK-spawned `codex exec` child stays visible to the process host" as unsettled
  (`runner-contract.md`); native subagents sharpen that same open question rather than
  resolving it. — inferred.

### Claude Code — **verified: yes, extensive, and the most fully documented of the three**

- `--agents <json-or-file>` defines custom subagents for a `-p` session. Full documented
  field set (fetched from `code.claude.com/docs/en/sub-agents`): `prompt`,
  `description`, `tools`, `disallowedTools`, **`model`** (`"sonnet"`, `"opus"`,
  `"haiku"`, `"fable"`, a full model ID, or `"inherit"`), `permissionMode`,
  `mcpServers`, `hooks`, `maxTurns`, `skills`, `memory`, `effort`, `isolation`,
  `background`, `omitClaudeMd`, `initialPrompt`. — verified.
- Built-in **Explore** subagent: read-only (Write/Edit denied), for file discovery and
  codebase search — the closest built-in match to the design's "read-only sub-tasks."
  As of v2.1.198 it inherits the main conversation's model (capped at Opus on the
  Claude API) rather than always running Haiku; to force it onto a cheap model, define
  a project/user subagent literally named `Explore` with your own `model` field. —
  verified.
- Concurrency: default **20 concurrent subagents** per session
  (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` to change), 3-layer default nesting depth
  (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`). — verified.
- Disable: `--disallowedTools "Agent(Explore)"` or `--disallowedTools "Agent"` (blocks
  the whole tool), or `permissions.deny: ["Agent"]` in settings, or
  `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` for built-ins specifically. — verified.
- Non-interactive behavior: if a background subagent is still running when the main
  turn ends, `claude -p` **stays alive and waits** (its result is part of the final
  output), up to a **10-minute** idle-wait ceiling (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`,
  0 = unbounded). — verified, `code.claude.com/docs/en/agent-sdk/headless`.
- Subscription allowance: subagents draw on the **same account/session allowance** as
  the main conversation — "No separate billing or quota per subagent... Rate limits
  apply to the session as a whole (main conversation + all subagents combined)." —
  verified (secondary-sourced summary of `code.claude.com/docs/en/sub-agents`; the
  authoritative cost-tracking page corroborates this indirectly by describing
  `modelUsage`/`total_cost_usd` as including subagent spend within one session — see §4).

---

## 3. Parallelism

- **Pi:** parallel tool execution is the **default mode**. "Sibling tool calls from the
  same assistant message are preflighted sequentially, then executed concurrently."
  (`docs/extensions.md`, `tool_call` event docs, and the custom-tools
  `withFileMutationQueue()` warning: "tool calls run in parallel by default.") So
  several `ask_helper` calls issued by one assistant turn run concurrently, each
  independently awaiting its own I/O. The shipped subagent example additionally
  supports an explicit "parallel" tool mode (up to 8 tasks queued, 4 concurrent),
  separate from Pi's baseline parallel-tool-call behavior. — verified.
- **Codex:** subagent (multi-agent) execution is explicitly parallel — "Codex waits
  until all requested results are available" — capped by
  `agents.max_concurrent_threads_per_session`. — verified. Whether ordinary (non-agent)
  MCP tool calls within one turn can also run concurrently is **not established** in the
  docs consulted this pass.
- **Claude Code:** up to 20 concurrent subagents by default (§2). Whether ordinary MCP
  tool calls within a single turn run concurrently was not directly re-confirmed this
  pass (Claude's Messages API generally supports the model requesting multiple
  parallel tool_use blocks per turn, which the SDK/CLI cost-tracking docs corroborate —
  "When Claude uses multiple tools in one turn, all messages in that turn share the
  same ID" — but this is **inferred**, not a direct statement that MCP tool *execution*
  is concurrent rather than serialized by the host).

---

## 4. Usage accounting

### Pi — **verified: helper usage is summable, but not broken out per model within one event**

- A tool result can carry a `usage` field for "nested LLM work performed by the tool";
  Pi "persists it on the tool result and includes it in footer, `/session`, and RPC
  session totals." `get_session_stats` (`docs/rpc.md`) sums `tokens`/`cost` "across
  assistant messages, usage reported by tools, and compaction," with no per-model
  breakdown map (no `modelUsage`-equivalent field documented anywhere in the Pi docs
  — confirmed absent by grep). — verified.
- **In Fleet's actual architecture this is moot in the useful direction**: because the
  design dispatches the helper as a **separate `pi --mode rpc` process** (a distinct
  Fleet-owned stage attempt, per the runner-contract's "one process per stage attempt"
  invariant), Fleet's own existing `pi-driver.ts` (`sumUsage`/`summarise`) already
  records that helper's usage **with its own `model`/`provider` fields**, fully
  separated from the writer's usage by construction — Fleet doesn't need Pi's
  in-tool-result `usage` nesting mechanism at all for per-model breakout; it gets a
  cleaner separation for free by treating the helper as its own stage. — inferred,
  from reading `src/pi-driver.ts` (`PiEvent.message.model`/`.provider`,
  `summarise()`) plus the runner-contract's process-per-attempt rule.

### Codex — **not established; flagged as a real gap**

- `codex exec --json`'s `turn.completed` event reports aggregate
  `usage: {input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}`
  with **no per-model field** and event types documented as `thread.started`,
  `turn.started`, `turn.completed`, `turn.failed`, `item.*`, `error` — **no
  subagent-spawn-specific event type is documented**. — verified (by the
  non-interactive-mode doc page consulted; the page is not exhaustive so an
  undocumented event type cannot be ruled out).
- Whether a `spawn_agent` call's tokens are attributed separately (by model, by role)
  anywhere in the machine-readable stream, or only folded into the parent turn's
  aggregate `usage`, is **not established** by the docs consulted. Community bug
  reports (e.g. "Restoring subagent roles, model and reasoning in multi_agent_v2")
  suggest subagent role/model attribution has been actively unstable across recent
  Codex versions, which is corroborating (but not primary) evidence that this is
  genuinely unsettled rather than just under-documented.
- Subscription allowance: general community/help-center sourcing indicates subagents
  "use the same subscription allowance as regular ChatGPT usage" and "consume more
  tokens than comparable single-agent runs," but this is **secondary-sourced, not
  confirmed on an OpenAI primary docs page** in this pass — mark as **inferred**.
- Net: per-model, per-role usage breakout for a Codex-native subagent is an open
  question this research could not settle from documentation alone — consistent with
  this repo's own `execution-paths.md` conclusion that "Codex reports consumed
  tokens... A failed turn or generic error event is not enough to distinguish
  [cases]... without inspecting the actual payload," and would need the same kind of
  bounded live prototype that document already calls for.

### Claude Code — **verified: the strongest, most explicit answer of the three**

- The `stream-json` **result** message carries three usage-scoped fields with
  **documented, distinct semantics regarding subagents** (`code.claude.com/docs/en/agent-sdk/cost-tracking`,
  quoted verbatim):

  | Field | Subagent activity |
  |---|---|
  | `usage` | **Excluded.** Counts only the top-level agent loop; subagent tokens not added. |
  | `total_cost_usd` | **Included.** Counts subagent requests alongside the top-level loop. |
  | `modelUsage` (`model_usage` in Python) | **Included, broken down by model.** |

- `modelUsage` is "a map of model name to per-model token counts and cost," explicitly
  called out as useful "when you run multiple models (for example, Haiku for subagents
  and Opus for the main agent)" — i.e. this is the documented, designed-for mechanism
  for exactly the accounting question asked here. Each entry also carries `costBasis`
  (`list`/`managed`/`unknown`) since Claude Code v2.1.246. — verified.
- Subagent messages are individually visible in the `stream-json` event stream too:
  `assistant`/`user` messages carry `parent_tool_use_id` = the id of the Agent/Task
  tool call that spawned them (`null` for the main conversation), letting a consumer
  rebuild the full nesting tree across depths; `--forward-subagent-text` /
  `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT` additionally forwards subagent text/thinking
  blocks, not just tool_use/tool_result. — verified.
- Same-subscription confirmation: `total_cost_usd`/`modelUsage` "include subagent
  requests alongside the top-level loop" within one session/query — corroborates the
  "same allowance, unified billing" claim in §2. — verified (this is the authoritative
  source for that claim; stronger than the secondary source cited in §2).

---

## Summary table

| | Pi | Codex | Claude Code |
|---|---|---|---|
| In-process custom tool w/ blocking async execute | **Yes** — `defineTool`/`registerTool`, no built-in timeout (verified) | **No** in-process API found; only external MCP server process (verified absence in docs consulted) | **Yes** — SDK `tool()`/`createSdkMcpServer()`, in-process, timeout ≥1000ms configurable (verified) |
| Out-of-process MCP tool w/ configurable timeout | N/A (no MCP client concept) | **Yes** — `mcp_servers.<name>.tool_timeout_sec` (default 60s, overridable) (verified) | **Yes** — `--mcp-config`, `MCP_TOOL_TIMEOUT` (default ~28h), per-server `timeout` (verified/secondary) |
| Native sub-agents | **No**, built-in (verified); yes via shipped example extension | **Yes**, `multi_agent` stable+on by default locally; per-role `model` pinning (verified); exec-mode support inferred, not confirmed | **Yes**, `--agents` JSON `model` field + built-in `Explore` (verified) |
| Parallel dispatch | Yes, default parallel tool calls; example extension adds explicit parallel mode (verified) | Yes for subagents, capped by `max_concurrent_threads_per_session` (verified); plain tool-call parallelism unconfirmed | Yes, ≤20 concurrent subagents default (verified) |
| Per-model usage breakout | Session totals sum tool-nested usage; no per-model map (verified). Moot for Fleet's actual design — a separate Fleet-dispatched process gets clean per-model separation for free (inferred) | Not established in docs; open gap, consistent with existing repo research's own "Prototype" flag | **Yes** — `modelUsage` on result message, explicitly designed for this (verified) |
| Same subscription allowance for helper/subagent usage | N/A — Fleet dispatches helper as its own pool/process, so this is a Fleet routing choice, not a Pi constraint | Inferred yes (secondary-sourced), not confirmed on a primary OpenAI page | **Yes**, verified — unified session billing including subagents |

## Sources consulted (primary, this pass)

- Repo: `src/fleet-extension.ts`, `src/pi-driver.ts`, `AGENTS.md`,
  `docs/wayfinder/assets/quota-aware/runner-contract.md` (branch
  `origin/wayfinder/runner-contract`), `docs/wayfinder/assets/quota-aware/execution-paths.md`
  (branch `research/subscription-execution-paths`), GitHub issues #48/#53/#64 and their
  resolving comments (`Kylevdm/pi-fleet`).
- Installed package docs: `node_modules/@earendil-works/pi-coding-agent/docs/{extensions,rpc,usage,sdk,containerization}.md`,
  `node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/{index.ts,agents.ts,README.md}`.
- CLI `--help` output (this pass, no prompts run): `pi --help`, `codex --help`,
  `codex exec --help`, `codex mcp --help`, `codex mcp add --help`, `codex mcp list --help`,
  `codex agents --help`, `codex features --help`, `codex features list`, `claude --help`.
- Official docs (fetched): `code.claude.com/docs/en/sub-agents`, `.../en/mcp`,
  `.../en/agent-sdk/cost-tracking`, `.../en/agent-sdk/typescript`, `.../en/agent-sdk/headless`;
  `learn.chatgpt.com/docs/extend/mcp?surface=cli`, `.../docs/config-file/config-reference`,
  `.../docs/agent-configuration/subagents`, `.../docs/non-interactive-mode`, `.../docs/codex-sdk`.
