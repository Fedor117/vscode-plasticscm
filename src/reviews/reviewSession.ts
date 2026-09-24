import {
  CancellationToken,
  commands,
  Disposable,
  Event,
  EventEmitter,
  OutputChannel,
  ProgressLocation,
  window,
  workspace,
} from "vscode";
import { formatCount, sameStatus, threadCounts, unnamedBranchId } from "./reviewPresentation";
import { IActiveReview, IReviewGroup, IReviewSessionView, ReviewGroupKey, Stage } from "./sessionTypes";
import {
  IFoundReviews,
  IReview,
  IReviewChangesets,
  IReviewComparison,
  IReviewDiscussions,
  IReviewFiles,
  IReviewQueue,
  IReviewThread,
  ReviewStatus,
  scopeRows,
  viewableRows,
} from "./models";
import { IReviewEditorContext, overviewViewId } from "./reviewEditors";
import { isReviewLoadCancelled, ReviewService } from "./reviewService";
import { IViewedMemento, reviewKey, ViewedStore } from "./viewedStore";
import { ReviewerBlock, reviewerBlock } from "./timeline";
import { discussionsViewId } from "./discussionsProvider";
import { IChangesetFileChange } from "../models";
import { IReviewLink } from "./reviewLinks";
import { isEmailAddress } from "./reviewWriter";
import { IShellConfig } from "../config";
import { PAGE_SIZE } from "./commands";
import { randomBytes } from "crypto";
import { renderOverview } from "./reviewOverview";
import { ReviewerAccess } from "./reviewPosting";
import { reviewListViewId } from "./reviewListProvider";
import { reviewTreeViewId } from "./reviewTreeProvider";

/** A Plastic workspace the reviews can be read through. */
export interface IReviewWorkspace {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  /** The repository spec `cm status` reports; undefined until it is known. */
  readonly repository?: string;
}

/** The part of ReviewEditors the session drives: which review the open diffs belong to. */
export interface IReviewSessionEditors {
  setContext(context: IReviewEditorContext | undefined): void;
  refreshOverview(serviceId: string, reviewId: number): void;
}

/** Everything the session shows the user, so tests can answer instead of a person. */
export interface IReviewSessionUi {
  /** A modal with one action button; resolves true when the user picks it. */
  confirm(message: string, detail: string, action: string): Thenable<boolean>;
  /** An error the user has to see, with a way to the output channel. */
  error(message: string): void;
  /** A short confirmation in the status bar. */
  status(message: string): void;
  /** A progress bar on a view while `task` runs. */
  progress<T>(viewId: string, task: () => Thenable<T>): Thenable<T>;
  /** A modal with several action buttons; resolves the one picked, undefined for Cancel. */
  choose(message: string, detail: string, actions: readonly string[]): Thenable<string | undefined>;
  /** Something the user should read, without blocking. */
  info(message: string): void;
  /** A notification with a Cancel button while `task` runs; `cancel` fires when it is pressed. */
  cancellable<T>(title: string, task: (cancel: CancellationToken) => Thenable<T>): Thenable<T>;
}

/**
 * Experimental: adding the cm user to a review's reviewers through Unity's
 * hosted API, with the connection of experimental posting. ReviewPosting
 * provides it.
 */
export interface IReviewSessionReviewers {
  /** The experimental setting; the Overview offers Add me as reviewer only while it is on. */
  settingOn(): boolean;
  /** Whether adding can work in a workspace, and if not, why. */
  access(workspaceId: string): Promise<ReviewerAccess>;
  /** Configure Experimental Posting…; resolves true once a connection is saved. */
  configure(): Promise<boolean>;
  /** Rejects with a message that is safe to show. */
  add(workspaceId: string, reviewId: number, user: string, cancel?: CancellationToken): Promise<void>;
}

export interface IReviewSessionOptions {
  workspaces: () => readonly IReviewWorkspace[];
  channel: OutputChannel;
  shellConfig: () => IShellConfig;
  /** Viewed files follow the user across workspaces and windows. */
  globalState: IViewedMemento;
  /** The selected workspace and the last review per workspace belong to this window's folders. */
  workspaceState: IViewedMemento;
  editors?: IReviewSessionEditors;
  /** The URI that opens a thread or a file row from the Overview; without it the Overview links nothing of its own. */
  overviewLink?: (link: IReviewLink) => string;
  /** Experimental: adds the cm user to reviewers. Without it, Set Review Status… never offers to. */
  reviewers?: IReviewSessionReviewers;
  /** Test injection; by default every workspace gets a service with its own cm shell. */
  createService?: (workspace: IReviewWorkspace) => ReviewService;
  ui?: Partial<IReviewSessionUi>;
  now?: () => number;
  pollInterval?: number;
  fileLayout?: () => "tree" | "list";
}

export const LAST_REVIEW_KEY = "plastic-scm.reviews.lastReview";
export const SELECTED_WORKSPACE_KEY = "plastic-scm.reviews.workspace";
export const FILE_LAYOUT_SETTING = "plastic-scm.reviews.fileLayout";

const PERSONAL: readonly ReviewGroupKey[] = [ "needsMyReview", "reworkRequested", "waitingForReviewers" ];
/** The groups that page: each Load More reads the next `PAGE_SIZE` reviews. */
const PAGED: readonly ReviewGroupKey[] = [ "allOpen", "allReviews" ];
const ALL_GROUPS: readonly ReviewGroupKey[] = PERSONAL.concat(PAGED);
const POLL_INTERVAL = 60 * 1000;
/** Find Review…'s reviews are read again once they are this old, as the polled queue would be. */
const FIND_MAX_AGE = POLL_INTERVAL;
const IDLE: Stage<never> = { state: "idle" };
const LOADING: Stage<never> = { state: "loading" };
const NOT_FOUND = "ReviewNotFound";
/** The choices of Set Review Status… when the cm user is not a reviewer yet; a modal adds Cancel. */
const SET_ANYWAY = "Set Status Anyway";
const CONFIGURE_AND_ADD = "Configure and Add…";
const WITHOUT_ADDING = "Set Status Without Adding";
/** Why the cm user cannot be added to a review's reviewers, as Add Me as Reviewer says it. */
const BLOCKED: { [block in ReviewerBlock]: (reviewId: number) => string } = {
  assignee: id => `You're the assignee of review #${id}, which already makes you a reviewer.`,
  author: id => `You opened review #${id}, and authors don't review their own change.`,
  requested: id => `You're already a reviewer on review #${id}.`,
};

interface ILastReviews {
  [workspaceId: string]: number | undefined;
}

/** What Set Review Status… does about the cm user's place among the reviewers; see `joinPlan`. */
type JoinPlan =
  | { kind: "none" }
  | { kind: "add" | "ask"; user: string }
  | { kind: "unable"; reason: string };

/** Why the cm user was not added to a review's reviewers; see `addUser`. */
interface IAddFailure {
  message: string;
  cancelled: boolean;
}

/**
 * An add of the cm user to one review in flight (see `claimAdd`). `failure`
 * is what `addUser` resolved or, until it has, why nothing was sent; the end
 * of the claim resolves `ended` with it.
 */
interface IAddClaim {
  readonly ended: Promise<IAddFailure | undefined>;
  failure: IAddFailure | undefined;
  end: (failure: IAddFailure | undefined) => void;
}

/** A settled promise, as `Promise.allSettled` would give it (not in this project's ES6 library). */
type Settled<T> = { value: T } | { error: unknown };

function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(value => ({ value }), (error: unknown) => ({ error }));
}

/** The key of an add in flight: a review of a workspace. */
function addKey(workspaceId: string, reviewId: number): string {
  return JSON.stringify([ workspaceId, reviewId ]);
}

