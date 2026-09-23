import {
  Disposable,
  Event,
  EventEmitter,
  ThemeIcon,
  TreeDataProvider,
  TreeItem,
  TreeItemCollapsibleState,
  Uri,
  ViewBadge,
} from "vscode";
import {
  errorSummary,
  isGeneralThread,
  retryTooltip,
  themeIcon,
  threadContext,
  threadCounts,
  threadDescription,
  threadIcon,
  threadSummary,
  threadTooltip,
  toneUri,
} from "./reviewPresentation";
import { IActiveReview, IReviewSessionView } from "./sessionTypes";
import { IReviewDiscussions, IReviewThread } from "./models";
import { compareNames } from "./reviewFileTree";
import { posix } from "path";
import { reviewScheme } from "./reviewEditors";

export const discussionsViewId = "plastic-scm.reviews.discussions";

/** Commands the rows run; ReviewActions registers them. Each receives the row's node. */
export const DISCUSSION_COMMANDS = {
  openDiscussion: "plastic-scm.reviews.openDiscussion",
  retry: "plastic-scm.reviews.retry",
};

export interface IDiscussionGroupNode {
  readonly kind: "group";
  readonly id: string;
  /** A file (by server path), a revision whose path is unknown, or General. */
  readonly group: "file" | "revision" | "general";
  readonly label: string;
  readonly path?: string;
  readonly revisionId?: number;
  /** In display order. */
  readonly threads: IReviewThread[];
}

export interface IDiscussionThreadNode {
  readonly kind: "thread";
  readonly id: string;
  readonly thread: IReviewThread;
  readonly workspaceId: string;
  readonly reviewId: number;
  /** General threads (conversations, verdicts) open the Overview, which prints them in full, rather than a diff. */
  readonly general: boolean;
  readonly parent: IDiscussionGroupNode;
}

export interface IDiscussionMessageNode {
  readonly kind: "message";
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
  /** The loading row, drawn in the description colour. */
  readonly muted?: boolean;
}

/** The `retry` command calls `retry()`, whichever view the row is in. */
export interface IDiscussionErrorNode {
  readonly kind: "error";
  readonly id: string;
  readonly message: string;
  readonly retry: () => void;
}

export type DiscussionNode =
  | IDiscussionGroupNode
  | IDiscussionThreadNode
  | IDiscussionMessageNode
  | IDiscussionErrorNode;

/**
 * Groups threads by the server path of their anchor revision, files sorted by
 * name (the directory is the row's description, so the name is what the eye
 * scans); threads whose revision has no known path go under "Revision <id>",
 * and conversations, verdicts and threads without a location under General,
 * last. Threads in a file are newest first; General reads as a
 * conversation, oldest first.
 */
export function groupDiscussions(
    threads: readonly IReviewThread[],
    prefix: string): IDiscussionGroupNode[] {
  const files = new Map<string, IReviewThread[]>();
  const revisions = new Map<number, IReviewThread[]>();
  const general: IReviewThread[] = [];
  for (const thread of threads) {
    if (isGeneralThread(thread)) {
      general.push(thread);
    } else if (thread.path) {
      push(files, thread.path, thread);
    } else {
      push(revisions, thread.anchor.revisionId, thread);
    }
  }
  const groups: IDiscussionGroupNode[] = [];
  Array.from(files.keys())
    .sort((a, b) => compareNames(posix.basename(a), posix.basename(b)) || compareNames(a, b))
    .forEach(path => groups.push({
      group: "file",
      id: `${prefix}/file:${path}`,
      kind: "group",
      label: posix.basename(path) || path,
      path,
      threads: files.get(path)!.sort(newestFirst),
    }));
  Array.from(revisions.keys())
    .sort((a, b) => a - b)
    .forEach(revisionId => groups.push({
      group: "revision",
      id: `${prefix}/revision:${revisionId}`,
      kind: "group",
      label: `Revision ${revisionId}`,
      revisionId,
      threads: revisions.get(revisionId)!.sort(newestFirst),
    }));
  if (general.length) {
    groups.push({
      group: "general",
      id: `${prefix}/general`,
      kind: "group",
      label: "General",
      threads: general.sort(byDate),
    });
  }
  return groups;
}

