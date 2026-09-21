# Observable subscription quota signals

Research date: 2026-09-21.

## Finding

Codex is the only reviewed path with a documented, machine-readable account quota query that Fleet can call before dispatch. Claude Code exposes comparable five-hour and seven-day percentages and reset times to its interactive status-line integration and `/usage` screen, but its documented headless CLI has no standalone quota query. OpenCode Go publishes its limit formula and shows current usage in the web console, while the supported CLI learns the reset interval only when Go rejects a request. Pi exposes configured models, per-call usage, and provider errors, but no subscription-ledger query.

Fleet therefore cannot treat all pools as if they had a common "remaining tokens" API. Its capacity model needs to represent the source and confidence of each observation.

This note distinguishes four kinds of signal:

- **Quota snapshot** comes from the provider's account ledger. It can support admission decisions.
- **Run usage** reports tokens or estimated cost for work already in progress or completed. It supports accounting and local forecasts, not an authoritative remaining balance.
- **Catalog/auth** shows that a model and credential are configured. It does not prove current service health or available quota.
- **Failure-derived cooldown** is learned when a request is rejected. It is useful for a circuit breaker, but too late to prevent that dispatch.

## Signals by phase

| Path | Before dispatch | During a run | After completion | Only after rejection |
| --- | --- | --- | --- | --- |
| Codex CLI/app-server with ChatGPT auth | `account/read` reports auth and plan. `account/rateLimits/read` reports `ordinaryUsageAllowed`, quota buckets, used percentage, window length, reset time, credits, spend-control state, and the server's reached-limit classification. | `account/rateLimits/updated` supplies rolling quota updates. `thread/tokenUsage/updated` supplies thread usage. | `account/usage/read` supplies account token summaries and daily buckets. A turn ends with a structured `completed`, `interrupted`, or `failed` status. | A failed turn can carry structured `codexErrorInfo`; quota state also has `rateLimitReachedType`. |
| Claude Code with Claude subscription auth | `claude auth status` proves login only. In an interactive session, `/usage` shows plan bars. A configured status-line command receives five-hour and seven-day used percentages and reset epochs. There is no documented standalone headless quota command. | The status-line payload refreshes after assistant messages and when a reported reset time arrives. `stream-json` emits live run events and retry events, but the documented headless stream does not expose the plan bars as its own quota record. | The final JSON result contains usage metadata, estimated cost, and per-model cost. `/usage` has session token totals plus locally computed recent attribution. | The process exits nonzero and prints an in-run failure on stdout. User-facing limit errors include a reset time. |
| OpenCode Go through OpenCode | The console shows current use. `opencode models opencode-go` and the Go models endpoint show the current catalog, not remaining quota or live health. No supported CLI or public usage endpoint is documented. | `opencode run --format json` emits raw `step_finish` records with tokens and cost. Session errors retain provider status, headers, and body. These are run telemetry, not the Go ledger. | `opencode stats` aggregates locally stored token and cost statistics; session export preserves the run. | OpenCode recognizes `GoUsageLimitError`, reads the affected `limitName` and `retry-after`, and presents the reset interval. |
| Pi RPC/provider abstraction | `get_available_models` lists configured models whose credentials are available. It does not probe live quota or service health. | `message_update.usage` carries the latest cumulative provider-reported input, output, cache, total-token, and cost values. It can remain zero until completion. Retry events expose attempt, delay, and provider error text. | `message_end`, `turn_end`, and `get_session_stats` preserve model, provider, stop reason, tokens, cost, and context use. | The assistant message has `stopReason: "error"` and `errorMessage`; `auto_retry_end` has `finalError`. Pi has no provider-neutral structured quota bucket or reset field. |

## Documented facts

### Codex

