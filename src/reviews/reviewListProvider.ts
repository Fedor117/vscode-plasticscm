import {
  cleanReviewTitle,
  errorSummary,
  formatCount,
  isSupportedTarget,
  retryTooltip,
  reviewAriaLabel,
  reviewDescription,
  ReviewPeople,
  reviewTooltip,
  statusContext,
  statusIcon,
  themeIcon,
  toneUri,
} from "./reviewPresentation";
import {
  Disposable,
  Event,
  EventEmitter,
  ThemeIcon,
  TreeDataProvider,
  TreeItem,
  TreeItemCollapsibleState,
  ViewBadge,
} from "vscode";
import { IReviewSessionView, ReviewGroupKey } from "./sessionTypes";
import { IReview } from "./models";

export const reviewListViewId = "plastic-scm.reviews.list";

/** Commands the rows run; ReviewActions registers them. Each receives the row's node. */
export const REVIEW_LIST_COMMANDS = {
  loadMore: "plastic-scm.reviews.loadMore",
  open: "plastic-scm.reviews.open",
  retry: "plastic-scm.reviews.retry",
};

export interface IReviewListGroupNode {
  readonly kind: "group";
  readonly id: string;
  readonly key: ReviewGroupKey;
}

export interface IReviewListReviewNode {
  readonly kind: "review";
  readonly id: string;
  readonly key: ReviewGroupKey;
  readonly review: IReview;
  readonly workspaceId: string;
  readonly parent: IReviewListGroupNode;
}

export interface IReviewListLoadMoreNode {
  readonly kind: "loadMore";
  readonly id: string;
  readonly key: ReviewGroupKey;
  readonly parent: IReviewListGroupNode;
}

export interface IReviewListMessageNode {
  readonly kind: "message";
  readonly id: string;
  readonly label: string;
  readonly loading: boolean;
  readonly parent: IReviewListGroupNode;
}

/** The `retry` command calls `retry()`, whichever view the row is in. */
export interface IReviewListErrorNode {
  readonly kind: "error";
  readonly id: string;
  readonly message: string;
  readonly retry: () => void;
  readonly parent: IReviewListGroupNode;
}

export type ReviewListNode =
  | IReviewListGroupNode
  | IReviewListReviewNode
  | IReviewListLoadMoreNode
  | IReviewListMessageNode
  | IReviewListErrorNode;

interface IGroupInfo {
  readonly label: string;
  readonly tooltip?: string;
  readonly expanded: boolean;
  /** Filled by the queue queries on the view's first render. */
  readonly personal: boolean;
  /** The leaf shown when the loaded group is empty; the group is hidden instead when absent. */
  readonly empty?: string;
  /** Who the description names: the author's own groups name the assignee, All Reviews both. */
  readonly people: ReviewPeople;
  /** Load More's tooltip, for a group that pages. */
  readonly more?: string;
}

/** In display order, which is also the precedence that keeps a review in one personal group. */
const GROUPS: Array<[ReviewGroupKey, IGroupInfo]> = [
  [ "needsMyReview", {
    empty: "Nothing needs your review",
    expanded: true,
    label: "Needs My Review",
    people: "author",
    personal: true,
    tooltip: "Open reviews by others that you are assigned to or were asked to review.",
  }],
  [ "reworkRequested", {
    expanded: true,
    label: "Rework Requested",
    people: "assignee",
    personal: true,
    tooltip: "Your reviews where a reviewer asked for rework.",
  }],
  [ "waitingForReviewers", {
    expanded: true,
    label: "Waiting for Reviewers",
    people: "assignee",
    personal: true,
    tooltip: "Your reviews that are Under review.",
  }],
  [ "allOpen", {
    empty: "No open reviews",
    expanded: false,
    label: "All Open",
    more: "Load the next 50 open reviews.",
    people: "author",
    personal: false,
    tooltip: "Every review that is not Reviewed, newest first.",
  }],
  [ "allReviews", {
    empty: "No reviews",
    expanded: false,
    label: "All Reviews",
    more: "Load the next 50 reviews.",
    people: "both",
    personal: false,
    tooltip: "Every review in this repository, newest first, whatever its status.",
  }],
];
const INFO = new Map(GROUPS);
const PERSONAL = GROUPS.filter(([ , info ]) => info.personal).map(([key]) => key);
/**
 * Your own reviews come from one query, Needs My Review from others, so each
 * fails on its own. The owned query's error shows once, under Waiting for
 * Reviewers, which stays visible while it is in error.
 */
