import { avatarUri, noDiffMessage, reviewCommentMarkdown, threadTypeLabel } from "./reviewPresentation";
import {
  commands,
  Comment,
  CommentController,
  CommentingRangeProvider,
  CommentMode,
  comments,
  CommentThread,
  CommentThreadCollapsibleState,
  CommentThreadState,
  Disposable,
  Event,
  EventEmitter,
  MarkdownString,
  Range,
  Selection,
  Tab,
  TabInputCustom,
  TabInputText,
  TabInputTextDiff,
  TextDocument,
  TextDocumentContentProvider,
  TextDocumentShowOptions,
  TextEditor,
  TextEditorRevealType,
  Uri,
  window,
  workspace,
} from "vscode";
import { FileChangeStatus, IChangesetFileChange, RevisionType } from "../models";
import {
  fileKey,
  IReview,
  IReviewComment,
  IReviewComparison,
  IReviewFiles,
  IReviewRevision,
  IReviewThread,
  sameRepository,
} from "./models";
import { mapReviewLine, splitLines } from "./anchors";
import { FileScope } from "./sessionTypes";
import { IReviewDraft } from "./reviewWriter";
import { isDiffable } from "./reviewFileTree";
import { posix } from "path";
import { randomBytes } from "crypto";
import { ReviewService } from "./reviewService";
import { shortOwner } from "../history/graphModel";

export const reviewScheme = "plastic-review";

export type ReviewSide = "left" | "right";

const SIDES: readonly ReviewSide[] = [ "left", "right" ];
/** Right first: a pure move has one revision on both sides, and its new name is the one to read. */
const EXACT_ORDER: readonly ReviewSide[] = [ "right", "left" ];
const REOPEN = "Reopen this file from Plastic Reviews to load its comparison.";
/** Changeset diffs kept for original-context editors; each is one `cm diff cs:N`. */
const MAX_CACHED_ORIGINALS = 16;
/** Overview refreshes this close together are one: marking many files viewed redraws it once. */
const OVERVIEW_REFRESH_DELAY = 50;

/** Stands for the Overview's preview in `ReviewSession.setViewVisible`: the active review is polled while it shows. */
export const overviewViewId = "plastic-scm.reviews.overview";

/** What the editors read from the active review. The session owns it and passes a new one on every load. */
export interface IReviewEditorContext {
  service: ReviewService;
  review: IReview;
  /** Undefined until the files stage has loaded; comments then open their original context. */
  files?: IReviewFiles;
  threads: readonly IReviewThread[];
}

/** How a diff relates to the review: one of its comparisons, or the history a comment was written on. */
export type ReviewDiffScope =
  | { kind: "review" }
  | { kind: "original"; revisionId: number; changesetId: number }
  | { kind: "outdated"; revisionId: number }
  | { kind: "previous"; revisionId: number };

export interface IReviewOpenOptions {
  /** Defaults to true, so browsing files reuses one tab. */
  preview?: boolean;
  /** Tree clicks keep focus in the tree; the editor's own previous/next move it into the diff. */
  preserveFocus?: boolean;
  focus?: { thread: IReviewThread; side: ReviewSide; line: number };
  /** Where the file was opened from, for previous/next; derived from the comparison when omitted. */
  scope?: FileScope;
}

/** A review file shown in an editor, as `fileAt` resolves either side of its diff. */
export interface IReviewFileAt {
  workspaceId: string;
  reviewId: number;
  comparison: IReviewComparison;
  file: IChangesetFileChange;
  side: ReviewSide;
  scope: FileScope;
}

export interface IReviewEditorsOptions {
  /**
   * The review service of a workspace, for tabs VS Code restores after a
   * reload: their URIs carry everything needed except the service. May wait
   * until the workspaces are known.
   */
  resolveService?: (workspaceId: string) => Thenable<ReviewService | undefined> | ReviewService | undefined;
  /** Renders the Overview document of a review. */
  overview?: (workspaceId: string, reviewId: number) => Thenable<string> | string;
  postingEnabled?: boolean;
}

export interface IReviewSide {
  uri: Uri;
  revisionId: number;
  path: string;
}

export interface IReviewDiff {
  left: IReviewSide;
  right: IReviewSide;
}

/** What a `plastic-review:` URI query carries. */
export interface IReviewUriQuery {
  kind?: string;
  comparison?: string;
  repository?: string;
  reviewId?: number;
  revisionId?: number;
  serviceId?: string;
  side?: string;
}

interface IOpenDiff {
  key: string;
  context: IReviewEditorContext;
  comparison: IReviewComparison;
  file: IChangesetFileChange;
  sides: IReviewDiff;
  scope: ReviewDiffScope;
  fileScope: FileScope;
  /** Opens in flight; a diff is never released while one runs. */
  opening: number;
  /** Bumped per render and on release, so an older render's threads are dropped. */
  renders: number;
}

interface ITarget {
  diff: IOpenDiff;
  side: ReviewSide;
}

interface IPlacement {
  side: ReviewSide;
  line: number;
  thread: IReviewThread;
  /** The anchor revision when the thread was mapped from another revision of the item. */
  from?: number;
}

/** One side of a review document, from the open diff or, for a restored tab, from its URI. */
interface ISideInfo {
  serviceId: string;
  reviewId: number;
  revisionId: number;
  repository: string;
  path: string;
  service?: ReviewService;
}

