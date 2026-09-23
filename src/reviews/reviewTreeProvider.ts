import {
  buildFileNodes,
  fileDescription,
  folderDescription,
  IFileTree,
  IFileTreeFile,
  IFileTreeFolder,
  navigationOrder,
} from "./reviewFileTree";
import {
  changesetTooltip,
  cleanReviewTitle,
  contentKind,
  errorSummary,
  fileTooltip,
  firstLine,
  formatCount,
  relativeAge,
  retryTooltip,
  reviewPeople,
  reviewTooltip,
  shortOwner,
  themeIcon,
  toneUri,
  updateSummary,
} from "./reviewPresentation";
import {
  Disposable,
  Event,
  EventEmitter,
  MarkdownString,
  ThemeIcon,
  TreeCheckboxChangeEvent,
  TreeDataProvider,
  TreeItem,
  TreeItemCheckboxState,
  TreeItemCollapsibleState,
  Uri,
} from "vscode";
import { FileChangeStatus, IChangesetFileChange } from "../models";
import {
  fileKey,
  IReviewChangeset,
  IReviewComparison,
  IReviewDiscussions,
  IReviewFiles,
  IReviewThread,
  repositoryName,
  scopeRows,
} from "./models";
import { FileScope, IActiveReview, IReviewSessionView } from "./sessionTypes";
import { reviewFileUri, reviewScheme } from "./reviewEditors";

export const reviewTreeViewId = "plastic-scm.reviews.active";

/** Commands the rows run; ReviewActions registers them. Each receives the row's node. */
export const REVIEW_TREE_COMMANDS = {
  loadMoreChangesets: "plastic-scm.reviews.loadMoreChangesets",
  loadUpdates: "plastic-scm.reviews.loadUpdates",
  openChanges: "plastic-scm.reviews.openChanges",
  openOverview: "plastic-scm.reviews.openOverview",
  retry: "plastic-scm.reviews.retry",
};

export type ReviewRootKind = "updates" | "overview" | "changes" | "merged" | "changesets";

export interface IReviewRootNode {
  readonly kind: ReviewRootKind;
  readonly id: string;
}

export interface IReviewChangesetNode {
  readonly kind: "changeset";
  readonly id: string;
  readonly changeset: IReviewChangeset;
  readonly parent: IReviewRootNode;
}

export interface IReviewTreeMessageNode {
  readonly kind: "message";
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  /** The label when absent. */
  readonly tooltip?: string;
  readonly icon?: string;
  /** Theme colour id of the icon. */
  readonly color?: string;
  /** Loading rows are drawn in the description colour, icon and label alike. */
  readonly muted?: boolean;
  readonly parent: IReviewRootNode | IReviewChangesetNode;
}

/** The `retry` command calls `retry()`, whichever view the row is in. */
export interface IReviewTreeErrorNode {
  readonly kind: "error";
  readonly id: string;
  readonly label: string;
  readonly message: string;
  readonly retry: () => void;
  readonly parent: IReviewRootNode | IReviewChangesetNode;
}

export interface IReviewLoadMoreChangesetsNode {
  readonly kind: "loadMoreChangesets";
  readonly id: string;
  readonly parent: IReviewRootNode;
}

/** What every file and folder node of one scope shares: enough to open its diffs. */
export interface IReviewFileGroup {
  readonly scope: FileScope;
  readonly comparison: IReviewComparison;
  readonly workspaceId: string;
  readonly reviewId: number;
  /** The Changes or Merged root, or the changeset, the scope hangs from. */
  readonly node: IReviewRootNode | IReviewChangesetNode;
}

export type ReviewFileNode = IFileTreeFile<IReviewFileGroup>;
export type ReviewFolderNode = IFileTreeFolder<IReviewFileGroup>;

export type ReviewTreeNode =
  | IReviewRootNode
  | IReviewChangesetNode
  | IReviewTreeMessageNode
  | IReviewTreeErrorNode
  | IReviewLoadMoreChangesetsNode
  | ReviewFileNode
  | ReviewFolderNode;

interface IScopeTree {
  readonly source: IReviewFiles | IReviewComparison;
  readonly layout: "tree" | "list";
  readonly tree: IFileTree<IReviewFileGroup>;
}

export function scopeKey(scope: FileScope): string {
  return typeof scope === "string" ? scope : `cs:${scope.changesetId}`;
}