/** Pending change requests: the only count that asks the author to act. */
export function discussionsBadge(threads: readonly IReviewThread[]): ViewBadge | undefined {
  const pending = threadCounts(threads).pending;
  return pending
    ? { tooltip: `${pending} pending change request${pending === 1 ? "" : "s"}`, value: pending }
    : undefined;
}

/**
 * `3 pending · 2 questions`; with nothing pending, the applied change requests
 * take that place (`1 applied · 1 question`). Undefined when all are zero.
 */
export function discussionsDescription(threads: readonly IReviewThread[]): string | undefined {
  const counts = threadCounts(threads);
  const parts: string[] = [];
  if (counts.pending) {
    parts.push(`${counts.pending} pending`);
  } else if (counts.applied) {
    parts.push(`${counts.applied} applied`);
  }
  if (counts.questions) {
    parts.push(`${counts.questions} question${counts.questions === 1 ? "" : "s"}`);
  }
  return parts.join(" · ") || undefined;
}

/** The Discussions view: every thread of the active review, grouped by file, then General. */
export class DiscussionsProvider implements TreeDataProvider<DiscussionNode>, Disposable {
  public readonly onDidChangeTreeData: Event<DiscussionNode | undefined>;
  private readonly changed = new EventEmitter<DiscussionNode | undefined>();
  private readonly subscription: Disposable;
  private cache?: { discussions: IReviewDiscussions; prefix: string; groups: IDiscussionGroupNode[] };

  public constructor(private readonly session: IReviewSessionView) {
    this.onDidChangeTreeData = this.changed.event;
    this.subscription = session.onDidChangeActive(() => this.changed.fire(undefined));
  }

  public dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
    this.cache = undefined;
  }

  public getChildren(node?: DiscussionNode): DiscussionNode[] {
    const active = this.session.active;
    if (!active) {
      return [];
    }
    if (node) {
      return node.kind === "group" ? this.threadNodes(active, node) : [];
    }
    const prefix = idPrefix(active);
    const stage = active.discussions;
    switch (stage.state) {
    case "error":
      return [{
        id: `${prefix}/error`,
        kind: "error",
        message: stage.message,
        retry: () => this.session.retryStage("discussions"),
      }];
    case "ready": {
      const children: DiscussionNode[] = [];
      if (stage.value.message) {
        children.push({ icon: "warning", id: `${prefix}/notice`, kind: "message", label: stage.value.message });
      }
      const groups = this.groups(stage.value, prefix);
      if (!groups.length) {
        children.push({ id: `${prefix}/empty`, kind: "message", label: "No discussions in this review yet." });
      }
      return children.concat(groups);
    }
    default:
      return [{
        icon: "loading~spin",
        id: `${prefix}/loading`,
        kind: "message",
        label: "Loading discussions…",
        muted: true,
      }];
    }
  }

  public getParent(node: DiscussionNode): DiscussionNode | undefined {
    return node.kind === "thread" ? node.parent : undefined;
  }

  public getTreeItem(node: DiscussionNode): TreeItem {
    switch (node.kind) {
    case "group":
      return groupItem(node);
    case "thread":
      return this.threadItem(node);
    case "error": {
      const item = new TreeItem("Couldn't load discussions", TreeItemCollapsibleState.None);
      item.id = node.id;
      item.description = errorSummary(node.message);
      item.tooltip = retryTooltip(node.message);
      item.iconPath = themeIcon({ color: "list.errorForeground", id: "error" });
      item.resourceUri = toneUri("error", node.id);
      item.contextValue = "error";
      item.command = { arguments: [node], command: DISCUSSION_COMMANDS.retry, title: "Retry" };
      return item;
    }
    default: {
      const item = new TreeItem(node.label, TreeItemCollapsibleState.None);
      item.id = node.id;
      item.tooltip = node.label;
      item.iconPath = node.icon
        ? themeIcon({ color: node.muted ? "descriptionForeground" : undefined, id: node.icon })
        : undefined;
      item.resourceUri = node.muted ? toneUri("muted", node.id) : undefined;
      item.contextValue = "message";
      return item;
    }
    }
  }

  /** The view badge for the loaded discussions; undefined while loading or with nothing pending. */
  public badge(): ViewBadge | undefined {
    const stage = this.session.active?.discussions;
    return stage?.state === "ready" ? discussionsBadge(stage.value.threads) : undefined;
  }

  public description(): string | undefined {
    const stage = this.session.active?.discussions;
    return stage?.state === "ready" ? discussionsDescription(stage.value.threads) : undefined;
  }

  private groups(discussions: IReviewDiscussions, prefix: string): IDiscussionGroupNode[] {
    if (this.cache?.discussions !== discussions || this.cache.prefix !== prefix) {
      this.cache = { discussions, groups: groupDiscussions(discussions.threads, prefix), prefix };
    }
    return this.cache.groups;
  }

  private threadNodes(active: IActiveReview, group: IDiscussionGroupNode): IDiscussionThreadNode[] {
    return group.threads.map(thread => ({
      general: group.group === "general",
      id: `${group.id}/thread:${thread.id}`,
      kind: "thread",
      parent: group,
      reviewId: active.review.id,
      thread,
      workspaceId: active.workspaceId,
    }));
  }

  private threadItem(node: IDiscussionThreadNode): TreeItem {
    const thread = node.thread;
    const item = new TreeItem(threadSummary(thread), TreeItemCollapsibleState.None);
    item.id = node.id;
    item.description = threadDescription(thread, this.session.now());
    item.iconPath = themeIcon(threadIcon(thread));
    item.tooltip = threadTooltip(thread);
    // A discarded change request reads greyed out, label and icon alike.
    item.resourceUri = thread.state === "discarded" ? toneUri("disabled", node.id) : undefined;
    item.contextValue = threadContext(thread);
    item.command = { arguments: [node], command: DISCUSSION_COMMANDS.openDiscussion, title: "Open Discussion" };
    return item;
  }
}

