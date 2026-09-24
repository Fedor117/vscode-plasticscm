import { CmShell, ICmShell } from "../cm/shell";
import { commentsUnsupported, PAGE_SIZE, ReviewCommands } from "./commands";
import { currentReviewers, parseTimeline, pendingReviewRequests } from "./timeline";
import { Disposable, OutputChannel } from "vscode";
import { FileChangeStatus, IChangesetFileChange, IHistoryChangeset } from "../models";
import {
  fileKey,
  groupReviewThreads,
  IReview,
  IReviewChangeset,
  IReviewChangesets,
  IReviewComment,
  IReviewComparison,
  IReviewDiscussions,
  IReviewFiles,
  IReviewQueue,
  IReviewRevision,
  IReviewThread,
  IReviewTimelineEvent,
  IReviewUpdates,
  repositoryName,
  ReviewStatus,
  sameRepository,
} from "./models";
import { decodeRevision } from "../revisionContentProvider";
import { promises as fs } from "fs";
import { GetFile } from "../cm/commands";
import { IShellConfig } from "../config";

/** A result from `fileForRevision`: the final-diff row and, for an exact revision hit, its side. */
export interface IRevisionFile {
  file: IChangesetFileChange;
  /** Set when the revision is one side of the row itself; undefined for another revision of the item. */
  exact: "right" | "left" | undefined;
}

/** A branch that keeps moving is reported instead of chased. */
const MAX_LOAD_ATTEMPTS = 3;
/** Final comparisons whose per-changeset comparisons stay cached; older ones are dropped. */
const MAX_CACHED_FINALS = 4;
/** Decoded revision texts kept in memory; the bytes stay in the on-disk cache either way. */
const MAX_CACHED_TEXTS = 64;
const MAX_CACHED_REVISIONS = 10000;
const MAX_CACHED_ITEMS = 500;
const MAX_CACHED_CHANGESETS = 100;
const CANCELLED = "ReviewLoadCancelled";

const always = () => true;

/** True for the error a load throws once its `isCurrent` check says a newer load took over. */
export function isReviewLoadCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === CANCELLED;
}

/**
 * Reads reviews for one workspace through its own cm shell, so review queries
 * never queue behind the workspace's status refreshes. Every call goes through
 * that one shell. Loads are split into stages (files, discussions, changesets)
 * so each can be shown, fail and retry on its own; a loaded stage is a pinned
 * snapshot, and nothing here changes it afterwards.
 */
export class ReviewService implements Disposable {
  public readonly commands: ReviewCommands;
  private readonly shell: ICmShell;
  private started?: Promise<void>;
  private disposed = false;
  private sequence = 0;
  private me?: Promise<string>;
  private user?: string;
  private readonly revisions = new Map<string, Promise<IReviewRevision>>();
  private readonly texts = new Map<string, Promise<string>>();
  private readonly comparisons = new Map<string, Promise<IReviewComparison>>();
  private readonly finals: string[] = [];
  private readonly itemRevisions = new Map<string, number[]>();
  private readonly changesetsById = new Map<number, Promise<IHistoryChangeset | undefined>>();

  public constructor(
    public readonly workspaceId: string,
    public readonly workspacePath: string,
    channel: OutputChannel,
    config: IShellConfig,
    shell?: ICmShell
  ) {
    this.shell = shell ?? new CmShell(workspacePath, channel, config);
    this.commands = new ReviewCommands(this.shell);
  }

  /** What `whoami` answered, for a render that cannot wait; undefined until cm has answered. */
  public get knownUser(): string | undefined {
    return this.user;
  }

  public async ready(): Promise<void> {
    this.assertRunning();
    if (!this.started) {
      this.started = this.shell
        .start()
        .then(ok => {
          if (!ok) {
            throw new Error("Unable to start the review cm shell.");
          }
        })
        .catch(error => {
          this.started = undefined;
          throw error;
        });
    }
    await this.started;
    this.assertRunning();
  }

  public dispose(): void {
    this.disposed = true;
    this.revisions.clear();
    this.texts.clear();
    this.comparisons.clear();
    this.itemRevisions.clear();
    this.changesetsById.clear();
    this.shell.dispose();
  }

  /** The cm user, as `cm whoami` prints it. Asked once per service. */
  public whoami(): Promise<string> {
    if (!this.me) {
      this.me = this.ready()
        .then(() => this.commands.whoami())
        .then(user => {
          this.user = user;
          return user;
        })
        .catch(error => {
          this.me = undefined;
          throw error;
        });
    }
    return this.me;
  }