/**
 * The Review view: Review updated (while the server has changes), Overview,
 * Changes, Merged from other branches (branch reviews with merged-only files),
 * and Changesets. File nodes are built once per scope, comparison and layout
 * and keep parent pointers for `reveal`; viewed state and discussion counts are
 * read when a row is drawn, so a checkbox toggle never rebuilds the tree.
 */
export class ReviewTreeProvider implements TreeDataProvider<ReviewTreeNode>, Disposable {
  public readonly onDidChangeTreeData: Event<ReviewTreeNode | undefined>;
  private readonly changed = new EventEmitter<ReviewTreeNode | undefined>();
  private readonly subscriptions: Disposable[];
  private readonly trees = new Map<string, IScopeTree>();
  private readonly changesetNodes = new Map<number, IReviewChangesetNode>();
  private identity?: string;
  private roots?: { [kind in ReviewRootKind]: IReviewRootNode };
  private threadIndex?: { discussions: IReviewDiscussions; byPath: Map<string, IReviewThread[]> };
  /** The head's revisions (`repo#revisionId`), for marking changeset rows that show the same revision. */
  private headRevisions?: { files: IReviewFiles; keys: Set<string> };

  public constructor(private readonly session: IReviewSessionView) {
    this.onDidChangeTreeData = this.changed.event;
    this.subscriptions = [
      session.onDidChangeActive(() => this.refresh()),
      session.onDidChangeViewed(() => this.refresh()),
    ];
  }

  public dispose(): void {
    Disposable.from(...this.subscriptions).dispose();
    this.changed.dispose();
    this.reset(undefined);
  }

  /** Redraws everything; the layout setting changing is the one trigger the session does not report. */
  public refresh(): void {
    this.changed.fire(undefined);
  }

  public getChildren(node?: ReviewTreeNode): ReviewTreeNode[] {
    const active = this.session.active;
    if (!active) {
      this.reset(undefined);
      return [];
    }
    const roots = this.rootNodes(active);
    if (!node) {
      return this.rootChildren(active, roots);
    }
    // A row of a review that was closed or replaced since VS Code asked.
    if (!node.id.startsWith(`${this.identity!}/`)) {
      return [];
    }
    switch (node.kind) {
    case "changes":
    case "merged":
      return this.scopeChildren(active, node.kind, node);
    case "changesets":
      return this.changesetChildren(active, node);
    case "changeset":
      return this.changesetFileChildren(node);
    case "folder":
      return node.children;
    default:
      return [];
    }
  }

  public getParent(node: ReviewTreeNode): ReviewTreeNode | undefined {
    switch (node.kind) {
    case "file":
    case "folder":
      return node.parent ?? node.group.node;
    case "changeset":
    case "message":
    case "error":
    case "loadMoreChangesets":
      return node.parent;
    default:
      return undefined;
    }
  }

  public getTreeItem(node: ReviewTreeNode): TreeItem {
    const active = this.session.active;
    switch (node.kind) {
    case "file":
      return this.fileItem(node, active);
    case "folder":
      return this.folderItem(node);
    case "changeset":
      return this.changesetItem(node, active);
    case "message": {
      const item = new TreeItem(node.label, TreeItemCollapsibleState.None);
      item.id = node.id;
      item.description = node.description;
      item.tooltip = node.tooltip ?? node.label;
      item.iconPath = node.icon ? themeIcon({ color: node.color, id: node.icon }) : undefined;
      item.resourceUri = node.muted ? toneUri("muted", node.id) : undefined;
      item.contextValue = "message";
      return item;
    }
    case "error": {
      const item = new TreeItem(node.label, TreeItemCollapsibleState.None);
      item.id = node.id;
      item.description = errorSummary(node.message);
      item.tooltip = retryTooltip(node.message);
      item.iconPath = themeIcon({ color: "list.errorForeground", id: "error" });
      item.resourceUri = toneUri("error", node.id);
      item.contextValue = "error";
      item.command = { arguments: [node], command: REVIEW_TREE_COMMANDS.retry, title: "Retry" };
      return item;
    }
    case "loadMoreChangesets": {
      if (this.session.loadingMoreChangesets) {
        const row = new TreeItem("Loading changesets…", TreeItemCollapsibleState.None);
        row.id = node.id;
        row.tooltip = "Loading the next 50 changesets.";
        row.iconPath = themeIcon(LOADING_ICON);
        row.resourceUri = toneUri("muted", node.id);
        row.contextValue = "message";
        return row;
      }
      const item = new TreeItem("Load More Changesets…", TreeItemCollapsibleState.None);
      item.id = node.id;
      item.description = "next 50";
      item.tooltip = "Load the next 50 changesets.";
      // No icon, but the space for one, so the label lines up with the changesets above it.
      item.iconPath = new ThemeIcon("blank");
      item.resourceUri = toneUri("link", node.id);
      item.contextValue = "loadMore";
      item.command = {
        arguments: [node],
        command: REVIEW_TREE_COMMANDS.loadMoreChangesets,
        title: "Load More Changesets",
      };
      return item;
    }
    default:
      return active ? this.rootItem(node, active) : new TreeItem(node.id);
    }
  }

