import {
  branchTooltip,
  firstLine,
  formatDate,
  isCurrentBranch,
  isCurrentLabel,
  isCurrentShelve,
  labelTooltip,
  ownerAndDate,
  shelveSpec,
  shelveTooltip,
} from "./presentation";
import { buildEntries, lockKey } from "../locks/lockSnapshot";
import { DiffChangeset, ListBranches, ListLabels, ListLocks, ListShelves } from "../cm/commands";
import {
  FileChangeStatus,
  IBranchInfo,
  IChangesetFileChange,
  ILabelInfo,
  ILockEntry,
  IShelveInfo,
} from "../models";
import { IRepositorySection, IRepositoryWorkspace, REPOSITORY_CONTEXT } from "./repositoryTreeProvider";
import { ThemeColor, ThemeIcon, TreeItem, TreeItemCollapsibleState } from "vscode";
import { posix } from "path";

/** Rows per page in every built-in section. */
export const REPOSITORY_PAGE_SIZE = 50;

const CURRENT_COLOR = new ThemeColor("charts.green");

function icon(id: string, current: boolean): ThemeIcon {
  return current ? new ThemeIcon(id, CURRENT_COLOR) : new ThemeIcon(id);
}

function describe(current: boolean, ...parts: string[]): string {
  return [ current ? "current" : "", ...parts ].filter(part => part.length > 0).join(" · ");
}

export const branchesSection: IRepositorySection<IBranchInfo> = {
  emptyMessage: "No branches",
  icon: "git-branch",
  id: "branches",
  key: branch => branch.name,
  label: "Branches",
  load: (workspace, query) => ListBranches.run(workspace.shell, query),
  pageSize: REPOSITORY_PAGE_SIZE,
  toTreeItem: (branch: IBranchInfo, workspace: IRepositoryWorkspace) => {
    const current = isCurrentBranch(branch, workspace.workspaceConfig);
    const item = new TreeItem(branch.name, TreeItemCollapsibleState.None);
    item.description = describe(current, ownerAndDate(branch.owner, branch.date));
    item.tooltip = branchTooltip(branch);
    item.iconPath = icon("git-branch", current);
    item.contextValue = current ? REPOSITORY_CONTEXT.currentBranch : REPOSITORY_CONTEXT.branch;
    return item;
  },
  tooltip: "Branches of this workspace's repository, newest first. Hidden branches are not listed.",
};

export const labelsSection: IRepositorySection<ILabelInfo> = {
  emptyMessage: "No labels",
  icon: "tag",
  id: "labels",
  key: label => label.name,
  label: "Labels",
  load: (workspace, query) => ListLabels.run(workspace.shell, query),
  pageSize: REPOSITORY_PAGE_SIZE,
  toTreeItem: (label: ILabelInfo, workspace: IRepositoryWorkspace) => {
    const current = isCurrentLabel(label, workspace.workspaceConfig);
    const item = new TreeItem(label.name, TreeItemCollapsibleState.None);
    item.description = describe(current, `cs:${label.changesetId}`, formatDate(label.date));
    item.tooltip = labelTooltip(label);
    item.iconPath = icon("tag", current);
    item.contextValue = current ? REPOSITORY_CONTEXT.currentLabel : REPOSITORY_CONTEXT.label;
    return item;
  },
  tooltip: "Labels of this workspace's repository, newest first.",
};

/** Command a click on a file under a shelve runs; receives the child node. */
export const SHELVE_OPEN_FILE_COMMAND = "plastic-scm.shelve.openFile";

function changeIcon(change: IChangesetFileChange): string {
  if (change.status & FileChangeStatus.Added) {
    return "diff-added";
  }
  if (change.status & FileChangeStatus.Deleted) {
    return "diff-removed";
  }
  if (change.status & FileChangeStatus.Moved && !(change.status & FileChangeStatus.Changed)) {
    return "diff-renamed";
  }
  return "diff-modified";
}

function changeLabel(change: IChangesetFileChange): string {
  const parts: string[] = [];
  if (change.status & FileChangeStatus.Added) {
    parts.push("added");
  }
  if (change.status & FileChangeStatus.Changed) {
    parts.push("changed");
  }
  if (change.status & FileChangeStatus.Moved) {
    parts.push("moved");
  }
  if (change.status & FileChangeStatus.Deleted) {
    parts.push("deleted");
  }
  return parts.join(", ");
}

/** The row of one file of a shelve. */
export function shelveFileItem(change: IChangesetFileChange): TreeItem {
  const item = new TreeItem(posix.basename(change.path), TreeItemCollapsibleState.None);
  const folder = posix.dirname(change.path);
  item.description = folder === "/" || folder === "." ? "" : folder;
  const moved = change.oldPath && change.oldPath !== change.path ? `\nMoved from ${change.oldPath}` : "";
  item.tooltip = `${change.path}\n${changeLabel(change)}${moved}`;
  item.iconPath = new ThemeIcon(changeIcon(change));
  item.contextValue = REPOSITORY_CONTEXT.shelveFile;
  item.command = { command: SHELVE_OPEN_FILE_COMMAND, title: "Open Changes" };
  return item;
}

