import * as fs from "fs";
import * as path from "path";
import {
  commands,
  Comment,
  CommentReply,
  CommentThread,
  ConfigurationTarget,
  Disposable,
  env,
  OutputChannel,
  QuickPickItem,
  QuickPickItemKind,
  Tab,
  Uri,
  window,
  workspace,
} from "vscode";
import {
  commentTypeLabel,
  exactReviewPick,
  formatCount,
  formatDate,
  hasLocation,
  IReviewPickItem,
  IReviewPickState,
  isGeneralThread,
  isSupportedTarget,
  noDiffMessage,
  openableReviewNumber,
  reviewNumber,
  reviewPickItems,
  sameStatus,
  threadTypeLabel,
} from "./reviewPresentation";
import { errorText, FILE_LAYOUT_SETTING, ReviewSession } from "./reviewSession";
import {
  fileKey,
  IFoundReviews,
  IReview,
  IReviewComparison,
  IReviewThread,
  ReviewStatus,
  reviewStatuses,
  sameRepository,
} from "./models";
import {
  IReviewEditorContext,
  IReviewFileAt,
  IReviewOpenOptions,
  isOverviewTab,
  MARKDOWN_PREVIEW_EDITOR,
  overviewTabReview,
  reviewOverviewUri,
} from "./reviewEditors";
import { FileScope } from "./sessionTypes";
import { FIND_LIMIT } from "./commands";
import { IChangesetFileChange } from "../models";
import { isDiffable } from "./reviewFileTree";
import { parseReviewLink } from "./reviewLinks";
import { ReviewPosting } from "./reviewPosting";
import { ReviewTreeProvider } from "./reviewTreeProvider";

/** Every command of Plastic Reviews, without its `plastic-scm.reviews.` prefix. */
export const REVIEW_COMMANDS = [
  "allowRetry",
  "cancelComment",
  "close",
  "configurePosting",
  "copyChangesetComment",
  "copyChangesetId",
  "copyDiscussionText",
  "copyPath",
  "copyReviewId",
  "copyTitle",
  "discardLocal",
  "find",
  "forgetPosting",
  "loadMore",
  "loadMoreChangesets",
  "loadUpdates",
  "markAllViewed",
  "markUnviewed",
  "markViewed",
  "markViewedAndNext",
  "nextFile",
  "open",
  "openById",
  "openChanges",
  "openDiscussion",
  "openNextUnviewed",
  "openOverview",
  "openWorkspaceFile",
  "postComment",
  "postReply",
  "previousFile",
  "refresh",
  "refreshReview",
  "retry",
  "sendAgain",
  "setStatus",
  "show",
  "switchWorkspace",
  "viewAsList",
  "viewAsTree",
] as const;

export type ReviewCommandName = typeof REVIEW_COMMANDS[number];

export const REVIEW_COMMAND_PREFIX = "plastic-scm.reviews.";

export interface IReviewActionsOptions {
  session: ReviewSession;
  editors: IReviewActionEditors;
  posting: ReviewPosting;
  tree: ReviewTreeProvider;
  channel: OutputChannel;
  /** Runs after a diff opened from a command, so context keys and the tree selection follow it. */
  afterOpen?: () => void;
}

/** What the commands need from ReviewEditors. */
export interface IReviewActionEditors {
  open(
    context: IReviewEditorContext,
    comparison: IReviewComparison,
    file: IChangesetFileChange,
    options?: IReviewOpenOptions): Promise<void>;
  openComment(
    context: IReviewEditorContext,
    thread: IReviewThread,
    options?: { preserveFocus?: boolean }): Promise<void>;
  fileAt(uri: Uri | undefined): IReviewFileAt | undefined;
  activeFile(): IReviewFileAt | undefined;
  refreshOverview(serviceId: string, reviewId: number): void;
}

/** A Set Review Status row; the "Current" separator has no status. */
export interface IStatusItem extends QuickPickItem {
  readonly status?: ReviewStatus;
}

/** A list row, as ReviewListProvider hands it to `open`, `setStatus` and the copy commands. */
interface IReviewRowArg {
  kind: "review";
  workspaceId: string;
  review: IReview;
}

interface IFileArg {
  kind: "file";
  file: IChangesetFileChange;
  group: { scope: FileScope; comparison: IReviewComparison; workspaceId: string; reviewId: number };
}

interface IFolderArg {
  kind: "folder";
  path: string;
  files: IChangesetFileChange[];
  group: { scope: FileScope; workspaceId: string; reviewId: number };
}

interface IChangesetArg {
  kind: "changeset";
  changeset: { id: number; comment: string };
}

interface IThreadArg {
  kind: "thread";
  thread: IReviewThread;
  workspaceId: string;
  reviewId: number;
  general: boolean;
}

const STATUS_DESCRIPTIONS: { [status in ReviewStatus]: string } = {
  "Reviewed": "Complete the review",
  "Rework required": "Ask the author for changes",
  "Under review": "Back to review",
};

const STATUS_ICONS: { [status in ReviewStatus]: string } = {
  "Reviewed": "review-status-reviewed.svg",
  "Rework required": "review-status-rework-required.svg",
  "Under review": "review-status-under-review.svg",
};