/** cm prefixes its own diagnostics with "Error: "; the message after it is what the user needs. */
export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const index = message.lastIndexOf("Error: ");
  return index < 0 ? message : message.substring(index + "Error: ".length);
}

/**
 * The state behind the three review views: the queue of the selected
 * workspace, and the one active review, loaded in stages (files, then
 * discussions, then changesets) that each show, fail and retry on their own.
 * A newer activation supersedes an older one through a generation counter, so
 * a slow load never overwrites what the user picked afterwards. Nothing here
 * opens an editor: activation, restore, refresh and updates only change what
 * the views and the already open diffs show.
 */
export class ReviewSession implements IReviewSessionView, Disposable {
  public readonly onDidChangeList: Event<ReviewGroupKey | undefined>;
  public readonly onDidChangeActive: Event<void>;
  public readonly onDidChangeViewed: Event<void>;
  /** The selected workspace changed; the queue and the active review were reset. */
  public readonly onDidChangeWorkspace: Event<void>;
  /** `canAddMe` may answer differently for the same review: cm said who the user is, or an add started or ended. */
  public readonly onDidChangeCanAddMe: Event<void>;
  /** Written into the Overview's Add me as reviewer link; a link without it asks before it writes. */
  public readonly linkKey = randomBytes(18).toString("base64url");
  public readonly now: () => number;
  private readonly listChanged = new EventEmitter<ReviewGroupKey | undefined>();
  private readonly activeChanged = new EventEmitter<void>();
  private readonly viewedChanged = new EventEmitter<void>();
  private readonly workspaceChanged = new EventEmitter<void>();
  private readonly canAddMeChanged = new EventEmitter<void>();
  private readonly services = new Map<string, ReviewService>();
  private readonly groups = new Map<ReviewGroupKey, IReviewGroup>();
  private readonly changesetStages = new Map<number, Stage<IReviewComparison>>();
  private readonly visibleViews = new Set<string>();
  private readonly restoredWorkspaces = new Set<string>();
  /**
   * The adds of the cm user in flight, by `addKey`. Each is held until the
   * open review shows its result, so neither a second Add Me as Reviewer nor
   * a Set Review Status… meanwhile sends a second request.
   */
  private readonly adds = new Map<string, IAddClaim>();
  private readonly viewed: ViewedStore;
  private readonly ui: IReviewSessionUi;
  private readonly pollInterval: number;
  private selected?: string;
  private current?: IActiveReview;
  /** Bumped by every activation, reload and close; a load whose number is stale drops its results. */
  private generation = 0;
  /** The generation of an activation still looking up its review; picking the active review again drops it. */
  private lookingUp?: number;
  /** Bumped when the workspace changes, so a queue load of the previous one is dropped. */
  private listGeneration = 0;
  private busyCount = 0;
  private polling = false;
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  /** The Changesets page a Load More Changesets is extending; its row shows the load. */
  private moreChangesetsFrom?: IReviewChangesets;
  /** Find Review…'s reviews of the selected workspace, and when they were asked for (see `findReviews`). */
  private found?: Promise<IFoundReviews>;
  private foundAt = 0;

  public constructor(private readonly options: IReviewSessionOptions) {
    this.onDidChangeList = this.listChanged.event;
    this.onDidChangeActive = this.activeChanged.event;
    this.onDidChangeViewed = this.viewedChanged.event;
    this.onDidChangeWorkspace = this.workspaceChanged.event;
    this.onDidChangeCanAddMe = this.canAddMeChanged.event;
    this.now = options.now ?? Date.now;
    this.pollInterval = options.pollInterval ?? POLL_INTERVAL;
    this.viewed = new ViewedStore(options.globalState, this.now);
    this.ui = { ...defaultUi(), ...options.ui };
    const saved = options.workspaceState.get<string>(SELECTED_WORKSPACE_KEY);
    const known = options.workspaces();
    this.selected = known.find(wk => wk.id === saved)?.id ?? known[0]?.id;
  }

  public get workspaceId(): string | undefined {
    return this.selected;
  }

  public get workspaceName(): string | undefined {
    return this.workspace(this.selected)?.name;
  }

  public get multipleWorkspaces(): boolean {
    return this.options.workspaces().length > 1;
  }

  public get active(): IActiveReview | undefined {
    return this.current;
  }

  public get fileLayout(): "tree" | "list" {
    const layout = this.options.fileLayout
      ? this.options.fileLayout()
      : workspace.getConfiguration().get<string>(FILE_LAYOUT_SETTING, "tree");
    return layout === "list" ? "list" : "tree";
  }

  /** A user operation is running; polls wait for it. */
  public get busy(): boolean {
    return this.busyCount > 0;
  }

  public get loadingMoreChangesets(): boolean {
    const changesets = this.current?.changesets;
    return !!this.moreChangesetsFrom && changesets?.state === "ready" && changesets.value === this.moreChangesetsFrom;
  }

  public dispose(): void {
    this.disposed = true;
    this.generation++;
    this.listGeneration++;
    this.stopPolling();
    this.services.forEach(service => service.dispose());
    this.services.clear();
    this.groups.clear();
    this.found = undefined;
    this.changesetStages.clear();
    this.listChanged.dispose();
    this.activeChanged.dispose();
    this.viewedChanged.dispose();
    this.workspaceChanged.dispose();
    this.canAddMeChanged.dispose();
  }

  public workspaces(): readonly IReviewWorkspace[] {
    return this.options.workspaces();
  }

  /** The review service of a known workspace, created on first use; undefined for any other id. */
  public service(workspaceId: string): ReviewService | undefined {
    if (this.disposed) {
      return undefined;
    }
    let service = this.services.get(workspaceId);
    if (!service) {
      const known = this.workspace(workspaceId);
      if (!known) {
        return undefined;
      }
      service = this.options.createService?.(known) ??
        new ReviewService(known.id, known.path, this.options.channel, this.options.shellConfig());
      this.services.set(workspaceId, service);
    }
    return service;
  }

  /** The workspace's repository spec, as `cm status` reports it. */
  public repository(workspaceId: string): string | undefined {
    return this.workspace(workspaceId)?.repository;
  }

  /**
   * Shows another workspace's reviews: its queue starts again from scratch and
   * the active review closes (its tabs keep their pinned content). The last
   * review of that workspace comes back, without opening anything.
   */
  public selectWorkspace(workspaceId: string): void {
    if (workspaceId === this.selected || !this.workspace(workspaceId)) {
      return;
    }
    this.selected = workspaceId;
    // Loads of the previous workspace's queue and review must not land in this one.
    this.generation++;
    this.listGeneration++;
    this.groups.clear();
    this.found = undefined;
    void this.options.workspaceState.update(SELECTED_WORKSPACE_KEY, workspaceId);
    this.setActive(undefined);
    this.listChanged.fire(undefined);
    this.workspaceChanged.fire();
    void this.restore();
  }

  public group(key: ReviewGroupKey): IReviewGroup {
    return this.groups.get(key) ??
      { hasMore: false, key, loadedOnce: false, loadingMore: false, reviews: [], stage: IDLE };
  }

  /** The first load of a group; the personal groups load together, from their two queries. */
  public expandGroup(key: ReviewGroupKey): void {
    const group = this.group(key);
    if (group.stage.state !== "idle" || group.loadedOnce) {
      return;
    }
    // Called while the view asks for its rows: the view already shows a loading row, so no event now.
    void this.loadGroup(key, false, false);
  }

  /** The next page of All Open or All Reviews; the other groups have one page. */
  public loadMore(key: ReviewGroupKey): void {
    const group = this.group(key);
    if (!PAGED.includes(key) || !group.hasMore || group.stage.state === "loading") {
      return;
    }
    void this.loadGroup(key, true);
  }

