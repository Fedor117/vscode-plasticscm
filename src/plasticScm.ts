
import * as fs from "fs";
import * as os from "os";
import * as pathModule from "path";
import { AddCommand, CheckinCommand, UndoCheckoutAllCommand, UndoCheckoutCommand } from "./commands";
import { CmShell, ICmShell } from "./cm/shell";
import {
  commands,
  Disposable,
  OutputChannel,
  Uri,
  window as VsCodeWindow,
  workspace as VsCodeWorkspace,
  WorkspaceFolder,
} from "vscode";
import { historyViewId, HistoryViewProvider } from "./history/historyViewProvider";
import { GetWorkspaceFromPath } from "./cm/commands";
import { HistoryCommands } from "./commands/history";
import { IConfig } from "./config";
import { IWorkspaceInfo } from "./models";
import { OpenFileCommand } from "./commands/openFile";
import { PlasticScmDecorations } from "./decorations";
import { RefreshCommand } from "./commands/refresh";
import { RevisionContentProvider } from "./revisionContentProvider";
import { ShowOutputCommand } from "./commands/showOutput";
import { Workspace } from "./workspace";
import { WorkspaceOperations } from "./workspaceOperations";

export class PlasticScm implements Disposable {
  public get workspaces(): Map<string, Workspace> {
    return this.mWorkspaces;
  }

  public get channel(): OutputChannel {
    return this.mChannel;
  }

  private readonly mWorkspaces: Map<string, Workspace> = new Map<string, Workspace>();
  private readonly mChannel: OutputChannel;
  private readonly mDisposables: Disposable[] = [];
  private readonly mExtensionUri: Uri;
  private mConfig?: IConfig;

  public constructor(channel: OutputChannel, extensionUri: Uri) {
    this.mChannel = channel;
    this.mExtensionUri = extensionUri;
  }

  public async initialize(configuration: IConfig): Promise<void> {
    if (!VsCodeWorkspace.workspaceFolders) {
      return;
    }

    this.mConfig = configuration;

    // The Source Control container builds its sections from the views it knows
    // about when it opens, and one added later, while it is already open, is not
    // shown until the user goes looking for it. `cm status` on a large workspace
    // takes seconds, so the graph view is gated on a cheap marker probe here and
    // the answer is corrected once the workspaces are actually known.
    setGraphViewGate(await hasPlasticWorkspaceMarker(VsCodeWorkspace.workspaceFolders));

    try {
      await this.buildWorkspaces(configuration, VsCodeWorkspace.workspaceFolders);
    } finally {
      // Without a workspace there is nothing to draw, and a permanently empty
      // section in the Source Control pane reads as a broken one, so the gate is
      // settled even when a step above threw.
      setGraphViewGate(this.mWorkspaces.size > 0);
    }
  }

  public updateConfig(newConfig: IConfig): void {
    this.mConfig = newConfig;
    for (const workspace of this.mWorkspaces.values()) {
      workspace.updateConfig(newConfig);
    }
  }

  public stop(): Promise<void[]> {
    return Promise.all(
      Array.from(this.mWorkspaces.values()).map(wk => wk.shell.stop()));
  }

  public dispose(): void {
    void commands.executeCommand("setContext", "plastic-scm.active", false);
    this.mDisposables.forEach(disposable => {
      disposable.dispose();
    });
  }

  public async promptUserToPickWorkspace(): Promise<Workspace | undefined> {
    if (this.workspaces.size === 1) {
      return Array.from(this.workspaces.values())[0];
    }

    const choice = await VsCodeWindow.showQuickPick(
      Array.from(this.workspaces.values()).map(wk => ({
        description: wk.info.path,
        label: wk.info.name,
        workspace: wk,
      })),
      {
        canPickMany: false,
        ignoreFocusOut: true,
        placeHolder: "Which workspace would you like to refresh?",
      });

    return choice?.workspace;
  }

