import { commands, Disposable, TreeView, window } from "vscode";
import {
  IRepositoryErrorNode,
  IRepositoryLoadMoreNode,
  IRepositorySection,
  IRepositoryWorkspace,
  REPOSITORY_COMMANDS,
  RepositoryNode,
  RepositoryTreeProvider,
  repositoryViewId,
} from "../repository/repositoryTreeProvider";

/**
 * Owns the Repository view (branches, labels and shelves of each workspace's
 * repository) and its row and title commands. Read-only: actions on the rows
 * are contributed by other commands through the rows' contextValues.
 */
export class RepositoryCommands implements Disposable {
  public get provider(): RepositoryTreeProvider {
    return this.mProvider;
  }

  private readonly mProvider: RepositoryTreeProvider;
  private readonly mTreeView: TreeView<RepositoryNode>;
  private readonly mDisposables: Disposable[];

  public constructor(
      workspaces: () => IRepositoryWorkspace[],
      sections: ReadonlyArray<IRepositorySection<unknown>>) {
    this.mProvider = new RepositoryTreeProvider(workspaces, sections);
    this.mTreeView = window.createTreeView(repositoryViewId, {
      showCollapseAll: true,
      treeDataProvider: this.mProvider,
    });
    this.mDisposables = [
      this.mTreeView,
      this.mProvider,
      commands.registerCommand(REPOSITORY_COMMANDS.refresh, () => this.mProvider.refresh()),
      commands.registerCommand(
        REPOSITORY_COMMANDS.loadMore, (node: IRepositoryLoadMoreNode) => this.mProvider.loadMore(node)),
      commands.registerCommand(
        REPOSITORY_COMMANDS.retry, (node: IRepositoryErrorNode) => this.mProvider.retry(node)),
    ];
  }

  public dispose(): void {
    this.mDisposables.forEach(disposable => {
      disposable.dispose();
    });
  }
}
