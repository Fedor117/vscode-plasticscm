import { commands, Disposable, window } from "vscode";
import { fileTargetUris, groupUrisByWorkspace } from "./fileTargets";
import { isAbsolute, join, relative, resolve } from "path";
import { runWorkspaceOperation, WorkspaceOperation } from "../workspaceOperations";
import { ChangeType } from "../models";
import { isPathInside } from "./scmUtils";
import { MoveItem } from "../cm/commands/moveItem/moveItem";
import { PlasticScm } from "../plasticScm";
import { RemoveItems } from "../cm/commands/removeItems/removeItems";
import { Workspace } from "../workspace";

export const TRACKED_FILE_COMMANDS = {
  delete: "plastic-scm.delete",
  move: "plastic-scm.move",
};

/** Drops paths below another path of the list: removing a folder already removes what is in it. */
export function topmostPaths(paths: readonly string[]): string[] {
  return paths.filter(candidate => !paths.some(other => other !== candidate && isPathInside(candidate, other)));
}

/** The confirmation text of a delete; names the target, or counts the targets. */
export function describeDelete(
    workspaceName: string,
    paths: readonly string[],
    uncommitted: readonly string[] = []): { message: string; detail: string } {
  const what = paths.length === 1 ? `'${paths[0].split(/[\\/]/).pop()}'` : `${paths.length} items`;
  const base = "The items are removed from the workspace's disk and from version control (cm remove). " +
    "The deletion is a pending change until you check it in.";
  const who = uncommitted.length === 1
    ? `'${uncommitted[0].split(/[\\/]/).pop()}' has`
    : `${uncommitted.length} items have`;
  const detail = uncommitted.length === 0
    ? `${base} Undo restores the checked-in revision.`
    : `${base}\n\nWARNING: ${who} uncommitted changes. Undoing the deletion brings back only the ` +
      "checked-in revision, so those changes are lost for good.";
  return {
    detail,
    message: `Delete ${what} in '${workspaceName}' with Plastic SCM?`,
  };
}

/**
 * Where an entered destination points: a path relative to the workspace root
 * (or absolute). Undefined when it is empty, has a quote or line break (the cm
 * shell cannot take them) or leaves the workspace.
 */
export function resolveMoveDestination(workspacePath: string, input: string): string | undefined {
  const text = input.trim();
  if (text.length === 0 || /[\r\n\0"]/.test(text)) {
    return undefined;
  }
  const target = resolve(isAbsolute(text) ? text : join(workspacePath, text));
  return isPathInside(target, workspacePath) && target !== resolve(workspacePath) ? target : undefined;
}

/** The problem with a typed destination, for an input box's validateInput; undefined when it is fine. */
export function moveDestinationProblem(workspacePath: string, input: string): string | undefined {
  if (input.trim().length === 0) {
    return "Enter the new path, relative to the workspace root.";
  }
  if (/[\r\n\0"]/.test(input)) {
    return "The path cannot contain quotes or line breaks.";
  }
  return resolveMoveDestination(workspacePath, input) === undefined
    ? "The destination must be inside the workspace."
    : undefined;
}

/**
 * "Delete (Plastic SCM)" and "Rename/Move (Plastic SCM)…": explicit commands for
 * the Explorer and the Source Control rows. Nothing hooks the Explorer's own
 * rename and delete, which would make VS Code do the file operation a second
 * time; Plastic notices local moves and deletes by itself and lists them as
 * pending changes.
 */
export class TrackedFileCommands implements Disposable {
  private readonly mDisposables: Disposable[];

  public constructor(private readonly mPlasticScm: PlasticScm) {
    this.mDisposables = [
      commands.registerCommand(TRACKED_FILE_COMMANDS.delete, (...args: unknown[]) => this.delete(args)),
      commands.registerCommand(TRACKED_FILE_COMMANDS.move, (...args: unknown[]) => this.move(args)),
    ];
  }

  public dispose(): void {
    this.mDisposables.forEach(disposable => {
      disposable.dispose();
    });
  }

  private async delete(args: unknown[]): Promise<void> {
    const uris = fileTargetUris(args, window.activeTextEditor?.document.uri);
    for (const [ workspace, owned ] of groupUrisByWorkspace(this.mPlasticScm, uris)) {
      const privates = new Set(workspace.pendingChanges
        .filter(state => state.isPrivate || (state.type & ChangeType.Deleted) !== 0)
        .map(state => state.resourceUri.fsPath));
      const paths = topmostPaths(owned.map(uri => uri.fsPath).filter(fsPath => !privates.has(fsPath)));

      if (paths.length === 0) {
        void window.showInformationMessage(
          "Nothing to delete with Plastic SCM: private files are not under version control; delete them as usual.");
        continue;
      }

      const uncommitted = workspace.pendingChanges
        .filter(state => !state.isPrivate && (state.type & (ChangeType.Changed | ChangeType.Checkedout)) !== 0 &&
          (state.type & ChangeType.Deleted) === 0)
        .map(state => state.resourceUri.fsPath)
        .filter(fsPath => paths.some(target => fsPath === target || isPathInside(fsPath, target)));
      const description = describeDelete(workspace.info.name, paths, uncommitted);
      const label = paths.length === 1 ? "Delete" : `Delete ${paths.length} Items`;
      const answer = await window.showWarningMessage(
        description.message, { detail: description.detail, modal: true }, label);
      if (answer !== label) {
        continue;
      }

      await runWorkspaceOperation(
        this.mPlasticScm,
        workspace,
        {
          name: "Delete",
          operation: WorkspaceOperation.TrackedFileChange,
          title: paths.length === 1 ? "Deleting 1 item" : `Deleting ${paths.length} items`,
        },
        () => RemoveItems.run(workspace.shell, paths));
    }
  }

  private async move(args: unknown[]): Promise<void> {
    const uris = fileTargetUris(args, window.activeTextEditor?.document.uri);
    for (const [ workspace, owned ] of groupUrisByWorkspace(this.mPlasticScm, uris)) {
      const sources = topmostPaths(owned.map(uri => uri.fsPath));
      await this.moveInto(workspace, sources);
    }
  }

  private async moveInto(workspace: Workspace, sources: string[]): Promise<void> {
    const root = workspace.info.path;
    const single = sources.length === 1;
    const entered = await window.showInputBox({
      ignoreFocusOut: true,
      prompt: single
        ? "New path of the item, relative to the workspace root (rename it or move it to another folder)"
        : `Folder to move ${sources.length} items into, relative to the workspace root`,
      title: "Rename/Move (Plastic SCM)",
      validateInput: value => moveDestinationProblem(root, value),
      value: single ? relative(root, sources[0]).split("\\").join("/") : "",
    });
    if (entered === undefined) {
      return;
    }

    const destination = resolveMoveDestination(root, entered);
    if (!destination) {
      return;
    }

    await runWorkspaceOperation(
      this.mPlasticScm,
      workspace,
      {
        name: "Move",
        operation: WorkspaceOperation.TrackedFileChange,
        title: single ? "Moving 1 item" : `Moving ${sources.length} items`,
      },
      async () => {
        const lines: string[] = [];
        for (const source of sources) {
          // With several items the destination is a folder, which cm moves each of them into.
          lines.push(...await MoveItem.run(workspace.shell, source, destination));
        }
        return lines;
      });
  }
}
