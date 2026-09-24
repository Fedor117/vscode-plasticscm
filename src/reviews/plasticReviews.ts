import {
  commands,
  Disposable,
  env,
  Memento,
  OutputChannel,
  SecretStorage,
  Tab,
  TreeView,
  Uri,
  window,
  workspace,
} from "vscode";
import { DiscussionNode, DiscussionsProvider, discussionsViewId } from "./discussionsProvider";
import { execFileCm, ITokenCm, ReviewTokens } from "./reviewTokens";
import { FILE_LAYOUT_SETTING, IReviewSessionOptions, IReviewWorkspace, ReviewSession } from "./reviewSession";
import { fileKey, IReviewComparison } from "./models";
import { IReviewFileAt, isOverviewTab, overviewTabReview, overviewViewId, ReviewEditors } from "./reviewEditors";
import { IReviewPostingOptions, ReviewPosting } from "./reviewPosting";
import { ReviewListNode, ReviewListProvider, reviewListViewId } from "./reviewListProvider";
import { ReviewTreeNode, ReviewTreeProvider, reviewTreeViewId, scopeKey } from "./reviewTreeProvider";
import { IShellConfig } from "../config";
import { ReviewActions } from "./reviewActions";
import { ReviewDecorations } from "./reviewDecorations";
import { reviewLinkUri } from "./reviewLinks";

/** Every context key Plastic Reviews sets; package.json `when` clauses may use no other `plastic-scm.reviews.*` key. */
export const CONTEXT_KEYS = {
  activeEditorIsOverview: "plastic-scm.reviews.activeEditorIsOverview",
  activeEditorIsReviewFile: "plastic-scm.reviews.activeEditorIsReviewFile",
  activeFileViewed: "plastic-scm.reviews.activeFileViewed",
  canAddMeAsReviewer: "plastic-scm.reviews.canAddMeAsReviewer",
  hasAccessToken: "plastic-scm.reviews.hasAccessToken",
  hasActiveReview: "plastic-scm.reviews.hasActiveReview",
  hasUpdates: "plastic-scm.reviews.hasUpdates",
  isBranchReview: "plastic-scm.reviews.isBranchReview",
  multipleWorkspaces: "plastic-scm.reviews.multipleWorkspaces",
  postingEnabled: "plastic-scm.reviews.postingEnabled",
} as const;

/** What Plastic Reviews needs from the extension. */
export interface IPlasticReviewsHost {
  readonly channel: OutputChannel;
  readonly secrets?: SecretStorage;
  /** The extension's id, as its context names it; the Overview's links address the URI handler with it. */
  readonly extensionId: string;
  readonly globalState: Memento;
  readonly workspaceState: Memento;
  workspaces(): readonly IReviewWorkspace[];
  shellConfig(): IShellConfig;
  /** Test injection: fake services, a UI that answers by itself. */
  readonly session?: Partial<IReviewSessionOptions>;
  /** Test injection: the experimental setting, trust and a writer on a fake transport. */
  readonly posting?: IReviewPostingOptions;
  /** Test injection: the cm that makes access tokens; by default the configured cm, through `execFile`. */
  readonly tokenCm?: ITokenCm;
}

/** Comparisons whose decorations stay registered, so tabs opened before a reload keep their letters. */
const MAX_DECORATED = 16;

/**
 * The composition root of Plastic Reviews: the session, the three tree views
 * of the Plastic Reviews container, the review editors and their decorations,
 * experimental posting, the commands and the URI handler behind the Overview's
 * links. It keeps the views' badges, titles and descriptions and the
 * `plastic-scm.reviews.*` context keys in step with the session and the active
 * editor, and reveals a newly active review file in the Review view.
 */
