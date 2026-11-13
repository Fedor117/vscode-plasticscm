import { Event, EventEmitter, TreeDataProvider, TreeItem } from "vscode";
import { IChangesetFileChange } from "../models";
import { IDiffLabels } from "../history/openChangesetFileDiff";
import { shelveFileItem } from "../repository/repositorySections";

export const comparisonViewId = "plastic-scm.comparison";

/** Set while the view has a result to show; the view is declared `when` it is true. */
export const COMPARISON_ACTIVE_CONTEXT = "plastic-scm.comparison.active";

export const COMPARISON_COMMANDS = {
  between: "plastic-scm.compare.between",
  branchChanges: "plastic-scm.compare.branch",
  changesets: "plastic-scm.compare.changesets",
  clear: "plastic-scm.compare.clear",
  openFile: "plastic-scm.compare.openFile",
  showChangeset: "plastic-scm.compare.showChangeset",
};

/** The files that differ between two sides, and what the sides are called. */
export interface IComparison {
  readonly workspaceId: string;
  /** Shown in the view's header, e.g. `cs:10 ↔ cs:25`. */
  readonly description: string;
  readonly labels: IDiffLabels;
  readonly changes: readonly IChangesetFileChange[];
}

export interface IComparisonFileNode {
  readonly kind: "comparisonFile";
  readonly comparison: IComparison;
  readonly change: IChangesetFileChange;
}

export function isComparisonFileNode(arg: unknown): arg is IComparisonFileNode {
  return typeof arg === "object" && arg !== null
    && (arg as { kind?: unknown }).kind === "comparisonFile"
    && typeof (arg as { change?: unknown }).change === "object";
}

/** The rows of a comparison, by path. */
export function toComparisonNodes(comparison: IComparison): IComparisonFileNode[] {
  return [...comparison.changes]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(change => ({ change, comparison, kind: "comparisonFile" }));
}

export class ComparisonTreeProvider implements TreeDataProvider<IComparisonFileNode> {
  private readonly mChanged = new EventEmitter<IComparisonFileNode | undefined>();
  private mNodes: IComparisonFileNode[] = [];

  public get onDidChangeTreeData(): Event<IComparisonFileNode | undefined> {
    return this.mChanged.event;
  }

  public set(comparison: IComparison | undefined): void {
    this.mNodes = comparison ? toComparisonNodes(comparison) : [];
    this.mChanged.fire(undefined);
  }

  public dispose(): void {
    this.mChanged.dispose();
  }

  public getChildren(element?: IComparisonFileNode): IComparisonFileNode[] {
    return element ? [] : this.mNodes;
  }

  public getTreeItem(node: IComparisonFileNode): TreeItem {
    const item = shelveFileItem(node.change);
    item.contextValue = "comparison.file";
    item.command = { arguments: [node], command: COMPARISON_COMMANDS.openFile, title: "Open Changes" };
    return item;
  }
}
