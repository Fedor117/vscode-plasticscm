import { CmRunner, ICmOutput, spawnCm } from "./cmRunner";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { CancellationToken } from "vscode";
import { join } from "path";
import { ReviewStatus } from "./models";
import { ReviewWriteError } from "./reviewWriteError";
import { tmpdir } from "os";

export { ReviewWriteError };

/**
 * A comment or a reply about to be sent. `key` identifies the draft, so that
 * one draft is never sent twice. A reply has `parentGuid`; a new comment is
 * pinned to `location` of `revisionId`, or applies to the whole review when
 * it has no revision.
 */
export interface IReviewDraft {
  key: string;
  workspaceId: string;
  reviewId: number;
  /** The revision the comment is on; negative for a comment on the whole review. */
  revisionId: number;
  /**
   * The changeset whose diff the comment was written in, when that diff shows
   * one changeset of the review; undefined when it shows the whole review.
   */
  changesetId?: number;
  /** Zero-based line in the revision; cm counts lines from 1. */
  location: number;
  path: string;
  /** The GUID of the comment a reply answers. */
  parentGuid?: string;
}

/** Whether a cm can write to reviews, and when it cannot, why, as a message safe to show. */
export type ReviewWriteSupport = { supported: true } | { supported: false; reason: string };

export interface IReviewWriterOptions {
  /** The cm to run, read on every use: the configured path can change. */
  cmPath: () => string;
  /** Runs cm once; by default as a child process. Tests replace it. */
  run?: CmRunner;
  /** Where each command is noted, as its name and review or comment id; never a comment's text. */
  log?: (message: string) => void;
  /**
   * The platform, which decides how a comment's text reaches cm (see
   * `send`); `process.platform` by default. Tests set it.
   */
  platform?: NodeJS.Platform;
  /** Where the folder for a comment's text file is made on Windows; the system's temporary folder by default. */
  tempDir?: () => string;
}

/** The first Unity Version Control client whose cm has the review write commands. */
export const MINIMUM_CLIENT = "11.0.16.10512";
export const CM_MISSING = "cm wasn't found. Check the plastic-scm.cmConfiguration.cmPath setting.";
const UNSUPPORTED = `Review writes need Unity Version Control client ${MINIMUM_CLIENT} or newer.`;
const MAX_TEXT = 64000;
const FROM_STDIN = "-commentsfile=-";
const NO_TEXT_FILE = "The text could not be written to a temporary file for cm. Nothing was sent.";
/**
 * What cm says when the server could not be reached or did not answer in
 * time. cm may have sent the write before it said so, so the result is not
 * known: a retry could post a duplicate.
 */
const LOST = new RegExp("time[ds]? ?out|did ?n[o'\u2019]t (?:respond|answer)|not respond|connect|unreachable|network|" +
  "socket|transport|unavailable", "i");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const WHOLE_UUID = new RegExp(`^${UUID.source}$`, "i");
/** cm's flag for each verdict of `cm codereview review`. */
const VERDICTS: { readonly [status in ReviewStatus]: string } = {
  "Reviewed": "--reviewed",
  "Rework required": "--rework-required",
  "Under review": "--under-review",
};


/** A write, for its command and its messages: `effect` says what may have happened when the result is unknown. */
interface IWrite {
  /** What the log calls it, such as `cm codereview comment add 312`. */
  name: string;
  args: string[];
  stdin?: string;
  /** How the log says where the text went, when there is one. */
  textIn?: string;
  effect: string;
}

/**
 * cm's arguments for a comment or a reply, validated before anything runs;
 * the text is not among them, it goes to cm on stdin (`-commentsfile=-`).
 *
 * A new comment names its revision and line (`--revision=revid:N --line=L`,
 * the line counted from 1) and is a plain comment: cm's default type would be
 * a change request. `--changeset=cs:N` is passed only for a draft written in
 * the diff of one changeset of the review, which is where cm then shows the
 * comment; without it cm files the comment under the diff of the whole
 * review, which is what a comment written there needs. This mirrors what the
 * server keeps: CHANGESET is -1 on comments of the whole diff and the
 * revision's own changeset on comments of a changeset's diff. A draft without
 * a revision is a comment on the whole review. A reply names only its
 * parent's GUID: cm puts it on the parent's file, line and changeset.
 */
