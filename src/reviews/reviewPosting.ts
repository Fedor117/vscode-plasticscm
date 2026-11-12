import {
  CancellationToken,
  Comment,
  CommentMode,
  CommentReply,
  CommentThread,
  Disposable,
  Event,
  EventEmitter,
  InputBoxOptions,
  MarkdownString,
  ProgressLocation,
  QuickPickItem,
  Uri,
  window,
  workspace,
} from "vscode";
import {
  firstLine,
  formatDate,
  isOwnComment,
  isOwnDescription,
  reviewCommentMarkdown,
  truncate,
} from "./reviewPresentation";
import { IReviewComment, repositoryServer, ReviewStatus } from "./models";
import { IReviewDraft, ReviewWriteError, ReviewWriter } from "./reviewWriter";
import { randomBytes } from "crypto";
import { shortOwner } from "../history/graphModel";

/** The setting that allows review writes (comments, replies, edits, deletes, reviewers, own status). */
export const WRITES_SETTING = "plastic-scm.reviews.commentWrites";
/** The deprecated setting 0.4.x used; it still counts where the new one is not set. */
export const LEGACY_WRITES_SETTING = "plastic-scm.reviews.experimentalPosting";

/** What `writesSettingOn` needs of a configuration. */
export interface ISettingInspector {
  inspect<T>(section: string): {
    globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T;
  } | undefined;
}

/** The value set explicitly at any scope, the most specific first; undefined when it is set nowhere. */
function explicitValue(configuration: ISettingInspector, section: string): boolean | undefined {
  const inspected = configuration.inspect<boolean>(section);
  return inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
}

/**
 * Whether review writes are allowed: `commentWrites` where it is set at any
 * scope, else the deprecated `experimentalPosting` where that is (so a user
 * who turned it off stays off), else on.
 */
export function writesSettingOn(configuration: ISettingInspector = workspace.getConfiguration()): boolean {
  return explicitValue(configuration, WRITES_SETTING) ?? explicitValue(configuration, LEGACY_WRITES_SETTING) ?? true;
}
/** The setting that says where cm is; another cm may or may not have the review write commands. */
const CM_SETTING = "plastic-scm.cmConfiguration";
/** Where 0.4.0's Configure Experimental Posting… kept a bearer token, per workspace and repository. */
const LEGACY_SECRET_PREFIX = "plastic-reviews.experimental:";

/** What posting needs from the review editors: drafts pinned to a side and line, and the threads it writes into. */
export interface IPostingEditors {
  /** Set by posting: which local comments a thread refresh keeps. */
  keepLocalComment: (comment: Comment) => boolean;
  draftAt(uri: Uri, line: number): Promise<IReviewDraft>;
  replyDraft(thread: CommentThread): IReviewDraft | undefined;
  adopt(thread: CommentThread): void;
  disposeThread(thread: CommentThread): void;
  threadOf(comment: Comment): CommentThread | undefined;
  /** The server comment a rendered comment shows; undefined for local comments and anything else. */
  serverComment?(comment: Comment): ICommentTarget | undefined;
  setPostingEnabled(enabled: boolean): void;
}

/** What posting needs to know about a review workspace, and of the session that shows its reviews. */
export interface IPostingWorkspaces {
  /** The repository spec `cm status` reports; undefined until it is known. */
  repository(workspaceId: string): string | undefined;
  /** The workspace's root folder, where cm runs so that it finds the repository; undefined once it is gone. */
  root(workspaceId: string): string | undefined;
  /** Loads a review's discussions again when it is the open one: a posted comment comes back as the server's row. */
  reloadDiscussions(workspaceId: string, reviewId: number): Thenable<void>;
  /** The cm user of a workspace, as `cm whoami` answered; undefined until it has. Owns what it can edit or delete. */
  user?(workspaceId: string): string | undefined;
}

/**
 * A comment on the server that a write acts on: one shown in a review diff,
 * a Discussions row or the Overview, or the review's description.
 */
