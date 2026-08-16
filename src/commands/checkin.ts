import { commands, Disposable, SourceControlResourceGroup, SourceControlResourceState, window } from "vscode";
import { findWorkspaceForResource, getSelectedResources, showOperationError } from "./scmUtils";
import { Checkin as CmCheckinCommand } from "../cm/commands";
import { PlasticScm } from "../plasticScm";
import { PlasticScmResource } from "../plasticScmResource";
import { Workspace } from "../workspace";
import { WorkspaceOperation } from "../workspaceOperations";

export class CheckinCommand implements Disposable {
  private readonly mPlasticScm: PlasticScm;
  private readonly mDisposable?: Disposable;

  public constructor(plasticScm: PlasticScm) {
    this.mPlasticScm = plasticScm;
    this.mDisposable = commands.registerCommand(
      "plastic-scm.checkin", (...args: unknown[]) => this.execute(args));
  }

  public dispose(): void {
    if (this.mDisposable) {
      this.mDisposable.dispose();
    }
  }

  private async execute(args: unknown[]): Promise<void> {
    const selectedResources = getSelectedResources(args);
    let workspace: Workspace | undefined;
    let checkinPaths: string[];

    if (selectedResources.length > 0) {
      workspace = findWorkspaceForResource(this.mPlasticScm, selectedResources[0]);
      checkinPaths = selectedResources
        .filter(r => !r.isPrivate)
        .map(r => r.resourceUri.fsPath);
    } else {
      const firstArg = args && args.length > 0 ? args[0] : undefined;
      workspace = firstArg instanceof Workspace ?
        firstArg :
        await this.mPlasticScm.promptUserToPickWorkspace();
      checkinPaths = workspace
        ? this.getCheckinPaths(workspace.statusResourceGroup)
        : [];
    }

    if (!workspace || checkinPaths.length === 0) {
      return;
    }

    const comment: string | undefined = await this.getComment(workspace);
    if (comment === undefined) {
      return;
    }

    if (workspace.operations.isRunning(WorkspaceOperation.Checkin)) {
      return;
    }

    await workspace.operations.run(WorkspaceOperation.Checkin, async () => {
      try {
        const ciResult = await CmCheckinCommand.run(
          workspace.shell,
          this.mPlasticScm.channel,
          comment,
          ...checkinPaths);

        await Promise.all(ciResult.map(cset => window.showInformationMessage(
          `Created changeset cs:${cset.changesetInfo.changesetId}`)));

        workspace.sourceControl.inputBox.value = "";
        await workspace.updateWorkspaceStatus();
      } catch (e) {
        await showOperationError(this.mPlasticScm, "Checkin", e);
      }
    });
  }

  private async getComment(workspace: Workspace): Promise<string | undefined> {
    if (workspace.sourceControl.inputBox.value) {
      return workspace.sourceControl.inputBox.value;
    }

    const yes = "Yes, go ahead!";
    const no = "No, let me write something first...";
    const allowEmpty: string | undefined = await window.showWarningMessage(
      "Do you really want to checkin with an empty comment?", { modal: true }, yes, no);

    if (allowEmpty === yes) {
      return "";
    }

    return await window.showInputBox({
      placeHolder: "Type here your checkin comment...",
    });
  }

  private getCheckinPaths(group: SourceControlResourceGroup): string[] {
    const results = group.resourceStates.map((entry: SourceControlResourceState) => {
      const change = entry as PlasticScmResource;
      return change.isPrivate ? null : change.resourceUri.fsPath;
    });
    return results.filter((p: string | null): p is string => p !== null);
  }
}