/** The extension's icons, from the compiled `out/reviews`. */
const ICONS_ROOT = path.join(__dirname, "..", "..", "images", "icons");

/**
 * The Set Review Status rows in cm's order, each with its coloured icon: a
 * codicon in the label would take the label's colour, and a QuickPick drops
 * the colour of a ThemeIcon. The current status sits under a "Current"
 * separator, which VS Code draws right-aligned on that row.
 */
export function statusItems(current: string): IStatusItem[] {
  const items: IStatusItem[] = [];
  for (const status of reviewStatuses) {
    if (sameStatus(status, current)) {
      items.push({ kind: QuickPickItemKind.Separator, label: "Current" });
    }
    items.push({
      description: STATUS_DESCRIPTIONS[status],
      iconPath: {
        dark: Uri.file(path.join(ICONS_ROOT, "dark", STATUS_ICONS[status])),
        light: Uri.file(path.join(ICONS_ROOT, "light", STATUS_ICONS[status])),
      },
      label: status,
      status,
    });
  }
  return items;
}

/**
 * The Plastic Reviews commands: view titles, row context menus, editor title
 * actions, the comment UI and the Command Palette. Rows pass their node; the
 * editor title passes the editor's URI; the palette and keybindings pass
 * nothing, which means the active review or the active review file. Anything
 * else is logged and ignored, as a stale row or a keybinding could send it.
 */
export class ReviewActions implements Disposable {
  private readonly disposables: Disposable[];
  /** The last file opened from Changes, per review, where Open Next Unviewed File continues. */
  private readonly lastOpened = new Map<string, string>();

  public constructor(private readonly options: IReviewActionsOptions) {
    const handlers: { [name in ReviewCommandName]: (...args: unknown[]) => unknown } = {
      allowRetry: arg => this.withComment(arg, comment => this.options.posting.allowRetry(comment)),
      cancelComment: arg => this.cancelComment(arg),
      close: () => this.closeReview(),
      configurePosting: () => this.options.posting.configure(),
      copyChangesetComment: arg => this.copyChangeset(arg, "comment"),
      copyChangesetId: arg => this.copyChangeset(arg, "id"),
      copyDiscussionText: arg => this.copyDiscussionText(arg),
      copyPath: arg => this.copyPath(arg),
      copyReviewId: arg => this.copyReview(arg, "id"),
      copyTitle: arg => this.copyReview(arg, "title"),
      discardLocal: arg => this.withComment(arg, comment => this.options.posting.discardLocal(comment)),
      find: () => this.find(),
      forgetPosting: () => this.options.posting.forget(),
      loadMore: arg => this.loadMore(arg),
      loadMoreChangesets: () => this.options.session.loadMoreChangesets(),
      loadUpdates: () => this.loadUpdates(),
      markAllViewed: arg => this.markAllViewed(arg),
      markUnviewed: arg => this.markViewed(arg, false),
      markViewed: arg => this.markViewed(arg, true),
      markViewedAndNext: arg => this.step(arg, 1, true),
      nextFile: arg => this.step(arg, 1, false),
      open: (arg, reviewId) => this.open(arg, reviewId),
      openById: () => this.openById(),
      openChanges: arg => this.openChanges(arg),
      openDiscussion: arg => this.openDiscussion(arg),
      openNextUnviewed: () => this.openNextUnviewed(),
      openOverview: arg => this.showOverview(isObject(arg) && arg.kind === "overview"),
      openWorkspaceFile: arg => this.openWorkspaceFile(arg),
      postComment: arg => this.withReply(arg, reply => this.options.posting.postComment(reply)),
      postReply: arg => this.withReply(arg, reply => this.options.posting.postReply(reply)),
      previousFile: arg => this.step(arg, -1, false),
      refresh: () => this.options.session.refreshList(),
      refreshReview: () => this.options.session.reload(),
      retry: arg => this.retry(arg),
      sendAgain: arg => this.withComment(arg, comment => this.options.posting.sendAgain(comment)),
      setStatus: arg => this.setStatus(arg),
      show: () => commands.executeCommand("workbench.view.extension.plastic-scm-reviews"),
      switchWorkspace: () => this.switchWorkspace(),
      viewAsList: () => this.setLayout("list"),
      viewAsTree: () => this.setLayout("tree"),
    };
    this.disposables = REVIEW_COMMANDS.map(name => commands.registerCommand(
      `${REVIEW_COMMAND_PREFIX}${name}`, (...args: unknown[]) => this.run(name, () => handlers[name](...args))));
  }

  public dispose(): void {
    Disposable.from(...this.disposables).dispose();
    this.disposables.length = 0;
    this.lastOpened.clear();
  }

  /** Every file of Changes is viewed: say so, and offer the status change that usually follows. */
  public async announceAllViewed(): Promise<void> {
    const active = this.options.session.active;
    const progress = this.options.tree.progress();
    if (!active || !progress) {
      return;
    }
    const files = `${formatCount(progress.total)} file${progress.total === 1 ? "" : "s"}`;
    const choice = await window.showInformationMessage(
      `All ${files} in review #${active.review.id} are viewed.`, "Set Review Status…");
    if (choice) {
      await commands.executeCommand(`${REVIEW_COMMAND_PREFIX}setStatus`);
    }
  }

