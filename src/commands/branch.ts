import { branchFromNode, explorerChangesetFromArg, guarded, labelFromNode, resolveWorkspace } from "./targets";
import {
  branchNameProblem,
  branchParentName,
  branchShortName,
  childBranchName,
} from "../cm/commands/refNames";
import { commands, Disposable, QuickPickItem, window } from "vscode";
import { confirmPendingChanges, runPendingChangesFollowUp } from "./pendingChanges";
import {
  CreateBranch,
  DeleteBranch,
  EditBranchComment,
  FindChangesets,
  RenameBranch,
} from "../cm/commands";
import { IBranchInfo, IHistoryChangeset, ILabelInfo } from "../models";
import { pickBranch, pickChangeset, pickLabel } from "../repository/pickers";
import { runWorkspaceOperation, WorkspaceOperation } from "../workspaceOperations";
import { ICmShell } from "../cm/shell";
import { isCurrentBranch } from "../repository/presentation";
import { PlasticScm } from "../plasticScm";
import { switchWorkspace } from "./workspaceActions";
import { Workspace } from "../workspace";

export const BRANCH_COMMANDS = {
  create: "plastic-scm.branch.create",
  createAndSwitch: "plastic-scm.branch.createAndSwitch",
  delete: "plastic-scm.branch.delete",
  editComment: "plastic-scm.branch.editComment",
  rename: "plastic-scm.branch.rename",
};

/** Where a new branch starts. */
export type BranchStart =
  | { readonly kind: "current" }
  | { readonly kind: "branch"; readonly branch: IBranchInfo }
  | { readonly kind: "changeset"; readonly changeset: IHistoryChangeset }
  | { readonly kind: "label"; readonly label: ILabelInfo };

/** The parent branch and the cm start point a {@link BranchStart} comes to. */
export interface IResolvedStart {
  /** Full name of the branch the new branch is a child of. */
  readonly parent: string;
  readonly fromChangeset?: number;
  readonly fromLabel?: string;
  /** For the name prompt, e.g. `cs:42`. */
  readonly description: string;
}

async function branchOfChangeset(shell: ICmShell, changesetId: number): Promise<string> {
  const changeset = await FindChangesets.runById(shell, changesetId, { ignoreHidden: true });
  if (!changeset) {
    throw new Error(`Changeset cs:${changesetId} was not found.`);
  }
  return changeset.branch;
}

/**
 * A branch is created under the branch its start changeset is on (cm takes the
 * parent from the new name and rejects a start changeset that is not on it),
 * so the parent of a changeset or label start is looked up.
 */
export async function resolveBranchStart(
    shell: ICmShell, workspace: Pick<Workspace, "currentChangeset">, start: BranchStart): Promise<IResolvedStart> {
  switch (start.kind) {
  case "branch":
    return { description: `the latest changeset of ${start.branch.name}`, parent: start.branch.name };
  case "changeset":
    return {
      description: `cs:${start.changeset.id}`,
      fromChangeset: start.changeset.id,
      parent: start.changeset.branch,
    };
  case "label":
    return {
      description: `label ${start.label.name}`,
      fromLabel: start.label.name,
      parent: await branchOfChangeset(shell, start.label.changesetId),
    };
  case "current": {
    const id = workspace.currentChangeset;
    if (id < 0) {
      throw new Error("The workspace's current changeset is not known yet. Refresh and try again.");
    }
    return { description: `cs:${id}`, fromChangeset: id, parent: await branchOfChangeset(shell, id) };
  }
  }
}

interface IStartItem extends QuickPickItem {
  pick: "current" | "changeset" | "label" | "branch";
}

/** Branch commands: create (and switch), rename, delete, edit comment. */
export class BranchCommands implements Disposable {
  private readonly mPlasticScm: PlasticScm;
  private readonly mOnRepositoryChanged: () => void;
  private readonly mDisposables: Disposable[];

  /** @param onRepositoryChanged Called after branches changed, so the Repository view reloads. */
  public constructor(plasticScm: PlasticScm, onRepositoryChanged: () => void) {
    this.mPlasticScm = plasticScm;
    this.mOnRepositoryChanged = onRepositoryChanged;
    this.mDisposables = [
      commands.registerCommand(BRANCH_COMMANDS.create, (...args: unknown[]) => this.create(args, false)),
      commands.registerCommand(BRANCH_COMMANDS.createAndSwitch, (...args: unknown[]) => this.create(args, true)),
      commands.registerCommand(BRANCH_COMMANDS.rename, (...args: unknown[]) => this.rename(args)),
      commands.registerCommand(BRANCH_COMMANDS.delete, (...args: unknown[]) => this.delete(args)),
      commands.registerCommand(BRANCH_COMMANDS.editComment, (...args: unknown[]) => this.editComment(args)),
    ];
  }

