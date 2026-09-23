import * as fs from "fs";
import { ICmParser, ICmResult, ICmShell } from "../../../cm/shell";
import { ReviewStatus, reviewStatuses } from "../../../reviews/models";

/**
 * A Plastic server in memory: one synthetic repository (branches, changesets,
 * merges, items and their revisions, reviews and their comments) and cm
 * shells that answer from it with the text cm prints. `cm diff` is computed
 * from the changesets, not written out, and every query shape the review
 * feature does not issue fails, naming the command, so a new or changed query
 * fails its test instead of quietly finding nothing. Tests take their
 * expectations from the model and the helpers over it below, never from what
 * the extension made of the answers.
 */

export type SyntheticItemType = "txt" | "bin" | "dir";

export interface ISyntheticItem {
  id: number;
  type: SyntheticItemType;
  /** The line ending of every revision of a text item. */
  eol: "\n" | "\r\n";
  /** Whether every revision of a text item starts with a UTF-8 byte order mark. */
  bom: boolean;
}

export interface ISyntheticRevision {
  id: number;
  item: number;
  changeset: number;
  branch: string;
  /** The item's previous revision, or -1. */
  parent: number;
  /** A text revision's lines, without their endings. */
  lines?: string[];
  /** A binary revision's bytes. */
  bytes?: Buffer;
}

export interface ISyntheticBranch {
  /** The branch's object id, which a branch review targets. */
  id: number;
  name: string;
  owner: string;
  date: string;
  comment: string;
  /** Left out of `where id = N`; only `and hidden = 'true'` finds it. */
  hidden: boolean;
  /** Neither branch query finds it. */
  deleted: boolean;
  /** The changeset it was created from: its head until it has changesets of its own. */
  base: number;
}

/** What a checkin did to one item. `load` is a merge taking the item as the merge source has it. */
export type SyntheticOp =
  | { kind: "add"; item: number }
  | { kind: "change"; item: number }
  | { kind: "move"; item: number }
  | { kind: "delete"; item: number }
  | { kind: "load"; item: number };

export interface ISyntheticChangeset {
  id: number;
  branch: string;
  parent: number;
  owner: string;
  date: string;
  comment: string;
  /** The changeset a merge brought in; undefined for a plain checkin. */
  mergedFrom?: number;
  ops: SyntheticOp[];
}

export interface ISyntheticReview {
  id: number;
  title: string;
  owner: string;
  assignee: string;
  date: string;
  status: ReviewStatus;
  targetType: "Branch" | "Changeset";
  /** A branch's object id, or a changeset id. */
  target: number;
}

export interface ISyntheticComment {
  id: number;
  review: number;
  owner: string;
  date: string;
  /** `timeline` rows start with a marker such as `[status-reviewed]`. */
  type: string;
  text: string;
  revision: number;
  /** Zero-based line in `revision`, or -1. */
  location: number;
  parent: number;
  changeset: number;
  applied: number;
}

export type SyntheticDiffStatus = "A" | "C" | "D" | "M";

/** A row of a comparison as the model computes it: a moved-and-edited item is one row with both statuses. */
export interface ISyntheticDiffRow {
  item: number;
  statuses: Set<SyntheticDiffStatus>;
  /** cm's letter: F text, B binary, D directory. */
  type: "F" | "B" | "D";
  path: string;
  oldPath?: string;
  /** The right side's revision; for a deleted item, the revision that was deleted. */
  revid: number;
  /** The left side's revision of a changed item, or -1. */
  base: number;
  parent: number;
}

/** Builds one changeset; every method applies to the tree at once. */
export interface ISyntheticCheckin {
  readonly id: number;
  add(path: string, lines: string[], options?: { eol?: "\n" | "\r\n"; bom?: boolean }): number;
  addBinary(path: string, bytes: Buffer): number;
  addDirectory(path: string): number;
  /** A new revision of a text item; `edit` gets its lines and returns the new ones. */
  change(item: number, edit: (lines: string[]) => string[]): number;
  /** A move, and with `edit` a new revision at the new path. */
  move(item: number, path: string, edit?: (lines: string[]) => string[]): void;
  remove(item: number): void;
  /** A merge's take of the item as the merge source has it. */
  load(item: number): void;
}

export interface ICmCall {
  command: string;
  args: string[];
}

interface ITreeEntry {
  revision: number;
  path: string;
}

type Shape<T> = [RegExp, (match: RegExpExecArray) => T];

