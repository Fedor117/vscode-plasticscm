import { CmShell, ICmShell } from "../cm/shell";
import { DiffChangeset, FindChangesets, FindMerges, ListLabels } from "../cm/commands";
import { Disposable, Event, EventEmitter, OutputChannel } from "vscode";
import { IChangesetFileChange, IHistoryChangeset, ILabelInfo, IMergeLink, WkConfigType } from "../models";
import { IConfig, IShellConfig } from "../config";
import { describeError } from "../commands/scmUtils";
import { Workspace } from "../workspace";

/** Changesets fetched per page, across every branch. */
export const EXPLORER_PAGE_SIZE = 300;

/** Labels drawn on the graph; a repository with more than this shows the newest ones. */
export const EXPLORER_LABEL_LIMIT = 1000;

/** Matches a repository search returns at most. */
export const EXPLORER_SEARCH_LIMIT = 200;

/** Changesets whose file list is kept; the oldest entry is dropped beyond this. */
const FILES_CACHE_SIZE = 50;

export type ExplorerStatus = "idle" | "loading" | "ready" | "error";

export type ExplorerShellFactory = (dir: string, channel: OutputChannel, config: IShellConfig) => ICmShell;

/**
 * The changesets, merge links and labels of one workspace's repository, loaded
 * newest first across every branch, a page at a time.
 *
 * It runs on its own cm shell where it can, so a page of history never queues
 * behind a status refresh or a long switch on the workspace's shell.
 */
export class BranchExplorerData implements Disposable {
  public readonly onDidChange: Event<void>;

  public get workspace(): Workspace {
    return this.mWorkspace;
  }

  public get status(): ExplorerStatus {
    return this.mStatus;
  }

  /** Why the last load failed; only set with status `error`. */
  public get message(): string | undefined {
    return this.mMessage;
  }

  public get changesets(): readonly IHistoryChangeset[] {
    return this.mChangesets;
  }

  public get merges(): readonly IMergeLink[] {
    return this.mMerges;
  }

  public get labels(): readonly ILabelInfo[] {
    return this.mLabels;
  }

  /** True while older changesets exist that are not loaded. */
  public get hasMore(): boolean {
    return this.mHasMore;
  }

  public get isLoadingMore(): boolean {
    return this.mLoadingMore;
  }

  /**
   * The branch the workspace is on. On a changeset or a label the workspace
   * names no branch, so it is the branch of the loaded changeset, when loaded.
   */
  public get currentBranch(): string | undefined {
    const config = this.mWorkspace.workspaceConfig;
    if (config?.configType === WkConfigType.Branch) {
      return config.location;
    }
    const current = this.mWorkspace.currentChangeset;
    return this.mChangesets.find(changeset => changeset.id === current)?.branch;
  }

  private readonly mWorkspace: Workspace;
  private readonly mChannel: OutputChannel;
  private readonly mGetConfig: () => IConfig;
  private readonly mShellFactory: ExplorerShellFactory;
  private readonly mOnDidChange = new EventEmitter<void>();
  private readonly mFiles = new Map<number, Promise<IChangesetFileChange[]>>();

  private mChangesets: IHistoryChangeset[] = [];
  private mMerges: IMergeLink[] = [];
  private mLabels: ILabelInfo[] = [];
  private mStatus: ExplorerStatus = "idle";
  private mMessage?: string;
  private mHasMore = false;
  private mLoadingMore = false;
  /** Bumped by every full load, so a slower, older one cannot overwrite it. */
  private mGeneration = 0;
  private mShellStarted?: Promise<void>;
  private mShell?: ICmShell;
  private mOwnShell?: ICmShell;
  private mbIsDisposed = false;

  public constructor(
      workspace: Workspace,
      channel: OutputChannel,
      getConfig: () => IConfig,
      shellFactory?: ExplorerShellFactory) {
    this.mWorkspace = workspace;
    this.mChannel = channel;
    this.mGetConfig = getConfig;
    this.mShellFactory = shellFactory ?? ((dir, ch, cfg) => new CmShell(dir, ch, cfg));
    this.onDidChange = this.mOnDidChange.event;
  }

