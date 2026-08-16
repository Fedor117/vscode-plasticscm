import * as path from "path";
import { commands, Disposable, window } from "vscode";
import { deletePrivatePaths, discardPrivateToTrash, retryWithoutTrash } from "./discardPrivate";
import { getSelectedResources, groupResourcesByWorkspace, showOperationError } from "./scmUtils";
import { Undo as CmUndoCommand } from "../cm/commands";
import { PlasticScm } from "../plasticScm";
import { PlasticScmResource } from "../plasticScmResource";
import { Workspace } from "../workspace";
import { WorkspaceOperation } from "../workspaceOperations";

/**
 * "Discard Changes" — the counterpart of the git extension's `git.clean`, and
 * contributed to the same two menus.
 *
 * One command covers single rows, multi-selections and folder rows alike,
 * because the SCM view flattens a folder into every resource beneath it before
 * invoking anything. Nothing here ever sees a directory node.
 */
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
    if (resources.length === 0) {
      return;
    }

    const controlled = resources.filter(resource => !resource.isPrivate);
    const privates = resources.filter(resource => resource.isPrivate);

    const scope = await confirmDiscard(controlled, privates);
    if (scope === DiscardScope.Nothing) {
      return;
    }

    const accepted = scope === DiscardScope.ControlledOnly
      ? controlled
      : resources;

    for (const [ workspace, owned ] of groupResourcesByWorkspace(this.mPlasticScm, accepted)) {
      await UndoCheckoutCommand.runDiscard(workspace, this.mPlasticScm, owned);
    }
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

    // Controlled changes only. Erasing every private file in the workspace is a
    // far bigger hammer than "undo my checkouts", and Plastic workspaces are
    // routinely full of untracked build output.
    const changeCount = workspace.statusResourceGroup.resourceStates
      .filter(resource => !resource.isPrivate).length;

    if (changeCount === 0) {
      return;
    }

    const yes = "Undo All Checkouts";
    const answer = await window.showWarningMessage(
      `Are you sure you want to undo all checkouts?\n\n${changeCount} controlled item(s) ` +
      "will be reverted. Private files are left alone.\n\nThis is IRREVERSIBLE!",
      { modal: true },
      yes);

    if (answer !== yes) {
      return;
    }

    // Recursive: `cm undocheckout` has no -r, so the previous form reverted the
    // workspace root item and left every changed file below it pending.
    await UndoCheckoutCommand.runUndoRecursive(
      workspace, this.mPlasticScm, [workspace.info.path]);
  }
}

export namespace UndoCheckoutCommand {
  export async function runDiscard(
      workspace: Workspace,
      plasticScm: PlasticScm,
      resources: PlasticScmResource[]): Promise<void> {

    if (workspace.operations.isRunning(WorkspaceOperation.UndoCheckout)) {
      return;
    }

    await workspace.operations.run(WorkspaceOperation.UndoCheckout, async () => {
      const privateUris = resources.filter(r => r.isPrivate).map(r => r.resourceUri);
      const controlledPaths = resources.filter(r => !r.isPrivate).map(r => r.resourceUri.fsPath);

      try {
        // cm goes first so a failure there leaves nothing deleted. No `-r`: cm
        // reports every changed descendant as its own entry, so the collected
        // paths are already the complete set and recursing would only widen the
        // operation past what the user was shown.
        if (controlledPaths.length > 0) {
          await CmUndoCommand.run(workspace.shell, false, ...controlledPaths);
        }

        if (privateUris.length > 0) {
          const useTrash = discardPrivateToTrash();
          let failed = await deletePrivatePaths(privateUris, useTrash);

          if (failed.length > 0 && useTrash) {
            failed = await retryWithoutTrash(failed, privateUris);
          }

          if (failed.length > 0) {
            throw new Error(`Unable to delete ${failed.length} private item(s): ${failed[0]}`);
          }
        }
      } catch (e) {
        await showOperationError(plasticScm, "Discard Changes", e);
      }

      await workspace.updateWorkspaceStatus();
    });
  }

