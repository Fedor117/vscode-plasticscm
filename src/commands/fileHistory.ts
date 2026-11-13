import * as fs from "fs";
import * as path from "path";
import { ChangeType, IFileRevision } from "../models";
import { commands, Disposable, env, TreeView, Uri, workspace as vscodeWorkspace, window } from "vscode";
import {
  describeRevisionDiff,
  describeWorkspaceDiff,
  FILE_HISTORY_COMMANDS,
  FileHistoryNode,
  FileHistoryTreeProvider,
  fileHistoryViewId,
  hasTextContent,
  IFileHistoryTarget,
  IFileRevisionNode,
  isRevisionNode,
} from "../fileHistory/fileHistoryTree";
import { fileTargetUris, groupUrisByWorkspace } from "./fileTargets";
import { runWorkspaceOperation, WorkspaceOperation } from "../workspaceOperations";
import { describeError } from "./scmUtils";
import { FileHistory } from "../cm/commands/fileHistory/fileHistory";
import { PlasticScm } from "../plasticScm";
import { RevertItem } from "../cm/commands/revertItem/revertItem";
import { toRevisionUri } from "../revisionContentProvider";
import { Workspace } from "../workspace";

/** True when an open editor holds unsaved edits of the file. */
function workspaceHasUnsavedBuffer(fsPath: string): boolean {
  return vscodeWorkspace.textDocuments.some(document => document.isDirty && document.uri.fsPath === fsPath);
}

/** The `data-vscode-context` of a file row of the Graph: a server path and the workspace it belongs to. */
interface IGraphFileContext {
  readonly wkId: string;
  readonly path: string;
}

function isGraphFileContext(arg: unknown): arg is IGraphFileContext {
  if (typeof arg !== "object" || arg === null) {
    return false;
  }
  const candidate = arg as Record<string, unknown>;
  return typeof candidate.wkId === "string" && typeof candidate.path === "string"
    && typeof candidate.changesetId === "number";
}

/** What the confirmation of "Revert to This Revision" says; pure so the wording is tested. */
export function describeRevert(
    fileName: string, revision: IFileRevision, pendingChange: boolean): { message: string; detail: string } {
  const lines = [
    `The workspace copy of ${fileName} is replaced with its content in cs:${revision.changesetId}. ` +
    "The change then shows up as a pending change; nothing is checked in.",
  ];
  if (pendingChange) {
    lines.push(
      "WARNING: the file has pending changes in the workspace. Reverting overwrites them, and they cannot be " +
      "recovered afterwards.");
  }
  return { detail: lines.join("\n\n"), message: `Revert '${fileName}' to cs:${revision.changesetId}?` };
}

/**
 * The File History view and its commands: Show File History (Explorer, editor,
 * SCM rows, Graph file rows) and, per revision, the comparisons, the copy of
 * the revision's content and the revert.
 */
export class FileHistoryCommands implements Disposable {
  private readonly mProvider = new FileHistoryTreeProvider();
  private readonly mTreeView: TreeView<FileHistoryNode>;
  private readonly mDisposables: Disposable[];
  private mTarget: IFileHistoryTarget | undefined;
  /** Bumped per load, so a slow answer for a file the user has left never replaces the current one. */
  private mLoadId = 0;

  public constructor(private readonly mPlasticScm: PlasticScm) {
    this.mTreeView = window.createTreeView(fileHistoryViewId, { treeDataProvider: this.mProvider });
    this.mDisposables = [
      this.mTreeView,
      this.mProvider,
      commands.registerCommand(FILE_HISTORY_COMMANDS.show, (...args: unknown[]) => this.show(args)),
      commands.registerCommand(FILE_HISTORY_COMMANDS.refresh, () => this.refresh()),
      commands.registerCommand(FILE_HISTORY_COMMANDS.openChanges, (arg: unknown) => this.openChanges(arg)),
      commands.registerCommand(
        FILE_HISTORY_COMMANDS.compareWithWorkspace, (arg: unknown) => this.compareWithWorkspace(arg)),
      commands.registerCommand(FILE_HISTORY_COMMANDS.openAtRevision, (arg: unknown) => this.openAtRevision(arg)),
      commands.registerCommand(FILE_HISTORY_COMMANDS.copyChangesetId, (arg: unknown) => this.copyChangesetId(arg)),
      commands.registerCommand(FILE_HISTORY_COMMANDS.revert, (arg: unknown) => this.revert(arg)),
    ];
  }

  public dispose(): void {
    this.mDisposables.forEach(disposable => {
      disposable.dispose();
    });
  }

  private async show(args: unknown[]): Promise<void> {
    const resolved = this.resolveTarget(args);
    if (!resolved) {
      void window.showInformationMessage(
        "Select a file under Plastic SCM source control, then choose Show File History.");
      return;
    }

    let stat: fs.Stats | undefined;
    try {
      stat = await fs.promises.stat(resolved.uri.fsPath);
    } catch {
      stat = undefined;
    }
    if (stat?.isDirectory()) {
      void window.showInformationMessage("File History shows one file. Choose a file, not a folder.");
      return;
    }

    this.mTarget = resolved;
    await commands.executeCommand(`${fileHistoryViewId}.focus`);
    await this.load(resolved);
  }