  /**
   * Applies a checkbox toggle (the view manages checkboxes itself): a file
   * marks its own revision, a folder every file below it.
   */
  public handleCheckboxes(event: TreeCheckboxChangeEvent<ReviewTreeNode>): void {
    const viewed: IChangesetFileChange[] = [];
    const unviewed: IChangesetFileChange[] = [];
    for (const [ node, state ] of event.items) {
      const files = node.kind === "file" ? [node.file] : node.kind === "folder" ? node.files : [];
      (state === TreeItemCheckboxState.Checked ? viewed : unviewed).push(...files);
    }
    if (viewed.length) {
      this.session.setViewed(viewed, true);
    }
    if (unviewed.length) {
      this.session.setViewed(unviewed, false);
    }
    // VS Code has already drawn the toggled box; redraw so folders and progress follow.
    this.refresh();
  }

  /** `Review #12831`, or `Review` with nothing open. */
  public title(): string {
    const active = this.session.active;
    return active ? `Review #${active.review.id}` : "Review";
  }

  /** The status, plus `(hidden)` when the branch is one Plastic hides. */
  public description(): string | undefined {
    const active = this.session.active;
    if (!active) {
      return undefined;
    }
    const hidden = active.files.state === "ready" && active.files.value.branch?.hidden;
    return hidden ? `${active.review.status} (hidden)` : active.review.status || undefined;
  }

  /** The comparison a scope's diffs use; undefined until it is loaded. */
  public comparison(scope: FileScope): IReviewComparison | undefined {
    const active = this.session.active;
    if (!active) {
      return undefined;
    }
    if (typeof scope === "string") {
      return active.files.state === "ready" ? active.files.value.final : undefined;
    }
    const stage = this.session.changesetFiles(scope.changesetId);
    return stage.state === "ready" ? stage.value : undefined;
  }

  /** Every file row of a scope in display order (binaries included, directory records not). */
  public scopeFiles(scope: FileScope): IChangesetFileChange[] | undefined {
    return this.scopeTree(scope)?.tree.files.map(node => node.file);
  }

  /** The previous/next order of a scope: display order without rows that have no text diff. */
  public navigationOrder(scope: FileScope): IChangesetFileChange[] {
    const tree = this.scopeTree(scope)?.tree;
    return tree ? navigationOrder(tree.roots) : [];
  }

  /** The row of a file, for `reveal`; undefined when the scope is not loaded or has no such row. */
  public fileNode(scope: FileScope, file: IChangesetFileChange): ReviewFileNode | undefined {
    return this.scopeTree(scope)?.tree.byKey.get(fileKey(file));
  }

  /** Viewed files among Changes, the count the review's progress shows. */
  public progress(): { viewed: number; total: number } | undefined {
    const files = this.scopeFiles("changes");
    if (!files) {
      return undefined;
    }
    return { total: files.length, viewed: files.filter(file => this.session.isViewed(file)).length };
  }

  private reset(identity: string | undefined): void {
    this.identity = identity;
    this.roots = undefined;
    this.trees.clear();
    this.changesetNodes.clear();
    this.threadIndex = undefined;
    this.headRevisions = undefined;
  }

  private rootNodes(active: IActiveReview): { [kind in ReviewRootKind]: IReviewRootNode } {
    const identity = `active/${active.workspaceId}/${active.review.id}`;
    if (identity !== this.identity || !this.roots) {
      this.reset(identity);
      const root = (kind: ReviewRootKind): IReviewRootNode => ({ id: `${identity}/${kind}`, kind });
      this.roots = {
        changes: root("changes"),
        changesets: root("changesets"),
        merged: root("merged"),
        overview: root("overview"),
        updates: root("updates"),
      };
    }
    return this.roots;
  }