export interface ICommentTarget {
  workspaceId: string;
  reviewId: number;
  /** The server's row; for the description, a row whose text is the description without its marker. */
  comment: IReviewComment;
  /** The review's description: it may be edited, never deleted. */
  description?: boolean;
  /** How many replies it has, which the delete confirmation mentions. */
  replies?: number;
}

export interface IReviewPostingOptions {
  /** The effective writes setting; read on every use. */
  setting?: () => boolean;
  trusted?: () => boolean;
  /**
   * The modal shown before every send and every delete; resolves true when
   * `action` (the button, `Post` by default) was chosen.
   */
  confirm?: (message: string, detail: string, action?: string) => Thenable<boolean>;
  /** Where a refused action is explained. */
  notify?: (message: string) => void;
  /** Where a write whose result is unknown is explained: it may have happened. */
  warn?: (message: string) => void;
  /**
   * The text of a review-level comment, a reply or an edit; undefined when
   * dismissed. Accepting it is the confirmation of those writes.
   */
  input?: (options: InputBoxOptions) => Thenable<string | undefined>;
  /** Which of several comments a Discussions command acts on; undefined when dismissed. */
  pick?: <T extends QuickPickItem>(items: T[], placeHolder: string) => Thenable<T | undefined>;
  /** Shows that a write runs, until it ends; a notification by default. */
  progress?: <T>(title: string, task: () => Promise<T>) => Thenable<T>;
  /** Deletes a secret the extension stored; only 0.4.0's bearer token is ever deleted, see `forgetLegacy`. */
  secrets?: { delete(key: string): Thenable<void> };
  /** Configuration changes; VS Code's by default. Tests fire their own. */
  configurationChanges?: Event<{ affectsConfiguration(section: string): boolean }>;
}

export type LocalPostState = "sending" | "posted" | "failed" | "uncertain";

interface ILocalPost {
  draft: IReviewDraft;
  text: string;
  state: LocalPostState;
  /** The thread it was appended to; a refresh can move it, see `IPostingEditors.threadOf`. */
  thread: CommentThread;
  /** Started with the gutter "+", as opposed to a reply in a review thread. */
  started: boolean;
}

/**
 * Whether review writes can work in a workspace: `settingOff`; `blocked` (the
 * workspace is untrusted, its repository is not known, or cm is missing or
 * older than the review write commands; `reason` says which); or `ready`.
 */
export type ReviewAccess =
  | { state: "settingOff" }
  | { state: "blocked"; reason: string }
  | { state: "ready" };

/**
 * Review writes with the installed cm and its own sign-in:
 * comments and replies from the native comment UI, and for the session Add Me
 * as Reviewer and the cm user's own verdict. There is no credential of the
 * extension's own. Every send is confirmed in a modal, and its result stays
 * in the thread as a local comment that keeps the text: posted (until the
 * review's discussions, which load again at once, bring the server's row),
 * not sent (Send Again reuses the draft key, so the writer refuses a
 * duplicate of an accepted comment), or unknown (a retry needs an explicit
 * Allow Another Attempt, which takes a new key).
 */
export class ReviewPosting implements Disposable {
  public readonly onDidChange: Event<void>;
  private readonly changes = new EventEmitter<void>();
  private readonly posts = new WeakMap<Comment, ILocalPost>();
  private readonly disposables: Disposable[] = [];
  /** The comments being edited in a review diff, with the body they showed before; see `startEdit`. */
  private readonly editing = new WeakMap<Comment, string | MarkdownString>();
  /** What cm last answered, through `access`, about each workspace's access; `enabled` reads it. */
  private readonly known = new Map<string, ReviewAccess>();
  /** The workspaces and repositories whose 0.4.0 bearer token was deleted this session; see `forgetLegacy`. */
  private readonly forgotten = new Set<string>();
  private activeWorkspace?: string;

