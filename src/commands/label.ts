import { branchFromNode, explorerChangesetFromArg, guarded, labelFromNode, resolveWorkspace } from "./targets";
import { commands, Disposable, QuickPickItem, window } from "vscode";
import { CreateLabel, DeleteLabel, ListLabels, RenameLabel } from "../cm/commands";
import { pickChangeset, pickLabel } from "../repository/pickers";
import { runWorkspaceOperation, WorkspaceOperation } from "../workspaceOperations";
import { ILabelInfo } from "../models";
import { isCurrentLabel } from "../repository/presentation";
import { labelNameProblem } from "../cm/commands/refNames";
import { PlasticScm } from "../plasticScm";
import { Workspace } from "../workspace";

export const LABEL_COMMANDS = {
  create: "plastic-scm.label.create",
  delete: "plastic-scm.label.delete",
  rename: "plastic-scm.label.rename",
};

interface IStartItem extends QuickPickItem {
  pick: "current" | "changeset";
}

/** Label commands: create, rename, delete. */
export class LabelCommands implements Disposable {
  private readonly mPlasticScm: PlasticScm;
  private readonly mOnRepositoryChanged: () => void;
  private readonly mDisposables: Disposable[];

  /** @param onRepositoryChanged Called after labels changed, so the Repository view reloads. */
  public constructor(plasticScm: PlasticScm, onRepositoryChanged: () => void) {
    this.mPlasticScm = plasticScm;
    this.mOnRepositoryChanged = onRepositoryChanged;
    this.mDisposables = [
      commands.registerCommand(LABEL_COMMANDS.create, (...args: unknown[]) => this.create(args)),
      commands.registerCommand(LABEL_COMMANDS.rename, (...args: unknown[]) => this.rename(args)),
      commands.registerCommand(LABEL_COMMANDS.delete, (...args: unknown[]) => this.delete(args)),
    ];
  }

  public dispose(): void {
    Disposable.from(...this.mDisposables).dispose();
    this.mDisposables.length = 0;
  }

  private async create(args: unknown[]): Promise<void> {
    const workspace = await resolveWorkspace(this.mPlasticScm, args, "Which workspace should get the new label?");
    if (!workspace) {
      return;
    }

    await guarded(this.mPlasticScm, "Create Label", async () => {
      const changeset = await this.chooseChangeset(workspace, args[0]);
      if (changeset === undefined) {
        return;
      }

      const name = await window.showInputBox({
        ignoreFocusOut: true,
        prompt: `Name of the new label on cs:${changeset}`,
        title: "Create Label",
        validateInput: text => labelNameProblem(text),
      });
      if (name === undefined) {
        return;
      }

      // `cm label create` on an existing name puts that label on one more changeset
      // instead of failing, which is not what "create" promises.
      const existing = await ListLabels.runByName(workspace.shell, name);
      if (existing) {
        throw new Error(`Label ${name} already exists, on cs:${existing.changesetId}. Pick another name.`);
      }

      const comment = await window.showInputBox({
        ignoreFocusOut: true,
        prompt: "Comment for the new label (optional). Enter to continue without one.",
        title: "Create Label",
      });
      if (comment === undefined) {
        return;
      }

      const outcome = await runWorkspaceOperation(
        this.mPlasticScm,
        workspace,
        {
          name: "Create Label",
          operation: WorkspaceOperation.Reference,
          refreshStatus: false,
          title: `Creating label ${name}`,
        },
        () => CreateLabel.run(workspace.shell, this.mPlasticScm.channel, { changeset, comment, name }));
      if (outcome.status === "succeeded") {
        this.mOnRepositoryChanged();
        window.setStatusBarMessage(`Created label ${name} on cs:${changeset}`, 5000);
      }
    });
  }