  export async function runUndoRecursive(
      workspace: Workspace,
      plasticScm: PlasticScm,
      paths: string[]): Promise<void> {

    if (workspace.operations.isRunning(WorkspaceOperation.UndoCheckout)) {
      return;
    }

    await workspace.operations.run(WorkspaceOperation.UndoCheckout, async () => {
      try {
        await CmUndoCommand.run(workspace.shell, true, ...paths);
        await workspace.updateWorkspaceStatus();
      } catch (e) {
        await showOperationError(plasticScm, "Undo Changes", e);
      }
    });
  }
}

/** What the user agreed to, which for a mixed selection is not all-or-nothing. */
const enum DiscardScope {
  Nothing,
  ControlledOnly,
  Everything,
}

/**
 * Deleting private files cannot be undone by Plastic, so the wording follows the
 * git extension's: name the single item, count the many, and say plainly when
 * the trash is not involved.
 */
async function confirmDiscard(
    controlled: PlasticScmResource[],
    privates: PlasticScmResource[]): Promise<DiscardScope> {

  if (privates.length === 0) {
    return await confirm(describeControlled(controlled), discardLabel(controlled))
      ? DiscardScope.Everything
      : DiscardScope.Nothing;
  }

  if (controlled.length === 0) {
    return await confirmPrivate(privates)
      ? DiscardScope.Everything
      : DiscardScope.Nothing;
  }

  const total = controlled.length + privates.length;
  const controlledLabel = controlled.length === 1
    ? "Discard 1 Controlled Item"
    : `Discard All ${controlled.length} Controlled Items`;
  const everythingLabel = `Discard All ${total} Items`;

  const answer = await window.showWarningMessage(
    `${describePrivate(privates)}\n\n${describeControlled(controlled)}` +
    "\n\nThis is IRREVERSIBLE!",
    { modal: true },
    controlledLabel,
    everythingLabel);

  if (answer === everythingLabel) {
    return DiscardScope.Everything;
  }

  return answer === controlledLabel ? DiscardScope.ControlledOnly : DiscardScope.Nothing;
}

async function confirmPrivate(privates: PlasticScmResource[]): Promise<boolean> {
  const useTrash = discardPrivateToTrash();
  const many = privates.length !== 1;
  const bin = process.platform === "win32" ? "Recycle Bin" : "Trash";

  if (useTrash) {
    const label = many ? `Move ${privates.length} Items to ${bin}` : `Move to ${bin}`;
    const detail = many
      ? `You can restore these items from the ${bin}.`
      : `You can restore this item from the ${bin}.`;

    return await confirm(describePrivate(privates), label, detail);
  }

  const label = many ? `Delete All ${privates.length} Items` : "Delete Item";
  const forever = many
    ? "\n\nThis is IRREVERSIBLE!\nThese items will be FOREVER LOST if you proceed."
    : "\n\nThis is IRREVERSIBLE!\nThis item will be FOREVER LOST if you proceed.";

  return confirm(`${describePrivate(privates)}${forever}`, label);
}

function describeControlled(controlled: PlasticScmResource[]): string {
  return controlled.length === 1
    ? `Are you sure you want to discard changes in '${basename(controlled[0])}'?`
    : `Are you sure you want to discard ALL changes in ${controlled.length} items?`;
}

function describePrivate(privates: PlasticScmResource[]): string {
  return privates.length === 1
    ? `Are you sure you want to DELETE the private item '${basename(privates[0])}'?`
    : `Are you sure you want to DELETE ${privates.length} private items?`;
}

function discardLabel(controlled: PlasticScmResource[]): string {
  return controlled.length === 1
    ? "Discard Item"
    : `Discard All ${controlled.length} Items`;
}

function basename(resource: PlasticScmResource): string {
  return path.basename(resource.resourceUri.fsPath);
}

async function confirm(message: string, label: string, detail?: string): Promise<boolean> {
  const answer = await window.showWarningMessage(
    message, { detail, modal: true }, label);

  return answer === label;
}
