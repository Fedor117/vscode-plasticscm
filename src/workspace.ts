import * as constants from "./constants";
import * as events from "./events";
import * as path from "path";
import {
  ChangeType,
  IChangeInfo,
  IPendingChanges,
  IWorkspaceConfig,
  IWorkspaceInfo,
  WkConfigType,
} from "./models";
import { GetFile as CmGetFileCommand, Status as CmStatusCommand } from "./cm/commands";
import {
  Command,
  Disposable,
  Event,
  EventEmitter,
  OutputChannel,
  QuickDiffProvider,
  RelativePattern,
  scm,
  SourceControl,
  SourceControlResourceGroup,
  SourceControlResourceState,
  Uri,
  workspace as VsCodeWorkspace,
} from "vscode";
import { hasIncomingChanges, IKnownBranchHead } from "./incomingChanges";
import { IWorkspaceOperations, WorkspaceOperation } from "./workspaceOperations";
import { debounce } from "./decorators";
import { ICmShell } from "./cm/shell";
import { IConfig } from "./config";
import { LockStore } from "./locks/lockStore";
import { PlasticScmResource } from "./plasticScmResource";
import { toRevisionUri } from "./revisionContentProvider";

/**
 * History diffs are keyed by revision id, so unlike the per-changeset cache there
 * is no "moved past it" signal; age is the only reasonable eviction rule.
 */
const REVISION_CACHE_MAX_AGE_MILLIS = 24 * 60 * 60 * 1000;

export class Workspace implements Disposable, QuickDiffProvider {

  public get sourceControl(): SourceControl {
    return this.mSourceControl;
  }

  public get statusResourceGroup(): IPlasticScmResourceGroup {
    return this.mStatusResourceGroup as IPlasticScmResourceGroup;
  }

  /**
   * Every pending change of the last status, including the One File Per Actor
   * ones that the SCM group leaves out. Switch, update and shelve decisions use
   * this list, not the group.
   */
  public get pendingChanges(): ReadonlyArray<{ isPrivate: boolean; resourceUri: Uri; type: ChangeType }> {
    return this.mPendingChanges;
  }

  public get workspaceConfig(): IWorkspaceConfig | undefined {
    return this.mWorkspaceConfig;
  }

  public get info(): IWorkspaceInfo {
    return this.mWkInfo;
  }

  public get shell(): ICmShell {
    return this.mShell;
  }

  public get currentChangeset(): number {
    // `??`, not `||`: changeset 0 is a real (if empty) place to be.
    return this.mCurrentChangeset ?? -1;
  }

  public get operations(): IWorkspaceOperations {
    return this.mOperations;
  }

  /** True when the branch the workspace is on has a newer head than the workspace's changeset. */
  public get hasIncomingChanges(): boolean {
    return hasIncomingChanges(this.mWorkspaceConfig, this.mCurrentChangeset, this.mKnownBranchHead);
  }

  public readonly onDidRunStatus: Event<void>;
  /** The locks of this workspace's repository; badges and the Locks view read it. */
  public readonly locks: LockStore;

  private mPendingChanges: Array<{ isPrivate: boolean; resourceUri: Uri; type: ChangeType }> = [];
  private readonly mShell: ICmShell;
  private readonly mChannel: OutputChannel;
  private readonly mWkInfo: IWorkspaceInfo;
  private readonly mSourceControl: SourceControl;
  private readonly mStatusResourceGroup: SourceControlResourceGroup;
  private readonly mUnrealLevelsResourceGroup: SourceControlResourceGroup;

  private readonly mOperations: IWorkspaceOperations;

  private readonly mDisposables: Disposable;

  private mConfig: IConfig;
  private mWorkspaceConfig?: IWorkspaceConfig;
  private mbIsStatusSlow = false;
  private mCurrentChangeset?: number;
  private mKnownBranchHead?: IKnownBranchHead;

  private onDidChangeStatus: EventEmitter<void>;

  public static async build(
      workspaceInfo: IWorkspaceInfo,
      shell: ICmShell,
      channel: OutputChannel,
      workspaceOperations: IWorkspaceOperations,
      config: IConfig): Promise<Workspace> {

    const result = new Workspace(workspaceInfo, shell, channel, workspaceOperations, config);

    await result.updateWorkspaceStatus();
    return result;
  }