  public retryGroup(key: ReviewGroupKey): void {
    if (this.group(key).stage.state === "loading") {
      return;
    }
    void this.loadGroup(key, false);
  }

  /**
   * Loads every group the user has seen again, in place: rows keep their ids,
   * so selection and expansion survive. All Open and All Reviews go back to
   * their first page, and Find Review… asks cm again next time.
   */
  public async refreshList(): Promise<void> {
    this.found = undefined;
    const keys = ALL_GROUPS.filter(key => (PERSONAL.includes(key) || this.group(key).loadedOnce) &&
      this.group(key).stage.state !== "loading");
    const personal = keys.some(key => PERSONAL.includes(key));
    const tasks: Array<Promise<void>> = [];
    if (personal) {
      tasks.push(this.loadGroup("needsMyReview", false));
    }
    keys.filter(key => !PERSONAL.includes(key)).forEach(key => tasks.push(this.loadGroup(key, false)));
    await Promise.all(tasks);
  }

  /**
   * The reviews Find Review… lists, newest first: the newest `FIND_LIMIT` in
   * the selected workspace's repository, with the names of the branches their
   * titles do not give. They are kept for `FIND_MAX_AGE`, and until Refresh, a
   * status write, a poll that sees the queue change or a workspace switch. A
   * failed query is not kept; failed branch queries only leave branches unnamed.
   */
  public findReviews(): Promise<IFoundReviews> {
    const workspaceId = this.selected;
    const service = workspaceId === undefined ? undefined : this.service(workspaceId);
    if (!service) {
      return Promise.reject(new Error("Plastic Reviews needs an open Plastic workspace."));
    }
    if (!this.found || this.now() - this.foundAt >= FIND_MAX_AGE) {
      const found = this.track(async () => {
        const reviews = await service.findReviews();
        return { branches: await this.branchNames(service, reviews), reviews };
      });
      this.found = found;
      this.foundAt = this.now();
      found.catch(() => {
        if (this.found === found) {
          this.found = undefined;
        }
      });
    }
    return this.found;
  }

  /**
   * Makes a review the active one. The header shows at once (from the list row
   * when there is one, otherwise after one query), then the stages load in
   * order. Resolves once every stage has settled; a newer activation, a
   * reload or a close makes it return early and drop what it loaded.
   */
  public async activate(workspaceId: string, reviewId: number, header?: IReview): Promise<void> {
    const service = this.service(workspaceId);
    if (!service) {
      throw new Error("This review's Plastic workspace is no longer open.");
    }
    if (!Number.isSafeInteger(reviewId) || reviewId <= 0) {
      throw new Error(`Invalid review id: ${String(reviewId)}`);
    }
    const current = this.current;
    if (current && current.workspaceId === workspaceId && current.review.id === reviewId) {
      // Selecting the open review again keeps its pinned stages; Refresh Review reloads them. A slower pick of
      // another review, still looking it up, is dropped: the last pick wins.
      if (this.lookingUp === this.generation) {
        this.lookingUp = undefined;
        this.resumeAfterFailedActivation(++this.generation);
      }
      return;
    }
    // Before a workspace switch, which would otherwise restore that workspace's last review.
    this.restoredWorkspaces.add(workspaceId);
    if (workspaceId !== this.selected) {
      this.selectWorkspace(workspaceId);
    }
    const generation = ++this.generation;
    await this.track(() => this.ui.progress(reviewTreeViewId, async () => {
      let review = header && header.id === reviewId ? header : undefined;
      if (!review) {
        this.lookingUp = generation;
        try {
          review = await service.review(reviewId);
        } catch (error) {
          this.resumeAfterFailedActivation(generation);
          throw error;
        } finally {
          if (this.lookingUp === generation) {
            this.lookingUp = undefined;
          }
        }
        if (generation !== this.generation) {
          return;
        }
        if (!review) {
          this.resumeAfterFailedActivation(generation);
          const error = new Error(
            `Review #${reviewId} was not found in ${this.workspace(workspaceId)?.name ?? "this workspace"}.`);
          error.name = NOT_FOUND;
          throw error;
        }
      }
      this.rememberReview(workspaceId, reviewId);
      this.setActive({
        changesets: IDLE,
        discussions: IDLE,
        files: LOADING,
        review,
        workspaceId,
      });
      await this.loadStages(generation, service, false);
    }));
  }

  /**
   * Brings back the last review of the selected workspace, once per workspace
   * and only when nothing is active. No editor opens. A review that is gone is
   * forgotten quietly; the output channel says why.
   */
  public async restore(): Promise<void> {
    const workspaceId = this.selected;
    if (!workspaceId || this.current || this.restoredWorkspaces.has(workspaceId)) {
      return;
    }
    this.restoredWorkspaces.add(workspaceId);
    const reviewId = this.lastReviews()[workspaceId];
    if (reviewId === undefined || !Number.isSafeInteger(reviewId)) {
      return;
    }
    try {
      await this.activate(workspaceId, reviewId);
    } catch (error) {
      this.log(`Couldn't restore review #${reviewId}: ${errorText(error)}`);
      // A server that is briefly unreachable must not make the review forgotten for good.
      if (error instanceof Error && error.name === NOT_FOUND) {
        this.forgetReview(workspaceId, reviewId);
      }
    }
  }

  /** Closes the active review; it will not come back on the next window reload. */
  public close(): void {
    const active = this.current;
    if (!active) {
      return;
    }
    this.generation++;
    this.forgetReview(active.workspaceId, active.review.id);
    this.setActive(undefined);
  }

  public retryStage(stage: "files" | "discussions" | "changesets"): void {
    const active = this.current;
    const service = active && this.service(active.workspaceId);
    if (!active || !service || active[stage].state === "loading") {
      return;
    }
    void this.track(() => this.ui.progress(reviewTreeViewId, () => this.retry(stage, active, service)));
  }

  public changesetFiles(changesetId: number): Stage<IReviewComparison> {
    const known = this.changesetStages.get(changesetId);
    if (known) {
      return known;
    }
    const active = this.current;
    const service = active && this.service(active.workspaceId);
    if (!active || !service || active.files.state !== "ready" || active.changesets.state !== "ready") {
      return IDLE;
    }
    const changeset = active.changesets.value.items.find(item => item.id === changesetId);
    if (!changeset) {
      return IDLE;
    }
    const files = active.files.value;
    this.changesetStages.set(changesetId, LOADING);
    void this.track(() => service.changesetComparison(files, changeset)).then(
      comparison => this.setChangesetStage(files, changesetId, { state: "ready", value: comparison }),
      error => {
        this.log(`Couldn't load the files of cs:${changesetId}: ${errorText(error)}`);
        this.setChangesetStage(files, changesetId, { message: errorText(error), state: "error" });
      });
    return LOADING;
  }

  public retryChangesetFiles(changesetId: number): void {
    if (this.changesetStages.get(changesetId)?.state !== "error") {
      return;
    }
    this.changesetStages.delete(changesetId);
    this.changesetFiles(changesetId);
    this.activeChanged.fire();
  }

  /** The loaded comparisons of the active review: the final one and every loaded changeset. */
  public loadedComparisons(): IReviewComparison[] {
    const active = this.current;
    if (!active || active.files.state !== "ready") {
      return [];
    }
    const comparisons = [active.files.value.final];
    this.changesetStages.forEach(stage => {
      if (stage.state === "ready" && !comparisons.includes(stage.value)) {
        comparisons.push(stage.value);
      }
    });
    return comparisons;
  }