  public constructor(
    private readonly writer: ReviewWriter,
    private readonly workspaces: IPostingWorkspaces,
    private readonly editors: IPostingEditors,
    private readonly options: IReviewPostingOptions = {}
  ) {
    this.onDidChange = this.changes.event;
    // Posted comments come back with the reloaded review; the others only exist here.
    editors.keepLocalComment = comment => this.posts.get(comment)?.state !== "posted";
    this.disposables.push(
      this.changes,
      this.changes.event(() => editors.setPostingEnabled(this.enabled)),
      (options.configurationChanges ?? workspace.onDidChangeConfiguration)(event => {
        if (event.affectsConfiguration(CM_SETTING)) {
          // Another cm, or the same one set up anew: what it can do is asked again.
          writer.forgetSupport();
        }
        if ([ WRITES_SETTING, LEGACY_WRITES_SETTING, CM_SETTING ].some(name => event.affectsConfiguration(name))) {
          void this.refresh();
        }
      }),
      workspace.onDidGrantWorkspaceTrust(() => void this.refresh())
    );
  }

  /**
   * Posting works in the active workspace: the setting is on, the workspace
   * trusted, its repository known, and cm has the review write commands.
   */
  public get enabled(): boolean {
    const workspaceId = this.activeWorkspace;
    return workspaceId !== undefined && !this.gate(workspaceId) && this.known.get(workspaceId)?.state === "ready";
  }

  public dispose(): void {
    Disposable.from(...this.disposables).dispose();
    this.disposables.length = 0;
  }

  /** The workspace whose reviews are shown; learns its access. */
  public async select(workspaceId: string | undefined): Promise<void> {
    this.activeWorkspace = workspaceId;
    await this.refresh();
  }

  /** Learns a workspace's access again, the active one's by default, and says so. */
  public async refresh(workspaceId = this.activeWorkspace): Promise<void> {
    if (workspaceId !== undefined) {
      await this.access(workspaceId);
    }
    this.changes.fire();
  }

  /** The effective writes setting, read on every call. */
  public settingOn(): boolean {
    return (this.options.setting ?? settingOn)();
  }

  /**
   * Whether review writes can work in a workspace. With the setting on and
   * the workspace trusted, it asks cm whether it has the review write
   * commands (`cm codereview comment --usage`; see `ReviewWriter.support`);
   * it writes nothing. What cm answered is kept for `enabled` (which checks
   * the rest itself, as it is now), and an answer that differs from the last
   * says so: a cm that was missing, slow or old when the workspace was
   * selected turns comments on once an action finds it ready.
   */
  public async access(workspaceId: string): Promise<ReviewAccess> {
    await this.forgetLegacy(workspaceId);
    if (!this.settingOn()) {
      return { state: "settingOff" };
    }
    const gate = this.gate(workspaceId);
    if (gate) {
      return { reason: gate, state: "blocked" };
    }
    const support = await this.writer.support();
    const access: ReviewAccess = support.supported ? { state: "ready" } : { reason: support.reason, state: "blocked" };
    const before = this.known.get(workspaceId);
    this.known.set(workspaceId, access);
    if (before && JSON.stringify(before) !== JSON.stringify(access)) {
      this.changes.fire();
    }
    return access;
  }

  /** Adds the cm user to a review's reviewers; rejects with a message safe to show. */
  public async addReviewer(workspaceId: string, reviewId: number, cancel?: CancellationToken): Promise<void> {
    await this.writer.addReviewer(await this.ready(workspaceId), reviewId, cancel);
  }

  /** Sets the cm user's own verdict on a review; rejects with a message safe to show. */
  public async setMyStatus(workspaceId: string, reviewId: number, status: ReviewStatus): Promise<void> {
    await this.writer.setStatus(await this.ready(workspaceId), reviewId, status);
  }

  /** Post Comment: a new comment on the line of an empty thread started with the gutter "+". */
  public async postComment(reply: CommentReply): Promise<void> {
    try {
      const { thread } = reply;
      const text = checkText(reply.text);
      const draft = await this.editors.draftAt(thread.uri, thread.range.start.line);
      const cwd = await this.ready(draft.workspaceId);
      if (!await this.confirm(draft)) {
        return;
      }
      this.editors.adopt(thread);
      // A reply needs the posted comment's GUID, which the thread only has once the review has loaded again.
      thread.canReply = false;
      thread.label = "Comment";
      await this.send(this.append(thread, { draft, started: true, state: "sending", text, thread }), cwd);
    } catch (error) {
      this.notify(error);
    }
  }