export function commentArguments(draft: IReviewDraft): string[] {
  if (draft.parentGuid !== undefined) {
    if (!WHOLE_UUID.test(draft.parentGuid)) {
      throw new ReviewWriteError("This discussion cannot be replied to yet. Refresh the review first.");
    }
    return [ "codereview", "comment", "reply", draft.parentGuid, "-commentsfile=-" ];
  }
  checkReviewId(draft.reviewId);
  const args = [ "codereview", "comment", "add", String(draft.reviewId), "-commentsfile=-" ];
  if (!Number.isSafeInteger(draft.revisionId)) {
    throw new ReviewWriteError("This comment does not have a valid pinned revision and line.");
  }
  if (draft.revisionId < 0) {
    return args;
  }
  if (!Number.isSafeInteger(draft.location) || draft.location < 0) {
    throw new ReviewWriteError("This comment does not have a valid pinned revision and line.");
  }
  args.push(`--revision=revid:${draft.revisionId}`, `--line=${draft.location + 1}`);
  if (draft.changesetId !== undefined) {
    if (!Number.isSafeInteger(draft.changesetId) || draft.changesetId < 0) {
      throw new ReviewWriteError("This comment does not have a valid changeset.");
    }
    args.push(`--changeset=cs:${draft.changesetId}`);
  }
  args.push("--type=Comment");
  return args;
}

/**
 * What cm said when it refused, on one line and at most 300 characters,
 * without the "Error: " it starts its own diagnostics with; stderr first,
 * then stdout. Undefined when it printed nothing.
 */
export function cmMessage(output: Pick<ICmOutput, "stdout" | "stderr">): string | undefined {
  const text = [ output.stderr, output.stdout ].map(part => part.replace(/\s+/g, " ").trim()).find(Boolean);
  return text?.replace(/^(?:Error:\s*)+/i, "").substring(0, 300).trim() || undefined;
}

/**
 * Review writes with the installed cm and its own sign-in: comments and
 * replies, Add Me as Reviewer and the cm user's own verdict. Every write is
 * one cm process, started in the workspace's folder so that cm finds the
 * repository, with its arguments as an array and a comment's text on stdin.
 * Nothing is retried, and nothing a write may have done is sent again without
 * the caller asking.
 *
 * How a write ended decides what the caller may do next. cm exiting with an
 * error it explains did not write: the error is `refused`, and its message is
 * cm's own. cm killed at the timeout or by a cancel, once it had started, may
 * have written, as may a cm that exited with an error about the connection or
 * the server's answer, or with no message at all, and a comment whose cm
 * exited cleanly without printing the new comment's GUID: those are
 * `uncertain`, and a retry could post a duplicate.
 */
export class ReviewWriter {
  private readonly sending = new Set<string>();
  private readonly completed = new Set<string>();
  /** The cm paths known to have the review write commands, and the probes in flight; see `support`. */
  private readonly supports = new Map<string, Promise<ReviewWriteSupport>>();
  private readonly run: CmRunner;

  public constructor(private readonly options: IReviewWriterOptions) {
    this.run = options.run ?? spawnCm;
  }

  /**
   * Whether the configured cm can write to reviews: `cm codereview comment
   * --usage` exits cleanly and lists `reply`, as it does from
   * 11.0.16.10512 on. Only a yes is kept, per cm path, until `forgetSupport`:
   * a no is asked again next time, so a client upgraded in place, or a cm
   * that was missing or slow, is found without a reload.
   */
  public async support(): Promise<ReviewWriteSupport> {
    const cmPath = this.options.cmPath();
    let probe = this.supports.get(cmPath);
    if (!probe) {
      probe = this.probe(cmPath);
      this.supports.set(cmPath, probe);
    }
    const answer = await probe;
    if (!answer.supported && this.supports.get(cmPath) === probe) {
      this.supports.delete(cmPath);
    }
    return answer;
  }

  /** Forgets what every cm answered: the cm settings changed. */
  public forgetSupport(): void {
    this.supports.clear();
  }