  /** The next page of the Changesets list; a second request while one loads is ignored. */
  public async loadMoreChangesets(): Promise<void> {
    const active = this.current;
    const service = active && this.service(active.workspaceId);
    if (!active || !service || active.files.state !== "ready" || active.changesets.state !== "ready" ||
      !active.changesets.value.hasMore || this.loadingMoreChangesets) {
      return;
    }
    const generation = this.generation;
    const files = active.files.value;
    const shown = active.changesets.value;
    this.moreChangesetsFrom = shown;
    this.activeChanged.fire();
    let more: IReviewChangesets | undefined;
    try {
      more = await this.track(() => this.ui.progress(reviewTreeViewId, () => service.moreChangesets(files, shown)));
    } catch (error) {
      if (generation === this.generation) {
        this.ui.error(`Couldn't load more changesets: ${errorText(error)}`);
      }
    }
    if (this.moreChangesetsFrom === shown) {
      this.moreChangesetsFrom = undefined;
    }
    if (more && generation === this.generation && this.current?.changesets.state === "ready" &&
      this.current.changesets.value === shown) {
      this.update({ changesets: { state: "ready", value: more }});
    } else {
      this.activeChanged.fire();
    }
  }

  /**
   * Loads every stage of the active review again. The loaded values stay on
   * screen until their replacements arrive, so tree rows keep their ids and
   * expansion; open diffs keep their pinned comparisons.
   */
  public async reload(): Promise<void> {
    const active = this.current;
    const service = active && this.service(active.workspaceId);
    if (!active || !service) {
      return;
    }
    const generation = ++this.generation;
    await this.track(() => this.ui.progress(reviewTreeViewId, async () => {
      let review = active.review;
      try {
        review = await service.review(active.review.id) ?? review;
      } catch (error) {
        this.log(`Couldn't read review #${active.review.id} again: ${errorText(error)}`);
      }
      if (generation !== this.generation) {
        return;
      }
      this.update({ review, updates: undefined });
      await this.loadStages(generation, service, true);
    }));
  }

  /**
   * Changes a review's status. Marking a review Reviewed while change requests
   * are pending or files are unviewed asks first, as does marking one whose
   * counts cannot be known; nothing is written unless the user confirms.
   *
   * With experimental posting on, a cm user who can be added to the reviewers
   * (see `reviewerBlock`) is added first: straight away when the workspace has
   * a connection, otherwise after asking, in one dialog with any Reviewed
   * warning. An add of the user to the review already in flight, from Add Me
   * as Reviewer, stands in for that one: its end is awaited and no second
   * request goes out. A failed add asks before the status is set anyway. The
   * review is read back afterwards, and a failed write leaves every displayed
   * status as it was.
   */
  public async setStatus(workspaceId: string, review: IReview, status: ReviewStatus): Promise<IReview | undefined> {
    const service = this.service(workspaceId);
    if (!service) {
      throw new Error("This review's Plastic workspace is no longer open.");
    }
    if (sameStatus(review.status, status)) {
      return undefined;
    }
    const join = await this.joinPlan(workspaceId, review, service);
    const warning = status === "Reviewed" ? await this.reviewedWarning(workspaceId, review, service) : undefined;
    // The Reviewed warning, in a dialog that asks about something else first.
    const also = warning && `Marking it Reviewed: ${warning}`;
    let user: string | undefined;
    if (join.kind === "ask") {
      const choice = await this.ui.choose(`You're not a reviewer on #${review.id}. Add yourself first?`,
        joinLines(also, "Adding yourself needs a Unity user token, which Configure Experimental Posting… saves."),
        [ CONFIGURE_AND_ADD, WITHOUT_ADDING ]);
      if (choice === CONFIGURE_AND_ADD && !await this.configureReviewers()) {
        return undefined;
      }
      if (choice !== CONFIGURE_AND_ADD && choice !== WITHOUT_ADDING) {
        return undefined;
      }
      user = choice === CONFIGURE_AND_ADD ? join.user : undefined;
    } else if (join.kind === "unable") {
      const title = `Couldn't add you as a reviewer on review #${review.id}.`;
      if (await this.ui.choose(title, joinLines(join.reason, also), [SET_ANYWAY]) !== SET_ANYWAY) {
        return undefined;
      }
    } else {
      user = join.kind === "add" ? join.user : undefined;
      const detail = warning && (user ? `${warning} You will be added as a reviewer first.` : warning);
      if (detail && !await this.ui.confirm(`Mark review #${review.id} as Reviewed?`, detail, "Mark Reviewed")) {
        return undefined;
      }
    }
    let added = false;
    let claim: IAddClaim | undefined;
    try {
      if (user !== undefined) {
        claim = this.claimAdd(workspaceId, review.id);
        // Undefined while Add Me as Reviewer adds the user already: how that add ended stands for this one.
        const failure = claim
          ? await this.addUser(claim, workspaceId, review.id, user)
          : await this.adds.get(addKey(workspaceId, review.id))?.ended;
        if (failure && (failure.cancelled || await this.ui.choose(
          `Couldn't add you as a reviewer on review #${review.id}.`, failure.message, [SET_ANYWAY]) !== SET_ANYWAY)) {
          return undefined;
        }
        added = !failure;
      }
      const fresh = await this.writeStatus(workspaceId, review, status, service);
      if (added) {
        // The request row, and the status row when the write went through.
        await this.reloadDiscussions(workspaceId, review.id);
      }
      return fresh;
    } finally {
      if (claim) {
        this.releaseAdd(workspaceId, review.id, claim);
      }
    }
  }

  /**
   * Add Me as Reviewer, once the caller has made sure experimental posting can
   * work in this workspace. The review's author, its assignee and anyone
   * already requested are told why not instead, as is a second click while
   * the first add is in flight. Afterwards the open review's discussions load
   * again, which draws the new reviewer card, and Needs My Review loads again
   * when the review now belongs in it. A failure is shown and changes nothing.
   * Resolves true once added.
   */
  public async addMe(workspaceId: string, review: IReview): Promise<boolean> {
    const service = this.service(workspaceId);
    if (!service) {
      throw new Error("This review's Plastic workspace is no longer open.");
    }
    // Claimed before cm is asked anything, so that a second click cannot pass the same checks meanwhile.
    const claim = this.claimAdd(workspaceId, review.id);
    if (!claim) {
      this.ui.info(`You're already being added as a reviewer on review #${review.id}.`);
      return false;
    }
    const failed = (message: string) => {
      this.ui.error(`Couldn't add you as a reviewer on review #${review.id}: ${message}`);
      return false;
    };
    try {
      let joining: { user: string; block?: ReviewerBlock };
      try {
        joining = await this.joining(workspaceId, review, service);
      } catch (error) {
        this.log(`Couldn't add you as a reviewer on review #${review.id}: ${errorText(error)}`);
        return failed(errorText(error));
      }
      const { block, user } = joining;
      if (block) {
        this.ui.info(BLOCKED[block](review.id));
        return false;
      }
      if (!isEmailAddress(user)) {
        this.log(`Couldn't add you as a reviewer on review #${review.id}: ${notAnAddress(user)}`);
        return failed(notAnAddress(user));
      }
      const failure = await this.addUser(claim, workspaceId, review.id, user);
      if (failure) {
        return failure.cancelled ? false : failed(failure.message);
      }
      this.ui.status(`$(person-add) Added you as a reviewer on review #${review.id}`);
      if (workspaceId === this.selected) {
        this.refreshNeedsMyReview(review);
      }
      await this.reloadDiscussions(workspaceId, review.id);
      return true;
    } finally {
      this.releaseAdd(workspaceId, review.id, claim);
    }
  }

  /**
   * Whether the cm user can be added to the active review's reviewers (see
   * `reviewerBlock`): false until cm has said who the user is and the
   * discussions have loaded, and while an add to the review is in flight. The
   * first ask asks cm; `onDidChangeCanAddMe` fires once it has answered.
   */
  public canAddMe(): boolean {
    const active = this.current;
    if (!active || active.discussions.state !== "ready" ||
      this.adds.has(addKey(active.workspaceId, active.review.id))) {
      return false;
    }
    const user = this.whoami(active);
    return user !== undefined && reviewerBlock(active.discussions.value.timeline, active.review, user) === undefined;
  }

