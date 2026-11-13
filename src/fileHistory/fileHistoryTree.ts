import {
  Event,
  EventEmitter,
  ThemeIcon,
  TreeDataProvider,
  TreeItem,
  TreeItemCollapsibleState,
  Uri,
} from "vscode";
import { firstLine, formatDate } from "../repository/presentation";
import { toEmptyRevisionUri, toRevisionUri } from "../revisionContentProvider";
import { IFileRevision } from "../models";
import { posix } from "path";

export const fileHistoryViewId = "plastic-scm.fileHistory";

export const FILE_HISTORY_COMMANDS = {
  compareWithWorkspace: "plastic-scm.fileHistory.compareWithWorkspace",
  copyChangesetId: "plastic-scm.fileHistory.copyChangesetId",
  openAtRevision: "plastic-scm.fileHistory.openAtRevision",
  openChanges: "plastic-scm.fileHistory.openChanges",
  refresh: "plastic-scm.fileHistory.refresh",
  revert: "plastic-scm.fileHistory.revert",
  show: "plastic-scm.fileHistory.show",
};

/** The file the view lists, and the workspace that can read its revisions. */
export interface IFileHistoryTarget {
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly uri: Uri;
}

/** The `contextValue` of a revision row, for `view/item/context` menus. */
export const FILE_REVISION_CONTEXT = "fileRevision";

export interface IFileRevisionNode {
  readonly kind: "revision";
  readonly target: IFileHistoryTarget;
  readonly revision: IFileRevision;
  /** The next older revision in the list, when there is one. */
  readonly previous?: IFileRevision;
}

export interface IFileHistoryMessageNode {
  readonly kind: "message";
  readonly text: string;
}

export type FileHistoryNode = IFileRevisionNode | IFileHistoryMessageNode;

export function isRevisionNode(arg: unknown): arg is IFileRevisionNode {
  return typeof arg === "object" && arg !== null
    && (arg as { kind?: unknown }).kind === "revision"
    && typeof (arg as { revision?: unknown }).revision === "object";
}

/** The revision list as nodes; each row knows the revision before it, which "Open Changes" compares against. */
export function toRevisionNodes(target: IFileHistoryTarget, revisions: readonly IFileRevision[]): IFileRevisionNode[] {
  return revisions.map((revision, index) => ({
    kind: "revision",
    previous: revisions[index + 1],
    revision,
    target,
  }));
}

export interface IRevisionDiff {
  readonly left: Uri;
  readonly right: Uri;
  readonly title: string;
}

/** Revisions of a directory or an unrecognised type have no text to show. */
export function hasTextContent(revision: IFileRevision): boolean {
  return revision.type !== "dir" && revision.type !== "bin";
}

function name(target: IFileHistoryTarget): string {
  return posix.basename(target.uri.path);
}

/** One revision against the one before it; an item's first revision is compared with nothing. */
export function describeRevisionDiff(node: IFileRevisionNode): IRevisionDiff {
  const { previous, revision, target } = node;
  return {
    left: previous
      ? toRevisionUri(target.workspaceId, target.uri, previous.changesetId)
      : toEmptyRevisionUri(target.workspaceId, target.uri.path),
    right: toRevisionUri(target.workspaceId, target.uri, revision.changesetId),
    title: `${name(target)} (${previous ? `cs:${previous.changesetId}` : "empty"}) ↔ (cs:${revision.changesetId})`,
  };
}

/** One revision against the file in the workspace. */
export function describeWorkspaceDiff(node: IFileRevisionNode): IRevisionDiff {
  const { revision, target } = node;
  return {
    left: toRevisionUri(target.workspaceId, target.uri, revision.changesetId),
    right: target.uri,
    title: `${name(target)} (cs:${revision.changesetId}) ↔ (workspace)`,
  };
}

export function revisionTooltip(revision: IFileRevision): string {
  return [
    `cs:${revision.changesetId} on ${revision.branch}`,
    `${revision.owner}, ${formatDate(revision.date)}`,
    revision.comment.trim(),
  ].filter(line => line.length > 0).join("\n\n");
}

export function revisionItem(node: IFileRevisionNode): TreeItem {
  const { revision } = node;
  const item = new TreeItem(`cs:${revision.changesetId}`, TreeItemCollapsibleState.None);
  const comment = firstLine(revision.comment);
  item.description = [ comment, revision.owner, revision.branch, formatDate(revision.date) ]
    .filter(part => part.length > 0).join(" · ");
  item.tooltip = revisionTooltip(revision);
  item.iconPath = new ThemeIcon("git-commit");
  item.contextValue = FILE_REVISION_CONTEXT;
  item.command = { arguments: [node], command: FILE_HISTORY_COMMANDS.openChanges, title: "Open Changes" };
  return item;
}

/** The File History view: the revisions of the one file it was opened for. */
export class FileHistoryTreeProvider implements TreeDataProvider<FileHistoryNode> {
  private readonly mChanged = new EventEmitter<FileHistoryNode | undefined>();
  private mNodes: FileHistoryNode[] = [];

  public get onDidChangeTreeData(): Event<FileHistoryNode | undefined> {
    return this.mChanged.event;
  }

  public setRevisions(target: IFileHistoryTarget, revisions: readonly IFileRevision[]): void {
    this.mNodes = revisions.length > 0
      ? toRevisionNodes(target, revisions)
      : [{ kind: "message", text: "This file has no revisions." }];
    this.mChanged.fire(undefined);
  }

  public setMessage(text: string): void {
    this.mNodes = [{ kind: "message", text }];
    this.mChanged.fire(undefined);
  }

  public clear(): void {
    this.mNodes = [];
    this.mChanged.fire(undefined);
  }

  public dispose(): void {
    this.mChanged.dispose();
  }

  public getChildren(element?: FileHistoryNode): FileHistoryNode[] {
    return element ? [] : this.mNodes;
  }

  public getTreeItem(node: FileHistoryNode): TreeItem {
    if (node.kind === "message") {
      return new TreeItem(node.text, TreeItemCollapsibleState.None);
    }
    return revisionItem(node);
  }
}
