import { FileDecoration, ThemeColor } from "vscode";
import { ILockEntry } from "../models";

export const LOCK_BADGE_MINE = "L";
export const LOCK_BADGE_OTHERS = "L!";

export function describeLock(lock: ILockEntry): string {
  const state = lock.status === "Retained" ? "Retained lock" : "Locked";
  return lock.mine
    ? `${state} by you (workspace ${lock.workspace})`
    : `${state} by ${lock.owner} (workspace ${lock.workspace})`;
}

/**
 * The decoration of a file that has a lock, merged with its pending-change
 * decoration when it has one. A lock held by somebody else replaces the badge,
 * because it decides whether the file can be edited at all; a lock of your own
 * only adds to the tooltip of a file that already carries a change badge (an
 * exclusive checkout is checked out and locked at once).
 */
export function decorateLocked(lock: ILockEntry, status: FileDecoration | undefined): FileDecoration {
  const text = describeLock(lock);

  if (status && lock.mine) {
    const decoration = new FileDecoration(status.badge, `${status.tooltip ?? ""} · ${text}`, status.color);
    decoration.propagate = status.propagate;
    return decoration;
  }

  const tooltip = status?.tooltip ? `${status.tooltip} · ${text}` : text;
  const decoration = lock.mine
    ? new FileDecoration(LOCK_BADGE_MINE, tooltip, new ThemeColor("charts.blue"))
    : new FileDecoration(LOCK_BADGE_OTHERS, tooltip, new ThemeColor("list.warningForeground"));
  decoration.propagate = false;
  return decoration;
}