  public async review(id: number): Promise<IReview | undefined> {
    await this.ready();
    return this.commands.review(id);
  }

  /**
   * Needs My Review, from three queries: open reviews assigned to me, the
   * timeline rows that request me as a reviewer, and the requested reviews not
   * already known. Assignment is not the only way to be asked for a review;
   * most requests only exist in the timeline. It does not use the query for my
   * own reviews, so either part can fail without the other.
   */
  public async needsMyReview(): Promise<IReview[]> {
    await this.ready();
    const me = await this.whoami();
    const assigned = await this.commands.list("assignedOpen");
    const requests = await this.commands.reviewRequests(me);
    const known = new Set(assigned.map(review => review.id));
    const missing = pendingReviewRequests(requests, me).filter(id => !known.has(id));
    const requested = missing.length ? await this.commands.reviews(missing, true) : [];
    return unique(assigned.concat(requested))
      .filter(review => !sameUser(review.owner, me) && review.status === "Under review")
      .sort(newestFirst);
  }

  /** My own open reviews, from one query: Rework Requested and Waiting for Reviewers. */
  public async ownedQueue(): Promise<Pick<IReviewQueue, "reworkRequested" | "waitingForReviewers">> {
    await this.ready();
    const owned = await this.commands.list("ownedOpen");
    return {
      reworkRequested: owned.filter(review => review.status === "Rework required"),
      waitingForReviewers: owned.filter(review => review.status === "Under review"),
    };
  }

  /** One page of every open review, newest first. */
  public async allOpen(offset: number): Promise<IReview[]> {
    await this.ready();
    return this.commands.list("allOpen", offset);
  }

  /** One page of every review in the repository, anyone's and in any status, newest first. */
  public async allReviews(offset: number): Promise<IReview[]> {
    await this.ready();
    return this.commands.list("all", offset);
  }

  /** The newest `FIND_LIMIT` reviews in the repository, for Find Review…: one query. */
  public async findReviews(): Promise<IReview[]> {
    await this.ready();
    return this.commands.list("find");
  }

  /** Branch names by object id, hidden branches included; a deleted branch has none. */
  public async branchNames(ids: readonly number[]): Promise<Map<number, string>> {
    await this.ready();
    return this.commands.branchNames(ids);
  }

  /**
   * The files stage. A branch review's final comparison is the plain branch
   * diff, which cm computes from the branch base (the parent of its first
   * changeset) to the head, so it includes whatever was merged into the branch.
   * When the branch has merges, a `--clean` diff (plain checkins only, same
   * revisions) tells which of those rows changed only through merges; the
   * sides of every row stay the plain diff's. The head is read again at the end
   * and the stage starts over if it moved, so the comparison is pinned to one
   * head. Hidden branches are found by the second branch query.
   */
  public async loadFiles(review: IReview, isCurrent: () => boolean = always): Promise<IReviewFiles> {
    await this.ready();
    const targetId = targetNumber(review.target);
    if (review.targetType === "changeset") {
      // Only the label needs the parent; the comparison is still right without it.
      const changeset = await this.changeset(targetId).catch(() => undefined);
      this.checkCurrent(isCurrent);
      const files = await this.commands.diff(`cs:${targetId}`);
      this.checkCurrent(isCurrent);
      const base = changeset && changeset.parentId >= 0 ? changeset.parentId : undefined;
      return {
        base,
        branchDeleted: false,
        final: this.createFinal(review.id, files, targetId, base),
        head: targetId,
        mergedKeys: new Set<string>(),
        merges: [],
      };
    }
    if (review.targetType !== "branch") {
      throw new Error(`Reviews of ${review.targetType || "this object type"} are not supported.`);
    }
    for (let attempt = 0; attempt < MAX_LOAD_ATTEMPTS; attempt++) {
      const branch = await this.commands.branch(targetId);
      this.checkCurrent(isCurrent);
      if (!branch) {
        return {
          branchDeleted: true,
          final: this.createFinal(review.id, [], -1, undefined),
          head: -1,
          mergedKeys: new Set<string>(),
          merges: [],
        };
      }
      const head = branch.headChangesetId;
      const merges = await this.commands.merges(branch.name, head);
      this.checkCurrent(isCurrent);
      const files = await this.commands.diff(`br:${branch.name}`);
      this.checkCurrent(isCurrent);
      const mergedKeys = merges.length ? await this.mergedOnly(branch.name, files) : new Set<string>();
      this.checkCurrent(isCurrent);
      const first = await this.commands.firstChangeset(branch.name).catch(() => undefined);
      this.checkCurrent(isCurrent);
      const moved = (await this.commands.branch(targetId))?.headChangesetId !== head;
      this.checkCurrent(isCurrent);
      if (moved) {
        continue;
      }
      const base = first && first.parentId >= 0 ? first.parentId : undefined;
      // A branch with no changeset of its own: its head is where it starts, and there is nothing to diff.
      const label = !first && !files.length ? "no changesets yet" : undefined;
      return {
        base,
        branch,
        branchDeleted: false,
        final: this.createFinal(review.id, files, head, base, label),
        head,
        mergedKeys,
        merges,
      };
    }
    throw new Error("The branch changed while loading. Refresh to try again.");
  }

