import { buildGraphModel, IGraphModel, ILaneInput } from "./graphModel";
import { CmShell, ICmShell } from "../cm/shell";
import { DiffChangeset, FindBranch, FindChangesets, FindMerges } from "../cm/commands";
import { Disposable, Event, EventEmitter, OutputChannel } from "vscode";
import { IBranchInfo, IChangesetFileChange, IHistoryChangeset, IMergeLink, WkConfigType } from "../models";
import { IConfig, IShellConfig } from "../config";
import { describeError } from "../commands/scmUtils";
import { Workspace } from "../workspace";

export type HistoryStatus = "idle" | "loading" | "ready" | "error" | "unsupported";

export type ShellFactory = (workingDir: string, channel: OutputChannel, config: IShellConfig) => ICmShell;

const UNSUPPORTED_MESSAGE = "Switch the workspace to a branch or a changeset to see its history.";

/** `cm find branch` per lane is a server round trip; status runs on every save, so it cannot follow status 1:1. */
const NEWER_CHECK_INTERVAL_MILLIS = 60 * 1000;

/**
 * Bounds the "keep paging until the workspace's changeset is visible" walk, so an
 * old changeset on a long branch cannot turn one refresh into dozens of queries.
 * It is a ceiling on the rows a lane may reach, not a count of extra queries: a
 * reload asks for what the lane already held, and counting pages from there
 * would let every reload dig `MAX_AUTO_PAGES` deeper than the last.
 */
const MAX_AUTO_PAGES = 5;

/** Used when the setting is missing or malformed; matches the `package.json` default. */
const DEFAULT_PAGE_SIZE = 50;

/** What the workspace pointed at when the history was loaded; any difference makes the history stale. */
interface ILoadedPosition {
  readonly changeset: number;
  readonly configType: WkConfigType;
  readonly location: string;
}

interface ILanePage {
  readonly changesets: IHistoryChangeset[];
  readonly hasMore: boolean;
}

/**
 * Loads and pages the changeset history of one workspace: the current branch,
 * its parent branch, and the merge links between them.
 *
 * Runs on its own cm shell: the workspace shell serializes everything, so a slow
 * history query would otherwise sit in front of every status refresh and checkin.
 */
export class WorkspaceHistory implements Disposable {
  public get workspace(): Workspace {
    return this.mWorkspace;
  }

  public get status(): HistoryStatus {
    return this.mStatus;
  }

  /** Error or unsupported text for the user. */
  public get message(): string | undefined {
    return this.mMessage;
  }

  public get model(): IGraphModel | undefined {
    return this.mModel;
  }

  /** True when the workspace moved (branch or changeset) since the last load. */
  public get isStale(): boolean {
    return this.mStatus === "idle" || this.mbIsStale;
  }

  public get currentBranch(): string | undefined {
    return this.mCurrentBranch;
  }

  public readonly onDidChange: Event<void>;

  private readonly mWorkspace: Workspace;
  private readonly mChannel: OutputChannel;
  private readonly mGetConfig: () => IConfig;
  private readonly mShellFactory: ShellFactory;
  private readonly mNow: () => number;
  private readonly mOnDidChange: EventEmitter<void>;
  private readonly mStatusSubscription: Disposable;
  private readonly mFiles = new Map<number, Promise<IChangesetFileChange[]>>();

  private mStatus: HistoryStatus = "idle";
  private mMessage?: string;
  private mModel?: IGraphModel;
  private mCurrentBranch?: string;
  private mLanes: ILaneInput[] = [];
  private mMerges: IMergeLink[] = [];
  private mLoaded?: ILoadedPosition;
  private mbIsStale = false;
  private mbIsDisposed = false;

  /**
   * Bumped by every load; an async step whose captured value no longer matches
   * belongs to a superseded load and must not write anything back.
   */
  private mGeneration = 0;
  private mLoadPromise?: Promise<void>;
  private mbReloadRequested = false;
  private mLastNewerCheck?: number;