  private rootChildren(active: IActiveReview, roots: { [kind in ReviewRootKind]: IReviewRootNode }): ReviewTreeNode[] {
    const branch = active.review.targetType === "branch";
    const children: ReviewTreeNode[] = [];
    if (active.updates) {
      children.push(roots.updates);
    }
    children.push(roots.overview, roots.changes);
    if (branch && active.files.state === "ready" && active.files.value.mergedKeys.size > 0 &&
        (this.scopeTree("merged")?.tree.roots.length ?? 0) > 0) {
      children.push(roots.merged);
    }
    // A deleted branch has no changesets to list; its discussions still open their original context.
    const deleted = active.files.state === "ready" && active.files.value.branchDeleted;
    if (branch && !deleted) {
      children.push(roots.changesets);
    }
    return children;
  }

  private scopeChildren(active: IActiveReview, scope: "changes" | "merged", node: IReviewRootNode): ReviewTreeNode[] {
    const stage = active.files;
    switch (stage.state) {
    case "error":
      return [this.errorNode(node, "Couldn't load changes", stage.message, () => this.session.retryStage("files"))];
    case "ready": {
      if (stage.value.branchDeleted) {
        return [{
          color: "list.warningForeground",
          description: "discussions open their original context",
          icon: "warning",
          id: `${node.id}/message`,
          kind: "message",
          label: "The branch no longer exists",
          parent: node,
          tooltip: BRANCH_DELETED,
        }];
      }
      const roots = this.scopeTree(scope)?.tree.roots ?? [];
      return roots.length ? roots : [message(node, "No changed files")];
    }
    default:
      return [loading(node, "Loading changes…")];
    }
  }

  private changesetChildren(active: IActiveReview, node: IReviewRootNode): ReviewTreeNode[] {
    const stage = active.changesets;
    switch (stage.state) {
    case "error":
      return [
        this.errorNode(node, "Couldn't load changesets", stage.message, () => this.session.retryStage("changesets")),
      ];
    case "ready": {
      const children: ReviewTreeNode[] = stage.value.items.map(changeset => this.changesetNode(changeset));
      if (stage.value.hasMore) {
        children.push({ id: `${node.id}/more`, kind: "loadMoreChangesets", parent: node });
      }
      return children.length ? children : [message(node, "No changesets")];
    }
    case "idle":
      // The changesets stage runs after the files stage; a failed files stage never starts it.
      return active.files.state === "error"
        ? [message(node, "Changesets load after the changes. Retry the changes first.")]
        : [loading(node, "Loading changesets…")];
    default:
      return [loading(node, "Loading changesets…")];
    }
  }

  private changesetFileChildren(node: IReviewChangesetNode): ReviewTreeNode[] {
    const id = node.changeset.id;
    const stage = this.session.changesetFiles(id);
    switch (stage.state) {
    case "error":
      return [this.errorNode(node, "Couldn't load files", stage.message, () => this.session.retryChangesetFiles(id))];
    case "ready": {
      const roots = this.scopeTree({ changesetId: id })?.tree.roots ?? [];
      return roots.length ? roots : [message(node, "No changed files")];
    }
    default:
      return [loading(node, "Loading files…")];
    }
  }

  private changesetNode(changeset: IReviewChangeset): IReviewChangesetNode {
    const known = this.changesetNodes.get(changeset.id);
    if (known && known.changeset === changeset) {
      return known;
    }
    const parent = this.roots!.changesets;
    const node: IReviewChangesetNode = { changeset, id: `${parent.id}/cs:${changeset.id}`, kind: "changeset", parent };
    this.changesetNodes.set(changeset.id, node);
    return node;
  }

