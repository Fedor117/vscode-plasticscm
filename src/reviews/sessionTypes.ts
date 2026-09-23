import {
  IReview,
  IReviewChangesets,
  IReviewComparison,
  IReviewDiscussions,
  IReviewFiles,
  IReviewUpdates,
} from "./models";
import { Event } from "vscode";
import { IChangesetFileChange } from "../models";

/**
 * What the review views read. The views never call cm: they render this state,
 * call the methods below, and redraw when the events fire. `ReviewSession`
 * implements it; tests use a fake.
 */

export type ReviewGroupKey =
  | "needsMyReview"
  | "reworkRequested"
  | "waitingForReviewers"
  | "allOpen"
  | "allReviews";

export type Stage<T> =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; value: T };

export interface IReviewGroup {
  key: ReviewGroupKey;
  /** Newest first, in cm's order. */
  reviews: readonly IReview[];
  /** `loading` also while a refresh or the next page is in flight; `reviews` keeps what was shown. */
  stage: Stage<void>;
  hasMore: boolean;
  /** The next page is loading; the Load More row shows that. */
  loadingMore: boolean;
  loadedOnce: boolean;
}

export interface IActiveReview {
  workspaceId: string;
  review: IReview;
  files: Stage<IReviewFiles>;
  discussions: Stage<IReviewDiscussions>;
  changesets: Stage<IReviewChangesets>;
  /** Set while the server has changes the pinned stages do not show. */
  updates?: IReviewUpdates;
}

export type FileScope = "changes" | "merged" | { changesetId: number };

export interface IReviewSessionView {
  /** undefined = all groups. */
  readonly onDidChangeList: Event<ReviewGroupKey | undefined>;
  readonly onDidChangeActive: Event<void>;
  readonly onDidChangeViewed: Event<void>;
  /** The workspace the Reviews list shows; review rows and their commands carry it. */
  readonly workspaceId: string | undefined;
  readonly workspaceName: string | undefined;
  readonly multipleWorkspaces: boolean;
  group(key: ReviewGroupKey): IReviewGroup;
  /**
   * Starts the first load of a group whose stage is idle and that has never
   * loaded; a no-op otherwise. The Reviews view calls it for the personal
   * groups on its first render and for All Open and All Reviews when
   * they are expanded, so it must tolerate repeated calls.
   */
  expandGroup(key: ReviewGroupKey): void;
  /** The next page of a paged group (All Open, All Reviews); a no-op for the others. */
  loadMore(key: ReviewGroupKey): void;
  retryGroup(key: ReviewGroupKey): void;
  readonly active: IActiveReview | undefined;
  /** Returns the cached stage; triggers a load when idle and fires onDidChangeActive when done. */
  changesetFiles(changesetId: number): Stage<IReviewComparison>;
  retryStage(stage: "files" | "discussions" | "changesets"): void;
  /** Reloads a changeset whose `changesetFiles` stage failed. */
  retryChangesetFiles(changesetId: number): void;
  /** The next page of the Changesets list is loading; its Load More row shows that instead. */
  readonly loadingMoreChangesets: boolean;
  isViewed(file: IChangesetFileChange): boolean;
  setViewed(files: readonly IChangesetFileChange[], viewed: boolean): void;
  readonly fileLayout: "tree" | "list";
  /** Injectable clock for relative ages. */
  readonly now: () => number;
}
