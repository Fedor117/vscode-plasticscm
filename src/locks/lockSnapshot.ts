import { ILockEntry, ILockInfo } from "../models";
import { relative } from "path";

/** The workspace's own repository, as `cm status` reports it, is `org/repo@server`; locks print `org/repo`. */
export function repositoryMatches(lockRepository: string, workspaceRepSpec: string | undefined): boolean {
  if (!workspaceRepSpec || workspaceRepSpec === "unknown@unknown") {
    return true;
  }
  const name = workspaceRepSpec.split("@")[0];
  return name.toLowerCase() === lockRepository.toLowerCase();
}

/** Key for comparing a lock's server path with a workspace file: forward slashes, lower case. */
export function serverPathKey(serverPath: string): string {
  return serverPath.split("\\").join("/").toLowerCase();
}

/** The server path (`/Assets/a.txt`) of a workspace file, as a lookup key. */
export function fileServerPathKey(workspacePath: string, fsPath: string): string {
  return serverPathKey("/" + relative(workspacePath, fsPath));
}

/**
 * Identifies one lock record. The item GUID alone is not enough: smart locks can
 * hold the same item several times (other destination branch, Locked plus
 * Retained, other users).
 */
export function lockKey(lock: ILockInfo): string {
  return [
    lock.guid, lock.status, lock.owner, lock.workspace, lock.holderBranch, lock.destinationBranch,
  ].join("#");
}

/** Combines the two `lock list` answers: the locks of the workspace's repository, flagged when they are yours. */
export function buildEntries(
    all: readonly ILockInfo[],
    mine: readonly ILockInfo[],
    workspaceRepSpec: string | undefined): ILockEntry[] {
  const mineKeys = new Set(mine.map(lock => lockKey(lock)));
  return all
    .filter(lock => repositoryMatches(lock.repository, workspaceRepSpec))
    .map(lock => ({ ...lock, mine: mineKeys.has(lockKey(lock)) }));
}

/** An immutable view of the locks at one moment, indexed by path. */
export class LockSnapshot {
  public static readonly empty = new LockSnapshot([]);

  private readonly mByPath = new Map<string, ILockEntry>();

  public constructor(public readonly entries: readonly ILockEntry[]) {
    for (const entry of entries) {
      // A lock that is held outranks a retained one for the same path.
      const key = serverPathKey(entry.path);
      const existing = this.mByPath.get(key);
      if (!existing || (existing.status !== "Locked" && entry.status === "Locked")) {
        this.mByPath.set(key, entry);
      }
    }
  }

  public forServerPath(serverPath: string): ILockEntry | undefined {
    return this.mByPath.get(serverPathKey(serverPath));
  }

  public forFile(workspacePath: string, fsPath: string): ILockEntry | undefined {
    return this.mByPath.get(fileServerPathKey(workspacePath, fsPath));
  }

  /** Server paths of every locked item, for deciding which decorations changed. */
  public serverPaths(): string[] {
    return Array.from(this.mByPath.values()).map(entry => entry.path);
  }
}
