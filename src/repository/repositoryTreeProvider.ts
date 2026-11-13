import {
  Disposable,
  Event,
  EventEmitter,
  ThemeIcon,
  TreeDataProvider,
  TreeItem,
  TreeItemCollapsibleState,
} from "vscode";
import { IListPage, IListQuery, IWorkspaceConfig, IWorkspaceInfo } from "../models";
import { describeError } from "../commands/scmUtils";
import { ICmShell } from "../cm/shell";
import { LockSnapshot } from "../locks/lockSnapshot";

export const repositoryViewId = "plastic-scm.repository";

/** Commands the view's rows and title bar run; `RepositoryCommands` registers them. */
export const REPOSITORY_COMMANDS = {
  /** Row command of a Load More row; receives the {@link IRepositoryLoadMoreNode}. */
  loadMore: "plastic-scm.repository.loadMore",
  /** View title button: forgets every loaded section and reloads what is expanded. */
  refresh: "plastic-scm.repository.refresh",
  /** Row command of an error row; receives the {@link IRepositoryErrorNode}. */
  retry: "plastic-scm.repository.retry",
};

/**
 * Every `contextValue` the view sets, for `view/item/context` menus
 * (`view == plastic-scm.repository && viewItem == branch`, or a regex such as
 * `viewItem =~ /^branch(\.current)?$/` for "any branch"). A `.current` suffix
 * marks the object the workspace is switched to. Values never change meaning.
 */
export const REPOSITORY_CONTEXT = {
  branch: "branch",
  currentBranch: "branch.current",
  currentLabel: "label.current",
  currentShelve: "shelve.current",
  error: "error",
  label: "label",
  loadMore: "loadMore",
  /** A group row of the Locks section ("Mine" or "Others"). */
  lockGroup: "locks.group",
  /** A lock row under a group: held by the current user, or by somebody else. */
  lockMine: "lock.mine",
  lockOthers: "lock.others",
  message: "message",
  /** `section.<id>`: `section.branches`, `section.labels`, `section.shelves`. */
  section: (sectionId: string): string => `section.${sectionId}`,
  shelve: "shelve",
  /** A file listed under a shelve row; the section's `childToTreeItem` sets it. */
  shelveFile: "shelve.file",
  workspace: "workspace",
};

/** What the view needs of a workspace; `Workspace` satisfies it. */
export interface IRepositoryWorkspace {
  readonly info: IWorkspaceInfo;
  readonly shell: ICmShell;
  /** The workspace's current location, from its last status run. */
  readonly workspaceConfig?: IWorkspaceConfig;
  /** Fires after every status run; the view re-marks the current branch/label/shelve then. */
  readonly onDidRunStatus: Event<void>;
  /** The workspace's lock list; the Locks section reloads it. Without it the section queries cm itself. */
  readonly locks?: { refresh(): Promise<LockSnapshot> };
}

/**
 * One top-level section of the view. A new section is one more object in the
 * list given to {@link RepositoryTreeProvider}; nothing else changes.
 */
export interface IRepositorySection<T> {
  /** Stable id; part of node ids and of the section's contextValue (`section.<id>`). */
  readonly id: string;
  readonly label: string;
  /** Codicon id of the section row, e.g. `git-branch`. */
  readonly icon: string;
  readonly tooltip?: string;
  /** Rows per page; the section shows a Load More row while cm has more. */
  readonly pageSize: number;
  /** Shown as the only row when the section loads empty, e.g. "No labels". */
  readonly emptyMessage: string;
  /** Loads one page, newest first. Rejections are shown as an error row with Retry. */
  load(workspace: IRepositoryWorkspace, query: IListQuery): Promise<IListPage<T>>;
  /** Identity of an item within the section, for node ids and to drop duplicates across pages. */
  key(item: T): string;
  /** The row for an item. The provider sets `id` and the collapsible state; the section sets the rest. */
  toTreeItem(item: T, workspace: IRepositoryWorkspace): TreeItem;
  /**
   * Makes the rows of this section expandable. Loads what is shown under one
   * row (e.g. the files of a shelve) when it is expanded; a rejection shows an
   * error row and expanding the row again after a refresh retries.
   */
  loadChildren?(item: T, workspace: IRepositoryWorkspace): Promise<unknown[]>;
  /** Identity of a child within its row. Required with {@link loadChildren}. */
  childKey?(child: unknown): string;
  /**
   * The row for a child. A `command` without `arguments` gets the child node as
   * its argument, so a click can act on it.
   */
  childToTreeItem?(child: unknown, item: T, workspace: IRepositoryWorkspace): TreeItem;
}

