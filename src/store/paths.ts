import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Composition seams the store talks through. Tests inject a fake `homedir`;
 * production calls `resolveStoreRoot()` with no argument and gets
 * `process.env.PI_FLEET_HOME ?? ~/.pi/fleet`.
 */
export interface PathEnvironment {
  home: () => string;
}

/** Default composition — reads `PI_FLEET_HOME` and `os.homedir()`. */
const DEFAULT_ENV: PathEnvironment = { home: () => homedir() };

/**
 * The store root that the binary uses when no env var is set. The result is
 * the conventional `~/.pi/fleet`; tests assert the trailing path so we notice
 * if it ever drifts.
 */
export function defaultStoreRoot(env: PathEnvironment = DEFAULT_ENV): string {
  return join(env.home(), ".pi", "fleet");
}

/**
 * Resolve the store root for the current invocation. `PI_FLEET_HOME` wins;
 * otherwise we fall back to the conventional location.
 *
 * The brief says the store self-initialises; we do not require the directory
 * to exist here. `JobStore.open` is responsible for that.
 */
export function resolveStoreRoot(env: PathEnvironment = DEFAULT_ENV): string {
  const fromEnv = process.env.PI_FLEET_HOME;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return defaultStoreRoot(env);
}

/**
 * Join the store root and a sequence of relative path parts. Returns a path
 * without resolving symlinks. Use `ensureWithinRoot` to confirm the result is
 * safely inside the root before any I/O.
 */
export function storePath(root: string, ...parts: readonly string[]): string {
  return join(root, ...parts);
}

/**
 * Confirm a path lives under `root` after symlink resolution.
 *
 * Strategy: walk up from the candidate until we find the deepest existing
 * ancestor, realpath it, and check that the result is the resolved root or
 * starts with `resolvedRoot + sep`. Non-existing leaf segments above that
 * ancestor are presumed to be created by us from validated parts; we never
 * accept a candidate whose deepest real ancestor escapes the root.
 *
 * This is the safety primitive behind every store read and write. Callers
 * that build paths from caller input must run the result through this before
 * touching the filesystem.
 */
export function ensureWithinRoot(root: string, candidate: string): boolean {
  const resolvedRoot = safeRealpath(root);
  if (resolvedRoot === null) return false;

  const absoluteCandidate = resolve(candidate);
  let cursor = absoluteCandidate;
  while (true) {
    const real = safeRealpath(cursor);
    if (real !== null) {
      return real === resolvedRoot || real.startsWith(resolvedRoot + sep);
    }
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

/**
 * Resolve a path's realpath without throwing. Returns `null` on any failure
 * (ENOENT, permission, loop).
 */
function safeRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Validate `--repo` and return its realpath, or `null` if it is not an
 * existing git working tree.
 *
 * A directory qualifies as a git working tree if it has a `.git` entry —
 * either a directory (normal checkout) or a file (worktree, submodule). The
 * spec's invariant is "a `.git` entry is present"; we do not parse the
 * pointer file because ticket 23 does not need to.
 *
 * `root` is the store root, used as the realpath reference for relative
 * paths but not enforced as a containment boundary here — callers that pass
 * arbitrary paths from a hostile source should additionally run
 * `ensureWithinRoot` on the result.
 */
export function resolveRepoRealpath(_root: string, repo: string): string | null {
  let real: string;
  try {
    real = realpathSync(repo);
  } catch {
    return null;
  }
  const stat = statSync(real, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory()) return null;
  const gitEntry = join(real, ".git");
  if (!existsSync(gitEntry)) return null;
  return real;
}