  /**
   * Resolves once `mShell` is set, deliberately not with the shell itself: resolving
   * a promise with an object probes its `then`, which a strict mock rejects.
   */
  private mShellStarted?: Promise<void>;
  /** The shell in use: ours once started, the workspace's when ours failed to start. */
  private mShell?: ICmShell;
  /** Only set for a shell this instance created and therefore owns. */
  private mOwnShell?: ICmShell;

  /**
   * @param shellFactory Creates the history's own cm shell; defaults to a real `CmShell`.
   * @param now Clock for the `checkForNewer` rate limit; injectable so tests can move time.
   */
  public constructor(
      workspace: Workspace,
      channel: OutputChannel,
      getConfig: () => IConfig,
      shellFactory?: ShellFactory,
      now?: () => number) {
    this.mWorkspace = workspace;
    this.mChannel = channel;
    this.mGetConfig = getConfig;
    this.mShellFactory = shellFactory ?? ((dir, ch, cfg) => new CmShell(dir, ch, cfg));
    this.mNow = now ?? (() => Date.now());
    this.mOnDidChange = new EventEmitter<void>();
    this.onDidChange = this.mOnDidChange.event;
    this.mStatusSubscription = workspace.onDidRunStatus(() => this.onDidRunStatus());
  }

  public dispose(): void {
    this.mbIsDisposed = true;
    // Anything still in flight compares against this and drops its result.
    this.mGeneration += 1;
    this.mStatusSubscription.dispose();

    const shell = this.mOwnShell;
    this.mOwnShell = undefined;
    if (shell) {
      this.stopAndDispose(shell);
    }
    this.mOnDidChange.dispose();
  }

  /**
   * (Re)loads both lanes. A call while a load is running does not start a second
   * one: the running load is finished first and a single extra pass runs after it.
   */
  public load(clearFiles = false): Promise<void> {
    if (clearFiles) {
      this.mFiles.clear();
    }

    if (this.mLoadPromise) {
      this.mbReloadRequested = true;
      return this.mLoadPromise;
    }

    this.mLoadPromise = this.runLoads();
    return this.mLoadPromise;
  }

  public async loadMore(branch: string): Promise<void> {
    const index = this.mLanes.findIndex(lane => lane.branch === branch);
    const lane: ILaneInput | undefined = this.mLanes[index];
    const oldest: IHistoryChangeset | undefined = lane ? lane.changesets[lane.changesets.length - 1] : undefined;
    if (this.mStatus === "loading" || !lane || !lane.hasMore || lane.loading || !oldest) {
      return;
    }

    const generation = this.mGeneration;
    const pageSize = this.pageSize();
    this.setLane(index, { ...lane, error: undefined, loading: true });
    this.notify();

    try {
      await this.ensureShell();
      const shell = this.requireShell();
      const more = await FindChangesets.run(shell, { beforeChangesetId: oldest.id, branch, limit: pageSize });
      if (!this.isCurrent(generation)) {
        return;
      }

      // Re-read: another lane's "Load more" may have replaced entries meanwhile.
      const current = this.mLanes[index];
      this.setLane(index, {
        ...current,
        changesets: current.changesets.concat(more),
        hasMore: more.length === pageSize,
        loading: false,
      });
      this.notify();

      await this.refreshMerges(shell, generation);
      this.notify();
    } catch (e) {
      if (!this.isCurrent(generation)) {
        return;
      }
      const message = describeError(e);
      this.mChannel.appendLine(`ERROR: loading more changesets on ${branch} failed: ${message}`);
      this.setLane(index, { ...this.mLanes[index], error: message, loading: false });
      this.notify();
    }
  }

  /** Cached per changeset; a failed query is forgotten so the next expand retries it. */
  public getFiles(changesetId: number): Promise<IChangesetFileChange[]> {
    const cached = this.mFiles.get(changesetId);
    if (cached) {
      return cached;
    }

    const promise = this.ensureShell().then(() => DiffChangeset.run(this.requireShell(), changesetId));
    this.mFiles.set(changesetId, promise);
    void promise.then(undefined, () => {
      // Identity check: `load(true)` may have cleared the cache and a newer
      // query may already sit under this id.
      if (this.mFiles.get(changesetId) === promise) {
        this.mFiles.delete(changesetId);
      }
    });
    return promise;
  }