const OWNED_ERROR_GROUP: ReviewGroupKey = "waitingForReviewers";

/**
 * The Reviews view: the personal queue, then All Open and All Reviews, which
 * query nothing until expanded and page 50 reviews at a time. It only renders
 * session state; the session runs the queries and fires `onDidChangeList`
 * with what changed.
 */
export class ReviewListProvider implements TreeDataProvider<ReviewListNode>, Disposable {
  public readonly onDidChangeTreeData: Event<ReviewListNode | undefined>;
  private readonly changed = new EventEmitter<ReviewListNode | undefined>();
  private readonly subscription: Disposable;
  private readonly groupNodes = new Map<string, IReviewListGroupNode>();

  public constructor(private readonly session: IReviewSessionView) {
    this.onDidChangeTreeData = this.changed.event;
    this.subscription = session.onDidChangeList(key => this.onListChanged(key));
  }

  public dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
    this.groupNodes.clear();
  }

  public getChildren(node?: ReviewListNode): ReviewListNode[] {
    if (!node) {
      return this.rootChildren();
    }
    return node.kind === "group" ? this.groupChildren(node) : [];
  }

  public getParent(node: ReviewListNode): ReviewListNode | undefined {
    return node.kind === "group" ? undefined : node.parent;
  }

  public getTreeItem(node: ReviewListNode): TreeItem {
    switch (node.kind) {
    case "group":
      return this.groupItem(node);
    case "review":
      return this.reviewItem(node);
    case "loadMore": {
      // While the next page loads the row says so, with no command; its id stays, so it turns back in place.
      if (this.session.group(node.key).loadingMore) {
        const loading = new TreeItem("Loading more reviews…", TreeItemCollapsibleState.None);
        loading.id = node.id;
        loading.tooltip = "Loading the next 50 reviews.";
        loading.iconPath = themeIcon({ color: "descriptionForeground", id: "loading~spin" });
        loading.resourceUri = toneUri("muted", node.id);
        loading.contextValue = "message";
        return loading;
      }
      const item = new TreeItem("Load More…", TreeItemCollapsibleState.None);
      item.id = node.id;
      item.description = "next 50";
      item.tooltip = INFO.get(node.key)!.more;
      // No icon, but the space for one, so the label lines up with the reviews above it.
      item.iconPath = new ThemeIcon("blank");
      item.resourceUri = toneUri("link", node.id);
      item.contextValue = "loadMore";
      item.command = { arguments: [node], command: REVIEW_LIST_COMMANDS.loadMore, title: "Load More" };
      return item;
    }
    case "error": {
      const item = new TreeItem("Couldn't load reviews", TreeItemCollapsibleState.None);
      item.id = node.id;
      item.description = errorSummary(node.message);
      item.tooltip = retryTooltip(node.message);
      item.iconPath = themeIcon({ color: "list.errorForeground", id: "error" });
      item.resourceUri = toneUri("error", node.id);
      item.contextValue = "error";
      item.command = { arguments: [node], command: REVIEW_LIST_COMMANDS.retry, title: "Retry" };
      return item;
    }
    default: {
      const item = new TreeItem(node.label, TreeItemCollapsibleState.None);
      item.id = node.id;
      item.tooltip = node.label;
      item.iconPath = node.loading ? themeIcon({ color: "descriptionForeground", id: "loading~spin" }) : undefined;
      item.resourceUri = node.loading ? toneUri("muted", node.id) : undefined;
      item.contextValue = "message";
      return item;
    }
    }
  }

  /** Needs My Review: the reviews waiting on the user as a reviewer. */
  public badge(): ViewBadge | undefined {
    const value = this.reviews("needsMyReview").length;
    return value ? { tooltip: `${value} review${value === 1 ? " needs" : "s need"} your review`, value } : undefined;
  }

  /** The workspace name, only when there is more than one Plastic workspace to tell apart. */
  public description(): string | undefined {
    return this.session.multipleWorkspaces ? this.session.workspaceName : undefined;
  }

  /**
   * A group's reviews as shown: a review already listed in an earlier personal
   * group is left out of the later ones.
   */
  public reviews(key: ReviewGroupKey): readonly IReview[] {
    const reviews = this.session.group(key).reviews;
    const index = PERSONAL.indexOf(key);
    if (index <= 0) {
      return reviews;
    }
    const earlier = new Set<number>();
    for (const other of PERSONAL.slice(0, index)) {
      this.session.group(other).reviews.forEach(review => earlier.add(review.id));
    }
    return reviews.filter(review => !earlier.has(review.id));
  }

  private rootChildren(): ReviewListNode[] {
    const workspaceId = this.session.workspaceId;
    if (workspaceId === undefined) {
      return [];
    }
    // Nothing loads at activation: the first render of the view runs the queue queries.
    PERSONAL.forEach(key => this.startLoad(key));
    // Groups without an empty text (Rework Requested, Waiting for Reviewers) stay hidden until they have
    // reviews; Waiting for Reviewers also shows while the query for your own reviews fails, to show why.
    return GROUPS
      .filter(([ key, info ]) => info.empty !== undefined || this.reviews(key).length > 0 ||
        (key === OWNED_ERROR_GROUP && this.session.group(key).stage.state === "error"))
      .map(([key]) => this.groupNode(workspaceId, key));
  }

  private groupChildren(node: IReviewListGroupNode): ReviewListNode[] {
    const info = INFO.get(node.key)!;
    if (!info.personal) {
      this.startLoad(node.key);
    }
    const group = this.session.group(node.key);
    const children: ReviewListNode[] = [];
    // Rework Requested and Waiting for Reviewers share one query, so its error is shown once.
    if (group.stage.state === "error" && node.key !== "reworkRequested") {
      const key = node.key;
      children.push({
        id: `${node.id}/error`,
        kind: "error",
        message: group.stage.message,
        parent: node,
        retry: () => this.session.retryGroup(key),
      });
    } else if (!group.loadedOnce) {
      return [{ id: `${node.id}/loading`, kind: "message", label: "Loading reviews…", loading: true, parent: node }];
    }
    const workspaceId = this.session.workspaceId ?? "";
    const reviews = this.reviews(node.key);
    for (const review of reviews) {
      const id = `${node.id}/${review.id}`;
      children.push({ id, key: node.key, kind: "review", parent: node, review, workspaceId });
    }
    if (group.hasMore) {
      children.push({ id: `${node.id}/more`, key: node.key, kind: "loadMore", parent: node });
    }
    if (!children.length && info.empty) {
      children.push({ id: `${node.id}/empty`, kind: "message", label: info.empty, loading: false, parent: node });
    }
    return children;
  }

  private groupItem(node: IReviewListGroupNode): TreeItem {
    const info = INFO.get(node.key)!;
    const group = this.session.group(node.key);
    const item = new TreeItem(
      info.label, info.expanded ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.Collapsed);
    item.id = node.id;
    item.tooltip = info.tooltip;
    item.contextValue = `group;${node.key}`;
    if (group.loadedOnce) {
      item.description = `${formatCount(this.reviews(node.key).length)}${group.hasMore ? "+" : ""}`;
    }
    return item;
  }

  private reviewItem(node: IReviewListReviewNode): TreeItem {
    const review = node.review;
    const now = this.session.now();
    const title = cleanReviewTitle(review);
    const item = new TreeItem(title, TreeItemCollapsibleState.None);
    item.id = node.id;
    item.description = reviewDescription(review, now, INFO.get(node.key)!.people);
    item.tooltip = reviewTooltip(review, now);
    item.contextValue = `review;${statusContext(review.status)}`;
    item.accessibilityInformation = { label: reviewAriaLabel(review, now) };
    if (isSupportedTarget(review)) {
      item.iconPath = themeIcon(statusIcon(review.status));
      item.command = { arguments: [node], command: REVIEW_LIST_COMMANDS.open, title: "Open Review" };
    } else {
      item.iconPath = new ThemeIcon("circle-slash");
    }
    return item;
  }

  private groupNode(workspaceId: string, key: ReviewGroupKey): IReviewListGroupNode {
    const id = `list/${workspaceId}/${key}`;
    let node = this.groupNodes.get(id);
    if (!node) {
      node = { id, key, kind: "group" };
      this.groupNodes.set(id, node);
    }
    return node;
  }

  private startLoad(key: ReviewGroupKey): void {
    const group = this.session.group(key);
    if (group.stage.state === "idle" && !group.loadedOnce) {
      this.session.expandGroup(key);
    }
  }

  private onListChanged(key: ReviewGroupKey | undefined): void {
    const workspaceId = this.session.workspaceId;
    // A personal group can appear or disappear, which only a root refresh shows.
    if (key === undefined || workspaceId === undefined || INFO.get(key)!.personal) {
      this.changed.fire(undefined);
      return;
    }
    this.changed.fire(this.groupNode(workspaceId, key));
  }
}
