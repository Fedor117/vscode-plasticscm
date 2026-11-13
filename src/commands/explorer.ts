import { commands, Disposable, env, window } from "vscode";
import { explorerChangesetFromArg, guarded, IExplorerChangesetTarget, resolveWorkspace } from "./targets";
import { BranchExplorer } from "../explorer/branchExplorerPanel";
import { FindChangesets } from "../cm/commands";
import { PlasticScm } from "../plasticScm";
import { switchWorkspace } from "./workspaceActions";
import { WkConfigType } from "../models";
import { Workspace } from "../workspace";

export const EXPLORER_COMMANDS = {
  compareWithSelected: "plastic-scm.explorer.compareWithSelected",
  compareWithWorkspace: "plastic-scm.explorer.compareWithWorkspace",
  copyBranch: "plastic-scm.explorer.copyBranch",
  copyChangesetId: "plastic-scm.explorer.copyChangesetId",
  copyComment: "plastic-scm.explorer.copyComment",
  createBranch: "plastic-scm.explorer.createBranch",
  createLabel: "plastic-scm.explorer.createLabel",
  createReview: "plastic-scm.explorer.createReview",
  open: "plastic-scm.explorer.open",
  refresh: "plastic-scm.explorer.refresh",
  switchToBranch: "plastic-scm.explorer.switchToBranch",
  switchToChangeset: "plastic-scm.explorer.switchToChangeset",
};

/**
 * Opens the Branch Explorer and runs the actions of its rows' context menu.
 * Every action hands the row to the command that already does the job from the
 * Repository view or the palette, so the dialogs and checks are the same.
 */
export class ExplorerCommands implements Disposable {
  private readonly mPlasticScm: PlasticScm;
  private readonly mExplorer: BranchExplorer;
  private readonly mDisposables: Disposable[];

  public constructor(plasticScm: PlasticScm, explorer: BranchExplorer) {
    this.mPlasticScm = plasticScm;
    this.mExplorer = explorer;

    const onRow = (id: string, action: (workspace: Workspace, row: IExplorerChangesetTarget) => Promise<void>) =>
      commands.registerCommand(id, (arg: unknown) => this.runOnRow(arg, action));
    const forward = (id: string, target: string) =>
      commands.registerCommand(id, (arg: unknown) => commands.executeCommand(target, arg));

    this.mDisposables = [
      commands.registerCommand(EXPLORER_COMMANDS.open, (...args: unknown[]) => this.open(args)),
      commands.registerCommand(
        EXPLORER_COMMANDS.refresh, () => this.mExplorer.refresh(this.mExplorer.activeWorkspaceId())),
      onRow(EXPLORER_COMMANDS.switchToChangeset, (workspace, row) => this.switchToChangeset(workspace, row)),
      onRow(EXPLORER_COMMANDS.switchToBranch, (workspace, row) => this.switchToBranch(workspace, row)),
      onRow(EXPLORER_COMMANDS.compareWithSelected,
        (workspace, row) => this.compare(workspace, row, row.compareWithId)),
      onRow(EXPLORER_COMMANDS.compareWithWorkspace,
        (workspace, row) => this.compare(workspace, row, workspace.currentChangeset)),
      onRow(EXPLORER_COMMANDS.copyChangesetId,
        (_, row) => this.copy(String(row.changesetId), `cs:${row.changesetId}`)),
      onRow(EXPLORER_COMMANDS.copyBranch, (_, row) => this.copy(row.branch, row.branch)),
      onRow(EXPLORER_COMMANDS.copyComment, (workspace, row) => this.copyComment(workspace, row)),
      // These three take the row as it is: the commands they run know a Branch Explorer row.
      forward(EXPLORER_COMMANDS.createBranch, "plastic-scm.branch.create"),
      forward(EXPLORER_COMMANDS.createLabel, "plastic-scm.label.create"),
      forward(EXPLORER_COMMANDS.createReview, "plastic-scm.codeReview.create"),
    ];
  }

  public dispose(): void {
    Disposable.from(...this.mDisposables).dispose();
    this.mDisposables.length = 0;
  }

  private async open(args: unknown[]): Promise<void> {
    const workspace = await resolveWorkspace(this.mPlasticScm, args, "Open the Branch Explorer of which workspace?");
    if (workspace) {
      this.mExplorer.open(workspace);
    }
  }

  private async runOnRow(
      arg: unknown,
      action: (workspace: Workspace, row: IExplorerChangesetTarget) => Promise<void>): Promise<void> {
    const row = explorerChangesetFromArg(arg);
    const workspace = row && this.mPlasticScm.workspaces.get(row.wkId);
    if (!row || !workspace) {
      return;
    }
    await guarded(this.mPlasticScm, "Branch Explorer", () => action(workspace, row));
  }

  private async switchToChangeset(workspace: Workspace, row: IExplorerChangesetTarget): Promise<void> {
    if (workspace.currentChangeset === row.changesetId
        && workspace.workspaceConfig?.configType === WkConfigType.Changeset) {
      void window.showInformationMessage(`'${workspace.info.name}' is already on cs:${row.changesetId}.`);
      return;
    }
    await switchWorkspace(this.mPlasticScm, workspace, { id: row.changesetId, kind: "changeset" });
  }

  private async switchToBranch(workspace: Workspace, row: IExplorerChangesetTarget): Promise<void> {
    const config = workspace.workspaceConfig;
    if (config?.configType === WkConfigType.Branch && config.location === row.branch) {
      void window.showInformationMessage(`'${workspace.info.name}' is already on ${row.branch}.`);
      return;
    }
    await switchWorkspace(this.mPlasticScm, workspace, { kind: "branch", name: row.branch });
  }

  private async compare(
      workspace: Workspace, row: IExplorerChangesetTarget, otherId: number | undefined): Promise<void> {
    if (otherId === undefined || otherId < 0) {
      void window.showInformationMessage("There is no other changeset to compare with.");
      return;
    }
    await commands.executeCommand(
      "plastic-scm.compare.between", { fromId: otherId, toId: row.changesetId, wkId: workspace.info.id });
  }

  private async copyComment(workspace: Workspace, row: IExplorerChangesetTarget): Promise<void> {
    const changeset = await FindChangesets.runById(workspace.shell, row.changesetId);
    if (!changeset) {
      void window.showInformationMessage(`cs:${row.changesetId} was not found.`);
      return;
    }
    await this.copy(changeset.comment, `the comment of cs:${row.changesetId}`);
  }

  private async copy(text: string, what: string): Promise<void> {
    await env.clipboard.writeText(text);
    window.setStatusBarMessage(`Copied ${what}`, 3000);
  }
}