  public isViewed(file: IChangesetFileChange): boolean {
    const key = this.viewedKey();
    return key !== undefined && this.viewed.isViewed(key, file);
  }

  /** How many of `files` are viewed in the active review. */
  public viewedCount(files: readonly IChangesetFileChange[]): number {
    const key = this.viewedKey();
    return key === undefined ? 0 : this.viewed.count(key, files);
  }

  public setViewed(files: readonly IChangesetFileChange[], viewed: boolean): void {
    const key = this.viewedKey();
    if (key === undefined || !files.length) {
      return;
    }
    this.viewed.set(key, files, viewed)
      .then(undefined, error => this.log(`Couldn't save viewed files: ${errorText(error)}`));
    // VS Code's Memento holds the new value as soon as `update` is called; only the disk write is later.
    this.viewedChanged.fire();
    this.refreshOverview(this.current);
  }

  /** What the review editors need for the active review; threads stay empty until discussions load. */
  public editorContext(): IReviewEditorContext | undefined {
    const active = this.current;
    const service = active && this.service(active.workspaceId);
    if (!active || !service) {
      return undefined;
    }
    return {
      files: active.files.state === "ready" ? active.files.value : undefined,
      review: active.review,
      service,
      threads: active.discussions.state === "ready" ? active.discussions.value.threads : [],
    };
  }

  /** Tells the session which review views are on screen; polling runs only while one is. */
  public setViewVisible(viewId: string, visible: boolean): void {
    if (visible) {
      this.visibleViews.add(viewId);
    } else {
      this.visibleViews.delete(viewId);
    }
    if (this.visibleViews.size && !this.disposed) {
      this.timer = this.timer ?? setInterval(() => void this.poll(), this.pollInterval);
    } else {
      this.stopPolling();
    }
  }

  /**
   * One poll: the queue when the Reviews view is visible, and what changed in
   * the active review when the Review or Discussions view or its Overview is.
   * Skipped while a user operation runs, so a click never waits behind it for
   * long. A failed poll only writes to the output channel.
   */
  public async poll(): Promise<void> {
    if (this.busyCount > 0 || this.polling || this.disposed) {
      return;
    }
    this.polling = true;
    try {
      if (this.visibleViews.has(reviewListViewId)) {
        await this.pollList();
      }
      const reviewShown = [ reviewTreeViewId, discussionsViewId, overviewViewId ].some(id => this.visibleViews.has(id));
      if (this.busyCount === 0 && reviewShown) {
        await this.pollActive();
      }
    } finally {
      this.polling = false;
    }
  }

  /** Runs a user operation; polls skip while any is in flight. */
  public async track<T>(task: () => Thenable<T>): Promise<T> {
    this.busyCount++;
    try {
      return await task();
    } finally {
      this.busyCount--;
    }
  }

  /**
   * The Overview document of a review; only the active review has one. Its
   * links open threads and file rows through `overviewLink`, and the cm user
   * is marked once `cm whoami` has answered: asked here the first time, after
   * which the Overview is drawn again. With experimental posting on, a user
   * who can be added to the reviewers is offered a link that does it; the
   * link carries `linkKey`.
   */
  public overview(workspaceId: string, reviewId: number): string {
    const active = this.current;
    if (!active || active.workspaceId !== workspaceId || active.review.id !== reviewId) {
      return `# Review #${reviewId}\n\nOpen this review in Plastic Reviews to see its overview.\n`;
    }
    const link = this.options.overviewLink;
    return renderOverview(active, {
      addMe: !!this.options.reviewers?.settingOn() && this.canAddMe(),
      isViewed: file => this.isViewed(file),
      link: link && (target => link({
        ...(target.kind === "addMeAsReviewer" ? { key: this.linkKey } : {}),
        reviewId,
        target,
        workspaceId,
      })),
      now: this.now(),
      whoami: this.whoami(active),
    });
  }

  private workspace(workspaceId: string | undefined): IReviewWorkspace | undefined {
    return workspaceId === undefined ? undefined : this.options.workspaces().find(wk => wk.id === workspaceId);
  }

  private async loadGroup(key: ReviewGroupKey, nextPage: boolean, announce = true): Promise<void> {
    const workspaceId = this.selected;
    const service = workspaceId === undefined ? undefined : this.service(workspaceId);
    if (!service) {
      return;
    }
    const generation = this.listGeneration;
    const keys = PERSONAL.includes(key) ? PERSONAL : [key];
    keys.forEach(other => this.setGroup(other, { loadingMore: nextPage, stage: LOADING }));
    if (announce) {
      this.fireList(key);
    }
    try {
      await this.track(() => this.ui.progress(reviewListViewId, async () => {
        if (PERSONAL.includes(key)) {
          await this.loadQueue(service, generation);
        } else {
          const shown = nextPage ? this.group(key).reviews : [];
          const page = await (key === "allOpen" ? service.allOpen(shown.length) : service.allReviews(shown.length));
          if (generation === this.listGeneration) {
            const known = new Set(shown.map(review => review.id));
            this.setLoaded(key, shown.concat(page.filter(review => !known.has(review.id))), page.length === PAGE_SIZE);
          }
        }
      }));
    } catch (error) {
      if (generation !== this.listGeneration) {
        return;
      }
      this.failGroups(keys, error);
    }
    if (generation === this.listGeneration) {
      this.fireList(key);
    }
  }

  /**
   * The personal groups from two independent loads: Needs My Review, and the
   * author's own reviews (Rework Requested and Waiting for Reviewers). One
   * failing never blanks the other; each part shows its own error.
   */
  private async loadQueue(service: ReviewService, generation: number): Promise<void> {
    const [ needs, owned ] = await Promise.all([ settle(service.needsMyReview()), settle(service.ownedQueue()) ]);
    if (generation !== this.listGeneration) {
      return;
    }
    if ("value" in needs) {
      this.setLoaded("needsMyReview", needs.value, false);
    } else {
      this.failGroups(["needsMyReview"], needs.error);
    }
    if ("value" in owned) {
      this.setLoaded("reworkRequested", owned.value.reworkRequested, false);
      this.setLoaded("waitingForReviewers", owned.value.waitingForReviewers, false);
    } else {
      this.failGroups([ "reworkRequested", "waitingForReviewers" ], owned.error);
    }
  }

  private failGroups(keys: readonly ReviewGroupKey[], error: unknown): void {
    this.log(`Couldn't load reviews: ${errorText(error)}`);
    const stage: Stage<void> = { message: errorText(error), state: "error" };
    keys.forEach(key => this.setGroup(key, { loadingMore: false, stage }));
  }

  private setLoaded(key: ReviewGroupKey, reviews: readonly IReview[], hasMore: boolean): void {
    const stage: Stage<void> = { state: "ready", value: undefined };
    this.setGroup(key, { hasMore, loadedOnce: true, loadingMore: false, reviews, stage });
  }

  private setGroup(key: ReviewGroupKey, patch: Partial<IReviewGroup>): void {
    this.groups.set(key, { ...this.group(key), ...patch, key });
  }

  private fireList(key: ReviewGroupKey): void {
    this.listChanged.fire(PERSONAL.includes(key) ? undefined : key);
  }