The Codex app-server protocol is suitable as a quota control plane. `account/rateLimits/read` returns a single legacy bucket and, when supplied, a map of buckets. Each window can include `usedPercent`, `windowDurationMins`, and `resetsAt`. The response can also include credit details and a server-classified reached state. `account/rateLimits/updated` publishes later changes. `account/usage/read` is a separate historical token-activity query. [Codex app-server account methods](https://developers.openai.com/codex/app-server#6-rate-limits-chatgpt)

The current protocol adds the stronger `ordinaryUsageAllowed` field. Its source comment says `null` means unavailable and clients must not infer recovery from percentages or reset times. Fleet should prefer this boolean for a hard admission gate and treat percentages as planning information. [Codex account protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/account.rs)

The interactive `/status` command and TUI status line also show rate limits, but app-server avoids terminal scraping. OpenAI's help page directs users to the usage dashboard or `/status` to identify the exhausted allowance, credit balance, and shown reset time. It also says usage depends on model, execution location, task complexity, context, reasoning, speed, and tools. [Codex developer commands](https://developers.openai.com/codex/cli/slash-commands#inspect-the-session-with-status), [Using Codex with a ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan#usage-limits-by-plan)

### Claude Code

Claude Code's documented status-line JSON includes `rate_limits.five_hour.used_percentage`, `rate_limits.seven_day.used_percentage`, and their `resets_at` Unix timestamps. Claude Code runs the status-line command at session start, after a new assistant message, and when a reported reset time arrives. The command itself consumes no model tokens. This is a supported TUI integration, not a standalone account API. [Claude Code status-line data](https://code.claude.com/docs/en/statusline#available-data)

The interactive `/usage` screen shows plan usage bars for subscription users. Its attribution view is only an approximation from local session history and excludes other devices and claude.ai. If the plan-usage request fails, it can show a cached snapshot no more than 60 minutes old. [Claude Code usage and costs](https://code.claude.com/docs/en/costs#using-the-usage-command)

For unattended execution, `claude -p --output-format stream-json` provides real-time run events and a final result with usage and cost metadata. Retryable API failures produce `system/api_retry` events. The documented JSON cost is a client-side estimate, not an account balance. [Claude Code programmatic usage](https://code.claude.com/docs/en/headless#stream-responses)

Anthropic does not publish a fixed token allowance for Pro. It says consumption depends on conversation length and complexity, features, model, and effort. Pro has a five-hour window and a weekly limit, and Anthropic may apply other weekly, monthly, model, or feature caps. [Claude Pro limits](https://support.claude.com/en/articles/8325606-what-is-the-pro-plan#does-the-pro-plan-have-any-usage-limits)

### OpenCode Go

Go defines allowance in dollar-valued model usage. Each model's five-hour limit is 20% of its published monthly allowance, its weekly limit is 50%, and its monthly limit is 100%. Monthly allowance and token rates vary by model. The same page says current usage is visible in the console and documents public inference and model-list endpoints, but it does not document a current-usage API. It also confirms that current Pi builds are validated Go clients. [OpenCode Go limits and supported clients](https://dev.opencode.ai/docs/go/#usage-limits)

The OpenCode CLI can list provider models, emit raw JSON events from a run, report local session stats, and export sessions. The model list is a catalog. The stats command reports locally recorded tokens and cost. [OpenCode CLI reference](https://opencode.ai/docs/cli/)

OpenCode's first-party source preserves provider `statusCode`, `responseHeaders`, and `responseBody` on a session API error, while each `step-finish` record contains token buckets and cost. [OpenCode session schema](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/message-v2.ts)

For a Go quota rejection, the retry policy specifically detects `GoUsageLimitError`, reads `metadata.limitName`, parses `retry-after`, and labels the condition `account_rate_limit`. This yields a useful cooldown only after a request has failed. [OpenCode Go retry classification](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/retry.ts)

If the user enables "Use balance," Go falls back to the Zen pay-as-you-go balance after included limits instead of blocking. A successful run therefore does not prove included subscription quota remains. [OpenCode Go usage beyond limits](https://dev.opencode.ai/docs/go/#usage-beyond-limits)

### Pi

Pi RPC has `get_available_models`, streaming events, session statistics, and retry events. The usage object contains input, output, cache read/write, total tokens, and calculated cost. The latest cumulative usage may remain zero until completion if a provider reports usage only at the end. Pi classifies rate limits with overload and 5xx responses as transient for automatic retry, and exposes the provider error as text. It does not define an account-quota read command. [Pi RPC protocol](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)

Pi supports ChatGPT Plus/Pro Codex login and Claude subscription login. Its current provider documentation warns that Claude Pro/Max use through an unofficial third-party client draws from paid extra usage rather than the included Claude plan allowance. Native Claude Code is therefore the supported path for spending the included Claude subscription pool. [Pi provider authentication](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md#subscriptions)

## What remains opaque

- **Codex task cost before execution.** The account snapshot gives percentages and reset times, not the exact allowance units or the percentage a proposed task will consume. OpenAI states that task shape and execution choices affect use.
- **Codex bucket applicability in every case.** The protocol may return several metered buckets and a `normalModelSlug`, but it does not promise a complete list of every bucket a requested model will debit. Fleet should not guess from a display name.
- **Claude's absolute included allowance.** The supported UI gives percentages, windows, and reset times. Anthropic does not state the underlying token or dollar amount, and it reserves other caps. Local session tokens cannot be converted reliably into remaining plan percentage.
- **Claude quota in a clean headless preflight.** The reviewed CLI reference documents JSON auth status and headless run output, but no non-interactive equivalent of `/usage`. A status-line bridge needs an interactive Claude Code session.
- **OpenCode Go's current balance through a public machine API.** Published prices make a local burn estimate possible, but the authoritative current use remains in the console. Other clients, delayed accounting, model-specific limits, and optional Zen fallback can make a local estimate diverge.
- **Pi subscription state.** Pi reports calls that passed through the current process. It does not know the provider's full account ledger, other clients' usage, remaining allowance, or reset time. Its calculated cost is not proof of how a subscription meter moved.
- **Live provider availability before work.** Every runner can establish some combination of valid auth and a model catalog. None of those signals proves that a model will accept the next request. Overload, regional availability, transient transport faults, and some account restrictions remain failure-time facts.

## Inferences for Fleet

The following are design implications, not provider guarantees.

1. **Store observations, not one synthetic balance.** A capacity observation should include `kind` (`quota-snapshot`, `run-usage`, `catalog-auth`, or `failure-cooldown`), account or credential identity when supported, provider, model or bucket, observed time, reset time, value, and source runner.
2. **Give only Codex a hard pre-dispatch quota gate in the first version.** Poll `account/rateLimits/read`. Dispatch on included quota only when `ordinaryUsageAllowed === true`; mark `null` or query failure as `unknown`; block when the field is `false`. Do not turn missing data into "available."
3. **Treat Claude's quota as advisory unless Fleet deliberately maintains an interactive status-line bridge.** Without that bridge, admit from a bounded local budget and open a provider-recovery wait after a native limit failure. Do not scrape terminal rendering or private web endpoints.
4. **Treat OpenCode Go as estimate plus circuit breaker.** Accumulate observed per-run cost against the published windows, but label it an estimate. On `GoUsageLimitError`, store the named limit and `retry-after` as the authoritative cooldown. Refreshing the console remains a human diagnostic.
5. **Use Pi as execution telemetry, not quota authority.** Pi can normalize tokens, cost estimates, model, provider, stop reason, and errors across providers. Its model list must not be used as proof of capacity. A known quota error should stop provider retries and open a Fleet-level cooldown instead.
6. **Keep quota separate from concurrency and health.** Process slots answer "can another worker run locally?" Quota snapshots answer "does this account permit included usage?" Failure cooldowns answer "when should this route be tried again?" Catalog/auth answers only "is this route configured?"

The first useful router can therefore make a strong Codex admission decision, an advisory Claude decision when interactive telemetry is present, and conservative OpenCode Go and Pi decisions based on local burn plus cooldowns. Any design that requires one exact cross-provider "remaining quota" number depends on data the supported interfaces do not provide.