  public dispose(): void {
    if (this.mbIsDisposed) {
      return;
    }
    this.mbIsDisposed = true;
    this.mOnDidChange.dispose();
    if (this.mOwnShell) {
      const shell = this.mOwnShell;
      const disposeShell = (): void => {
        shell.dispose();
      };
      // Dispose only after stop settles: dispose kills the process while stop is still writing `exit` to it.
      void shell.stop().then(disposeShell, disposeShell);
    }
  }

  /** Loads the newest page from scratch, with the merge links and labels that go with it. */
  public async load(): Promise<void> {
    const generation = ++this.mGeneration;
    this.mStatus = "loading";
    this.mMessage = undefined;
    this.mLoadingMore = false;
    this.fire();

    try {
      const shell = await this.shell();
      const page = await FindChangesets.runRepository(shell, { limit: EXPLORER_PAGE_SIZE + 1 });
      const changesets = page.slice(0, EXPLORER_PAGE_SIZE);
      const [ merges, labels ] = await Promise.all([
        this.findMerges(shell, changesets),
        this.findLabels(shell),
      ]);
      if (generation !== this.mGeneration || this.mbIsDisposed) {
        return;
      }

      this.mChangesets = changesets;
      this.mMerges = merges;
      this.mLabels = labels;
      this.mHasMore = page.length > EXPLORER_PAGE_SIZE;
      this.mFiles.clear();
      this.mStatus = "ready";
    } catch (e) {
      if (generation !== this.mGeneration || this.mbIsDisposed) {
        return;
      }
      this.mStatus = "error";
      this.mMessage = describeError(e);
      this.mChannel.appendLine(`Unable to load the Branch Explorer: ${this.mMessage}`);
    }
    this.fire();
  }

  /** Appends the next older page. Rejects when cm fails; the loaded rows stay. */
  public async loadMore(): Promise<void> {
    if (this.mLoadingMore || !this.mHasMore || this.mStatus !== "ready" || this.mChangesets.length === 0) {
      return;
    }

    const generation = this.mGeneration;
    const oldest = this.mChangesets[this.mChangesets.length - 1].id;
    this.mLoadingMore = true;
    this.fire();

    try {
      const shell = await this.shell();
      const page = await FindChangesets.runRepository(
        shell, { beforeChangesetId: oldest, limit: EXPLORER_PAGE_SIZE + 1 });
      const changesets = page.slice(0, EXPLORER_PAGE_SIZE);
      const merges = await this.findMerges(shell, changesets, oldest);
      if (generation !== this.mGeneration || this.mbIsDisposed) {
        return;
      }

      this.mChangesets = this.mChangesets.concat(changesets);
      this.mMerges = this.mMerges.concat(merges);
      this.mHasMore = page.length > EXPLORER_PAGE_SIZE;
    } finally {
      if (generation === this.mGeneration) {
        this.mLoadingMore = false;
        this.fire();
      }
    }
  }

  /**
   * Picks up changesets created since the last load (a checkin, a colleague's
   * work) without dropping the pages already loaded. Does nothing before the
   * first load. Failures are logged: this runs unasked, after a status refresh.
   */
  public async loadNewer(): Promise<void> {
    if (this.mStatus !== "ready" || this.mChangesets.length === 0) {
      return;
    }

    const generation = this.mGeneration;
    const newest = this.mChangesets[0].id;
    try {
      const shell = await this.shell();
      const newer = await FindChangesets.runRepository(
        shell, { afterChangesetId: newest, limit: EXPLORER_PAGE_SIZE + 1 });
      if (generation !== this.mGeneration || this.mbIsDisposed || newer.length === 0) {
        return;
      }
      if (newer.length > EXPLORER_PAGE_SIZE) {
        // More arrived than a page holds: there would be a gap between it and
        // what is loaded, so start over from the top instead.
        await this.load();
        return;
      }

      const [ merges, labels ] = await Promise.all([ this.findMerges(shell, newer), this.findLabels(shell) ]);
      if (generation !== this.mGeneration || this.mbIsDisposed) {
        return;
      }
      this.mChangesets = newer.concat(this.mChangesets);
      this.mMerges = merges.concat(this.mMerges);
      this.mLabels = labels;
      this.fire();
    } catch (e) {
      this.mChannel.appendLine(`Unable to check the Branch Explorer for new changesets: ${describeError(e)}`);
    }
  }

