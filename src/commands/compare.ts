import { branchFromNode, guarded, resolveWorkspace } from "./targets";
import { commands, Disposable, ProgressLocation, TreeView, window } from "vscode";
import {
  COMPARISON_ACTIVE_CONTEXT,
  COMPARISON_COMMANDS,
  ComparisonTreeProvider,
  comparisonViewId,
  IComparison,
  IComparisonFileNode,
  isComparisonFileNode,
} from "../comparison/comparisonTree";
import { pickBranch, pickChangeset } from "../repository/pickers";
import { DiffChangeset } from "../cm/commands/diffChangeset/diffChangeset";
import { FindChangesets } from "../cm/commands/findChangesets/findChangesets";
import { openComparisonFileDiff } from "../history/openChangesetFileDiff";
import { PlasticScm } from "../plasticScm";

/** What the compare command builds for two changesets; pure so the labels are tested. */
export function changesetsComparison(workspaceId: string, fromId: number, toId: number): Omit<IComparison, "changes"> {
  return {
    description: `cs:${fromId} ↔ cs:${toId}`,
    labels: { current: `cs:${toId}`, parent: `cs:${fromId}` },
    workspaceId,
  };
}

/** What the command builds for a branch against its parent; pure so the labels are tested. */
export function branchComparison(workspaceId: string, branchName: string): Omit<IComparison, "changes"> {
  return {
    description: `${branchName} against its parent`,
    labels: { current: `br:${branchName}`, parent: "branch base" },
    workspaceId,
  };
}

/** The args of `plastic-scm.compare.showChangeset`, which the annotate hover links to. */
export interface IShowChangesetArgs {
  readonly wkId: string;
  readonly changesetId: number;
}

/** The args of `plastic-scm.compare.between`. */
export interface ICompareBetweenArgs {
  readonly wkId: string;
  readonly fromId: number;
  readonly toId: number;
}

export function isCompareBetweenArgs(arg: unknown): arg is ICompareBetweenArgs {
  if (typeof arg !== "object" || arg === null) {
    return false;
  }
  const candidate = arg as Record<string, unknown>;
  return typeof candidate.wkId === "string"
    && Number.isInteger(candidate.fromId) && Number.isInteger(candidate.toId);
}

/** What a hover link carries through JSON; anything else is ignored. */
export function isShowChangesetArgs(arg: unknown): arg is IShowChangesetArgs {
  if (typeof arg !== "object" || arg === null) {
    return false;
  }
  const candidate = arg as Record<string, unknown>;
  return typeof candidate.wkId === "string" && typeof candidate.changesetId === "number"
    && Number.isInteger(candidate.changesetId);
}

/**
 * Compare Changesets…, Show Branch Changes… and the Comparison view they fill:
 * the files that differ, each opening the same diff editor as the Graph's file list.
 */
export class CompareCommands implements Disposable {
  private readonly mProvider = new ComparisonTreeProvider();
  private readonly mTreeView: TreeView<IComparisonFileNode>;
  private readonly mDisposables: Disposable[];

  public constructor(private readonly mPlasticScm: PlasticScm) {
    this.mTreeView = window.createTreeView(comparisonViewId, { treeDataProvider: this.mProvider });
    this.mDisposables = [
      this.mTreeView,
      this.mProvider,
      commands.registerCommand(COMPARISON_COMMANDS.changesets, (...args: unknown[]) => this.compareChangesets(args)),
      commands.registerCommand(COMPARISON_COMMANDS.branchChanges, (...args: unknown[]) => this.branchChanges(args)),
      commands.registerCommand(COMPARISON_COMMANDS.showChangeset, (arg: unknown) => this.showChangeset(arg)),
      commands.registerCommand(COMPARISON_COMMANDS.between, (arg: unknown) => this.compareBetween(arg)),
      commands.registerCommand(COMPARISON_COMMANDS.clear, () => this.show(undefined)),
      commands.registerCommand(COMPARISON_COMMANDS.openFile, (arg: unknown) => this.openFile(arg)),
    ];
  }

  public dispose(): void {
    this.mDisposables.forEach(disposable => {
      disposable.dispose();
    });
  }

