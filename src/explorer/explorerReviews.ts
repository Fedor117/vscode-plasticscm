import { IReview, IReviewComment } from "../reviews/models";
import { IHistoryChangeset } from "../models";
import { parseTimelineEvent } from "../reviews/timeline";
import { statusContext } from "../reviews/reviewPresentation";

/** A review's own status, as cm has it. */
type ReviewStatusKey = "underReview" | "reworkRequired" | "reviewed";

/** What a badge shows. `reviewedEarlier` is a branch marked Reviewed that got changesets afterwards. */
export type ExplorerReviewStatus = ReviewStatusKey | "reviewedEarlier";

/** The review badge of a branch or a changeset: its newest review, with any older ones named in the tooltip. */
export interface IExplorerReviewMark {
  /** The review a click opens. */
  readonly id: number;
  readonly status: ExplorerReviewStatus;
  /** The status in words, as the badge shows it. */
  readonly label: string;
  readonly tooltip: string;
  /**
   * When a branch's review was last marked Reviewed, in milliseconds. Absent
   * until its timeline is read, and when the timeline does not say.
   */
  readonly reviewedAt?: number;
}

export interface IExplorerReviews {
  /** By full branch name. */
  readonly byBranch: ReadonlyMap<string, IExplorerReviewMark>;
  readonly byChangeset: ReadonlyMap<number, IExplorerReviewMark>;
}

export const NO_EXPLORER_REVIEWS: IExplorerReviews = { byBranch: new Map(), byChangeset: new Map() };

const STATUS_TEXT: { [status in ReviewStatusKey]: string } = {
  reviewed: "Reviewed",
  reworkRequired: "Rework required",
  underReview: "Under review",
};

interface IKnownReview {
  readonly review: IReview;
  readonly status: ReviewStatusKey;
}

/** The branch object id of a branch review's `id:N` target, or a changeset review's changeset number. */
export function reviewTargetId(review: Pick<IReview, "target">): number | undefined {
  const match = /^(?:id:|cs:)?(\d+)$/.exec(review.target);
  return match ? Number(match[1]) : undefined;
}

/**
 * Groups reviews by what they review. A review row names its branch by object
 * id only, so `branchNames` says which branch that is; a review of a deleted
 * branch, of an unknown target type or in a status cm does not document has
 * no badge. Review ids grow with time, so the highest id is the newest review.
 */
export function indexExplorerReviews(
    reviews: readonly IReview[],
    branchNames: ReadonlyMap<number, string | undefined>,
    reviewedAt: ReadonlyMap<number, number | undefined> = new Map()): IExplorerReviews {
  const byBranch = new Map<string, IKnownReview[]>();
  const byChangeset = new Map<number, IKnownReview[]>();
  const add = <K>(map: Map<K, IKnownReview[]>, key: K, known: IKnownReview): void => {
    const list = map.get(key) ?? [];
    list.push(known);
    map.set(key, list);
  };

  for (const review of reviews) {
    const status = statusContext(review.status);
    const targetId = reviewTargetId(review);
    if (status === "unknown" || targetId === undefined) {
      continue;
    }
    if (review.targetType === "changeset") {
      add(byChangeset, targetId, { review, status });
    } else if (review.targetType === "branch") {
      const branch = branchNames.get(targetId);
      if (branch) {
        add(byBranch, branch, { review, status });
      }
    }
  }

  // A changeset never changes, so only a branch's review can fall behind what it reviewed.
  return { byBranch: toMarks(byBranch, reviewedAt), byChangeset: toMarks(byChangeset) };
}

/** When each review was last marked Reviewed, from its timeline rows. A review whose rows do not say is left out. */
export function reviewedDates(timeline: readonly IReviewComment[]): Map<number, number> {
  const dates = new Map<number, number>();
  for (const comment of timeline) {
    if (comment.type !== "timeline") {
      continue;
    }
    const event = parseTimelineEvent(comment);
    const at = Date.parse(event.date);
    if (event.kind === "status" && event.status === "Reviewed" && !isNaN(at) &&
        at > (dates.get(comment.reviewId) ?? -Infinity)) {
      dates.set(comment.reviewId, at);
    }
  }
  return dates;
}

/**
 * A branch's mark as its head shows it. A branch marked Reviewed that got
 * changesets afterwards says so, and how many: the review did not cover them.
 * `changesets` are the loaded ones of the branch, newest first. When all of
 * them are newer than the review and `isLoaded` does not know the oldest one's
 * parent, older ones may be newer too, and the count is a minimum.
 */
export function markOnBranch(
    mark: IExplorerReviewMark,
    changesets: readonly IHistoryChangeset[],
    isLoaded: (changesetId: number) => boolean): IExplorerReviewMark {
  const reviewedAt = mark.reviewedAt;
  if (reviewedAt === undefined) {
    return mark;
  }
  const newer = changesets.filter(changeset => changeset.date.getTime() > reviewedAt);
  if (newer.length === 0) {
    return mark;
  }
  const oldest = newer[newer.length - 1];
  const atLeast = newer.length === changesets.length && oldest.parentId >= 0 && !isLoaded(oldest.parentId);
  const count = `${newer.length}${atLeast ? "+" : ""}`;
  const [ status, ...rest ] = mark.tooltip.split("\n");
  return {
    ...mark,
    label: `Reviewed · ${count} new`,
    status: "reviewedEarlier",
    tooltip: [
      status,
      `${count} ${count === "1" ? "changeset was" : "changesets were"} checked in after it was marked Reviewed`,
      ...rest,
    ].join("\n"),
  };
}

function toMarks<K>(
    groups: Map<K, IKnownReview[]>,
    reviewedAt?: ReadonlyMap<number, number | undefined>): Map<K, IExplorerReviewMark> {
  const marks = new Map<K, IExplorerReviewMark>();
  for (const [ key, group ] of groups) {
    const [ newest, ...older ] = group.sort((left, right) => right.review.id - left.review.id);
    const lines = [
      `${STATUS_TEXT[newest.status]}: review ${newest.review.id}, ${newest.review.title || "untitled"}`,
      ...older.map(known => `Earlier: review ${known.review.id}, ${STATUS_TEXT[known.status]}`),
      "Click to open the review",
    ];
    const at = newest.status === "reviewed" ? reviewedAt?.get(newest.review.id) : undefined;
    marks.set(key, {
      id: newest.review.id,
      label: STATUS_TEXT[newest.status],
      status: newest.status,
      tooltip: lines.join("\n"),
      ...(at === undefined ? {} : { reviewedAt: at }),
    });
  }
  return marks;
}