export function reviewDiff(
    serviceId: string,
    reviewId: number,
    comparison: IReviewComparison,
    file: IChangesetFileChange
): IReviewDiff {
  const side = (name: string, revisionId: number, path: string): IReviewSide => ({
    path,
    revisionId,
    uri: Uri.from({
      path,
      query: JSON.stringify({
        comparison: comparison.id,
        repository: file.repository,
        reviewId,
        revisionId,
        serviceId,
        side: name,
      }),
      scheme: reviewScheme,
    }),
  });
  const deleted = !!(file.status & FileChangeStatus.Deleted);
  const added = !!(file.status & FileChangeStatus.Added);
  const pureMove = !!(file.status & FileChangeStatus.Moved) && !(file.status & FileChangeStatus.Changed);
  return {
    left: side(
      "left",
      deleted || pureMove ? file.revisionId : added ? -1 : file.baseRevisionId,
      file.oldPath ?? file.path
    ),
    right: side("right", deleted ? -1 : file.revisionId, file.path),
  };
}

/**
 * The URI a review row is known by: the right side of its diff. The tree row,
 * its decoration and the diff tab must share this exact string, or the tab
 * loses its status letter. Rows without a text diff get the same shape; it is
 * never opened.
 */
export function reviewFileUri(
    serviceId: string,
    reviewId: number,
    comparison: IReviewComparison,
    file: IChangesetFileChange): Uri {
  return reviewDiff(serviceId, reviewId, comparison, file).right.uri;
}

export function reviewOverviewUri(serviceId: string, reviewId: number): Uri {
  return Uri.from({
    path: `/Review ${reviewId}.md`,
    query: JSON.stringify({ kind: "overview", reviewId, serviceId }),
    scheme: reviewScheme,
  });
}

/** VS Code's Markdown preview editor, which shows a review's Overview. */
export const MARKDOWN_PREVIEW_EDITOR = "vscode.markdown.preview.editor";

/**
 * The review whose Overview a tab shows, read from the tab's URI: the Markdown
 * preview editor of `plastic-review:/Review N.md`, or that document as text when
 * the preview editor is missing. Undefined for any other tab, whatever its title.
 */
export function overviewTabReview(tab: Tab | undefined): { workspaceId: string; reviewId: number } | undefined {
  const input = tab?.input;
  const uri = input instanceof TabInputCustom || input instanceof TabInputText ? input.uri : undefined;
  const query = uri && parseReviewUri(uri);
  if (query?.kind !== "overview" || query.serviceId === undefined || query.reviewId === undefined) {
    return undefined;
  }
  return { reviewId: query.reviewId, workspaceId: query.serviceId };
}
/** Whether a tab is the Overview of that review. */
export function isOverviewTab(tab: Tab | undefined, workspaceId: string, reviewId: number): boolean {
  const shown = overviewTabReview(tab);
  return shown?.workspaceId === workspaceId && shown.reviewId === reviewId;
}

/** The query of a `plastic-review:` URI with its field types checked; undefined for anything else. */
export function parseReviewUri(uri: Uri): IReviewUriQuery | undefined {
  if (uri.scheme !== reviewScheme) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(uri.query);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const query = value as Record<string, unknown>;
  const text = (name: string) => typeof query[name] === "string" ? query[name] : undefined;
  const integer = (name: string) => Number.isSafeInteger(query[name]) ? query[name] as number : undefined;
  return {
    comparison: text("comparison"),
    kind: text("kind"),
    repository: text("repository"),
    reviewId: integer("reviewId"),
    revisionId: integer("revisionId"),
    serviceId: text("serviceId"),
    side: text("side"),
  };
}

/**
 * The editor title. The file name comes first so that truncation drops the
 * suffix first, and both sides are named, because checking that the right
 * revisions are compared is the first thing a reviewer does.
 */
export function reviewDiffTitle(
    scope: ReviewDiffScope,
    file: IChangesetFileChange,
    comparison: IReviewComparison,
    reviewId: number): string {
  const name = posix.basename(file.path);
  const suffix = ` · #${reviewId}`;
  const base = comparison.baseChangesetId === undefined ? "base" : `cs:${comparison.baseChangesetId}`;
  switch (scope.kind) {
  case "original":
    return `${name} (rev ${scope.revisionId} · cs:${scope.changesetId} · original context)${suffix}`;
  case "outdated":
    return `${name} (${base} ↔ rev ${scope.revisionId} · outdated)${suffix}`;
  case "previous":
    return `${name} (rev ${scope.revisionId} vs previous revision)${suffix}`;
  default:
    break;
  }
  const head = comparison.headChangesetId === undefined ? undefined : `cs:${comparison.headChangesetId}`;
  if (file.status & FileChangeStatus.Added) {
    return `${name} (added · ${head ?? comparison.label})${suffix}`;
  }
  if (file.status & FileChangeStatus.Deleted) {
    return `${name} (deleted · ${head ?? comparison.label})${suffix}`;
  }
  if (file.status & FileChangeStatus.Moved) {
    const oldName = posix.basename(file.oldPath ?? file.path);
    const target = head ?? comparison.label;
    return file.status & FileChangeStatus.Changed
      ? `${oldName} (${base}) ↔ ${name} (${target})${suffix}`
      : `${oldName} ↔ ${name} (${target})${suffix}`;
  }
  return `${name} (${head ? `${base} ↔ ${head}` : comparison.label})${suffix}`;
}