  /**
   * The discussions stage: every comment row, timeline included, grouped into
   * threads. Anchor revisions are read in batches only to name each thread's
   * server path; `files` lets exact revision hits use the diff's own path.
   */
  public async loadDiscussions(
      review: IReview,
      files?: IReviewFiles,
      isCurrent: () => boolean = always): Promise<IReviewDiscussions> {
    await this.ready();
    const read = await this.readComments(review.id);
    this.checkCurrent(isCurrent);
    const timeline = parseTimeline(read.comments);
    const threads = groupReviewThreads(read.comments, timeline);
    const messages = [read.message];
    try {
      await this.prefetchRevisions(threads.map(thread => thread.anchor.revisionId), "");
    } catch {
      messages.push("Some comment locations could not be loaded. Opening a discussion retries its original context.");
    }
    this.checkCurrent(isCurrent);
    for (const thread of threads) {
      thread.path = await this.threadPath(thread, files?.final.files ?? []);
    }
    return {
      message: messages.filter(Boolean).join(" ") || undefined,
      reviewers: currentReviewers(timeline),
      threads,
      timeline,
    };
  }

  /**
   * A review's threads without their paths: one comment query, enough to count
   * what is still open for a review whose stages are not loaded.
   */
  public async threads(review: IReview): Promise<IReviewThread[]> {
    await this.ready();
    const read = await this.readComments(review.id);
    if (read.message) {
      throw new Error(read.message);
    }
    return groupReviewThreads(read.comments, parseTimeline(read.comments));
  }

  /** A review's timeline, from one comment query: who is requested, for a review whose stages are not loaded. */
  public async timeline(review: IReview): Promise<IReviewTimelineEvent[]> {
    await this.ready();
    const read = await this.readComments(review.id);
    if (read.message) {
      throw new Error(read.message);
    }
    return parseTimeline(read.comments);
  }

  /**
   * The changesets stage: the branch's changesets up to the pinned head, newest
   * first, with merge destinations flagged; for a changeset review, the one
   * changeset. Changesets of hidden branches are included.
   */
  public async loadChangesets(review: IReview, files: IReviewFiles): Promise<IReviewChangesets> {
    await this.ready();
    if (files.branch) {
      const items = await this.commands.changesets(files.branch.name, files.head + 1);
      return { hasMore: items.length === PAGE_SIZE, items: items.map(item => flagMerge(item, files)) };
    }
    if (review.targetType === "changeset" && files.head >= 0) {
      const changeset = await this.changeset(files.head);
      return { hasMore: false, items: changeset ? [flagMerge(changeset, files)] : [] };
    }
    return { hasMore: false, items: [] };
  }

  /** The next page after `current`, as a new object; `current` is left as it is. */
  public async moreChangesets(files: IReviewFiles, current: IReviewChangesets): Promise<IReviewChangesets> {
    const last = current.items[current.items.length - 1];
    if (!files.branch || !current.hasMore || !last) {
      return current;
    }
    await this.ready();
    const next = await this.commands.changesets(files.branch.name, last.id);
    return {
      hasMore: next.length === PAGE_SIZE,
      items: current.items.concat(next.map(item => flagMerge(item, files))),
    };
  }