  /**
   * A comment, or a reply when the draft has a parent; resolves the new
   * comment's GUID. A draft that is sending or was sent is refused.
   *
   * The text goes to cm on stdin, except on Windows: a .NET program there
   * reads redirected stdin in the console's code page, which would store
   * anything but ASCII garbled, for good. There it goes in a file of its own,
   * UTF-8 with a byte order mark (which .NET reads as UTF-8 whatever the code
   * page), in a new temporary folder that is deleted once cm has ended.
   */
  public async send(cwd: string, draft: IReviewDraft, text: string, cancel?: CancellationToken): Promise<string> {
    if (this.sending.has(draft.key) || this.completed.has(draft.key)) {
      throw new ReviewWriteError("This draft is already sending or has been sent.");
    }
    checkText(text);
    const args = commentArguments(draft);
    const reply = draft.parentGuid !== undefined;
    this.sending.add(draft.key);
    try {
      const effect = reply ? "The reply may have been posted" : "The comment may have been posted";
      const name = `cm codereview comment ${reply ? `reply ${draft.parentGuid!}` : `add ${draft.reviewId}`}`;
      const output = await this.writeText(cwd, { args, effect, name }, text, cancel);
      const guid = UUID.exec(output.stdout)?.[0];
      if (!guid) {
        throw new ReviewWriteError(`cm did not name the new ${reply ? "reply" : "comment"}. ${effect}; refresh the ` +
          "review before retrying.", true);
      }
      this.completed.add(draft.key);
      return guid;
    } finally {
      this.sending.delete(draft.key);
    }
  }

  /**
   * Replaces the text of a comment, by its GUID (`cm codereview comment edit`).
   * cm keeps the comment's type, file, line and changeset, and a review
   * description's `[description]` prefix, so `text` is only what the reader
   * sees. The text reaches cm as `send`'s does. Like `addReviewer`, every call
   * runs: an edit sent twice leaves the same text.
   */
  public async editComment(cwd: string, guid: string, text: string, cancel?: CancellationToken): Promise<void> {
    checkGuid(guid);
    checkText(text);
    await this.writeText(cwd, {
      args: [ "codereview", "comment", "edit", guid, FROM_STDIN ],
      effect: "The comment may have been changed",
      name: `cm codereview comment edit ${guid}`,
    }, text, cancel);
  }

  /**
   * Deletes one comment, by its GUID (`cm codereview comment delete`). cm
   * reports a comment it could not delete and goes on with the others, and
   * its help does not say how it exits then; with one GUID, anything it
   * printed on stderr after a clean exit leaves the result unknown.
   */
  public async deleteComment(cwd: string, guid: string, cancel?: CancellationToken): Promise<void> {
    checkGuid(guid);
    const effect = "The comment may have been deleted";
    const output = await this.write(cwd, {
      args: [ "codereview", "comment", "delete", guid ],
      effect,
      name: `cm codereview comment delete ${guid}`,
    }, cancel);
    const said = cmMessage({ stderr: output.stderr, stdout: "" });
    if (said) {
      throw new ReviewWriteError(`cm said: ${sentence(said)} ${effect}; refresh the review to check.`, true);
    }
  }

  /**
   * Adds the cm user to a review's reviewers (`--users=me`). Unlike `send`,
   * this sends every call: the caller keeps one add per review in flight
   * (ReviewSession does).
   */
  public async addReviewer(cwd: string, reviewId: number, cancel?: CancellationToken): Promise<void> {
    checkReviewId(reviewId);
    await this.write(cwd, {
      args: [ "codereview", "reviewer", "add", String(reviewId), "--users=me" ],
      effect: "You may have been added",
      name: `cm codereview reviewer add ${reviewId}`,
    }, cancel);
  }

  /** The cm user's own verdict on a review, which cm takes from a reviewer or a server administrator. */
  public async setStatus(cwd: string, reviewId: number, status: ReviewStatus, cancel?: CancellationToken):
      Promise<void> {
    checkReviewId(reviewId);
    const verdict = Object.prototype.hasOwnProperty.call(VERDICTS, status) ? VERDICTS[status] : undefined;
    if (!verdict) {
      throw new ReviewWriteError(`Invalid review status: ${String(status)}`);
    }
    await this.write(cwd, {
      args: [ "codereview", "review", String(reviewId), verdict ],
      effect: "Your status may have been set",
      name: `cm codereview review ${reviewId} ${verdict}`,
    }, cancel);
  }

  private async probe(cmPath: string): Promise<ReviewWriteSupport> {
    const output = await this.run(cmPath, { args: [ "codereview", "comment", "--usage" ], timeout: 30 * 1000 });
    if (output.missing) {
      return { reason: CM_MISSING, supported: false };
    }
    if (output.code === undefined) {
      return { reason: "cm did not say whether it can write to reviews. Try again.", supported: false };
    }
    return output.code === 0 && /\breply\b/i.test(output.stdout)
      ? { supported: true }
      : { reason: UNSUPPORTED, supported: false };
  }