  /**
   * Opens what an Overview link names, as a click on its row in Discussions or
   * the Review view does. Anything can send such a URI (a browser passes
   * vscode:// links on), so it is read strictly, acts only on the active review
   * of a known workspace and never writes. A link that cannot open says why; a
   * path that is not one of ours is logged and ignored.
   */
  public handleUri(uri: Uri): Promise<void> {
    return this.run("openLink", () => this.openLink(uri));
  }

  /** Runs a command, or a link as one: a failure is logged and shown with a way to the output channel. */
  private async run(name: ReviewCommandName | "openLink", task: () => unknown): Promise<void> {
    try {
      await task();
    } catch (error) {
      const message = errorText(error);
      this.options.channel.appendLine(`Plastic Reviews: ${name} failed: ${message}`);
      const choice = await window.showErrorMessage(`Plastic Reviews: ${message}`, "Show Output");
      if (choice) {
        await commands.executeCommand("plastic-scm.showOutput");
      }
    }
  }

  private ignore(name: string, arg: unknown): void {
    let text: string;
    try {
      text = JSON.stringify(arg) ?? String(arg);
    } catch {
      text = String(arg);
    }
    this.options.channel.appendLine(`Plastic Reviews: ${name} ignored: unexpected argument ${text.substring(0, 200)}`);
  }

  /**
   * A row click is the user picking a review: it opens the review's Overview as
   * well. The `(workspaceId, reviewId)` form is for other code, and only makes
   * the review active.
   */
  private async open(arg: unknown, reviewId: unknown): Promise<void> {
    if (isReviewRow(arg)) {
      if (!isSupportedTarget(arg.review)) {
        showUnsupported(arg.review);
        return;
      }
      await this.activateAndShow(arg.workspaceId, arg.review.id, arg.review, true);
    } else if (typeof arg === "string" && typeof reviewId === "number") {
      await this.options.session.activate(arg, reviewId);
    } else {
      this.ignore("open", arg);
    }
  }

  /**
   * Makes a review the user picked active and opens its Overview once it is,
   * while its stages still load. `fromList`: a click in the Reviews list leaves
   * the keyboard there, as a tree click that opens a diff does.
   */
  private async activateAndShow(
      workspaceId: string, reviewId: number, header: IReview | undefined, fromList: boolean): Promise<void> {
    const session = this.options.session;
    let shown: Promise<void> | undefined;
    const show = () => {
      const active = session.active;
      if (!shown && active?.workspaceId === workspaceId && active.review.id === reviewId) {
        shown = this.showOverview(fromList);
      }
    };
    const listener = session.onDidChangeActive(show);
    try {
      // Picking the review that is already active changes nothing, so no event comes.
      show();
      await session.activate(workspaceId, reviewId, header);
    } finally {
      listener.dispose();
      await shown?.catch(error =>
        this.options.channel.appendLine(`Plastic Reviews: couldn't open the Overview: ${errorText(error)}`));
    }
  }

  /**
   * Opens the active review's Overview in VS Code's Markdown preview editor,
   * which stays on its document, so opening another Markdown file never takes
   * its place. It opens in the group that already shows it, else in the group
   * of the Overview it replaces, else in the active group; every other
   * review's Overview then closes. `preserveFocus`: a tree click keeps the
   * keyboard in the tree, and the active group stays the one the next diff
   * opens in.
   */
  private async showOverview(preserveFocus: boolean): Promise<void> {
    const active = this.options.session.active;
    if (!active) {
      void window.showInformationMessage("Open a review in Plastic Reviews first.");
      return;
    }
    this.options.editors.refreshOverview(active.workspaceId, active.review.id);
    const overviews = allTabs().filter(tab => overviewTabReview(tab) !== undefined);
    const own = overviews.find(tab => isOverviewTab(tab, active.workspaceId, active.review.id));
    const target = own ?? overviews[0];
    // A tree click on a review whose page is on screen leaves it be: opening it again makes its group the active one.
    if (!(preserveFocus && own?.isActive)) {
      const viewColumn = target?.group.viewColumn ?? window.tabGroups.activeTabGroup.viewColumn;
      // `background`, which VS Code reads though its typings leave it out, keeps the active group where it is. Only
      // for a page that takes the place of its group's visible tab: in the background it is not revealed otherwise.
      const background = preserveFocus && !!target?.isActive && !target.group.isActive;
      // Without the Markdown extension, VS Code opens the document as text instead.
      await commands.executeCommand("vscode.openWith", reviewOverviewUri(active.workspaceId, active.review.id),
        MARKDOWN_PREVIEW_EDITOR, { preserveFocus, preview: false, viewColumn, ...(background ? { background } : {}) });
    }
    await this.closeOtherOverviews();
  }