  private async pollList(): Promise<void> {
    const workspaceId = this.selected;
    const service = workspaceId === undefined ? undefined : this.service(workspaceId);
    if (!service || !PERSONAL.every(key => this.group(key).loadedOnce && this.group(key).stage.state === "ready")) {
      return;
    }
    const generation = this.listGeneration;
    const [ needs, owned ] = await Promise.all([ settle(service.needsMyReview()), settle(service.ownedQueue()) ]);
    if (generation !== this.listGeneration || PERSONAL.some(key => this.group(key).stage.state === "loading")) {
      return;
    }
    const fresh: Partial<IReviewQueue> = {};
    for (const part of [ needs, owned ]) {
      if ("error" in part) {
        this.log(`Review queue poll failed: ${errorText(part.error)}`);
      }
    }
    if ("value" in needs) {
      fresh.needsMyReview = needs.value;
    }
    if ("value" in owned) {
      Object.assign(fresh, owned.value);
    }
    const changed = PERSONAL.filter(key => {
      const reviews = fresh[key as keyof IReviewQueue];
      return reviews && !sameReviews(this.group(key).reviews, reviews);
    });
    if (changed.length) {
      // Find Review… may lack a review assigned since it loaded.
      this.found = undefined;
      changed.forEach(key => this.setLoaded(key, fresh[key as keyof IReviewQueue]!, false));
      this.listChanged.fire(undefined);
    }
  }

  private async pollActive(): Promise<void> {
    const active = this.current;
    const service = active && this.service(active.workspaceId);
    if (!active || !service || active.files.state === "loading" || active.discussions.state === "loading") {
      return;
    }
    const generation = this.generation;
    const files = active.files.state === "ready" ? active.files.value : undefined;
    const discussions = active.discussions.state === "ready" ? active.discussions.value : undefined;
    try {
      const updates = await service.checkUpdates(active.review, files, discussions);
      if (generation !== this.generation || this.current !== active) {
        return;
      }
      if (JSON.stringify(updates) !== JSON.stringify(active.updates)) {
        this.update({ updates });
      }
    } catch (error) {
      this.log(`Review #${active.review.id} update check failed: ${errorText(error)}`);
    }
  }

  private stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Files, then discussions (their paths use the file rows), then changesets
   * (which need the branch and head the files stage pinned). A failed files
   * stage leaves the changesets idle until it is retried. With `keep`, loaded
   * values stay until their replacements arrive.
   */
  private async loadStages(generation: number, service: ReviewService, keep: boolean): Promise<void> {
    const files = await this.loadFiles(generation, service, keep);
    if (generation !== this.generation) {
      return;
    }
    await this.loadDiscussions(generation, service, files, keep);
    if (generation !== this.generation) {
      return;
    }
    if (files) {
      await this.loadChangesets(generation, service, files, keep);
    } else {
      this.update({ changesets: IDLE });
    }
  }

  private async loadFiles(
      generation: number,
      service: ReviewService,
      keep: boolean): Promise<IReviewFiles | undefined> {
    const active = this.current!;
    const isCurrent = () => generation === this.generation && !this.disposed;
    if (!keep || active.files.state !== "ready") {
      this.update({ files: LOADING });
    }
    try {
      const files = await service.loadFiles(active.review, isCurrent);
      if (!isCurrent()) {
        return undefined;
      }
      this.changesetStages.clear();
      this.update({ files: { state: "ready", value: files }});
      return files;
    } catch (error) {
      if (isCurrent() && !isReviewLoadCancelled(error)) {
        this.log(`Couldn't load the changes of review #${active.review.id}: ${errorText(error)}`);
        this.changesetStages.clear();
        this.update({ files: { message: errorText(error), state: "error" }});
      }
      return undefined;
    }
  }

  private async loadDiscussions(
      generation: number,
      service: ReviewService,
      files: IReviewFiles | undefined,
      keep: boolean): Promise<void> {
    const active = this.current!;
    const isCurrent = () => generation === this.generation && !this.disposed;
    if (!keep || active.discussions.state !== "ready") {
      this.update({ discussions: LOADING });
    }
    try {
      const discussions: IReviewDiscussions = await service.loadDiscussions(active.review, files, isCurrent);
      if (isCurrent()) {
        this.update({ discussions: { state: "ready", value: discussions }});
      }
    } catch (error) {
      if (isCurrent() && !isReviewLoadCancelled(error)) {
        this.log(`Couldn't load the discussions of review #${active.review.id}: ${errorText(error)}`);
        this.update({ discussions: { message: errorText(error), state: "error" }});
      }
    }
  }

  private async loadChangesets(
      generation: number,
      service: ReviewService,
      files: IReviewFiles,
      keep: boolean): Promise<void> {
    const active = this.current!;
    if (!keep || active.changesets.state !== "ready") {
      this.update({ changesets: LOADING });
    }
    try {
      const changesets: IReviewChangesets = await service.loadChangesets(active.review, files);
      if (generation === this.generation) {
        this.update({ changesets: { state: "ready", value: changesets }});
      }
    } catch (error) {
      if (generation === this.generation) {
        this.log(`Couldn't load the changesets of review #${active.review.id}: ${errorText(error)}`);
        this.update({ changesets: { message: errorText(error), state: "error" }});
      }
    }
  }

  /**
   * An activation that failed before it replaced the active review (Open by ID
   * with a mistyped number, an unreachable server) still claimed a generation,
   * so the stages the active review was loading dropped their results. Those
   * stages load again under the failed activation's generation, unless a newer
   * activation, reload or close took over meanwhile.
   */
  private resumeAfterFailedActivation(generation: number): void {
    const active = this.current;
    const service = active && this.service(active.workspaceId);
    const unfinished = (state: string) => state === "loading" || state === "idle";
    if (!active || !service || generation !== this.generation ||
      ![ active.files, active.discussions, active.changesets ].some(stage => stage.state === "loading")) {
      return;
    }
    void this.track(() => this.ui.progress(reviewTreeViewId, async () => {
      let files = active.files.state === "ready" ? active.files.value : undefined;
      if (unfinished(active.files.state)) {
        files = await this.loadFiles(generation, service, false);
      }
      if (generation !== this.generation) {
        return;
      }
      if (unfinished(this.current!.discussions.state)) {
        await this.loadDiscussions(generation, service, files, false);
      }
      if (generation === this.generation && files && unfinished(this.current!.changesets.state)) {
        await this.loadChangesets(generation, service, files, false);
      }
    }));
  }

  private async retry(
      stage: "files" | "discussions" | "changesets",
      active: IActiveReview,
      service: ReviewService): Promise<void> {
    const generation = this.generation;
    if (stage === "files") {
      const files = await this.loadFiles(generation, service, false);
      if (!files || generation !== this.generation) {
        return;
      }
      if (this.current?.discussions.state === "error") {
        await this.loadDiscussions(generation, service, files, false);
      }
      if (generation === this.generation && this.current?.changesets.state !== "ready") {
        await this.loadChangesets(generation, service, files, false);
      }
      return;
    }
    const files = active.files.state === "ready" ? active.files.value : undefined;
    if (stage === "discussions") {
      await this.loadDiscussions(generation, service, files, false);
    } else if (files) {
      await this.loadChangesets(generation, service, files, false);
    }
  }

  /**
   * Keyed by the files stage the load started from, not the generation: a
   * reload that keeps those files must still see its changesets finish, and one
   * that replaces them clears the stages anyway.
   */
  private setChangesetStage(files: IReviewFiles, changesetId: number, stage: Stage<IReviewComparison>): void {
    const active = this.current;
    if (!active || active.files.state !== "ready" || active.files.value !== files) {
      return;
    }
    this.changesetStages.set(changesetId, stage);
    this.activeChanged.fire();
  }

  /** Replaces the active review, tells the editors and the views; an Overview of the previous one says it closed. */
  private setActive(active: IActiveReview | undefined): void {
    const previous = this.current;
    this.current = active;
    this.changesetStages.clear();
    if (!active && !previous) {
      return;
    }
    this.options.editors?.setContext(this.editorContext());
    [ previous, active ].forEach(review => this.refreshOverview(review));
    this.activeChanged.fire();
  }