  /** The loaded row when there is one; otherwise asks cm, so commands still work after a reload dropped it. */
  public async getChangeset(changesetId: number): Promise<IHistoryChangeset | undefined> {
    for (const lane of this.mLanes) {
      const loaded = lane.changesets.find(changeset => changeset.id === changesetId);
      if (loaded) {
        return loaded;
      }
    }

    await this.ensureShell();
    return FindChangesets.runById(this.requireShell(), changesetId);
  }

  /** Refreshes each lane's head id so the view can offer a refresh; at most once a minute. */
  public async checkForNewer(): Promise<void> {
    if (this.mbIsDisposed || this.mLoadPromise || this.mLanes.length === 0) {
      return;
    }

    const now = this.mNow();
    if (this.mLastNewerCheck !== undefined && now - this.mLastNewerCheck < NEWER_CHECK_INTERVAL_MILLIS) {
      return;
    }
    this.mLastNewerCheck = now;

    const generation = this.mGeneration;
    await this.ensureShell();
    const shell = this.requireShell();
    // Snapshot the names: a concurrent "Load more" replaces lane entries.
    const branches = this.mLanes.map(lane => lane.branch);
    for (const branch of branches) {
      try {
        const info = await FindBranch.run(shell, branch);
        if (!this.isCurrent(generation)) {
          return;
        }
        const index = this.mLanes.findIndex(lane => lane.branch === branch);
        if (info && index >= 0) {
          this.setLane(index, { ...this.mLanes[index], headChangesetId: info.headChangesetId });
        }
      } catch (e) {
        this.mChannel.appendLine(`Unable to check ${branch} for new changesets: ${describeError(e)}`);
      }
    }

    if (this.isCurrent(generation)) {
      this.notify();
    }
  }

  private async runLoads(): Promise<void> {
    try {
      do {
        this.mbReloadRequested = false;
        await this.loadOnce();
      } while (this.mbReloadRequested && !this.mbIsDisposed);
    } finally {
      this.mLoadPromise = undefined;
    }
  }

  private async loadOnce(): Promise<void> {
    const generation = ++this.mGeneration;
    const position = this.currentPosition();
    const previousLanes = this.mLanes;

    // The old model stays visible until the first lane of the new one arrives.
    this.mLoaded = position;
    this.mbIsStale = false;
    this.mStatus = "loading";
    this.mMessage = undefined;
    this.notify();

    try {
      await this.ensureShell();
      const shell = this.requireShell();
      const branch = await this.resolveBranch(shell, position);
      if (!this.isCurrent(generation)) {
        return;
      }

      if (!branch) {
        this.mCurrentBranch = undefined;
        this.mLanes = [];
        this.mMerges = [];
        this.mStatus = "unsupported";
        this.mMessage = UNSUPPORTED_MESSAGE;
        this.notify();
        return;
      }

      if (branch !== this.mCurrentBranch) {
        // Rows of another branch would only be misleading while the new ones load.
        this.mCurrentBranch = branch;
        this.mLanes = [];
        this.mMerges = [];
        this.notify();
      }

      const branchInfo = await this.lookupBranch(shell, branch);
      if (!this.isCurrent(generation)) {
        return;
      }

      const parentBranch = branchInfo?.parent;
      const limitOf = (name: string): number => {
        const previous = previousLanes.find(lane => lane.branch === name);
        return Math.max(this.pageSize(), previous?.changesets.length ?? 0);
      };

      const page = await this.fetchLane(shell, branch, limitOf(branch), position.changeset);
      if (!this.isCurrent(generation)) {
        return;
      }

      const lanes: ILaneInput[] = [{
        branch,
        changesets: page.changesets,
        hasMore: page.hasMore,
        headChangesetId: branchInfo?.headChangesetId,
        loading: false,
      }];
      if (parentBranch) {
        lanes.push({ branch: parentBranch, changesets: [], hasMore: false, loading: true });
      } else {
        this.mMerges = [];
      }
      this.mLanes = lanes;
      this.notify();

      if (parentBranch) {
        await this.loadParentLane(shell, generation, parentBranch, limitOf(parentBranch), position.changeset);
        if (!this.isCurrent(generation)) {
          return;
        }
        this.notify();

        await this.refreshMerges(shell, generation);
        if (!this.isCurrent(generation)) {
          return;
        }
      }

      this.mStatus = "ready";
      this.notify();
    } catch (e) {
      if (!this.isCurrent(generation)) {
        return;
      }
      this.mStatus = "error";
      this.mMessage = describeError(e);
      this.mChannel.appendLine(`ERROR: loading the history of ${this.mWorkspace.info.name} failed: ${this.mMessage}`);
      this.notify();
    }
  }

