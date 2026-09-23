import { FileChangeStatus, IChangesetFileChange, IHistoryChangeset, IMergeLink, RevisionType } from "../models";
import { parseTimeline } from "./timeline";

export type ReviewStatus = "Under review" | "Rework required" | "Reviewed";
export const reviewStatuses: readonly ReviewStatus[] = [ "Under review", "Rework required", "Reviewed" ];

export interface IReview {
  id: number;
  title: string;
  owner: string;
  assignee: string;
  date: string;
  /** cm's status text with its `Status `/`CodeReviewStatus ` prefix removed. */
  status: string;
  /** Lower case: `branch` or `changeset`, the only target types cm has. */
  targetType: string;
  /** `id:<branch object id>` for branch reviews, the changeset number for changeset reviews. */
  target: string;
}

export interface IReviewComment {
  id: number;
  guid: string;
  owner: string;
  date: string;
  text: string;
  /** Lower case: change, question, comment, conversation, discarded, timeline… */
  type: string;
  revisionId: number;
  reviewId: number;
  /** Zero-based line in the anchor revision; -1 when the comment has no location. */
  location: number;
  parentId: number;
  /** -1 on most comments; when set it is the anchor revision's own changeset. */
  changesetId: number;
  appliedInChangesetId: number;
}

export type ReviewThreadKind = "question" | "change" | "comment" | "conversation" | "status" | "other";
export type ReviewThreadState = "pending" | "applied" | "discarded" | "none";

export interface IReviewThread {
  /** The root comment's id. */
  id: number;
  /**
   * Root first, then replies by date. For a thread built from a timeline row the
   * root is a copy of that row whose text is the event's text, marker removed;
   * the status itself is in `event`.
   */
  comments: IReviewComment[];
  /** The first comment with a revision and a location, otherwise the root. */
  anchor: IReviewComment;
  /** Server path (`/Assets/...`) of the anchor revision; undefined when unknown. */
  path?: string;
  kind: ReviewThreadKind;
  state: ReviewThreadState;
  /** Set on `status`/`other` threads built from a timeline row. */
  event?: IReviewTimelineEvent;
}

export type ReviewTimelineEventKind =
  | "status"
  | "reviewRequested"
  | "reviewRequestRemoved"
  | "reviewReRequested"
  | "renamed"
  | "description"
  | "other";

export interface IReviewTimelineEvent {
  /** Id of the timeline comment row. */
  id: number;
  owner: string;
  date: string;
  kind: ReviewTimelineEventKind;
  /** Set on `status` events whose marker names a known status. */
  status?: ReviewStatus;
  /** The reviewer a review request event is about. */
  user?: string;
  /** Verdict, new title, description or raw text, trimmed; empty when the event carries none. */
  text: string;
  /** The title a `renamed` event replaced; it often held the only ticket link. */
  previous?: string;
}

export interface IReviewRevision {
  id: number;
  itemId: number;
  /** Local absolute workspace path, as `cm find revision` prints it; see ReviewService.serverPath. */
  path: string;
  /** txt, bin or dir. */
  type: string;
  changesetId: number;
  /** Previous revision in the item's history, or -1. */
  parentId: number;
  /** REPNAME@REPSERVER. */
  repository: string;
  /** Branch name without cm's `br:` prefix. */
  branch: string;
}

export interface IReviewComparison {
  /** Unique per load; embedded in plastic-review: URIs. */
  id: string;
  kind: "final" | "changeset" | "original";
  /** Names both sides, e.g. "cs:3471 ↔ cs:3715". */
  label: string;
  baseChangesetId?: number;
  headChangesetId?: number;
  files: IChangesetFileChange[];
}

export interface IReviewBranch {
  /** Branch object id, the review's target. */
  id: number;
  name: string;
  parent?: string;
  headChangesetId: number;
  /** Found only by the `hidden = 'true'` query. */
  hidden: boolean;
}

export interface IReviewFiles {
  /** Every row of the plain `cm diff br:<name>` (branch) or `cm diff cs:N` (changeset). */
  final: IReviewComparison;
  /** fileKey()s of final rows that changed only through merges; empty when there are none. */
  mergedKeys: ReadonlySet<string>;
  branch?: IReviewBranch;
  /** Neither branch query found the branch; `final.files` is then empty. */
  branchDeleted: boolean;
  /** Head changeset the comparison is pinned to; -1 for a deleted branch. */
  head: number;
  /** Branch base (parent of the branch's first changeset) or the reviewed changeset's parent. */
  base?: number;
  /** Merges into the branch up to `head` (branch reviews only). */
  merges: IMergeLink[];
}

export interface IReviewDiscussions {
  threads: IReviewThread[];
  /** Every timeline event, oldest first. */
  timeline: IReviewTimelineEvent[];
  /** Currently requested reviewers, from the timeline. */
  reviewers: string[];
  message?: string;
}

export interface IReviewChangeset extends IHistoryChangeset {
  /** Destination of a merge, cherry pick or interval merge into the branch. */
  isMerge: boolean;
  mergeSourceBranch?: string;
}

export interface IReviewChangesets {
  /** Newest first. */
  items: IReviewChangeset[];
  hasMore: boolean;
}

export interface IReviewUpdates {
  /** The new status, when it differs from the review's. */
  status?: string;
  /** The branch's new head; -1 when the branch no longer exists. */
  newHead?: number;
  /** Discussion comments that are new, or whose text, type or applied state changed. */
  newComments: number;
  removedComments: number;
}

