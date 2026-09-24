# Skill-loading fact-finding: Pi, Codex, Claude Code

Installed locally: `pi` 0.85.1 (`@earendil-works/pi-coding-agent@0.85.1`), `codex` 0.156.1
(`@openai/codex@0.156.1`), `claude` 2.1.281. `@openai/codex-sdk` is **not** installed locally
(latest on npm is 0.156.1, matching the CLI; alpha channel is at 0.158.0-alpha.8). No local
Claude Code TypeScript SDK package was found either — findings for Claude Code rest on the
installed CLI's own `--help` output plus official docs.

Sources consulted: `pi --help`, `pi config/list/install --help`, installed package docs at
`~/.nvm/versions/node/v22.23.1/lib/node_modules/@earendil-works/pi-coding-agent/docs/{skills,rpc}.md`;
`codex --help`, `codex exec --help`, `codex plugin add/marketplace --help`, `codex features list`
(live output of the installed binary); the `openai/codex` GitHub repo source
(`codex-rs/ext/skills/src/host_roots.rs`, `host_service.rs`, `core/config.schema.json`,
`features/src/lib.rs`) fetched via `gh api`/`gh search code` — this is the **main-branch** source,
which may be slightly ahead of the installed 0.156.1 binary; `claude --help` (installed CLI);
WebFetch of `code.claude.com/docs/en/skills` and `code.claude.com/docs/en/cli-reference`;
WebSearch for `CLAUDE_CONFIG_DIR` (corroborated via `anthropics/claude-code` GitHub issues, since
the live docs fetch for it truncated before reaching that entry).

---

## 1. Pi (`pi --mode rpc -e fleet-extension.ts`)

**Verified — native support, explicit directory flag, restrictable, RPC-compatible.**

- Pi implements the [Agent Skills standard](https://agentskills.io/specification) natively
  (source: `docs/skills.md` in the installed package). SKILL.md format is exactly what Fleet
  expects from Matt Pocock's skills (Pi is deliberately lenient about the one place it diverges:
  it does not require `name` to match the parent directory, "because that requirement is
  suboptimal for shared skill directories used across multiple agent harnesses" — the package
  even documents pointing Pi at `~/.claude/skills` / `~/.codex/skills` directly).
- **Discovery locations** (verified, `docs/skills.md`): global `~/.pi/agent/skills/`,
  `~/.agents/skills/`; project `.pi/skills/`, `.agents/skills/` (cwd up to repo root, only after
  the project is trust-approved); package `skills/` dirs / `pi.skills` in `package.json`;
  `settings.json` `skills` array; CLI `--skill <path>` (repeatable).
- **Explicit Fleet-supplied directory, no global/repo writes** (verified, `pi --help` +
  `docs/skills.md`): `--skill <path>` loads a specific skill file or directory for that
  invocation. Critically, it is **additive even with `--no-skills`** — i.e. `--no-skills --skill
  /fleet/skills/implement --skill /fleet/skills/tdd` loads exactly those two skills and nothing
  else discovered from `~/.pi`, `~/.agents`, `.pi/`, `.agents/`, or packages. This is a clean,
  documented, single-invocation mechanism requiring no writes to the user's `~/.pi/agent/` config
  or to the target repository.
- **Restriction to only Fleet's skills**: yes — `--no-skills` (disable discovery) combined with
  repeated `--skill <path>` (explicit loads) gives Fleet exact, closed control over the skill set
  for that run. (Pi's own docs recommend this pattern implicitly by calling `--skill` paths
  "additive even with `--no-skills`".)
- **Invocation model** (verified, `docs/skills.md` "How Skills Work" + Frontmatter table):
  default is automatic — descriptions are always in the system prompt (progressive disclosure);
  the agent decides when to `read` the full `SKILL.md`, "though models don't always do this; use
  prompting or `/skill:name` to force it." Frontmatter `disable-model-invocation: true` — "When
  `true`, skill is hidden from system prompt. Users must use `/skill:name`" — i.e. it suppresses
  automatic loading; only explicit `/skill:name` remains.
