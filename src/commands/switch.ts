import { branchFromNode, guarded, labelFromNode, resolveWorkspace } from "./targets";
import { commands, Disposable, QuickPickItem, window } from "vscode";
import { isCurrentBranch, isCurrentLabel } from "../repository/presentation";
import { pickBranch, pickChangeset, pickLabel } from "../repository/pickers";
import { switchWorkspace, updateWorkspace } from "./workspaceActions";
import { PlasticScm } from "../plasticScm";
import { Workspace } from "../workspace";

export const SWITCH_COMMANDS = {
  statusBarMenu: "plastic-scm.statusBarMenu",
  switchToBranch: "plastic-scm.switch.branch",
  switchToChangeset: "plastic-scm.switch.changeset",
  switchToLabel: "plastic-scm.switch.label",
  update: "plastic-scm.update",
};

interface IMenuItem extends QuickPickItem {
  command: string;
}

/** The entries of the status bar menu, in order. Exported for tests. */
export const STATUS_BAR_MENU: readonly IMenuItem[] = [
  { command: SWITCH_COMMANDS.switchToBranch, label: "$(git-branch) Switch to Branch…" },
  { command: SWITCH_COMMANDS.switchToChangeset, label: "$(git-commit) Switch to Changeset…" },
  { command: SWITCH_COMMANDS.switchToLabel, label: "$(tag) Switch to Label…" },
  { command: "plastic-scm.branch.create", label: "$(add) Create Branch…" },
  { command: "plastic-scm.branch.createAndSwitch", label: "$(add) Create Branch and Switch…" },
  { command: SWITCH_COMMANDS.update, label: "$(cloud-download) Update Workspace" },
  { command: "plastic-scm.shelve.create", label: "$(archive) Shelve Pending Changes…" },
  { command: "workbench.view.scm", label: "$(source-control) Show Source Control" },
];

/** Switch to a branch, changeset or label, update the workspace, and the status bar menu that offers them. */
export class SwitchCommands implements Disposable {
  private readonly mPlasticScm: PlasticScm;
  private readonly mDisposables: Disposable[];

  public constructor(plasticScm: PlasticScm) {
    this.mPlasticScm = plasticScm;
    this.mDisposables = [
      commands.registerCommand(SWITCH_COMMANDS.switchToBranch, (...args: unknown[]) => this.switchToBranch(args)),
      commands.registerCommand(SWITCH_COMMANDS.switchToChangeset, (...args: unknown[]) => this.switchToChangeset(args)),
      commands.registerCommand(SWITCH_COMMANDS.switchToLabel, (...args: unknown[]) => this.switchToLabel(args)),
      commands.registerCommand(SWITCH_COMMANDS.update, (...args: unknown[]) => this.update(args)),
      commands.registerCommand(SWITCH_COMMANDS.statusBarMenu, (...args: unknown[]) => this.showMenu(args)),
    ];
  }

  public dispose(): void {
    Disposable.from(...this.mDisposables).dispose();
    this.mDisposables.length = 0;
  }

  private async switchToBranch(args: unknown[]): Promise<void> {
    const workspace = await resolveWorkspace(this.mPlasticScm, args, "Which workspace would you like to switch?");
    if (!workspace) {
      return;
    }

    await guarded(this.mPlasticScm, "Switch", async () => {
      const branch = branchFromNode(args[0]) ?? await pickBranch(workspace.shell, {
        title: "Switch to Branch",
        workspaceConfig: workspace.workspaceConfig,
      });
      if (!branch) {
        return;
      }

      if (isCurrentBranch(branch, workspace.workspaceConfig)) {
        void window.showInformationMessage(`'${workspace.info.name}' is already on ${branch.name}.`);
        return;
      }
      await switchWorkspace(this.mPlasticScm, workspace, { kind: "branch", name: branch.name });
    });
  }

  private async switchToChangeset(args: unknown[]): Promise<void> {
    const workspace = await resolveWorkspace(this.mPlasticScm, args, "Which workspace would you like to switch?");
    if (!workspace) {
      return;
    }

    await guarded(this.mPlasticScm, "Switch", async () => {
      const changeset = await pickChangeset(workspace.shell, {
        title: "Switch to Changeset",
        workspaceConfig: workspace.workspaceConfig,
      });
      if (changeset) {
        await switchWorkspace(this.mPlasticScm, workspace, { id: changeset.id, kind: "changeset" });
      }
    });
  }

  private async switchToLabel(args: unknown[]): Promise<void> {
    const workspace = await resolveWorkspace(this.mPlasticScm, args, "Which workspace would you like to switch?");
    if (!workspace) {
      return;
    }

    await guarded(this.mPlasticScm, "Switch", async () => {
      const label = labelFromNode(args[0]) ?? await pickLabel(workspace.shell, {
        title: "Switch to Label",
        workspaceConfig: workspace.workspaceConfig,
      });
      if (!label) {
        return;
      }

      if (isCurrentLabel(label, workspace.workspaceConfig)) {
        void window.showInformationMessage(`'${workspace.info.name}' is already on label ${label.name}.`);
        return;
      }
      await switchWorkspace(this.mPlasticScm, workspace, { kind: "label", name: label.name });
    });
  }

  private async update(args: unknown[]): Promise<void> {
    const workspace = await resolveWorkspace(this.mPlasticScm, args, "Which workspace would you like to update?");
    if (workspace) {
      await guarded(this.mPlasticScm, "Update", async () => {
        await updateWorkspace(this.mPlasticScm, workspace);
      });
    }
  }

  private async showMenu(args: unknown[]): Promise<void> {
    const workspace: Workspace | undefined = await resolveWorkspace(
      this.mPlasticScm, args, "Which workspace would you like to work with?");
    if (!workspace) {
      return;
    }

    const items = STATUS_BAR_MENU.map(item => item.command === SWITCH_COMMANDS.update && workspace.hasIncomingChanges
      ? { ...item, description: "newer changesets on the branch" }
      : item);
    const choice = await window.showQuickPick(items, {
      placeHolder: `${workspace.info.name}: ${workspace.workspaceConfig?.location ?? ""}`,
    });
    if (choice) {
      await commands.executeCommand(choice.command, workspace);
    }
  }
}