/** The personal review groups. A review appears in at most one of them; each is newest first. */
export interface IReviewQueue {
  /** Open, Under review, not mine, and I am the assignee or a currently requested reviewer. */
  needsMyReview: IReview[];
  /** Mine, Rework required. */
  reworkRequested: IReview[];
  /** Mine, Under review. */
  waitingForReviewers: IReview[];
}

/** Find Review…'s reviews, with the branch names their titles do not give. */
export interface IFoundReviews {
  /** Newest first. */
  readonly reviews: readonly IReview[];
  /** Branch object id → name, for the branch reviews whose title does not name the branch; a deleted one has none. */
  readonly branches: ReadonlyMap<number, string>;
}

/** Identity of a diff row. A path alone is not enough: a delete and re-add of one path are two rows. */
export function fileKey(file: { path: string; revisionId: number }): string {
  return JSON.stringify([ file.path, file.revisionId ]);
}

/**
 * The final rows of Changes (touched by the branch's own check-ins) or of
 * Merged from other branches, directory records included: the tree shows
 * those as folders.
 */
export function scopeRows(files: IReviewFiles, scope: "changes" | "merged"): IChangesetFileChange[] {
  const merged = scope === "merged";
  if (!files.mergedKeys.size) {
    return merged ? [] : files.final.files;
  }
  return files.final.files.filter(file => files.mergedKeys.has(fileKey(file)) === merged);
}

/**
 * The rows a viewed count covers. Directory records are folders in the tree,
 * never files to view, so the tree, the Overview and the Reviewed check all
 * count without them.
 */
export function viewableRows(rows: readonly IChangesetFileChange[]): IChangesetFileChange[] {
  return rows.filter(file => file.revisionType !== RevisionType.Directory);
}

/**
 * cm prints one repository under different server aliases depending on the
 * command (`…@acme-studio@unity` from diff and find revision, a numeric
 * `…@cloud` from status), so only the name before the first `@` is compared.
 */
export function sameRepository(a: string, b: string): boolean {
  return repositoryName(a).toLowerCase() === repositoryName(b).toLowerCase();
}

export function repositoryName(repository: string): string {
  const at = repository.indexOf("@");
  return at < 0 ? repository : repository.substring(0, at);
}

/**
 * Merge rows sometimes list an item as Changed with neither a base nor a parent
 * revision although the same revision sits at that path on both sides. There is
 * nothing to compare, and falling back to the item's history parent would show
 * a change that never happened.
 */
export function isPhantomChange(file: IChangesetFileChange): boolean {
  return file.status === FileChangeStatus.Changed && file.baseRevisionId < 0 && file.parentRevisionId < 0;
}

/**
 * Retains orphan replies and breaks malformed cycles instead of hiding
 * discussion. Timeline rows become threads only when they carry text or have
 * replies (a reviewer answering a verdict); the rest belong to the activity log.
 */
export function groupReviewThreads(
    comments: readonly IReviewComment[],
    timeline?: readonly IReviewTimelineEvent[]): IReviewThread[] {
  const events = new Map((timeline ?? parseTimeline(comments)).map(event => [ event.id, event ]));
  const byId = new Map(comments.map(comment => [ comment.id, comment ]));
  const groups = new Map<number, IReviewComment[]>();
  for (const comment of comments) {
    let root = comment;
    const visited = new Set<number>([comment.id]);
    while (byId.has(root.parentId) && !visited.has(root.parentId)) {
      visited.add(root.parentId);
      root = byId.get(root.parentId)!;
    }
    if (visited.has(root.parentId)) {
      root = byId.get(Math.min(...Array.from(visited)))!;
    }
    const group = groups.get(root.id) ?? [];
    group.push(comment);
    groups.set(root.id, group);
  }
  const threads: IReviewThread[] = [];
  groups.forEach((group, id) => {
    group.sort((a, b) => (a.id === id ? -1 : b.id === id ? 1 : a.date.localeCompare(b.date) || a.id - b.id));
    const root = group[0];
    const event = root.type === "timeline" ? events.get(root.id) : undefined;
    if (root.type === "timeline" && group.length === 1 && !(event?.text && carriesDiscussion(event))) {
      return;
    }
    if (event) {
      group[0] = { ...root, text: event.text };
    }
    threads.push({
      anchor: group.find(comment => comment.revisionId > 0 && comment.location >= 0) ?? group[0],
      comments: group,
      event,
      id,
      kind: threadKind(root, event),
      state: threadState(root, group),
    });
  });
  return threads;
}

/**
 * Renames, descriptions and review requests with text are bookkeeping, not
 * discussion: History lists them and the Overview leads with the latest
 * description, so they are threads only when someone replied to them.
 */
function carriesDiscussion(event: IReviewTimelineEvent): boolean {
  return event.kind === "status" || event.kind === "other";
}

function threadKind(root: IReviewComment, event: IReviewTimelineEvent | undefined): ReviewThreadKind {
  if (root.type === "timeline") {
    return event?.kind === "status" ? "status" : "other";
  }
  switch (root.type) {
  case "question":
  case "change":
  case "comment":
  case "conversation":
    return root.type;
  default:
    return "other";
  }
}

function threadState(root: IReviewComment, group: readonly IReviewComment[]): ReviewThreadState {
  if (root.type !== "change") {
    return "none";
  }
  if (root.appliedInChangesetId >= 0) {
    return "applied";
  }
  return group.some(comment => comment !== root && comment.type === "discarded") ? "discarded" : "pending";
}