  private constructor(
      workspaceInfo: IWorkspaceInfo,
      shell: ICmShell,
      channel: OutputChannel,
      workspaceOperations: IWorkspaceOperations,
      config: IConfig) {

    this.onDidChangeStatus = new EventEmitter<void>();
    this.onDidRunStatus = this.onDidChangeStatus.event;

    this.mWkInfo = workspaceInfo;
    this.mShell = shell;
    this.locks = new LockStore({
      log: message => channel.appendLine(message),
      repSpec: () => this.mWorkspaceConfig?.repSpec,
      shell,
    });
    this.mChannel = channel;
    // Namespaced per workspace: a constant id makes every Plastic workspace in the
    // window answer to the same `scmProvider` key, so menus and commands can't tell
    // them apart. Menu `when` clauses match the prefix with `=~ /^plastic-scm/`.
    this.mSourceControl = scm.createSourceControl(
      `${constants.extensionId}:${workspaceInfo.id}`,
      constants.extensionDisplayName,
      Uri.file(workspaceInfo.path));
    this.mUnrealLevelsResourceGroup = this.mSourceControl.createResourceGroup(
      "unreal-levels", "Dirty Unreal Levels");
    this.mStatusResourceGroup = this.mSourceControl.createResourceGroup(
      "status", "Workspace Status");

    this.mUnrealLevelsResourceGroup.hideWhenEmpty = true;

    this.mOperations = workspaceOperations;
    this.mConfig = config;

    const fsWatcher = VsCodeWorkspace.createFileSystemWatcher(new RelativePattern(workspaceInfo.path, "**"));
    const onAnyFsOperationEvent: Event<Uri> = events.filterEvent(
      events.anyEvent(
        fsWatcher.onDidChange,
        fsWatcher.onDidCreate,
        fsWatcher.onDidDelete,
      ),
      uri => this.isWatched(uri));

    this.mDisposables = Disposable.from(
      this.mSourceControl,
      this.mUnrealLevelsResourceGroup,
      this.mStatusResourceGroup,
      fsWatcher,
      onAnyFsOperationEvent(async () => this.onFileChanged(), this),
    );

    this.mSourceControl.acceptInputCommand = {
      arguments: [this],
      command: "plastic-scm.checkin",
      title: "checkin",
    };

    this.mSourceControl.quickDiffProvider = this;
  }

  public dispose(): void {
    this.locks.dispose();
    this.mDisposables.dispose();
  }

  public updateConfig(newConfig: IConfig): void {
    this.mConfig = newConfig;
  }

  public async provideOriginalResource(uri: Uri): Promise<Uri | undefined> {
    if (uri.scheme !== "file") {
      return undefined;
    }

    if (typeof this.mCurrentChangeset === "undefined") {
      await this.mOperations.run(WorkspaceOperation.Status, () => this.updateWorkspaceStatus());
    }

    if (!this.mCurrentChangeset) {
      return undefined;
    }

    // Hand back a URI, not content: the content provider fetches it only if VS
    // Code actually needs to render this gutter.
    return toRevisionUri(this.mWkInfo.id, uri, this.mCurrentChangeset);
  }

  public async updateWorkspaceStatus(): Promise<void> {
    // Improvement: measure status time and update the 'this.mbIsStatusSlow' flag.
    // ! Status XML output does not print performance warnings!
    const pendingChanges: IPendingChanges =
      await CmStatusCommand.run(this.mWkInfo.path, this.mShell);

    this.mWorkspaceConfig = pendingChanges.workspaceConfig;
    this.mCurrentChangeset = pendingChanges.changeset;

    void CmGetFileCommand.pruneCache(this.mWkInfo.path, pendingChanges.changeset).catch(
      e => this.mChannel.appendLine(`Unable to prune the changeset file cache: ${(e as Error).message}`));
    void CmGetFileCommand.pruneRevisionCache(this.mWkInfo.path, REVISION_CACHE_MAX_AGE_MILLIS).catch(
      e => this.mChannel.appendLine(`Unable to prune the revision cache: ${(e as Error).message}`));

    const changeInfos: IChangeInfo[] = Array.from(pendingChanges.changes.values());
    this.mPendingChanges = changeInfos.map(info => ({
      isPrivate: (info.type & ChangeType.Private) !== 0,
      resourceUri: info.path,
      type: info.type,
    }));

    const sourceControlResources: PlasticScmResource[] = [];
    const unrealLevelResources: SourceControlResourceState[] = [];

    // regex pattern for Unreal Engine's One File Per Actor system
    const unrealOfpaRegex = /(__ExternalActors__|__ExternalObjects__)/;

    for (const changeInfo of changeInfos) {
      if (
        this.mConfig.consolidateUnrealOneFilePerActorChanges &&
        unrealOfpaRegex.exec(changeInfo.path.toString()) !== null
      ) {
        continue;
      }

      sourceControlResources.push(new PlasticScmResource(changeInfo, this));
    }

    if (this.mConfig.consolidateUnrealOneFilePerActorChanges) {
      const unrealLevelNames: string[] = [];
      for (const changeInfo of changeInfos) {
        let skipFile =
          unrealOfpaRegex.exec(changeInfo.path.fsPath) === null ||
          !changeInfo.path.fsPath.endsWith("uasset");

        for (const name of unrealLevelNames) {
          if (changeInfo.path.fsPath.includes(name)) {
            skipFile = true;
            break;
          }
        }

        if (skipFile) {
          continue;
        }

        const pathParts = changeInfo.path.fsPath.replace(/\\/g, "/").split("/");
        const ofpaIndex = pathParts.findIndex((value: string) => unrealOfpaRegex.exec(value) !== null);
        const levelRelativeLocation = pathParts.slice(ofpaIndex + 1, pathParts.length - 3).join("/");
        const pathToContentDir = pathParts.slice(0, ofpaIndex).join("/");
        const levelName = path.basename(levelRelativeLocation);

        unrealLevelNames.push(levelName);

        const resourceState: SourceControlResourceState = {
          decorations: {
            faded: false,
            strikeThrough: false,
            tooltip: `${levelRelativeLocation}.umap: actors or objects saved in separate files ` +
              "(One File Per Actor) have pending changes",
          },
          resourceUri: Uri.from({
            path: `${pathToContentDir}/${levelRelativeLocation}.umap`,
            scheme: "file",
          }),
        };

        unrealLevelResources.push(resourceState);
      }
    }

    this.mStatusResourceGroup.resourceStates = sourceControlResources;
    this.mUnrealLevelsResourceGroup.resourceStates = unrealLevelResources;
    this.mSourceControl.count = sourceControlResources.length + unrealLevelResources.length;


    this.mSourceControl.inputBox.placeholder = this.getCheckinPlaceholder(this.mWorkspaceConfig);
    this.updateStatusBar();

    this.onDidChangeStatus.fire();
  }

