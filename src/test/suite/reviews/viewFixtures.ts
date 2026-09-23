import { BRANCH_REVIEW_ID, ReviewShell, scenarioAnswer, WORKSPACE_ROOT } from "./fixtures";
import { EventEmitter, MarkdownString, OutputChannel, ThemeIcon, TreeItem, window } from "vscode";
import {
  IActiveReview,
  IReviewGroup,
  IReviewSessionView,
  ReviewGroupKey,
  Stage,
} from "../../../reviews/sessionTypes";
import {
  IReview,
  IReviewChangesets,
  IReviewComparison,
  IReviewDiscussions,
  IReviewFiles,
} from "../../../reviews/models";
import { IChangesetFileChange } from "../../../models";
import { ReviewService } from "../../../reviews/reviewService";
import { revisionKey } from "../../../reviews/viewedStore";

/** The fixed clock of the view tests: 18:00 on 22 Sep 2026 in the fixtures' +01:00 zone. */
export const NOW = Date.parse("2026-09-22T18:00:00+01:00");

/**
 * A session the views can render without cm: every stage is set directly,
 * every call a view makes is recorded in `calls`, and the events fire only
 * when a test (or `setViewed`) fires them.
 */
export class FakeSession implements IReviewSessionView {
  public readonly listChanged = new EventEmitter<ReviewGroupKey | undefined>();
  public readonly activeChanged = new EventEmitter<void>();
  public readonly viewedChanged = new EventEmitter<void>();
  public readonly onDidChangeList = this.listChanged.event;
  public readonly onDidChangeActive = this.activeChanged.event;
  public readonly onDidChangeViewed = this.viewedChanged.event;
  public workspaceId: string | undefined = "wk";
  public workspaceName: string | undefined = "Nimbus";
  public multipleWorkspaces = false;
  public active: IActiveReview | undefined;
  public fileLayout: "tree" | "list" = "tree";
  public loadingMoreChangesets = false;
  public readonly calls: string[] = [];
  public readonly groups = new Map<ReviewGroupKey, IReviewGroup>();
  public readonly changesetStages = new Map<number, Stage<IReviewComparison>>();
  public readonly viewed = new Set<string>();

  public now = (): number => NOW;

  public group(key: ReviewGroupKey): IReviewGroup {
    return this.groups.get(key) ??
      { hasMore: false, key, loadedOnce: false, loadingMore: false, reviews: [], stage: { state: "idle" }};
  }

  public setGroup(key: ReviewGroupKey, reviews: IReview[], overrides: Partial<IReviewGroup> = {}): void {
    this.groups.set(key, { hasMore: false, key, loadedOnce: true, loadingMore: false, reviews,
      stage: { state: "ready", value: undefined }, ...overrides });
  }

  public expandGroup(key: ReviewGroupKey): void {
    this.calls.push(`expandGroup:${key}`);
  }

  public loadMore(key: ReviewGroupKey): void {
    this.calls.push(`loadMore:${key}`);
  }

  public retryGroup(key: ReviewGroupKey): void {
    this.calls.push(`retryGroup:${key}`);
  }

  public changesetFiles(changesetId: number): Stage<IReviewComparison> {
    this.calls.push(`changesetFiles:${changesetId}`);
    let stage = this.changesetStages.get(changesetId);
    if (!stage) {
      // As the session does: the first request of an idle changeset starts its load.
      stage = { state: "loading" };
      this.changesetStages.set(changesetId, stage);
      this.calls.push(`loadChangeset:${changesetId}`);
    }
    return stage;
  }

  public retryStage(stage: "files" | "discussions" | "changesets"): void {
    this.calls.push(`retryStage:${stage}`);
  }

  public retryChangesetFiles(changesetId: number): void {
    this.calls.push(`retryChangesetFiles:${changesetId}`);
  }

  public isViewed(file: IChangesetFileChange): boolean {
    return this.viewed.has(revisionKey(file));
  }

  public setViewed(files: readonly IChangesetFileChange[], viewed: boolean): void {
    this.calls.push(`setViewed:${viewed}:${files.map(file => file.path).join(",")}`);
    for (const file of files) {
      if (viewed) {
        this.viewed.add(revisionKey(file));
      } else {
        this.viewed.delete(revisionKey(file));
      }
    }
    this.viewedChanged.fire();
  }

  public dispose(): void {
    this.listChanged.dispose();
    this.activeChanged.dispose();
    this.viewedChanged.dispose();
  }
}

export interface IScenario {
  review: IReview;
  files: IReviewFiles;
  discussions: IReviewDiscussions;
  changesets: IReviewChangesets;
}

let channel: OutputChannel | undefined;

/**
 * Loads a fixture review through the real service over the fake cm shell, so
 * the views are tested against the stage values the data layer really builds.
 */
export async function loadScenario(reviewId = BRANCH_REVIEW_ID): Promise<IScenario> {
  // One channel for every load: VS Code registers a channel asynchronously, and
  // disposing it before that finishes logs a leak warning.
  channel = channel ?? window.createOutputChannel("Review view tests");
  const shell = new ReviewShell();
  shell.answer = scenarioAnswer;
  const service = new ReviewService(
    "wk",
    WORKSPACE_ROOT,
    channel,
    { cmPath: "cm", millisCommandTimeout: 1000, millisToStop: 1000, millisToWaitUntilUp: 1000 },
    shell);
  try {
    const loaded = (await service.review(reviewId))!;
    const files = await service.loadFiles(loaded);
    const discussions = await service.loadDiscussions(loaded, files);
    const changesets = await service.loadChangesets(loaded, files);
    return { changesets, discussions, files, review: loaded };
  } finally {
    service.dispose();
  }
}

/** The scenario as an active review with every stage ready. */
export function readyReview(scenario: IScenario, overrides: Partial<IActiveReview> = {}): IActiveReview {
  return {
    changesets: { state: "ready", value: scenario.changesets },
    discussions: { state: "ready", value: scenario.discussions },
    files: { state: "ready", value: scenario.files },
    review: scenario.review,
    workspaceId: "wk",
    ...overrides,
  };
}

export function review(overrides: Partial<IReview> = {}): IReview {
  return {
    assignee: "",
    date: "2026-09-21T16:03:49+01:00",
    id: 12831,
    owner: "erin.author@example.com",
    status: "Under review",
    target: "id:11931",
    targetType: "branch",
    title: "Lap Timer Accuracy",
    ...overrides,
  };
}

export function label(item: TreeItem): string {
  return typeof item.label === "string" ? item.label : item.label?.label ?? "";
}

export function iconOf(item: TreeItem): { id: string; color?: string } | undefined {
  const icon = item.iconPath;
  if (!(icon instanceof ThemeIcon)) {
    return undefined;
  }
  return icon.color ? { color: icon.color.id, id: icon.id } : { id: icon.id };
}

/** A MarkdownString tooltip as the reader sees it: escapes and `&nbsp;` removed. */
export function plain(tooltip: TreeItem["tooltip"] | MarkdownString): string {
  const value = tooltip instanceof MarkdownString ? tooltip.value : tooltip ?? "";
  return value.replace(/&nbsp;/g, " ").replace(/\\([\\`*_{}[\]()#+\-.!|<>~$])/g, "$1");
}