  /** Post Reply: a reply in a review thread shown in a review diff. */
  public async postReply(reply: CommentReply): Promise<void> {
    try {
      const { thread } = reply;
      const draft = this.editors.replyDraft(thread);
      if (!draft) {
        throw new Error("Only threads loaded from the review can be replied to. Refresh the review first.");
      }
      const text = checkText(reply.text);
      const earlier = thread.comments.map(comment => this.posts.get(comment)).filter(isPost);
      if (earlier.some(post => post.state === "sending")) {
        throw new Error("A reply in this thread is still being sent.");
      }
      if (earlier.some(post => post.text === text && post.state !== "failed")) {
        throw new Error("This reply was already sent from here. Refresh the review to check it.");
      }
      const cwd = await this.ready(draft.workspaceId);
      if (!await this.confirm(draft)) {
        return;
      }
      await this.send(this.append(thread, { draft, started: false, state: "sending", text, thread }), cwd);
    } catch (error) {
      this.notify(error);
    }
  }

  /** Cancel: drops a thread the user started but did not post. */
  public cancel(argument: CommentReply | CommentThread): void {
    const thread = "thread" in argument ? argument.thread : argument;
    if (!thread.comments.length) {
      thread.dispose();
    }
  }

  /** Send Again, for a comment that was definitely not sent: same draft key, so never a duplicate. */
  public async sendAgain(comment: Comment): Promise<void> {
    const post = this.posts.get(comment);
    if (!post || post.state !== "failed") {
      return;
    }
    try {
      const cwd = await this.ready(post.draft.workspaceId);
      if (await this.confirm(post.draft)) {
        await this.send(comment, cwd);
      }
    } catch (error) {
      this.notify(error);
    }
  }

  /** Allow Another Attempt, after an unknown result: a new key, accepting the risk of a duplicate. */
  public allowRetry(comment: Comment): void {
    const post = this.posts.get(comment);
    if (!post || post.state !== "uncertain") {
      return;
    }
    post.draft = { ...post.draft, key: newKey() };
    this.update(comment, "failed", "retry allowed; sending again may post a duplicate if the first attempt arrived");
  }

  /** Discard: removes a local comment that was not posted, with its thread when the user started it. */
  public discardLocal(comment: Comment): void {
    const post = this.posts.get(comment);
    if (!post || (post.state !== "failed" && post.state !== "uncertain")) {
      return;
    }
    const thread = this.threadOf(comment, post);
    thread.comments = thread.comments.filter(other => other !== comment);
    this.posts.delete(comment);
    if (post.started && !thread.comments.length) {
      this.editors.disposeThread(thread);
    }
  }

  /** Whether the cm user may edit and delete a comment of a workspace; see `isOwnComment`. */
  public owns(workspaceId: string, comment: IReviewComment): boolean {
    return isOwnComment(comment, this.workspaces.user?.(workspaceId));
  }

  /**
   * Whether the cm user may edit a target: their own comment, or their own
   * description, which is a timeline row (see `isOwnDescription`).
   */
  public mayEdit(target: ICommentTarget): boolean {
    if (!target.description) {
      return this.owns(target.workspaceId, target.comment);
    }
    const user = this.workspaces.user?.(target.workspaceId);
    const { date, guid, id, owner, text } = target.comment;
    return isOwnDescription({ date, guid, id, kind: "description", owner, text }, user);
  }

  /** The cm user of a workspace, once `cm whoami` has answered. */
  public user(workspaceId: string): string | undefined {
    return this.workspaces.user?.(workspaceId);
  }

  /**
   * Edit, on a comment of the cm user's in a review diff: the comment turns
   * into an editor holding its own text (its Markdown rendering would be
   * edited otherwise), with Save and Cancel. A refresh of the review's
   * threads renders the comment anew, which ends the edit.
   */
  public startEdit(comment: Comment): void {
    const target = this.editors.serverComment?.(comment);
    if (!target || !this.owns(target.workspaceId, target.comment) || comment.mode === CommentMode.Editing) {
      return;
    }
    this.editing.set(comment, comment.body);
    comment.body = target.comment.text;
    comment.mode = CommentMode.Editing;
    this.redraw(comment);
  }