/** The `--format=` of the review feature's `cm diff`; any other is a query this server does not know. */
const DIFF_FORMAT =
  "--format=S:{status}{newline}T:{type}{newline}P:{path}{newline}R:{revid}{newline}PR:{parentrevid}{newline}" +
  "B:{baserevid}{newline}SP:{srccmpath}{newline}DP:{dstcmpath}{newline}RP:{repository}";
const FIND_ARGS = "--xml --nototal --encoding=utf-8";
const BOM = Buffer.from([ 0xef, 0xbb, 0xbf ]);
const TYPE_LETTERS: { [type in SyntheticItemType]: "F" | "B" | "D" } = { bin: "B", dir: "D", txt: "F" };
const ID_LIST = /id = (\d+)/g;
const OPEN = "status != 'Reviewed'";

/** Newest first, as cm's `order by date desc` lists reviews; the id orders two of one date. */
export function newestFirst(a: { date: string; id: number }, b: { date: string; id: number }): number {
  return Date.parse(b.date) - Date.parse(a.date) || b.id - a.id;
}

export class SyntheticPlasticServer {
  /** Every command any shell of this server ran, in order. */
  public readonly calls: ICmCall[] = [];
  /** Commands this server does not know; each also failed, naming itself. */
  public readonly unrecognised: string[] = [];
  public readonly branches: ISyntheticBranch[] = [];
  public readonly changesets: ISyntheticChangeset[] = [];
  public readonly items = new Map<number, ISyntheticItem>();
  public readonly revisions = new Map<number, ISyntheticRevision>();
  public readonly reviews: ISyntheticReview[] = [];
  public readonly comments: ISyntheticComment[] = [];
  /** `REPNAME@REPSERVER`, as `cm diff` and `cm find revision` name the repository. */
  public readonly repository: string;
  private readonly trees = new Map<number, Map<number, ITreeEntry>>();
  private nextItem = 101;
  private nextRevision = 1001;
  private nextComment = 7001;

  public constructor(
    /** The workspace root: `cm find revision` prints local paths under it. */
    public readonly root: string,
    /** What `cm whoami` prints, and whom `'me'` means in a query. */
    public readonly user: string,
    public readonly repositoryName: string,
    public readonly repositoryServer: string,
    /** The branch the workspace is on, at its head. */
    public readonly workspaceBranch = "/main"
  ) {
    this.repository = `${repositoryName}@${repositoryServer}`;
  }

  /** A cm shell that answers from this server, one command at a time, as cm's own shell does. */
  public shell(): ICmShell {
    let running = false;
    let busy = 0;
    let queue: Promise<unknown> = Promise.resolve();
    const run = async <T>(command: string, args: string[], parser: ICmParser<T>): Promise<ICmResult<T>> => {
      this.calls.push({ args, command });
      if (!running) {
        const refused = `Unable to run command '${command}' because the shell isn't running`;
        return { error: new Error(refused), success: false };
      }
      let output: string;
      try {
        output = await this.answer(command, args);
      } catch (error) {
        return { error: error as Error, success: false };
      }
      // cm's shell reader (byline) splits on every line break and drops empty lines.
      output.split(/\r\n|\r|\n/).filter(line => line.length > 0).forEach(line => parser.readLineOut(line));
      const result = await parser.parse();
      return { error: parser.getError(), result, success: true };
    };
    return {
      dispose: () => {
        running = false;
      },
      exec: <T>(command: string, args: string[], parser: ICmParser<T>) => {
        const next = queue.then(async () => {
          busy++;
          try {
            return await run(command, args, parser);
          } finally {
            busy--;
          }
        });
        queue = next.catch(() => undefined);
        return next;
      },
      get isBusy() {
        return busy > 0;
      },
      get isRunning() {
        return running;
      },
      start: () => {
        running = true;
        return Promise.resolve(true);
      },
      stop: () => {
        running = false;
        return Promise.resolve();
      },
    };
  }

  public addBranch(branch: Omit<ISyntheticBranch, "deleted" | "hidden"> & Partial<ISyntheticBranch>): void {
    this.branches.push({ deleted: false, hidden: false, ...branch });
  }

  /** A checkin on top of the branch's head. */
  public checkin(branch: string, info: { owner: string; date: string; comment: string }): ISyntheticCheckin {
    return this.createChangeset(branch, info, undefined);
  }

  /** A merge of `source` into the branch that takes `items` as `source` has them. */
  public merge(branch: string, source: number, info: { owner: string; date: string; comment: string },
      items: number[]): number {
    const merge = this.createChangeset(branch, info, source);
    items.forEach(item => merge.load(item));
    return merge.id;
  }