  /**
   * Closes the Overview of every review but the active one: it only says that
   * review is not open. A newer activation that lands while an Overview opens
   * makes this close that one too.
   */
  private async closeOtherOverviews(): Promise<void> {
    const active = this.options.session.active;
    const others = allTabs().filter(tab => {
      const shown = overviewTabReview(tab);
      return !!shown && !(active && isOverviewTab(tab, active.workspaceId, active.review.id));
    });
    if (others.length > 0) {
      await window.tabGroups.close(others, true);
    }
  }

  private async closeReview(): Promise<void> {
    this.options.session.close();
    await this.closeOtherOverviews();
  }

  private async openById(): Promise<void> {
    const session = this.options.session;
    const workspaceId = session.workspaceId;
    if (!workspaceId) {
      void window.showInformationMessage("Plastic Reviews needs an open Plastic workspace.");
      return;
    }
    const value = await window.showInputBox({
      placeHolder: "12831",
      prompt: `Review ID in ${session.workspaceName ?? "this workspace"}`,
      validateInput: text => reviewNumber(text) === undefined ? "Enter a review number, such as 12831." : undefined,
    });
    const id = value === undefined ? undefined : reviewNumber(value);
    if (id !== undefined) {
      await this.activateAndShow(workspaceId, id, undefined, false);
    }
  }

  /**
   * Find Review…: every review in the repository in a picker that filters on
   * the title, number, people, branch and status. The session keeps the
   * reviews for a while (see `ReviewSession.findReviews`); the picker is busy
   * until they have loaded. A pick opens the review as a list click does, but
   * moves the keyboard to its Overview, as Open Review by ID… does; a review
   * number the list may not have opens by ID.
   */
  private async find(): Promise<void> {
    const session = this.options.session;
    const workspaceId = session.workspaceId;
    if (!workspaceId) {
      void window.showInformationMessage("Plastic Reviews needs an open Plastic workspace.");
      return;
    }
    const choice = await pickReview(session.findReviews(), session.now, session.workspaceName);
    if (!choice) {
      return;
    }
    if (choice.review && !isSupportedTarget(choice.review)) {
      showUnsupported(choice.review);
      return;
    }
    await this.activateAndShow(workspaceId, choice.id, choice.review, false);
  }

  private async switchWorkspace(): Promise<void> {
    const session = this.options.session;
    const items = session.workspaces().map(wk => ({
      description: wk.path,
      detail: wk.id === session.workspaceId ? "Current" : undefined,
      id: wk.id,
      label: wk.name,
    }));
    const choice = await window.showQuickPick(items, { placeHolder: "Show the reviews of which Plastic workspace?" });
    if (choice) {
      session.selectWorkspace(choice.id);
      await this.closeOtherOverviews();
    }
  }

  private loadMore(arg: unknown): void {
    if (isObject(arg) && arg.kind === "loadMore" && typeof arg.key === "string") {
      this.options.session.loadMore(arg.key as Parameters<ReviewSession["loadMore"]>[0]);
    } else {
      this.ignore("loadMore", arg);
    }
  }

  private retry(arg: unknown): void {
    if (isObject(arg) && arg.kind === "error" && typeof arg.retry === "function") {
      (arg.retry as () => void)();
    } else {
      this.ignore("retry", arg);
    }
  }

  private async setStatus(arg: unknown): Promise<void> {
    const session = this.options.session;
    const active = session.active;
    let target: { workspaceId: string; review: IReview } | undefined;
    if (isReviewRow(arg)) {
      target = { review: arg.review, workspaceId: arg.workspaceId };
    } else if (active) {
      target = { review: active.review, workspaceId: active.workspaceId };
    }
    if (!target) {
      void window.showInformationMessage("Open a review in Plastic Reviews first.");
      return;
    }
    const { review, workspaceId } = target;
    const choice = await pickStatus(review);
    if (choice && !sameStatus(choice, review.status)) {
      await session.setStatus(workspaceId, review, choice);
    }
  }

  /**
   * Reloads the active review. When the active editor shows a file opened from
   * Changes or Merged from other branches and a row with the same path is still
   * in the review, that row is opened against the new comparison; every other
   * tab keeps its pinned revisions.
   */
  private async loadUpdates(): Promise<void> {
    const session = this.options.session;
    const before = this.activeFile();
    await session.reload();
    const active = session.active;
    const context = session.editorContext();
    if (!before || typeof before.scope !== "string" || !active || !context || active.files.state !== "ready") {
      return;
    }
    const files = active.files.value;
    const file = files.final.files.find(candidate => candidate.path === before.file.path);
    if (!file || !isDiffable(file)) {
      return;
    }
    const scope: FileScope = files.mergedKeys.has(fileKey(file)) ? "merged" : "changes";
    await this.openFile(files.final, file, scope, true);
  }

  private async copyReview(arg: unknown, what: "id" | "title"): Promise<void> {
    const review = isReviewRow(arg) ? arg.review : this.options.session.active?.review;
    if (!review) {
      void window.showInformationMessage("Open a review in Plastic Reviews first.");
      return;
    }
    await env.clipboard.writeText(what === "id" ? String(review.id) : review.title);
    window.setStatusBarMessage(what === "id" ? `Copied review ID ${review.id}` : "Copied review title", 2000);
  }