  /**
   * The nodes of one scope, rebuilt only when its comparison or the layout
   * changed. A changeset scope only exists for a changeset the Changesets list
   * shows, and only once its files are loaded.
   */
  private scopeTree(scope: FileScope): IScopeTree | undefined {
    const active = this.session.active;
    if (!active) {
      return undefined;
    }
    const roots = this.rootNodes(active);
    const layout = this.session.fileLayout;
    const key = scopeKey(scope);
    let source: IReviewFiles | IReviewComparison;
    let comparison: IReviewComparison;
    let rows: IChangesetFileChange[];
    let owner: IReviewRootNode | IReviewChangesetNode;
    if (typeof scope === "string") {
      if (active.files.state !== "ready") {
        return undefined;
      }
      const files = active.files.value;
      source = files;
      comparison = files.final;
      owner = roots[scope];
      rows = scopeRows(files, scope);
    } else {
      const changeset = active.changesets.state === "ready"
        ? active.changesets.value.items.find(item => item.id === scope.changesetId)
        : undefined;
      const stage = changeset ? this.session.changesetFiles(changeset.id) : undefined;
      if (!changeset || stage?.state !== "ready") {
        return undefined;
      }
      source = stage.value;
      comparison = stage.value;
      owner = this.changesetNode(changeset);
      rows = comparison.files;
    }
    const cached = this.trees.get(key);
    if (cached && cached.source === source && cached.layout === layout) {
      return cached;
    }
    const group: IReviewFileGroup = {
      comparison,
      node: owner,
      reviewId: active.review.id,
      scope,
      workspaceId: active.workspaceId,
    };
    const entry: IScopeTree = { layout, source, tree: buildFileNodes(rows, layout, `${this.identity!}/${key}`, group) };
    this.trees.set(key, entry);
    return entry;
  }

  private errorNode(
      parent: IReviewRootNode | IReviewChangesetNode,
      label: string,
      text: string,
      retry: () => void): IReviewTreeErrorNode {
    return { id: `${parent.id}/error`, kind: "error", label, message: text, parent, retry };
  }

  private rootItem(node: IReviewRootNode, active: IActiveReview): TreeItem {
    const review = active.review;
    const now = this.session.now();
    const files = active.files.state === "ready" ? active.files.value : undefined;
    let item: TreeItem;
    switch (node.kind) {
    case "updates": {
      item = new TreeItem("Review updated", TreeItemCollapsibleState.None);
      item.iconPath = themeIcon({ color: "charts.blue", id: "sync" });
      item.description = active.updates ? updateSummary(active.updates) : undefined;
      const pinned = files && files.head >= 0 ? `cs:${files.head}` : "what was loaded";
      const counted = active.updates?.newComments ? ` ${NEW_COMMENTS_NOTE}` : "";
      item.tooltip =
        `This review is pinned to ${pinned}. Select to load the latest. Open diffs keep their revisions.${counted}`;
      item.command = { arguments: [node], command: REVIEW_TREE_COMMANDS.loadUpdates, title: "Load Updates" };
      item.contextValue = "updates";
      break;
    }
    case "overview": {
      item = new TreeItem(cleanReviewTitle(review, files?.branch?.name), TreeItemCollapsibleState.None);
      item.iconPath = new ThemeIcon("book");
      item.description = reviewPeople(review, now);
      const tooltip: MarkdownString = reviewTooltip(review, now);
      tooltip.appendMarkdown("\n\nSelect to open the overview.");
      item.tooltip = tooltip;
      item.command = { arguments: [node], command: REVIEW_TREE_COMMANDS.openOverview, title: "Open Overview" };
      item.contextValue = "overview";
      break;
    }
    case "changes": {
      const branch = review.targetType === "branch";
      item = new TreeItem(
        branch ? "Changes" : `Changes in cs:${review.target.replace(/^cs:/, "")}`, TreeItemCollapsibleState.Expanded);
      item.iconPath = new ThemeIcon("git-compare");
      item.contextValue = "changes";
      if (files?.branchDeleted) {
        item.description = "branch deleted";
        item.tooltip = BRANCH_DELETED;
      } else if (files) {
        const progress = this.progress();
        // Both sides, as the diffs compare them: "4/23 viewed · cs:3471 ↔ cs:3715".
        item.description =
          `${formatCount(progress?.viewed ?? 0)}/${formatCount(progress?.total ?? 0)} viewed · ${files.final.label}`;
        item.tooltip = changesTooltip(files, branch);
      }
      break;
    }
    case "merged": {
      item = new TreeItem("Merged from other branches", TreeItemCollapsibleState.Collapsed);
      item.iconPath = new ThemeIcon("git-merge");
      item.contextValue = "merged";
      const count = this.scopeTree("merged")?.tree.files.length ?? 0;
      item.description = `${formatCount(count)} file${count === 1 ? "" : "s"}`;
      if (files) {
        const base = files.base === undefined ? "the branch base" : `the branch base cs:${files.base}`;
        item.tooltip = "Files that changed on this branch only through merges (from /main or child branches). " +
          `Their diffs still compare ${base} with the head cs:${files.head}. ` +
          "Plastic's own review groups these under 'Merged from cs:N'.";
      }
      break;
    }
    default: {
      item = new TreeItem("Changesets", TreeItemCollapsibleState.Collapsed);
      item.contextValue = "changesets";
      const stage = active.changesets;
      if (stage.state === "ready") {
        item.iconPath = new ThemeIcon("git-commit");
        item.description = `${formatCount(stage.value.items.length)}${stage.value.hasMore ? "+" : ""}`;
      } else if (stage.state === "error") {
        item.iconPath = themeIcon({ color: "list.errorForeground", id: "error" });
        item.description = "Couldn't load";
      } else if (stage.state === "loading" || active.files.state !== "error") {
        // Collapsed, so the row itself shows that this stage is still filling in.
        item.iconPath = themeIcon(LOADING_ICON);
        item.description = "Loading…";
      } else {
        item.iconPath = new ThemeIcon("git-commit");
      }
      item.tooltip = files?.branch
        ? `Changesets on ${files.branch.name} up to cs:${files.head}, newest first. Merges are marked.`
        : "Changesets of the reviewed branch, newest first.";
      break;
    }
    }
    item.id = node.id;
    return item;
  }