  private update(patch: Partial<IActiveReview>): void {
    const active = this.current;
    if (!active) {
      return;
    }
    this.current = { ...active, ...patch };
    this.options.editors?.setContext(this.editorContext());
    this.refreshOverview(active);
    this.activeChanged.fire();
  }

  /** Draws a review's Overview again, if it is open; the editors coalesce a burst of these. */
  private refreshOverview(review: IActiveReview | undefined): void {
    if (review) {
      this.options.editors?.refreshOverview(review.workspaceId, review.review.id);
    }
  }

  /** The cm user, once known; the first ask redraws the Overview and fires `onDidChangeCanAddMe` when cm answers. */
  private whoami(active: IActiveReview): string | undefined {
    const service = this.service(active.workspaceId);
    if (service && service.knownUser === undefined) {
      service.whoami().then(
        () => {
          this.refreshOverview(this.openReview(active.workspaceId, active.review.id));
          this.canAddMeChanged.fire();
        },
        error => this.log(`Couldn't ask cm who the user is: ${errorText(error)}`));
    }
    return service?.knownUser;
  }

  /** Puts a re-read review everywhere it is shown: the active header and every list row. */
  private applyReview(workspaceId: string, fresh: IReview): void {
    const active = this.current;
    if (active && active.workspaceId === workspaceId && active.review.id === fresh.id) {
      const updates = active.updates && { ...active.updates, status: undefined };
      const pending = !!updates &&
        (updates.newHead !== undefined || updates.newComments > 0 || updates.removedComments > 0);
      this.update({ review: fresh, updates: pending ? updates : undefined });
    }
    if (workspaceId !== this.selected) {
      return;
    }
    let changed = false;
    this.groups.forEach((group, key) => {
      if (group.reviews.some(review => review.id === fresh.id)) {
        this.setGroup(key, { reviews: group.reviews.map(review => review.id === fresh.id ? fresh : review) });
        changed = true;
      }
    });
    if (changed) {
      this.listChanged.fire(undefined);
    }
  }

  /**
   * The queue after a status write, which decides a review's personal group
   * and whether All Open lists it. The personal groups load again, once they
   * have loaded. All Reviews lists a review whatever its status and
   * `applyReview` already put the new one on its row, so it keeps its pages.
   * All Open loads again while it shows no more than its first page, which
   * loses nothing; deeper, it keeps its pages and only leaves out a review now
   * Reviewed (one opened again waits for Refresh). Find Review… asks cm again.
   */
  private refreshAfterStatus(fresh: IReview): void {
    this.found = undefined;
    const personal = PERSONAL.map(key => this.group(key).stage.state);
    if (personal.some(state => state !== "idle") && !personal.includes("loading")) {
      void this.loadGroup("needsMyReview", false);
    }
    const open = this.group("allOpen");
    if (!open.loadedOnce || open.stage.state === "loading") {
      return;
    }
    if (open.reviews.length <= PAGE_SIZE) {
      void this.loadGroup("allOpen", false);
    } else if (sameStatus(fresh.status, "Reviewed") && open.reviews.some(review => review.id === fresh.id)) {
      this.setGroup("allOpen", { reviews: open.reviews.filter(review => review.id !== fresh.id) });
      this.listChanged.fire("allOpen");
    }
  }

  /** The branch names `findReviews` needs; failed queries leave them unnamed and are logged. */
  private async branchNames(
      service: ReviewService,
      reviews: readonly IReview[]): Promise<ReadonlyMap<number, string>> {
    const ids = reviews.map(review => unnamedBranchId(review)).filter((id): id is number => id !== undefined);
    if (!ids.length) {
      return new Map();
    }
    try {
      return await service.branchNames(ids);
    } catch (error) {
      this.log(`Couldn't name the branches of Find Review…'s reviews: ${errorText(error)}`);
      return new Map();
    }
  }

  /**
   * Why marking a review Reviewed deserves a second look; undefined when
   * nothing is left. The open review answers from its stages; any other review
   * (Set Review Status… on a Reviews row) costs one comment query, and a count
   * that cannot be known is said rather than skipped.
   */
  private async reviewedWarning(
      workspaceId: string,
      review: IReview,
      service: ReviewService): Promise<string | undefined> {
    const parts: string[] = [];
    const open = this.openReview(workspaceId, review.id);
    let threads: readonly IReviewThread[] | undefined =
      open?.discussions.state === "ready" ? open.discussions.value.threads : undefined;
    if (!threads) {
      try {
        threads = await this.track(() => service.threads(review));
      } catch (error) {
        this.log(`Couldn't count the pending change requests of review #${review.id}: ${errorText(error)}`);
      }
    }
    if (threads) {
      const pending = threadCounts(threads).pending;
      if (pending) {
        parts.push(`${pending} change request${pending === 1 ? " is" : "s are"} still pending.`);
      }
    } else {
      parts.push("Its discussions could not be read, so pending change requests are unknown.");
    }
    // Asked again: another review may have been opened while the comments loaded.
    const current = this.openReview(workspaceId, review.id);
    if (current?.files.state === "ready") {
      const changes = viewableRows(scopeRows(current.files.value, "changes"));
      const unviewed = changes.length - this.viewedCount(changes);
      if (unviewed) {
        const files = `${formatCount(changes.length)} file${changes.length === 1 ? "" : "s"}`;
        parts.push(`${formatCount(unviewed)} of ${files} ${unviewed === 1 ? "is" : "are"} not viewed.`);
      }
    } else {
      parts.push(current
        ? "Its files have not loaded yet, so unviewed files are unknown."
        : "It is not the open review, so unviewed files are unknown.");
    }
    return parts.join(" ") || undefined;
  }

  /** The active review when it is this one. */
  private openReview(workspaceId: string, reviewId: number): IActiveReview | undefined {
    const active = this.current;
    return active && active.workspaceId === workspaceId && active.review.id === reviewId ? active : undefined;
  }

  /** The status write: read back, shown everywhere, and the queue follows. A failure is shown. */
  private async writeStatus(
      workspaceId: string,
      review: IReview,
      status: ReviewStatus,
      service: ReviewService): Promise<IReview | undefined> {
    let fresh: IReview;
    try {
      fresh = await this.track(() => this.ui.progress(reviewTreeViewId, () => service.setStatus(review.id, status)));
    } catch (error) {
      this.log(`Couldn't set review #${review.id} to ${status}: ${errorText(error)}`);
      this.ui.error(`Couldn't set review #${review.id} to ${status}: ${errorText(error)}`);
      return undefined;
    }
    this.applyReview(workspaceId, fresh);
    const icon = fresh.status === "Reviewed" ? "$(pass) " : "";
    this.ui.status(`${icon}Review #${fresh.id} marked ${fresh.status}`);
    // The row may belong in another group now; the queue follows without losing the pages shown.
    if (workspaceId === this.selected) {
      this.refreshAfterStatus(fresh);
    }
    return fresh;
  }

  /**
   * The cm user, and why they cannot be added to the review's reviewers when
   * they cannot. The open review answers from its discussions; any other
   * review costs one comment query. Rejects when cm cannot say.
   */
  private async joining(
      workspaceId: string,
      review: IReview,
      service: ReviewService): Promise<{ user: string; block?: ReviewerBlock }> {
    const user = await this.track(() => service.whoami());
    const open = this.openReview(workspaceId, review.id);
    const timeline = open?.discussions.state === "ready"
      ? open.discussions.value.timeline
      : await this.track(() => service.timeline(review));
    return { block: reviewerBlock(timeline, review, user), user };
  }