  private async setLayout(layout: "tree" | "list"): Promise<void> {
    const configuration = workspace.getConfiguration();
    await configuration.update(FILE_LAYOUT_SETTING, layout, layoutTarget(configuration.inspect(FILE_LAYOUT_SETTING)));
  }

  private markAllViewed(arg: unknown): void {
    let scope: FileScope | undefined;
    if (arg === undefined) {
      scope = "changes";
    } else if (isObject(arg) && arg.kind === "changes") {
      scope = "changes";
    } else if (isChangeset(arg)) {
      scope = { changesetId: arg.changeset.id };
    }
    if (!scope) {
      this.ignore("markAllViewed", arg);
      return;
    }
    const files = this.options.tree.scopeFiles(scope);
    if (!files) {
      void window.showInformationMessage("Expand it first so its files are loaded.");
      return;
    }
    this.options.session.setViewed(files, true);
  }

  private async openChanges(arg: unknown): Promise<void> {
    if (!isFile(arg)) {
      this.ignore("openChanges", arg);
      return;
    }
    if (!this.isActive(arg.group.workspaceId, arg.group.reviewId)) {
      void window.showInformationMessage("This file belongs to a review that is no longer open.");
      return;
    }
    await this.openFile(arg.group.comparison, arg.file, arg.group.scope, true);
  }

  private async openWorkspaceFile(arg: unknown): Promise<void> {
    const target = this.fileTarget(arg);
    if (!target) {
      this.ignore("openWorkspaceFile", arg);
      return;
    }
    const wk = this.options.session.workspaces().find(candidate => candidate.id === target.workspaceId);
    const name = path.posix.basename(target.file.path);
    if (!wk) {
      return;
    }
    // An xlinked repository's paths only exist inside that xlink's own workspace.
    if (wk.repository && target.file.repository && !sameRepository(wk.repository, target.file.repository)) {
      void window.showInformationMessage(
        `${name} belongs to repository ${target.file.repository}, not to this workspace.`);
      return;
    }
    const local = path.join(wk.path, ...target.file.path.split("/").filter(Boolean));
    if (!await exists(local)) {
      void window.showInformationMessage(`${name} is not in this workspace.`);
      return;
    }
    await commands.executeCommand("vscode.open", Uri.file(local));
  }

  private async copyPath(arg: unknown): Promise<void> {
    let text: string | undefined;
    if (isFolder(arg)) {
      text = arg.path;
    } else {
      text = this.fileTarget(arg)?.file.path;
    }
    if (text === undefined) {
      this.ignore("copyPath", arg);
      return;
    }
    await env.clipboard.writeText(text);
    window.setStatusBarMessage("Copied path", 2000);
  }

  private async copyChangeset(arg: unknown, what: "id" | "comment"): Promise<void> {
    if (!isChangeset(arg)) {
      this.ignore(what === "id" ? "copyChangesetId" : "copyChangesetComment", arg);
      return;
    }
    await env.clipboard.writeText(what === "id" ? String(arg.changeset.id) : arg.changeset.comment);
    window.setStatusBarMessage(what === "id" ? "Copied changeset ID" : "Copied changeset comment", 2000);
  }

  private markViewed(arg: unknown, viewed: boolean): void {
    let files: IChangesetFileChange[] | undefined;
    if (isFolder(arg)) {
      files = this.isActive(arg.group.workspaceId, arg.group.reviewId) ? arg.files : undefined;
    } else if (isFile(arg)) {
      files = this.isActive(arg.group.workspaceId, arg.group.reviewId) ? [arg.file] : undefined;
    } else {
      const target = this.fileTarget(arg);
      files = target && [target.file];
    }
    if (!files) {
      this.ignore(viewed ? "markViewed" : "markUnviewed", arg);
      return;
    }
    this.options.session.setViewed(files, viewed);
    this.options.afterOpen?.();
  }

  /**
   * Previous/next inside the scope the diff was opened from: Changes, Merged
   * from other branches or one changeset, in display order, skipping rows
   * without a text diff.
   */
  private async step(arg: unknown, direction: 1 | -1, markViewed: boolean): Promise<void> {
    const target = this.fileTarget(arg);
    if (!target) {
      void window.showInformationMessage("Open a file of the active review first.");
      return;
    }
    const session = this.options.session;
    const tree = this.options.tree;
    if (markViewed) {
      session.setViewed([target.file], true);
    }
    const order = tree.navigationOrder(target.scope);
    const index = order.findIndex(file => fileKey(file) === fileKey(target.file));
    const next = index < 0 ? order[direction > 0 ? 0 : order.length - 1] : order[index + direction];
    if (!next) {
      const files = tree.scopeFiles(target.scope) ?? [];
      const unviewed = files.length - session.viewedCount(files);
      window.setStatusBarMessage(
        `${direction > 0 ? "Last" : "First"} file in ${scopeLabel(target.scope)} · ${formatCount(unviewed)} not viewed`,
        4000);
      this.options.afterOpen?.();
      return;
    }
    // Focus follows into the next diff: these run from the editor, where the keyboard loop happens.
    await this.openFile(tree.comparison(target.scope) ?? target.comparison, next, target.scope, false);
  }