  public addReview(review: ISyntheticReview): void {
    this.reviews.push(review);
  }

  /** A comment row; returns its id. */
  public addComment(
      review: number,
      owner: string,
      date: string,
      text: string,
      options: Partial<Omit<ISyntheticComment, "date" | "id" | "owner" | "review" | "text">> = {}): number {
    const id = this.nextComment++;
    this.comments.push({
      applied: -1, changeset: -1, date, id, location: -1, owner, parent: -1, review, revision: -1, text,
      type: "comment", ...options,
    });
    return id;
  }

  /** A timeline row, such as `[requested-review-from]<user>`; returns its id. */
  public addTimeline(review: number, owner: string, date: string, text: string): number {
    return this.addComment(review, owner, date, text, { type: "timeline" });
  }

  // -------------------------------------------------------------------------
  // The model, as tests read it.
  // -------------------------------------------------------------------------

  public branch(name: string): ISyntheticBranch {
    const branch = this.branches.find(candidate => candidate.name === name);
    if (!branch) {
      throw new Error(`No synthetic branch ${name}.`);
    }
    return branch;
  }

  public branchById(id: number): ISyntheticBranch {
    const branch = this.branches.find(candidate => candidate.id === id);
    if (!branch) {
      throw new Error(`No synthetic branch with id ${id}.`);
    }
    return branch;
  }

  public changeset(id: number): ISyntheticChangeset {
    const changeset = this.changesets.find(candidate => candidate.id === id);
    if (!changeset) {
      throw new Error(`No synthetic changeset ${id}.`);
    }
    return changeset;
  }

  public review(id: number): ISyntheticReview {
    const review = this.reviews.find(candidate => candidate.id === id);
    if (!review) {
      throw new Error(`No synthetic review ${id}.`);
    }
    return review;
  }

  public revision(id: number): ISyntheticRevision {
    const revision = this.revisions.get(id);
    if (!revision) {
      throw new Error(`No synthetic revision ${id}.`);
    }
    return revision;
  }

  /** The branch's changesets up to `upTo`, newest first. */
  public branchChangesets(name: string, upTo = Number.MAX_SAFE_INTEGER): ISyntheticChangeset[] {
    return this.changesets.filter(changeset => changeset.branch === name && changeset.id <= upTo)
      .sort((a, b) => b.id - a.id);
  }

  public head(name: string): number {
    return this.branchChangesets(name)[0]?.id ?? this.branch(name).base;
  }

  /** The parent of the branch's first changeset: what `cm diff br:` compares the head with. */
  public branchBase(name: string): number {
    const own = this.branchChangesets(name);
    return own.length ? own[own.length - 1].parent : this.branch(name).base;
  }

  /** Merge destinations on the branch up to `upTo`, newest first. */
  public mergesInto(name: string, upTo = Number.MAX_SAFE_INTEGER): ISyntheticChangeset[] {
    return this.branchChangesets(name, upTo).filter(changeset => changeset.mergedFrom !== undefined);
  }

  /** Every item of the tree at a changeset, with its revision and path there. */
  public tree(changeset: number): ReadonlyMap<number, ITreeEntry> {
    const tree = changeset < 0 ? new Map<number, ITreeEntry>() : this.trees.get(changeset);
    if (!tree) {
      throw new Error(`No synthetic changeset ${changeset}.`);
    }
    return tree;
  }

  /** The revision an item has at a changeset, or -1. */
  public revisionAt(item: number, changeset: number): number {
    return this.tree(changeset).get(item)?.revision ?? -1;
  }

  /** `cm diff br:<name>`; `clean` keeps the items the branch's own (non-merge) checkins touched. */
  public branchDiff(name: string, clean = false): ISyntheticDiffRow[] {
    const rows = this.compare(this.branchBase(name), this.head(name));
    if (!clean) {
      return rows;
    }
    const touched = new Set<number>();
    this.branchChangesets(name).filter(changeset => changeset.mergedFrom === undefined)
      .forEach(changeset => changeset.ops.forEach(op => touched.add(op.item)));
    return rows.filter(row => touched.has(row.item));
  }

  /** `cm diff cs:N`: the changeset against its parent. */
  public changesetDiff(id: number): ISyntheticDiffRow[] {
    return this.compare(this.changeset(id).parent, id);
  }

  /** A text revision as the editor shows it: its lines with their endings, no byte order mark. */
  public text(revisionId: number): string {
    const revision = this.revision(revisionId);
    const item = this.items.get(revision.item)!;
    if (!revision.lines) {
      throw new Error(`Synthetic revision ${revisionId} is not text.`);
    }
    return revision.lines.map(line => `${line}${item.eol}`).join("");
  }

