import * as os from "os";
import * as xml2js from "xml2js";
import {
  assertBranchName, assertInteger, FIND_XML_ARGS, FindChangesets,
} from "../cm/commands/findChangesets/findChangesets";
import {
  FindChangesetsParser, PLASTIC_QUERY_OPTIONS, readId, readQueryRows, readText,
} from "../cm/commands/findChangesets/findChangesetsParser";
import { IChangesetFileChange, IHistoryChangeset, IMergeLink } from "../models";
import { ICmParser, ICmShell } from "../cm/shell";
import { IReview, IReviewBranch, IReviewComment, IReviewRevision, ReviewStatus, reviewStatuses } from "./models";
import { DiffChangesetParser } from "../cm/commands/diffChangeset/diffChangesetParser";
import { encodeBranchSpec } from "../cm/commands/findMerges/findMerges";
import { FindBranchParser } from "../cm/commands/findBranch/findBranchParser";
import { FindMergesParser } from "../cm/commands/findMerges/findMergesParser";

export type QueryRow = Record<string, unknown>;

/**
 * The review lists, as fixed where-clauses. `'me'` is resolved by the server,
 * so none of them needs the user's name. All Open and All Reviews page; Find
 * Review… reads the newest `FIND_LIMIT` reviews of the repository at once.
 */
export type ReviewListQuery = "assignedOpen" | "ownedOpen" | "allOpen" | "all" | "find";

/** Revisions or reviews per `(id = … or …)` query; long enough for a page, short enough for cm's parser. */
export const IDS_PER_QUERY = 50;

/** Page size of the changeset list, All Open and All Reviews. */
export const PAGE_SIZE = 50;

/** Reviews Find Review… lists; cm answers this many in about a second. */
export const FIND_LIMIT = 2000;

const DIFF_FORMAT =
  "--format=S:{status}{newline}T:{type}{newline}P:{path}{newline}R:{revid}{newline}PR:{parentrevid}{newline}" +
  "B:{baserevid}{newline}SP:{srccmpath}{newline}DP:{dstcmpath}{newline}RP:{repository}";

/** A parser without a class of its own: it only has to buffer and hand the lines to `read`. */
export function outputParser<T>(read: (lines: string[]) => T | Promise<T>): ICmParser<T> {
  const out: string[] = [];
  const err: string[] = [];
  let parseError: Error | undefined;
  return {
    getError: () => parseError ?? (err.length ? new Error(err.join(os.EOL)) : undefined),
    getOutputLines: () => out.concat(err),
    parse: async () => {
      try {
        return await read(out);
      } catch (error) {
        parseError = error as Error;
        return undefined;
      }
    },
    readLineErr: line => {
      err.push(line);
    },
    readLineOut: line => {
      out.push(line);
    },
  };
}

/**
 * Reads `cm find <tag> --xml`. Output that is not a query response (an error
 * message, a truncated document) fails instead of passing for an empty result,
 * and text keeps its whitespace: comment bodies are shown as written.
 */
export function queryParser<T>(tag: string, convert: (row: QueryRow) => T): ICmParser<T[]> {
  return outputParser(async lines => {
    const xml = lines.join("\n");
    if (!/<PLASTICQUERY(?:\s|\/?>)/i.test(xml)) {
      throw new Error("cm did not return a Plastic XML query response.");
    }
    const parsed: unknown = await xml2js.parseStringPromise(xml, { ...PLASTIC_QUERY_OPTIONS, trim: false });
    return readQueryRows<QueryRow>(parsed, tag).map(convert);
  });
}

export function parseReview(row: QueryRow): IReview {
  return {
    assignee: readText(row.assignee),
    date: readText(row.date),
    id: readId(row.id),
    owner: readText(row.owner),
    status: readText(row.codereviewstatus || row.status).replace(/^(?:CodeReviewStatus|Status)\s+/i, ""),
    target: readText(row.target),
    targetType: readText(row.targettype).toLowerCase(),
    title: readText(row.title),
  };
}

export function parseComment(row: QueryRow): IReviewComment {
  return {
    appliedInChangesetId: readId(row.appliedinchangeset),
    changesetId: readId(row.changeset),
    date: readText(row.date),
    guid: readText(row.guid),
    id: readId(row.id),
    location: readId(row.location),
    owner: readText(row.owner),
    parentId: readId(row.parent),
    reviewId: readId(row.reviewid),
    revisionId: readId(row.revisionid),
    text: readText(row.comment),
    type: readText(row.type).toLowerCase(),
  };
}

export function parseRevision(row: QueryRow): IReviewRevision {
  const repository = readText(row.repname || row.repository);
  const server = readText(row.repserver);
  return {
    branch: readText(row.branch).replace(/^br:/, ""),
    changesetId: readId(row.changeset),
    id: readId(row.id),
    itemId: readId(row.itemid),
    parentId: readId(row.parent),
    path: readText(row.path || row.item),
    repository: server ? `${repository}@${server}` : repository,
    type: readText(row.type),
  };
}