  /** The first unviewed file of Changes after the last one opened, wrapping once. */
  private async openNextUnviewed(): Promise<void> {
    const session = this.options.session;
    const active = session.active;
    if (!active) {
      void window.showInformationMessage("Open a review in Plastic Reviews first.");
      return;
    }
    const tree = this.options.tree;
    const comparison = tree.comparison("changes");
    const order = tree.navigationOrder("changes");
    if (!comparison || !order.length) {
      void window.showInformationMessage(comparison
        ? "No file in Changes has a text diff."
        : "The review's changes are still loading.");
      return;
    }
    const last = this.lastOpened.get(identity(active.workspaceId, active.review.id));
    const start = last === undefined ? 0 : order.findIndex(file => fileKey(file) === last) + 1;
    for (let offset = 0; offset < order.length; offset++) {
      const file = order[(start + offset) % order.length];
      if (!session.isViewed(file)) {
        await this.openFile(comparison, file, "changes", true);
        return;
      }
    }
    const progress = tree.progress();
    if (progress && progress.viewed < progress.total) {
      const left = progress.total - progress.viewed;
      void window.showInformationMessage(
        `Every file with a text diff is viewed; ${left} file${left === 1 ? "" : "s"} without one ` +
        `${left === 1 ? "is" : "are"} not. Check ${left === 1 ? "it" : "them"} in the Review view.`);
      return;
    }
    await this.announceAllViewed();
  }

  private async openDiscussion(arg: unknown): Promise<void> {
    if (!isThread(arg)) {
      this.ignore("openDiscussion", arg);
      return;
    }
    if (!this.isActive(arg.workspaceId, arg.reviewId)) {
      void window.showInformationMessage("This discussion belongs to a review that is no longer open.");
      return;
    }
    if (arg.general) {
      await this.showOverview(true);
      return;
    }
    const context = this.options.session.editorContext()!;
    // A tree click: the diff opens beside the tree, which keeps the keyboard.
    await this.options.session.track(() =>
      this.options.editors.openComment(context, arg.thread, { preserveFocus: true }));
    this.options.afterOpen?.();
  }

  private async openLink(uri: Uri): Promise<void> {
    const parsed = parseReviewLink(uri);
    if (parsed.kind !== "link") {
      const reason = parsed.kind === "unknown" ? "not a Plastic Reviews path" : `it has ${parsed.reason}`;
      this.options.channel.appendLine(
        `Plastic Reviews: link ignored, ${reason}: ${uri.toString(true).substring(0, 200)}`);
      if (parsed.kind === "malformed") {
        void window.showInformationMessage("This link does not name a discussion or a file of a Plastic review.");
      }
      return;
    }
    const { reviewId, target, workspaceId } = parsed.link;
    if (!this.options.session.workspaces().some(wk => wk.id === workspaceId)) {
      void window.showInformationMessage(
        `Review #${reviewId} belongs to a Plastic workspace that is not open in this window.`);
      return;
    }
    if (!this.isActive(workspaceId, reviewId)) {
      void window.showInformationMessage(
        `Open review #${reviewId} in Plastic Reviews first, then follow the link again.`);
      return;
    }
    if (target.kind === "thread") {
      await this.openThreadLink(workspaceId, reviewId, target.threadId);
    } else {
      await this.openFileLink(reviewId, target.scope, target.fileKey);
    }
  }

  /** A discussion link: what selecting the thread's row in Discussions does. */
  private async openThreadLink(workspaceId: string, reviewId: number, threadId: number): Promise<void> {
    const stage = this.options.session.active!.discussions;
    if (stage.state !== "ready") {
      void window.showInformationMessage(stage.state === "error"
        ? `The discussions of review #${reviewId} did not load. Retry them in the Discussions view.`
        : `The discussions of review #${reviewId} are still loading. Follow the link again in a moment.`);
      return;
    }
    const thread = stage.value.threads.find(candidate => candidate.id === threadId);
    if (!thread) {
      void window.showInformationMessage(`That discussion is no longer in review #${reviewId}.`);
      return;
    }
    const general = isGeneralThread(thread);
    if (!general && !hasLocation(thread)) {
      void window.showInformationMessage(
        "This comment is about the whole file, not one line. Hover its row in Discussions to read it.");
      return;
    }
    await this.openDiscussion({ general, kind: "thread", reviewId, thread, workspaceId });
  }

