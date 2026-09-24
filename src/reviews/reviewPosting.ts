import {
  CancellationToken,
  Comment,
  CommentMode,
  CommentReply,
  CommentThread,
  Disposable,
  Event,
  EventEmitter,
  SecretStorage,
  Uri,
  window,
  workspace,
} from "vscode";
import { IReviewDraft, IReviewWriteConnection, ReviewWriteError, ReviewWriter } from "./reviewWriter";
import { randomBytes } from "crypto";

/** The setting that turns experimental posting on, under `plastic-scm.reviews`. */
export const POSTING_SETTING = "plastic-scm.reviews.experimentalPosting";

/** What posting needs from the review editors: drafts pinned to a side and line, and the threads it writes into. */
export interface IPostingEditors {
  /** Set by posting: which local comments a thread refresh keeps. */
  keepLocalComment: (comment: Comment) => boolean;
  draftAt(uri: Uri, line: number): Promise<IReviewDraft>;
  replyDraft(thread: CommentThread): IReviewDraft | undefined;
  adopt(thread: CommentThread): void;
  disposeThread(thread: CommentThread): void;
  threadOf(comment: Comment): CommentThread | undefined;
  setPostingEnabled(enabled: boolean): void;
}

export interface IReviewPostingOptions {
  /** The experimental setting; read on every use. */
  setting?: () => boolean;
  trusted?: () => boolean;
  /** The modal shown before every send; resolves true to send. */
  confirm?: (message: string, detail: string) => Thenable<boolean>;
  /** Where a refused action is explained. */
  notify?: (message: string) => void;
  writer?: ReviewWriter;
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

/** Unity Version Control cloud repositories, the only ones the hosted API serves. */
export function isCloudRepository(repository: string): boolean {
  return /@(?:cloud|unity)$/i.test(repository.trim());
}

/**
 * Whether Add Me as Reviewer can work in a workspace: `settingOff` (the
 * experimental setting is off), `blocked` (the workspace is untrusted or its
 * repository is not a cloud one; `reason` says which), `unconfigured` (no
 * saved connection) or `ready`.
 */
export type ReviewerAccess =
  | { state: "settingOff" }
  | { state: "blocked"; reason: string }
  | { state: "unconfigured" }
  | { state: "ready" };

/**
 * Experimental posting through Unity's hosted API, from the native comment UI.
 * Every send is confirmed in a modal, and its result stays in the thread as a
 * local comment that keeps the text: posted, not sent (Send Again reuses the
 * draft key, so the writer refuses a duplicate of an accepted comment), or
 * unknown (a retry needs an explicit Allow Another Attempt, which takes a new
 * key). The same connection adds the cm user to a review's reviewers (Add Me
 * as Reviewer). Credentials live in SecretStorage only and never reach a
 * comment, the output channel or an error message.
 */
export class ReviewPosting implements Disposable {
  public readonly onDidChange: Event<void>;
  private readonly changes = new EventEmitter<void>();
  private readonly connections = new Map<string, IReviewWriteConnection>();
  private readonly posts = new WeakMap<Comment, ILocalPost>();
  private readonly disposables: Disposable[] = [];
  private readonly writer: ReviewWriter;
  private activeWorkspace?: string;