  private resolveTarget(args: unknown[]): IFileHistoryTarget | undefined {
    const first = args[0];
    if (isGraphFileContext(first)) {
      const workspace = this.mPlasticScm.workspaces.get(first.wkId);
      if (!workspace) {
        return undefined;
      }
      return this.toTarget(workspace, Uri.file(path.join(workspace.info.path, first.path)));
    }

    const [uri] = fileTargetUris(args, window.activeTextEditor?.document.uri);
    if (!uri) {
      return undefined;
    }
    const [workspace] = groupUrisByWorkspace(this.mPlasticScm, [uri]).keys();
    return workspace ? this.toTarget(workspace, uri) : undefined;
  }

  private toTarget(workspace: Workspace, uri: Uri): IFileHistoryTarget {
    return { uri, workspaceId: workspace.info.id, workspacePath: workspace.info.path };
  }

  private async refresh(): Promise<void> {
    if (this.mTarget) {
      await this.load(this.mTarget);
    }
  }

  private async load(target: IFileHistoryTarget): Promise<void> {
    const workspace = this.mPlasticScm.workspaces.get(target.workspaceId);
    if (!workspace) {
      return;
    }

    const loadId = ++this.mLoadId;
    this.mTreeView.title = `File History: ${path.basename(target.uri.fsPath)}`;
    this.mTreeView.description = path.relative(target.workspacePath, path.dirname(target.uri.fsPath));
    this.mProvider.setMessage("Loading…");
    try {
      const revisions = await FileHistory.run(workspace.shell, target.uri.fsPath);
      if (loadId === this.mLoadId) {
        this.mProvider.setRevisions(target, revisions);
      }
    } catch (e) {
      if (loadId === this.mLoadId) {
        this.mProvider.setMessage(`Unable to load the history: ${describeError(e)}`);
        this.mPlasticScm.channel.appendLine(`File History failed: ${describeError(e)}`);
      }
    }
  }

  private node(arg: unknown): IFileRevisionNode | undefined {
    if (isRevisionNode(arg)) {
      return arg;
    }
    this.mPlasticScm.channel.appendLine(
      "File History command ignored: run it from a revision in the File History view.");
    return undefined;
  }

  private async openChanges(arg: unknown): Promise<void> {
    const node = this.node(arg);
    if (!node) {
      return;
    }
    if (!hasTextContent(node.revision)) {
      void window.showInformationMessage(
        `${path.basename(node.target.uri.fsPath)} at cs:${node.revision.changesetId} has no text to compare.`);
      return;
    }

    const diff = describeRevisionDiff(node);
    await commands.executeCommand("vscode.diff", diff.left, diff.right, diff.title, { preview: true });
  }

  private async compareWithWorkspace(arg: unknown): Promise<void> {
    const node = this.node(arg);
    if (!node) {
      return;
    }
    if (!hasTextContent(node.revision)) {
      void window.showInformationMessage(
        `${path.basename(node.target.uri.fsPath)} at cs:${node.revision.changesetId} has no text to compare.`);
      return;
    }

    const diff = describeWorkspaceDiff(node);
    await commands.executeCommand("vscode.diff", diff.left, diff.right, diff.title, { preview: true });
  }

  private async openAtRevision(arg: unknown): Promise<void> {
    const node = this.node(arg);
    if (!node) {
      return;
    }

    await commands.executeCommand(
      "vscode.open", toRevisionUri(node.target.workspaceId, node.target.uri, node.revision.changesetId));
  }

  private async copyChangesetId(arg: unknown): Promise<void> {
    const node = this.node(arg);
    if (!node) {
      return;
    }

    await env.clipboard.writeText(String(node.revision.changesetId));
    window.setStatusBarMessage("Copied changeset id", 2000);
  }

  private async revert(arg: unknown): Promise<void> {
    const node = this.node(arg);
    if (!node) {
      return;
    }

    const workspace = this.mPlasticScm.workspaces.get(node.target.workspaceId);
    if (!workspace) {
      return;
    }

    const fileName = path.basename(node.target.uri.fsPath);
    // The cached status can be up to a debounce behind, and unsaved editor buffers are not in it at all.
    try {
      await workspace.updateWorkspaceStatus();
    } catch (e) {
      this.mPlasticScm.channel.appendLine(`Unable to refresh the status before reverting: ${describeError(e)}`);
    }
    const unsaved = workspaceHasUnsavedBuffer(node.target.uri.fsPath);
    const pending = unsaved || workspace.pendingChanges.some(
      state => state.resourceUri.fsPath === node.target.uri.fsPath
        && (state.type & (ChangeType.Changed | ChangeType.Checkedout | ChangeType.Deleted | ChangeType.Moved)) !== 0);
    const description = describeRevert(fileName, node.revision, pending);
    const label = "Revert File";
    const answer = await window.showWarningMessage(
      description.message, { detail: description.detail, modal: true }, label);
    if (answer !== label) {
      return;
    }

    const outcome = await runWorkspaceOperation(
      this.mPlasticScm,
      workspace,
      {
        name: "Revert",
        operation: WorkspaceOperation.Revert,
        title: `Reverting ${fileName} to cs:${node.revision.changesetId}`,
      },
      () => RevertItem.run(workspace.shell, node.target.uri.fsPath, node.revision.changesetId));

    if (outcome.status === "succeeded") {
      window.setStatusBarMessage(`${fileName} reverted to cs:${node.revision.changesetId}`, 5000);
    }
  }
}
