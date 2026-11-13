import { ChangeType, ILockEntry } from "../models";
import { commands, Disposable, window } from "vscode";
import { explainCheckoutFailure, lockItemSpec, locksHeldByOthers } from "../locks/lockMessages";
import { fileTargetUris, groupUrisByWorkspace } from "./fileTargets";
import { guarded, lockNodesFromArgs } from "./targets";
import { runWorkspaceOperation, WorkspaceOperation } from "../workspaceOperations";
import { Checkout } from "../cm/commands/checkout/checkout";
import { describeError } from "./scmUtils";
import { PlasticScm } from "../plasticScm";
import { UnlockItems } from "../cm/commands/unlockItems/unlockItems";
import { Workspace } from "../workspace";

export const LOCK_COMMANDS = {
  checkout: "plastic-scm.checkout",
  refresh: "plastic-scm.locks.refresh",
  release: "plastic-scm.locks.release",
  remove: "plastic-scm.locks.remove",
};

/** What a lock confirmation shows; pure so the wording is tested. */
export function describeUnlock(
    locks: readonly ILockEntry[], remove: boolean): { message: string; detail: string; label: string } {
  const others = locks.filter(lock => !lock.mine);
  const what = locks.length === 1 ? `'${locks[0].path}'` : `${locks.length} files`;
  const verb = remove ? "Remove the lock on" : "Release the lock on";

  const lines: string[] = [];
  if (remove) {
    lines.push("The lock record is deleted completely. Only a server administrator can do that.");
  } else {
    lines.push("Other users can check the file out afterwards. Your changes to it stay in your workspace.");
  }
  if (others.length > 0) {
    const owners = Array.from(new Set(others.map(lock => lock.owner))).join(", ");
    lines.push(
      `WARNING: ${others.length === locks.length ? "this lock is" : `${others.length} of these locks are`} ` +
      `held by ${owners}, not by you. Whoever holds it may lose work done under the lock. ` +
      "cm only lets a server administrator do this and refuses otherwise.");
  }

  const label = others.length > 0
    ? (remove ? "Remove Someone Else's Lock" : "Release Someone Else's Lock")
    : (remove ? "Remove Lock" : "Release Lock");
  return { detail: lines.join("\n\n"), label, message: `${verb} ${what}?` };
}

/** Paths to check out: files only known to be private, deleted or already checked out are left out. */
export function checkoutCandidates(
    uris: ReadonlyArray<{ fsPath: string }>,
    states: ReadonlyArray<{ resourceUri: { fsPath: string }; type: ChangeType; isPrivate: boolean }>): string[] {
  const byPath = new Map(states.map(state => [ state.resourceUri.fsPath, state ]));
  return uris
    .map(uri => uri.fsPath)
    .filter(fsPath => {
      const state = byPath.get(fsPath);
      return !state || !(state.isPrivate || (state.type & (ChangeType.Deleted | ChangeType.Checkedout)));
    });
}

/**
 * Checkout (SCM rows, Explorer, editor title) and the Locks view's commands.
 * Checkout is exclusive when the server's lock rules match the file; cm then
 * refuses it while somebody else holds the lock.
 */
export class LockCommands implements Disposable {
  private readonly mDisposables: Disposable[];

  /** @param onRepositoryChanged Called after locks changed, so the Repository view reloads. */
  public constructor(private readonly mPlasticScm: PlasticScm, private readonly mOnRepositoryChanged: () => void) {
    this.mDisposables = [
      commands.registerCommand(LOCK_COMMANDS.checkout, (...args: unknown[]) => this.checkout(args)),
      commands.registerCommand(LOCK_COMMANDS.refresh, () => this.refresh()),
      commands.registerCommand(LOCK_COMMANDS.release, (...args: unknown[]) => this.unlock(args, false)),
      commands.registerCommand(LOCK_COMMANDS.remove, (...args: unknown[]) => this.unlock(args, true)),
    ];
  }

  public dispose(): void {
    this.mDisposables.forEach(disposable => {
      disposable.dispose();
    });
  }

