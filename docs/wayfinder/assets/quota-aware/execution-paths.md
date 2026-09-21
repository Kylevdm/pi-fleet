# Subscription-backed execution paths

Researched 2026-09-21. This note evaluates paths that can use an existing Codex, Claude, or OpenCode Go subscription without silently moving work onto a separately billed API account.

Labels used below:

- **Documented**: stated by the product's current primary documentation or public source.
- **Inference**: an architectural conclusion drawn from documented behavior.
- **Prototype**: behavior that the documentation does not settle and must be tested with the intended account and CLI version.

## Research conclusion

The evidence supports one runner contract with provider-specific execution adapters as an option for the later **Choose the execution-backend boundary** ticket. This is a research conclusion, not a settled Wayfinder architecture decision. That later ticket should evaluate:

- **Codex:** use the official Codex SDK, backed by `codex exec` and ChatGPT subscription login. This is the clearest supported path to model selection, sandbox controls, resumable threads, structured output, cancellation, and machine-readable usage.
- **Claude:** use native Claude Code in print mode with Claude Pro/Max login. Do not use `--bare`: Anthropic documents that bare mode does not use subscription login. Use safe mode plus an explicit tool and permission policy for unattended runs.
- **OpenCode Go:** keep Pi RPC as the initial adapter. OpenCode explicitly validates current Pi builds as a Go client, while Pi already exposes cancellation, session state, and normalized usage. If Fleet later needs schema-constrained output or typed provider errors, add an OpenCode SDK/server adapter.

Do not make Pi the only execution path. In particular, Pi is not a Claude Pro/Max allowance path: Pi documents that Claude use from third-party harnesses draws from Anthropic “extra usage,” billed per token. Anthropic separately says subscription use is intended for its native applications, including Claude Code, and directs third-party tools to API keys. ([Pi providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md), [Anthropic account login policy](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account))

## Subscription support boundary

