# Fixtures for #65

Throwaway harness for the measurements in `../codex-probe-containment.md`. Kept as
evidence, not as code to carry into `src/`. Paths to the real `codex` binary are
hard-coded to the machine the measurements were taken on.

- `probe-latency.mjs` — cold spawn → `account/rateLimits/read` → exit, N runs. Output in
  `latency-runs.json`.
- `probe-warm.mjs` — repeated reads on one live app-server; shows the read is not cached.
- `probe-noauth.mjs` — the probe against an unauthenticated `CODEX_HOME`.
- `containment-session.mjs` — process-group and session termination; both leak.
- `containment-scope.mjs` — systemd transient scope termination; contains the tree.
- `resume-after-abort.mjs` — abort mid-tool-call, then resume by thread id.
- `exec-noauth.mjs` — the execution path's auth-failure emissions and internal retries.
- `shim-*.sh` — the three `codexPathOverride` shims, in the order they were tried.

The SDK harness files expect `@openai/codex-sdk` resolvable from their own directory and
`SP` in the environment pointing at a scratch directory containing `shimdir/` and `work/`.
