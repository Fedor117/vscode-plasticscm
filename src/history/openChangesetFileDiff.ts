import { commands, TextDocumentShowOptions, Uri, window } from "vscode";
import { FileChangeStatus, IChangesetFileChange, IHistoryChangeset, RevisionType } from "../models";
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

/**
 * Pure: decides which two revisions to compare and how to title the editor.
 * Returns undefined when there is nothing to open (directories, binaries).
 */
export function describeChangesetFileDiff(
    workspaceId: string,
    changeset: IHistoryChangeset,
    change: IChangesetFileChange): IChangesetFileDiff | undefined {
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
      title: `${name} (added in cs:${changeset.id})`,
    };
  }

  // For a deleted item `revisionId` is the revision that was removed, so its
  // content is the left side; `parentRevisionId` may be set but is irrelevant.
  if (change.status & FileChangeStatus.Deleted) {
    return {
      left: revision,
      right: toEmptyRevisionUri(workspaceId, change.path),
      title: `${name} (deleted in cs:${changeset.id})`,
    };
  }

  // A pure move keeps the revision: same content under two names, like Git's
  // rename detection showing an identical pair.
  if ((change.status & FileChangeStatus.Moved) && !(change.status & FileChangeStatus.Changed)) {
    return {
      left: toRevisionIdUri(workspaceId, oldPath, change.revisionId, change.repository),
      right: revision,
      title: `${oldName} (cs:${changeset.parentId}) ↔ ${name} (cs:${changeset.id})`,
    };
  }

  const left = describeLeftSide(workspaceId, changeset, change, oldPath);
  return {
    left: left.uri,
    right: revision,
    title: `${oldName} ${left.label} ↔ ${name} (cs:${changeset.id})`,
  };
}

export async function openChangesetFileDiff(
    workspace: Workspace,
    changeset: IHistoryChangeset,
    change: IChangesetFileChange): Promise<void> {
  const diff = describeChangesetFileDiff(workspace.info.id, changeset, change);
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
    changeset: IHistoryChangeset,
    change: IChangesetFileChange,
    oldPath: string): ILeftSide {
  // The base revision is the one in the parent changeset's tree: exactly "what
  // did this changeset change".
  if (change.baseRevisionId > 0) {
    return {
      label: `(cs:${changeset.parentId})`,
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