/** Shown only when several Plastic workspaces are open: one per workspace. */
export interface IRepositoryWorkspaceNode {
  readonly kind: "workspace";
  readonly id: string;
  readonly workspace: IRepositoryWorkspace;
}

export interface IRepositorySectionNode {
  readonly kind: "section";
  readonly id: string;
  readonly workspace: IRepositoryWorkspace;
  readonly section: IRepositorySection<unknown>;
  readonly parent?: IRepositoryWorkspaceNode;
}

/**
 * A branch, label or shelve row. What `item` holds follows the contextValue:
 * `IBranchInfo` for `branch*`, `ILabelInfo` for `label*`, `IShelveInfo` for `shelve*`.
 * Commands contributed to these rows receive this node as their first argument.
 */
export interface IRepositoryItemNode<T = unknown> {
  readonly kind: "item";
  readonly id: string;
  readonly workspace: IRepositoryWorkspace;
  readonly item: T;
  readonly parent: IRepositorySectionNode;
}

/** One row under an item row, e.g. a file of a shelve; `child` is whatever the section's `loadChildren` returned. */
export interface IRepositoryChildNode {
  readonly kind: "child";
  readonly id: string;
  readonly workspace: IRepositoryWorkspace;
  readonly child: unknown;
  readonly parent: IRepositoryItemNode;
}

export interface IRepositoryLoadMoreNode {
  readonly kind: "loadMore";
  readonly id: string;
  readonly parent: IRepositorySectionNode;
}

export interface IRepositoryMessageNode {
  readonly kind: "message";
  readonly id: string;
  readonly label: string;
  readonly loading: boolean;
  readonly parent: IRepositorySectionNode | IRepositoryItemNode;
}

export interface IRepositoryErrorNode {
  readonly kind: "error";
  readonly id: string;
  readonly message: string;
  readonly parent: IRepositorySectionNode;
}

export type RepositoryNode =
  | IRepositoryWorkspaceNode
  | IRepositorySectionNode
  | IRepositoryItemNode
  | IRepositoryChildNode
  | IRepositoryLoadMoreNode
  | IRepositoryMessageNode
  | IRepositoryErrorNode;

interface IChildrenState {
  children: unknown[];
  loading: boolean;
  error?: string;
}

interface ISectionState {
  items: unknown[];
  keys: Set<string>;
  hasMore: boolean;
  loading: boolean;
  error?: string;
}

/**
 * The Repository view: per workspace, one section per {@link IRepositorySection}.
 * A section queries nothing until it is expanded, then loads one page at a time.
 */
export class RepositoryTreeProvider implements TreeDataProvider<RepositoryNode>, Disposable {
  public readonly onDidChangeTreeData: Event<RepositoryNode | undefined>;

  private readonly mChanged = new EventEmitter<RepositoryNode | undefined>();
  private readonly mStates = new Map<string, ISectionState>();
  private readonly mChildStates = new Map<string, IChildrenState>();
  private readonly mNodes = new Map<string, IRepositoryWorkspaceNode | IRepositorySectionNode>();
  private readonly mLocations = new Map<string, string>();
  private readonly mSubscriptions: Disposable[] = [];

  public constructor(
      private readonly mWorkspaces: () => IRepositoryWorkspace[],
      private readonly mSections: ReadonlyArray<IRepositorySection<unknown>>) {
    this.onDidChangeTreeData = this.mChanged.event;
    for (const workspace of mWorkspaces()) {
      this.mLocations.set(workspace.info.id, locationOf(workspace));
      this.mSubscriptions.push(workspace.onDidRunStatus(() => this.onStatus(workspace)));
    }
  }

  public dispose(): void {
    this.mSubscriptions.forEach(subscription => {
      subscription.dispose();
    });
    this.mChanged.dispose();
    this.mStates.clear();
    this.mChildStates.clear();
    this.mNodes.clear();
  }

  public getChildren(node?: RepositoryNode): RepositoryNode[] {
    if (!node) {
      const workspaces = this.mWorkspaces();
      return workspaces.length === 1
        ? this.sectionNodes(workspaces[0])
        : workspaces.map(workspace => this.workspaceNode(workspace));
    }

    switch (node.kind) {
    case "workspace":
      return this.sectionNodes(node.workspace, node);
    case "section":
      return this.sectionChildren(node);
    case "item":
      return this.itemChildren(node);
    default:
      return [];
    }
  }

