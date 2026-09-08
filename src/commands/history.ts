import * as fs from "fs";
import * as path from "path";
import { commands, Disposable, env, Uri, window } from "vscode";
import { findFileChange, HistoryViewProvider } from "../history/historyViewProvider";
import { IChangesetFileChange, IHistoryChangeset } from "../models";
import { openChangesetFileDiff } from "../history/openChangesetFileDiff";
import { PlasticScm } from "../plasticScm";
import { showOperationError } from "./scmUtils";
import { WorkspaceHistory } from "../history/workspaceHistory";

/**
 * The merged `data-vscode-context` object VS Code passes to `webview/context`
 * menu commands; `path` is only present on file rows.
 */
interface IHistoryContext {
  readonly wkId: string;
  readonly changesetId: number;
  readonly path?: string;
  /** Disambiguates two records for one path; absent on a pre-update webview. */
  readonly revisionId?: number;
  readonly webviewSection?: string;
}

interface IResolvedFile {
  readonly history: WorkspaceHistory;
  readonly changeset: IHistoryChangeset;
  readonly change: IChangesetFileChange;
}

/** Title-bar and context-menu commands of the Plastic SCM Graph view. */
export class HistoryCommands implements Disposable {
  private readonly mPlasticScm: PlasticScm;
  private readonly mProvider: HistoryViewProvider;
  private readonly mDisposables: Disposable[];

  public constructor(plasticScm: PlasticScm, provider: HistoryViewProvider) {
    this.mPlasticScm = plasticScm;
    this.mProvider = provider;
    this.mDisposables = [
      commands.registerCommand("plastic-scm.history.refresh", () => this.mProvider.refresh()),
      commands.registerCommand(
        "plastic-scm.history.copyChangesetId", (arg: unknown) => this.copyChangesetId(arg)),
      commands.registerCommand(
        "plastic-scm.history.copyComment", (arg: unknown) => this.copyComment(arg)),
      commands.registerCommand(
        "plastic-scm.history.openChanges", (arg: unknown) => this.openChanges(arg)),
      commands.registerCommand(
        "plastic-scm.history.openFile", (arg: unknown) => this.openFile(arg)),
    ];
  }

  public dispose(): void {
    Disposable.from(...this.mDisposables).dispose();
    this.mDisposables.length = 0;
  }

  private async copyChangesetId(arg: unknown): Promise<void> {
    const context = this.validate(arg);
    if (!context) {
      return;
    }

    await env.clipboard.writeText(String(context.changesetId));
    window.setStatusBarMessage("Copied changeset id", 2000);
  }

  private async copyComment(arg: unknown): Promise<void> {
    const context = this.validate(arg);
    if (!context) {
      return;
    }

    const history = this.getHistory(context);
    if (!history) {
      return;
    }

    try {
      const changeset = await history.getChangeset(context.changesetId);
      if (!changeset) {
        void window.showInformationMessage(`Changeset ${context.changesetId} is no longer loaded.`);
        return;
      }

      await env.clipboard.writeText(changeset.comment);
      window.setStatusBarMessage("Copied changeset comment", 2000);
    } catch (e) {
      await showOperationError(this.mPlasticScm, "Copy comment", e);
    }
  }

  private async openChanges(arg: unknown): Promise<void> {
    const context = this.validate(arg, true);
    if (!context) {
      return;
    }

    try {
      const resolved = await this.resolveFile(context);
      if (!resolved) {
        return;
      }
      await openChangesetFileDiff(resolved.history.workspace, resolved.changeset, resolved.change);
    } catch (e) {
      await showOperationError(this.mPlasticScm, "Open changes", e);
    }
  }

  private async openFile(arg: unknown): Promise<void> {
    const context = this.validate(arg, true);
    if (!context) {
      return;
    }

    try {
      const resolved = await this.resolveFile(context);
      if (!resolved) {
        return;
      }

      const { history, change } = resolved;
      const workspace = history.workspace;
      const name = path.posix.basename(change.path);

      // An xlinked repository's paths only exist inside that xlink's own
      // workspace; joining them onto this one would open the wrong file, or none.
      const repSpec = workspace.workspaceConfig?.repSpec;
      if (repSpec && !isSameRepository(change.repository, repSpec)) {
        void window.showInformationMessage(
          `${name} belongs to xlinked repository ${change.repository}; open it from that workspace.`);
        return;
      }

      const localPath = path.join(workspace.info.path, change.path);
      if (!await exists(localPath)) {
        void window.showInformationMessage(`${name} is not in the workspace at this location.`);
        return;
      }

      await commands.executeCommand("vscode.open", Uri.file(localPath));
    } catch (e) {
      await showOperationError(this.mPlasticScm, "Open file", e);
    }
  }

  private async resolveFile(context: IHistoryContext): Promise<IResolvedFile | undefined> {
    const history = this.getHistory(context);
    if (!history || context.path === undefined) {
      return undefined;
    }

    const files = await history.getFiles(context.changesetId);
    const change = findFileChange(files, context.path, context.revisionId);
    const changeset = await history.getChangeset(context.changesetId);
    if (!change || !changeset) {
      void window.showInformationMessage(`Changeset ${context.changesetId} is no longer loaded.`);
      return undefined;
    }

    return { change, changeset, history };
  }

  private getHistory(context: IHistoryContext): WorkspaceHistory | undefined {
    const history = this.mProvider.getHistory(context.wkId);
    if (!history) {
      this.mPlasticScm.channel.appendLine(`Graph command ignored: unknown workspace '${context.wkId}'`);
    }
    return history;
  }

  /**
   * The commands are hidden from the palette, but a keybinding can still invoke
   * them with no arguments, and a stale webview could send anything.
   */
  private validate(arg: unknown, requirePath = false): IHistoryContext | undefined {
    if (isHistoryContext(arg) && (!requirePath || typeof arg.path === "string")) {
      return arg;
    }

    this.mPlasticScm.channel.appendLine(
      `Graph command ignored: unexpected argument ${JSON.stringify(arg) ?? String(arg)}`);
    return undefined;
  }
}

function isHistoryContext(arg: unknown): arg is IHistoryContext {
  if (typeof arg !== "object" || arg === null) {
    return false;
  }

  const candidate = arg as Record<string, unknown>;
  return typeof candidate.wkId === "string"
    && typeof candidate.changesetId === "number"
    && (candidate.path === undefined || typeof candidate.path === "string")
    && (candidate.revisionId === undefined || typeof candidate.revisionId === "number");
}

/**
 * `cm status --xml` and `cm diff` print the same repository under different
 * server aliases (`Nimbus/Nimbus@1234567890123@cloud` against
 * `Nimbus/Nimbus@acme-studio@unity`), so only the name before the
 * first `@` is comparable. Names are what an xlink actually differs in.
 */
export function isSameRepository(left: string, right: string): boolean {
  return repositoryName(left) === repositoryName(right);
}

function repositoryName(spec: string): string {
  const at = spec.indexOf("@");
  return at < 0 ? spec.trim() : spec.substring(0, at).trim();
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}