  /** The text at a path in the tree of a changeset; empty when nothing is there. */
  public textAt(path: string, changeset: number): string {
    const entry = Array.from(this.tree(changeset).values()).find(candidate => candidate.path === path);
    return entry ? this.text(entry.revision) : "";
  }

  /** The server path `cm find revision` prints under the root: the item's workspace path, else the revision's. */
  public workspacePath(revisionId: number): string {
    const revision = this.revision(revisionId);
    const loaded = this.tree(this.head(this.workspaceBranch)).get(revision.item);
    return (loaded ?? this.tree(revision.changeset).get(revision.item)!).path;
  }

  /** Reviews as `order by date desc` lists them. */
  public newestReviews(filter: (review: ISyntheticReview) => boolean = () => true): ISyntheticReview[] {
    return this.reviews.filter(filter).sort(newestFirst);
  }

  // -------------------------------------------------------------------------
  // Building the model.
  // -------------------------------------------------------------------------

  private createChangeset(
      branch: string,
      info: { owner: string; date: string; comment: string },
      mergedFrom: number | undefined): ISyntheticCheckin {
    this.branch(branch);
    const id = this.changesets.length ? this.changesets[this.changesets.length - 1].id + 1 : 1;
    const changeset: ISyntheticChangeset = { ...info, branch, id, mergedFrom, ops: [], parent: this.head(branch) };
    const tree = new Map(this.tree(changeset.parent));
    this.changesets.push(changeset);
    this.trees.set(id, tree);
    const current = (item: number) => {
      const entry = tree.get(item);
      if (!entry) {
        throw new Error(`Item ${item} is not in the tree of cs:${id}.`);
      }
      return entry;
    };
    const revise = (item: number, content: { lines?: string[]; bytes?: Buffer }): number => {
      const revision = this.nextRevision++;
      const parent = tree.get(item)?.revision ?? -1;
      this.revisions.set(revision, { branch, changeset: id, id: revision, item, parent, ...content });
      return revision;
    };
    const add = (path: string, type: SyntheticItemType, content: { lines?: string[]; bytes?: Buffer },
        options: { eol?: "\n" | "\r\n"; bom?: boolean } = {}) => {
      const item = this.nextItem++;
      this.items.set(item, { bom: options.bom ?? false, eol: options.eol ?? "\n", id: item, type });
      tree.set(item, { path, revision: revise(item, content) });
      changeset.ops.push({ item, kind: "add" });
      return item;
    };
    const edited = (item: number, edit: (lines: string[]) => string[]) => {
      const lines = this.revision(current(item).revision).lines;
      if (!lines) {
        throw new Error(`Item ${item} is not text.`);
      }
      return edit(lines.slice());
    };
    return {
      add: (path, lines, options) => add(path, "txt", { lines }, options),
      addBinary: (path, bytes) => add(path, "bin", { bytes }),
      addDirectory: path => add(path, "dir", {}),
      change: (item, edit) => {
        const revision = revise(item, { lines: edited(item, edit) });
        tree.set(item, { path: current(item).path, revision });
        changeset.ops.push({ item, kind: "change" });
        return revision;
      },
      id,
      load: item => {
        if (mergedFrom === undefined) {
          throw new Error(`cs:${id} is not a merge.`);
        }
        const source = this.tree(mergedFrom).get(item);
        if (source) {
          tree.set(item, source);
        } else {
          tree.delete(item);
        }
        changeset.ops.push({ item, kind: "load" });
      },
      move: (item, path, edit) => {
        const revision = edit ? revise(item, { lines: edited(item, edit) }) : current(item).revision;
        tree.set(item, { path, revision });
        changeset.ops.push({ item, kind: "move" });
      },
      remove: item => {
        current(item);
        tree.delete(item);
        changeset.ops.push({ item, kind: "delete" });
      },
    };
  }