  /** Cancel, on a comment being edited: its text as it was. */
  public cancelEdit(comment: Comment): void {
    const body = this.editing.get(comment);
    if (body === undefined) {
      return;
    }
    this.editing.delete(comment);
    comment.body = body;
    comment.mode = CommentMode.Preview;
    this.redraw(comment);
  }

  /**
   * Save, on a comment being edited: sends the new text with cm (Save is the
   * confirmation; nothing else is asked), then loads the discussions again.
   * Unchanged text sends nothing. cm refusing keeps the editor open with the
   * text, so it can be changed or cancelled; an unknown result ends the edit
   * and says so, as the server may have the new text.
   */
  public async saveEdit(comment: Comment): Promise<void> {
    const target = this.editors.serverComment?.(comment);
    const before = this.editing.get(comment);
    if (!target || before === undefined) {
      return;
    }
    const text = typeof comment.body === "string" ? comment.body : comment.body.value;
    try {
      if (text === target.comment.text) {
        this.cancelEdit(comment);
        return;
      }
      checkText(text);
      const cwd = await this.ready(target.workspaceId);
      await this.progress(`Saving your comment on review #${target.reviewId}…`,
        () => this.writer.editComment(cwd, target.comment.guid.trim(), text));
    } catch (error) {
      if (error instanceof ReviewWriteError && error.uncertain) {
        this.cancelEdit(comment);
        this.warn(error);
        await this.reload(target);
      } else {
        this.notify(error);
      }
      return;
    }
    this.editing.delete(comment);
    comment.body = markdown(text);
    comment.mode = CommentMode.Preview;
    this.redraw(comment);
    await this.reload(target);
  }

  /**
   * Add Comment…: a new comment on the whole review, from the Discussions
   * view or the Overview. Accepting the input box sends it; the review's
   * discussions then load again.
   */
  public async addReviewComment(workspaceId: string, reviewId: number): Promise<void> {
    await this.guard(async () => {
      const cwd = await this.ready(workspaceId);
      const text = await this.input({
        placeHolder: "Comment on the whole review",
        prompt: `${this.destination(workspaceId, reviewId)} Enter posts it.${LONG_TEXT}`,
        title: `Comment on review #${reviewId}`,
        validateInput: validText,
      });
      if (text === undefined) {
        return;
      }
      const draft: IReviewDraft = {
        key: newKey(), location: -1, path: "", reviewId, revisionId: -1, workspaceId,
      };
      await this.run({ reviewId, workspaceId }, `Posting a comment to review #${reviewId}…`,
        () => this.writer.send(cwd, draft, text));
    });
  }

  /** Reply…: a reply to a comment, from the input box; Discussions and the Overview offer it. */
  public async replyTo(target: ICommentTarget): Promise<void> {
    await this.guard(async () => {
      const cwd = await this.ready(target.workspaceId);
      const owner = shortOwner(target.comment.owner) || "the author";
      const text = await this.input({
        placeHolder: `Reply to ${owner}`,
        prompt: `${this.destination(target.workspaceId, target.reviewId)} Replying to: ` +
          `${quote(target.comment.text)} Enter posts it.${LONG_TEXT}`,
        title: `Reply on review #${target.reviewId}`,
        validateInput: validText,
      });
      if (text === undefined) {
        return;
      }
      const draft: IReviewDraft = {
        key: newKey(),
        location: -1,
        parentGuid: target.comment.guid.trim(),
        path: "",
        reviewId: target.reviewId,
        revisionId: -1,
        workspaceId: target.workspaceId,
      };
      await this.run(target, `Posting a reply to review #${target.reviewId}…`,
        () => this.writer.send(cwd, draft, text));
    });
  }