  private async compareChangesets(args: unknown[]): Promise<void> {
    await guarded(this.mPlasticScm, "Compare Changesets", async () => {
      const workspace = await resolveWorkspace(this.mPlasticScm, args, "Select the workspace to compare in");
      if (!workspace) {
        return;
      }

      const from = await pickChangeset(workspace.shell, {
        placeHolder: "The changeset to compare from (the base)",
        title: "Compare Changesets (1 of 2)",
        workspaceConfig: workspace.workspaceConfig,
      });
      if (!from) {
        return;
      }

      const to = await pickChangeset(workspace.shell, {
        placeHolder: `The changeset to compare with cs:${from.id}`,
        title: "Compare Changesets (2 of 2)",
        workspaceConfig: workspace.workspaceConfig,
      });
      if (!to) {
        return;
      }

      if (from.id === to.id) {
        void window.showInformationMessage(`Both are cs:${from.id}; there is nothing to compare.`);
        return;
      }

      const base = changesetsComparison(workspace.info.id, from.id, to.id);
      await this.load(base, () => DiffChangeset.runBetween(workspace.shell, from.id, to.id));
    });
  }

  /** Two changesets named by the caller (the Branch Explorer), the older one as the base. */
  private async compareBetween(arg: unknown): Promise<void> {
    if (!isCompareBetweenArgs(arg)) {
      return;
    }
    const workspace = this.mPlasticScm.workspaces.get(arg.wkId);
    if (!workspace) {
      return;
    }

    await guarded(this.mPlasticScm, "Compare Changesets", async () => {
      if (arg.fromId === arg.toId) {
        void window.showInformationMessage(`Both are cs:${arg.fromId}; there is nothing to compare.`);
        return;
      }
      const fromId = Math.min(arg.fromId, arg.toId);
      const toId = Math.max(arg.fromId, arg.toId);
      await this.load(
        changesetsComparison(workspace.info.id, fromId, toId),
        () => DiffChangeset.runBetween(workspace.shell, fromId, toId));
    });
  }

  private async branchChanges(args: unknown[]): Promise<void> {
    await guarded(this.mPlasticScm, "Show Branch Changes", async () => {
      const workspace = await resolveWorkspace(this.mPlasticScm, args, "Select the workspace to compare in");
      if (!workspace) {
        return;
      }

      const branch = branchFromNode(args[0]) ?? await pickBranch(workspace.shell, {
        placeHolder: "The branch to show the changes of, against its parent",
        title: "Show Branch Changes",
        workspaceConfig: workspace.workspaceConfig,
      });
      if (!branch) {
        return;
      }

      const base = branchComparison(workspace.info.id, branch.name);
      await this.load(base, () => DiffChangeset.runBranch(workspace.shell, branch.name));
    });
  }

  /** The changes of one changeset against its parent; the Annotate hover links here. */
  private async showChangeset(arg: unknown): Promise<void> {
    if (!isShowChangesetArgs(arg)) {
      return;
    }
    const workspace = this.mPlasticScm.workspaces.get(arg.wkId);
    if (!workspace) {
      return;
    }

    await guarded(this.mPlasticScm, "Show Changeset Changes", async () => {
      const changeset = await FindChangesets.runById(workspace.shell, arg.changesetId, { ignoreHidden: false });
      if (!changeset) {
        void window.showInformationMessage(`cs:${arg.changesetId} was not found.`);
        return;
      }

      const base: Omit<IComparison, "changes"> = {
        description: `cs:${changeset.id} against its parent`,
        labels: { current: `cs:${changeset.id}`, parent: `cs:${changeset.parentId}` },
        workspaceId: workspace.info.id,
      };
      await this.load(base, () => DiffChangeset.run(workspace.shell, changeset.id));
    });
  }

  private async load(
      base: Omit<IComparison, "changes">, run: () => ReturnType<typeof DiffChangeset.run>): Promise<void> {
    const changes = await window.withProgress(
      { location: ProgressLocation.Notification, title: `Comparing ${base.description}…` }, run);

    if (changes.length === 0) {
      this.show(undefined);
      void window.showInformationMessage(`No differences: ${base.description}.`);
      return;
    }

    this.show({ ...base, changes });
  }

  private show(comparison: IComparison | undefined): void {
    this.mProvider.set(comparison);
    void commands.executeCommand("setContext", COMPARISON_ACTIVE_CONTEXT, comparison !== undefined);
    if (comparison) {
      this.mTreeView.title = "Comparison";
      this.mTreeView.description = `${comparison.description}, ${comparison.changes.length} files`;
      void commands.executeCommand(`${comparisonViewId}.focus`);
    }
  }

  private async openFile(arg: unknown): Promise<void> {
    if (!isComparisonFileNode(arg)) {
      return;
    }
    await openComparisonFileDiff(arg.comparison.workspaceId, arg.comparison.labels, arg.change);
  }
}