  public dispose(): void {
    Disposable.from(...this.mDisposables).dispose();
    this.mDisposables.length = 0;
  }

  private async create(args: unknown[], andSwitch: boolean): Promise<void> {
    const title = andSwitch ? "Create Branch and Switch" : "Create Branch";
    const workspace = await resolveWorkspace(this.mPlasticScm, args, "Which workspace should get the new branch?");
    if (!workspace) {
      return;
    }

    await guarded(this.mPlasticScm, title, async () => {
      const start = await this.chooseStart(workspace, args[0], title);
      if (!start) {
        return;
      }
      const resolved = await resolveBranchStart(workspace.shell, workspace, start);

      const shortName = await window.showInputBox({
        ignoreFocusOut: true,
        prompt: `New branch under ${resolved.parent}, starting at ${resolved.description}`,
        title,
        validateInput: text => branchNameProblem(text),
      });
      if (shortName === undefined) {
        return;
      }

      const comment = await window.showInputBox({
        ignoreFocusOut: true,
        prompt: "Comment for the new branch (optional). Enter to continue without one.",
        title,
      });
      if (comment === undefined) {
        return;
      }

      const name = childBranchName(resolved.parent, shortName);
      // Asked before anything is created, so cancelling leaves no branch behind.
      if (andSwitch && !await confirmPendingChanges(workspace, { kind: "switch", target: `the new branch ${name}` })) {
        return;
      }

      const outcome = await runWorkspaceOperation(
        this.mPlasticScm,
        workspace,
        {
          name: "Create Branch",
          operation: WorkspaceOperation.Reference,
          refreshStatus: false,
          title: `Creating branch ${name}`,
        },
        () => CreateBranch.run(workspace.shell, this.mPlasticScm.channel, {
          comment,
          fromChangeset: resolved.fromChangeset,
          fromLabel: resolved.fromLabel,
          name,
        }));
      if (outcome.status !== "succeeded") {
        // "Shelve changes and continue" already shelved and undid the changes; say where they are.
        if (andSwitch) {
          await runPendingChangesFollowUp(workspace, false);
        }
        return;
      }

      this.mOnRepositoryChanged();
      if (andSwitch) {
        await switchWorkspace(this.mPlasticScm, workspace, { kind: "branch", name }, { pendingChangesConfirmed: true });
      } else {
        window.setStatusBarMessage(`Created branch ${name}`, 5000);
      }
    });
  }

  /** A row gives the start; otherwise the user chooses among the current changeset, a changeset, a label, a branch. */
  private async chooseStart(workspace: Workspace, arg: unknown, title: string): Promise<BranchStart | undefined> {
    const branch = branchFromNode(arg);
    if (branch) {
      return { branch, kind: "branch" };
    }
    const label = labelFromNode(arg);
    if (label) {
      return { kind: "label", label };
    }
    const explorerRow = explorerChangesetFromArg(arg);
    if (explorerRow) {
      const changeset = await FindChangesets.runById(workspace.shell, explorerRow.changesetId);
      if (!changeset) {
        throw new Error(`cs:${explorerRow.changesetId} was not found.`);
      }
      return { changeset, kind: "changeset" };
    }

    const current = workspace.currentChangeset;
    const items: IStartItem[] = [
      {
        description: current >= 0 ? `cs:${current}` : undefined,
        label: "$(git-commit) The current changeset",
        pick: "current",
      },
      { label: "$(history) A changeset…", pick: "changeset" },
      { label: "$(tag) A label…", pick: "label" },
      { label: "$(git-branch) The latest changeset of a branch…", pick: "branch" },
    ];
    const choice = await window.showQuickPick(items, { placeHolder: "Start the new branch from…", title });
    if (!choice) {
      return undefined;
    }

    const options = { title, workspaceConfig: workspace.workspaceConfig };
    switch (choice.pick) {
    case "current":
      return { kind: "current" };
    case "changeset": {
      const changeset = await pickChangeset(workspace.shell, options);
      return changeset && { changeset, kind: "changeset" };
    }
    case "label": {
      const picked = await pickLabel(workspace.shell, options);
      return picked && { kind: "label", label: picked };
    }
    case "branch": {
      const picked = await pickBranch(workspace.shell, options);
      return picked && { branch: picked, kind: "branch" };
    }
    }
  }

