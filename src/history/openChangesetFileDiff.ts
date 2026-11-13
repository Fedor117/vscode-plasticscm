import { commands, TextDocumentShowOptions, Uri, window } from "vscode";
import { FileChangeStatus, IChangesetFileChange, IHistoryChangeset, IShelveInfo, RevisionType } from "../models";
import { toEmptyRevisionUri, toRevisionIdUri } from "../revisionContentProvider";
import { posix } from "path";
import { Workspace } from "../workspace";

export interface IChangesetFileDiff {
  left: Uri;
  right: Uri;
  title: string;
}

interface ILeftSide {
  uri: Uri;
  /** Parenthesised, e.g. `(cs:42)`; it says which tree the left side comes from. */
  label: string;
}

/** How the two sides are named in editor titles; changesets default to `cs:<id>` and `cs:<parent>`. */
export interface IDiffLabels {
  /** The tree the right side comes from, e.g. `cs:42` or `sh:7`. */
  readonly current: string;
  /** The tree the left side comes from, e.g. `cs:41`. */
  readonly parent: string;
}

function changesetLabels(changeset: IHistoryChangeset): IDiffLabels {
  return { current: `cs:${changeset.id}`, parent: `cs:${changeset.parentId}` };
}

/**
 * Pure: decides which two revisions to compare and how to title the editor.
 * Returns undefined when there is nothing to open (directories, binaries).
 */
export function describeChangesetFileDiff(
    workspaceId: string,
    changeset: IHistoryChangeset,
    change: IChangesetFileChange,
    labels: IDiffLabels = changesetLabels(changeset)): IChangesetFileDiff | undefined {
  if (change.revisionType !== RevisionType.TextFile) {
    return undefined;
  }

  const name = posix.basename(change.path);
  const oldPath = change.oldPath ?? change.path;
  const oldName = posix.basename(oldPath);
  const revision = toRevisionIdUri(workspaceId, change.path, change.revisionId, change.repository);

  if (change.status & FileChangeStatus.Added) {
    return {
      left: toEmptyRevisionUri(workspaceId, change.path),
      right: revision,
      title: `${name} (added in ${labels.current})`,
    };
  }

  // For a deleted item `revisionId` is the revision that was removed, so its
  // content is the left side; `parentRevisionId` may be set but is irrelevant.
  if (change.status & FileChangeStatus.Deleted) {
    return {
      left: revision,
      right: toEmptyRevisionUri(workspaceId, change.path),
      title: `${name} (deleted in ${labels.current})`,
    };
  }

  // A pure move keeps the revision: same content under two names, like Git's
  // rename detection showing an identical pair.
  if ((change.status & FileChangeStatus.Moved) && !(change.status & FileChangeStatus.Changed)) {
    return {
      left: toRevisionIdUri(workspaceId, oldPath, change.revisionId, change.repository),
      right: revision,
      title: `${oldName} (${labels.parent}) ↔ ${name} (${labels.current})`,
    };
  }

  const left = describeLeftSide(workspaceId, labels, change, oldPath);
  return {
    left: left.uri,
    right: revision,
    title: `${oldName} ${left.label} ↔ ${name} (${labels.current})`,
  };
}

export async function openChangesetFileDiff(
    workspace: Workspace,
    changeset: IHistoryChangeset,
    change: IChangesetFileChange): Promise<void> {
  await openFileDiff(describeChangesetFileDiff(workspace.info.id, changeset, change), change);
}

/**
 * Opens the diff of one file of a shelve against the changeset the shelve was
 * made on. A shelve has no changeset of its own, so the labels name `sh:N`.
 */
export async function openShelveFileDiff(
    workspaceId: string,
    shelve: IShelveInfo,
    change: IChangesetFileChange): Promise<void> {
  await openFileDiff(describeShelveFileDiff(workspaceId, shelve, change), change);
}

export function describeShelveFileDiff(
    workspaceId: string,
    shelve: IShelveInfo,
    change: IChangesetFileChange): IChangesetFileDiff | undefined {
  // Only `id`/`parentId` are read, and only through the labels.
  const stand: IHistoryChangeset = {
    branch: "", comment: shelve.comment, date: shelve.date, guid: shelve.guid, id: -1,
    owner: shelve.owner, parentId: shelve.parentChangesetId, repository: shelve.repository, server: shelve.server,
  };
  return describeChangesetFileDiff(
    workspaceId, stand, change, { current: `sh:${shelve.shelveId}`, parent: `cs:${shelve.parentChangesetId}` });
}

/**
 * Opens the diff of one file of a comparison (two changesets, or a branch against
 * its parent), titled with the labels of the two sides.
 */
export async function openComparisonFileDiff(
    workspaceId: string,
    labels: IDiffLabels,
    change: IChangesetFileChange): Promise<void> {
  await openFileDiff(describeComparisonFileDiff(workspaceId, labels, change), change);
}

export function describeComparisonFileDiff(
    workspaceId: string,
    labels: IDiffLabels,
    change: IChangesetFileChange): IChangesetFileDiff | undefined {
  // Only the labels are read from the stand-in.
  const stand: IHistoryChangeset = {
    branch: "", comment: "", date: new Date(0), guid: "", id: -1, owner: "", parentId: -1, repository: "", server: "",
  };
  return describeChangesetFileDiff(workspaceId, stand, change, labels);
}

async function openFileDiff(
    diff: IChangesetFileDiff | undefined,
    change: IChangesetFileChange): Promise<void> {
  if (!diff) {
    const name = posix.basename(change.path);
    void window.showInformationMessage(change.revisionType === RevisionType.BinaryFile
      ? `${name} is a binary file. Plastic SCM has no text diff for it.`
      : `${name} is a directory or link; there is no diff to show.`);
    return;
  }

  const options: TextDocumentShowOptions = { preview: true };
  await commands.executeCommand("vscode.diff", diff.left, diff.right, diff.title, options);
}

function describeLeftSide(
    workspaceId: string,
    labels: IDiffLabels,
    change: IChangesetFileChange,
    oldPath: string): ILeftSide {
  // The base revision is the one in the parent changeset's tree: exactly "what
  // did this changeset change".
  if (change.baseRevisionId > 0) {
    return {
      label: `(${labels.parent})`,
      uri: toRevisionIdUri(workspaceId, oldPath, change.baseRevisionId, change.repository),
    };
  }

  // The previous revision in the item's own history. On a merge changeset it
  // comes from the source branch, not the parent tree, hence the vaguer label.
  if (change.parentRevisionId > 0) {
    return {
      label: "(previous revision)",
      uri: toRevisionIdUri(workspaceId, oldPath, change.parentRevisionId, change.repository),
    };
  }

  return {
    label: "(empty)",
    uri: toEmptyRevisionUri(workspaceId, oldPath),
  };
}