  public getParent(node: RepositoryNode): RepositoryNode | undefined {
    return node.kind === "workspace" ? undefined : node.parent;
  }

  public getTreeItem(node: RepositoryNode): TreeItem {
    switch (node.kind) {
    case "workspace": {
      const item = new TreeItem(node.workspace.info.name, TreeItemCollapsibleState.Expanded);
      item.id = node.id;
      item.description = node.workspace.workspaceConfig?.repSpec;
      item.tooltip = node.workspace.info.path;
      item.iconPath = new ThemeIcon("repo");
      item.contextValue = REPOSITORY_CONTEXT.workspace;
      return item;
    }
    case "section": {
      const item = new TreeItem(node.section.label, TreeItemCollapsibleState.Collapsed);
      item.id = node.id;
      item.tooltip = node.section.tooltip;
      item.iconPath = new ThemeIcon(node.section.icon);
      item.contextValue = REPOSITORY_CONTEXT.section(node.section.id);
      return item;
    }
    case "item": {
      const item = node.parent.section.toTreeItem(node.item, node.workspace);
      item.id = node.id;
      item.collapsibleState = node.parent.section.loadChildren
        ? TreeItemCollapsibleState.Collapsed
        : TreeItemCollapsibleState.None;
      return item;
    }
    case "child": {
      const section = node.parent.parent.section;
      const item = section.childToTreeItem
        ? section.childToTreeItem(node.child, node.parent.item, node.workspace)
        : new TreeItem("");
      item.id = node.id;
      item.collapsibleState = TreeItemCollapsibleState.None;
      if (item.command && item.command.arguments === undefined) {
        item.command = { ...item.command, arguments: [node] };
      }
      return item;
    }
    case "loadMore": {
      const state = this.mStates.get(node.parent.id);
      const loading = state?.loading ?? false;
      const item = new TreeItem(loading ? "Loading more…" : "Load More", TreeItemCollapsibleState.None);
      item.id = node.id;
      item.iconPath = new ThemeIcon(loading ? "loading~spin" : "more");
      item.tooltip = `Load the next ${node.parent.section.pageSize} rows.`;
      item.contextValue = REPOSITORY_CONTEXT.loadMore;
      if (!loading) {
        item.command = { arguments: [node], command: REPOSITORY_COMMANDS.loadMore, title: "Load More" };
      }
      return item;
    }
    case "message": {
      const item = new TreeItem(node.label, TreeItemCollapsibleState.None);
      item.id = node.id;
      item.iconPath = node.loading ? new ThemeIcon("loading~spin") : undefined;
      item.contextValue = REPOSITORY_CONTEXT.message;
      return item;
    }
    case "error": {
      const item = new TreeItem(`Couldn't load: ${node.message}`, TreeItemCollapsibleState.None);
      item.id = node.id;
      item.tooltip = `${node.message}\n\nClick to retry.`;
      item.iconPath = new ThemeIcon("error");
      item.contextValue = REPOSITORY_CONTEXT.error;
      item.command = { arguments: [node], command: REPOSITORY_COMMANDS.retry, title: "Retry" };
      return item;
    }
    }
  }

  /** Forgets every loaded section; expanded ones reload when the view asks for them again. */
  public refresh(): void {
    this.mStates.clear();
    this.mChildStates.clear();
    this.mChanged.fire(undefined);
  }

  /** Loads the next page of the Load More row's section. */
  public async loadMore(node: IRepositoryLoadMoreNode): Promise<void> {
    const state = this.mStates.get(node.parent.id);
    if (!state || state.loading || !state.hasMore) {
      return;
    }
    await this.loadPage(node.parent, state);
  }

  /** Retries the page that failed: the first one, or the next one after the rows already shown. */
  public async retry(node: IRepositoryErrorNode): Promise<void> {
    let state = this.mStates.get(node.parent.id);
    if (state?.loading) {
      return;
    }
    if (!state) {
      state = this.newState();
      this.mStates.set(node.parent.id, state);
    }
    await this.loadPage(node.parent, state);
  }

  private onStatus(workspace: IRepositoryWorkspace): void {
    const location = locationOf(workspace);
    if (this.mLocations.get(workspace.info.id) === location) {
      return;
    }
    this.mLocations.set(workspace.info.id, location);
    // Only the current-row markers change; loaded pages stay.
    this.mChanged.fire(undefined);
  }

  private workspaceNode(workspace: IRepositoryWorkspace): IRepositoryWorkspaceNode {
    const id = `workspace:${workspace.info.id}`;
    let node = this.mNodes.get(id) as IRepositoryWorkspaceNode | undefined;
    if (!node) {
      node = { id, kind: "workspace", workspace };
      this.mNodes.set(id, node);
    }
    return node;
  }