  /**
   * Edit…: new text for one of the cm user's comments, or for the review's
   * description, from an input box that starts with the current text. The
   * box has one line: line breaks of the current text are shown as spaces,
   * and the prompt says that saving keeps the text as typed.
   */
  public async editWithInput(target: ICommentTarget): Promise<void> {
    await this.guard(async () => {
      if (!this.mayEdit(target)) {
        throw new Error(target.description ? "Only your own description can be edited."
          : "Only your own comments can be edited.");
      }
      const cwd = await this.ready(target.workspaceId);
      const current = target.comment.text;
      const lines = /[\r\n]/.test(current.trim());
      const value = lines ? current.trim().replace(/\s*[\r\n]+\s*/g, " ") : current;
      const what = target.description ? "the description" : "your comment";
      const text = await this.input({
        prompt: `${this.destination(target.workspaceId, target.reviewId)} Enter saves ${what}.` +
          (lines ? " Its line breaks can't be shown here: saving keeps the text as typed, on one line." : "") +
          LONG_TEXT,
        title: `Edit ${what} on review #${target.reviewId}`,
        validateInput: validText,
        value,
      });
      if (text === undefined || text === value) {
        return;
      }
      await this.run(target, `Saving ${what} on review #${target.reviewId}…`,
        () => this.writer.editComment(cwd, target.comment.guid.trim(), text));
    });
  }

  /**
   * Delete, on one of the cm user's comments: always after a modal, which
   * says that it cannot be undone and, for a comment with replies, that cm's
   * help does not say what becomes of them. The description is never deleted.
   */
  public async deleteComment(target: ICommentTarget): Promise<void> {
    await this.guard(async () => {
      if (target.description || !this.owns(target.workspaceId, target.comment)) {
        throw new Error("Only your own comments can be deleted.");
      }
      const cwd = await this.ready(target.workspaceId);
      const replies = target.replies ?? 0;
      const detail = [
        `Review #${target.reviewId}: ${quote(target.comment.text)}`,
        ...(replies ? [`It has ${replies} ${replies === 1 ? "reply" : "replies"}. cm's help doesn't say ` +
          "whether replies are deleted with the comment."] : []),
        this.through(target.workspaceId),
      ].join("\n");
      if (!await this.ask("Delete this comment? This can't be undone.", detail, "Delete")) {
        return;
      }
      await this.run(target, `Deleting your comment on review #${target.reviewId}…`,
        () => this.writer.deleteComment(cwd, target.comment.guid.trim()));
    });
  }

  /**
   * Which of the cm user's comments a Discussions command acts on: the only
   * one, or the one picked when there are several; undefined when there is
   * none or the pick was dismissed.
   */
  public async chooseOwn(workspaceId: string, comments: readonly IReviewComment[], verb: string):
      Promise<IReviewComment | undefined> {
    const own = comments.filter(comment => this.owns(workspaceId, comment));
    if (own.length <= 1) {
      return own[0];
    }
    const items = own.map(comment => ({
      comment,
      description: formatDate(comment.date),
      label: truncate(firstLine(comment.text.trim()) || "(no text)", 80),
    }));
    const pick = this.options.pick ?? ((list, placeHolder) => window.showQuickPick(list, { placeHolder }));
    return (await pick(items, `Which of your comments do you want to ${verb}?`))?.comment;
  }

  /**
   * Runs a write that the user confirmed, with progress, says how it ended,
   * and loads the review's discussions again whatever the outcome: cm may
   * have written even when it says otherwise, and a refused write may be
   * refused because the comment changed meanwhile.
   */
  private async run(target: { workspaceId: string; reviewId: number }, title: string,
      task: () => Promise<unknown>): Promise<void> {
    try {
      await this.progress(title, task);
    } catch (error) {
      if (error instanceof ReviewWriteError && error.uncertain) {
        this.warn(error);
      } else {
        this.notify(error);
      }
    }
    await this.reload(target);
  }

  private async reload(target: { workspaceId: string; reviewId: number }): Promise<void> {
    try {
      await this.workspaces.reloadDiscussions(target.workspaceId, target.reviewId);
    } catch {
      // The write is done all the same; a refresh of the review shows it.
    }
  }

  /** Runs a comment command; whatever stops it is shown, never thrown. */
  private async guard(task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch (error) {
      this.notify(error);
    }
  }