  /** One changeset against its parent, cached per final comparison. */
  public changesetComparison(files: IReviewFiles, changeset: IReviewChangeset): Promise<IReviewComparison> {
    if (!files.branch && changeset.id === files.head) {
      return Promise.resolve(files.final);
    }
    if (!files.branch || changeset.branch !== files.branch.name || changeset.id > files.head) {
      return Promise.reject(new Error("This changeset is not part of the loaded review."));
    }
    const id = `${files.final.id}:cs:${changeset.id}`;
    let pending = this.comparisons.get(id);
    if (!pending) {
      const base = changeset.parentId >= 0 ? changeset.parentId : undefined;
      pending = this.ready()
        .then(() => this.commands.diff(`cs:${changeset.id}`))
        .then((changes): IReviewComparison => ({
          baseChangesetId: base,
          files: changes,
          headChangesetId: changeset.id,
          id,
          kind: "changeset",
          label: sidesLabel(base, changeset.id),
        }))
        .catch(error => {
          this.comparisons.delete(id);
          throw error;
        });
      this.comparisons.set(id, pending);
    }
    return pending;
  }

  /**
   * What changed since the stages were loaded, or undefined when nothing did.
   * Three reads at most: the review, the branch (branch reviews with loaded
   * files) and the comments (with loaded discussions). Only discussion comments
   * count: timeline rows without text, such as the status change the user just
   * made, show up as `status` instead.
   */
  public async checkUpdates(
      review: IReview,
      files?: IReviewFiles,
      discussions?: IReviewDiscussions): Promise<IReviewUpdates | undefined> {
    await this.ready();
    const fresh = await this.commands.review(review.id);
    if (!fresh) {
      throw new Error("This review no longer exists or is not accessible.");
    }
    const updates: IReviewUpdates = { newComments: 0, removedComments: 0 };
    if (fresh.status !== review.status) {
      updates.status = fresh.status;
    }
    if (files && review.targetType === "branch") {
      const head = (await this.commands.branch(targetNumber(review.target)))?.headChangesetId ?? -1;
      if (head !== files.head) {
        updates.newHead = head;
      }
    }
    if (discussions) {
      const known = commentVersions(discussions.threads);
      const current = commentVersions(groupReviewThreads((await this.readComments(review.id)).comments));
      current.forEach((version, id) => {
        if (known.get(id) !== version) {
          updates.newComments++;
        }
      });
      known.forEach((_version, id) => {
        if (!current.has(id)) {
          updates.removedComments++;
        }
      });
    }
    const changed = updates.status !== undefined || updates.newHead !== undefined ||
      updates.newComments > 0 || updates.removedComments > 0;
    return changed ? updates : undefined;
  }

  /** Writes the status, then reads the review back so the caller shows what the server has. */
  public async setStatus(id: number, status: ReviewStatus): Promise<IReview> {
    await this.ready();
    await this.commands.setStatus(id, status);
    const review = await this.commands.review(id);
    if (!review) {
      throw new Error("The review could not be read back after changing its status.");
    }
    return review;
  }

  /**
   * Revision metadata, cached. Without a repository the id is resolved in the
   * workspace's repository, which is where comment anchors live.
   */
  public revision(id: number, repository = ""): Promise<IReviewRevision> {
    const key = `${repository}:${id}`;
    let pending = this.revisions.get(key);
    if (!pending) {
      pending = this.ready()
        .then(() => this.commands.revision(id, repository))
        .then(revision => {
          if (!revision) {
            throw new Error(`Revision ${id} is not accessible.`);
          }
          return revision;
        })
        .catch(error => {
          this.revisions.delete(key);
          throw error;
        });
      remember(this.revisions, key, pending, MAX_CACHED_REVISIONS);
    }
    return pending;
  }

  /**
   * A revision's text. The bytes are cached under the workspace root, next to
   * History's (same key, pruned daily with them); revision ids are only unique
   * per repository, so a revision without one is refused rather than guessed.
   */
  public text(id: number, repository: string, path: string): Promise<string> {
    if (id < 0) {
      return Promise.resolve("");
    }
    if (!repository) {
      return Promise.reject(new Error(`The repository of revision ${id} is unknown.`));
    }
    const key = `${repository}:${id}`;
    let pending = this.texts.get(key);
    if (!pending) {
      pending = this.ready()
        .then(() => GetFile.runRevision(this.workspacePath, id, repository, path, this.shell))
        .then(file => fs.readFile(file.fsPath))
        .then(decodeRevision)
        .catch(error => {
          this.texts.delete(key);
          throw error;
        });
    }
    remember(this.texts, key, pending, MAX_CACHED_TEXTS);
    return pending;
  }