  /** A file link: what clicking the file's row in the Review view does. */
  private async openFileLink(reviewId: number, scope: FileScope, key: string): Promise<void> {
    const tree = this.options.tree;
    const session = this.options.session;
    const active = session.active!;
    const changesetId = typeof scope === "string" ? undefined : scope.changesetId;
    if (changesetId !== undefined && active.changesets.state === "ready" &&
        !active.changesets.value.items.some(changeset => changeset.id === changesetId)) {
      void window.showInformationMessage(active.changesets.value.hasMore
        ? `cs:${changesetId} is not among the changesets of review #${reviewId} loaded so far. ` +
          "Load more in the Review view, then follow the link again."
        : `cs:${changesetId} is not part of review #${reviewId}.`);
      return;
    }
    const comparison = tree.comparison(scope);
    if (!comparison) {
      // The review's files first: a changeset's files load only once they have.
      const changesetFailed = changesetId !== undefined &&
        (active.changesets.state === "error" || session.changesetFiles(changesetId).state === "error");
      const what = active.files.state === "error" || changesetId === undefined
        ? `review #${reviewId}` : `cs:${changesetId}`;
      void window.showInformationMessage(active.files.state === "error" || changesetFailed
        ? `The files of ${what} did not load. Retry them in the Review view.`
        : `The files of ${what} are still loading. Follow the link again in a moment.`);
      return;
    }
    const file = tree.scopeFiles(scope)?.find(row => fileKey(row) === key);
    if (!file) {
      void window.showInformationMessage(`That file is no longer in ${scopeLabel(scope)} of review #${reviewId}.`);
      return;
    }
    await this.openFile(comparison, file, scope, true);
  }

  private async copyDiscussionText(arg: unknown): Promise<void> {
    if (!isThread(arg)) {
      this.ignore("copyDiscussionText", arg);
      return;
    }
    const thread = arg.thread;
    const text = thread.comments.map((comment, index) => {
      const header = [ comment.owner || "unknown", index === 0 ? threadTypeLabel(thread) : commentTypeLabel(comment) ];
      const date = formatDate(comment.date);
      if (date) {
        header.push(date);
      }
      return `${header.join(" · ")}\n${comment.text.trim()}`;
    }).join("\n\n");
    await env.clipboard.writeText(text);
    window.setStatusBarMessage("Copied discussion", 2000);
  }

  private cancelComment(arg: unknown): void {
    if (isReply(arg)) {
      this.options.posting.cancel(arg);
    } else if (isThreadObject(arg)) {
      this.options.posting.cancel(arg);
    } else {
      this.ignore("cancelComment", arg);
    }
  }

  private async withReply(arg: unknown, action: (reply: CommentReply) => Promise<void>): Promise<void> {
    if (isReply(arg)) {
      await action(arg);
    } else {
      this.ignore("post", arg);
    }
  }

  private async withComment(arg: unknown, action: (comment: Comment) => unknown): Promise<void> {
    if (isComment(arg)) {
      await action(arg);
    } else {
      this.ignore("comment action", arg);
    }
  }

  private async openFile(
      comparison: IReviewComparison,
      file: IChangesetFileChange,
      scope: FileScope,
      preserveFocus: boolean): Promise<void> {
    const session = this.options.session;
    const active = session.active;
    const context = session.editorContext();
    if (!active || !context) {
      return;
    }
    const message = noDiffMessage(file);
    if (message) {
      void window.showInformationMessage(message);
      return;
    }
    if (scope === "changes") {
      this.lastOpened.set(identity(active.workspaceId, active.review.id), fileKey(file));
    }
    await session.track(() => this.options.editors.open(
      context, comparison, file, { preserveFocus, preview: true, scope }));
    this.options.afterOpen?.();
  }

  /** The review file a command is about: the editor-title URI, else the active tab; only in the active review. */
  private fileTarget(arg: unknown): IReviewFileAt | undefined {
    if (isFile(arg)) {
      const { group } = arg;
      return this.isActive(group.workspaceId, group.reviewId)
        ? { ...group, file: arg.file, side: "right" }
        : undefined;
    }
    if (arg !== undefined && !(arg instanceof Uri)) {
      return undefined;
    }
    const at = arg instanceof Uri ? this.options.editors.fileAt(arg) ?? this.activeFile() : this.activeFile();
    return at && this.isActive(at.workspaceId, at.reviewId) ? at : undefined;
  }

  private activeFile(): IReviewFileAt | undefined {
    return this.options.editors.activeFile();
  }

  private isActive(workspaceId: string, reviewId: number): boolean {
    const active = this.options.session.active;
    return !!active && active.workspaceId === workspaceId && active.review.id === reviewId;
  }
}

/**
 * Where a layout switch has to be written to take effect: a workspace value
 * overrides the user's, so it is changed where it is set.
 */
export function layoutTarget(inspected: { workspaceValue?: unknown } | undefined): ConfigurationTarget {
  return inspected?.workspaceValue !== undefined ? ConfigurationTarget.Workspace : ConfigurationTarget.Global;
}

function identity(workspaceId: string, reviewId: number): string {
  return `${workspaceId}/${reviewId}`;
}

function scopeLabel(scope: FileScope): string {
  if (scope === "changes") {
    return "Changes";
  }
  return scope === "merged" ? "Merged from other branches" : `cs:${scope.changesetId}`;
}

/** A review the list and Find Review… show but cannot open. */
function showUnsupported(review: IReview): void {
  void window.showInformationMessage(`Reviews of a ${review.targetType || "unknown target"} are not supported.`);
}

/**
 * The status picker. It opens on the first status that is not the current one,
 * so Enter changes something; undefined when it is dismissed.
 */