  private async resolveBranch(shell: ICmShell, position: ILoadedPosition): Promise<string | undefined> {
    if (position.changeset < 0) {
      return undefined;
    }

    switch (position.configType) {
    case WkConfigType.Branch:
      return position.location || undefined;
    case WkConfigType.Changeset:
    case WkConfigType.Label: {
      const changeset = await FindChangesets.runById(shell, position.changeset);
      return changeset?.branch || undefined;
    }
    default:
      return undefined;
    }
  }

  /** A missing parent only costs the second lane, so a failed lookup is logged, not fatal. */
  private async lookupBranch(shell: ICmShell, branch: string): Promise<IBranchInfo | undefined> {
    try {
      return await FindBranch.run(shell, branch);
    } catch (e) {
      this.mChannel.appendLine(`Unable to look up the parent of ${branch}: ${describeError(e)}`);
      return undefined;
    }
  }

  /**
   * Fetches the first page and, when `ensureId` is expected on this branch but not
   * in it, keeps paging so the workspace's changeset is marked in the graph.
   */
  private async fetchLane(shell: ICmShell, branch: string, limit: number, ensureId?: number): Promise<ILanePage> {
    const pageSize = this.pageSize();
    let changesets = await FindChangesets.run(shell, { branch, limit });
    let hasMore = changesets.length === limit;

    const isMissing = (): boolean => {
      const present = changesets.some(changeset => changeset.id === ensureId);
      if (ensureId === undefined || changesets.length === 0 || present) {
        return false;
      }
      // Ids grow monotonically: once the oldest loaded id is below the target,
      // older pages cannot contain it (it lives on another branch).
      return changesets[changesets.length - 1].id > ensureId;
    };

    const maxRows = Math.max(limit, pageSize * MAX_AUTO_PAGES);
    while (hasMore && changesets.length < maxRows && isMissing()) {
      const oldest = changesets[changesets.length - 1];
      const more = await FindChangesets.run(shell, { beforeChangesetId: oldest.id, branch, limit: pageSize });
      changesets = changesets.concat(more);
      hasMore = more.length === pageSize;
    }

    return { changesets, hasMore };
  }

  /**
   * The parent lane is paged past the workspace's changeset too: rows older than
   * the parent's oldest loaded changeset are held back, so the current changeset
   * only shows once the parent lane has been loaded that far.
   */
  private async loadParentLane(
      shell: ICmShell, generation: number, branch: string, limit: number, ensureBelowId: number): Promise<void> {
    try {
      const page = await this.fetchLane(shell, branch, limit, ensureBelowId);
      if (!this.isCurrent(generation)) {
        return;
      }
      this.setLane(1, { branch, changesets: page.changesets, hasMore: page.hasMore, loading: false });
    } catch (e) {
      if (!this.isCurrent(generation)) {
        return;
      }
      const message = describeError(e);
      this.mChannel.appendLine(`ERROR: loading the changesets of ${branch} failed: ${message}`);
      this.setLane(1, { branch, changesets: [], error: message, hasMore: false, loading: false });
    }
  }