  /**
   * Tells the workspace the newest changeset the server has on its branch, as
   * the graph last saw it. When that is newer than the workspace's changeset,
   * the status bar offers an Update.
   */
  public setKnownBranchHead(head: IKnownBranchHead | undefined): void {
    const wasIncoming = this.hasIncomingChanges;
    this.mKnownBranchHead = head;
    if (wasIncoming !== this.hasIncomingChanges) {
      this.updateStatusBar();
    }
  }

  private updateStatusBar(): void {
    const config = this.mWorkspaceConfig;
    if (!config) {
      return;
    }

    const location = this.getPrefix(config.configType) + config.location;
    const statusBarCommands: Command[] = [{
      // A menu, not the SCM view: switching and updating are what the entry is for.
      arguments: [this],
      command: "plastic-scm.statusBarMenu",
      title: `$(${this.getStatusBarIconKey(config.configType)}) ${location}`,
      tooltip: `${location}@${config.repSpec}\nClick to switch, create a branch or update.`,
    }];

    if (this.hasIncomingChanges) {
      statusBarCommands.push({
        arguments: [this],
        command: "plastic-scm.update",
        title: "$(cloud-download) Update",
        tooltip: `Newer changesets on ${config.location}. Click to update the workspace.`,
      });
    }

    this.mSourceControl.statusBarCommands = statusBarCommands;
  }

  /**
   * Debounced rather than throttled: an editor save or a Unity import arrives as a
   * burst of events, and only the state after the burst is worth a status call.
   */
  @debounce(1500)
  private async onFileChanged(): Promise<void> {
    if (!this.mConfig.autorefresh) {
      return;
    }

    if (this.mbIsStatusSlow) {
      // IMPROVEMENT: ask the user if they want to keep calculating status on this workspace automatically.
    }

    if (this.mOperations.isRunning(WorkspaceOperation.Status)) {
      return;
    }

    // The shell queues commands, so there is nothing to wait for here.
    await this.mOperations.run(WorkspaceOperation.Status, () => this.updateWorkspaceStatus());
  }

  /**
   * Unity and Unreal rewrite their intermediate directories constantly. Watching
   * them means a refresh that can never keep up — and the revision cache lives
   * under .plastic, so an unfiltered watcher retriggers itself forever.
   */
  private isWatched(uri: Uri): boolean {
    const relativePath = path.relative(this.mWkInfo.path, uri.fsPath).replace(/\\/g, "/");

    if (relativePath.startsWith("..")) {
      return false;
    }

    const [topLevel] = relativePath.split("/");
    return !this.mConfig.ignoredDirectories.includes(topLevel);
  }

  private getCheckinPlaceholder(wkConfig: IWorkspaceConfig) {
    if (wkConfig.configType === WkConfigType.Branch) {
      return `Message (Ctrl+Enter to checkin in '${wkConfig.location}')`;
    }

    if (wkConfig.configType === WkConfigType.Changeset) {
      return `Message (Ctrl+Enter to checkin after '${wkConfig.location}')`;
    }

    return "Check in on a branch or a changeset. This workspace is on a " +
      `${wkConfig.configType.toLowerCase()}: run "Plastic SCM: Switch to Branch" first.`;
  }

  private getStatusBarIconKey(wkConfigType: WkConfigType) {
    switch (wkConfigType) {
    case WkConfigType.Changeset:
      return "git-commit";
    case WkConfigType.Label:
      return "tag";
    case WkConfigType.Shelve:
      return "archive";
    case WkConfigType.Branch:
    default:
      return "git-branch";
    }
  }

  private getPrefix(wkConfigType: WkConfigType) {
    switch (wkConfigType) {
    case WkConfigType.Changeset:
      return "cs:";
    case WkConfigType.Label:
      return "lb:";
    case WkConfigType.Shelve:
      return "sh:";
    case WkConfigType.Branch:
      return "br:";
    default:
      return "";
    }
  }
}

export interface IPlasticScmResourceGroup extends SourceControlResourceGroup {
  resourceStates: PlasticScmResource[];
}