  /**
   * The row of `files` a comment revision belongs to. An exact hit (the revision
   * is a side of a row) needs no cm call. Otherwise one `where itemid` query
   * lists the item's revisions and the row holding any of them is the item's;
   * matching by path would miss moves, and scanning every row's metadata costs
   * one query per 50 rows.
   */
  public async fileForRevision(
      files: readonly IChangesetFileChange[],
      revision: IReviewRevision,
      isCurrent: () => boolean = always): Promise<IRevisionFile | undefined> {
    const exact = exactRevisionFile(files, revision);
    if (exact || revision.itemId < 0) {
      return exact;
    }
    const key = `${repositoryName(revision.repository).toLowerCase()}:${revision.itemId}`;
    const cached = this.itemRevisions.get(key);
    const known = cached && itemFile(files, revision, cached);
    if (known) {
      return { exact: undefined, file: known };
    }
    // A cached list can predate a checkin on the item, so a miss asks again.
    await this.ready();
    const ids = await this.commands.itemRevisionIds(revision.itemId, revision.repository || undefined);
    this.checkCurrent(isCurrent);
    remember(this.itemRevisions, key, ids, MAX_CACHED_ITEMS);
    const file = itemFile(files, revision, ids);
    return file ? { exact: undefined, file } : undefined;
  }

  /** `/Assets/...` for a local path under this workspace; undefined for anything else. */
  public serverPath(localPath: string): string | undefined {
    return toServerPath(this.workspacePath, localPath);
  }

  private assertRunning(): void {
    if (this.disposed) {
      throw new Error("Review service has stopped.");
    }
  }

  private checkCurrent(isCurrent: () => boolean): void {
    this.assertRunning();
    if (!isCurrent()) {
      const error = new Error("A newer review load superseded this one.");
      error.name = CANCELLED;
      throw error;
    }
  }

  /**
   * Every final comparison gets a new id, so open editors keep the one they
   * were built from. `label` replaces the sides for a comparison with none.
   */
  private createFinal(
      reviewId: number,
      files: IChangesetFileChange[],
      head: number,
      base: number | undefined,
      label?: string): IReviewComparison {
    const id = `${reviewId}:final:${head}:${++this.sequence}`;
    this.finals.push(id);
    while (this.finals.length > MAX_CACHED_FINALS) {
      const dropped = `${this.finals.shift()!}:`;
      Array.from(this.comparisons.keys())
        .filter(key => key.startsWith(dropped))
        .forEach(key => this.comparisons.delete(key));
    }
    return {
      baseChangesetId: base,
      files,
      headChangesetId: head >= 0 ? head : undefined,
      id,
      kind: "final",
      label: head >= 0 ? label ?? sidesLabel(base, head) : "branch deleted",
    };
  }

  /** Keys of `files` rows missing from the `--clean` diff, which lists plain checkins only. */
  private async mergedOnly(branchName: string, files: readonly IChangesetFileChange[]): Promise<Set<string>> {
    const clean = new Set((await this.commands.diff(`br:${branchName}`, { clean: true })).map(fileKey));
    return new Set(files.map(fileKey).filter(key => !clean.has(key)));
  }

  private changeset(id: number): Promise<IHistoryChangeset | undefined> {
    let pending = this.changesetsById.get(id);
    if (!pending) {
      pending = this.commands.changeset(id).catch(error => {
        this.changesetsById.delete(id);
        throw error;
      });
      remember(this.changesetsById, id, pending, MAX_CACHED_CHANGESETS);
    }
    return pending;
  }

  private async prefetchRevisions(ids: number[], repository: string): Promise<void> {
    const missing = Array.from(new Set(ids)).filter(id => id > 0 && !this.revisions.has(`${repository}:${id}`));
    if (!missing.length) {
      return;
    }
    for (const row of await this.commands.revisions(missing, repository)) {
      const value = Promise.resolve(row);
      remember(this.revisions, `${repository}:${row.id}`, value, MAX_CACHED_REVISIONS);
      if (row.repository && row.repository !== repository) {
        remember(this.revisions, `${row.repository}:${row.id}`, value, MAX_CACHED_REVISIONS);
      }
    }
  }