  private changesetItem(node: IReviewChangesetNode, active: IActiveReview | undefined): TreeItem {
    const changeset = node.changeset;
    const now = this.session.now();
    const item = new TreeItem(firstLine(changeset.comment) || "(no comment)", TreeItemCollapsibleState.Collapsed);
    item.id = node.id;
    const age = relativeAge(changeset.date, now);
    const head = active?.files.state === "ready" && active.files.value.head === changeset.id;
    const parts = [`cs:${changeset.id}`];
    parts.push(changeset.isMerge
      ? `merge from ${changeset.mergeSourceBranch ?? "another branch"}`
      : shortOwner(changeset.owner));
    if (age) {
      parts.push(age);
    }
    if (head) {
      parts.push("head");
    }
    item.description = parts.join(" · ");
    item.iconPath = new ThemeIcon(changeset.isMerge ? "git-merge" : "git-commit");
    item.tooltip = changesetTooltip(changeset, now, head);
    item.contextValue = changeset.isMerge ? "changeset;merge" : "changeset";
    return item;
  }

  private fileItem(node: ReviewFileNode, active: IActiveReview | undefined): TreeItem {
    const file = node.file;
    const group = node.group;
    const threads = active ? this.threadsFor(active, file) : [];
    const viewed = this.session.isViewed(file);
    const sameAsHead = this.sameAsHead(active, node);
    const item = new TreeItem(node.label, TreeItemCollapsibleState.None);
    item.id = node.id;
    // The right side of the row's diff, so the row, its decoration and the diff tab share one URI.
    item.resourceUri = reviewFileUri(group.workspaceId, group.reviewId, group.comparison, file);
    item.iconPath = ThemeIcon.File;
    item.description = fileDescription(file, this.session.fileLayout, threads.length, sameAsHead);
    item.tooltip = fileTooltip(file, threads, sameAsHead);
    item.checkboxState = {
      accessibilityInformation: { label: viewed ? `${node.label} viewed` : `Mark ${node.label} as viewed` },
      state: viewed ? TreeItemCheckboxState.Checked : TreeItemCheckboxState.Unchecked,
      tooltip: viewed ? "Viewed" : "Mark as viewed",
    };
    item.command = { arguments: [node], command: REVIEW_TREE_COMMANDS.openChanges, title: "Open Changes" };
    item.contextValue = `file;${contentKind(file)};${viewed ? "viewed" : "unviewed"}`;
    return item;
  }

