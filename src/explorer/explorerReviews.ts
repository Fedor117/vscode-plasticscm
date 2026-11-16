import { IReview } from "../reviews/models";
import { statusContext } from "../reviews/reviewPresentation";

export type ExplorerReviewStatus = "underReview" | "reworkRequired" | "reviewed";

/** The review badge of a branch or a changeset: its newest review, with any older ones named in the tooltip. */
export interface IExplorerReviewMark {
  /** The review a click opens. */
  readonly id: number;
  readonly status: ExplorerReviewStatus;
  readonly tooltip: string;
}

export interface IExplorerReviews {
  /** By full branch name. */
  readonly byBranch: ReadonlyMap<string, IExplorerReviewMark>;
  readonly byChangeset: ReadonlyMap<number, IExplorerReviewMark>;
}

export const NO_EXPLORER_REVIEWS: IExplorerReviews = { byBranch: new Map(), byChangeset: new Map() };

const STATUS_TEXT: { [status in ExplorerReviewStatus]: string } = {
  reviewed: "Reviewed",
  reworkRequired: "Rework required",
  underReview: "Under review",
};

interface IKnownReview {
  readonly review: IReview;
  readonly status: ExplorerReviewStatus;
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
    branchNames: ReadonlyMap<number, string | undefined>): IExplorerReviews {
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

  return { byBranch: toMarks(byBranch), byChangeset: toMarks(byChangeset) };
}

function toMarks<K>(groups: Map<K, IKnownReview[]>): Map<K, IExplorerReviewMark> {
  const marks = new Map<K, IExplorerReviewMark>();
  for (const [ key, group ] of groups) {
    const [ newest, ...older ] = group.sort((left, right) => right.review.id - left.review.id);
    const lines = [
      `${STATUS_TEXT[newest.status]}: review ${newest.review.id}, ${newest.review.title || "untitled"}`,
      ...older.map(known => `Earlier: review ${known.review.id}, ${STATUS_TEXT[known.status]}`),
      "Click to open the review",
    ];
    marks.set(key, { id: newest.review.id, status: newest.status, tooltip: lines.join("\n") });
  }
  return marks;
}