  /** Cached per changeset; a failed query is forgotten so the next request retries it. */
  public getFiles(changesetId: number): Promise<IChangesetFileChange[]> {
    const cached = this.mFiles.get(changesetId);
    if (cached) {
      return cached;
    }

    const promise = this.shell().then(shell => DiffChangeset.run(shell, changesetId));
    this.mFiles.set(changesetId, promise);
    if (this.mFiles.size > FILES_CACHE_SIZE) {
      const oldest = this.mFiles.keys().next();
      if (!oldest.done) {
        this.mFiles.delete(oldest.value);
      }
    }
    void promise.then(undefined, () => {
      if (this.mFiles.get(changesetId) === promise) {
        this.mFiles.delete(changesetId);
      }
    });
    return promise;
  }

  /** The loaded row when there is one; otherwise asks cm (a search result may be older than the loaded window). */
  public async getChangeset(changesetId: number): Promise<IHistoryChangeset | undefined> {
    const loaded = this.mChangesets.find(changeset => changeset.id === changesetId);
    if (loaded) {
      return loaded;
    }
    return FindChangesets.runById(await this.shell(), changesetId);
  }

  /**
   * Searches the whole repository, not just the loaded window: by number for
   * `123` or `cs:123`, otherwise for changesets whose comment contains the text.
   */
  public async search(text: string): Promise<IHistoryChangeset[]> {
    const shell = await this.shell();
    const id = parseChangesetId(text);
    if (id !== undefined) {
      const changeset = await FindChangesets.runById(shell, id);
      return changeset ? [changeset] : [];
    }
    return FindChangesets.runRepository(shell, { commentContains: text, limit: EXPLORER_SEARCH_LIMIT });
  }

  private async findMerges(
      shell: ICmShell,
      changesets: readonly IHistoryChangeset[],
      beforeChangesetId?: number): Promise<IMergeLink[]> {
    if (changesets.length === 0) {
      return [];
    }
    const oldest = changesets[changesets.length - 1].id;
    try {
      return await FindMerges.runRange(shell, oldest, beforeChangesetId);
    } catch (e) {
      // The graph is still worth showing without its merge lines.
      this.mChannel.appendLine(`Unable to load the merge links of the Branch Explorer: ${describeError(e)}`);
      return [];
    }
  }

  private async findLabels(shell: ICmShell): Promise<ILabelInfo[]> {
    try {
      return (await ListLabels.run(shell, { limit: EXPLORER_LABEL_LIMIT })).items;
    } catch (e) {
      this.mChannel.appendLine(`Unable to load the labels of the Branch Explorer: ${describeError(e)}`);
      return [];
    }
  }

  private fire(): void {
    if (!this.mbIsDisposed) {
      this.mOnDidChange.fire();
    }
  }

  private async shell(): Promise<ICmShell> {
    if (!this.mShellStarted) {
      this.mShellStarted = this.startShell();
    }
    await this.mShellStarted;
    return this.mShell ?? this.mWorkspace.shell;
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

    if (!started || this.mbIsDisposed) {
      if (started) {
        const disposeShell = (): void => {
          shell.dispose();
        };
        void shell.stop().then(disposeShell, disposeShell);
      } else {
        shell.dispose();
        this.mChannel.appendLine(
          `Unable to start a cm shell for the Branch Explorer of ${this.mWorkspace.info.name}; `
          + "sharing the workspace shell instead.");
      }
      this.mShell = this.mWorkspace.shell;
      return;
    }

    this.mOwnShell = shell;
    this.mShell = shell;
  }
}

/** `123` or `cs:123` as a changeset number; undefined for anything else. */
export function parseChangesetId(text: string): number | undefined {
  const match = /^\s*(?:cs:)?(\d{1,9})\s*$/i.exec(text);
  return match ? parseInt(match[1], 10) : undefined;
}