/** Comment text as Markdown for native threads; it lives with the tooltips, which render it too. */
export { reviewCommentMarkdown };

/**
 * Review diffs as native editors: the content provider for `plastic-review:`
 * documents and the comment controller that shows review threads in them.
 * Every open diff keeps its pinned comparison; threads follow the active
 * review's discussions and are disposed with their tab or when the review
 * changes, so nothing here outlives what is on screen.
 */
export class ReviewEditors implements Disposable, TextDocumentContentProvider, CommentingRangeProvider {
  public readonly onDidChange: Event<Uri>;
  /** Decides which local comments (experimental posting results) a thread refresh carries over. */
  public keepLocalComment: (comment: Comment) => boolean;
  private readonly changes = new EventEmitter<Uri>();
  private readonly controller: CommentController;
  private readonly disposables: Disposable[] = [];
  private readonly diffs = new Map<string, IOpenDiff>();
  private readonly targets = new Map<string, ITarget>();
  private readonly threads = new Map<string, CommentThread[]>();
  /** Threads the user started (experimental posting), by document; kept across refreshes. */
  private readonly adopted = new Map<string, Set<CommentThread>>();
  private readonly threadIds = new WeakMap<CommentThread, number>();
  private readonly replyTargets = new WeakMap<CommentThread, IReviewDraft>();
  /** Comments built from review data, as opposed to local ones appended to a thread. */
  private readonly rendered = new WeakSet<Comment>();
  private readonly originals = new Map<string, Promise<IChangesetFileChange[]>>();
  private readonly overviewRefreshes = new Map<string, ReturnType<typeof setTimeout>>();
  private context?: IReviewEditorContext;
  private postingEnabled: boolean;
  private generation = 0;
  private disposed = false;

  public constructor(private readonly options: IReviewEditorsOptions = {}) {
    this.onDidChange = this.changes.event;
    this.keepLocalComment = () => true;
    this.postingEnabled = options.postingEnabled ?? false;
    this.controller = comments.createCommentController("plastic-scm.reviews", "Plastic Reviews");
    this.applyPostingOptions();
    this.disposables.push(
      this.controller,
      this.changes,
      workspace.registerTextDocumentContentProvider(reviewScheme, this),
      window.tabGroups.onDidChangeTabs(event => this.onTabsClosed(event.closed)),
      workspace.onDidCloseTextDocument(document => this.onDocumentClosed(document.uri))
    );
  }

  public dispose(): void {
    this.disposed = true;
    this.generation++;
    this.overviewRefreshes.forEach(timer => clearTimeout(timer));
    this.overviewRefreshes.clear();
    // Disposing the controller removes every thread it created, including the ones the user started.
    Disposable.from(...this.disposables).dispose();
    this.disposables.length = 0;
    this.diffs.clear();
    this.targets.clear();
    this.threads.clear();
    this.adopted.clear();
    this.originals.clear();
  }

  /**
   * The active review, or undefined when none is open. Another review releases
   * every diff of the previous one (their tabs keep reading content through
   * their URIs but lose threads and navigation); a reload of the same review
   * re-renders the threads of its open diffs.
   */
  public setContext(context: IReviewEditorContext | undefined): void {
    const previous = this.context;
    this.context = context;
    for (const diff of Array.from(this.diffs.values())) {
      if (!context || !sameReview(diff.context, context)) {
        this.release(diff);
      }
    }
    if (!context || !previous || !sameReview(previous, context)) {
      this.generation++;
      this.adopted.forEach(set => set.forEach(thread => thread.dispose()));
      this.adopted.clear();
      return;
    }
    if (previous.threads !== context.threads || previous.files !== context.files) {
      void this.refreshThreads();
    }
  }

  /** Renders the current review's threads again in every open review diff. */
  public async refreshThreads(): Promise<void> {
    await Promise.all(Array.from(this.diffs.values()).map(diff => this.renderDiff(diff).catch(() => undefined)));
  }

  public setPostingEnabled(enabled: boolean): void {
    if (this.postingEnabled === enabled) {
      return;
    }
    this.postingEnabled = enabled;
    this.applyPostingOptions();
    this.threads.forEach(list => list.forEach(thread => {
      thread.canReply = enabled;
    }));
  }

  public provideTextDocumentContent(uri: Uri): Promise<string> {
    return this.content(uri);
  }

  /** Every line of a revision side while posting is on; nothing on an empty side or the Overview. */
  public provideCommentingRanges(document: TextDocument): Range[] {
    if (!this.postingEnabled || document.lineCount < 1) {
      return [];
    }
    const side = this.sideOf(document.uri);
    return side && side.revisionId >= 0 ? [new Range(0, 0, document.lineCount - 1, 0)] : [];
  }

  /** Tells VS Code to read the Overview again; a burst of calls is one read. */
  public refreshOverview(serviceId: string, reviewId: number): void {
    const uri = reviewOverviewUri(serviceId, reviewId);
    const key = uri.toString();
    if (this.disposed || this.overviewRefreshes.has(key)) {
      return;
    }
    this.overviewRefreshes.set(key, setTimeout(() => {
      this.overviewRefreshes.delete(key);
      this.changes.fire(uri);
    }, OVERVIEW_REFRESH_DELAY));
  }