  /**
   * The diff row's path when the anchor is exactly one side of a row (the left
   * side's path for a base revision), otherwise the anchor's local path made
   * relative to the workspace root.
   */
  private async threadPath(thread: IReviewThread, files: readonly IChangesetFileChange[]): Promise<string | undefined> {
    const id = thread.anchor.revisionId;
    if (id <= 0) {
      return undefined;
    }
    const revision = await this.revisions.get(`:${id}`)?.catch(() => undefined);
    const row = files.find(file => (file.revisionId === id || file.baseRevisionId === id) &&
      (!revision || sameRepository(file.repository, revision.repository)));
    if (row) {
      return row.revisionId === id ? row.path : row.oldPath ?? row.path;
    }
    return revision ? this.serverPath(revision.path) : undefined;
  }

  private async readComments(id: number): Promise<{ comments: IReviewComment[]; message?: string }> {
    try {
      return { comments: await this.commands.comments(id) };
    } catch (error) {
      if (commentsUnsupported(error)) {
        return {
          comments: [],
          message: "This cm client does not support review-comment queries. Update Plastic to read discussions here.",
        };
      }
      throw error;
    }
  }
}

export function targetNumber(target: string): number {
  if (!/^(?:(?:id|cs):)?\d+$/.test(target)) {
    throw new Error(`Unsupported review target: ${target}`);
  }
  return Number(target.replace(/^(?:id|cs):/, ""));
}

/**
 * `cm find revision` prints a local absolute path (the workspace root plus the
 * item's current path in the workspace). Stripping the root gives the server
 * path the diff rows use; anything outside the root has no server path here.
 */
export function toServerPath(
    root: string,
    localPath: string,
    ignoreCase = process.platform === "win32"): string | undefined {
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const path = localPath.replace(/\\/g, "/");
  const prefix = `${base}/`;
  if (!base || path.length <= prefix.length) {
    return undefined;
  }
  const head = path.substring(0, prefix.length);
  const inside = ignoreCase ? head.toLowerCase() === prefix.toLowerCase() : head === prefix;
  return inside ? `/${path.substring(prefix.length)}` : undefined;
}

/** "cs:3471 ↔ cs:3715", or "base ↔ cs:3715" when the base changeset is unknown. */
function sidesLabel(base: number | undefined, head: number): string {
  return `${base === undefined ? "base" : `cs:${base}`} ↔ cs:${head}`;
}

function exactRevisionFile(
    files: readonly IChangesetFileChange[],
    revision: IReviewRevision): IRevisionFile | undefined {
  const same = (file: IChangesetFileChange) => sameRepository(file.repository, revision.repository);
  const right = files.find(file => file.revisionId === revision.id && same(file));
  if (right) {
    // A deleted row's revision is the one that was deleted: the left side.
    return { exact: right.status & FileChangeStatus.Deleted ? "left" : "right", file: right };
  }
  const left = files.find(file => file.baseRevisionId === revision.id && same(file));
  return left ? { exact: "left", file: left } : undefined;
}

function itemFile(
    files: readonly IChangesetFileChange[],
    revision: IReviewRevision,
    ids: readonly number[]): IChangesetFileChange | undefined {
  const item = new Set(ids);
  return files.find(file => sameRepository(file.repository, revision.repository) &&
    (item.has(file.revisionId) || item.has(file.baseRevisionId)));
}

function flagMerge(changeset: IHistoryChangeset, files: IReviewFiles): IReviewChangeset {
  const merge = files.merges.find(link => link.destinationChangesetId === changeset.id);
  return { ...changeset, isMerge: !!merge, mergeSourceBranch: merge?.sourceBranch };
}

/** What a comment looked like, for telling an edit (or an applied change) from no change. */
function commentVersions(threads: readonly IReviewThread[]): Map<number, string> {
  const versions = new Map<number, string>();
  for (const thread of threads) {
    for (const comment of thread.comments) {
      const { appliedInChangesetId, location, parentId, revisionId, text, type } = comment;
      versions.set(comment.id, JSON.stringify([ text, type, appliedInChangesetId, revisionId, location, parentId ]));
    }
  }
  return versions;
}

function sameUser(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function unique(reviews: readonly IReview[]): IReview[] {
  const seen = new Set<number>();
  return reviews.filter(review => !seen.has(review.id) && !!seen.add(review.id));
}

function newestFirst(a: IReview, b: IReview): number {
  const time = (review: IReview) => {
    const value = Date.parse(review.date);
    return isNaN(value) ? 0 : value;
  };
  return time(b) - time(a) || b.id - a.id;
}

/** Map insertion order doubles as recency: a hit moves to the end, the oldest entry goes first. */
function remember<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) {
      break;
    }
    map.delete(oldest.value);
  }
}