  private progress<T>(title: string, task: () => Promise<T>): Thenable<T> {
    return (this.options.progress ?? withProgress)(title, task);
  }

  private input(options: InputBoxOptions): Thenable<string | undefined> {
    return (this.options.input ?? (box => window.showInputBox(box)))({ ignoreFocusOut: true, ...options });
  }

  /** Where a write goes, for the input box's prompt. */
  private destination(workspaceId: string, reviewId: number): string {
    return `Review #${reviewId} on ${this.server(workspaceId)}, through cm as the user cm is signed in as.`;
  }

  private through(workspaceId: string): string {
    return `Destination: ${this.server(workspaceId)} through cm, as the user cm is signed in as`;
  }

  private server(workspaceId: string): string {
    return repositoryServer(this.workspaces.repository(workspaceId) ?? "") || "the workspace's server";
  }

  private ask(title: string, detail: string, action: string): Thenable<boolean> {
    return (this.options.confirm ?? confirmModal)(title, detail, action);
  }

  /** Makes VS Code draw a changed comment: its thread needs a new array. */
  private redraw(comment: Comment): void {
    const thread = this.editors.threadOf(comment);
    if (thread) {
      thread.comments = thread.comments.slice();
    }
  }

  private warn(error: ReviewWriteError): void {
    (this.options.warn ?? (text => void window.showWarningMessage(text)))(`Result unknown: ${error.message}`);
  }

  /**
   * Deletes, once a session, the bearer token 0.4.0's Configure Experimental
   * Posting… kept for the workspace and its repository, whatever the setting:
   * nothing reads it any more, and no command is left to remove it.
   */
  private async forgetLegacy(workspaceId: string): Promise<void> {
    const repository = this.workspaces.repository(workspaceId);
    const key = JSON.stringify([ workspaceId, repository ]);
    if (!repository || !this.options.secrets || this.forgotten.has(key)) {
      return;
    }
    this.forgotten.add(key);
    try {
      await this.options.secrets.delete(`${LEGACY_SECRET_PREFIX}${key}`);
    } catch {
      // Unavailable secret storage: nothing more can be done about it.
    }
  }

  /** Why posting is off for a workspace whatever its cm; undefined when it may post. */
  private gate(workspaceId: string): string | undefined {
    if (!this.settingOn()) {
      return `Turn on the ${WRITES_SETTING} setting to post review comments.`;
    }
    if (!(this.options.trusted ?? (() => workspace.isTrusted))()) {
      return "Posting requires a trusted workspace.";
    }
    if (!this.workspaces.root(workspaceId)) {
      return "The review workspace is no longer available.";
    }
    return this.workspaces.repository(workspaceId)
      ? undefined
      : "The review workspace's repository is not known yet. Try again in a moment.";
  }

  /** The folder cm runs in for a workspace whose access is ready; rejects with why not otherwise. */
  private async ready(workspaceId: string): Promise<string> {
    const access = await this.access(workspaceId);
    const root = this.workspaces.root(workspaceId);
    if (access.state !== "ready" || !root) {
      throw new Error(unavailable(access));
    }
    return root;
  }

  private confirm(draft: IReviewDraft): Thenable<boolean> {
    const reply = draft.parentGuid !== undefined;
    const line = draft.location >= 0 ? `, line ${draft.location + 1}` : "";
    const server = repositoryServer(this.workspaces.repository(draft.workspaceId) ?? "");
    const detail = [
      `Destination: ${server || "the workspace's server"} through cm, as the user cm is signed in as`,
      reply
        ? `Reply in the discussion on ${draft.path}${line}`
        : `File: ${draft.path}${line}, revision ${draft.revisionId}`,
    ].join("\n");
    const title = `Post this ${reply ? "reply" : "comment"} to review #${draft.reviewId}?`;
    return (this.options.confirm ?? confirmModal)(title, detail);
  }

  private append(thread: CommentThread, post: ILocalPost): Comment {
    const comment: Comment = {
      author: { name: "You" },
      body: post.text,
      contextValue: "reviewLocal-sending",
      label: "Sending…",
      mode: CommentMode.Preview,
      timestamp: new Date(),
    };
    this.posts.set(comment, post);
    thread.comments = thread.comments.concat(comment);
    return comment;
  }

