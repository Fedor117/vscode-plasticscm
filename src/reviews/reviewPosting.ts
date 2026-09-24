import {
  CancellationToken,
  Comment,
  CommentMode,
  CommentReply,
  CommentThread,
  Disposable,
  Event,
  EventEmitter,
  Uri,
  window,
  workspace,
} from "vscode";
import { CONSENT_MESSAGE, consentDetail, IOrganization, ReviewTokens, TokenState } from "./reviewTokens";
import { IReviewConnection, IReviewDraft, restOrigin, ReviewWriteError, ReviewWriter } from "./reviewWriter";
import { repositoryName, repositoryServer, ReviewStatus } from "./models";
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

/** What posting needs to know about a review workspace. */
export interface IPostingWorkspaces {
  /** The repository spec `cm status` reports; undefined until it is known. */
  repository(workspaceId: string): string | undefined;
  /** The cm user, as `cm whoami` prints it; rejects when cm cannot say. */
  user(workspaceId: string): Promise<string>;
}

export interface IReviewPostingOptions {
  /** The experimental setting; read on every use. */
  setting?: () => boolean;
  trusted?: () => boolean;
  /** The modal shown before every send; resolves true to send. */
  confirm?: (message: string, detail: string) => Thenable<boolean>;
  /** The modal shown before a post needs the first token for its server; resolves true to create one. */
  consent?: (message: string, detail: string) => Thenable<boolean>;
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

/** A workspace whose writes are not blocked: its server and user, and where the REST API is for them. */
interface IPostingTarget {
  server: string;
  user: string;
  /** The repository's name, without its server. */
  repository: string;
  organization: IOrganization;
  origin: string;
}

/** Unity Version Control cloud repositories, the only ones the REST API serves. */
export function isCloudRepository(repository: string): boolean {
  return /@(?:cloud|unity)$/i.test(repository.trim());
}

/**
 * Whether review writes can work in a workspace, as far as can be told
 * without creating or revealing a token or asking the REST API anything:
 * `settingOff`; `blocked` (the workspace is untrusted or not a cloud one, cm
 * is missing or too old, or the organization's region is not a documented
 * REST server; `reason` says which); `needsConsent` (no token for `server`
 * yet, and the user has not agreed to create one); `notAllowed` and
 * `disabled` (cm lately refused to create one; `message` says what an admin
 * can do, and `command` is the admin's command); or `ready`.
 */
export type ReviewAccess =
  | { state: "settingOff" }
  | { state: "blocked"; reason: string }
  | { state: "needsConsent"; server: string }
  | { state: "notAllowed"; message: string; command: string }
  | { state: "disabled"; message: string }
  | { state: "ready" };

/**
 * Experimental review writes through the Unity Version Control Server REST
 * API: comments and replies from the native comment UI, and for the session
 * Add Me as Reviewer and the cm user's own verdict. The credential is a
 * personal access token that ReviewTokens creates with cm, once the user has
 * agreed to it; it lives in SecretStorage only and never reaches a comment,
 * the output channel or an error message. Every send is confirmed in a modal,
 * and its result stays in the thread as a local comment that keeps the text:
 * posted, not sent (Send Again reuses the draft key, so the writer refuses a
 * duplicate of an accepted comment), or unknown (a retry needs an explicit
 * Allow Another Attempt, which takes a new key).
 */
export class ReviewPosting implements Disposable {
  public readonly onDidChange: Event<void>;
  private readonly changes = new EventEmitter<void>();
  private readonly posts = new WeakMap<Comment, ILocalPost>();
  private readonly disposables: Disposable[] = [];
  private readonly writer: ReviewWriter;
  /** What `refresh` last learned of each workspace: its access, and whether a token is saved for it. */
  private readonly known = new Map<string, { access: ReviewAccess; saved: boolean }>();
  /** The workspaces and repositories whose 0.4.0 bearer token was deleted this session; see `forgetLegacy`. */
  private readonly forgotten = new Set<string>();
  private activeWorkspace?: string;

