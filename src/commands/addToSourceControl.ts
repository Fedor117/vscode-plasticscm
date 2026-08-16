import { commands, Disposable, window } from "vscode";
import { getSelectedResources, groupResourcesByWorkspace, isPathInside, showOperationError } from "./scmUtils";
import { Add as CmAddCommand } from "../cm/commands";
import { PlasticScm } from "../plasticScm";
import { PlasticScmResource } from "../plasticScmResource";
import { Workspace } from "../workspace";
import { WorkspaceOperation } from "../workspaceOperations";

/**
 * "Add to Source Control" — the counterpart of the git extension's `git.stage`,
 * and the only way a private file can reach a checkin: CheckinCommand filters
 * private resources out of every path list it builds, so until an item is added
 * it is invisible to a checkin no matter how it is selected.
 */
export class AddCommand implements Disposable {
  private readonly mPlasticScm: PlasticScm;
  private readonly mDisposable?: Disposable;

  public constructor(plasticScm: PlasticScm) {
    this.mPlasticScm = plasticScm;
    this.mDisposable = commands.registerCommand(
      "plastic-scm.add", (...args: unknown[]) => this.execute(args));
  }

  public dispose(): void {
    if (this.mDisposable) {
      this.mDisposable.dispose();
    }
  }

  private async execute(args: unknown[]): Promise<void> {
    const selected = getSelectedResources(args);
    if (selected.length === 0) {
      return;
    }

    const privates = selected.filter(resource => resource.isPrivate);
    if (privates.length === 0) {
      // Reachable from a folder row: the folder menu has no way to describe its
      // own contents, so the entry is always visible and has to explain itself.
      await window.showInformationMessage(
        "Nothing to add — everything selected is already under source control.");
      return;
    }

    for (const [ workspace, owned ] of groupResourcesByWorkspace(this.mPlasticScm, privates)) {
      await this.runAdd(workspace, owned);
    }
  }

  private async runAdd(
      workspace: Workspace,
      resources: PlasticScmResource[]): Promise<void> {

    if (workspace.operations.isRunning(WorkspaceOperation.Add)) {
      return;
    }

    await workspace.operations.run(WorkspaceOperation.Add, async () => {
      const selectedPaths = resources.map(resource => resource.resourceUri.fsPath);
      const privateDirectories = workspace.statusResourceGroup.resourceStates
        .filter(resource => resource.isPrivate && resource.isDirectory)
        .map(resource => resource.resourceUri.fsPath);

      const scaffolding = privateAncestorsOf(privateDirectories, selectedPaths);

      try {
        // Parents first and non-recursively: these directories were never
        // picked by the user, they exist only to satisfy cm's requirement that
        // a parent be under source control before its child can be added.
        // Adding them recursively would sweep in siblings nobody selected.
        if (scaffolding.length > 0) {
          await CmAddCommand.run(workspace.shell, false, ...scaffolding);
        }

        // Recursive, so that clicking a private folder in list view — where
        // nothing is flattened for us — takes its contents along.
        await CmAddCommand.run(workspace.shell, true, ...topmost(selectedPaths));
      } catch (e) {
        await showOperationError(this.mPlasticScm, "Add", e);
      }

      await workspace.updateWorkspaceStatus();
    });
  }
}

/**
 * The private directories between the selection and the workspace root, which
 * `cm add` will not create on the caller's behalf. Sorted shallowest-first,
 * which plain lexicographic order gives us because a parent path is a prefix of
 * its children.
 */
export function privateAncestorsOf(
    privateDirectories: string[], selectedPaths: string[]): string[] {

  const selected = new Set(selectedPaths);

  return privateDirectories
    .filter(dir => !selected.has(dir) && selectedPaths.some(p => isPathInside(p, dir)))
    .sort();
}

/** Drops paths already covered by a selected ancestor, since the add is recursive. */
export function topmost(paths: string[]): string[] {
  return paths.filter(candidate => !paths.some(
    other => other !== candidate && isPathInside(candidate, other)));
}
