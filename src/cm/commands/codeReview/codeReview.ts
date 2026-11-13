import { ICmExecOptions, ICmShell } from "../../shell";
import { withCommentsFile, withTextFile } from "../commentsFile";
import { OutputChannel } from "vscode";
import { OutputLinesParser } from "../outputLinesParser";
import { ReviewerListParser } from "./reviewerListParser";
import { runMutation } from "../runMutation";

/** A review's own status, as `cm codereview review` sets the cm user's verdict. */
export type CodeReviewStatus = "Under review" | "Reviewed" | "Rework required";

/** One row of `cm codereview reviewer list`: a user or a group, and the status they gave. */
export interface IListedReviewer {
  /** As cm prints it: usually an e-mail address for a user. */
  name: string;
  /** "Under review", "Reviewed" or "Rework required"; cm prints them in English whatever the client language. */
  status: string;
  type: "user" | "group";
}

/** Who a reviewer command names: users and groups by name; `me` is the cm user. */
export interface IReviewerNames {
  users?: readonly string[];
  groups?: readonly string[];
}

export interface ICreateCodeReviewRequest {
  /** `br:/main/task`, `cs:N` or `sh:N`. */
  spec: string;
  title: string;
  description?: string;
  reviewers?: IReviewerNames;
}

export interface ICreatedCodeReview {
  /** The new review's id; undefined when cm printed none that could be read. */
  id?: number;
  lines: string[];
}

/** A comment on a line of a file: a revision the review's diff shows, and a line counted from 1. */
export interface ICommentAnchor {
  revisionId: number;
  line: number;
}

/**
 * Which `cm codereview` subcommands the cm in use has. Older clients only
 * create, edit and delete reviews; `cm codereview comment|reviewer|review`
 * came later, and so did `--descriptionfile`.
 */
export interface ICodeReviewSupport {
  comments: boolean;
  reviewers: boolean;
  review: boolean;
  descriptionFile: boolean;
}

export const NO_CODE_REVIEW_SUPPORT: ICodeReviewSupport = {
  comments: false, descriptionFile: false, review: false, reviewers: false,
};

const STATUS_FLAGS: { [status in CodeReviewStatus]: string } = {
  "Reviewed": "--reviewed",
  "Rework required": "--rework-required",
  "Under review": "--under-review",
};
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TARGET = /^(?:br:\/[^"\r\n\0]*|cs:\d+|sh:\d+)$/;
/** cm takes a comment of this many characters at most through the REST API; the same bound applies here. */
export const MAX_REVIEW_TEXT = 64000;
/** `--usage` is answered at once, also by a cm that does not know the subcommand: it then prints the general usage. */
const USAGE_OPTIONS: ICmExecOptions = { timeoutMillis: 15000 };

/** Whether `cm codereview comment --usage` printed the comment subcommands rather than the general usage. */
export function hasSubcommands(lines: readonly string[], names: readonly string[]): boolean {
  return names.every(name => lines.some(line => new RegExp(`^\\s*-\\s*${name}\\b`).test(line)));
}

/** The review id `--format={id}` printed: the last line that is only a number. */
export function parseCreatedReviewId(lines: readonly string[]): number | undefined {
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = /^\s*(\d+)\s*$/.exec(lines[index]);
    if (match) {
      const id = Number(match[1]);
      return Number.isSafeInteger(id) && id > 0 ? id : undefined;
    }
  }
  return undefined;
}

export function assertReviewId(id: number): void {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`Invalid review id: ${String(id)}.`);
  }
}

export function assertCommentGuid(guid: string): void {
  if (!GUID.test(guid)) {
    throw new Error("This comment has no id cm can name; refresh the review and try again.");
  }
}