  public constructor(
    private readonly tokens: ReviewTokens | undefined,
    private readonly workspaces: IPostingWorkspaces,
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
          void this.refresh();
        }
      }),
      workspace.onDidGrantWorkspaceTrust(() => void this.refresh())
    );
  }

  /**
   * Posting works in the active workspace: the setting is on, the workspace
   * trusted and a cloud one, and access is ready or only needs consent.
   */
  public get enabled(): boolean {
    const state = this.activeState();
    return state === "ready" || state === "needsConsent";
  }

  /** A token is saved for the active workspace: Revoke Review Access Token is offered. */
  public get hasToken(): boolean {
    return this.activeState() !== undefined && !!this.known.get(this.activeWorkspace!)?.saved;
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
      const { access, target } = await this.resolve(workspaceId);
      let saved = false;
      try {
        saved = !!target && !!await this.tokens?.saved(target.server, target.user);
      } catch {
        // Unreadable secrets: no token to revoke.
      }
      this.known.set(workspaceId, { access, saved });
    }
    this.changes.fire();
  }

  /** The experimental setting, read on every call. */
  public settingOn(): boolean {
    return (this.options.setting ?? settingOn)();
  }

  /**
   * Whether review writes can work in a workspace. Asks cm who the user is
   * and, once per server, about its organization; creates and reveals no
   * token, and asks the REST API nothing.
   */
  public async access(workspaceId: string): Promise<ReviewAccess> {
    return (await this.resolve(workspaceId)).access;
  }

  /** Remembers that the user agreed to a token for the workspace's server and user. */
  public async consent(workspaceId: string): Promise<void> {
    const { target } = await this.resolve(workspaceId);
    if (!target || !this.tokens) {
      throw new Error("Review actions are not available in this workspace.");
    }
    await this.tokens.consent(target.server, target.user);
    await this.refresh(workspaceId);
  }

  /** Adds the cm user to a review's reviewers; rejects with a message safe to show. */
  public async addReviewer(workspaceId: string, reviewId: number, cancel?: CancellationToken): Promise<void> {
    const connection = await this.connection(workspaceId);
    try {
      await this.writer.addReviewer(connection, reviewId, cancel);
    } finally {
      // Its token may be new, or cm may have refused to create one.
      await this.refresh(workspaceId);
    }
  }

  /** Sets the cm user's own verdict on a review; rejects with a message safe to show. */
  public async setMyStatus(workspaceId: string, reviewId: number, status: ReviewStatus): Promise<void> {
    const connection = await this.connection(workspaceId);
    try {
      await this.writer.setStatus(connection, reviewId, status);
    } finally {
      await this.refresh(workspaceId);
    }
  }

  /** Post Comment: a new comment on the line of an empty thread started with the gutter "+". */
  public async postComment(reply: CommentReply): Promise<void> {
    try {
      const { thread } = reply;
      const text = checkText(reply.text);
      const draft = await this.editors.draftAt(thread.uri, thread.range.start.line);
      const connection = await this.postingConnection(draft.workspaceId);
      if (!connection || !await this.confirm(draft, connection)) {
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
      const connection = await this.postingConnection(draft.workspaceId);
      if (!connection || !await this.confirm(draft, connection)) {
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
      const connection = await this.postingConnection(post.draft.workspaceId);
      if (connection && await this.confirm(post.draft, connection)) {
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

  /**
   * Revoke Review Access Token: revokes the active workspace's token with cm
   * and forgets it and the consent. Resolves what happened, to show.
   */
  public async revoke(): Promise<string> {
    const workspaceId = this.activeWorkspace;
    if (!workspaceId) {
      throw new Error("Open a review workspace first.");
    }
    const blocked = this.gate(workspaceId);
    if (blocked || !this.tokens) {
      throw new Error(blocked ?? "Review actions need VS Code's secret storage.");
    }
    const { server, user } = await this.identity(workspaceId);
    try {
      return await this.tokens.revoke(server, user)
        ? `Revoked the review access token for ${server}.`
        : `No review access token is saved for ${server}.`;
    } finally {
      await this.refresh(workspaceId);
    }
  }

  /** The active workspace's last known access state; undefined when there is none or it is not allowed to post. */
  private activeState(): ReviewAccess["state"] | undefined {
    const workspaceId = this.activeWorkspace;
    return workspaceId === undefined || this.gate(workspaceId) ? undefined : this.known.get(workspaceId)?.access.state;
  }

  /** A workspace's access, and for one that is not blocked, where and as whom it writes. */
  private async resolve(workspaceId: string): Promise<{ access: ReviewAccess; target?: IPostingTarget }> {
    await this.forgetLegacy(workspaceId);
    if (!this.settingOn()) {
      return { access: { state: "settingOff" }};
    }
    const blocked = (reason: string) => ({ access: { reason, state: "blocked" } as ReviewAccess });
    const gate = this.gate(workspaceId);
    if (gate || !this.tokens) {
      return blocked(gate ?? "Review actions need VS Code's secret storage.");
    }
    let identity: { server: string; user: string; repository: string };
    let organization: IOrganization;
    try {
      identity = await this.identity(workspaceId);
      organization = await this.tokens.organization(identity.server);
    } catch (error) {
      return blocked(message(error));
    }
    const { server, user } = identity;
    const origin = restOrigin(organization.region);
    if (!origin) {
      return blocked(`The Unity Version Control Server REST API documents no server for ${server}, whose region is ` +
        `"${organization.region}".`);
    }
    const target = { ...identity, organization, origin };
    let state: TokenState;
    try {
      state = await this.tokens.state(server, user);
    } catch (error) {
      return blocked(message(error));
    }
    switch (state.state) {
    case "needsConsent":
      return { access: { server, state: "needsConsent" }, target };
    case "notAllowed":
      return { access: { command: state.command, message: state.message, state: "notAllowed" }, target };
    case "disabled":
      return { access: { message: state.message, state: "disabled" }, target };
    default:
      return { access: { state: "ready" }, target };
    }
  }

  /** The workspace's server spec, repository name and cm user; rejects with a message safe to show. */
  private async identity(workspaceId: string): Promise<{ server: string; user: string; repository: string }> {
    const spec = this.workspaces.repository(workspaceId) ?? "";
    let user: string;
    try {
      user = (await this.workspaces.user(workspaceId)).trim();
    } catch (error) {
      throw new Error(`cm couldn't say who you are: ${message(error)}`);
    }
    if (!user) {
      throw new Error("cm couldn't say who you are.");
    }
    return { repository: repositoryName(spec), server: repositoryServer(spec), user };
  }

  /**
   * Deletes, once a session, the bearer token 0.4.0's Configure Experimental
   * Posting… kept for the workspace and its repository, whatever the setting:
   * nothing reads it any more, and no command is left to remove it.
   */
  private async forgetLegacy(workspaceId: string): Promise<void> {
    const repository = this.workspaces.repository(workspaceId);
    const key = JSON.stringify([ workspaceId, repository ]);
    if (!repository || !this.tokens || this.forgotten.has(key)) {
      return;
    }
    this.forgotten.add(key);
    try {
      await this.tokens.forgetLegacyToken(workspaceId, repository);
    } catch {
      // Unavailable secret storage: nothing more can be done about it.
    }
  }

  /** Why posting is off for a workspace whatever its token; undefined when it may post. */
  private gate(workspaceId: string): string | undefined {
    if (!this.settingOn()) {
      return `Turn on the ${POSTING_SETTING} setting to post review comments.`;
    }
    if (!(this.options.trusted ?? (() => workspace.isTrusted))()) {
      return "Posting requires a trusted workspace.";
    }
    const repository = this.workspaces.repository(workspaceId);
    if (!repository) {
      return "The review workspace is no longer available.";
    }
    return isCloudRepository(repository)
      ? undefined
      : "Experimental posting only works with Unity Version Control cloud repositories.";
  }

  /** The writer's connection for a workspace whose access is ready; rejects with why not otherwise. */
  private async connection(workspaceId: string): Promise<IReviewConnection> {
    const { access, target } = await this.resolve(workspaceId);
    const tokens = this.tokens;
    if (access.state !== "ready" || !target || !tokens) {
      throw new Error(unavailable(access));
    }
    const { organization, origin, repository, server, user } = target;
    return {
      organizations: [ organization.name, organization.unityId ].filter(name => !!name && name !== "-1"),
      origin,
      repository,
      server,
      token: stale => tokens.token(server, user, stale),
      user,
    };
  }

  /**
   * The connection for a post: without a token for its server yet, it asks
   * for consent first, and resolves undefined when the user declines. Rejects
   * with why posting cannot work in the workspace.
   */
  private async postingConnection(workspaceId: string): Promise<IReviewConnection | undefined> {
    const access = await this.access(workspaceId);
    if (access.state === "needsConsent") {
      if (!await (this.options.consent ?? consentModal)(CONSENT_MESSAGE, consentDetail(access.server))) {
        return undefined;
      }
      await this.consent(workspaceId);
    }
    return this.connection(workspaceId);
  }

  private confirm(draft: IReviewDraft, connection: IReviewConnection): Thenable<boolean> {
    const reply = draft.parentId !== undefined;
    const line = draft.location >= 0 ? `, line ${draft.location + 1}` : "";
    const detail = [
      `Destination: ${connection.server} through the Unity Version Control REST API`,
      reply
        ? `Reply in the discussion on ${draft.path}${line}`
        : `File: ${draft.path}${line}, revision ${draft.revisionId}`,
      "Experimental: line encoding is unverified. Refresh the review afterwards to check the result.",
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

  private async send(comment: Comment, connection: IReviewConnection): Promise<void> {
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
    } finally {
      // The first post of a server has created its token, or cm has refused to.
      await this.refresh(post.draft.workspaceId);
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

/** Why an access that is not `ready` cannot write. */
function unavailable(access: ReviewAccess): string {
  switch (access.state) {
  case "settingOff":
    return `Turn on the ${POSTING_SETTING} setting first.`;
  case "blocked":
    return access.reason;
  case "needsConsent":
    return `Create a personal access token for ${access.server} first.`;
  case "notAllowed":
  case "disabled":
    return access.message;
  default:
    return "Review actions are not available in this workspace.";
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function settingOn(): boolean {
  return workspace.getConfiguration().get<boolean>(POSTING_SETTING, false);
}

async function confirmModal(title: string, detail: string): Promise<boolean> {
  return await window.showWarningMessage(title, { detail, modal: true }, "Post") === "Post";
}

async function consentModal(title: string, detail: string): Promise<boolean> {
  return await window.showWarningMessage(title, { detail, modal: true }, "Create Token") === "Create Token";
}

function newKey(): string {
  return randomBytes(16).toString("hex");
}