export class PlasticReviews implements Disposable {
  public readonly session: ReviewSession;
  public readonly editors: ReviewEditors;
  public readonly posting: ReviewPosting;
  public readonly actions: ReviewActions;
  private readonly decorations: ReviewDecorations;
  private readonly listProvider: ReviewListProvider;
  private readonly treeProvider: ReviewTreeProvider;
  private readonly discussionsProvider: DiscussionsProvider;
  private readonly listView: TreeView<ReviewListNode>;
  private readonly treeView: TreeView<ReviewTreeNode>;
  private readonly discussionsView: TreeView<DiscussionNode>;
  private readonly disposables: Disposable[] = [];
  private readonly keys = new Map<string, unknown>();
  private decorated: { identity?: string; comparisons: IReviewComparison[] } = { comparisons: [] };
  /** Whether every file of Changes was viewed, per review, to notice the moment the last one is. */
  private progress?: { identity: string; complete: boolean };
  /** The review file the active editor showed when last checked; the Review view reveals it only when it changes. */
  private revealed?: string;

  public constructor(host: IPlasticReviewsHost) {
    this.editors = new ReviewEditors({
      overview: (workspaceId, reviewId) => this.session.overview(workspaceId, reviewId),
      resolveService: workspaceId => this.session.service(workspaceId),
    });
    const links = { authority: host.extensionId, scheme: env.uriScheme };
    this.session = new ReviewSession({
      channel: host.channel,
      editors: this.editors,
      globalState: host.globalState,
      overviewLink: link => reviewLinkUri(links, link),
      // Experimental posting is created below; it only answers once the session asks.
      reviewers: {
        access: workspaceId => this.posting.access(workspaceId),
        add: (workspaceId, reviewId, cancel) => this.posting.addReviewer(workspaceId, reviewId, cancel),
        consent: workspaceId => this.posting.consent(workspaceId),
        setStatus: (workspaceId, reviewId, status) => this.posting.setMyStatus(workspaceId, reviewId, status),
        settingOn: () => this.posting.settingOn(),
      },
      shellConfig: () => host.shellConfig(),
      workspaceState: host.workspaceState,
      workspaces: () => host.workspaces(),
      ...host.session,
    });
    this.decorations = new ReviewDecorations();
    // Never the shared cm shell: it logs what cm prints, and `cm accesstoken reveal` prints the token.
    const tokens = host.secrets && new ReviewTokens(host.secrets, host.globalState,
      host.tokenCm ?? execFileCm(() => host.shellConfig().cmPath));
    this.posting = new ReviewPosting(tokens, {
      repository: workspaceId => this.session.repository(workspaceId),
      user: workspaceId => this.session.service(workspaceId)?.whoami() ??
        Promise.reject(new Error("The review workspace is no longer available.")),
    }, this.editors, host.posting);
    this.listProvider = new ReviewListProvider(this.session);
    this.treeProvider = new ReviewTreeProvider(this.session);
    this.discussionsProvider = new DiscussionsProvider(this.session);
    this.listView = window.createTreeView(reviewListViewId, { treeDataProvider: this.listProvider });
    // No Collapse All on the Review and Discussions views: their headers carry the review's own actions only.
    this.treeView = window.createTreeView(reviewTreeViewId, {
      manageCheckboxStateManually: true,
      treeDataProvider: this.treeProvider,
    });
    this.discussionsView = window.createTreeView(discussionsViewId, { treeDataProvider: this.discussionsProvider });
    this.actions = new ReviewActions({
      afterOpen: () => this.onEditorChanged(),
      channel: host.channel,
      editors: this.editors,
      posting: this.posting,
      session: this.session,
      tree: this.treeProvider,
    });
    this.registerUriHandler(host.channel);

    this.disposables.push(
      this.listView.onDidChangeVisibility(event => this.onVisibility(reviewListViewId, event.visible)),
      this.treeView.onDidChangeVisibility(event => this.onVisibility(reviewTreeViewId, event.visible)),
      this.discussionsView.onDidChangeVisibility(event => this.onVisibility(discussionsViewId, event.visible)),
      this.session.onDidChangeList(() => this.onListChanged()),
      this.session.onDidChangeActive(() => this.onActiveChanged()),
      this.session.onDidChangeViewed(() => this.onViewedChanged()),
      this.session.onDidChangeWorkspace(() => this.onWorkspaceChanged()),
      this.session.onDidChangeCanAddMe(() => this.updateReviewerKey()),
      this.posting.onDidChange(() => this.onPostingChanged()),
      this.treeView.onDidChangeCheckboxState(event => this.treeProvider.handleCheckboxes(event)),
      window.onDidChangeActiveTextEditor(() => this.onEditorChanged()),
      window.tabGroups.onDidChangeTabs(() => this.onEditorChanged()),
      window.tabGroups.onDidChangeTabGroups(() => this.onEditorChanged()),
      workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration(FILE_LAYOUT_SETTING)) {
          this.treeProvider.refresh();
        }
      }));

    this.onWorkspaceChanged();
    this.onActiveChanged();
    this.onPostingChanged();
    this.onVisibility(reviewListViewId, this.listView.visible);
    this.onVisibility(reviewTreeViewId, this.treeView.visible);
    this.onVisibility(discussionsViewId, this.discussionsView.visible);
  }

  public dispose(): void {
    // Commands first, so nothing reaches a view or the session while they are torn down.
    this.actions.dispose();
    Disposable.from(...this.disposables).dispose();
    this.disposables.length = 0;
    this.listView.dispose();
    this.treeView.dispose();
    this.discussionsView.dispose();
    this.listProvider.dispose();
    this.treeProvider.dispose();
    this.discussionsProvider.dispose();
    this.posting.dispose();
    this.decorations.dispose();
    this.editors.dispose();
    this.session.dispose();
    for (const key of Object.values(CONTEXT_KEYS)) {
      void commands.executeCommand("setContext", key, undefined);
    }
  }

  private onVisibility(viewId: string, visible: boolean): void {
    this.session.setViewVisible(viewId, visible);
    if (visible) {
      // The last review comes back the first time the container is shown; no editor opens.
      void this.session.restore();
    }
  }

  private onListChanged(): void {
    this.listView.badge = this.listProvider.badge();
    this.listView.description = this.listProvider.description();
  }

  private onWorkspaceChanged(): void {
    this.setKey(CONTEXT_KEYS.multipleWorkspaces, this.session.multipleWorkspaces);
    this.listView.message = this.session.workspaceId === undefined ? "No Plastic workspace is open." : undefined;
    void this.posting.select(this.session.workspaceId);
    this.onListChanged();
  }

  private onActiveChanged(): void {
    const active = this.session.active;
    this.setKey(CONTEXT_KEYS.hasActiveReview, !!active);
    this.setKey(CONTEXT_KEYS.isBranchReview, active?.review.targetType === "branch");
    this.setKey(CONTEXT_KEYS.hasUpdates, !!active?.updates);
    this.updateReviewerKey();
    this.treeView.title = this.treeProvider.title();
    this.treeView.description = this.treeProvider.description();
    this.discussionsView.badge = this.discussionsProvider.badge();
    this.discussionsView.description = this.discussionsProvider.description();
    this.syncDecorations();
    this.checkProgress(false);
    this.updateEditorKeys();
  }

  private onViewedChanged(): void {
    this.checkProgress(true);
    this.updateEditorKeys();
  }

  /**
   * Whether the Review view offers Add Me as Reviewer. Only asked of the
   * session while the experimental setting is on, since the first ask runs
   * `cm whoami`; `onDidChangeCanAddMe` brings the answer, and hides the button
   * while an add is in flight.
   */
  private updateReviewerKey(): void {
    this.setKey(CONTEXT_KEYS.canAddMeAsReviewer, this.posting.settingOn() && this.session.canAddMe());
  }

  /** The keys follow, and so does the Overview, which offers Add me as reviewer only while the setting is on. */
  private onPostingChanged(): void {
    this.setKey(CONTEXT_KEYS.postingEnabled, this.posting.enabled);
    this.setKey(CONTEXT_KEYS.hasAccessToken, this.posting.hasToken);
    this.updateReviewerKey();
    const active = this.session.active;
    if (active) {
      this.editors.refreshOverview(active.workspaceId, active.review.id);
    }
  }

  /**
   * The active editor or tab changed, or a command opened a diff. The keys
   * follow, and when a different file of the active review became active the
   * Review view selects its row. Session events (a changeset's files loading,
   * files marked viewed, a poll) only update the keys: moving the selection
   * then would pull the tree away from wherever the user is working in it.
   */
  private onEditorChanged(): void {
    const at = this.updateEditorKeys();
    const identity = at && `${at.workspaceId}/${at.reviewId}/${scopeKey(at.scope)}/${fileKey(at.file)}`;
    if (identity === this.revealed) {
      return;
    }
    this.revealed = identity;
    if (!at || !this.treeView.visible) {
      return;
    }
    const node = this.treeProvider.fileNode(at.scope, at.file);
    if (node && this.treeView.selection[0] !== node) {
      this.treeView.reveal(node, { focus: false, select: true }).then(undefined, () => undefined);
    }
  }

  /**
   * Keys for the editor title actions; returns the active tab's file when it
   * belongs to the active review. Whether the Overview is on screen also
   * decides whether the active review is polled for updates.
   */
  private updateEditorKeys(): IReviewFileAt | undefined {
    const active = this.session.active;
    const at = this.editors.activeFile();
    const current = !!at && !!active && at.workspaceId === active.workspaceId && at.reviewId === active.review.id;
    this.setKey(CONTEXT_KEYS.activeEditorIsReviewFile, current);
    this.setKey(CONTEXT_KEYS.activeFileViewed, current && this.session.isViewed(at.file));
    const overview = (tab: Tab | undefined) => !!active && isOverviewTab(tab, active.workspaceId, active.review.id);
    this.setKey(CONTEXT_KEYS.activeEditorIsOverview, overview(window.tabGroups.activeTabGroup.activeTab));
    this.session.setViewVisible(overviewViewId, window.tabGroups.all.some(group => overview(group.activeTab)));
    // An Overview VS Code restored after a reload brings its review back, as showing a review view does.
    const selected = this.session.workspaceId;
    const restored = (tab: Tab | undefined) => overviewTabReview(tab)?.workspaceId === selected;
    if (!active && selected && window.tabGroups.all.some(group => restored(group.activeTab))) {
      void this.session.restore();
    }
    return current ? at : undefined;
  }

  /**
   * The Overview's links open through here. VS Code allows one handler per
   * extension, so a second PlasticReviews alongside this one (only tests make
   * one) logs instead of failing.
   */
  private registerUriHandler(channel: OutputChannel): void {
    try {
      this.disposables.push(window.registerUriHandler({ handleUri: (uri: Uri) => this.actions.handleUri(uri) }));
    } catch (error) {
      channel.appendLine(`Plastic Reviews: the Overview's links will not open: ${String(error)}`);
    }
  }

  /**
   * Registers the status letters of every loaded comparison of the active
   * review. Another review starts afresh; a reload of the same review keeps the
   * older comparisons for a while, as their tabs still show them.
   */
  private syncDecorations(): void {
    const active = this.session.active;
    const identity = active && `${active.workspaceId}/${active.review.id}`;
    if (identity !== this.decorated.identity) {
      this.decorations.clear();
      this.decorated = { comparisons: [], identity };
    }
    if (!active) {
      return;
    }
    const known = this.decorated.comparisons;
    for (const comparison of this.session.loadedComparisons()) {
      if (known.includes(comparison)) {
        continue;
      }
      this.decorations.setComparison(active.workspaceId, active.review.id, comparison);
      known.push(comparison);
      while (known.length > MAX_DECORATED) {
        this.decorations.clearComparison(active.workspaceId, known.shift()!);
      }
    }
  }

  /** Announces the moment the last file of Changes becomes viewed; opening a finished review says nothing. */
  private checkProgress(announce: boolean): void {
    const active = this.session.active;
    const progress = active && this.treeProvider.progress();
    if (!active || !progress) {
      this.progress = undefined;
      return;
    }
    const identity = `${active.workspaceId}/${active.review.id}`;
    const complete = progress.total > 0 && progress.viewed === progress.total;
    const before = this.progress;
    this.progress = { complete, identity };
    if (announce && complete && before?.identity === identity && !before.complete) {
      void this.actions.announceAllViewed();
    }
  }

  private setKey(key: string, value: unknown): void {
    if (this.keys.has(key) && this.keys.get(key) === value) {
      return;
    }
    this.keys.set(key, value);
    void commands.executeCommand("setContext", key, value);
  }
}