  public constructor(
    private readonly secrets: SecretStorage | undefined,
    private readonly repository: (workspaceId: string) => string | undefined,
    private readonly editors: IPostingEditors,
    private readonly options: IReviewPostingOptions = {}
  ) {
    this.onDidChange = this.changes.event;
    this.writer = options.writer ?? new ReviewWriter();
    // Posted comments come back with the reloaded review; the others only exist here.
    editors.keepLocalComment = comment => this.posts.get(comment)?.state !== "posted";
    this.disposables.push(
      this.changes,
      this.changes.event(() => editors.setPostingEnabled(this.enabled)),
      workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration(POSTING_SETTING)) {
          this.changes.fire();
        }
      }),
      workspace.onDidGrantWorkspaceTrust(() => this.changes.fire())
    );
  }

  /** Posting works in the active workspace: setting on, trusted, cloud repository and a saved connection. */
  public get enabled(): boolean {
    return !!this.activeWorkspace && !this.unavailable(this.activeWorkspace);
  }

  /** A connection is saved for the active workspace (Forget is offered). */
  public get configured(): boolean {
    return !!this.activeWorkspace && this.configuredFor(this.activeWorkspace);
  }

  public dispose(): void {
    Disposable.from(...this.disposables).dispose();
    this.disposables.length = 0;
  }

  public configuredFor(workspaceId: string): boolean {
    const key = this.key(workspaceId);
    return key !== undefined && this.connections.has(key);
  }

  public destination(workspaceId: string): string | undefined {
    const key = this.key(workspaceId);
    const connection = key === undefined ? undefined : this.connections.get(key);
    return connection && `${connection.organization} / ${connection.repository}`;
  }

  /** The workspace whose reviews are shown; loads its saved connection. */
  public async select(workspaceId: string | undefined): Promise<void> {
    this.activeWorkspace = workspaceId;
    if (workspaceId) {
      await this.load(workspaceId);
    }
    this.changes.fire();
  }

  /** The experimental setting, read on every call. */
  public settingOn(): boolean {
    return (this.options.setting ?? settingOn)();
  }

  /** Whether Add Me as Reviewer can work in a workspace; reads its saved connection again. */
  public async reviewerAccess(workspaceId: string): Promise<ReviewerAccess> {
    if (!this.settingOn()) {
      return { state: "settingOff" };
    }
    const blocked = this.gate(workspaceId);
    if (blocked) {
      return { reason: blocked, state: "blocked" };
    }
    return await this.load(workspaceId) ? { state: "ready" } : { state: "unconfigured" };
  }

  /** Adds `user`, the cm user, to a review's reviewers; rejects with a message safe to show. */
  public async addReviewer(workspaceId: string, reviewId: number, user: string, cancel?: CancellationToken):
      Promise<void> {
    const connection = await this.connection(workspaceId);
    await this.writer.addReviewer(connection, reviewId, user, cancel);
  }

  /** Post Comment: a new comment on the line of an empty thread started with the gutter "+". */
  public async postComment(reply: CommentReply): Promise<void> {
    try {
      const { thread } = reply;
      const text = checkText(reply.text);
      const draft = await this.editors.draftAt(thread.uri, thread.range.start.line);
      const connection = await this.connection(draft.workspaceId);
      if (!await this.confirm(draft, connection)) {
        return;
      }
      this.editors.adopt(thread);
      // A reply needs a posted parent with a server id; this thread has neither until a refresh.
      thread.canReply = false;
      thread.label = "Comment (experimental)";
      await this.send(this.append(thread, { draft, started: true, state: "sending", text, thread }), connection);
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
      const connection = await this.connection(draft.workspaceId);
      if (!await this.confirm(draft, connection)) {
        return;
      }
      await this.send(this.append(thread, { draft, started: false, state: "sending", text, thread }), connection);
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
      const connection = await this.connection(post.draft.workspaceId);
      if (await this.confirm(post.draft, connection)) {
        await this.send(comment, connection);
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

  /** Configure Experimental Posting…: resolves true once a connection is saved, false when cancelled. */
  public async configure(): Promise<boolean> {
    const workspaceId = this.activeWorkspace;
    if (!workspaceId) {
      throw new Error("Open a review workspace first.");
    }
    const blocked = this.gate(workspaceId);
    if (blocked) {
      throw new Error(blocked);
    }
    const key = this.key(workspaceId);
    if (!this.secrets || key === undefined) {
      throw new Error("Experimental posting requires VS Code secret storage.");
    }
    const previous = this.connections.get(key);
    const organization = await window.showInputBox({
      ignoreFocusOut: true,
      prompt: "Experimental posting: enter the hosted API organization name. This does not enable cm authentication.",
      value: previous?.organization,
    });
    if (!organization?.trim()) {
      return false;
    }
    const repository = await window.showInputBox({
      ignoreFocusOut: true,
      prompt: `Hosted repository name for ${this.repository(workspaceId) ?? "this workspace"} ` +
        "(include any repository path prefix)",
      value: previous?.repository,
    });
    if (!repository?.trim()) {
      return false;
    }
    const token = await window.showInputBox({
      ignoreFocusOut: true,
      password: true,
      prompt: "Review-service bearer token. Stored securely; automatic login and token exchange are not implemented.",
      validateInput: value => !value.trim() || /\s/.test(value.trim())
        ? "Enter a bearer token without its Bearer prefix."
        : undefined,
    });
    if (!token?.trim()) {
      return false;
    }
    const connection = { organization: organization.trim(), repository: repository.trim(), token: token.trim() };
    await this.secrets.store(key, JSON.stringify(connection));
    this.connections.set(key, connection);
    this.changes.fire();
    return true;
  }

  public async forget(): Promise<void> {
    const key = this.activeWorkspace ? this.key(this.activeWorkspace) : undefined;
    if (key === undefined) {
      return;
    }
    await this.secrets?.delete(key);
    this.connections.delete(key);
    this.changes.fire();
  }

  /** The secret's key: workspace and repository, so a switched repository never reuses a token. */
  private key(workspaceId: string): string | undefined {
    const repository = this.repository(workspaceId);
    return repository ? `plastic-reviews.experimental:${JSON.stringify([ workspaceId, repository ])}` : undefined;
  }

  private async load(workspaceId: string): Promise<IReviewWriteConnection | undefined> {
    const key = this.key(workspaceId);
    if (key === undefined) {
      return undefined;
    }
    const saved = await this.secrets?.get(key);
    let connection: IReviewWriteConnection | undefined;
    try {
      const value = saved ? JSON.parse(saved) as Partial<IReviewWriteConnection> : undefined;
      if (value && typeof value.token === "string" && typeof value.organization === "string" &&
        typeof value.repository === "string") {
        connection = { organization: value.organization, repository: value.repository, token: value.token };
      }
    } catch {
      // An unreadable stored connection counts as none.
    }
    if (connection) {
      this.connections.set(key, connection);
    } else {
      this.connections.delete(key);
    }
    return connection;
  }

  /** Why posting is off for a workspace regardless of its connection; undefined when it may post. */
  private gate(workspaceId: string): string | undefined {
    if (!(this.options.setting ?? settingOn)()) {
      return `Turn on the ${POSTING_SETTING} setting to post review comments.`;
    }
    if (!(this.options.trusted ?? (() => workspace.isTrusted))()) {
      return "Posting requires a trusted workspace.";
    }
    const repository = this.repository(workspaceId);
    if (!repository) {
      return "The review workspace is no longer available.";
    }
    return isCloudRepository(repository)
      ? undefined
      : "Experimental posting only works with Unity Version Control cloud repositories.";
  }

  private unavailable(workspaceId: string): string | undefined {
    return this.gate(workspaceId) ??
      (this.configuredFor(workspaceId) ? undefined : "Configure experimental posting for this workspace first.");
  }

  private async connection(workspaceId: string): Promise<IReviewWriteConnection> {
    const blocked = this.gate(workspaceId);
    if (blocked) {
      throw new Error(blocked);
    }
    const connection = await this.load(workspaceId);
    if (!connection) {
      throw new Error("Configure experimental posting for this workspace first.");
    }
    return connection;
  }

  private confirm(draft: IReviewDraft, connection: IReviewWriteConnection): Thenable<boolean> {
    const reply = draft.parentId !== undefined;
    const line = draft.location >= 0 ? `, line ${draft.location + 1}` : "";
    const detail = [
      `Destination: ${connection.organization} / ${connection.repository}`,
      reply
        ? `Reply in the discussion on ${draft.path}${line}`
        : `File: ${draft.path}${line}, revision ${draft.revisionId}`,
      "Experimental: authentication and line encoding are unverified. " +
        "Refresh the review afterwards to check the result.",
    ].join("\n");
    const message = `Post this ${reply ? "reply" : "comment"} to review #${draft.reviewId}?`;
    return (this.options.confirm ?? confirmModal)(message, detail);
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

  private async send(comment: Comment, connection: IReviewWriteConnection): Promise<void> {
    const post = this.posts.get(comment);
    if (!post) {
      return;
    }
    this.update(comment, "sending");
    try {
      await this.writer.send(connection, post.draft, post.text);
      this.update(comment, "posted");
    } catch (error) {
      if (error instanceof ReviewWriteError && error.uncertain) {
        this.update(comment, "uncertain");
      } else {
        this.update(comment, "failed", error instanceof ReviewWriteError ? error.message : "posting failed");
      }
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
    const message = error instanceof Error ? error.message : String(error);
    (this.options.notify ?? (text => void window.showErrorMessage(text)))(message);
  }
}

function localLabel(state: LocalPostState, reason?: string): string {
  switch (state) {
  case "sending":
    return "Sending…";
  case "posted":
    return "Posted · refresh to verify";
  case "uncertain":
    return "Result unknown: check the review before retrying";
  default:
    return `Not sent: ${reason ?? "unknown error"}`;
  }
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

function settingOn(): boolean {
  return workspace.getConfiguration().get<boolean>(POSTING_SETTING, false);
}

async function confirmModal(message: string, detail: string): Promise<boolean> {
  return await window.showWarningMessage(message, { detail, modal: true }, "Post") === "Post";
}

function newKey(): string {
  return randomBytes(16).toString("hex");
}
