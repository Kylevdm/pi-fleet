import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * A boot-unique token identifying this process instance. Combined with the
 * pid, it distinguishes lock holders across process restarts on the same
 * machine.
 */
const BOOT_TOKEN = randomUUID();

/**
 * How many times `acquireLock` re-reads a lock that moved under it before it
 * gives up with `LockHeldError`.
 */
const LOCK_ACQUIRE_ATTEMPTS = 5;

/**
 * Identity of the current process, used to record the owner of a lock or an
 * idempotency claim. A pid alone is not enough across restarts; the
 * boot-unique token distinguishes a reused pid.
 */
export function ownerIdentity(): { pid: number; bootToken: string } {
  return { pid: process.pid, bootToken: BOOT_TOKEN };
}

/**
 * Options for atomic-write helpers. `pretty` lets tests keep the output
 * deterministic; `scratchDir` names where the scratch file lives. A caller
 * writing a job-level record passes the job's `tmp/` directory explicitly;
 * root-level records leave it unset and get a dot-prefixed scratch alongside
 * the target.
 */
interface WriteOptions {
  pretty?: boolean;
  scratchDir?: string;
}

/**
 * Atomically write a JSON document to `target`. The brief fixes the pattern:
 * `tmp/<name>.<suffix>` → `fsync(file)` → `rename` over the target →
 * `fsync(dir)`. The scratch lives in the same directory as the target (or in
 * the caller-supplied `scratchDir`, which stays on the same filesystem) so a
 * rename never crosses a filesystem, and any orphaned scratch is discardable.
 *
 * Returns the path of the scratch file so callers that want to record it in
 * an audit log can.
 */
export async function writeJsonFile(
  target: string,
  value: unknown,
  options: WriteOptions = {},
): Promise<string> {
  const payload = options.pretty === true
    ? `${JSON.stringify(value, null, 2)}\n`
    : `${JSON.stringify(value)}\n`;
  return writeStringFileAtomic(target, payload, options);
}

/**
 * Write an exact byte string via the rename-commit pattern. Unlike
 * `writeJsonFile`, the caller controls serialization, so a digest taken over
 * `content` is a digest of exactly the bytes that land on disk.
 */
export async function writeStringFileAtomic(
  target: string,
  content: string,
  options: WriteOptions = {},
): Promise<string> {
  const dir = dirname(target);
  const scratchDir = options.scratchDir ?? dir;
  await fs.mkdir(scratchDir, { recursive: true });
  // Scratch files need uniqueness, not ULID semantics — a random suffix
  // never touches the monotonic ULID generator that job ids rely on.
  const suffix = randomUUID();
  // Inside a caller-supplied scratch dir (a job tmp/ directory) the scratch
  // name can be plain. Alongside the target (root-level records) it is
  // dot-prefixed so it never shows up as a stray top-level entry.
  const scratchName = options.scratchDir !== undefined
    ? `${basenameOf(target)}.${suffix}`
    : `.${basenameOf(target)}.${suffix}.tmp`;
  const scratch = join(scratchDir, scratchName);

  const handle = await fs.open(scratch, "wx");
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(scratch, target);
  await syncDir(dir);
  return scratch;
}

/** Thrown by `writeFileExclusive` when the target already exists. */
export class FileExistsError extends Error {
  readonly target: string;
  constructor(target: string) {
    super(`file exists: ${target}`);
    this.name = "FileExistsError";
    this.target = target;
  }
}

/**
 * Write `content` to `target` only if `target` does not already exist. The
 * commit uses `fs.link` (O_EXCL semantics) rather than a TOCTOU existence
 * check, so two concurrent writers cannot both succeed.
 */
export async function writeFileExclusive(
  target: string,
  content: string,
  options: WriteOptions = {},
): Promise<void> {
  const dir = dirname(target);
  const scratchDir = options.scratchDir ?? dir;
  await fs.mkdir(scratchDir, { recursive: true });
  const scratch = join(scratchDir, `${basenameOf(target)}.${randomUUID()}`);
  const handle = await fs.open(scratch, "wx");
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.link(scratch, target);
  } catch (error) {
    await fs.unlink(scratch).catch(() => {});
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new FileExistsError(target);
    }
    throw error;
  }
  await fs.unlink(scratch);
  await syncDir(dir);
}

/**
 * Read a JSON document. Returns `null` if the file does not exist. Throws on
 * unreadable or non-JSON content — callers that must distinguish a corrupt
 * stored record from a missing one catch the parse failure themselves.
 */