- **Headless/RPC compatibility of explicit invocation** (verified, `docs/rpc.md` line 69, 82,
  104): "Input expansion: Skill commands (`/skill:name`) and prompt templates (`/template`) are
  expanded before sending/queueing" — this applies to the `prompt`, `steer`, and `follow_up` RPC
  commands used by `pi --mode rpc`. So Fleet's driver can force-invoke a specific Fleet-chosen
  skill even in headless/RPC mode by putting `/skill:name` literally in the prompt text it writes
  to the child's stdin — this is not TUI-only.

**Net for Pi**: full "yes" on every question. `--no-skills` + repeated `--skill <path>` gives an
exact, closed, Fleet-chosen skill set with no discovery leakage and no writes outside the
invocation's own argv; `disable-model-invocation` plus `/skill:name` in the RPC `prompt` command
gives Fleet control over whether the skill loads automatically or only on Fleet's explicit say-so.

---

## 2. Codex (`codex exec`, via `@openai/codex-sdk` in Fleet's design)

**Verified — native support, default-on, but no discovered session-scoped external-directory
flag; restriction and isolation are materially harder than Pi/Claude Code.**

- **Native support / enabled by default**: verified live from the installed 0.156.1 binary —
  `codex features list` shows `skill_search  stable  true` (already stable and *on*) and
  `skip_host_skill_discovery  under development  false`. There is no bare `skills` feature key in
  this version, which contradicts a blog claim (Dec 2025, pre-dates this install) that
  `--enable skills` is required — on the installed version skills are on by default; no
  `--enable`/`-c features.*=true` needed. (Marked verified for *this* installed version; the
  historical blog claim is noted only as context, not relied on.)