  private async checkout(args: unknown[]): Promise<void> {
    const uris = fileTargetUris(args, window.activeTextEditor?.document.uri);
    for (const [ workspace, owned ] of groupUrisByWorkspace(this.mPlasticScm, uris)) {
      const paths = checkoutCandidates(owned, workspace.pendingChanges);
      if (paths.length > 0) {
        await this.checkoutPaths(workspace, paths);
      } else {
        void window.showInformationMessage(
          "Nothing to check out: the selection is private, deleted or already checked out.");
      }
    }
  }

  private async checkoutPaths(workspace: Workspace, paths: string[]): Promise<void> {
    await runWorkspaceOperation(
      this.mPlasticScm,
      workspace,
      {
        name: "Checkout",
        operation: WorkspaceOperation.Checkout,
        title: paths.length === 1 ? "Checking out 1 file" : `Checking out ${paths.length} files`,
      },
      async () => {
        try {
          const lines = await Checkout.run(workspace.shell, paths);
          // Not refreshIfStale: the checkout may just have taken a lock, and every status keeps that fresh.
          void workspace.locks.refresh({ fresh: true }).then(
            () => this.mOnRepositoryChanged(),
            (e: unknown) => this.mPlasticScm.channel.appendLine(`Unable to list locks: ${describeError(e)}`));
          return lines;
        } catch (e) {
          throw new Error(await this.explainFailure(workspace, paths, describeError(e)));
        }
      });
  }

  /** Names the holder of a lock on the files, from the cached list first and from a fresh one if that finds nothing. */
  private async explainFailure(workspace: Workspace, paths: string[], cmMessage: string): Promise<string> {
    let held = locksHeldByOthers(workspace.locks.snapshot, workspace.info.path, paths);
    if (held.length === 0) {
      try {
        held = locksHeldByOthers(await workspace.locks.refresh(), workspace.info.path, paths);
      } catch (e) {
        this.mPlasticScm.channel.appendLine(`Unable to list locks: ${describeError(e)}`);
      }
    }
    return explainCheckoutFailure(cmMessage, held, workspace.info.path);
  }

  private async refresh(): Promise<void> {
    await guarded(this.mPlasticScm, "Refresh Locks", async () => {
      for (const workspace of this.mPlasticScm.workspaces.values()) {
        await workspace.locks.refresh();
      }
      this.mOnRepositoryChanged();
    });
  }

  private async unlock(args: unknown[], remove: boolean): Promise<void> {
    const nodes = lockNodesFromArgs(args);
    if (nodes.length === 0) {
      void window.showInformationMessage("Select a lock in the Locks section of the Plastic SCM Repository view.");
      return;
    }

    const description = describeUnlock(nodes.map(node => node.lock), remove);
    const answer = await window.showWarningMessage(
      description.message, { detail: description.detail, modal: true }, description.label);
    if (answer !== description.label) {
      return;
    }

    const byWorkspace = new Map<string, typeof nodes>();
    for (const node of nodes) {
      byWorkspace.set(node.workspaceId, [ ...(byWorkspace.get(node.workspaceId) ?? []), node ]);
    }

    for (const [ workspaceId, owned ] of byWorkspace) {
      const workspace = this.mPlasticScm.workspaces.get(workspaceId);
      if (!workspace) {
        continue;
      }

      const specs = owned.map(node => lockItemSpec(node.lock, workspace.workspaceConfig?.repSpec, workspace.info.path));
      const outcome = await runWorkspaceOperation(
        this.mPlasticScm,
        workspace,
        {
          name: remove ? "Remove Lock" : "Release Lock",
          operation: WorkspaceOperation.Lock,
          refreshStatus: false,
          title: remove ? "Removing locks" : "Releasing locks",
        },
        () => UnlockItems.run(workspace.shell, specs, remove));

      // After the operation: cm already released the lock, so a failed listing must not turn that into a failure.
      if (outcome.status === "succeeded") {
        try {
          await workspace.locks.refresh({ fresh: true });
        } catch (e) {
          this.mPlasticScm.channel.appendLine(`Unable to list locks: ${describeError(e)}`);
        }
      }

      if (outcome.status === "succeeded") {
        window.setStatusBarMessage(remove ? "Lock removed" : "Lock released", 5000);
      }
      this.mOnRepositoryChanged();
    }
  }
}