function pickStatus(review: IReview): Promise<ReviewStatus | undefined> {
  const items = statusItems(review.status);
  const picker = window.createQuickPick<IStatusItem>();
  picker.items = items;
  picker.placeholder = `Set status of review #${review.id} (currently ${review.status || "unknown"})`;
  picker.activeItems = items.filter(item => item.status && !sameStatus(item.status, review.status)).slice(0, 1);
  return new Promise(resolve => {
    picker.onDidAccept(() => {
      resolve(picker.selectedItems[0]?.status);
      picker.hide();
    });
    picker.onDidHide(() => {
      resolve(undefined);
      picker.dispose();
    });
    picker.show();
  });
}

/**
 * The Find Review… picker. It opens at once and is busy until `found`
 * arrives; a review number typed meanwhile can already be opened by ID. The
 * items are replaced only when the number the "Open review by ID" row offers
 * changes, since the row has to show it; filtering by text, or by a number the
 * row does not offer, never sends the reviews to the picker again. A number
 * typed makes its review, or else its changeset's review, the active row, so
 * Enter opens that one wherever the picker sorts it. Undefined when it is
 * dismissed; a failed load closes it and rejects, unless it was dismissed.
 */
function pickReview(
    found: Promise<IFoundReviews>,
    now: () => number,
    workspaceName: string | undefined): Promise<IReviewPickItem | undefined> {
  const picker = window.createQuickPick<IReviewPickItem>();
  const where = workspaceName ? ` in ${workspaceName}` : "";
  picker.placeholder = `Loading the reviews${where}…`;
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  picker.busy = true;
  let reviews: readonly IReview[] = [];
  let state: IReviewPickState = { loading: true };
  let time = now();
  let items: IReviewPickItem[] = [];
  let offered: number | undefined;
  const draw = (always: boolean) => {
    const typed = openableReviewNumber(reviews, picker.value, state);
    if (always || typed !== offered) {
      offered = typed;
      items = reviewPickItems(reviews, time, picker.value, state);
      picker.items = items;
    }
    const exact = exactReviewPick(items, picker.value);
    if (exact) {
      picker.activeItems = [exact];
    }
  };
  return new Promise((resolve, reject) => {
    let hidden = false;
    picker.onDidChangeValue(() => draw(false));
    picker.onDidAccept(() => {
      const item = picker.selectedItems[0];
      if (item) {
        resolve(item);
        picker.hide();
      }
    });
    picker.onDidHide(() => {
      hidden = true;
      resolve(undefined);
      picker.dispose();
    });
    picker.show();
    found.then(result => {
      if (hidden) {
        return;
      }
      reviews = result.reviews;
      state = { branches: result.branches, truncated: reviews.length >= FIND_LIMIT };
      time = now();
      picker.busy = false;
      if (!reviews.length) {
        picker.placeholder = `No reviews${where}`;
      } else if (state.truncated) {
        const limit = formatCount(FIND_LIMIT);
        picker.placeholder = `Only the newest ${limit} reviews are listed; type a number to open an older one`;
      } else {
        picker.placeholder = `Find a review${where} by title, number, person, branch or status`;
      }
      draw(true);
    }, (error: unknown) => {
      reject(error instanceof Error ? error : new Error(String(error)));
      picker.hide();
    });
  });
}

function allTabs(): Tab[] {
  return window.tabGroups.all.flatMap(group => group.tabs);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isReviewRow(value: unknown): value is IReviewRowArg {
  return isObject(value) && value.kind === "review" && typeof value.workspaceId === "string" &&
    isObject(value.review) && typeof value.review.id === "number" && typeof value.review.title === "string";
}

function isGroup(value: unknown): value is IFileArg["group"] {
  return isObject(value) && typeof value.workspaceId === "string" && typeof value.reviewId === "number" &&
    (typeof value.scope === "string" || isObject(value.scope)) && isObject(value.comparison);
}

function isFile(value: unknown): value is IFileArg {
  return isObject(value) && value.kind === "file" && isObject(value.file) && typeof value.file.path === "string" &&
    isGroup(value.group);
}

function isFolder(value: unknown): value is IFolderArg {
  return isObject(value) && value.kind === "folder" && typeof value.path === "string" && Array.isArray(value.files) &&
    isGroup(value.group);
}

function isChangeset(value: unknown): value is IChangesetArg {
  return isObject(value) && value.kind === "changeset" && isObject(value.changeset) &&
    typeof value.changeset.id === "number" && typeof value.changeset.comment === "string";
}

function isThread(value: unknown): value is IThreadArg {
  return isObject(value) && value.kind === "thread" && isObject(value.thread) &&
    Array.isArray(value.thread.comments) && typeof value.workspaceId === "string" &&
    typeof value.reviewId === "number" && typeof value.general === "boolean";
}

function isThreadObject(value: unknown): value is CommentThread {
  return isObject(value) && value.uri instanceof Uri && Array.isArray(value.comments);
}

function isReply(value: unknown): value is CommentReply {
  return isObject(value) && typeof value.text === "string" && isThreadObject(value.thread);
}

function isComment(value: unknown): value is Comment {
  return isObject(value) && isObject(value.author) && "body" in value;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}