  /**
   * Whether Set Review Status… adds the cm user to the reviewers first: only
   * while experimental posting is on and can work in the workspace, and only
   * for a user who can be added. Otherwise cm is asked nothing more. When cm
   * cannot say, the status is set as it would be without posting, and the
   * output channel says why.
   */
  private async joinPlan(workspaceId: string, review: IReview, service: ReviewService): Promise<JoinPlan> {
    const reviewers = this.options.reviewers;
    if (!reviewers) {
      return { kind: "none" };
    }
    let access: ReviewerAccess;
    let joining: { user: string; block?: ReviewerBlock };
    try {
      access = await reviewers.access(workspaceId);
      if (access.state === "settingOff" || access.state === "blocked") {
        return { kind: "none" };
      }
      joining = await this.joining(workspaceId, review, service);
    } catch (error) {
      this.log(`Couldn't tell whether you are a reviewer on review #${review.id}: ${errorText(error)}`);
      return { kind: "none" };
    }
    if (joining.block) {
      return { kind: "none" };
    }
    if (!isEmailAddress(joining.user)) {
      return { kind: "unable", reason: notAnAddress(joining.user) };
    }
    return { kind: access.state === "ready" ? "add" : "ask", user: joining.user };
  }

  /**
   * Adds the cm user under a notification that can cancel it; resolves why
   * not, or undefined once added, and records the same in `claim`.
   */
  private async addUser(
      claim: IAddClaim,
      workspaceId: string,
      reviewId: number,
      user: string): Promise<IAddFailure | undefined> {
    const reviewers = this.options.reviewers;
    let token: CancellationToken | undefined;
    claim.failure = undefined;
    try {
      if (!reviewers) {
        throw new Error("Experimental posting is not available here.");
      }
      await this.track(() => this.ui.cancellable(`Adding you as a reviewer on review #${reviewId}…`, cancel => {
        token = cancel;
        return reviewers.add(workspaceId, reviewId, user, cancel);
      }));
    } catch (error) {
      this.log(`Couldn't add you as a reviewer on review #${reviewId}: ${errorText(error)}`);
      claim.failure = { cancelled: !!token?.isCancellationRequested, message: errorText(error) };
    }
    return claim.failure;
  }

  /**
   * Claims the add of the cm user to a review until `releaseAdd`, which comes
   * once the open review shows the result; `canAddMe` is false meanwhile.
   * Undefined while another add holds the claim.
   */
  private claimAdd(workspaceId: string, reviewId: number): IAddClaim | undefined {
    const key = addKey(workspaceId, reviewId);
    if (this.adds.has(key)) {
      return undefined;
    }
    let end!: (failure: IAddFailure | undefined) => void;
    const ended = new Promise<IAddFailure | undefined>(resolve => {
      end = resolve;
    });
    const claim: IAddClaim = {
      end, ended, failure: { cancelled: false, message: "Add Me as Reviewer stopped before it sent anything." },
    };
    this.adds.set(key, claim);
    this.addsChanged(workspaceId, reviewId);
    return claim;
  }

  /** Ends a claim from `claimAdd`: a Set Review Status… waiting on it learns how the add went. */
  private releaseAdd(workspaceId: string, reviewId: number, claim: IAddClaim): void {
    this.adds.delete(addKey(workspaceId, reviewId));
    claim.end(claim.failure);
    this.addsChanged(workspaceId, reviewId);
  }

  /** An add started or ended: the open review's Add me link and button follow. */
  private addsChanged(workspaceId: string, reviewId: number): void {
    const open = this.openReview(workspaceId, reviewId);
    if (open && !this.disposed) {
      this.refreshOverview(open);
      this.canAddMeChanged.fire();
    }
  }

  /** Configure Experimental Posting…, from Set Review Status…; a failure is shown. Resolves true once saved. */
  private async configureReviewers(): Promise<boolean> {
    try {
      return !!await this.options.reviewers?.configure();
    } catch (error) {
      this.ui.error(`Couldn't configure experimental posting: ${errorText(error)}`);
      return false;
    }
  }

  /**
   * Loads the open review's discussions again, timeline included, when it is
   * this review; the other stages stay as they are. While the discussions are
   * still loading, the whole review loads again instead, so that a load which
   * started before the change cannot land last.
   */
  private async reloadDiscussions(workspaceId: string, reviewId: number): Promise<void> {
    const active = this.openReview(workspaceId, reviewId);
    const service = active && this.service(workspaceId);
    if (!active || !service) {
      return;
    }
    if (active.discussions.state === "loading") {
      await this.reload();
      return;
    }
    const generation = this.generation;
    const files = active.files.state === "ready" ? active.files.value : undefined;
    await this.track(() => this.ui.progress(reviewTreeViewId,
      () => this.loadDiscussions(generation, service, files, true)));
  }

  /**
   * Needs My Review after the cm user joined a review that now belongs in it:
   * under review and not listed there yet. It loads again once the personal
   * groups have loaded, as after a status write.
   */
  private refreshNeedsMyReview(review: IReview): void {
    const personal = PERSONAL.map(key => this.group(key).stage.state);
    const listed = this.group("needsMyReview").reviews.some(row => row.id === review.id);
    if (sameStatus(review.status, "Under review") && !listed && personal.some(state => state !== "idle") &&
      !personal.includes("loading")) {
      void this.loadGroup("needsMyReview", false);
    }
  }

  private viewedKey(): string | undefined {
    const active = this.current;
    if (!active) {
      return undefined;
    }
    // The repository, not the workspace: two workspaces of one repository share what was viewed.
    const repository = this.repository(active.workspaceId) ?? `workspace:${active.workspaceId}`;
    return reviewKey(repository, active.review.id);
  }

  private lastReviews(): ILastReviews {
    const value = this.options.workspaceState.get<ILastReviews>(LAST_REVIEW_KEY);
    return value && typeof value === "object" ? value : {};
  }

  private rememberReview(workspaceId: string, reviewId: number): void {
    if (this.lastReviews()[workspaceId] !== reviewId) {
      void this.options.workspaceState.update(LAST_REVIEW_KEY, { ...this.lastReviews(), [workspaceId]: reviewId });
    }
  }

  private forgetReview(workspaceId: string, reviewId: number): void {
    const saved = { ...this.lastReviews() };
    if (saved[workspaceId] === reviewId) {
      delete saved[workspaceId];
      void this.options.workspaceState.update(LAST_REVIEW_KEY, saved);
    }
  }

  private log(message: string): void {
    this.options.channel.appendLine(`Plastic Reviews: ${message}`);
  }
}

function sameReviews(a: readonly IReview[], b: readonly IReview[]): boolean {
  return a.length === b.length && a.every((review, index) => JSON.stringify(review) === JSON.stringify(b[index]));
}

/** The non-empty parts, a line each. */
function joinLines(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join("\n");
}

/** Why the hosted API cannot take the cm user as a reviewer. */
function notAnAddress(user: string): string {
  return `cm names you "${user}", which is not an e-mail address, and the review service names reviewers by ` +
    "e-mail address.";
}

function defaultUi(): IReviewSessionUi {
  return {
    cancellable: (title, task) => window.withProgress(
      { cancellable: true, location: ProgressLocation.Notification, title }, (_progress, cancel) => task(cancel)),
    choose: (message, detail, actions) => window.showWarningMessage(message, { detail, modal: true }, ...actions),
    confirm: async (message, detail, action) =>
      await window.showWarningMessage(message, { detail, modal: true }, action) === action,
    error: message => {
      void window.showErrorMessage(message, "Show Output").then(choice => {
        if (choice) {
          void commands.executeCommand("plastic-scm.showOutput");
        }
      });
    },
    info: message => {
      void window.showInformationMessage(message);
    },
    progress: (viewId, task) => window.withProgress({ location: { viewId }}, task),
    status: message => {
      window.setStatusBarMessage(message, 4000);
    },
  };
}
