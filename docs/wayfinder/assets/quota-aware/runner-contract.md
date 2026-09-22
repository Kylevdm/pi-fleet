# The Fleet runner contract

Decided 2026-09-22 in [Choose the execution-backend boundary](https://github.com/Kylevdm/pi-fleet/issues/52), on the map [Quota-aware orchestration across subscription model pools](https://github.com/Kylevdm/pi-fleet/issues/47).

This note is the interface form of that decision. It is a design artifact, not shipped code: nothing here is implemented, and the map is planning-only until it closes.

Evidence it rests on: [execution-paths.md](./execution-paths.md) (#48), [quota-signals.md](./quota-signals.md) (#53), [harness-survey.md](./harness-survey.md) (#64), and the ten frozen invariants recorded in [#61](https://github.com/Kylevdm/pi-fleet/issues/61).

## The shape

Fleet does not invoke all work through Pi, and does not invoke provider-native CLIs directly from the supervisor. It exposes **one narrow runner contract** with **provider-specific adapters** behind it. Pi is demoted from *the* runner to *a* runner.

The forcing fact is billing, not capability. Pi can log into Claude Pro/Max, but its own provider documentation says third-party harness usage draws from Anthropic "extra usage" and is billed per token rather than against plan limits. #64 found that shape is the field's default rather than Pi's quirk — Amp, Charm Crush's Hyper, Cursor CLI under BYOK, Goose→Claude and Qwen Code all reproduce it. A quota-aware orchestrator whose whole purpose is spending plan allowance cannot reach Claude's allowance through a harness that bills per token, so no single runner can cover every pool.

## Vocabulary

- **Runner** — the Fleet-owned contract a stage attempt executes through. One contract, several implementations.
- **Adapter** — one implementation of the runner contract for one execution path. Private behind the module interface (#2). Three in the first slice: Pi RPC, Codex SDK, Claude Code CLI.
- **Pool** — an account *plus* an execution path, not an account. `codex-plus-native` and `codex-plus-via-pi` are two pools over one ChatGPT subscription, because they spend different meters. The adapter is a fixed property of the pool; routing chooses between pools, never between adapters for a pool.
- **Billing mode** — `plan-allowance` or `per-token`, declared per pool. The distinction that makes a leaked meter visible in configuration instead of invisible at runtime.
- **Capability** — a behavior an adapter either provides or does not. Declared, not assumed.
- **Failure class** — the normalized vocabulary an adapter translates provider errors into.
- **Failure shape** — what a class means to the scheduler: attempt-fatal, pool-fatal, or transient.
- **Allowance probe** — an optional pre-dispatch query for remaining plan allowance. Advice, never authority.

## Decisions

### 1. Interchangeable runner backends (Q1)

One contract, provider-specific adapters, Pi as one of them.

### 2. Fleet owns every process lifetime (Q2)

One process per stage attempt. No daemons, no process reuse across attempts. An adapter may carry a **session identifier** across attempts; it may never carry a process.

Adapters must acquire child processes through a core-supplied process host, so Fleet retains the handle and the kill authority the fenced-lease recovery invariant (#3) assumes. An SDK-based adapter that spawns internally — the Codex SDK wraps `codex exec` — must be wrapped so the host still sees the child. Whether that containment holds is a prototype item, not a settled fact.

### 3. Adapters classify; the core maps class to outcome (Q3, Q12)

The adapter is the only component that knows a provider's dialect, so classification lives there. Every event carries the raw provider payload alongside the normalized form. `unknown` is a legitimate classification and never auto-retries.

This ticket fixes the classes and their **shape**. It does not fix the policy table — that belongs to [#55](https://github.com/Kylevdm/pi-fleet/issues/55) (retry, escalation, terminal return) and [#62](https://github.com/Kylevdm/pi-fleet/issues/62) (capacity and scarcity), which inherit this vocabulary.

| Class | Shape | Meaning |
| --- | --- | --- |
| `authentication` | pool-fatal | Invalid, expired, or disallowed subscription credentials. |
| `allowance-exhausted` | pool-fatal | Confirmed plan, Go allowance, or billing-ceiling exhaustion. Carries a reset hint when the provider gives one. |
| `rate-limited` | transient | Throttling that is safe to retry after a cooldown. |
| `overloaded` | transient | Provider capacity failure. |
| `invalid-request` | attempt-fatal | Unsupported model, context overflow, content filter, malformed schema or prompt. |
| `tool-policy` | attempt-fatal | Denied tool or an approval the unattended run cannot answer. |
| `cancelled` | attempt-fatal | Orchestrator cancellation or provider abort. |
| `provider-error` | transient | Classified server failure with no more specific class. |
| `unknown` | attempt-fatal | Unclassified. Preserve the raw event; never auto-retry. |

Pool-fatal means the *pool* is out, not the job: the job is re-routable to another pool and the pool enters whatever cooldown #62 defines.

### 4. The core owns the transcript (Q4)

Adapters emit events; the core writes the stage transcript artifact at the core's path. This keeps the seal, the scrub at seal and at egress, and the size cap uniform across adapters, exactly as the retention invariant (#12) requires.

An adapter-discovered session file — Pi's session JSONL at a discovered path, a Codex thread id, a Claude session id — is recorded on the job as a **diagnostic pointer**, never as the artifact. This settles the acquisition half of #12 that #61 reopened.

### 5. A generic termination ladder (Q5)

Rung one is adapter-supplied abort (SDK `AbortSignal`, RPC `abort`, session-abort endpoint, interrupt). Rungs two and three are SIGTERM and SIGKILL, owned by the core, with Fleet-policy timeouts. The ladder already built in `src/pi-driver.ts` is lifted out as the shared implementation.

### 6. Declared capabilities with pre-launch refusal (Q6)

The contract is not the intersection of what all adapters can do — that would forbid schema-constrained output forever because Pi lacks it, and would let a job needing isolation run unsandboxed on Pi, which has no sandbox at all. Each adapter declares a capability set; the core refuses an incompatible request **before dispatch**, the same shape as #8's refuse-on-open-blocker rule.

### 7. Pool identity carries the execution path (Q7)

See Vocabulary. Routing ([#57](https://github.com/Kylevdm/pi-fleet/issues/57)) chooses pools on quota; it never chooses an adapter.

### 8. Three adapters in the first slice (Q8)

Pi RPC (already built, serves OpenCode Go), Codex SDK, Claude Code CLI in print mode with safe mode and an explicit tool policy. OpenCode's own SDK/server is deferred — it earns its maintenance cost only if Pi RPC proves insufficient for Go. The candidates #64 surfaced (Factory Droid, Gemini CLI, Copilot CLI, Cline's Claude Code provider mode) are second-slice questions.

### 9. Fleet declares policy; adapters translate or refuse (Q9)

Tool and sandbox policy are an abstract Fleet vocabulary. Each adapter translates it into its own surface — `--sandbox`/`--ask-for-approval`, `--allowedTools` plus permission mode, allow/ask/deny rules, Pi's allow/exclude flags — or declares the capability missing. Pi cannot sandbox, so a job requiring isolation refuses a Pi pool rather than quietly running without one.

### 10. Each attempt starts clean (Q10)

No provider-session resume in v1. The session id is persisted as a diagnostic pointer only. Resuming is cheaper in tokens but cannot honour "reconcile in-flight calls exactly once" (#3) without knowing what an aborted turn already did. Reopening this needs the #48 prototype that establishes whether a resumed SIGTERM'd turn duplicates tool effects.

### 11. The allowance probe is an optional capability (Q11, Q14)

Codex's app-server `account/rateLimits/read` — with `ordinaryUsageAllowed`, bucket percentages, window lengths and reset times — is the only hard pre-dispatch quota gate available to Fleet. #64 confirmed that across fifteen surveyed harnesses nothing else exposes a remaining-plan-allowance check; the nearest miss, Amp's `amp usage`, reports a dollar-credit balance under pass-through pricing.

The probe is therefore an **optional capability**, not a contract requirement. A pool without one is not second-class, and #62 must treat any probe result as advice rather than authority.

The app-server is a long-lived JSON-RPC server, which collides with decision 2. Resolution: **execution stays on the SDK; the probe spawns a short-lived app-server, reads the rate limits, and exits.** Fleet owns every process lifetime and nothing outlives a stage attempt. #62 may cache a snapshot with a TTL. If per-admission spawn cost proves prohibitive, letting the Codex adapter own a daemon is a later, evidence-backed reopening rather than a v1 guess.

`ordinaryUsageAllowed === null` means *unavailable*, never *available*.

## The interface

```ts
/** A pool is an account plus an execution path. The adapter is fixed per pool. */
export interface PoolConfig {
  readonly id: string;                    // "codex-plus-native", "claude-max", "opencode-go-via-pi"
  readonly adapter: AdapterKind;
  readonly billing: "plan-allowance" | "per-token";
  readonly models: readonly string[];
}

export type AdapterKind = "pi-rpc" | "codex-sdk" | "claude-cli";

/** Declared, not assumed. The core refuses an incompatible request before dispatch. */
export interface RunnerCapabilities {
  readonly sandbox: boolean;
  readonly toolAllowlist: boolean;
  readonly structuredOutput: boolean;
  readonly allowanceProbe: boolean;
  readonly resume: boolean;               // declared; unused in v1 (decision 10)
}

export interface ToolPolicy {
  readonly allowed: readonly string[];
  readonly denyMcp: boolean;
  readonly approvals: "never";            // unattended runs never prompt
}

export interface SandboxPolicy {
  readonly isolation: "required" | "preferred" | "none";
  readonly writableRoots: readonly string[];
  readonly network: "deny" | "allow";
}

export interface StageRequest {
  readonly jobId: string;
  readonly stageIndex: number;
  readonly attempt: number;
  readonly pool: string;
  readonly model: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly toolPolicy: ToolPolicy;
  readonly sandboxPolicy: SandboxPolicy;
  readonly outputSchema: unknown | null;
  readonly timeouts: { readonly launchMs: number; readonly stageMs: number };
}

export interface Usage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly estimatedCost: number | null;  // reporting only, never routing capacity
}

export type FailureClass =
  | "authentication"
  | "allowance-exhausted"
  | "rate-limited"
  | "overloaded"
  | "invalid-request"
  | "tool-policy"
  | "cancelled"
  | "provider-error"
  | "unknown";

export type FailureShape = "attempt-fatal" | "pool-fatal" | "transient";

export interface RunnerFailure {
  readonly class: FailureClass;
  readonly shape: FailureShape;
  readonly retryAfterMs: number | null;
  readonly message: string;
}

/** Every event carries the raw provider payload beside the normalized form. */
export type RunnerEvent =
  | { readonly kind: "started"; readonly sessionId: string | null; readonly model: string; readonly raw: unknown }
  | { readonly kind: "progress"; readonly tool: string | null; readonly message: string | null; readonly raw: unknown }
  | { readonly kind: "usage"; readonly usage: Usage; readonly raw: unknown }
  | { readonly kind: "completed"; readonly output: string; readonly usage: Usage; readonly raw: unknown }
  | { readonly kind: "failed"; readonly failure: RunnerFailure; readonly raw: unknown }
  | { readonly kind: "cancelled"; readonly raw: unknown };

/** Advice, never authority. `allowed: null` means unknown, which is not "yes". */
export interface AllowanceSnapshot {
  readonly pool: string;
  readonly allowed: boolean | null;
  readonly usedPercent: number | null;
  readonly resetsAt: string | null;
  readonly observedAt: string;
}

/**
 * The core supplies this. Adapters acquire every child process through it, so
 * Fleet keeps the handle, the termination ladder, and the kill authority.
 */
export interface ProcessHost {
  spawn(spec: LaunchSpec): Promise<ProcessHandle>;
}

export interface LaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

export interface ProcessHandle {
  readonly pid: number;
  readonly stdout: AsyncIterable<string>;
  /** Rungs two and three of the ladder. Rung one is the adapter's own abort. */
  terminate(): Promise<TerminateRung>;
}

export type TerminateRung = "abort" | "sigterm" | "sigkill";

export interface Runner {
  readonly kind: AdapterKind;
  readonly capabilities: RunnerCapabilities;

  /** Pre-launch refusal (decision 6). Null means the request is executable. */
  accepts(request: StageRequest): Problem | null;

  /** Emits normalized events. The core writes the transcript; the adapter never does. */
  run(
    request: StageRequest,
    host: ProcessHost,
    signal: AbortSignal,
  ): AsyncIterable<RunnerEvent>;

  /** Rung one of the termination ladder. */
  abort(): Promise<void>;

  /** Present only when `capabilities.allowanceProbe` is true. */
  probeAllowance?(pool: string, signal: AbortSignal): Promise<AllowanceSnapshot>;
}
```

### What the core owns, not the adapter

Process spawn and lifetime; the termination ladder past rung one; the transcript artifact and its scrub, cap and seal; call-intent recording before any paid call; capability checking; the class-to-outcome mapping.

### What the adapter owns

The launch spec or SDK invocation; decoding the provider's event stream; classifying provider errors into a `FailureClass`; rung-one abort; the optional allowance probe; declaring its own capabilities honestly.

## Consequences

`src/pi-driver.ts` (ticket 25) becomes the Pi RPC adapter. Its JSONL framing, usage summing and termination ladder survive; the ladder and the artifact writing move into the core, and its outcome classification is rewritten into the `FailureClass` vocabulary above, which is wider than the current infrastructure/quality split. `resolvePiBinary` becomes adapter-private.

The supervisor stops calling `runStage` directly and calls through the runner contract with a pool rather than a Pi binary path.

Nothing above breaks a frozen invariant from #61.

## Unsettled, deliberately

- Whether a short-lived app-server spawn is fast enough to sit in the admission path, and whether an SDK-spawned `codex exec` child stays visible to the process host. Prototype, not inference.
- The class-to-outcome policy table (#55, #62).
- Provider-plural context sizing and admission limits (#63).
- Second-slice adapters (#64's candidates).