  /** The changeset to label: a branch row's head, else the current changeset or a picked one. */
  private async chooseChangeset(workspace: Workspace, arg: unknown): Promise<number | undefined> {
    const branch = branchFromNode(arg);
    if (branch) {
      return branch.headChangesetId;
    }
    const explorerRow = explorerChangesetFromArg(arg);
    if (explorerRow) {
      return explorerRow.changesetId;
    }

    const current = workspace.currentChangeset;
    const items: IStartItem[] = [
      {
        description: current >= 0 ? `cs:${current}` : "not known yet",
        label: "$(git-commit) The current changeset",
        pick: "current",
      },
      { label: "$(history) A changeset…", pick: "changeset" },
    ];
    const choice = await window.showQuickPick(items, { placeHolder: "Put the label on…", title: "Create Label" });
    if (!choice) {
      return undefined;
    }

    if (choice.pick === "changeset") {
      return (await pickChangeset(workspace.shell, {
        title: "Create Label",
        workspaceConfig: workspace.workspaceConfig,
      }))?.id;
    }

    if (current < 0) {
      throw new Error("The workspace's current changeset is not known yet. Refresh and try again.");
    }
    return current;
  }

  private chooseLabel(workspace: Workspace, arg: unknown, title: string): Promise<ILabelInfo | undefined> {
    const label = labelFromNode(arg);
    return label
      ? Promise.resolve(label)
      : pickLabel(workspace.shell, { title, workspaceConfig: workspace.workspaceConfig });
  }

  private async rename(args: unknown[]): Promise<void> {
    const workspace = await resolveWorkspace(this.mPlasticScm, args, "Which workspace has the label to rename?");
    if (!workspace) {
      return;
    }

    await guarded(this.mPlasticScm, "Rename Label", async () => {
      const label = await this.chooseLabel(workspace, args[0], "Rename Label");
      if (!label) {
        return;
      }

      const newName = await window.showInputBox({
        ignoreFocusOut: true,
        prompt: `New name for label ${label.name}`,
        title: "Rename Label",
        validateInput: text => labelNameProblem(text),
        value: label.name,
      });
      if (newName === undefined || newName === label.name) {
        return;
      }

      // The workspace's location changes when its own label is renamed, so status is refreshed.
      const outcome = await runWorkspaceOperation(
        this.mPlasticScm,
        workspace,
        { name: "Rename Label", operation: WorkspaceOperation.Reference, title: `Renaming label ${label.name}` },
        () => RenameLabel.run(workspace.shell, label.name, newName));
      if (outcome.status === "succeeded") {
        this.mOnRepositoryChanged();
      }
    });
  }

  private async delete(args: unknown[]): Promise<void> {
    const workspace = await resolveWorkspace(this.mPlasticScm, args, "Which workspace has the label to delete?");
    if (!workspace) {
      return;
    }

    await guarded(this.mPlasticScm, "Delete Label", async () => {
      const label = await this.chooseLabel(workspace, args[0], "Delete Label");
      if (!label) {
        return;
      }

      if (isCurrentLabel(label, workspace.workspaceConfig)) {
        void window.showErrorMessage(
          `'${workspace.info.name}' is on label ${label.name}. Switch to a branch before deleting it.`);
        return;
      }

      const remove = "Delete";
      const answer = await window.showWarningMessage(
        `Delete label ${label.name}?`,
        {
          detail: `The label is on cs:${label.changesetId}. Deleting it removes the label only, not the ` +
            "changeset, and cannot be undone.",
          modal: true,
        },
        remove);
      if (answer !== remove) {
        return;
      }

      const outcome = await runWorkspaceOperation(
        this.mPlasticScm,
        workspace,
        {
          name: "Delete Label",
          operation: WorkspaceOperation.Reference,
          refreshStatus: false,
          title: `Deleting label ${label.name}`,
        },
        () => DeleteLabel.run(workspace.shell, label.name));
      if (outcome.status === "succeeded") {
        this.mOnRepositoryChanged();
        window.setStatusBarMessage(`Deleted label ${label.name}`, 5000);
      }
    });
  }
}