export async function executeReviewCommand<T>(
    shell: ICmShell,
    command: string,
    args: string[],
    parser: ICmParser<T>): Promise<T> {
  const result = await shell.exec(command, args, parser);
  if (!result.success || result.error || parser.getError()) {
    throw result.error ?? parser.getError() ?? new Error(`cm ${command} failed.`);
  }
  if (result.result === undefined) {
    throw new Error(`cm ${command} returned no result.`);
  }
  return result.result;
}

/** No shell interpolation; query strings still need their own validation. */
export function queryString(value: string): string {
  if (/[\r\n'"\0]/.test(value)) {
    throw new Error("Plastic query values cannot contain quotes or line breaks.");
  }
  return `'${value}'`;
}

function listWhere(query: ReviewListQuery, offset: number): string {
  switch (query) {
  case "assignedOpen":
    return "where assignee = 'me' and status != 'Reviewed' order by date desc limit 100";
  case "ownedOpen":
    return "where owner = 'me' and status != 'Reviewed' order by date desc limit 100";
  case "allOpen":
    return `where status != 'Reviewed' order by date desc limit ${PAGE_SIZE} offset ${offset}`;
  case "all":
    return `where id > 0 order by date desc limit ${PAGE_SIZE} offset ${offset}`;
  case "find":
    return `where id > 0 order by date desc limit ${FIND_LIMIT}`;
  default:
    throw new Error(`Unknown review list ${String(query)}.`);
  }
}

function onRepository(repository: string | undefined): string {
  return repository ? ` on repository ${queryString(repository)}` : "";
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    result.push(values.slice(start, start + size));
  }
  return result;
}

/**
 * Every cm query the review feature makes. Numbers are checked with
 * `assertInteger` and every interpolated string goes through `queryString`
 * (or `assertBranchName`), so nothing a server returns can widen a query.
 */
export class ReviewCommands {
  public constructor(private readonly shell: ICmShell) {}

  public list(query: ReviewListQuery, offset = 0): Promise<IReview[]> {
    assertInteger(offset, "offset");
    return this.find("review", listWhere(query, offset), queryParser("review", parseReview));
  }

  public async review(id: number): Promise<IReview | undefined> {
    assertInteger(id, "review id");
    return (await this.find("review", `where id = ${id}`, queryParser("review", parseReview)))[0];
  }

  /** Reviews by id, newest first; `openOnly` leaves out Reviewed ones on the server. */
  public async reviews(ids: readonly number[], openOnly: boolean): Promise<IReview[]> {
    ids.forEach(id => assertInteger(id, "review id"));
    const found: IReview[] = [];
    for (const page of chunks(Array.from(new Set(ids)), IDS_PER_QUERY)) {
      const where = `where (${page.map(id => `id = ${id}`).join(" or ")})` +
        `${openOnly ? " and status != 'Reviewed'" : ""} order by date desc`;
      found.push(...await this.find("review", where, queryParser("review", parseReview)));
    }
    return found;
  }

  /**
   * Every comment row of a review, timeline rows included: status changes carry
   * reviewers' verdicts, and replies can point at them.
   */
  public comments(id: number): Promise<IReviewComment[]> {
    assertInteger(id, "review id");
    return this.find("changereviewcomment", `where reviewid = ${id}`, queryParser("changereviewcomment", parseComment));
  }

  /**
   * Timeline rows of any review that request, re-request or remove `user` as a
   * reviewer. `like` wildcards in the name only widen the match; callers compare
   * the parsed user exactly.
   */
  public reviewRequests(user: string): Promise<IReviewComment[]> {
    return this.find(
      "changereviewcomment",
      `where type = 'timeline' and comment like ${queryString(`%review-from%${user}%`)}`,
      queryParser("changereviewcomment", parseComment));
  }

  public async revision(id: number, repository?: string): Promise<IReviewRevision | undefined> {
    assertInteger(id, "revision id");
    return (await this.find(
      "revision", `where id = ${id}${onRepository(repository)}`, queryParser("revision", parseRevision)))[0];
  }

  public async revisions(ids: readonly number[], repository = ""): Promise<IReviewRevision[]> {
    ids.forEach(id => assertInteger(id, "revision id"));
    const found: IReviewRevision[] = [];
    for (const page of chunks(Array.from(new Set(ids)), IDS_PER_QUERY)) {
      const where = `where (${page.map(id => `id = ${id}`).join(" or ")})${onRepository(repository)}`;
      found.push(...await this.find("revision", where, queryParser("revision", parseRevision)));
    }
    return found;
  }

  /** Every revision id of one item: one indexed query, however long the diff it is matched against. */
  public async itemRevisionIds(itemId: number, repository?: string): Promise<number[]> {
    assertInteger(itemId, "item id");
    const rows = await this.find(
      "revision", `where itemid = ${itemId}${onRepository(repository)}`, queryParser("revision", parseRevision));
    return rows.map(row => row.id);
  }