  /**
   * Opens a row of a comparison as a diff. Threads are placed before the
   * editor opens; a newer open (or a review change) cancels this one.
   */
  public async open(
      context: IReviewEditorContext,
      comparison: IReviewComparison,
      file: IChangesetFileChange,
      options: IReviewOpenOptions = {}): Promise<void> {
    await this.show(context, comparison, file, { kind: "review" }, options);
  }

  /**
   * Opens a thread where it was written, in this order: the final diff when its
   * revision is one side of a row; the final diff at the mapped line when it is
   * another revision of a row's item; an "outdated" diff of the row's left side
   * against the comment revision when the line no longer maps; the revision's
   * own changeset; the revision against its previous revision. Like `open`, a
   * newer open or openComment (or a review change) cancels this one, so the
   * discussion clicked last is the one that opens.
   */
  public async openComment(
      context: IReviewEditorContext,
      thread: IReviewThread,
      options: { preserveFocus?: boolean } = {}): Promise<void> {
    // Claimed before the first await: the lookups below can take longer than the next click.
    const generation = ++this.generation;
    const stale = () => this.disposed || generation !== this.generation;
    const { service } = context;
    const anchor = thread.anchor;
    if (anchor.revisionId <= 0) {
      throw new Error("This discussion has no file location. Its thread is listed under General in Discussions.");
    }
    if (anchor.location < 0) {
      // Listed with its file in Discussions, but there is no line to open it at.
      throw new Error("This comment is about the whole file, not one line. Hover its row in Discussions to read it.");
    }
    const revision = await service.revision(anchor.revisionId);
    const path = this.serverPath(service, thread, revision);
    const source = await service.text(revision.id, revision.repository, path);
    const line = anchor.location;
    if (line >= splitLines(source).length) {
      throw new Error("This comment points outside its original revision. Its discussion remains in Discussions.");
    }
    const final = context.files?.final;
    const match = final && final.files.length ? await service.fileForRevision(final.files, revision) : undefined;
    if (stale()) {
      return;
    }
    const show = (
        comparison: IReviewComparison,
        file: IChangesetFileChange,
        scope: ReviewDiffScope,
        side: ReviewSide,
        at: number) => this.show(context, comparison, file, scope, {
      focus: { line: at, side, thread },
      preserveFocus: options.preserveFocus ?? false,
      preview: true,
    }, generation);
    if (final && match && isDiffable(match.file)) {
      if (match.exact) {
        await show(final, match.file, { kind: "review" }, match.exact, line);
        return;
      }
      const sides = reviewDiff(service.workspaceId, context.review.id, final, match.file);
      if (sides.right.revisionId >= 0) {
        const current = await service.text(sides.right.revisionId, match.file.repository, sides.right.path);
        const mapped = mapReviewLine(source, current, line);
        if (stale()) {
          return;
        }
        if (mapped !== undefined) {
          await show(final, match.file, { kind: "review" }, "right", mapped);
          return;
        }
      }
      const outdated = outdatedFile(match.file, sides, revision, path);
      await show({
        baseChangesetId: final.baseChangesetId,
        files: [outdated],
        headChangesetId: revision.changesetId >= 0 ? revision.changesetId : undefined,
        id: `${final.id}:outdated:${revision.id}`,
        kind: "original",
        label: `outdated · rev ${revision.id}`,
      }, outdated, { kind: "outdated", revisionId: revision.id }, "right", line);
      return;
    }
    // cm leaves CHANGESET at -1 on most comments; the revision's own changeset is the reliable one.
    const changesetId = revision.changesetId >= 0 ? revision.changesetId : anchor.changesetId;
    if (changesetId >= 0) {
      const files = await this.changesetFiles(service, changesetId);
      const hit = revisionHit(files, revision);
      if (stale()) {
        return;
      }
      if (hit && isDiffable(hit.file)) {
        await show({
          files,
          headChangesetId: changesetId,
          id: `${service.workspaceId}:${context.review.id}:original:${changesetId}`,
          kind: "original",
          label: `original context · cs:${changesetId}`,
        }, hit.file, { changesetId, kind: "original", revisionId: revision.id }, hit.side, line);
        return;
      }
    }
    const previous = previousRevisionFile(revision, path);
    await show({
      files: [previous],
      id: `${service.workspaceId}:${context.review.id}:revision:${revision.id}`,
      kind: "original",
      label: `rev ${revision.id} vs previous revision`,
    }, previous, { kind: "previous", revisionId: revision.id }, "right", line);
  }

  /**
   * The review file shown by either side of a diff; undefined for other
   * documents, and for original-context editors, which are not review files.
   */
  public fileAt(uri: Uri | undefined): IReviewFileAt | undefined {
    const target = uri && this.targets.get(uri.toString());
    if (!target || target.diff.scope.kind !== "review") {
      return undefined;
    }
    const { diff } = target;
    return {
      comparison: diff.comparison,
      file: diff.file,
      reviewId: diff.context.review.id,
      scope: diff.fileScope,
      side: target.side,
      workspaceId: diff.context.service.workspaceId,
    };
  }