export const shelvesSection: IRepositorySection<IShelveInfo> = {
  childKey: change => `${(change as IChangesetFileChange).path}#${(change as IChangesetFileChange).revisionId}`,
  childToTreeItem: change => shelveFileItem(change as IChangesetFileChange),
  emptyMessage: "No shelves",
  icon: "archive",
  id: "shelves",
  key: shelve => String(shelve.shelveId),
  label: "Shelves",
  load: (workspace, query) => ListShelves.run(workspace.shell, query),
  loadChildren: (shelve, workspace) => DiffChangeset.runShelve(workspace.shell, shelve.shelveId),
  pageSize: REPOSITORY_PAGE_SIZE,
  toTreeItem: (shelve: IShelveInfo, workspace: IRepositoryWorkspace) => {
    const current = isCurrentShelve(shelve, workspace.workspaceConfig);
    const item = new TreeItem(shelveSpec(shelve), TreeItemCollapsibleState.None);
    item.description = describe(current, firstLine(shelve.comment), ownerAndDate(shelve.owner, shelve.date));
    item.tooltip = shelveTooltip(shelve);
    item.iconPath = icon("archive", current);
    item.contextValue = current ? REPOSITORY_CONTEXT.currentShelve : REPOSITORY_CONTEXT.shelve;
    return item;
  },
  tooltip: "Shelves of this workspace's repository, newest first.",
};

/** "Mine" or "Others": the rows of the Locks section, each expanding to its locks. */
export interface ILockGroup {
  readonly id: "mine" | "others";
  readonly label: string;
  readonly locks: ILockEntry[];
}

/** Splits locks into the groups the Locks section shows; an empty group is left out. */
export function groupLocks(entries: readonly ILockEntry[]): ILockGroup[] {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const groups: ILockGroup[] = [
    { id: "mine", label: "Mine", locks: sorted.filter(lock => lock.mine) },
    { id: "others", label: "Others", locks: sorted.filter(lock => !lock.mine) },
  ];
  return groups.filter(group => group.locks.length > 0);
}

export function lockTooltip(lock: ILockEntry): string {
  return [
    lock.path,
    `${lock.status} by ${lock.mine ? "you" : lock.owner}`,
    `Owner: ${lock.owner}`,
    `Workspace: ${lock.workspace}`,
    `Branch: ${lock.holderBranch}${lock.destinationBranch !== lock.holderBranch
      ? ` (released on ${lock.destinationBranch})`
      : ""}`,
    `Since: ${lock.date}`,
  ].join("\n");
}

/** The row of one lock: path as the label; owner, branch and status beside it. */
export function lockItem(lock: ILockEntry): TreeItem {
  const item = new TreeItem(lock.path, TreeItemCollapsibleState.None);
  item.description = [ lock.mine ? "" : lock.owner, lock.holderBranch, lock.status ]
    .filter(part => part.length > 0)
    .join(" · ");
  item.tooltip = lockTooltip(lock);
  item.iconPath = new ThemeIcon("lock", new ThemeColor(lock.mine ? "charts.blue" : "list.warningForeground"));
  item.contextValue = lock.mine ? REPOSITORY_CONTEXT.lockMine : REPOSITORY_CONTEXT.lockOthers;
  return item;
}

async function loadLocks(workspace: IRepositoryWorkspace): Promise<ILockEntry[]> {
  if (workspace.locks) {
    return (await workspace.locks.refresh()).entries.slice();
  }
  const all = await ListLocks.run(workspace.shell);
  const mine = await ListLocks.run(workspace.shell, { onlyCurrentUser: true });
  return buildEntries(all, mine, workspace.workspaceConfig?.repSpec);
}

/**
 * Every lock of the workspace's repository, in "Mine" and "Others". Loading the
 * section runs `cm lock list` (so does the view's Refresh); the lock list has no
 * paging.
 */
export const locksSection: IRepositorySection<ILockGroup> = {
  childKey: lock => lockKey(lock as ILockEntry),
  childToTreeItem: lock => lockItem(lock as ILockEntry),
  emptyMessage: "No locks",
  icon: "lock",
  id: "locks",
  key: group => group.id,
  label: "Locks",
  load: async workspace => ({ hasMore: false, items: groupLocks(await loadLocks(workspace)) }),
  loadChildren: group => Promise.resolve(group.locks),
  pageSize: REPOSITORY_PAGE_SIZE,
  toTreeItem: group => {
    const item = new TreeItem(`${group.label} (${group.locks.length})`, TreeItemCollapsibleState.Collapsed);
    item.iconPath = new ThemeIcon(group.id === "mine" ? "account" : "organization");
    item.contextValue = REPOSITORY_CONTEXT.lockGroup;
    return item;
  },
  tooltip: "Files locked by exclusive checkout, in your name and in others'.",
};

/**
 * The sections the Repository view shows, in order. Add a section by
 * appending an {@link IRepositorySection} here.
 */
export const REPOSITORY_SECTIONS: ReadonlyArray<IRepositorySection<unknown>> = [
  branchesSection as IRepositorySection<unknown>,
  labelsSection as IRepositorySection<unknown>,
  shelvesSection as IRepositorySection<unknown>,
  locksSection as IRepositorySection<unknown>,
];