  /**
   * Sends a local comment with cm from `cwd` and shows how it went. Once
   * posted, the review's discussions load again: the server's row, with the
   * GUID a reply needs, replaces the local comment, which a thread refresh
   * does not keep.
   */
  private async send(comment: Comment, cwd: string): Promise<void> {
    const post = this.posts.get(comment);
    if (!post) {
      return;
    }
    this.update(comment, "sending");
    try {
      await this.writer.send(cwd, post.draft, post.text);
    } catch (error) {
      if (error instanceof ReviewWriteError && error.uncertain) {
        this.update(comment, "uncertain");
      } else {
        this.update(comment, "failed", error instanceof ReviewWriteError ? error.message : "posting failed");
      }
      return;
    }
    this.update(comment, "posted");
    try {
      await this.workspaces.reloadDiscussions(post.draft.workspaceId, post.draft.reviewId);
    } catch {
      // The comment is posted all the same; it stays marked Posted until the review is refreshed.
    }
  }

  private update(comment: Comment, state: LocalPostState, reason?: string): void {
    const post = this.posts.get(comment);
    if (!post) {
      return;
    }
    post.state = state;
    comment.contextValue = `reviewLocal-${state}`;
    comment.label = localLabel(state, reason);
    const thread = this.threadOf(comment, post);
    // A new array is what makes VS Code render the changed comment.
    thread.comments = thread.comments.slice();
  }

  private threadOf(comment: Comment, post: ILocalPost): CommentThread {
    const thread = this.editors.threadOf(comment) ?? post.thread;
    post.thread = thread;
    return thread;
  }

  private notify(error: unknown): void {
    (this.options.notify ?? (text => void window.showErrorMessage(text)))(message(error));
  }
}

/** What every input box says about text the box cannot hold. */
const LONG_TEXT = " For text with line breaks, use Unity Version Control.";

/** Why an access that is not `ready` cannot write. */
function unavailable(access: ReviewAccess): string {
  switch (access.state) {
  case "settingOff":
    return `Turn on the ${WRITES_SETTING} setting first.`;
  case "blocked":
    return access.reason;
  default:
    return "Review actions are not available in this workspace.";
  }
}

function localLabel(state: LocalPostState, reason?: string): string {
  switch (state) {
  case "sending":
    return "Sending…";
  case "posted":
    return "Posted";
  case "uncertain":
    return "Result unknown: check the review before retrying";
  default:
    return `Not sent: ${reason ?? "unknown error"}`;
  }
}

/** The input box's check of a comment's text; undefined when it may be sent. */
function validText(text: string): string | undefined {
  if (!text.trim()) {
    return "Enter some text.";
  }
  return text.length > 64000 ? "Enter at most 64,000 characters." : undefined;
}

/** The start of a comment, quoted on one line. */
function quote(text: string): string {
  return `"${truncate(firstLine(text.trim()) || "(no text)", 80)}"`;
}

/** Comment text as a rendered comment shows it; see `ReviewEditors.toComment`. */
function markdown(text: string): MarkdownString {
  const body = new MarkdownString(reviewCommentMarkdown(text));
  body.isTrusted = false;
  body.supportHtml = false;
  return body;
}

function withProgress<T>(title: string, task: () => Promise<T>): Thenable<T> {
  return window.withProgress({ location: ProgressLocation.Notification, title }, task);
}

function checkText(text: string): string {
  if (!text.trim()) {
    throw new Error("Enter a comment first.");
  }
  if (text.length > 64000) {
    throw new Error("Enter a comment of at most 64,000 characters.");
  }
  return text;
}

function isPost(post: ILocalPost | undefined): post is ILocalPost {
  return post !== undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function settingOn(): boolean {
  return writesSettingOn();
}

async function confirmModal(title: string, detail: string, action = "Post"): Promise<boolean> {
  return await window.showWarningMessage(title, { detail, modal: true }, action) === action;
}

function newKey(): string {
  return randomBytes(16).toString("hex");
}