  /** The rows between two trees, by path, as cm computes them. */
  private compare(before: number, after: number): ISyntheticDiffRow[] {
    const left = this.tree(before);
    const right = this.tree(after);
    const rows: ISyntheticDiffRow[] = [];
    const items = new Set(Array.from(left.keys()).concat(Array.from(right.keys())));
    items.forEach(item => {
      const was = left.get(item);
      const now = right.get(item);
      const type = TYPE_LETTERS[this.items.get(item)!.type];
      if (was && now) {
        const statuses = new Set<SyntheticDiffStatus>();
        if (was.revision !== now.revision) {
          statuses.add("C");
        }
        if (was.path !== now.path) {
          statuses.add("M");
        }
        if (statuses.size) {
          rows.push({
            base: statuses.has("C") ? was.revision : -1,
            item,
            oldPath: statuses.has("M") ? was.path : undefined,
            parent: this.revision(now.revision).parent,
            path: now.path,
            revid: now.revision,
            statuses,
            type,
          });
        }
      } else if (now) {
        rows.push({
          base: -1, item, parent: this.revision(now.revision).parent, path: now.path, revid: now.revision,
          statuses: new Set<SyntheticDiffStatus>(["A"]), type,
        });
      } else if (was) {
        rows.push({
          base: -1, item, parent: -1, path: was.path, revid: was.revision,
          statuses: new Set<SyntheticDiffStatus>(["D"]), type,
        });
      }
    });
    return rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  // -------------------------------------------------------------------------
  // cm's side: what each command prints.
  // -------------------------------------------------------------------------

  private answer(command: string, args: string[]): string | Promise<string> {
    switch (command) {
    case "find":
      return this.find(args);
    case "diff":
      return this.diff(args);
    case "getfile":
      return this.getfile(args);
    case "codereview":
      return this.codereview(args);
    case "whoami":
      if (!args.length) {
        return `${this.user}\n`;
      }
      break;
    default:
      break;
    }
    throw this.unknown(command, args);
  }

  private unknown(command: string, args: string[]): Error {
    const line = `cm ${command} ${args.join(" ")}`;
    this.unrecognised.push(line);
    return new Error(`The synthetic Plastic server does not know this command: ${line}`);
  }

  private find(args: string[]): string {
    const [ type, where = "", ...rest ] = args;
    const answer = rest.join(" ") !== FIND_ARGS ? undefined
      : type === "review" ? this.findReviews(where)
        : type === "changereviewcomment" ? this.findComments(where)
          : type === "revision" ? this.findRevisions(where)
            : type === "branch" ? this.findBranches(where)
              : type === "merge" ? this.findMerges(where)
                : type === "changeset" ? this.findChangesets(where) : undefined;
    if (answer === undefined) {
      throw this.unknown("find", args);
    }
    return answer;
  }

  private findReviews(where: string): string | undefined {
    const me = (user: string) => user.toLowerCase() === this.user.toLowerCase();
    const open = (review: ISyntheticReview) => review.status !== "Reviewed";
    const page = (reviews: ISyntheticReview[], limit: string, offset = "0") =>
      reviews.slice(Number(offset), Number(offset) + Number(limit));
    const shapes: Array<Shape<ISyntheticReview[]>> = [
      [
        new RegExp(`^where assignee = 'me' and ${OPEN} order by date desc limit (\\d+)$`),
        match => page(this.newestReviews(review => me(review.assignee) && open(review)), match[1]),
      ],
      [
        new RegExp(`^where owner = 'me' and ${OPEN} order by date desc limit (\\d+)$`),
        match => page(this.newestReviews(review => me(review.owner) && open(review)), match[1]),
      ],
      [
        new RegExp(`^where ${OPEN} order by date desc limit (\\d+) offset (\\d+)$`),
        match => page(this.newestReviews(open), match[1], match[2]),
      ],
      [
        /^where id > 0 order by date desc limit (\d+)(?: offset (\d+))?$/,
        match => page(this.newestReviews(), match[1], match[2]),
      ],
      [ /^where id = (\d+)$/, match => this.reviews.filter(review => review.id === Number(match[1])) ],
      [
        new RegExp(`^where \\((id = \\d+(?: or id = \\d+)*)\\)( and ${OPEN})? order by date desc$`),
        match => {
          const ids = idList(match[1]);
          return this.newestReviews(review => ids.includes(review.id) && (!match[2] || open(review)));
        },
      ],
    ];
    const found = matchShape(where, shapes);
    return found && query(found.map(review => this.reviewXml(review)));
  }

  private findComments(where: string): string | undefined {
    const shapes: Array<Shape<ISyntheticComment[]>> = [
      [ /^where reviewid = (\d+)$/, match => this.comments.filter(comment => comment.review === Number(match[1])) ],
      [
        /^where type = 'timeline' and comment like '([^']*)'$/,
        match => {
          const pattern = likePattern(match[1]);
          return this.comments.filter(comment => comment.type === "timeline" && pattern.test(comment.text));
        },
      ],
    ];
    const found = matchShape(where, shapes);
    return found && query(found.map(comment => this.commentXml(comment)));
  }

  private findRevisions(where: string): string | undefined {
    const repository = / on repository '([^']*)'$/.exec(where);
    if (repository && !this.sameRepository(repository[1])) {
      return query([]);
    }
    const clause = repository ? where.substring(0, repository.index) : where;
    const revisions = Array.from(this.revisions.values());
    const shapes: Array<Shape<ISyntheticRevision[]>> = [
      [ /^where id = (\d+)$/, match => revisions.filter(revision => revision.id === Number(match[1])) ],
      [
        /^where \((id = \d+(?: or id = \d+)*)\)$/,
        match => revisions.filter(revision => idList(match[1]).includes(revision.id)),
      ],
      [ /^where itemid = (\d+)$/, match => revisions.filter(revision => revision.item === Number(match[1])) ],
    ];
    const found = matchShape(clause, shapes);
    return found && query(found.map(revision => this.revisionXml(revision)));
  }

  private findBranches(where: string): string | undefined {
    const findable = (branch: ISyntheticBranch, hidden: boolean) => !branch.deleted && branch.hidden === hidden;
    const shapes: Array<Shape<ISyntheticBranch[]>> = [
      [
        /^where id = (\d+)( and hidden = 'true')?$/,
        match => this.branches.filter(branch => branch.id === Number(match[1]) && findable(branch, !!match[2])),
      ],
      [
        /^where \((id = \d+(?: or id = \d+)*)\)( and hidden = 'true')?$/,
        match => this.branches.filter(branch => idList(match[1]).includes(branch.id) && findable(branch, !!match[2])),
      ],
    ];
    const found = matchShape(where, shapes);
    return found && query(found.map(branch => this.branchXml(branch)));
  }

  private findMerges(where: string): string | undefined {
    const match = /^where dstbranch = 'br:([^']*)' and dstchangeset <= (\d+)$/.exec(where);
    if (!match) {
      return undefined;
    }
    const name = match[1].split("%20").join(" ");
    const merges = this.branches.some(branch => branch.name === name) ? this.mergesInto(name, Number(match[2])) : [];
    return query(merges.map(merge => this.mergeXml(merge)));
  }

  private findChangesets(where: string): string | undefined {
    const shapes: Array<Shape<ISyntheticChangeset[]>> = [
      [
        new RegExp("^where branch='([^']*)' and changesetid < (\\d+) and ignorehidden = 'true' " +
          "order by changesetid desc limit (\\d+)$"),
        match => this.changesets.filter(changeset => changeset.branch === match[1] && changeset.id < Number(match[2]))
          .sort((a, b) => b.id - a.id).slice(0, Number(match[3])),
      ],
      [
        /^where changesetid=(\d+) and ignorehidden = 'true'$/,
        match => this.changesets.filter(changeset => changeset.id === Number(match[1])),
      ],
      [
        /^where branch = '([^']*)' and ignorehidden = 'true' order by changesetid asc limit 1$/,
        match => this.changesets.filter(changeset => changeset.branch === match[1]).sort((a, b) => a.id - b.id)
          .slice(0, 1),
      ],
    ];
    const found = matchShape(where, shapes);
    return found && query(found.map(changeset => this.changesetXml(changeset)));
  }

  private diff(args: string[]): string {
    const [ spec = "", format, paths, ...rest ] = args;
    const clean = rest.length === 1 && rest[0] === "--clean";
    const branch = /^br:(.+)$/.exec(spec);
    const changeset = /^cs:(\d+)$/.exec(spec);
    if (format !== DIFF_FORMAT || paths !== "--repositorypaths" || (rest.length && !clean) || (!branch && !changeset) ||
        (clean && !branch)) {
      throw this.unknown("diff", args);
    }
    if (branch && !this.branches.some(known => known.name === branch[1] && !known.deleted)) {
      throw new Error(`The branch br:${branch[1]} does not exist.`);
    }
    if (changeset && !this.changesets.some(known => known.id === Number(changeset[1]))) {
      throw new Error(`The changeset cs:${changeset[1]} does not exist.`);
    }
    const lines: string[] = [];
    if (branch && clean) {
      const merges = this.mergesInto(branch[1]).reverse();
      if (merges.length) {
        lines.push(
          `Calculating merges to branch br:${branch[1]}@${this.repository}`,
          `Skipping differences from ${merges.length} changesets (merge destinations)`,
          ...merges.map((merge, index) => `Skipped differences from cs:${merge.id}@${this.repository} ` +
            `(${Math.round((index + 1) / merges.length * 100)}%)`),
          "Skipped differences from merges");
      }
    }
    const rows = branch ? this.branchDiff(branch[1], clean) : this.changesetDiff(Number(changeset![1]));
    for (const row of rows) {
      const moved = row.statuses.has("M");
      const status = row.statuses.has("A") ? "A" : row.statuses.has("D") ? "D" : row.statuses.has("C") ? "C" : "M";
      // A moved-and-edited item is printed twice: a C row with its base, and an M row with both paths.
      lines.push(...this.diffRecord(row, status, status === "M" ? -1 : row.base, status === "M"));
      if (status === "C" && moved) {
        lines.push(...this.diffRecord(row, "M", -1, true));
      }
    }
    return lines.join("\n");
  }

  private diffRecord(row: ISyntheticDiffRow, status: SyntheticDiffStatus, base: number, paths: boolean): string[] {
    return [
      `S:${status}`,
      `T:${row.type}`,
      `P:"${row.path}"`,
      `R:${row.revid}`,
      `PR:${row.parent}`,
      `B:${base}`,
      `SP:"${paths ? row.oldPath ?? "" : ""}"`,
      `DP:"${paths ? row.path : ""}"`,
      `RP:"${this.repository}"`,
    ];
  }

  /** `cm getfile revid:N[@rep:<repository>] --file=<path>`: writes the revision's bytes. */
  private async getfile(args: string[]): Promise<string> {
    const [ spec = "", file = "", ...rest ] = args;
    const revision = /^revid:(\d+)(?:@rep:(.+))?$/.exec(spec);
    const target = /^--file=(.+)$/.exec(file);
    if (!revision || !target || rest.length) {
      throw this.unknown("getfile", args);
    }
    if (revision[2] !== undefined && !this.sameRepository(revision[2])) {
      throw new Error(`The repository '${revision[2]}' does not exist.`);
    }
    const known = this.revisions.get(Number(revision[1]));
    if (!known || this.items.get(known.item)!.type === "dir") {
      throw new Error(`The revision ${revision[1]} does not exist or is not a file.`);
    }
    await fs.promises.writeFile(target[1], this.bytes(known));
    return "";
  }

  /** `cm codereview -e <id> --status=<status>`: the one write; the calls record it. */
  private codereview(args: string[]): string {
    const status = /^--status=(.+)$/.exec(args[2] ?? "");
    const id = args.length === 3 && args[0] === "-e" ? Number(args[1]) : -1;
    const review = this.reviews.find(known => known.id === id);
    const value = status && reviewStatuses.find(known => known === status[1]);
    if (!review || !value) {
      throw this.unknown("codereview", args);
    }
    review.status = value;
    return "";
  }

  private bytes(revision: ISyntheticRevision): Buffer {
    const item = this.items.get(revision.item)!;
    if (revision.bytes) {
      return revision.bytes;
    }
    const text = Buffer.from(this.text(revision.id), "utf8");
    return item.bom ? Buffer.concat([ BOM, text ]) : text;
  }

  private sameRepository(spec: string): boolean {
    return spec.split("@")[0].toLowerCase() === this.repositoryName.toLowerCase();
  }

  private reviewXml(review: ISyntheticReview): string {
    return element("REVIEW", [
      [ "ID", review.id ],
      [ "OWNER", review.owner ],
      [ "DATE", review.date ],
      [ "TITLE", review.title ],
      [ "MERGEREQUESTSTATUS", "MergeRequestStatus None" ],
      [ "STATUS", `Status ${review.status}` ],
      [ "CODEREVIEWSTATUS", `CodeReviewStatus ${review.status}` ],
      [ "ASSIGNEE", review.assignee ],
      [ "TARGETTYPE", review.targetType ],
      [ "TARGET", review.targetType === "Branch" ? `id:${review.target}` : review.target ],
      [ "DESTINATION", "" ],
    ]);
  }

  private commentXml(comment: ISyntheticComment): string {
    return element("CHANGEREVIEWCOMMENT", [
      [ "ID", comment.id ],
      [ "OWNER", comment.owner ],
      [ "DATE", comment.date ],
      [ "COMMENT", comment.text ],
      [ "REVISIONID", comment.revision ],
      [ "REVIEWID", comment.review ],
      [ "LOCATION", comment.location ],
      [ "TYPE", comment.type ],
      [ "PARENT", comment.parent ],
      [ "CHANGESET", comment.changeset ],
      [ "APPLIEDINCHANGESET", comment.applied ],
      [ "GUID", guid(comment.id) ],
    ]);
  }

  private revisionXml(revision: ISyntheticRevision): string {
    const local = `${this.root}${this.workspacePath(revision.id)}`;
    return element("REVISION", [
      [ "ID", revision.id ],
      [ "TYPE", this.items.get(revision.item)!.type ],
      [ "CHANGESET", revision.changeset ],
      [ "PARENT", revision.parent ],
      [ "ITEM", local ],
      [ "ITEMID", revision.item ],
      [ "BRANCH", `br:${revision.branch}` ],
      [ "PATH", local ],
      [ "REPOSITORY", this.repositoryName ],
      [ "REPNAME", this.repositoryName ],
      [ "REPSERVER", this.repositoryServer ],
    ]);
  }

  private branchXml(branch: ISyntheticBranch): string {
    const slash = branch.name.lastIndexOf("/");
    return element("BRANCH", [
      [ "ID", branch.id ],
      [ "COMMENT", branch.comment ],
      [ "DATE", branch.date ],
      [ "OWNER", branch.owner ],
      [ "NAME", branch.name ],
      [ "PARENT", slash > 0 ? branch.name.substring(0, slash) : "" ],
      [ "REPOSITORY", this.repositoryName ],
      [ "REPNAME", this.repositoryName ],
      [ "REPSERVER", this.repositoryServer ],
      [ "TYPE", "T" ],
      [ "CHANGESET", this.head(branch.name) ],
      [ "GUID", guid(branch.id) ],
    ]);
  }

  private mergeXml(merge: ISyntheticChangeset): string {
    const source = this.changeset(merge.mergedFrom!);
    return element("MERGE", [
      [ "ID", 90000 + merge.id ],
      [ "DATE", merge.date ],
      [ "OWNER", merge.owner ],
      [ "TYPE", "merge" ],
      [ "SRCCHANGESET", source.id ],
      [ "SRCBRANCH", `br:${source.branch}` ],
      [ "DSTCOMMENT", merge.comment ],
      [ "DSTCHANGESET", merge.id ],
      [ "DSTBRANCH", `br:${merge.branch}` ],
      [ "BASECHANGESET", "" ],
      [ "SRC", `br:${source.branch}@${source.id}` ],
      [ "DST", `br:${merge.branch}@${merge.id}` ],
    ]);
  }

  private changesetXml(changeset: ISyntheticChangeset): string {
    return element("CHANGESET", [
      [ "ID", 80000 + changeset.id ],
      [ "CHANGESETID", changeset.id ],
      [ "COMMENT", changeset.comment ],
      [ "DATE", changeset.date ],
      [ "OWNER", changeset.owner ],
      [ "REPOSITORY", this.repositoryName ],
      [ "REPNAME", this.repositoryName ],
      [ "REPSERVER", this.repositoryServer ],
      [ "BRANCH", changeset.branch ],
      [ "PARENT", changeset.parent ],
      [ "GUID", guid(80000 + changeset.id) ],
    ]);
  }
}

