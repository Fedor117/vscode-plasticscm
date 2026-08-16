import { FileSystemError, Uri, workspace as VsCodeWorkspace, window } from "vscode";
import { isPathInside } from "./scmUtils";

/**
 * Whether private files go to the OS trash rather than being erased. Mirrors
 * git.discardUntrackedChangesToTrash, including its default.
 */
export function discardPrivateToTrash(): boolean {
  return VsCodeWorkspace.getConfiguration("plastic-scm")
    .get<boolean>("discardPrivateChangesToTrash", true);
}

/**
 * Deletes private items from disk, which is the only way to discard them: they
 * are not under source control, so `cm undo` has nothing to roll back and leaves
 * them exactly where they are.
 *
 * Deleting is recursive, so a private directory takes its contents with it. That
 * is a deliberate difference from git, which leaves the now-empty directory
 * behind — git has no concept of a directory to discard, whereas cm reports a
 * private directory as a change in its own right and the user expects the row
 * they clicked to disappear.
 *
 * Returns the paths that could not be deleted.
 */
export async function deletePrivatePaths(uris: Uri[], useTrash: boolean): Promise<string[]> {
  const failed: string[] = [];

  for (const uri of pruneDescendants(uris)) {
    try {
      await VsCodeWorkspace.fs.delete(uri, { recursive: true, useTrash });
    } catch (e) {
      // Already gone is the outcome we wanted. cm can remove an item itself —
      // undoing an add of the only file in a directory, say — and the status
      // that produced this row is a moment older than the delete.
      if ((e as FileSystemError).code !== "FileNotFound") {
        failed.push(uri.fsPath);
      }
    }
  }

  return failed;
}

/**
 * Offers the permanent delete that git offers when the trash is unavailable —
 * network volumes and some Linux sandboxes have no trash to move anything into,
 * and silently reporting failure would leave the user stuck.
 */
export async function retryWithoutTrash(failedPaths: string[], uris: Uri[]): Promise<string[]> {
  const label = failedPaths.length === 1
    ? "Delete File"
    : `Delete All ${failedPaths.length} Files`;

  const answer = await window.showWarningMessage(
    "Failed to delete using the Trash. Do you want to permanently delete instead?",
    { modal: true },
    label);

  if (answer !== label) {
    return failedPaths;
  }

  const retryable = uris.filter(uri => failedPaths.includes(uri.fsPath));
  return deletePrivatePaths(retryable, false);
}

/**
 * cm lists a private directory *and* every private item beneath it, so a folder
 * selection arrives holding both. Deleting the parent already removes the
 * children, and the follow-up delete would then fail on a path that is gone.
 */
export function pruneDescendants(uris: Uri[]): Uri[] {
  const paths = uris.map(uri => uri.fsPath);

  return uris.filter(uri => !paths.some(
    other => other !== uri.fsPath && isPathInside(uri.fsPath, other)));
}