| Execution path | Subscription-backed status | Decision |
|---|---|---|
| Codex SDK / `codex exec` → ChatGPT | **Documented.** Codex supports “Sign in with ChatGPT” for subscription access. ([Codex authentication](https://learn.chatgpt.com/docs/auth)) | Primary Codex path. |
| Claude Code `claude -p` → Claude Pro/Max | **Documented.** Claude Code is included with Pro/Max; an `ANTHROPIC_API_KEY` overrides the subscription and incurs API billing. ([Claude Code with Pro or Max](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)) | Primary Claude path. |
| OpenCode / Pi → OpenCode Go | **Documented.** Go supplies an API key under the subscription and lists Pi among validated clients. ([OpenCode Go](https://opencode.ai/docs/go/)) | Pi RPC first; OpenCode SDK/server if richer controls justify it. |
| Pi → Codex subscription | **Documented by Pi**, which offers ChatGPT Plus/Pro OAuth login. OpenAI documents ChatGPT sign-in for Codex itself and mentions Pi in its open-source program, but does not document a general third-party OAuth contract. ([Pi providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md), [Codex for open source](https://developers.openai.com/community/codex-for-oss)) | Available fallback, not the primary contracted path. Prototype reauthentication and quota behavior. |
| Pi → Claude subscription | **Not plan-backed.** Pi says third-party Claude authentication uses separately billed extra usage. Anthropic restricts subscription credentials to native applications. | Exclude from the subscription allowance router. |

An OpenCode Go API key is still a subscription credential even though it looks like a conventional provider key. Its limits are dollar-equivalent five-hour, weekly, and monthly allowances, and the documented place to view remaining usage is the Go console. ([OpenCode Go](https://opencode.ai/docs/go/))

## Execution control matrix

| Capability | Codex SDK / CLI | Claude Code CLI | OpenCode SDK / server / CLI | Pi RPC |
|---|---|---|---|---|
| Authentication | ChatGPT login or API key. ChatGPT login uses the plan; API keys are usage billed. | Claude account login uses Pro/Max. An environment API key takes precedence and is separately billed. | Go API key identifies the subscription. OpenCode stores provider credentials in its auth store. | Provider-specific login/key. Codex OAuth and Go are usable; Claude third-party auth is extra usage. |
| Model selection | `model` in the SDK or `--model` in `codex exec`. | `--model`. | `provider/model` via `--model`; SDK provider/model options. | `--provider`, `--model`, and RPC model-switch commands. |
| Tool policy | Sandbox preset plus approval policy; CLI supports `--sandbox` and `--ask-for-approval`. | `--tools`, `--allowedTools`, `--disallowedTools`, permission modes, and `--permission-prompts none`. | Permission rules can allow, ask, or deny tools globally or per agent. The default allows operations, so Fleet must supply policy. | Tool allow/exclude flags, but no built-in sandbox. Run unattended Pi work inside a container or equivalent boundary. |
| Noninteractive execution | `codex exec`; the SDK is intended for CI and internal workflows. | `claude -p`. | `opencode run`; SDK/server for long-lived integration. | Print, JSONL, or RPC mode. RPC is the best orchestration surface. |
| Sessions and continuation | SDK threads can start, continue, and resume; CLI has `exec resume`, including by ID or last session. | `--continue`, `--resume`, `--session-id`, and optional no-persistence mode. | CLI supports continue/session/fork; server and SDK expose session APIs. | Session JSONL supports continue, resume by path/ID, and fork. RPC exposes current state. |
| Structured output | `--output-schema`; JSONL event stream with `--json`; SDK accepts an output schema. | JSON or streaming JSON events; `--json-schema` validates the final result in JSON mode. | SDK supports schema output and a typed `StructuredOutputError`; `opencode run --format json` emits events but has no documented final-output schema flag. | JSONL/RPC events are structured, but there is no documented JSON-schema-constrained final answer. A Fleet-specific tool contract would be custom. |
| Cancellation | SDK accepts an `AbortSignal`. | SIGTERM exits 143 and leaves an unfinished turn resumable; SIGINT/SDK interrupt ends the active turn. | Server exposes `POST /session/:id/abort`; SDK has an abort method. | RPC `abort` stops the active operation and waits for idle. |
| Usage reporting | `turn.completed` reports input, cached-input, output, and reasoning tokens. | Result events include token usage and client-estimated cost. | Session messages/steps include tokens and cost; `opencode stats` aggregates usage. | Provider-normalized usage and cost are reported in events/session stats, sometimes only after completion. |
| Failure surface | JSONL has `turn.failed` and `error`, plus process exit status, but no documented stable failure taxonomy. | Retry events classify auth, billing, rate limit, overload, invalid request, model, server, output limit, cloud credentials, and unknown failures. | SDK schema defines auth, abort, output length, structured output, context overflow, content filter, API, and unknown errors. API errors include status and retryability. | Normalized stop reasons include stop, length, tool use, error, aborted, and deferred, with a free-text error message. |

The matrix is based on the official [Codex command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli), [Codex noninteractive guide](https://learn.chatgpt.com/docs/non-interactive-mode), [Codex SDK guide](https://learn.chatgpt.com/docs/codex-sdk), [Claude CLI reference](https://code.claude.com/docs/en/cli-reference), [Claude headless guide](https://code.claude.com/docs/en/headless), [OpenCode CLI](https://opencode.ai/docs/cli/), [OpenCode configuration](https://opencode.ai/docs/config/), [OpenCode agents](https://opencode.ai/docs/agents/), [OpenCode SDK](https://opencode.ai/docs/sdk/), [OpenCode server](https://opencode.ai/docs/server/), [Pi usage](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md), [Pi RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md), and [Pi sessions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sessions.md).

## Adapter notes

### Codex

**Documented.** `codex exec --json` emits JSONL lifecycle events including thread and turn start/completion/failure, item updates, errors, and terminal token usage. `exec resume` continues a thread. `--output-schema` constrains the final response. The official TypeScript SDK wraps the CLI, exposes thread start/resume, model and sandbox options, an output schema, and `AbortSignal`; the app server is the deeper integration surface when an application needs authentication, history, approvals, and live events. ([Noninteractive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [TypeScript SDK source](https://github.com/openai/codex/blob/main/sdk/typescript/src/exec.ts), [Codex app server](https://learn.chatgpt.com/docs/app-server))

**Inference.** The SDK is the smallest stable boundary for Fleet: it preserves official subscription authentication while avoiding a hand-maintained JSONL parser. Use a workspace-write sandbox by default, and make approval policy part of the job definition rather than inheriting user configuration implicitly.

**Limit.** Codex reports consumed tokens, not remaining ChatGPT plan allowance. A failed turn or generic error event is not enough to distinguish exhausted plan capacity from transient rate limiting without inspecting the actual payload.

### Claude Code

**Documented.** Print mode is the native noninteractive surface. `--safe-mode` disables hooks, skills, plugins, MCP, and project settings while preserving authentication, model selection, tools, and permissions. By contrast, `--bare` is designed for API-key automation and explicitly does not use subscription login. Claude's streaming system events can report retry attempts, delays, HTTP status, and categorized causes; final result events include the session ID, usage, and estimated cost. SIGTERM leaves the current turn unfinished and resumable. ([CLI reference](https://code.claude.com/docs/en/cli-reference), [Headless mode](https://code.claude.com/docs/en/headless))

**Inference.** Start with safe mode, an explicit tool allowlist, MCP denied, a non-prompting permission mode, and streaming JSON. This makes the native subscription path sufficiently deterministic for Fleet without relying on local extensions.

**Limit.** Usage and estimated cost are accounting signals, not remaining Pro/Max allowance. Anthropic documents `/status` for interactive monitoring, not a machine-readable remaining-quota endpoint.

### OpenCode Go

**Documented.** Go is intended for OpenCode and other coding agents. Clients should send their own user agent and a stable `x-opencode-session` value; Pi is currently a validated client. OpenCode's native SDK/server adds schema-constrained output, typed failures, SSE events, and an explicit session-abort endpoint. The CLI supplies event JSON and session continuation, while permissions support allow/ask/deny rules. ([OpenCode Go](https://opencode.ai/docs/go/), [OpenCode server](https://opencode.ai/docs/server/), [OpenCode SDK](https://opencode.ai/docs/sdk/))

**Inference.** Pi RPC is the lower-cost first adapter because Go explicitly supports it and Fleet already has a Pi seam. Native OpenCode becomes worthwhile if Fleet needs server-side session ownership, JSON-schema output, or typed error metadata. OpenCode's public session schema defines `ProviderAuthError`, `MessageAbortedError`, `StructuredOutputError`, `ContextOverflowError`, `ContentFilterError`, retryable `APIError`, and other useful categories. ([OpenCode session schema](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/v1/session.ts))

**Limit.** The Go console exposes allowance consumption, but no stable programmatic remaining-quota API is documented. The statement that Pi is validated is explicitly current-state compatibility, not a guarantee of future versions.

### Pi

**Documented.** Pi supports noninteractive JSONL and a bidirectional RPC mode. RPC can change models, abort, query state, and return session statistics. Session files are resumable and forkable. Pi normalizes provider output into stop reasons and usage fields. It does not provide a built-in sandbox; its security guide says project trust is not a sandbox and recommends external isolation for untrusted or unattended work. ([Pi JSON mode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md), [Pi RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md), [Pi AI types](https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts), [Pi security](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md))

**Inference.** Use RPC rather than one-shot print mode when Pi is the adapter. Fleet should own the process lifetime, enforce an external sandbox, persist the session identifier, and treat provider/model as explicit job inputs.

**Limit.** Pi's final-answer shape is not JSON-schema constrained, and its normalized failure surface is deliberately shallow. Fleet must classify provider-specific error text beneath `error` and must not mistake cumulative consumed usage for remaining allowance.

## Fleet runner contract

Each adapter should produce the same small set of runner events while retaining the raw provider event for diagnostics:

```text
started { provider, model, sessionId }
progress { message?, tool?, raw }
completed { output, usage, sessionId, raw }
failed { class, retryable, message, sessionId?, raw }
cancelled { sessionId?, raw }
```

The common request should include `provider`, `model`, `prompt`, `workingDirectory`, `toolPolicy`, `sandboxPolicy`, `continuation`, `outputSchema`, and an abort signal. A provider can reject unsupported combinations before launch; for example, Pi cannot honestly promise native schema-constrained output.

Use these initial normalized failure classes:

- `authentication`: invalid, expired, or disallowed subscription credentials.
- `allowance_exhausted`: confirmed plan, Go allowance, or billing ceiling exhaustion.
- `rate_limited`: temporary request throttling that is safe to retry later.
- `overloaded`: provider capacity failure.
- `invalid_request`: unsupported model, context overflow, content filtering, or malformed schema/prompt.
- `tool_policy`: denied tool or approval requirement.
- `cancelled`: orchestrator cancellation or provider abort.
- `provider_error`: classified server failure without a more specific Fleet class.
- `unknown`: unclassified failure; preserve the raw event and do not automatically retry indefinitely.

**Inference.** Routing must use observed capacity state, not token accounting alone. None of the four surfaces documents a stable programmatic “remaining subscription allowance” value. Fleet therefore needs a local allowance state machine fed by successful runs, positively identified exhaustion/rate-limit errors, cooldowns, and optional human-supplied resets. Cost and token totals remain reporting fields, not authoritative routing capacity.

## Required live prototypes

These behaviors are not settled by the documentation and should be tested before the adapter is treated as production-ready:

1. **Codex subscription exhaustion:** capture the exact SDK event, process status, message, and recovery timing when ChatGPT plan limits are reached; distinguish it from transient throttling and authentication expiry.
2. **Codex cancellation:** abort during model generation and during a tool call, then determine whether the same thread can be resumed safely and whether partial usage is reported.
3. **Claude safe-mode policy:** verify the exact noninteractive invocation against the installed version, including zero prompts, explicit tool restrictions, disabled MCP, JSON Schema plus streaming compatibility, and whether resumed SIGTERM work duplicates tool effects.
4. **Claude allowance/auth failures:** record Pro/Max exhaustion, expired login, account hold, and overload events; confirm that no `ANTHROPIC_API_KEY` in the runner environment can override subscription billing.
5. **OpenCode Go via Pi:** confirm required user-agent/session headers, session continuity across Pi restarts, cancellation while a tool is running, the event emitted at each Go limit, and whether cumulative usage appears only after completion.
6. **OpenCode native alternative:** compare SDK/server schema validation, abort behavior, and typed errors with Pi RPC using the same Go account before deciding whether the second adapter earns its maintenance cost.
7. **Process termination:** for every adapter, escalate cancellation from protocol/SDK abort to SIGTERM and finally process kill with timeouts; verify child-process cleanup, resumability, final event emission, and accounting.

Until these tests are captured as fixtures, failure-text parsing and allowance detection are versioned heuristics, not documented contracts.