  private sectionNodes(workspace: IRepositoryWorkspace, parent?: IRepositoryWorkspaceNode): IRepositorySectionNode[] {
    return this.mSections.map(section => {
      const id = `section:${workspace.info.id}/${section.id}`;
      let node = this.mNodes.get(id) as IRepositorySectionNode | undefined;
      if (!node) {
        node = { id, kind: "section", parent, section, workspace };
        this.mNodes.set(id, node);
      }
      return node;
    });
  }

  private sectionChildren(node: IRepositorySectionNode): RepositoryNode[] {
    let state = this.mStates.get(node.id);
    if (!state) {
      state = this.newState();
      this.mStates.set(node.id, state);
      void this.loadPage(node, state);
    }

    if (state.items.length === 0) {
      if (state.loading) {
        return [{ id: `${node.id}/loading`, kind: "message", label: "Loading…", loading: true, parent: node }];
      }
      if (state.error !== undefined) {
        return [{ id: `${node.id}/error`, kind: "error", message: state.error, parent: node }];
      }
      return [{
        id: `${node.id}/empty`, kind: "message", label: node.section.emptyMessage, loading: false, parent: node,
      }];
    }

    const rows: RepositoryNode[] = state.items.map(item => ({
      id: `${node.id}/item:${node.section.key(item)}`,
      item,
      kind: "item",
      parent: node,
      workspace: node.workspace,
    }));
    if (state.error !== undefined) {
      rows.push({ id: `${node.id}/error`, kind: "error", message: state.error, parent: node });
    } else if (state.hasMore) {
      rows.push({ id: `${node.id}/loadMore`, kind: "loadMore", parent: node });
    }
    return rows;
  }

  private itemChildren(node: IRepositoryItemNode): RepositoryNode[] {
    const section = node.parent.section;
    if (!section.loadChildren || !section.childKey) {
      return [];
    }
    const childKey = section.childKey.bind(section);

    let state = this.mChildStates.get(node.id);
    if (!state) {
      state = { children: [], loading: true };
      this.mChildStates.set(node.id, state);
      void this.loadChildren(node, state);
    }

    if (state.loading) {
      return [{ id: `${node.id}/loading`, kind: "message", label: "Loading…", loading: true, parent: node }];
    }
    if (state.error !== undefined) {
      return [{
        id: `${node.id}/error`, kind: "message", label: `Couldn't load: ${state.error}`, loading: false, parent: node,
      }];
    }
    if (state.children.length === 0) {
      return [{ id: `${node.id}/empty`, kind: "message", label: "Nothing to show", loading: false, parent: node }];
    }

    return state.children.map(child => ({
      child,
      id: `${node.id}/child:${childKey(child)}`,
      kind: "child",
      parent: node,
      workspace: node.workspace,
    }));
  }

  private async loadChildren(node: IRepositoryItemNode, state: IChildrenState): Promise<void> {
    try {
      const section = node.parent.section;
      state.children = await section.loadChildren!(node.item, node.workspace);
    } catch (e) {
      state.error = describeError(e);
    } finally {
      state.loading = false;
    }

    if (this.mChildStates.get(node.id) === state) {
      this.mChanged.fire(node);
    }
  }

  private newState(): ISectionState {
    return { hasMore: false, items: [], keys: new Set<string>(), loading: false };
  }

  private async loadPage(node: IRepositorySectionNode, state: ISectionState): Promise<void> {
    state.loading = true;
    state.error = undefined;
    if (state.items.length > 0) {
      // Turns the Load More row into its loading form.
      this.mChanged.fire(node);
    }

    try {
      const page = await node.section.load(
        node.workspace, { limit: node.section.pageSize, offset: state.items.length });
      for (const item of page.items) {
        const key = node.section.key(item);
        // A row created between two pages shifts the next page by one.
        if (!state.keys.has(key)) {
          state.keys.add(key);
          state.items.push(item);
        }
      }
      state.hasMore = page.hasMore;
    } catch (e) {
      state.error = describeError(e);
    } finally {
      state.loading = false;
    }

    // A refresh while this page loaded replaced the state; its own load reports instead.
    if (this.mStates.get(node.id) === state) {
      this.mChanged.fire(node);
    }
  }
}

function locationOf(workspace: IRepositoryWorkspace): string {
  const config = workspace.workspaceConfig;
  return config ? `${config.configType}:${config.location}` : "";
}