  /**
   * Merge links are decoration: when the query fails the rows stay and the
   * previous links (still valid for the loaded ids) are kept.
   */
  private async refreshMerges(shell: ICmShell, generation: number): Promise<void> {
    // One lane is enough: a merge from a branch that has no lane is still drawn,
    // as a stub on the changeset it produced.
    if (this.mLanes.length === 0 || !this.mCurrentBranch) {
      return;
    }

    let oldestId: number | undefined;
    for (const lane of this.mLanes) {
      for (const changeset of lane.changesets) {
        if (oldestId === undefined || changeset.id < oldestId) {
          oldestId = changeset.id;
        }
      }
    }
    if (oldestId === undefined) {
      return;
    }

    try {
      const merges = await FindMerges.run(shell, this.mCurrentBranch, oldestId);
      if (this.isCurrent(generation)) {
        this.mMerges = merges;
      }
    } catch (e) {
      this.mChannel.appendLine(`Unable to load the merge links of ${this.mCurrentBranch}: ${describeError(e)}`);
    }
  }

  private ensureShell(): Promise<void> {
    if (!this.mShellStarted) {
      this.mShellStarted = this.startShell();
    }
    return this.mShellStarted;
  }

  private requireShell(): ICmShell {
    if (!this.mShell) {
      throw new Error("The history shell has not been started.");
    }
    return this.mShell;
  }

  private async startShell(): Promise<void> {
    const shell = this.mShellFactory(
      this.mWorkspace.info.path, this.mChannel, this.mGetConfig().cmConfiguration);
    let started = false;

    try {
      started = await shell.start();
    } catch (e) {
      this.mChannel.appendLine(`ERROR: ${describeError(e)}`);
    }

    if (started && this.mbIsDisposed) {
      this.stopAndDispose(shell);
      this.mShell = this.mWorkspace.shell;
      return;
    }

    if (!started) {
      shell.dispose();
      this.mChannel.appendLine(
        `Unable to start a cm shell for the history of ${this.mWorkspace.info.name}; `
        + "sharing the workspace shell instead.");
      this.mShell = this.mWorkspace.shell;
      return;
    }

    this.mOwnShell = shell;
    this.mShell = shell;
  }

  /** Dispose only after stop settles: dispose kills the process while stop is still writing `exit` to it. */
  private stopAndDispose(shell: ICmShell): void {
    const disposeShell = (): void => {
      shell.dispose();
    };
    void shell.stop().then(disposeShell, disposeShell);
  }

  private onDidRunStatus(): void {
    if (!this.mLoaded || this.mbIsStale) {
      return;
    }

    const position = this.currentPosition();
    if (position.location !== this.mLoaded.location
        || position.configType !== this.mLoaded.configType
        || position.changeset !== this.mLoaded.changeset) {
      this.mbIsStale = true;
      this.notify();
    }
  }

  private currentPosition(): ILoadedPosition {
    const config = this.mWorkspace.workspaceConfig;
    return {
      changeset: this.mWorkspace.currentChangeset,
      configType: config?.configType ?? WkConfigType.Unknown,
      location: config?.location ?? "",
    };
  }

  private pageSize(): number {
    const pageSize = this.mGetConfig().history.pageSize;
    return Number.isInteger(pageSize) && pageSize > 0 ? pageSize : DEFAULT_PAGE_SIZE;
  }

  private isCurrent(generation: number): boolean {
    return generation === this.mGeneration && !this.mbIsDisposed;
  }

  private setLane(index: number, lane: ILaneInput): void {
    const lanes = this.mLanes.slice();
    lanes[index] = lane;
    this.mLanes = lanes;
  }

  /** Every state change rebuilds the model, so `model` is never out of step with the lanes. */
  private notify(): void {
    if (this.mbIsDisposed) {
      return;
    }

    this.mModel = this.mCurrentBranch && this.mLanes.length > 0 && this.mLoaded
      ? buildGraphModel({
        currentBranch: this.mCurrentBranch,
        currentChangesetId: this.mLoaded.changeset,
        lanes: this.mLanes,
        merges: this.mMerges,
      })
      : undefined;
    this.mOnDidChange.fire();
  }
}