  /** The review file in the active tab, which is what previous/next start from. */
  public activeFile(): IReviewFileAt | undefined {
    const input = window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof TabInputTextDiff) {
      return this.fileAt(input.modified) ?? this.fileAt(input.original);
    }
    if (input instanceof TabInputText) {
      return this.fileAt(input.uri);
    }
    return this.fileAt(window.activeTextEditor?.document.uri);
  }

  /** A new comment at `line` of a revision side, pinned to that revision. */
  public async draftAt(uri: Uri, line: number): Promise<IReviewDraft> {
    const side = this.sideOf(uri);
    if (!side || side.revisionId < 0 || !Number.isSafeInteger(line) || line < 0) {
      throw new Error("Select a line on a non-empty side of a Plastic review diff.");
    }
    const text = await this.content(uri);
    if (line >= splitLines(text).length) {
      throw new Error("The selected line is outside the pinned revision.");
    }
    const service = side.service ?? await this.resolve(side.serviceId);
    const revision = await service.revision(side.revisionId, side.repository);
    return {
      changesetId: revision.changesetId,
      key: newDraftKey(),
      location: line,
      path: side.path,
      reviewId: side.reviewId,
      revisionId: side.revisionId,
      workspaceId: service.workspaceId,
    };
  }

  /** A reply to a review thread shown here, with a fresh idempotency key; undefined for other threads. */
  public replyDraft(thread: CommentThread): IReviewDraft | undefined {
    const target = this.replyTargets.get(thread);
    return target && { ...target, key: newDraftKey() };
  }

  /** Takes over a thread the user started, so it is disposed with its tab or review. */
  public adopt(thread: CommentThread): void {
    const uri = thread.uri.toString();
    const set = this.adopted.get(uri) ?? new Set<CommentThread>();
    set.add(thread);
    this.adopted.set(uri, set);
  }

  public disposeThread(thread: CommentThread): void {
    const uri = thread.uri.toString();
    this.adopted.get(uri)?.delete(thread);
    const list = this.threads.get(uri);
    if (list?.includes(thread)) {
      this.threads.set(uri, list.filter(other => other !== thread));
    }
    thread.dispose();
  }

  /** The thread that currently holds a local comment; a refresh moves it to a new thread. */
  public threadOf(comment: Comment): CommentThread | undefined {
    for (const list of Array.from(this.threads.values())) {
      const found = list.find(thread => thread.comments.includes(comment));
      if (found) {
        return found;
      }
    }
    for (const set of Array.from(this.adopted.values())) {
      const found = Array.from(set).find(thread => thread.comments.includes(comment));
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  /**
   * Opens a diff. `claimed` is the generation an openComment took when it
   * started; any other open claims its own here.
   */
  private async show(
      context: IReviewEditorContext,
      comparison: IReviewComparison,
      file: IChangesetFileChange,
      scope: ReviewDiffScope,
      options: IReviewOpenOptions,
      claimed?: number): Promise<void> {
    const message = noDiffMessage(file);
    if (message) {
      throw new Error(message);
    }
    const generation = claimed ?? ++this.generation;
    const sides = reviewDiff(context.service.workspaceId, context.review.id, comparison, file);
    const diff = this.register(context, comparison, file, sides, scope, options.scope);
    diff.opening++;
    let shown = false;
    try {
      const [ left, right ] = await Promise.all([ this.sideText(diff, "left"), this.sideText(diff, "right") ]);
      if (this.disposed || generation !== this.generation) {
        return;
      }
      await this.render(diff, { left, right }, options.focus?.thread.id);
      if (this.disposed || generation !== this.generation) {
        return;
      }
      const focus = options.focus;
      const selection = focus ? new Range(focus.line, 0, focus.line, 0) : undefined;
      const show: TextDocumentShowOptions = {
        preserveFocus: options.preserveFocus ?? false,
        preview: options.preview ?? true,
        selection: focus?.side === "right" ? selection : undefined,
      };
      const title = reviewDiffTitle(scope, file, comparison, context.review.id);
      await commands.executeCommand("vscode.diff", sides.left.uri, sides.right.uri, title, show);
      shown = true;
      if (focus && selection) {
        await this.reveal(sides[focus.side].uri, selection, focus.thread.id);
      }
    } finally {
      diff.opening--;
      if (!shown && diff.opening === 0 && !this.isShown(diff)) {
        this.release(diff);
      }
    }
  }

  private register(
      context: IReviewEditorContext,
      comparison: IReviewComparison,
      file: IChangesetFileChange,
      sides: IReviewDiff,
      scope: ReviewDiffScope,
      fileScope: FileScope | undefined): IOpenDiff {
    const key = `${sides.left.uri.toString()}\n${sides.right.uri.toString()}`;
    const existing = this.diffs.get(key);
    if (existing) {
      // The URIs pin the comparison and revisions; only how it was reached can differ.
      existing.context = context;
      existing.scope = scope;
      existing.fileScope = fileScope ?? existing.fileScope;
      return existing;
    }
    const diff: IOpenDiff = {
      comparison,
      context,
      file,
      fileScope: fileScope ?? deriveScope(context, comparison, file),
      key,
      opening: 0,
      renders: 0,
      scope,
      sides,
    };
    this.diffs.set(key, diff);
    for (const side of SIDES) {
      this.targets.set(sides[side].uri.toString(), { diff, side });
    }
    return diff;
  }

  private release(diff: IOpenDiff): void {
    if (this.diffs.get(diff.key) !== diff) {
      return;
    }
    this.diffs.delete(diff.key);
    diff.renders++;
    for (const side of SIDES) {
      const uri = diff.sides[side].uri.toString();
      if (this.targets.get(uri)?.diff === diff) {
        this.targets.delete(uri);
      }
      this.disposeThreads(uri);
    }
  }

  private disposeThreads(uri: string): void {
    this.threads.get(uri)?.forEach(thread => thread.dispose());
    this.threads.delete(uri);
    this.adopted.get(uri)?.forEach(thread => thread.dispose());
    this.adopted.delete(uri);
  }

  private onTabsClosed(closed: readonly Tab[]): void {
    const uris = new Set<string>();
    closed.forEach(tab => tabUris(tab).forEach(uri => uris.add(uri)));
    if (uris.size) {
      this.releaseUnshown(uris);
    }
  }

  private onDocumentClosed(uri: Uri): void {
    if (uri.scheme === reviewScheme) {
      this.releaseUnshown(new Set([uri.toString()]));
    }
  }

  /** Releases the diffs a closed tab showed, unless another tab still shows them. */
  private releaseUnshown(closed: Set<string>): void {
    const open = shownUris();
    for (const diff of Array.from(this.diffs.values())) {
      const uris = SIDES.map(side => diff.sides[side].uri.toString());
      if (diff.opening === 0 && uris.some(uri => closed.has(uri)) && !uris.some(uri => open.has(uri))) {
        this.release(diff);
      }
    }
    closed.forEach(uri => {
      if (!open.has(uri) && !this.targets.has(uri)) {
        this.disposeThreads(uri);
      }
    });
  }

  private isShown(diff: IOpenDiff): boolean {
    const open = shownUris();
    return SIDES.some(side => open.has(diff.sides[side].uri.toString()));
  }

  private async renderDiff(diff: IOpenDiff): Promise<void> {
    const [ left, right ] = await Promise.all([ this.sideText(diff, "left"), this.sideText(diff, "right") ]);
    await this.render(diff, { left, right });
  }

  /** Replaces the threads on both sides of a diff; local comments of a replaced thread move to its successor. */
  private async render(diff: IOpenDiff, texts: Record<ReviewSide, string>, focus?: number): Promise<void> {
    const render = ++diff.renders;
    const placements = await this.place(diff, texts);
    if (this.disposed || render !== diff.renders || this.diffs.get(diff.key) !== diff) {
      return;
    }
    for (const side of SIDES) {
      const uri = diff.sides[side].uri.toString();
      const carried = new Map<number, Comment[]>();
      for (const old of this.threads.get(uri) ?? []) {
        const id = this.threadIds.get(old);
        const local = old.comments.filter(comment => !this.rendered.has(comment) && this.keepLocalComment(comment));
        if (id !== undefined && local.length) {
          carried.set(id, (carried.get(id) ?? []).concat(local));
        }
        old.dispose();
      }
      this.threads.set(uri, placements
        .filter(placement => placement.side === side)
        .map(placement => this.createThread(diff, placement, focus, carried.get(placement.thread.id) ?? [])));
      // A started thread whose comments were all posted is shown by the reloaded review itself.
      this.adopted.get(uri)?.forEach(thread => {
        if (thread.comments.length && thread.comments.every(comment => !this.keepLocalComment(comment))) {
          this.adopted.get(uri)?.delete(thread);
          thread.dispose();
        }
      });
    }
  }

  /**
   * Where each thread goes in a diff. A thread whose revision is one side of
   * the diff goes on that side at its own line (the left for a base-side
   * comment); another revision of the same item is mapped onto the right side
   * (the left when the right is empty) and says where it came from. Threads
   * whose line no longer maps, or whose revision cannot be read, are left out.
   */
  private async place(diff: IOpenDiff, texts: Record<ReviewSide, string>): Promise<IPlacement[]> {
    const service = diff.context.service;
    const repository = diff.file.repository;
    const mappedSide: ReviewSide = diff.sides.right.revisionId >= 0 ? "right" : "left";
    let item: Promise<IReviewRevision | undefined> | undefined;
    const placements: IPlacement[] = [];
    for (const thread of this.threadsFor(diff)) {
      const anchor = thread.anchor;
      if (anchor.revisionId <= 0 || anchor.location < 0) {
        continue;
      }
      try {
        const revision = await service.revision(anchor.revisionId);
        if (!sameRepository(revision.repository, repository)) {
          continue;
        }
        const exact = EXACT_ORDER.find(side => diff.sides[side].revisionId === revision.id);
        if (exact) {
          if (anchor.location < splitLines(texts[exact]).length) {
            placements.push({ line: anchor.location, side: exact, thread });
          }
          continue;
        }
        const target = diff.sides[mappedSide];
        if (target.revisionId < 0) {
          continue;
        }
        item = item ?? service.revision(target.revisionId, repository).catch(() => undefined);
        const current = await item;
        if (!current || current.itemId !== revision.itemId ||
          !sameRepository(current.repository, revision.repository)) {
          continue;
        }
        const source = await service.text(revision.id, revision.repository, thread.path ?? target.path);
        const line = mapReviewLine(source, texts[mappedSide], anchor.location);
        if (line !== undefined) {
          placements.push({ from: revision.id, line, side: mappedSide, thread });
        }
      } catch {
        // An inaccessible historical revision must not keep the other threads out.
        // Opening its Discussions row reports the underlying error.
      }
    }
    return placements;
  }

  private createThread(
      diff: IOpenDiff,
      placement: IPlacement,
      focus: number | undefined,
      local: Comment[]): CommentThread {
    const { thread } = placement;
    const label = threadTypeLabel(thread);
    const side = diff.sides[placement.side];
    const native = this.controller.createCommentThread(
      side.uri,
      new Range(placement.line, 0, placement.line, 0),
      // The thread's header names the type; each comment shows only its author and time, as in the Plastic clients.
      thread.comments.map(comment => this.toComment(comment)).concat(local)
    );
    const origin = placement.from !== undefined ? ` · from rev ${placement.from}`
      : diff.scope.kind !== "review" ? " · original context" : "";
    native.label = `${label}${origin}`;
    const state = nativeState(thread);
    if (state !== undefined) {
      native.state = state;
    }
    const expanded = (thread.kind === "change" && thread.state === "pending") || thread.kind === "question" ||
      thread.id === focus;
    native.collapsibleState = expanded
      ? CommentThreadCollapsibleState.Expanded
      : CommentThreadCollapsibleState.Collapsed;
    native.canReply = this.postingEnabled;
    native.contextValue = `reviewThread;${thread.kind};${thread.state}`;
    this.threadIds.set(native, thread.id);
    this.replyTargets.set(native, {
      changesetId: thread.anchor.changesetId,
      key: "",
      location: thread.anchor.location,
      parentId: thread.id,
      path: side.path,
      reviewId: diff.context.review.id,
      revisionId: thread.anchor.revisionId,
      workspaceId: diff.context.service.workspaceId,
    });
    return native;
  }

  private toComment(comment: IReviewComment): Comment {
    const body = new MarkdownString(reviewCommentMarkdown(comment.text));
    body.isTrusted = false;
    body.supportHtml = false;
    const time = Date.parse(comment.date);
    const result: Comment = {
      author: { iconPath: avatarUri(comment.owner), name: shortOwner(comment.owner) || "Unknown" },
      body,
      // A discarded reply says so; the thread's own label cannot, as it describes the root.
      label: comment.type === "discarded" ? "Discarded" : undefined,
      mode: CommentMode.Preview,
      timestamp: isNaN(time) ? undefined : new Date(time),
    };
    this.rendered.add(result);
    return result;
  }

  private async reveal(uri: Uri, selection: Range, threadId: number): Promise<void> {
    const editor = await visibleEditor(uri);
    if (editor) {
      editor.selection = new Selection(selection.start, selection.end);
      editor.revealRange(selection, TextEditorRevealType.InCenter);
    }
    const native = (this.threads.get(uri.toString()) ?? []).find(thread => this.threadIds.get(thread) === threadId);
    if (native) {
      native.collapsibleState = CommentThreadCollapsibleState.Expanded;
    }
  }

  /** The active review's threads for a diff of that review; the diff's own otherwise. */
  private threadsFor(diff: IOpenDiff): readonly IReviewThread[] {
    return this.context && sameReview(this.context, diff.context) ? this.context.threads : diff.context.threads;
  }

  private sideText(diff: IOpenDiff, side: ReviewSide): Promise<string> {
    const { path, revisionId } = diff.sides[side];
    return diff.context.service.text(revisionId, diff.file.repository, path);
  }

  private async content(uri: Uri): Promise<string> {
    const query = parseReviewUri(uri);
    if (query?.kind === "overview") {
      if (!this.options.overview || query.serviceId === undefined || query.reviewId === undefined) {
        throw new Error("Open the overview from Plastic Reviews.");
      }
      return this.options.overview(query.serviceId, query.reviewId);
    }
    const side = this.sideOf(uri);
    if (!side) {
      throw new Error(REOPEN);
    }
    if (side.revisionId < 0) {
      return "";
    }
    const service = side.service ?? await this.resolve(side.serviceId);
    return service.text(side.revisionId, side.repository, side.path);
  }

  private sideOf(uri: Uri): ISideInfo | undefined {
    const target = this.targets.get(uri.toString());
    if (target) {
      const { diff } = target;
      const side = diff.sides[target.side];
      return {
        path: side.path,
        repository: diff.file.repository,
        reviewId: diff.context.review.id,
        revisionId: side.revisionId,
        service: diff.context.service,
        serviceId: diff.context.service.workspaceId,
      };
    }
    // A tab restored after a reload: its URI names the revision, the repository and the workspace.
    const query = parseReviewUri(uri);
    if (!query || query.kind !== undefined || query.serviceId === undefined || query.reviewId === undefined ||
      query.revisionId === undefined || query.repository === undefined) {
      return undefined;
    }
    return {
      path: uri.path,
      repository: query.repository,
      reviewId: query.reviewId,
      revisionId: query.revisionId,
      serviceId: query.serviceId,
    };
  }

  private async resolve(serviceId: string): Promise<ReviewService> {
    const service = await this.options.resolveService?.(serviceId);
    if (!service) {
      throw new Error(REOPEN);
    }
    return service;
  }

  private serverPath(service: ReviewService, thread: IReviewThread, revision: IReviewRevision): string {
    return thread.path ?? service.serverPath(revision.path) ?? `/${posix.basename(revision.path.replace(/\\/g, "/"))}`;
  }

  private changesetFiles(service: ReviewService, changesetId: number): Promise<IChangesetFileChange[]> {
    const key = `${service.workspaceId}:${changesetId}`;
    let pending = this.originals.get(key);
    if (!pending) {
      pending = service.ready()
        .then(() => service.commands.diff(`cs:${changesetId}`))
        .catch(error => {
          this.originals.delete(key);
          throw error;
        });
      this.originals.set(key, pending);
      while (this.originals.size > MAX_CACHED_ORIGINALS) {
        this.originals.delete(this.originals.keys().next().value as string);
      }
    }
    return pending;
  }

  private applyPostingOptions(): void {
    this.controller.options = this.postingEnabled ? {
      placeHolder:
        "Experimental: posts through Unity's hosted API with your saved token. Refresh afterwards to verify.",
      prompt: "Reply (experimental)",
    } : undefined;
    // Assigning the provider again makes VS Code ask for the commenting ranges anew.
    this.controller.commentingRangeProvider = this;
  }
}

function sameReview(a: IReviewEditorContext, b: IReviewEditorContext): boolean {
  return a.service.workspaceId === b.service.workspaceId && a.review.id === b.review.id;
}

function deriveScope(
    context: IReviewEditorContext,
    comparison: IReviewComparison,
    file: IChangesetFileChange): FileScope {
  if (comparison.kind === "changeset" && comparison.headChangesetId !== undefined) {
    return { changesetId: comparison.headChangesetId };
  }
  return context.files?.mergedKeys.has(fileKey(file)) ? "merged" : "changes";
}

function nativeState(thread: IReviewThread): CommentThreadState | undefined {
  switch (thread.state) {
  case "pending":
    return CommentThreadState.Unresolved;
  case "applied":
  case "discarded":
    return CommentThreadState.Resolved;
  default:
    return undefined;
  }
}

/** The row of a changeset diff a revision is a side of, and which side (a deleted row's revision is on the left). */
function revisionHit(
    files: readonly IChangesetFileChange[],
    revision: IReviewRevision): { file: IChangesetFileChange; side: ReviewSide } | undefined {
  const same = (file: IChangesetFileChange) => sameRepository(file.repository, revision.repository);
  const right = files.find(file => file.revisionId === revision.id && same(file));
  if (right) {
    return { file: right, side: right.status & FileChangeStatus.Deleted ? "left" : "right" };
  }
  const left = files.find(file => file.baseRevisionId === revision.id && same(file));
  return left ? { file: left, side: "left" } : undefined;
}

/**
 * The comment revision against the left side of the final row it belongs to:
 * what the reviewer saw when commenting, as close as the review allows,
 * instead of one intermediate changeset's delta.
 */
function outdatedFile(
    row: IChangesetFileChange,
    sides: IReviewDiff,
    revision: IReviewRevision,
    path: string): IChangesetFileChange {
  const base = sides.left.revisionId;
  const oldPath = base >= 0 && sides.left.path !== path ? sides.left.path : undefined;
  let status = FileChangeStatus.Changed;
  if (base < 0) {
    status = FileChangeStatus.Added;
  } else if (oldPath) {
    status |= FileChangeStatus.Moved;
  }
  return {
    baseRevisionId: base,
    oldPath,
    parentRevisionId: revision.parentId,
    path,
    repository: row.repository,
    revisionId: revision.id,
    revisionType: RevisionType.TextFile,
    status,
  };
}

function previousRevisionFile(revision: IReviewRevision, path: string): IChangesetFileChange {
  return {
    baseRevisionId: revision.parentId,
    parentRevisionId: revision.parentId,
    path,
    repository: revision.repository,
    revisionId: revision.id,
    revisionType: revision.type === "txt" ? RevisionType.TextFile : RevisionType.BinaryFile,
    status: revision.parentId < 0 ? FileChangeStatus.Added : FileChangeStatus.Changed,
  };
}

function tabUris(tab: Tab): string[] {
  const input = tab.input;
  if (input instanceof TabInputTextDiff) {
    return [ input.original.toString(), input.modified.toString() ];
  }
  return input instanceof TabInputText ? [input.uri.toString()] : [];
}

function shownUris(): Set<string> {
  const uris = new Set<string>();
  window.tabGroups.all.forEach(group => group.tabs.forEach(tab => tabUris(tab).forEach(uri => uris.add(uri))));
  return uris;
}

/** The editor showing `uri`; the extension host learns of a new diff's editors shortly after it opens. */
function visibleEditor(uri: Uri, timeout = 2000): Promise<TextEditor | undefined> {
  const find = () => window.visibleTextEditors.find(editor => editor.document.uri.toString() === uri.toString());
  const found = find();
  if (found) {
    return Promise.resolve(found);
  }
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      listener.dispose();
      resolve(undefined);
    }, timeout);
    const listener = window.onDidChangeVisibleTextEditors(() => {
      const editor = find();
      if (editor) {
        clearTimeout(timer);
        listener.dispose();
        resolve(editor);
      }
    });
  });
}

function newDraftKey(): string {
  return randomBytes(16).toString("hex");
}