  private async buildWorkspaces(configuration: IConfig, folders: readonly WorkspaceFolder[]): Promise<void> {
    const globalShell: ICmShell = new CmShell(
      os.tmpdir(), this.mChannel, configuration.cmConfiguration);
    if (!await globalShell.start()) {
      const errorMessage =
        `Plastic SCM extension can\'t start: unable to start "${configuration.cmConfiguration.cmPath} shell"`;
      this.mChannel.appendLine(errorMessage);
      // A shell that timed out during start still has a spawned cm process.
      globalShell.dispose();
      await VsCodeWindow.showErrorMessage(errorMessage);
      return;
    }

    for (const folder of folders) {
      const workingDir: string = folder.uri.fsPath;

      try {
        const wkInfo: IWorkspaceInfo | undefined =
          await GetWorkspaceFromPath.run(workingDir, globalShell);

        if (!wkInfo || this.mWorkspaces.has(wkInfo.id)) {
          this.mChannel.appendLine(`No workspace found at '${workingDir}'`);
          continue;
        }

        const wkShell: ICmShell = new CmShell(
          wkInfo.path, this.mChannel, configuration.cmConfiguration);
        if (!await wkShell.start()) {
          this.mChannel.appendLine(`Unable to start shell for workspace "${wkInfo.path}"`);
          wkShell.dispose();
          continue;
        }

        const workspace: Workspace = await Workspace.build(
          wkInfo, wkShell, this.mChannel, new WorkspaceOperations(), configuration);

        this.mDisposables.push(wkShell, workspace);
        this.mWorkspaces.set(wkInfo.id, workspace);
      } catch (e) {
        const error = e as Error;
        this.mChannel.appendLine(
          `Unable to find workspace in ${workingDir}: ${error?.message}`);
        await VsCodeWindow.showErrorMessage(error?.message);
      }
    }

    await globalShell.stop();
    globalShell.dispose();

    if (this.mWorkspaces.size) {
      this.mDisposables.push(new CheckinCommand(this));
      this.mDisposables.push(new RefreshCommand(this));
      this.mDisposables.push(new OpenFileCommand(this));
      this.mDisposables.push(new AddCommand(this));
      this.mDisposables.push(new UndoCheckoutCommand(this));
      this.mDisposables.push(new UndoCheckoutAllCommand(this));
      this.mDisposables.push(new ShowOutputCommand(this));
      this.mDisposables.push(new PlasticScmDecorations(this));
      this.mDisposables.push(new RevisionContentProvider(this));

      // Registered before it is pushed: disposal runs in insertion order, and the
      // registration must go first so no late resolve reaches a torn-down provider.
      const historyProvider = new HistoryViewProvider(
        this, this.mExtensionUri, () => this.mConfig ?? configuration);
      this.mDisposables.push(VsCodeWindow.registerWebviewViewProvider(
        historyViewId, historyProvider, { webviewOptions: { retainContextWhenHidden: true }}));
      this.mDisposables.push(historyProvider);
      this.mDisposables.push(new HistoryCommands(this, historyProvider));
    }
  }
}

/** Marker cm writes at the root of every workspace. */
const PLASTIC_WORKSPACE_MARKER = pathModule.join(".plastic", "plastic.workspace");

/** How far above an opened folder to look for that marker. */
const MAX_MARKER_WALK_DEPTH = 16;

function setGraphViewGate(active: boolean): void {
  void commands.executeCommand("setContext", "plastic-scm.active", active);
}

/**
 * True when a workspace folder, or any directory above it, holds the marker.
 * Deliberately cheap and approximate: it only decides whether to register the
 * graph view early, and `initialize` settles the question afterwards.
 */
async function hasPlasticWorkspaceMarker(folders: readonly WorkspaceFolder[] | undefined): Promise<boolean> {
  const answers = await Promise.all((folders ?? []).map(folder => folderIsInWorkspace(folder.uri.fsPath)));
  return answers.some(Boolean);
}

async function folderIsInWorkspace(folderPath: string): Promise<boolean> {
  let dir = folderPath;
  // Bounded: every stat can be a round trip on a network path, and this runs
  // before anything else in activation. A workspace root further up than this
  // only means the graph view is registered a few seconds later, as it was
  // before this probe existed.
  for (let depth = 0; depth < MAX_MARKER_WALK_DEPTH; depth++) {
    if (await pathExists(pathModule.join(dir, PLASTIC_WORKSPACE_MARKER))) {
      return true;
    }

    const parent = pathModule.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return false;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.promises.access(target);
    return true;
  } catch {
    return false;
  }
}
