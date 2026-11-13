import { branchesSection, labelsSection, locksSection, shelvesSection } from "../repository/repositorySections";
import { IBranchInfo, IChangesetFileChange, ILabelInfo, ILockEntry, IShelveInfo } from "../models";
import { IRepositoryItemNode } from "../repository/repositoryTreeProvider";
import { PlasticScm } from "../plasticScm";
import { showOperationError } from "./scmUtils";
import { SourceControl } from "vscode";
import { Workspace } from "../workspace";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The workspace a command was invoked for: a workspace itself (status bar), a
 * Repository view row (any node kind carries its workspace), the Source Control
 * view's title menu (it passes the `SourceControl`), or, when there is no
 * hint, the one the user picks.
 */
export async function resolveWorkspace(
    plasticScm: PlasticScm,
    args: unknown[],
    placeHolder: string): Promise<Workspace | undefined> {

  const first = args[0];
  if (first instanceof Workspace) {
    return first;
  }

  if (isObject(first)) {
    // A row of a webview (the Branch Explorer) names its workspace by id.
    if (typeof first.wkId === "string") {
      const workspace = plasticScm.workspaces.get(first.wkId);
      if (workspace) {
        return workspace;
      }
    }

    const nodeWorkspace = first.workspace;
    if (isObject(nodeWorkspace) && isObject(nodeWorkspace.info) && typeof nodeWorkspace.info.id === "string") {
      const workspace = plasticScm.workspaces.get(nodeWorkspace.info.id);
      if (workspace) {
        return workspace;
      }
    }

    for (const workspace of plasticScm.workspaces.values()) {
      if (workspace.sourceControl === (first as unknown as SourceControl)) {
        return workspace;
      }
    }
  }

  return plasticScm.promptUserToPickWorkspace(placeHolder);
}

/** A changeset row of the Branch Explorer, as its context menu hands it to a command. */
export interface IExplorerChangesetTarget {
  readonly wkId: string;
  readonly changesetId: number;
  /** Full name of the changeset's branch. */
  readonly branch: string;
  /** The row selected in the explorer when another row was right-clicked. */
  readonly compareWithId?: number;
}

/** The Branch Explorer row a command was run from; undefined for any other argument. */
export function explorerChangesetFromArg(arg: unknown): IExplorerChangesetTarget | undefined {
  if (!isObject(arg) || arg.webviewSection !== "explorerChangeset"
      || typeof arg.wkId !== "string" || typeof arg.branch !== "string"
      || typeof arg.changesetId !== "number" || !Number.isInteger(arg.changesetId)) {
    return undefined;
  }
  const compareWithId = typeof arg.compareWithId === "number" && Number.isInteger(arg.compareWithId)
    ? arg.compareWithId
    : undefined;
  return { branch: arg.branch, changesetId: arg.changesetId, compareWithId, wkId: arg.wkId };
}

function repositoryItem<T>(arg: unknown, sectionId: string): IRepositoryItemNode<T> | undefined {
  if (isObject(arg) && arg.kind === "item" && isObject(arg.parent)
      && isObject(arg.parent.section) && arg.parent.section.id === sectionId) {
    return arg as unknown as IRepositoryItemNode<T>;
  }
  return undefined;
}

/** The branch a Repository view row stands for, when the command was run from a branch row. */
export function branchFromNode(arg: unknown): IBranchInfo | undefined {
  return repositoryItem<IBranchInfo>(arg, branchesSection.id)?.item;
}

/** The label a Repository view row stands for, when the command was run from a label row. */
export function labelFromNode(arg: unknown): ILabelInfo | undefined {
  return repositoryItem<ILabelInfo>(arg, labelsSection.id)?.item;
}

/** The shelve a Repository view row stands for, when the command was run from a shelve row. */
export function shelveFromNode(arg: unknown): IShelveInfo | undefined {
  return repositoryItem<IShelveInfo>(arg, shelvesSection.id)?.item;
}

/** The shelve and the file of a row under a shelve, when the command was run from such a row. */
export function shelveFileFromNode(arg: unknown): { shelve: IShelveInfo; change: IChangesetFileChange } | undefined {
  if (isObject(arg) && arg.kind === "child" && isObject(arg.child)) {
    const shelve = shelveFromNode(arg.parent);
    if (shelve) {
      return { change: arg.child as unknown as IChangesetFileChange, shelve };
    }
  }
  return undefined;
}

/**
 * Runs the interactive part of a command (pickers, look-ups), which rejects when
 * cm fails, and shows that failure the way the operation runner shows its own.
 */
export async function guarded(plasticScm: PlasticScm, name: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (e) {
    await showOperationError(plasticScm, name, e);
  }
}

/** A lock row of the Locks section, and the id of the workspace it belongs to. */
export interface ILockNode {
  readonly lock: ILockEntry;
  readonly workspaceId: string;
}

function lockFromChildNode(arg: unknown): ILockNode | undefined {
  if (isObject(arg) && arg.kind === "child" && isObject(arg.child) && isObject(arg.parent)
      && isObject(arg.parent.parent) && isObject(arg.parent.parent.section)
      && arg.parent.parent.section.id === locksSection.id
      && isObject(arg.workspace) && isObject(arg.workspace.info) && typeof arg.workspace.info.id === "string") {
    return { lock: arg.child as unknown as ILockEntry, workspaceId: arg.workspace.info.id };
  }
  return undefined;
}

/**
 * The lock rows a command ran on. A tree command receives `(clicked, selected[])`;
 * the selection is used when there is one, so several locks can be released at once.
 */
export function lockNodesFromArgs(args: unknown[]): ILockNode[] {
  const [ clicked, selected ] = args;
  const candidates = Array.isArray(selected) && selected.length > 0 ? selected : [clicked];
  const nodes: ILockNode[] = [];
  for (const candidate of candidates) {
    const node = lockFromChildNode(candidate);
    if (node && !nodes.some(known => known.lock.guid === node.lock.guid && known.lock.status === node.lock.status)) {
      nodes.push(node);
    }
  }
  return nodes;
}