  private folderItem(node: ReviewFolderNode): TreeItem {
    const collapsible = !node.children.length ? TreeItemCollapsibleState.None
      : node.expanded ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.Collapsed;
    const item = new TreeItem(node.label, collapsible);
    item.id = node.id;
    item.iconPath = ThemeIcon.Folder;
    item.resourceUri = Uri.from({ path: node.path, query: JSON.stringify({ kind: "folder" }), scheme: reviewScheme });
    item.description = folderDescription(node, this.session.fileLayout) || undefined;
    const viewedCount = node.files.filter(file => this.session.isViewed(file)).length;
    const viewed = node.files.length > 0 && viewedCount === node.files.length;
    if (node.files.length) {
      item.checkboxState = {
        accessibilityInformation: { label: viewed ? `${node.label} viewed` : `Mark ${node.label} as viewed` },
        state: viewed ? TreeItemCheckboxState.Checked : TreeItemCheckboxState.Unchecked,
        tooltip: viewed ? "All files viewed" : "Mark all files in this folder as viewed",
      };
    }
    const files = `${formatCount(node.files.length)} file${node.files.length === 1 ? "" : "s"}`;
    item.tooltip = node.files.length ? `${node.path}\n${files} · ${formatCount(viewedCount)} viewed` : node.path;
    item.contextValue = `folder;${viewed ? "viewed" : "unviewed"}`;
    return item;
  }

  /**
   * A changeset row whose revision is also in the head's comparison: the two
   * rows share one viewed state, and the description says why this one may
   * already be ticked.
   */
  private sameAsHead(active: IActiveReview | undefined, node: ReviewFileNode): boolean {
    const file = node.file;
    if (typeof node.group.scope === "string" || active?.files.state !== "ready" || file.revisionId < 0 ||
      file.status & FileChangeStatus.Deleted) {
      return false;
    }
    const files = active.files.value;
    if (this.headRevisions?.files !== files) {
      const keys = new Set(files.final.files
        .filter(row => row.revisionId >= 0 && !(row.status & FileChangeStatus.Deleted))
        .map(revisionKey));
      this.headRevisions = { files, keys };
    }
    return this.headRevisions.keys.has(revisionKey(file));
  }

  /** Threads on this file's path, or on its path before a move (base-side comments). */
  private threadsFor(active: IActiveReview, file: IChangesetFileChange): IReviewThread[] {
    if (active.discussions.state !== "ready") {
      return [];
    }
    const discussions = active.discussions.value;
    if (this.threadIndex?.discussions !== discussions) {
      const byPath = new Map<string, IReviewThread[]>();
      for (const thread of discussions.threads) {
        const fileThread = thread.kind === "question" || thread.kind === "change" || thread.kind === "comment";
        if (fileThread && thread.path) {
          byPath.set(thread.path, (byPath.get(thread.path) ?? []).concat(thread));
        }
      }
      this.threadIndex = { byPath, discussions };
    }
    const own = this.threadIndex.byPath.get(file.path) ?? [];
    const moved = file.oldPath && file.oldPath !== file.path ? this.threadIndex.byPath.get(file.oldPath) ?? [] : [];
    return moved.length ? own.concat(moved) : own;
  }
}

const BRANCH_DELETED = "The branch no longer exists. Discussions still open their original context.";
const LOADING_ICON = { color: "descriptionForeground", id: "loading~spin" };
/** The update row's count includes more than new comments; its tooltip says what. */
const NEW_COMMENTS_NOTE = "New comments include edited ones and applied change requests.";

function message(
    parent: IReviewRootNode | IReviewChangesetNode,
    label: string,
    icon?: string): IReviewTreeMessageNode {
  return { icon, id: `${parent.id}/message`, kind: "message", label, parent };
}

function loading(parent: IReviewRootNode | IReviewChangesetNode, label: string): IReviewTreeMessageNode {
  return { ...message(parent, label, LOADING_ICON.id), color: LOADING_ICON.color, muted: true };
}

/** Revision ids are unique per repository only; aliases of one repository compare equal (`sameRepository`). */
function revisionKey(file: IChangesetFileChange): string {
  return `${repositoryName(file.repository).toLowerCase()}#${file.revisionId}`;
}

function changesTooltip(files: IReviewFiles, branch: boolean): string {
  const base = files.base === undefined ? undefined : `cs:${files.base}`;
  if (!branch) {
    return `Changes in cs:${files.head} compared with ${base ? `its parent ${base}` : "its parent"}.`;
  }
  const name = files.branch ? `${files.branch.name}${files.branch.hidden ? " (hidden)" : ""}` : "the branch";
  const merged = files.mergedKeys.size
    ? " Files that changed only through merges are listed under Merged from other branches."
    : "";
  return `Changes checked in on ${name}, compared from ${base ? `the branch base ${base}` : "the branch base"} ` +
    `to cs:${files.head}, the branch head when this review was loaded.${merged}`;
}
