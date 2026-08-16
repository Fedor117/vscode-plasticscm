import { commands, Disposable, window } from "vscode";
import { findWorkspaceForResource, getSelectedResources } from "./scmUtils";
import { UndoCheckout as CmUndoCheckoutCommand } from "../cm/commands";
import { PlasticScm } from "../plasticScm";
import { Workspace } from "../workspace";
import { WorkspaceOperation } from "../workspaceOperations";

export class UndoCheckoutCommand implements Disposable {
  private readonly mPlasticScm: PlasticScm;
  private readonly mDisposable?: Disposable;

  public constructor(plasticScm: PlasticScm) {
    this.mPlasticScm = plasticScm;
    this.mDisposable = commands.registerCommand(
      "plastic-scm.undoCheckout", (...args: unknown[]) => this.execute(args));
  }

  public dispose(): void {
    if (this.mDisposable) {
      this.mDisposable.dispose();
    }
  }

  private async execute(args: unknown[]): Promise<void> {
    const resources = getSelectedResources(args);
    if (!resources || resources.length === 0) {
      return;
    }

    // Filter to only controlled (non-private) files — undocheckout doesn't work on private files
    const revertable = resources.filter(r => !r.isPrivate);
    if (revertable.length === 0) {
      await window.showWarningMessage(
        "No controlled files selected. Undo checkout only works on files under source control.");
      return;
    }

    // Confirmation dialog
    const fileNames = revertable.map(r => r.resourceUri.fsPath);
    const fileList = revertable.length <= 3
      ? fileNames.map(f => `\n  • ${f}`).join("")
      : `\n  ${revertable.length} files`;

    const yes = "Undo Checkout";
    const answer = await window.showWarningMessage(
      `Are you sure you want to undo checkout?${fileList}\n\nThis will discard your changes.`,
      { modal: true },
      yes);

    if (answer !== yes) {
      return;
    }

    const workspace = findWorkspaceForResource(this.mPlasticScm, revertable[0]);
    if (!workspace) {
      return;
    }

    await UndoCheckoutCommand.runUndoCheckout(
      workspace, this.mPlasticScm,
      revertable.map(r => r.resourceUri.fsPath));
  }
}

export class UndoCheckoutAllCommand implements Disposable {
  private readonly mPlasticScm: PlasticScm;
  private readonly mDisposable?: Disposable;

  public constructor(plasticScm: PlasticScm) {
    this.mPlasticScm = plasticScm;
    this.mDisposable = commands.registerCommand(
      "plastic-scm.undoCheckoutAll", (...args: unknown[]) => this.execute(args));
  }

  public dispose(): void {
    if (this.mDisposable) {
      this.mDisposable.dispose();
    }
  }

  private async execute(args: unknown[]): Promise<void> {
    const firstArg = args && args.length > 0 ? args[0] : undefined;
    const workspace: Workspace | undefined = firstArg instanceof Workspace
      ? firstArg
      : await this.mPlasticScm.promptUserToPickWorkspace();

    if (!workspace) {
      return;
    }

    const changeCount = workspace.statusResourceGroup.resourceStates.length;
    if (changeCount === 0) {
      return;
    }

    const yes = "Undo All Checkouts";
    const answer = await window.showWarningMessage(
      `Are you sure you want to undo all checkouts?\n\n${changeCount} changed file(s) will be reverted. This will discard all your changes.`,
      { modal: true },
      yes);

    if (answer !== yes) {
      return;
    }

    await UndoCheckoutCommand.runUndoCheckout(
      workspace, this.mPlasticScm,
      [workspace.info.path]);
  }
}

export namespace UndoCheckoutCommand {
  export async function runUndoCheckout(
      workspace: Workspace,
      plasticScm: PlasticScm,
      paths: string[]): Promise<void> {

    if (workspace.operations.isRunning(WorkspaceOperation.UndoCheckout)) {
      return;
    }

    await workspace.operations.run(WorkspaceOperation.UndoCheckout, async () => {
      try {
        await CmUndoCheckoutCommand.run(workspace.shell, ...paths);
        await workspace.updateWorkspaceStatus();
      } catch (e) {
        const error = e as Error;
        const errorPrefix = "Error: ";
        const message = error.message.substring(
          error.message.lastIndexOf(errorPrefix) + errorPrefix.length);
        plasticScm.channel.appendLine(`ERROR: ${message}`);
        await window.showErrorMessage(`Plastic SCM Undo Checkout failed: ${message}`);
      }
    });
  }
}