function matchShape<T>(where: string, shapes: Array<Shape<T>>): T | undefined {
  for (const [ pattern, read ] of shapes) {
    const match = pattern.exec(where);
    if (match) {
      return read(match);
    }
  }
  return undefined;
}

function idList(list: string): number[] {
  const ids: number[] = [];
  const pattern = new RegExp(ID_LIST.source, ID_LIST.flags);
  for (let match = pattern.exec(list); match; match = pattern.exec(list)) {
    ids.push(Number(match[1]));
  }
  return ids;
}

/** A `like` pattern: `%` any run, `_` any one character; case is ignored. */
function likePattern(pattern: string): RegExp {
  const source = pattern.split("").map(char => (char === "%" ? "[\\s\\S]*" : char === "_" ? "[\\s\\S]"
    : char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("");
  return new RegExp(`^${source}$`, "i");
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function element(tag: string, fields: Array<[string, string | number]>): string {
  return [
    `  <${tag}>`,
    ...fields.map(([ name, value ]) => `    <${name}>${escapeXml(String(value))}</${name}>`),
    `  </${tag}>`,
  ].join("\n");
}

function query(rows: string[]): string {
  const body = rows.length ? `${rows.join("\n")}\n` : "";
  return `<?xml version="1.0" encoding="utf-8" ?>\n<PLASTICQUERY>\n${body}</PLASTICQUERY>`;
}

function guid(id: number): string {
  return `5e1f0c2a-0000-4000-8000-${String(id).padStart(12, "0")}`;
}