/** Why a reviewer, user or group name cannot be passed to cm; undefined when it can. */
export function reviewerNameProblem(name: string): string | undefined {
  if (!name.trim()) {
    return "Enter a name.";
  }
  if (/[,"\r\n\0]/.test(name)) {
    return "Names cannot contain commas, quotes or line breaks.";
  }
  return undefined;
}

/** Why a review title cannot be passed to cm; undefined when it can. */
export function reviewTitleProblem(title: string): string | undefined {
  if (!title.trim()) {
    return "Enter a title.";
  }
  if (/["\r\n\0]/.test(title)) {
    return "The title cannot contain double quotes or line breaks.";
  }
  return title.length > 1000 ? "Enter a title of at most 1,000 characters." : undefined;
}

/** Free text that travels in a file: anything but empty or longer than `MAX_REVIEW_TEXT`. */
export function assertReviewText(text: string): void {
  if (!text.trim()) {
    throw new Error("Enter a comment first.");
  }
  if (text.length > MAX_REVIEW_TEXT) {
    throw new Error("Enter a comment of at most 64,000 characters.");
  }
}

/** `--users=a,b` and `--groups=c`, each only when it names someone; throws on a name cm cannot take. */
export function reviewerArgs(names: IReviewerNames): string[] {
  const args: string[] = [];
  const lists = [[ "--users", names.users ], [ "--groups", names.groups ]] as const;
  for (const [ option, list ] of lists) {
    const values = (list ?? []).map(name => name.trim()).filter(Boolean);
    for (const value of values) {
      const problem = reviewerNameProblem(value);
      if (problem) {
        throw new Error(`'${value.replace(/[\r\n]/g, " ")}': ${problem}`);
      }
    }
    if (values.length) {
      args.push(`${option}=${values.join(",")}`);
    }
  }
  return args;
}

/**
 * The `cm codereview` commands that write: create a review, manage its
 * reviewers, set the cm user's own status, re-request, and add, reply to,
 * edit and delete comments. Free text (descriptions, comments) never becomes
 * an argument: the shell wraps arguments in double quotes without escaping,
 * so it travels in a temporary file (`--descriptionfile=`, `-commentsfile=`).
 * Ids and names are checked before cm is called. Success is cm's exit code;
 * what cm prints is returned, and the shell has already echoed it to the
 * Plastic SCM output channel.
 */
export class CodeReview {
  /**
   * Which subcommands this cm has, from their `--usage`: read-only, and
   * answered without a server. A cm that does not know a subcommand prints the
   * general `codereview` usage, which lists no `- reply` row, so the answer
   * is read from the text, not from the exit code.
   */
  public static async support(shell: ICmShell): Promise<ICodeReviewSupport> {
    const usage = async (args: string[]): Promise<string[]> => {
      const parser = new OutputLinesParser();
      const result = await shell.exec("codereview", args, parser, USAGE_OPTIONS);
      return result.success ? result.result ?? [] : [];
    };
    const comments = hasSubcommands(await usage([ "comment", "--usage" ]), [ "add", "reply", "edit", "delete" ]);
    const reviewers = hasSubcommands(await usage([ "reviewer", "--usage" ]), [ "add", "remove", "list" ]);
    const reviewLines = await usage([ "review", "--usage" ]);
    const review = [ "--reviewed", "--rework-required", "--under-review", "--re-request" ]
      .every(flag => reviewLines.some(line => line.includes(flag)));
    const general = await usage(["--usage"]);
    const descriptionFile = general.some(line => line.includes("--descriptionfile"));
    return { comments, descriptionFile, review, reviewers };
  }

  /**
   * `cm codereview <spec> <title> [--users=…] [--groups=…] [--descriptionfile=<tmp>] --format={id}`.
   * cm creates the review and may then fail to add its description; it still
   * prints the id and exits with an error, and the error says which review
   * was created.
   */
  public static async create(
      shell: ICmShell,
      channel: Pick<OutputChannel, "appendLine">,
      request: ICreateCodeReviewRequest): Promise<ICreatedCodeReview> {
    if (!TARGET.test(request.spec)) {
      throw new Error(`'${request.spec.replace(/[\r\n]/g, " ")}' is not a branch, changeset or shelve to review.`);
    }
    const titleProblem = reviewTitleProblem(request.title);
    if (titleProblem) {
      throw new Error(titleProblem);
    }
    const reviewers = reviewerArgs(request.reviewers ?? {});
    const description = request.description?.trim() ? request.description : undefined;
    if (description !== undefined && description.length > MAX_REVIEW_TEXT) {
      throw new Error("Enter a description of at most 64,000 characters.");
    }
    const run = async (descriptionArgs: string[]): Promise<ICreatedCodeReview> => {
      const parser = new OutputLinesParser();
      const result = await shell.exec("codereview",
        [ request.spec, request.title.trim(), ...reviewers, ...descriptionArgs, "--format={id}" ], parser);
      const lines = result.result ?? parser.getOutputLines().filter(line => line.trim());
      const id = parseCreatedReviewId(lines);
      if (!result.success) {
        const why = result.error?.message ?? "cm codereview failed.";
        throw new Error(id === undefined ? why : `Review #${id} was created, but cm reported an error: ${why}`);
      }
      return { id, lines };
    };
    return description === undefined
      ? run([])
      : withTextFile(description, channel, file => run([`--descriptionfile=${file}`]));
  }

  /** `cm codereview reviewer list <id> --xml --encoding=utf-8`: users and groups with their status. */
  public static async listReviewers(shell: ICmShell, reviewId: number): Promise<IListedReviewer[]> {
    assertReviewId(reviewId);
    const parser = new ReviewerListParser();
    const result = await shell.exec(
      "codereview", [ "reviewer", "list", String(reviewId), "--xml", "--encoding=utf-8" ], parser);
    const error = result.error ?? parser.getError();
    if (!result.success || error || !result.result) {
      throw error ?? new Error("cm codereview reviewer list failed.");
    }
    return result.result;
  }

  /** `cm codereview reviewer add <id> --users=… --groups=…`; the reviewers already there stay. */
  public static addReviewers(shell: ICmShell, reviewId: number, names: IReviewerNames): Promise<string[]> {
    return CodeReview.reviewers(shell, "add", reviewId, names);
  }

  /** `cm codereview reviewer remove <id> --users=… --groups=…`; the other reviewers stay. */
  public static removeReviewers(shell: ICmShell, reviewId: number, names: IReviewerNames): Promise<string[]> {
    return CodeReview.reviewers(shell, "remove", reviewId, names);
  }

  /** `cm codereview review <id> --reviewed|--rework-required|--under-review`: the cm user's own status. */
  public static setOwnStatus(shell: ICmShell, reviewId: number, status: CodeReviewStatus): Promise<string[]> {
    assertReviewId(reviewId);
    const flag = STATUS_FLAGS[status];
    if (!flag) {
      throw new Error(`Invalid review status: ${String(status)}.`);
    }
    return runMutation(shell, {
      args: [ "review", String(reviewId), flag ], command: "codereview", name: "codereview",
    });
  }

  /** `cm codereview review <id> --re-request --all`, or with `--users`/`--groups` for some of the reviewers. */
  public static reRequest(shell: ICmShell, reviewId: number, who: "all" | IReviewerNames): Promise<string[]> {
    assertReviewId(reviewId);
    const target = who === "all" ? ["--all"] : reviewerArgs(who);
    if (!target.length) {
      throw new Error("Name the reviewers to ask again.");
    }
    return runMutation(shell, {
      args: [ "review", String(reviewId), "--re-request", ...target ], command: "codereview", name: "codereview",
    });
  }

  /**
   * `cm codereview comment add <id> -commentsfile=<tmp> [--revision=revid:N --line=L --type=Comment]`:
   * on a line of a file when `anchor` is given, else on the whole review.
   */
  public static addComment(
      shell: ICmShell,
      channel: Pick<OutputChannel, "appendLine">,
      reviewId: number,
      text: string,
      anchor?: ICommentAnchor): Promise<string[]> {
    assertReviewId(reviewId);
    assertReviewText(text);
    const location: string[] = [];
    if (anchor) {
      if (!Number.isSafeInteger(anchor.revisionId) || anchor.revisionId <= 0 ||
        !Number.isSafeInteger(anchor.line) || anchor.line < 1) {
        throw new Error("This comment does not have a valid revision and line.");
      }
      location.push(`--revision=revid:${anchor.revisionId}`, `--line=${anchor.line}`, "--type=Comment");
    }
    return withCommentsFile(text, channel, commentArgs => runMutation(shell, {
      args: [ "comment", "add", String(reviewId), ...commentArgs, ...location ], command: "codereview",
      name: "codereview comment add",
    }));
  }

  /** `cm codereview comment reply <guid> -commentsfile=<tmp>`. */
  public static reply(
      shell: ICmShell,
      channel: Pick<OutputChannel, "appendLine">,
      parentGuid: string,
      text: string): Promise<string[]> {
    assertCommentGuid(parentGuid);
    assertReviewText(text);
    return withCommentsFile(text, channel, commentArgs => runMutation(shell, {
      args: [ "comment", "reply", parentGuid, ...commentArgs ],
      command: "codereview",
      name: "codereview comment reply",
    }));
  }

  /** `cm codereview comment edit <guid> -commentsfile=<tmp>`: only the text changes. */
  public static editComment(
      shell: ICmShell, channel: Pick<OutputChannel, "appendLine">, guid: string, text: string): Promise<string[]> {
    assertCommentGuid(guid);
    assertReviewText(text);
    return withCommentsFile(text, channel, commentArgs => runMutation(shell, {
      args: [ "comment", "edit", guid, ...commentArgs ], command: "codereview", name: "codereview comment edit",
    }));
  }

  /** `cm codereview comment delete <guid>`. */
  public static deleteComment(shell: ICmShell, guid: string): Promise<string[]> {
    assertCommentGuid(guid);
    return runMutation(shell, {
      args: [ "comment", "delete", guid ], command: "codereview", name: "codereview comment delete",
    });
  }

  private static reviewers(
      shell: ICmShell, action: "add" | "remove", reviewId: number, names: IReviewerNames): Promise<string[]> {
    assertReviewId(reviewId);
    const args = reviewerArgs(names);
    if (!args.length) {
      throw new Error("Name at least one reviewer.");
    }
    return runMutation(shell, {
      args: [ "reviewer", action, String(reviewId), ...args ], command: "codereview",
      name: `codereview reviewer ${action}`,
    });
  }
}