export async function readJsonFile(target: string): Promise<unknown> {
  let text: string;
  try {
    text = await fs.readFile(target, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  return JSON.parse(text);
}

/**
 * Append a single JSON line to a log file using `O_APPEND`. POSIX guarantees
 * that `O_APPEND` writes are atomic at the byte level up to `PIPE_BUF`, so
 * concurrent appends from cooperating processes do not interleave within a
 * line. We follow the append with an `fsync` so the entry is durable when
 * the caller's `await` resolves.
 */
export async function appendJsonLine(target: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(target), { recursive: true });
  const handle = await fs.open(target, "a");
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Acquire a job lock with `O_CREAT | O_EXCL`. The lock is a sentinel file at
 * `target`; if it already exists, the lock is held by someone else.
 *
 * A lock whose mtime is older than `staleMs` is considered abandoned and may
 * be broken. Breaking is done atomically via `rename` — only one contender
 * can win the rename, so two processes that both see a stale lock cannot
 * both believe they hold it. The lock file records the holder's pid and a
 * boot-unique token so the audit trail can identify the dead holder.
 *
 * No raw errno escapes this function. Every non-fault outcome becomes
 * `LockHeldError`.
 */
export async function acquireLock(
  target: string,
  options: { staleMs: number; audit?: string },
): Promise<void> {
  const dir = dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const holder = ownerIdentity();

  // Bounded. Every "the lock moved under us" path costs one attempt, so a
  // contended — or malformed — lock ends in `LockHeldError` rather than
  // spinning. An unbounded retry here does not merely fail its own caller: it
  // keeps scheduling I/O, so the process never goes idle and never exits.
  for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      await writeHolder(target, holder);
      return;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }

    // The lock exists. `lstat`, not `stat`: a dangling symlink at the lock
    // path answers EEXIST to `open` but ENOENT to `stat`, and following it
    // would leave this loop unable to see the very entry it has to break.
    let ageMs: number;
    try {
      const stat = await fs.lstat(target);
      ageMs = Date.now() - stat.mtimeMs;
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      continue; // genuinely vanished between open and lstat
    }

    if (ageMs < options.staleMs) {
      throw new LockHeldError(target);
    }

    // Break the stale lock atomically: rename it aside. Only one process can
    // win that rename; the loser retries and re-evaluates whatever is there.
    const stale = `${target}.stale.${process.pid}.${Date.now()}`;
    try {
      await fs.rename(target, stale);
    } catch (error) {
      if (isErrno(error, "ENOENT")) continue; // another process broke it first
      throw new LockHeldError(target);
    }

    if (options.audit !== undefined) {
      await appendJsonLine(options.audit, {
        schema: "audit/1",
        timestamp: new Date().toISOString(),
        action: "lock-stolen",
        target,
        ageMs,
        holder,
      }).catch(() => {
        // Audit failure must not block lock acquisition.
      });
    }
    await fs.unlink(stale).catch(() => {});

    try {
      await writeHolder(target, holder);
      return;
    } catch (error) {
      if (isErrno(error, "EEXIST")) continue; // lost the re-acquire race
      throw error;
    }
  }

  throw new LockHeldError(target);
}

/** Write the holder identity into a lock file, created exclusively. */
async function writeHolder(
  target: string,
  holder: { pid: number; bootToken: string },
): Promise<void> {
  const handle = await fs.open(target, "wx");
  try {
    await handle.writeFile(JSON.stringify(holder));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** True when `error` is a Node errno error carrying exactly `code`. */
function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * Release a lock, but only if the lock belongs to this process. The holder
 * identity (pid + boot token) is written into the file precisely so release
 * can verify it: if another process broke and re-acquired a stale lock, the
 * stale holder's `finally` must not delete that new holder's lock. A refusal
 * is recorded in the audit log when one is provided.
 *
 * Idempotent: a missing lock is a no-op, not an error.
 */
/**
 * True when the lock file at `target` still records this process as its holder.
 *
 * The lock's mtime is set at acquisition and never refreshed, so a mutation
 * that outlives `staleMs` can have its lock broken and re-acquired underneath
 * it. Checking ownership immediately before the commit closes the window in
 * which both writers read revision N and both write N+1, losing one of them.
 * A renewal protocol belongs with the supervisor leases, not here.
 */
export async function holdsLock(target: string): Promise<boolean> {
  let content: string;
  try {
    content = await fs.readFile(target, "utf8");
  } catch {
    return false;
  }
  try {
    const holder = JSON.parse(content) as { pid?: unknown; bootToken?: unknown };
    return holder.pid === process.pid && holder.bootToken === BOOT_TOKEN;
  } catch {
    return false;
  }
}

export async function releaseLock(
  target: string,
  options: { audit?: string } = {},
): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(target, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  let holder: { pid?: unknown; bootToken?: unknown } = {};
  try {
    holder = JSON.parse(content) as { pid?: unknown; bootToken?: unknown };
  } catch {
    holder = {};
  }
  if (holder.pid !== process.pid || holder.bootToken !== BOOT_TOKEN) {
    if (options.audit !== undefined) {
      await appendJsonLine(options.audit, {
        schema: "audit/1",
        timestamp: new Date().toISOString(),
        action: "lock-release-refused",
        target,
        holder,
      }).catch(() => {
        // Audit failure must not turn a release into a throw.
      });
    }
    return;
  }
  try {
    await fs.unlink(target);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function basenameOf(p: string): string {
  const norm = p.endsWith("/") ? p.slice(0, -1) : p;
  const idx = norm.lastIndexOf("/");
  return idx === -1 ? norm : norm.slice(idx + 1);
}

/**
 * `fsync` the directory so the rename is durable. A directory's data is the
 * list of its children; without this `fsync`, a power loss between
 * `rename(file)` and the next directory metadata flush can lose the file.
 */
export async function syncDir(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  const handle = await fs.open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Distinguish "lock held" from "something else went wrong" so callers can
 * decide whether to retry / surface a different problem. The store's
 * `mutateJob` maps this to `conflict` because the lock usually signals a
 * concurrent writer rather than a logic error.
 */
export class LockHeldError extends Error {
  readonly target: string;
  constructor(target: string) {
    super(`lock held: ${target}`);
    this.name = "LockHeldError";
    this.target = target;
  }
}