function groupItem(node: IDiscussionGroupNode): TreeItem {
  const item = new TreeItem(node.label, TreeItemCollapsibleState.Expanded);
  item.id = node.id;
  item.contextValue = `discussions;${node.group}`;
  const count = `${node.threads.length} discussion${node.threads.length === 1 ? "" : "s"}`;
  if (node.group === "file" && node.path) {
    const directory = posix.dirname(node.path).replace(/^\/+/, "");
    item.description = directory === "." ? "" : directory;
    // Only for the file icon theme; no decoration provider answers for `kind: item`.
    item.resourceUri = Uri.from({ path: node.path, query: JSON.stringify({ kind: "item" }), scheme: reviewScheme });
    item.iconPath = ThemeIcon.File;
    item.tooltip = `${node.path}\n${count}`;
  } else if (node.group === "revision") {
    item.iconPath = ThemeIcon.File;
    item.tooltip = `The path of revision ${node.revisionId ?? ""} is not in this workspace.\n${count}`;
  } else {
    // No icon: the threads below carry theirs, and a second speech bubble here would only repeat them.
    item.tooltip = "Conversations, verdicts and comments without a file location. " +
      `Select one to read it in the Overview.\n${count}`;
  }
  return item;
}

function idPrefix(active: IActiveReview): string {
  return `discussions/${active.workspaceId}/${active.review.id}`;
}

function push<K>(map: Map<K, IReviewThread[]>, key: K, thread: IReviewThread): void {
  const list = map.get(key);
  if (list) {
    list.push(thread);
  } else {
    map.set(key, [thread]);
  }
}

function time(thread: IReviewThread): number {
  const value = Date.parse(thread.comments[0]?.date ?? "");
  return isNaN(value) ? 0 : value;
}

/** Newest first, then by line; the thread id keeps the order total. */
function newestFirst(a: IReviewThread, b: IReviewThread): number {
  return time(b) - time(a) || a.anchor.location - b.anchor.location || a.id - b.id;
}

function byDate(a: IReviewThread, b: IReviewThread): number {
  return time(a) - time(b) || a.id - b.id;
}