  /**
   * `where id = N` leaves hidden branches out, and teams hide branches once they
   * are merged, so most reviewed branches are only found by the second query.
   * One combined `(hidden = 'true' or hidden = 'false')` query is not reliable,
   * which is why these are two. Undefined only when both come back empty.
   */
  public async branch(id: number): Promise<IReviewBranch | undefined> {
    assertInteger(id, "branch id");
    for (const hidden of [ false, true ]) {
      const where = `where id = ${id}${hidden ? " and hidden = 'true'" : ""}`;
      const branch = (await this.find("branch", where, new FindBranchParser()))[0];
      if (branch) {
        return { headChangesetId: branch.headChangesetId, hidden, id, name: branch.name, parent: branch.parent };
      }
    }
    return undefined;
  }

  /**
   * Branch names by object id, `IDS_PER_QUERY` ids a query: the plain query,
   * then the hidden one for the ids it did not find, as `branch` asks. A
   * deleted branch has no entry.
   */
  public async branchNames(ids: readonly number[]): Promise<Map<number, string>> {
    ids.forEach(id => assertInteger(id, "branch id"));
    const names = new Map<number, string>();
    const parser = () => queryParser("branch", row => ({ id: readId(row.id), name: readText(row.name) }));
    const where = (page: readonly number[]) => `where (${page.map(id => `id = ${id}`).join(" or ")})`;
    for (const page of chunks(Array.from(new Set(ids)), IDS_PER_QUERY)) {
      const plain = await this.find("branch", where(page), parser());
      const missing = page.filter(id => !plain.some(row => row.id === id));
      const hidden = missing.length ? await this.find("branch", `${where(missing)} and hidden = 'true'`, parser()) : [];
      for (const row of plain.concat(hidden)) {
        if (page.includes(row.id) && row.name) {
          names.set(row.id, row.name);
        }
      }
    }
    return names;
  }

  /**
   * `--clean` lists only files touched by plain (non-merge) checkins, with the
   * same revisions as the plain diff; it only means something for a branch. Its
   * "Calculating merges…" progress lines have no field prefix and are skipped
   * by the parser.
   */
  public diff(spec: string, options: { clean?: boolean } = {}): Promise<IChangesetFileChange[]> {
    if (!/^(br:.+|cs:\d+)$/.test(spec) || /[\r\n"\0]/.test(spec)) {
      throw new Error("Invalid review comparison.");
    }
    if (options.clean && !spec.startsWith("br:")) {
      throw new Error("Only branch comparisons can leave out merged changes.");
    }
    const args = [ spec, DIFF_FORMAT, "--repositorypaths" ];
    if (options.clean) {
      args.push("--clean");
    }
    return executeReviewCommand(this.shell, "diff", args, new DiffChangesetParser());
  }

  /** Merges, cherry picks and interval merges into `branchName` up to `head`. */
  public merges(branchName: string, head: number): Promise<IMergeLink[]> {
    assertBranchName(branchName);
    assertInteger(head, "head changeset");
    const spec = queryString(`br:${encodeBranchSpec(branchName)}`);
    return this.find("merge", `where dstbranch = ${spec} and dstchangeset <= ${head}`, new FindMergesParser());
  }

  public changesets(branchName: string, beforeChangesetId: number): Promise<IHistoryChangeset[]> {
    return FindChangesets.run(
      this.shell, { beforeChangesetId, branch: branchName, ignoreHidden: true, limit: PAGE_SIZE });
  }

  public changeset(id: number): Promise<IHistoryChangeset | undefined> {
    return FindChangesets.runById(this.shell, id, { ignoreHidden: true });
  }

  /** The branch's oldest changeset; its parent is the base `cm diff br:` compares against. */
  public async firstChangeset(branchName: string): Promise<IHistoryChangeset | undefined> {
    assertBranchName(branchName);
    const where =
      `where branch = ${queryString(branchName)} and ignorehidden = 'true' order by changesetid asc limit 1`;
    return (await this.find("changeset", where, new FindChangesetsParser()))[0];
  }

  public async whoami(): Promise<string> {
    const user = await executeReviewCommand(
      this.shell, "whoami", [], outputParser(lines => lines.map(line => line.trim()).find(Boolean) ?? ""));
    if (!user) {
      throw new Error("cm whoami did not name a user.");
    }
    return user;
  }

  public async setStatus(id: number, status: ReviewStatus): Promise<void> {
    assertInteger(id, "review id");
    if (!reviewStatuses.includes(status)) {
      throw new Error("Invalid review status.");
    }
    await executeReviewCommand(
      this.shell, "codereview", [ "-e", String(id), `--status=${status}` ], outputParser(() => true));
  }

  private find<T>(type: string, query: string, parser: ICmParser<T>): Promise<T> {
    return executeReviewCommand(this.shell, "find", [ type, query, ...FIND_XML_ARGS ], parser);
  }
}

export function commentsUnsupported(error: unknown): boolean {
  return new RegExp(
    "(?:unknown|invalid|unsupported|not supported|not found|unexpected).*changereviewcomment|" +
    "changereviewcomment.*(?:unknown|invalid|not supported|not found)|" +
    "unexpected.*(?:object|token).*changereviewcomment", "i").test(String(error));
}
