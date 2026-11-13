import { ILockEntry } from "../models";
import { LockSnapshot } from "./lockSnapshot";
import { relative } from "path";

/** The locks held by somebody else on any of `fsPaths`, one per path. */
export function locksHeldByOthers(
    snapshot: LockSnapshot,
    workspacePath: string,
    fsPaths: readonly string[]): Array<{ fsPath: string; lock: ILockEntry }> {
  const found: Array<{ fsPath: string; lock: ILockEntry }> = [];
  for (const fsPath of fsPaths) {
    const lock = snapshot.forFile(workspacePath, fsPath);
    if (lock && !lock.mine) {
      found.push({ fsPath, lock });
    }
  }
  return found;
}

/**
 * The message for a failed checkout. When the lock list names who holds one of
 * the files, that goes first, in words; cm's own message always follows, since
 * nothing here depends on its wording.
 */
export function explainCheckoutFailure(
    cmMessage: string,
    held: ReadonlyArray<{ fsPath: string; lock: ILockEntry }>,
    workspacePath: string): string {
  if (held.length === 0) {
    return cmMessage;
  }

  const lines = held.slice(0, 5).map(({ fsPath, lock }) =>
    `${relative(workspacePath, fsPath).split("\\").join("/")} is locked by ${lock.owner} ` +
    `(workspace ${lock.workspace}, branch ${lock.holderBranch})`);
  if (held.length > lines.length) {
    lines.push(`and ${held.length - lines.length} more locked by others`);
  }
  return `${lines.join("; ")}. ${cmMessage}`;
}

/** The item spec `cm lock unlock` takes: by item id in the workspace's repository, else by path. */
export function lockItemSpec(lock: ILockEntry, repSpec: string | undefined, workspacePath: string): string {
  if (repSpec && repSpec !== "unknown@unknown") {
    return `itemid:${lock.itemId}@${repSpec}`;
  }
  return `item:${workspacePath.replace(/[\\/]+$/, "")}${lock.path}`;
}