- **Default discovery roots** (verified via `openai/codex` GitHub source,
  `codex-rs/ext/skills/src/host_roots.rs`, main branch): per config layer —
  - Project layer: `<project-config-folder>/skills` (repo-scoped Codex config dir)
  - User layer: deprecated `$CODEX_HOME/skills` (kept for back-compat), `$HOME/.agents/skills`,
    plus a system/bundled cache dir
  - System/admin layer: `<admin-config-folder>/skills`
  - Plus `.agents/skills` walked from cwd up to the detected project root
    (`repo_agents_skill_roots`)
  - Plus any `PluginSkillRoot`s contributed by installed Codex plugins
  - `CODEX_HOME` (verified via source comments/`SYSTEM_SKILLS_DIR`/`skill-installer` sample skill
    text: "creates discoverable skills in `$CODEX_HOME/skills`, or `~/.codex/skills` when
    `CODEX_HOME` is unset") is a real env var Fleet could redirect per-run — but note it only
    moves the **deprecated user-scope** `$CODEX_HOME/skills` root; `$HOME/.agents/skills` is
    keyed off the real `$HOME`, not `$CODEX_HOME`, so overriding `CODEX_HOME` alone does **not**
    fully isolate a run from a real user's skills, and Fleet would also have to replicate/symlink
    whatever else lives in `$CODEX_HOME` (auth, config.toml) into the redirected directory for the
    run to still authenticate. This is inferred from source, not from an explicit doc statement,
    and not tested.
- **Explicit, session-scoped external skills directory (the thing Fleet actually wants)**:
  **not found**, and the source structure suggests it doesn't exist as a surfaced option. In
  `host_roots.rs`, `resolve_skill_roots()` does take an `extra_skill_roots: Vec<AbsolutePathBuf>`
  parameter, but tracing its only caller (`host_service.rs::skill_roots_for_config`) shows that
  parameter is fed by `self.extra_roots()` — a method with no CLI flag, `-c` config key, or env
  var wired to it that `gh search code` could find; it looks like an internal/test-only hook, not
  something `codex exec` or the `@openai/codex-sdk` protocol exposes. The other parameter to the
  same function, `plugin_skill_roots` (`Vec<PluginSkillRoot>`), **is** live — it comes from
  `plugin_outcome.effective_plugin_skill_roots()`, i.e. from Codex's plugin system. But unlike
  Claude Code's `--plugin-dir <path>` (session-only, no global write), Codex's plugin surface
  (`codex plugin add`, `codex plugin marketplace add`) installs into the persistent, global
  `~/.codex` plugin cache/config — no session-scoped, ephemeral "load this plugin/skill dir for
  just this run" flag was found on `codex`, `codex exec`, or `codex plugin --help`.
  **Conclusion (inferred from source + exhaustive `--help` review, not from an explicit "there is
  no such flag" doc statement): as of 0.156.1, Fleet cannot point a single `codex exec` run at an
  external, Fleet-chosen skills directory without either writing into `$CODEX_HOME` (global-ish,
  though redirectable per-run via the `CODEX_HOME` env var with the auth-replication caveat above)
  or installing a plugin into the persistent Codex plugin store.**
- **Restricting to only Fleet's chosen skills** (verified via `config.schema.json`): the
  `[[skills.config]]` array (`SkillConfig { enabled: bool (required), name?: string, path?:
  AbsolutePathBuf }`) lets a `-c`/config.toml override enable/disable *already-discovered* skills
  by name or path selector, and `skills.bundled.enabled = false` turns off Codex's bundled system
  skills — but neither adds a new root; they only prune what the standard roots above already
  found. So "only Fleet's skills, nothing else" is not cleanly achievable without either
  `skip_host_skill_discovery` (currently `under development`, default `false` — its exact effect
  wasn't traced further given it's not yet a stable, documented feature) or accepting the
  CODEX_HOME-redirect caveat above.
- **Automatic vs. explicit invocation** (verified via the OpenAI docs redirect target,
  `learn.chatgpt.com/docs/build-skills`, plus corroborated by `mattpocock/skills` issue #516):
  Codex supports both; default is automatic description-matching, `$skill-name` forces explicit
  invocation. Critically — Codex does **not** read Claude's `disable-model-invocation` SKILL.md
  frontmatter field at all; it needs its own sidecar file, `agents/openai.yaml`, with
  `policy.allow_implicit_invocation: false` to suppress auto-invocation (this is exactly why
  `mattpocock/skills` ships an `agents/openai.yaml` next to every user-invoked `SKILL.md` — per
  its own issue #163/#516 history, cross-harness frontmatter is not portable to Codex; the
  Codex-specific metadata file is mandatory if Fleet wants the same suppression behavior it gets
  for free from Pi/Claude Code's shared frontmatter field). Whether `$skill-name` explicit syntax
  is parsed inside a `codex exec` non-interactive prompt (as opposed to only the interactive TUI)
  was **not verified** — no doc or source excerpt confirmed or denied this for headless mode.

**Net for Codex**: skills are natively supported and on by default, but Fleet has no clean,
documented, session-scoped way to hand it an explicit external skill directory the way it can
with Pi's `--skill` or Claude Code's `--plugin-dir`; every path found either mutates
`$CODEX_HOME`/the global plugin store or relies on an apparently-internal, unexposed hook.
Restricting to *only* Fleet's chosen skills is correspondingly harder, and suppressing
auto-invocation requires an extra Codex-specific `agents/openai.yaml` file per skill (already
Matt Pocock's own pattern) rather than a shared frontmatter field.

---

## 3. Claude Code CLI (`claude -p`)

**Verified — native support, session-scoped explicit directory via `--plugin-dir`, restrictable
via `--setting-sources`, and `disable-model-invocation` explicitly documented to block headless
model-triggered use as of v2.1.196 (installed is 2.1.281).**

- **Discovery locations** (verified via WebFetch of `code.claude.com/docs/en/skills`, priority
  high→low): Enterprise (`managed-settings` dir, all users), Personal (`~/.claude/skills/`),
  Project (`.claude/skills/`, current repo, walked from start dir up through parent dirs to repo
  root), Nested (`<subdir>/.claude/skills/`, loads lazily once Claude reads a file under that
  subdir), Additional directory (`.claude/skills/` inside any path passed via `--add-dir`, session
  only), Plugin (`<plugin>/skills/<skill-name>/SKILL.md`, namespaced as
  `/plugin-name:skill-name`), Synced-from-claude.ai (`~/.claude/skills/synced/`).
- **Explicit, session-scoped Fleet-supplied directory, no global/repo writes** (verified,
  `claude --help`, installed 2.1.281): `--plugin-dir <path>` — "Load a plugin from a directory or
  `.zip` for this session only; a folder of plugins loads each child (repeatable)." This is the
  clean mechanism: Fleet packages the Matt Pocock `implement`/`tdd` skills as a minimal local
  plugin (a directory with `.claude-plugin/plugin.json` plus a `skills/` subdirectory containing
  each `SKILL.md`) and passes `--plugin-dir /fleet/skills-plugin` on the `claude -p` invocation.
  Nothing is written to `~/.claude` or the target repo, and the plugin does not persist past the
  session. (`--plugin-url` is the same idea for a remote `.zip`.) Skills loaded this way are
  namespaced `/fleet-skills:implement` etc., which also sidesteps name collisions with anything
  in the target repo.
- **Restriction to only Fleet's skills** (verified for the source-exclusion mechanism,
  `claude --help`, cross-checked against the WebFetch summary of the docs page — the WebFetch
  page's own example commands used a `project,enterprise` value that is **not** among the values
  the installed CLI's own `--help` lists, so that specific example is flagged as unverified/likely
  imprecise): `--setting-sources <sources>` — "Comma-separated list of setting sources to load
  (user, project, local)" is the value set actually accepted per the installed binary. Passing
  `--setting-sources local` (i.e., omitting both `user` and `project`) excludes both the Personal
  (`~/.claude/skills`) and Project (`.claude/skills` in the target repo) discovery locations,
  leaving only: always-on Enterprise/managed skills (org policy, outside Fleet's or the user's
  control either way) and whatever Fleet explicitly supplies via `--plugin-dir`/`--add-dir`. That
  combination — `--setting-sources local --plugin-dir /fleet/skills-plugin` — is the closest
  built-in equivalent to Pi's `--no-skills --skill <path>`, and is a materially different (and
  weaker "opt everything off" tool) than the two blunt instruments below.
  - `--disable-slash-commands` (verified, `claude --help`): "Disable all skills" — this is
    all-or-nothing; since Fleet's own explicit `--plugin-dir` skills are *also* invoked as
    `/plugin-name:skill-name` slash commands, this flag would disable Fleet's own skill too. Not
    usable for "only Fleet's skills."
  - `--safe-mode` (verified, `claude --help`): disables *all* customizations including skills,
    "useful for troubleshooting a broken configuration" — same all-or-nothing problem.
  - `--bare` (verified, `claude --help`): notably **does not** blanket-disable skills — the
    help text explicitly carves it out: "Skills still resolve via `/skill-name`" while `--bare`
    strips hooks, plugin sync, attribution, auto-memory, background prefetches, keychain reads,
    and CLAUDE.md auto-discovery. The same help text explicitly names `--plugin-dir` as one of the
    ways to "explicitly provide context" under `--bare`. This makes `--bare` (with the CLAUDE.md
    auto-discovery already stripped) combined with `--plugin-dir` and `--setting-sources local`
    look like the best-fit "safe headless mode with exactly Fleet's skills" combination the CLI
    exposes, matching the ticket's stated intent of a safe-mode headless run with explicit
    control. This composite recommendation is **inferred** (not a single documented recipe) from
    combining three independently-verified flag behaviors.
- **Automatic vs. explicit invocation, and `disable-model-invocation` in headless mode**
  (verified via WebFetch of `code.claude.com/docs/en/skills`): default is automatic
  description-matching by the model; `disable-model-invocation: true` in frontmatter blocks that
  path. The docs are explicit that, as of v2.1.196 (installed 2.1.281 postdates this), the block
  also applies to **non-interactive `-p` runs and scheduled-task prompts** specifically — i.e. a
  model cannot trigger a `disable-model-invocation: true` skill in headless mode either; only
  literal `/skill-name` in the prompt/session still works. This is the one point among all three
  harnesses with an explicit, versioned doc statement about headless-mode model-invocation
  suppression.
- **`--strict-mcp-config`** (verified, `claude --help`): scoped to MCP servers only ("Only use MCP
  servers from `--mcp-config`, ignoring all other MCP configurations") — no stated interaction
  with skills; treated as irrelevant to this design question.

**Net for Claude Code**: `--plugin-dir` is a clean, session-scoped, no-global/no-repo-write
mechanism for handing the harness a Fleet-chosen skill set (mirroring Pi's `--skill`); combined
with `--setting-sources local` it can be made to exclude both personal and project skill
discovery, though the "user/project/local" value set is materially different from — and less
granular than — what one WebFetch summary implied (no `enterprise` value on the actual CLI;
enterprise/managed skills are apparently always-on regardless of `--setting-sources`, consistent
with `--safe-mode`'s "Admin-managed (policy) settings still apply" language elsewhere in the same
`--help` output). `disable-model-invocation` is the one harness where the doc explicitly confirms
headless-mode suppression by version number.

---

## Cross-harness summary

| Question | Pi | Codex | Claude Code |
|---|---|---|---|
| Native Agent Skills (SKILL.md) support | Verified, yes | Verified, yes (on by default in 0.156.1) | Verified, yes |
| Session-scoped explicit external directory, no global/repo write | Verified: `--skill <path>` (+`--no-skills`) | Not found / inferred absent — only `CODEX_HOME` redirect (partial, has auth caveat) or persistent plugin install | Verified: `--plugin-dir <path>` / `--plugin-url` |
| Restrict to *only* Fleet's chosen skills | Verified: `--no-skills` + `--skill` | Not cleanly achievable; `skills.config`/`bundled.enabled=false` only prune already-discovered skills | Verified (with caveats): `--setting-sources local` + `--plugin-dir`; enterprise skills stay on regardless |
| Automatic vs. explicit invocation; `disable-model-invocation` in headless | Verified: default automatic; flag hides from system prompt, `/skill:name` still works, and `docs/rpc.md` confirms `/skill:name` expansion works over the RPC `prompt`/`steer`/`follow_up` commands | Verified (via OpenAI's skills doc + mattpocock/skills issue #516): default automatic; Codex ignores Claude's `disable-model-invocation` frontmatter — needs its own `agents/openai.yaml` `policy.allow_implicit_invocation: false`; headless (`codex exec`) behavior of explicit `$skill-name` syntax not verified | Verified: default automatic; `disable-model-invocation: true` explicitly documented (v2.1.196+) to also block non-interactive `-p` and scheduled-task model-triggered invocation |

**Bottom line for the design decision**: Pi and Claude Code both give Fleet a real, documented,
session-scoped hook to hand each headless run an explicit, Fleet-chosen skill set without
touching the user's global config or the target repo (`--skill`/`--no-skills` for Pi,
`--plugin-dir`/`--setting-sources` for Claude Code), and both let Fleet control automatic vs.
explicit invocation via the shared `disable-model-invocation` frontmatter field (Claude Code
explicitly documents this working in headless mode; Pi's RPC docs confirm `/skill:name` expansion
works over the same JSON protocol Fleet already drives). Codex is the outlier: skills are
supported and on by default, but no session-scoped external-directory mechanism was found from
either the CLI surface or the underlying source, cross-harness `disable-model-invocation`
frontmatter isn't honored (Codex needs its own `agents/openai.yaml` sidecar, which
`mattpocock/skills` already ships), and genuinely restricting Codex to *only* Fleet's chosen
skills looks materially harder than for the other two harnesses. If Fleet wants symmetric
behavior across all three harnesses, Codex is the one where "paste the method into the prompt"
(the fallback the question poses) is the most defensible near-term answer, pending confirmation
directly from OpenAI or a deeper read of the `codex-rs` app-server protocol that this research did
not have budget to complete.