  private async chooseBranch(workspace: Workspace, arg: unknown, title: string): Promise<IBranchInfo | undefined> {
    return branchFromNode(arg) ?? pickBranch(workspace.shell, { title, workspaceConfig: workspace.workspaceConfig });
  }

  private async rename(args: unknown[]): Promise<void> {
    const workspace = await resolveWorkspace(this.mPlasticScm, args, "Which workspace has the branch to rename?");
    if (!workspace) {
      return;
    }

    await guarded(this.mPlasticScm, "Rename Branch", async () => {
      const branch = await this.chooseBranch(workspace, args[0], "Rename Branch");
      if (!branch) {
        return;
      }

      const shortName = branchShortName(branch.name);
      const newName = await window.showInputBox({
        ignoreFocusOut: true,
        prompt: `New name for ${branch.name}. It stays under ${branchParentName(branch.name) ?? "the top level"}.`,
        title: "Rename Branch",
        validateInput: text => branchNameProblem(text),
        value: shortName,
      });
      if (newName === undefined || newName === shortName) {
        return;
      }

      // The workspace's location changes when its own branch is renamed, so status is refreshed.
      const outcome = await runWorkspaceOperation(
        this.mPlasticScm,
        workspace,
        { name: "Rename Branch", operation: WorkspaceOperation.Reference, title: `Renaming ${branch.name}` },
        () => RenameBranch.run(workspace.shell, branch.name, newName));
      if (outcome.status === "succeeded") {
        this.mOnRepositoryChanged();
      }
    });
  }

  private async delete(args: unknown[]): Promise<void> {
    const workspace = await resolveWorkspace(this.mPlasticScm, args, "Which workspace has the branch to delete?");
    if (!workspace) {
      return;
    }

    await guarded(this.mPlasticScm, "Delete Branch", async () => {
      const branch = await this.chooseBranch(workspace, args[0], "Delete Branch");
      if (!branch) {
        return;
      }

      if (isCurrentBranch(branch, workspace.workspaceConfig)) {
        void window.showErrorMessage(
          `'${workspace.info.name}' is on ${branch.name}. Switch to another branch before deleting it.`);
        return;
      }

      const remove = "Delete";
      const answer = await window.showWarningMessage(
        `Delete branch ${branch.name}?`,
        {
          detail: "A deleted branch cannot be brought back. cm's help describes deleting a branch that has " +
            "changesets as needing --delete-changesets, which this command never passes, so cm is expected " +
            "to refuse a branch that is not empty.",
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
          name: "Delete Branch",
          operation: WorkspaceOperation.Reference,
          refreshStatus: false,
          title: `Deleting ${branch.name}`,
        },
        () => DeleteBranch.run(workspace.shell, branch.name));
      if (outcome.status === "succeeded") {
        this.mOnRepositoryChanged();
        window.setStatusBarMessage(`Deleted branch ${branch.name}`, 5000);
      }
    });
  }

  private async editComment(args: unknown[]): Promise<void> {
    const workspace = await resolveWorkspace(this.mPlasticScm, args, "Which workspace has the branch to edit?");
    if (!workspace) {
      return;
    }

    await guarded(this.mPlasticScm, "Edit Branch Comment", async () => {
      const branch = await this.chooseBranch(workspace, args[0], "Edit Branch Comment");
      if (!branch) {
        return;
      }

      const lines = branch.comment.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
      if (lines.length > 1) {
        const edit = "Replace with One Line";
        const answer = await window.showWarningMessage(
          `The comment of ${branch.name} has ${lines.length} lines.`,
          {
            detail: "The input box edits one line, so saving replaces the whole comment with that line.",
            modal: true,
          },
          edit);
        if (answer !== edit) {
          return;
        }
      }

      const comment = await window.showInputBox({
        ignoreFocusOut: true,
        prompt: `Comment for ${branch.name}. Leave it empty to clear the comment.`,
        title: "Edit Branch Comment",
        value: lines[0] ?? "",
      });
      if (comment === undefined) {
        return;
      }

      const outcome = await runWorkspaceOperation(
        this.mPlasticScm,
        workspace,
        {
          name: "Edit Branch Comment",
          operation: WorkspaceOperation.Reference,
          refreshStatus: false,
          title: `Saving the comment of ${branch.name}`,
        },
        () => EditBranchComment.run(workspace.shell, this.mPlasticScm.channel, branch.name, comment));
      if (outcome.status === "succeeded") {
        this.mOnRepositoryChanged();
      }
    });
  }
}