  /**
   * Runs a write that takes a comment's text: on stdin, or on Windows in a
   * temporary UTF-8 file with a byte order mark (see `send`), which is
   * deleted once cm has ended. `write.args` names stdin (`-commentsfile=-`).
   */
  private async writeText(cwd: string, write: Omit<IWrite, "stdin" | "textIn">, text: string,
      cancel?: CancellationToken): Promise<ICmOutput> {
    if ((this.options.platform ?? process.platform) !== "win32") {
      return this.write(cwd, { ...write, stdin: text, textIn: "text on stdin" }, cancel);
    }
    const folder = await this.textFolder();
    try {
      const file = join(folder, "comment.txt");
      await writeFile(file, `﻿${text}`, { encoding: "utf8", mode: 0o600 }).catch(() => {
        throw new ReviewWriteError(NO_TEXT_FILE);
      });
      return await this.write(cwd, {
        ...write,
        args: write.args.map(arg => arg === FROM_STDIN ? `-commentsfile=${file}` : arg),
        textIn: "text in a temporary file",
      }, cancel);
    } finally {
      await rm(folder, { force: true, recursive: true }).catch(() => undefined);
    }
  }

  /** A new folder for a comment's text file; see `send`. */
  private async textFolder(): Promise<string> {
    try {
      return await mkdtemp(join((this.options.tempDir ?? tmpdir)(), "plastic-review-"));
    } catch {
      throw new ReviewWriteError(NO_TEXT_FILE);
    }
  }

  /** Runs one write and resolves what cm printed when it exited cleanly; rejects with a ReviewWriteError otherwise. */
  private async write(cwd: string, write: IWrite, cancel?: CancellationToken): Promise<ICmOutput> {
    if (!cwd) {
      throw new ReviewWriteError("The review workspace is no longer available.");
    }
    const support = await this.support();
    if (!support.supported) {
      throw new ReviewWriteError(support.reason);
    }
    this.log(`${write.name}${write.textIn === undefined ? "" : ` (${write.textIn})`}`);
    const output = await this.run(this.options.cmPath(), { args: write.args, cancel, cwd, stdin: write.stdin });
    this.log(`${write.name}: ${outcome(output)}`);
    if (output.code === 0) {
      return output;
    }
    if (output.cwdMissing) {
      throw new ReviewWriteError("The review workspace's folder no longer exists.");
    }
    if (output.missing) {
      throw new ReviewWriteError(CM_MISSING);
    }
    if (output.code !== undefined) {
      const said = cmMessage(output);
      if (said && !LOST.test(said)) {
        throw new ReviewWriteError(sentence(said), false, true);
      }
      throw new ReviewWriteError(`${sentence(said ?? `cm exited with code ${output.code}`)} ${write.effect}; refresh ` +
        "the review before retrying.", true);
    }
    if (!output.started) {
      throw new ReviewWriteError(output.killed === "cancelled"
        ? "Cancelled before anything was sent."
        : "cm could not be started. Check the plastic-scm.cmConfiguration.cmPath setting.");
    }
    const what = output.killed === "cancelled" ? "Cancelled before cm finished."
      : output.killed === "timeout" ? "cm did not finish in time."
        : "cm ended without a result.";
    throw new ReviewWriteError(`${what} ${write.effect}; refresh the review before retrying.`, true);
  }

  private log(message: string): void {
    this.options.log?.(message);
  }
}

/** How a run ended, for the log; nothing cm printed. */
function outcome(output: ICmOutput): string {
  if (output.code !== undefined) {
    return `exit code ${output.code}`;
  }
  return output.missing ? "cm not found" : output.killed ?? (output.started ? "ended without an exit code"
    : "not started");
}

/** A comment's text as cm takes it: not blank, at most 64,000 characters. */
function checkText(text: string): void {
  if (!text.trim() || text.length > MAX_TEXT) {
    throw new ReviewWriteError("Enter a comment of at most 64,000 characters.");
  }
}

/** A comment's GUID, whole: it is one argument of cm, and nothing else may ride along. */
function checkGuid(guid: string): void {
  if (!WHOLE_UUID.test(guid)) {
    throw new ReviewWriteError("This comment cannot be changed from here yet. Refresh the review first.");
  }
}

function checkReviewId(reviewId: number): void {
  if (!Number.isSafeInteger(reviewId) || reviewId <= 0) {
    throw new ReviewWriteError(`Invalid review id: ${String(reviewId)}`);
  }
}

/** The text with a full stop, unless it ends a sentence already. */
function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
