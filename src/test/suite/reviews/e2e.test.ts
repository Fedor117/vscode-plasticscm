import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CancellationTokenSource,
  commands,
  env,
  Memento,
  OutputChannel,
  TabInputTextDiff,
  TextDocument,
  Uri,
  window,
  workspace,
} from "vscode";
import { CONTEXT_KEYS, IPlasticReviewsHost, PlasticReviews } from "../../../reviews/plasticReviews";
import { DiscussionsProvider, IDiscussionThreadNode } from "../../../reviews/discussionsProvider";
import {
  EMAIL,
  expectHandlerLinksOpen,
  expectLinksOpen,
  expectThreadsOnPage,
  expectWellFormed,
  links,
  testLink,
  textLines,
  visible,
} from "./overviewFixtures";
import { FileChangeStatus, RevisionType } from "../../../models";
import { fileKey, IReviewChangesets, IReviewDiscussions, IReviewFiles, IReviewThread } from "../../../reviews/models";
import { INimbusScenario, IOverviewTarget, ME, nimbusRepository } from "./syntheticNimbus";
import { IReviewLink, parseReviewLink } from "../../../reviews/reviewLinks";
import { ISyntheticComment, ISyntheticDiffRow, ISyntheticReview, SyntheticPlasticServer } from "./syntheticServer";
import { label, NOW } from "./viewFixtures";
import { memorySecrets, nativeThread, until } from "./editorFixtures";
import { noDiffMessage, reviewPickItems } from "../../../reviews/reviewPresentation";
import { CONSENT_MESSAGE } from "../../../reviews/reviewTokens";
import { expect } from "chai";
import { FakeRest } from "./restFixtures";
import { FakeTokenCm } from "./tokenFixtures";
import { IActiveReview } from "../../../reviews/sessionTypes";
import { renderOverview } from "../../../reviews/reviewOverview";
import { reviewDiff } from "../../../reviews/reviewEditors";
import { ReviewListQuery } from "../../../reviews/commands";
import { ReviewService } from "../../../reviews/reviewService";
import { ReviewSession } from "../../../reviews/reviewSession";
import { ReviewTreeProvider } from "../../../reviews/reviewTreeProvider";
import { ReviewWriter } from "../../../reviews/reviewWriter";
import { splitLines } from "../../../reviews/anchors";

/**
 * Plastic Reviews end to end on a synthetic Plastic server (syntheticServer.ts,
 * with the repository of syntheticNimbus.ts): the real ReviewService, session,
 * tree providers, commands, diff editors, comment threads and Overview, each
 * result checked against the model. The review services get the synthetic
 * server's shells, and their cm path cannot exist, so the real cm never runs.
 */

const WORKSPACE_ID = "synthetic";
/** The extension's id, as its context names it: the authority of the Overview's links. */
const EXTENSION_ID = "plastic-scm.plastic-scm";
/** A cm that cannot exist: a review service that reached for the real one would fail at once. */
const SHELL_CONFIG = {
  cmPath: "/nonexistent/cm-must-not-run", millisCommandTimeout: 5000, millisToStop: 1000, millisToWaitUntilUp: 1000,
};
/** Longer than the suite: no test waits on a poll. */
const POLL_INTERVAL = 24 * 60 * 60 * 1000;
const PAGE = 50;
/**
 * A request row as cm stores it: `[requested-review-from]<user>` or
 * `[requested-review-from-<user>]`, also after `re-` and `removed-`.
 */
const REQUEST_ROW = /^\[(removed-|re-)?requested-review-from(?:\]([^\r\n]+)|-([^\]\r\n]+)\])/;

interface IDiffDocuments {
  label: string;
  left: TextDocument;
  right: TextDocument;
}

function keyOf(row: { path: string; revid: number }): string {
  return fileKey({ path: row.path, revisionId: row.revid });
}

function byKey(rows: readonly ISyntheticDiffRow[]): Map<string, ISyntheticDiffRow> {
  return new Map(rows.map(row => [ keyOf(row), row ] as [string, ISyntheticDiffRow]));
}

function nonDirectories(rows: Iterable<ISyntheticDiffRow>): ISyntheticDiffRow[] {
  return Array.from(rows).filter(row => row.type !== "D");
}

/** The top folder of a server path, `/Assets/` of `/Assets/Code/A.cs`, or `/` for a file at the root. */
function pathRoot(serverPath: string): string {
  const slash = serverPath.indexOf("/", 1);
  return slash < 0 ? "/" : serverPath.substring(0, slash + 1);
}

/** The top folders a diff's files sit in, and those its moved files came from. */
function pathRoots(rows: Iterable<ISyntheticDiffRow>): Set<string> {
  const roots = new Set<string>();
  for (const row of nonDirectories(rows)) {
    roots.add(pathRoot(row.path));
    roots.add(pathRoot(row.oldPath ?? row.path));
  }
  return roots;
}

/** A text row per kind of change: changed, added, deleted and moved, first by path. */
function samples(rows: Iterable<ISyntheticDiffRow>): ISyntheticDiffRow[] {
  const text = Array.from(rows)
    .filter(row => row.type === "F" && !(row.statuses.size === 1 && row.statuses.has("C") && row.base < 0))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const only = (status: "A" | "C" | "D") => text.find(row => row.statuses.size === 1 && row.statuses.has(status));
  return [ only("C"), only("A"), only("D"), text.find(row => row.statuses.has("M")) ]
    .filter((row): row is ISyntheticDiffRow => !!row);
}

function describeRow(row: ISyntheticDiffRow): string {
  return `${Array.from(row.statuses).join("")} ${row.path} (rev ${row.revid}, base ${row.base})`;
}

function baseName(serverPath: string): string {
  return serverPath.substring(serverPath.lastIndexOf("/") + 1);
}

/** The title a row's diff has: its name, then both sides by changeset, then the review. */
function diffTitle(row: ISyntheticDiffRow, base: number, head: number, reviewId: number): string {
  const name = baseName(row.path);
  const suffix = ` · #${reviewId}`;
  if (row.statuses.has("A")) {
    return `${name} (added · cs:${head})${suffix}`;
  }
  if (row.statuses.has("D")) {
    return `${name} (deleted · cs:${head})${suffix}`;
  }
  if (row.statuses.has("M")) {
    const oldName = baseName(row.oldPath!);
    return row.statuses.has("C")
      ? `${oldName} (cs:${base}) ↔ ${name} (cs:${head})${suffix}`
      : `${oldName} ↔ ${name} (cs:${head})${suffix}`;
  }
  return `${name} (cs:${base} ↔ cs:${head})${suffix}`;
}

function lines(document: TextDocument): string[] {
  return Array.from({ length: document.lineCount }, (_, index) => document.lineAt(index).text);
}

/** Line-by-line comparison; VS Code normalises mixed line endings, which is not what is under test. */
function expectSameText(document: TextDocument, expected: string, what: string): void {
  const actual = lines(document);
  const wanted = splitLines(expected);
  const first = actual.findIndex((line, index) => line !== wanted[index]);
  const mismatch = first >= 0 ? first : actual.length !== wanted.length ? Math.min(actual.length, wanted.length) : -1;
  expect(mismatch, `${what}: first differing line ${mismatch} ` +
    `(got ${JSON.stringify(actual[mismatch])}, want ${JSON.stringify(wanted[mismatch])}); ` +
    `${actual.length} vs ${wanted.length} lines`).to.equal(-1);
}

function memento(): Memento {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string, fallback?: T) => (values.has(key) ? values.get(key) as T : fallback),
    keys: () => Array.from(values.keys()),
    update: (key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    },
  } as Memento;
}

function anchored(threads: readonly IReviewThread[]): IReviewThread[] {
  return threads.filter(thread => thread.anchor.revisionId > 0 && thread.anchor.location >= 0);
}

/** `a`, `a and b`, `a, b and c`. */
function joinWords(words: readonly string[]): string {
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function closeAllEditors(): Thenable<unknown> {
  return commands.executeCommand("workbench.action.closeAllEditors");
}

describe("Synthetic end-to-end Plastic Reviews", function() {
  this.timeout(20000);
  const output: string[] = [];
  const errors: string[] = [];
  let root = "";
  let scenario: INimbusScenario;
  let server: SyntheticPlasticServer;
  let reviews: PlasticReviews;
  let host: IPlasticReviewsHost;

  const channel = {
    append: (value: string) => output.push(value),
    appendLine: (value: string) => output.push(value),
    clear: () => undefined,
    dispose: () => undefined,
    hide: () => undefined,
    name: "Synthetic Plastic Reviews",
    replace: () => undefined,
    show: () => undefined,
  } as unknown as OutputChannel;

  const session = () => reviews.session;
  const tree = () => (reviews as unknown as { treeProvider: ReviewTreeProvider }).treeProvider;
  const discussions = () => (reviews as unknown as { discussionsProvider: DiscussionsProvider }).discussionsProvider;
  const service = () => session().service(WORKSPACE_ID)!;
  const failures = () => output.filter(line => /failed|Couldn't|ignored/.test(line)).concat(errors).join(" | ");
  /** A review service on a shell of the synthetic server, as the host builds each one. */
  const synthetic = (workspaceId: string, workspacePath: string) =>
    new ReviewService(workspaceId, workspacePath, channel, SHELL_CONFIG, server.shell());

  // ---------------------------------------------------------------------------
  // What the model says the extension should show.
  // ---------------------------------------------------------------------------

  const newest = (filter?: (review: ISyntheticReview) => boolean) => server.newestReviews(filter).map(row => row.id);
  const isOpen = (review: ISyntheticReview) => review.status !== "Reviewed";
  const timelineRows = (reviewId: number) =>
    server.comments.filter(comment => comment.review === reviewId && comment.type === "timeline");
  /** A timeline row's text without its marker, as the row's thread shows it. */
  const markerless = (row: ISyntheticComment) => row.text.replace(/^\[[^\]]*\]/, "").trim();

  /** Whom a review's timeline rows request and remove, read from the rows as cm stores them. */
  function reviewRequests(reviewId: number): { removed: Set<string>; requested: Set<string> } {
    const removed = new Set<string>();
    const requested = new Set<string>();
    for (const row of timelineRows(reviewId)) {
      const match = REQUEST_ROW.exec(row.text.trim());
      if (match) {
        (match[1] === "removed-" ? removed : requested).add((match[2] ?? match[3]).trim().toLowerCase());
      }
    }
    return { removed, requested };
  }

  /** The people still requested: their latest request row is not a removal. In the order first requested. */
  function currentRequests(reviewId: number): string[] {
    const latest = new Map<string, boolean>();
    const rows = timelineRows(reviewId).slice().sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.id - b.id);
    for (const row of rows) {
      const match = REQUEST_ROW.exec(row.text.trim());
      if (match) {
        latest.set((match[2] ?? match[3]).trim().toLowerCase(), match[1] !== "removed-");
      }
    }
    return Array.from(latest.keys()).filter(user => latest.get(user));
  }

  /** Needs My Review: Under review, not the cm user's, and assigned to them or requesting them. */
  function needsMyReview(): number[] {
    return newest(review => review.status === "Under review" && review.owner !== ME &&
      (review.assignee === ME || currentRequests(review.id).includes(ME)));
  }

  function owned(status: string): number[] {
    return newest(review => review.owner === ME && review.status === status);
  }

  /** The review's comments that start a thread on a line of a revision. */
  function anchoredRoots(reviewId: number): number[] {
    return server.comments.filter(comment => comment.review === reviewId && comment.type !== "timeline" &&
      comment.parent < 0 && comment.revision > 0 && comment.location >= 0).map(comment => comment.id);
  }

  /** Status rows of a review, and those that become threads: the ones with text or with replies. */
  function statusRows(reviewId: number): { all: number[]; threads: number[] } {
    const rows = timelineRows(reviewId).filter(row => /^\[status-[a-z-]+\]/.test(row.text));
    const replied = (id: number) => server.comments.some(comment => comment.parent === id);
    return {
      all: rows.map(row => row.id),
      threads: rows.filter(row => markerless(row) || replied(row.id)).map(row => row.id),
    };
  }

  /**
   * The review's General threads, each with its replies: its conversations, and
   * the status rows with text or replies, shown without their markers.
   */
  function generalThreads(reviewId: number): Array<{ id: number; comments: ISyntheticComment[] }> {
    const replies = (id: number): ISyntheticComment[] => server.comments.filter(comment => comment.parent === id)
      .reduce<ISyntheticComment[]>((all, reply) => all.concat(reply, replies(reply.id)), []);
    const verdicts = statusRows(reviewId).threads;
    return server.comments
      .filter(comment => comment.review === reviewId &&
        ((comment.type === "conversation" && comment.parent < 0) || verdicts.includes(comment.id)))
      .map(first => ({
        comments: [{ ...first, text: first.type === "timeline" ? markerless(first) : first.text }]
          .concat(replies(first.id)),
        id: first.id,
      }));
  }

  /** The review's threads are the model's, and each General one is on the Overview in full. */
  function expectReviewThreads(html: string, loaded: IReviewDiscussions, reviewId: number): void {
    const general = generalThreads(reviewId);
    expect(loaded.threads.map(thread => thread.id), `#${reviewId} threads`)
      .to.have.members(anchoredRoots(reviewId).concat(general.map(thread => thread.id)));
    expectThreadsOnPage(html, general);
  }

  /** The headline's names: the short name, marked for the cm user and with a role. */
  function who(user: string, role?: string): string {
    const marks = [ user === ME ? "you" : "", role ?? "" ].filter(Boolean);
    return `${user.split("@")[0]}${marks.length ? ` (${marks.join(", ")})` : ""}`;
  }

  function expectHeadline(html: string, target: IOverviewTarget, owner: string): void {
    const headline = textLines(/<p class="stand-head"><strong>[\s\S]*?<\/strong>/.exec(html)![0])[0];
    if (target.rework) {
      expect(headline, `#${target.id}`).to.equal(`Waiting on ${who(owner, "author")}`);
    } else if (target.waitingOn.length) {
      expect(headline, `#${target.id}`).to.equal(`Waiting on ${joinWords(target.waitingOn.map(user => who(user)))}`);
    } else {
      expect(headline, `#${target.id}`).to.not.match(/^Waiting on /);
    }
  }

  // ---------------------------------------------------------------------------
  // Driving the views and editors.
  // ---------------------------------------------------------------------------

  async function settle<T>(task: Thenable<T>, what: string, millis = 15000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve(task),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${what} did not finish in ${millis} ms. ${failures()}`)), millis);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The Discussions row of a thread, found through its group as the view shows it. */
  function threadNode(threadId: number): IDiscussionThreadNode | undefined {
    for (const group of discussions().getChildren()) {
      for (const node of discussions().getChildren(group)) {
        if (node.kind === "thread" && node.thread.id === threadId) {
          return node;
        }
      }
    }
    return undefined;
  }

  function readyFiles(): IReviewFiles {
    const files = session().active!.files;
    expect(files.state, files.state === "error" ? files.message : "files stage").to.equal("ready");
    return (files as { value: IReviewFiles }).value;
  }

  function readyDiscussions(): IReviewDiscussions {
    return (session().active!.discussions as { value: IReviewDiscussions }).value;
  }

  function readyChangesets(): IReviewChangesets {
    return (session().active!.changesets as { value: IReviewChangesets }).value;
  }

  async function activate(reviewId: number): Promise<void> {
    await settle(session().activate(WORKSPACE_ID, reviewId), `activate #${reviewId}`);
    const active = session().active!;
    expect(active.review.id).to.equal(reviewId);
    for (const stage of [ "files", "discussions", "changesets" ] as const) {
      const value = active[stage];
      expect(value.state, `${stage}: ${value.state === "error" ? value.message : value.state}`).to.equal("ready");
    }
  }

  async function activeDiff(): Promise<IDiffDocuments> {
    const tab = window.tabGroups.activeTabGroup.activeTab;
    const input = tab?.input;
    if (!tab || !(input instanceof TabInputTextDiff)) {
      throw new Error(`The active tab is not a diff: ${tab?.label ?? "no tab"}. ${failures()}`);
    }
    const [ left, right ] = await Promise.all([
      workspace.openTextDocument(input.original),
      workspace.openTextDocument(input.modified),
    ]);
    return { label: tab.label, left, right };
  }

  /** Opens a row the way a click on it does, and checks both sides against the model at base and head. */
  async function checkSample(
      files: IReviewFiles,
      row: ISyntheticDiffRow,
      scope: "changes" | "merged",
      base: number,
      head: number,
      reviewId: number): Promise<void> {
    const file = files.final.files.find(candidate => fileKey(candidate) === keyOf(row));
    expect(file, `final row for ${describeRow(row)}`).to.not.equal(undefined);
    expect(files.mergedKeys.has(fileKey(file!)) ? "merged" : "changes", describeRow(row)).to.equal(scope);
    const node = tree().fileNode(scope, file!);
    expect(node, `${scope} tree row for ${describeRow(row)}`).to.not.equal(undefined);
    await closeAllEditors();
    await settle(commands.executeCommand("plastic-scm.reviews.openChanges", node), `open ${row.path}`);
    await settle(until(() => {
      const at = reviews.editors.activeFile();
      return !!at && fileKey(at.file) === fileKey(file!);
    }, 10000), `diff tab of ${row.path}`);
    const diff = await activeDiff();
    expect(diff.label, describeRow(row)).to.equal(diffTitle(row, base, head, reviewId));
    const left = row.statuses.has("A") ? "" : server.textAt(row.oldPath ?? row.path, base);
    const right = row.statuses.has("D") ? "" : server.textAt(row.path, head);
    expectSameText(diff.left, left, `left of ${describeRow(row)} vs cs:${base}`);
    expectSameText(diff.right, right, `right of ${describeRow(row)} vs cs:${head}`);
  }

  /**
   * Opens a discussion the way a click on its row does. The focused line must
   * read what the comment revision has at its location, and the native thread
   * must sit on that line of that document.
   */
  async function checkComment(thread: IReviewThread, exactSide: "left" | "right" | undefined): Promise<void> {
    const node = threadNode(thread.id);
    expect(node, `Discussions row of thread ${thread.id}`).to.not.equal(undefined);
    expect(node!.general, `thread ${thread.id} is a file thread`).to.equal(false);
    await closeAllEditors();
    const before = output.length;
    await settle(commands.executeCommand("plastic-scm.reviews.openDiscussion", node), `open thread ${thread.id}`);
    expect(output.slice(before).filter(line => line.includes("openDiscussion failed")), `thread ${thread.id}`)
      .to.deep.equal([]);
    await settle(until(() => !!nativeThread(reviews.editors, thread.id), 10000), `native thread ${thread.id}`);
    const diff = await activeDiff();
    const native = nativeThread(reviews.editors, thread.id)!;
    const side = native.uri.toString() === diff.right.uri.toString() ? "right"
      : native.uri.toString() === diff.left.uri.toString() ? "left" : undefined;
    expect(side, `thread ${thread.id} is on a side of the active diff "${diff.label}"`).to.not.equal(undefined);
    if (exactSide) {
      expect(side, `thread ${thread.id} side`).to.equal(exactSide);
      expect(native.range.start.line, `thread ${thread.id} line`).to.equal(thread.anchor.location);
    } else if (!/outdated|original context|previous revision/.test(diff.label)) {
      // Mapped onto the final comparison from another revision of the item.
      expect(native.label, `thread ${thread.id} label`).to.include(` · from rev ${thread.anchor.revisionId}`);
    }
    const document = side === "right" ? diff.right : diff.left;
    await settle(until(() => window.visibleTextEditors.some(editor =>
      editor.document.uri.toString() === document.uri.toString() &&
      editor.selection.active.line === native.range.start.line), 10000), `selection on thread ${thread.id}`);
    const source = splitLines(server.text(thread.anchor.revisionId));
    expect(document.lineAt(native.range.start.line).text,
      `thread ${thread.id}: ${side} line ${native.range.start.line} of "${diff.label}" vs ` +
      `rev ${thread.anchor.revisionId} line ${thread.anchor.location}`)
      .to.equal(source[thread.anchor.location]);
  }

  before(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "plastic-reviews-e2e-"));
    scenario = nimbusRepository(root);
    server = scenario.server;
    host = {
      channel,
      extensionId: EXTENSION_ID,
      globalState: memento(),
      secrets: undefined,
      session: {
        createService: wk => synthetic(wk.id, wk.path),
        now: () => NOW,
        pollInterval: POLL_INTERVAL,
        ui: {
          confirm: () => Promise.resolve(false),
          error: message => {
            errors.push(message);
          },
          progress: (_viewId, task) => task(),
          status: () => undefined,
        },
      },
      shellConfig: () => SHELL_CONFIG,
      workspaceState: memento(),
      workspaces: () => [{ id: WORKSPACE_ID, name: "Nimbus", path: root, repository: server.repository }],
    };
    reviews = new PlasticReviews(host);
    await closeAllEditors();
  });

  afterEach(() => {
    expect(server.unrecognised, "commands the synthetic server does not know").to.deep.equal([]);
    expect(server.calls.filter(call => call.command === "codereview"), "status writes").to.deep.equal([]);
  });

  after(async () => {
    await closeAllEditors();
    reviews?.dispose();
    if (root) {
      await fs.promises.rm(root, { force: true, recursive: true });
    }
  });

  it("lists the queues, loads a review's stages and names its threads by server path", async () => {
    const { branch: name, id } = scenario.branchReview;
    const own = synthetic("direct", root);
    try {
      await own.ready();
      const ids = (list: ReadonlyArray<{ id: number }>) => list.map(review => review.id);
      const expected: { [query in ReviewListQuery]: number[] } = {
        all: newest().slice(0, PAGE),
        allOpen: newest(isOpen).slice(0, PAGE),
        assignedOpen: newest(review => review.assignee === ME && isOpen(review)),
        find: newest(),
        ownedOpen: newest(review => review.owner === ME && isOpen(review)),
      };
      for (const query of [ "assignedOpen", "ownedOpen", "allOpen", "all", "find" ] as const) {
        expect(ids(await own.commands.list(query)), query).to.deep.equal(expected[query]);
      }
      expect(ids(await own.needsMyReview())).to.deep.equal(needsMyReview());
      expect(ids((await own.ownedQueue()).waitingForReviewers)).to.deep.equal(owned("Under review"));

      const review = (await own.review(id))!;
      expect(review.id).to.equal(id);
      const files = await own.loadFiles(review);
      expect(files.final.label).to.equal(`cs:${server.branchBase(name)} ↔ cs:${server.head(name)}`);
      const loaded = await own.loadDiscussions(review, files);
      expect(anchored(loaded.threads).map(thread => thread.id)).to.have.members(anchoredRoots(id));
      for (const thread of loaded.threads.filter(candidate => candidate.path !== undefined)) {
        expect(thread.path!.startsWith("/"), thread.path).to.equal(true);
        expect(thread.path!.toLowerCase().startsWith(root.toLowerCase()), thread.path).to.equal(false);
      }
      const changesets = await own.loadChangesets(review, files);
      expect(ids(changesets.items)).to.deep.equal(server.branchChangesets(name).map(changeset => changeset.id));
      const comparison = await own.changesetComparison(files, changesets.items[0]);
      expect(comparison.files.map(fileKey)).to.have.members(server.changesetDiff(changesets.items[0].id).map(keyOf));
      expect(await own.checkUpdates(review, files, loaded)).to.equal(undefined);

      // A branch review's target is its branch's object id, `id:<n>`.
      expect(review.targetType, `#${id} target`).to.equal("branch");
      const branch = (await own.commands.branch(Number(/^(?:id:)?(\d+)$/.exec(review.target)![1])))!;
      expect(branch.name).to.equal(name);
      const plain = await own.commands.diff(`br:${branch.name}`);
      const clean = await own.commands.diff(`br:${branch.name}`, { clean: true });
      expect(plain.map(fileKey)).to.have.members(server.branchDiff(name).map(keyOf));
      expect(clean.map(fileKey)).to.have.members(server.branchDiff(name, true).map(keyOf));
      expect(clean.length).to.be.lessThan(plain.length);
    } finally {
      own.dispose();
    }
  });

  it("activates the review through the session without opening an editor", async () => {
    const { id } = scenario.branchReview;
    const own = new ReviewSession({
      channel,
      createService: wk => synthetic(wk.id, wk.path),
      globalState: memento(),
      shellConfig: () => SHELL_CONFIG,
      ui: { progress: (_viewId, task) => task() },
      workspaceState: memento(),
      workspaces: () => [{ id: "direct", name: "Nimbus", path: root }],
    });
    try {
      await closeAllEditors();
      await own.activate("direct", id);
      const active = own.active!;
      expect(active.review.id).to.equal(id);
      expect(active.files.state).to.equal("ready");
      expect(active.discussions.state).to.equal("ready");
      expect(active.changesets.state).to.equal("ready");
      expect(window.tabGroups.all.every(group => group.tabs.length === 0)).to.equal(true);
    } finally {
      own.dispose();
    }
  });

  it("renders the Overviews as one block that shows no address and names whom each review waits on", async () => {
    const own = synthetic("direct", root);
    try {
      const whoami = await own.whoami();
      for (const target of scenario.overviewReviews) {
        const review = (await own.review(target.id))!;
        expect(review, `#${target.id}`).to.not.equal(undefined);
        const files = await own.loadFiles(review);
        const loaded = await own.loadDiscussions(review, files);
        const changesets = await own.loadChangesets(review, files);
        const active: IActiveReview = {
          changesets: { state: "ready", value: changesets },
          discussions: { state: "ready", value: loaded },
          files: { state: "ready", value: files },
          review,
          workspaceId: "direct",
        };
        const html = renderOverview(active, { isViewed: () => false, link: testLink, now: NOW, whoami });
        expectWellFormed(html);
        expectLinksOpen(html, active);
        expectReviewThreads(html, loaded, target.id);
        expect(visible(html), `#${target.id}`).to.not.match(EMAIL);
        expect(html, `#${target.id}`).to.not.contain("[apply-change:");
        expectHeadline(html, target, review.owner);
      }
    } finally {
      own.dispose();
    }
  });

  it("loads every queue group", async () => {
    const keys = [ "needsMyReview", "reworkRequested", "waitingForReviewers", "allOpen", "allReviews" ] as const;
    keys.forEach(key => session().expandGroup(key));
    await settle(until(() => keys.every(key => {
      const group = session().group(key);
      return group.stage.state === "error" || (group.loadedOnce && group.stage.state === "ready");
    }), 10000), "queue groups");
    for (const key of keys) {
      const group = session().group(key);
      expect(group.stage.state, `${key}: ${group.stage.state === "error" ? group.stage.message : ""}`)
        .to.equal("ready");
    }
    const ids = (key: typeof keys[number]) => session().group(key).reviews.map(review => review.id);
    const personal = ids("needsMyReview").concat(ids("reworkRequested"), ids("waitingForReviewers"));
    expect(new Set(personal).size, "a review is in at most one personal group").to.equal(personal.length);
    for (const review of session().group("needsMyReview").reviews) {
      expect(review.owner.toLowerCase(), `needsMyReview #${review.id} owner`).to.not.equal(ME);
      expect(review.status, `needsMyReview #${review.id}`).to.equal("Under review");
    }
    expect(ids("needsMyReview"), "assigned to or requesting the cm user, not theirs").to.deep.equal(needsMyReview());
    // Asked for in each way cm records it: assigned, requested in either row format; not once the request is
    // removed, not when the review waits on rework or is settled, and not for the cm user's own review.
    expect(ids("needsMyReview")).to.include.members([ scenario.branchReview.id, 310, 311 ]);
    [ 312, 313, 314, 315 ].forEach(id => expect(ids("needsMyReview"), `#${id}`).to.not.include(id));
    expect(ids("waitingForReviewers")).to.deep.equal(owned("Under review"));
    expect(ids("waitingForReviewers")).to.include.members([ scenario.hiddenReview.id, scenario.changesetReview.id ]);
    expect(ids("reworkRequested")).to.deep.equal(owned("Rework required")).and.deep.equal([316]);
    expect(newest(isOpen).length, "open reviews, more than a page").to.be.greaterThan(PAGE);
    expect(ids("allOpen")).to.deep.equal(newest(isOpen).slice(0, PAGE));
    expect(session().group("allOpen").hasMore).to.equal(true);
    expect(ids("allReviews"), "All Reviews: anyone's, any status").to.deep.equal(newest().slice(0, PAGE));
    expect(session().group("allReviews").hasMore).to.equal(true);
  });

  it("pages All Open and All Reviews, and lists every review for Find Review…", async () => {
    const paged = [ "allOpen", "allReviews" ] as const;
    const group = (key: typeof paged[number]) => session().group(key);
    const ids = (key: typeof paged[number]) => group(key).reviews.map(review => review.id);
    // The first pages, unless the queue test above loaded them already.
    paged.forEach(key => session().expandGroup(key));
    await settle(until(() => paged.every(key => group(key).loadedOnce && group(key).stage.state === "ready"), 10000),
      "first pages");
    paged.forEach(key => session().loadMore(key));
    await settle(until(() => paged.every(key => group(key).stage.state !== "loading"), 10000), "second pages");
    // All Open ends on its second page; All Reviews goes on.
    expect(newest(isOpen).length, "open reviews, more than a page and at most two").to.be.within(PAGE + 1, 2 * PAGE);
    expect(ids("allOpen")).to.deep.equal(newest(isOpen));
    expect(group("allOpen").hasMore).to.equal(false);
    expect(newest().length, "reviews, more than two pages").to.be.greaterThan(2 * PAGE);
    expect(ids("allReviews")).to.deep.equal(newest().slice(0, 2 * PAGE));
    expect(group("allReviews").hasMore).to.equal(true);
    const found = await settle(session().findReviews(), "Find Review… query");
    expect(found.reviews.map(review => review.id)).to.deep.equal(newest());
    // Branch reviews whose title the author wrote are named by the branch queries, hidden branches too; a deleted
    // branch has no name.
    const unnamed = server.reviews.filter(review => review.targetType === "Branch" &&
      !review.title.startsWith("Review of branch "));
    const named = unnamed.map(review => server.branchById(review.target)).filter(branch => !branch.deleted)
      .map(branch => [ branch.id, branch.name ] as [number, string]).sort((a, b) => a[0] - b[0]);
    expect(Array.from(found.branches.entries()).sort((a, b) => a[0] - b[0])).to.deep.equal(named);
    const branchOf = (reviewId: number) => found.branches.get(server.review(reviewId).target);
    expect(branchOf(scenario.branchReview.id)).to.equal(scenario.branchReview.branch);
    expect(branchOf(scenario.namedHiddenReview.id)).to.equal(scenario.namedHiddenReview.branch);
    expect(branchOf(scenario.deletedReview.id)).to.equal(undefined);
    const items = reviewPickItems(found.reviews, NOW, "", { branches: found.branches });
    const detail = (reviewId: number) => items.find(item => item.id === reviewId)?.detail;
    expect(detail(scenario.branchReview.id)).to.equal(`${scenario.branchReview.branch} · Under review`);
    expect(detail(scenario.deletedReview.id), "Find Review… says branch").to.equal("branch · Under review");
    // Kept for a while: asking again runs no query.
    const calls = server.calls.length;
    expect(await session().findReviews()).to.equal(found);
    expect(server.calls.length).to.equal(calls);
  });

  it("activates the branch review, stage after stage, without opening an editor", async () => {
    const { id } = scenario.branchReview;
    await closeAllEditors();
    const settled: string[] = [];
    const listener = session().onDidChangeActive(() => {
      const active = session().active;
      for (const stage of [ "files", "discussions", "changesets" ] as const) {
        const state = active?.[stage].state;
        const mark = `${stage} ${state ?? ""}`;
        if (active?.review.id === id && (state === "ready" || state === "error") && !settled.includes(mark)) {
          settled.push(mark);
        }
      }
    });
    try {
      await activate(id);
    } finally {
      listener.dispose();
    }
    expect(settled).to.deep.equal([ "files ready", "discussions ready", "changesets ready" ]);
    expect(window.tabGroups.all.every(group => group.tabs.length === 0), "no editor opened").to.equal(true);
  });

  it("shows the branch review's files as the model computes them: Changes = --clean, Merged = plain − clean",
    async () => {
      const { branch: name, id } = scenario.branchReview;
      await activate(id);
      const files = readyFiles();
      const branch = files.branch!;
      expect(branch.name).to.equal(name);
      expect(branch.hidden).to.equal(false);
      const base = server.branchBase(name);
      const head = server.head(name);
      expect(branch.headChangesetId).to.equal(head);
      expect(files.head).to.equal(head);
      expect(files.base).to.equal(base);
      expect(files.final.label).to.equal(`cs:${base} ↔ cs:${head}`);
      expect(files.final.baseChangesetId).to.equal(base);
      expect(files.final.headChangesetId).to.equal(head);

      const plain = byKey(server.branchDiff(name));
      const clean = byKey(server.branchDiff(name, true));
      expect(clean.size, "a merge brought in rows of its own").to.be.lessThan(plain.size);
      Array.from(clean.keys()).forEach(key => expect(plain.has(key), `clean row ${key} is a plain row`).to.equal(true));
      expect(files.final.files.map(fileKey)).to.have.members(Array.from(plain.keys()));
      const changes = files.final.files.filter(file => !files.mergedKeys.has(fileKey(file)));
      expect(changes.map(fileKey), "Changes rows").to.have.members(Array.from(clean.keys()));
      expect(files.mergedKeys.size, "Merged rows").to.equal(plain.size - clean.size);

      // The tree lists file rows; directory records are not counted.
      const changedFiles = nonDirectories(clean.values()).length;
      const mergedFiles = nonDirectories(plain.values()).length - changedFiles;
      expect(changedFiles, "a directory row").to.be.lessThan(clean.size);
      expect(tree().scopeFiles("changes")!.length, "Changes files in the tree").to.equal(changedFiles);
      expect(tree().scopeFiles("merged")!.length, "Merged files in the tree").to.equal(mergedFiles);
      const roots = tree().getChildren();
      expect(roots.map(node => node.kind)).to.deep.equal([ "overview", "changes", "merged", "changesets" ]);
      const items = roots.map(node => tree().getTreeItem(node));
      expect(label(items[1])).to.equal("Changes");
      expect(items[1].description).to.equal(`0/${changedFiles} viewed · cs:${base} ↔ cs:${head}`);
      expect(label(items[2])).to.equal("Merged from other branches");
      expect(items[2].description).to.equal(`${mergedFiles} files`);
      const tooltip = items[2].tooltip;
      expect(typeof tooltip === "string" ? tooltip : tooltip?.value).to.include(`cs:${base}`).and.include(`cs:${head}`);

      const changed = samples(clean.values());
      expect(changed.map(row => Array.from(row.statuses).join("")), "a text row of each kind")
        .to.have.members([ "C", "A", "D", "CM" ]);
      for (const row of changed) {
        await checkSample(files, row, "changes", base, head, id);
      }
      const merged = samples(Array.from(plain.values()).filter(row => !clean.has(keyOf(row))));
      expect(merged.length, "a merged text row").to.be.greaterThan(0);
      for (const row of merged) {
        await checkSample(files, row, "merged", base, head, id);
      }
    });

  it("lists the branch review's changesets with its merges", async () => {
    const { branch: name, id } = scenario.branchReview;
    await activate(id);
    const files = readyFiles();
    const changesets = readyChangesets();
    expect(changesets.items.map(item => item.id)).to.deep.equal(
      server.branchChangesets(name, files.head).map(changeset => changeset.id));
    expect(changesets.hasMore).to.equal(false);
    const merges = server.mergesInto(name, files.head);
    expect(merges.length, "merges from /main").to.equal(2);
    expect(changesets.items.filter(item => item.isMerge).map(item => [ item.id, item.mergeSourceBranch ]))
      .to.deep.equal(merges.map(merge => [ merge.id, server.changeset(merge.mergedFrom!).branch ]));
  });

  it("names the branch review's threads by server path and opens each on its line", async () => {
    const { branch: name, id } = scenario.branchReview;
    await activate(id);
    const value = readyDiscussions();
    const threads = anchored(value.threads);
    expect(threads.map(thread => thread.id), "anchored threads").to.have.members(anchoredRoots(id));
    const rows = server.branchDiff(name);
    const roots = pathRoots(rows);
    const base = server.branchBase(name);
    const head = server.head(name);
    for (const thread of threads) {
      const revision = thread.anchor.revisionId;
      const right = rows.find(row => row.revid === revision);
      const left = rows.find(row => row.base === revision);
      const exact = right ? (right.statuses.has("D") ? "left" : "right") : left ? "left" : undefined;
      expect(exact, `rev ${revision} is a side of a final row`).to.not.equal(undefined);
      expect(thread.path, `thread ${thread.id} path`).to.equal(right ? right.path : left!.oldPath ?? left!.path);
      expect(roots.has(pathRoot(thread.path!)), `${thread.path} sits where the diff's files do`).to.equal(true);
      await checkComment(thread, exact);
      const diff = await activeDiff();
      expect(diff.label, "the diff title names its sides").to.equal(diffTitle((right ?? left)!, base, head, id));
      if (right && exact === "right" && right.base >= 0) {
        expectSameText(diff.left, server.text(right.base), `left of thread ${thread.id}`);
      }
    }
    // The reviewers are whom the timeline rows request: never someone nobody asked, always someone nobody removed.
    const { removed, requested } = reviewRequests(id);
    const reviewers = value.reviewers.map(user => user.toLowerCase());
    expect(reviewers, "requested reviewers").to.not.be.empty;
    expect(Array.from(requested), "every reviewer was requested").to.include.members(reviewers);
    expect(reviewers, "every request nobody removed")
      .to.include.members(Array.from(requested).filter(user => !removed.has(user)));
    expect(reviewers, "requested and not removed since").to.deep.equal(currentRequests(id));
    const overview = session().overview(WORKSPACE_ID, id);
    expect(overview).to.include("<h2>Reviewers ").and.include("<h2>History</h2>");
  });

  it("loads the hidden branch review with its files, changesets and discussions", async () => {
    const { branchId, id } = scenario.hiddenReview;
    const name = server.branchById(branchId).name;
    await activate(id);
    const files = readyFiles();
    expect(files.branchDeleted, "the hidden branch is not reported deleted").to.equal(false);
    const branch = files.branch!;
    expect(branch.id).to.equal(branchId);
    expect(branch.name).to.equal(name);
    expect(branch.hidden).to.equal(true);
    expect(tree().description()).to.include("(hidden)");
    const base = server.branchBase(name);
    const head = server.head(name);
    expect(files.base).to.equal(base);
    expect(files.head).to.equal(head);
    expect(files.final.label).to.equal(`cs:${base} ↔ cs:${head}`);
    const plain = byKey(server.branchDiff(name));
    const clean = byKey(server.branchDiff(name, true));
    expect(files.final.files.map(fileKey)).to.have.members(Array.from(plain.keys()));
    expect(files.mergedKeys.size, "Merged rows").to.be.greaterThan(0).and.equal(plain.size - clean.size);

    const changesets = readyChangesets();
    const expected = server.branchChangesets(name, head).map(changeset => changeset.id);
    expect(expected.length, "more than a page of changesets").to.be.greaterThan(PAGE);
    expect(changesets.items.map(item => item.id)).to.deep.equal(expected.slice(0, PAGE));
    expect(changesets.hasMore).to.equal(true);
    changesets.items.forEach(item => expect(item.branch).to.equal(name));

    const [changed] = samples(clean.values());
    await checkSample(files, changed, "changes", base, head, id);
    const [merged] = samples(Array.from(plain.values()).filter(row => !clean.has(keyOf(row))));
    await checkSample(files, merged, "merged", base, head, id);

    const value = readyDiscussions();
    const threads = anchored(value.threads);
    expect(threads.map(thread => thread.id), "anchored threads").to.have.members(anchoredRoots(id));
    const roots = pathRoots(plain.values());
    const rows = Array.from(plain.values());
    let mapped = 0;
    for (const thread of threads) {
      expect(thread.path, `thread ${thread.id}`).to.equal(server.workspacePath(thread.anchor.revisionId));
      expect(roots.has(pathRoot(thread.path!)), `${thread.path} sits where the diff's files do`).to.equal(true);
      const right = rows.find(row => row.revid === thread.anchor.revisionId);
      const left = rows.find(row => row.base === thread.anchor.revisionId);
      const exact = right ? (right.statuses.has("D") ? "left" : "right") : left ? "left" : undefined;
      mapped += exact ? 0 : 1;
      await checkComment(thread, exact);
      // Every thread of the same revision shows in the same diff.
      const native = nativeThread(reviews.editors, thread.id)!;
      threads.filter(other => other.anchor.revisionId === thread.anchor.revisionId).forEach(other => {
        expect(nativeThread(reviews.editors, other.id)?.uri.toString(), `thread ${other.id} beside ${thread.id}`)
          .to.equal(native.uri.toString());
      });
    }
    expect(mapped, "a thread mapped from another revision of its item").to.be.greaterThan(0);
    const active = session().active!;
    expect(await service().checkUpdates(active.review, files, value), "no update reported").to.equal(undefined);
  });

  it("loads the changeset review on a hidden branch", async () => {
    const { changeset: changesetId, id } = scenario.changesetReview;
    await activate(id);
    const files = readyFiles();
    const changeset = server.changeset(changesetId);
    expect(server.branch(changeset.branch).hidden, "on a hidden branch").to.equal(true);
    expect(files.head).to.equal(changesetId);
    expect(files.base).to.equal(changeset.parent);
    expect(files.branch).to.equal(undefined);
    expect(files.mergedKeys.size).to.equal(0);
    expect(files.final.label).to.equal(`cs:${changeset.parent} ↔ cs:${changesetId}`);
    const items = readyChangesets().items;
    expect(items.map(item => item.id)).to.deep.equal([changesetId]);
    const [shown] = items;
    expect(shown.parentId).to.equal(changeset.parent);
    expect(shown.branch).to.equal(changeset.branch);
    expect(shown.owner).to.equal(changeset.owner);
    // The comment as written, every line of it.
    expect(shown.comment).to.equal(changeset.comment);
    const rows = byKey(server.changesetDiff(changesetId));
    expect(files.final.files.map(fileKey)).to.have.members(Array.from(rows.keys()));
    const roots = tree().getChildren();
    expect(roots.map(node => label(tree().getTreeItem(node)))).to.include(`Changes in cs:${changesetId}`);
    const texts = Array.from(rows.values()).filter(row => row.type === "F").slice(0, 3);
    expect(texts.map(row => Array.from(row.statuses).join("")), "an added, a changed and a deleted text row")
      .to.have.members([ "A", "C", "D" ]);
    for (const row of texts) {
      await checkSample(files, row, "changes", changeset.parent, changesetId, id);
    }
  });

  it("turns status verdicts into General threads and leaves text-less ones to the activity log", async () => {
    const known = scenario.verdictReview;
    const recent = newest(review => review.status === "Reviewed").slice(0, 5);
    for (const id of Array.from(new Set(recent.concat(known.id)))) {
      const expected = statusRows(id);
      const review = (await service().review(id))!;
      const loaded = await service().loadDiscussions(review);
      const status = loaded.threads.filter(thread => thread.kind === "status");
      expect(loaded.timeline.filter(event => event.kind === "status").length, `#${id}`).to.equal(expected.all.length);
      expect(status.map(thread => thread.id), `#${id} status threads`).to.have.members(expected.threads);
      status.forEach(thread => {
        expect(thread.event?.status).to.be.oneOf([ "Reviewed", "Rework required", "Under review" ]);
        const row = server.comments.find(comment => comment.id === thread.id)!;
        expect(thread.comments[0].text, `status thread ${thread.id}`).to.equal(markerless(row));
      });
    }
    const verdicts = statusRows(known.id);
    expect(verdicts.threads.length, "a verdict without text").to.be.lessThan(verdicts.all.length);
    await activate(known.id);
    const value = readyDiscussions();
    const verdict = value.threads.find(thread => thread.id === known.verdictThread);
    expect(verdict?.kind).to.equal("status");
    expect(verdict!.comments.map(comment => comment.id), "the reply to the verdict").to.include(known.replyToVerdict);
    const general = discussions().getChildren().find(node => node.kind === "group" && node.group === "general");
    expect(general, "General group").to.not.equal(undefined);
    const inGeneral = discussions().getChildren(general).map(node => (node.kind === "thread" ? node.thread.id : -1));
    expect(inGeneral).to.have.members([known.generalThread].concat(verdicts.threads));
    const verdictRow = threadNode(known.verdictThread)!;
    expect(label(discussions().getTreeItem(verdictRow))).to.include(known.verdictText);
    // A General row opens the Overview, where the verdict's reply sits under it: on the reviewer's card, or in
    // Other discussions once a later verdict replaced it.
    const before = output.length;
    await settle(commands.executeCommand("plastic-scm.reviews.openDiscussion", verdictRow), "open the verdict");
    expect(output.slice(before).filter(line => line.includes("failed"))).to.deep.equal([]);
    const overview = session().overview(WORKSPACE_ID, known.id);
    expect(overview).to.not.include("Verdicts");
    const replies = overview.split("\n").filter(line => line.includes("<ul class=\"replies\">"))
      .map(line => line.substring(line.indexOf("<ul class=\"replies\">")));
    expect(replies.some(line => line.includes(known.replyText)), "the reply under the verdict").to.equal(true);
    await closeAllEditors();
    const files = readyFiles();
    expect(files.branch?.hidden).to.equal(true);
    expect(files.final.files.map(fileKey)).to.have.members(server.branchDiff(files.branch!.name).map(keyOf));
    const updates = await service().checkUpdates(session().active!.review, files, value);
    expect(updates, "no update reported").to.equal(undefined);
  });

  it("opens the outdated review's comment, whose line the final revision no longer has, as outdated", async () => {
    const { id, verdictText } = scenario.outdatedReview;
    await activate(id);
    const files = readyFiles();
    const value = readyDiscussions();
    const threads = anchored(value.threads);
    expect(threads.map(thread => thread.id), "anchored threads").to.have.members(anchoredRoots(id));
    expect(threads.length).to.be.greaterThan(0);
    const rows = server.branchDiff(files.branch!.name);
    for (const thread of threads) {
      const serverPath = server.workspacePath(thread.anchor.revisionId);
      expect(thread.path).to.equal(serverPath);
      const row = rows.find(candidate => candidate.path === serverPath);
      expect(row, `${serverPath} is in the final diff`).to.not.equal(undefined);
      expect(row!.revid, "the comment revision is not the final one").to.not.equal(thread.anchor.revisionId);
      await checkComment(thread, undefined);
      const diff = await activeDiff();
      expect(diff.label).to.include(`rev ${thread.anchor.revisionId} · outdated`);
      // The left side is the final row's left side: what the branch started from.
      expectSameText(diff.left, row!.base < 0 ? "" : server.text(row!.base), "outdated left");
    }
    expect(value.threads.some(thread => thread.kind === "status" && thread.event?.text === verdictText),
      `a "${verdictText}" verdict`).to.equal(true);
  });

  it("reads a restored plastic-review: tab through a fresh PlasticReviews", async () => {
    const { id } = scenario.outdatedReview;
    await activate(id);
    const files = readyFiles();
    const file = files.final.files.find(candidate => candidate.revisionType === RevisionType.TextFile &&
      candidate.status === FileChangeStatus.Changed && candidate.baseRevisionId >= 0)!;
    expect(file, "a changed text file").to.not.equal(undefined);
    const sides = reviewDiff(WORKSPACE_ID, id, files.final, file);
    await closeAllEditors();
    // As after a window reload: nothing of the old instance survives, only the tab's URIs.
    reviews.dispose();
    reviews = new PlasticReviews(host);
    const right = await settle(workspace.openTextDocument(sides.right.uri), "restored right side");
    const left = await settle(workspace.openTextDocument(sides.left.uri), "restored left side");
    const name = files.branch!.name;
    expectSameText(right, server.textAt(file.path, server.head(name)), `restored right of ${file.path}`);
    expectSameText(left, server.textAt(file.oldPath ?? file.path, server.branchBase(name)),
      `restored left of ${file.path}`);
  });

  it("renders the Overviews through the session, and every link on them opens", async () => {
    const me = await settle(service().whoami(), "cm whoami");
    const prefix = `${env.uriScheme}://${EXTENSION_ID}/`;
    const shown: string[] = [];
    const api = window as unknown as { showInformationMessage: (message: string) => Thenable<undefined> };
    const original = api.showInformationMessage;
    api.showInformationMessage = message => {
      shown.push(message);
      return Promise.resolve(undefined);
    };
    let opened = 0;
    let explained = 0;
    try {
      for (const target of scenario.overviewReviews) {
        const { id } = target;
        await activate(id);
        const active = session().active!;
        const review = active.review;
        const value = readyDiscussions();
        const html = session().overview(WORKSPACE_ID, id);
        expectWellFormed(html);
        expect(visible(html), `#${id}`).to.not.match(EMAIL);
        expect(html, `#${id}`).to.not.contain("[apply-change:");
        expectReviewThreads(html, value, id);
        if (review.owner === me || review.assignee === me) {
          expect(visible(html), `#${id} marks ${me}`).to.contain("(you)");
        }
        expectHeadline(html, target, review.owner);
        expectHandlerLinksOpen(html, active, prefix);
        // Every link, as the page writes it, through the URI handler: it opens what a click on its row opens.
        const rows = readyFiles().final.files;
        for (const href of links(html).map(link => link.href).filter(candidate => candidate.startsWith(prefix))) {
          const linked = (parseReviewLink(Uri.parse(href)) as { link: IReviewLink }).link.target;
          const file = linked.kind === "file" ? rows.find(row => fileKey(row) === linked.fileKey) : undefined;
          await closeAllEditors();
          const before = shown.length;
          await settle(reviews.actions.handleUri(Uri.parse(href)), `link ${href}`);
          if (file && noDiffMessage(file)) {
            // A row without a text diff says why, as its row in the Review view does.
            expect(shown.slice(before), href).to.deep.equal([noDiffMessage(file)]);
            explained++;
            continue;
          }
          await settle(until(() => {
            const input = window.tabGroups.activeTabGroup.activeTab?.input;
            return input instanceof TabInputTextDiff && input.modified.scheme === "plastic-review";
          }, 10000), `diff from ${href}`);
          if (linked.kind === "file") {
            expect(reviews.editors.activeFile() && fileKey(reviews.editors.activeFile()!.file), href)
              .to.equal(linked.fileKey);
          } else if (linked.kind === "thread") {
            const thread = value.threads.find(candidate => candidate.id === linked.threadId)!;
            expect(window.tabGroups.activeTabGroup.activeTab!.label, href).to.contain(baseName(thread.path ?? ""));
          }
          opened++;
        }
      }
    } finally {
      api.showInformationMessage = original;
    }
    expect(shown.length, `links that could not open: ${shown.join(" | ")}`).to.equal(explained);
    expect(output.filter(line => line.includes("openLink failed"))).to.deep.equal([]);
    // The changeset review lists its binary file, which has no text diff to open.
    const binaries = scenario.overviewReviews.map(target => server.review(target.id))
      .filter(review => review.targetType === "Changeset")
      .map(review => server.changesetDiff(review.target).filter(row => row.type === "B").length)
      .reduce((sum, count) => sum + count, 0);
    expect(explained, "links that say why they open no diff").to.equal(binaries);
    expect(opened, "links dispatched through the handler").to.be.greaterThan(0);
  });

  it("adds the cm user as a reviewer through a fake REST API, with a token from a fake cm, and the Overview shows them",
    async () => {
      const REVIEW_ID = 312;
      const refused: string[] = [];
      const asked: string[] = [];
      let added: number | undefined;
      // The Server REST API in memory: it knows review 312 of Nimbus and adds one reviewer to it, once; any other write
      // it refuses. As the service would, the add puts a request row in the review's timeline.
      const rest = new FakeRest();
      rest.repositories = ["Nimbus"];
      rest.reviews = new Set([REVIEW_ID]);
      rest.respond = call => {
        if (call.method !== "GET" &&
          (added !== undefined || !call.path.endsWith(`/codereview/${REVIEW_ID}/reviewers`))) {
          refused.push(`${call.method} ${call.path}`);
          return Promise.reject(new Error("the fake REST API refuses every other write"));
        }
        return undefined;
      };
      rest.onWrite = call => {
        const [user] = (call.body as { reviewers: string[] }).reviewers;
        added = server.addTimeline(REVIEW_ID, user, "2026-09-22T17:30:00+01:00", `[requested-review-from]${user}`);
      };
      // cm for tokens, in memory as well: the review services' cm path cannot exist, and neither is the real cm run.
      const cm = new FakeTokenCm();
      const statuses: string[] = [];
      reviews.dispose();
      reviews = new PlasticReviews({
        ...host,
        posting: { setting: () => true, trusted: () => true, writer: new ReviewWriter(rest.transport) },
        secrets: memorySecrets(),
        session: {
          ...host.session,
          ui: {
            ...host.session?.ui,
            cancellable: (_title, task) => task(new CancellationTokenSource().token),
            // The one question: whether to create the first token for the organization.
            choose: message => {
              asked.push(message);
              return Promise.resolve("Create Token and Add");
            },
            status: message => {
              statuses.push(message);
            },
          },
        },
        tokenCm: cm,
      });
      const keys = (reviews as unknown as { keys: Map<string, unknown> }).keys;
      const needsMe = () => session().group("needsMyReview");
      /** The Reviewers section's lines, from its heading to the next heading. */
      const reviewersSection = (html: string) => {
        const rows = textLines(html);
        const next = /^(?:Open items|Conversation|Other discussions|Changesets|History)\b/;
        const start = rows.findIndex(line => /^Reviewers \d+$/.test(line));
        return rows.slice(start, rows.findIndex((line, index) => index > start && next.test(line)));
      };
      const myCard = (html: string) => reviewersSection(html).filter(line => /^dana\.kim you\b/.test(line));
      try {
        session().expandGroup("needsMyReview");
        await settle(until(() => needsMe().loadedOnce && needsMe().stage.state === "ready"), "Needs My Review");
        expect(needsMe().reviews.map(review => review.id)).to.not.include(REVIEW_ID);
        await activate(REVIEW_ID);
        expect(await settle(service().whoami(), "cm whoami")).to.equal(ME);
        // Requested once, then removed: the cm user is not a reviewer, so the Review view and the Overview offer it.
        await settle(until(() => keys.get(CONTEXT_KEYS.canAddMeAsReviewer) === true), "the Add Me as Reviewer key");
        const before = session().overview(WORKSPACE_ID, REVIEW_ID);
        expectWellFormed(before);
        expect(links(before).filter(link => link.text === "Add me as reviewer")).to.have.length(1);
        expect(myCard(before)).to.deep.equal([]);

        await settle(commands.executeCommand("plastic-scm.reviews.addMeAsReviewer"), "Add Me as Reviewer");
        expect(asked).to.deep.equal([CONSENT_MESSAGE]);
        expect(cm.calls.map(call => call.slice(0, 2).join(" "))).to.deep.equal([
          "getconfig organization", "accesstoken create", "accesstoken reveal",
        ]);
        expect(refused, "writes the fake refused").to.deep.equal([]);
        expect(added, "the request row the fake REST API wrote").to.be.a("number");
        expect(rest.writes().map(call => call.path))
          .to.deep.equal([`/api/v1/organizations/acme-studio/repos/Nimbus/codereview/${REVIEW_ID}/reviewers`]);
        expect(rest.calls.every(call => call.token === cm.revealed[0])).to.equal(true);
        await settle(until(() => keys.get(CONTEXT_KEYS.canAddMeAsReviewer) === false), "the key after the add");
        await settle(until(() => myCard(session().overview(WORKSPACE_ID, REVIEW_ID)).length > 0), "the reviewer card");
        const after = session().overview(WORKSPACE_ID, REVIEW_ID);
        expectWellFormed(after);
        // The service writes the request row as the cm user's own, and a self-request reads as Reviewing.
        expect(myCard(after)).to.deep.equal(["dana.kim you Reviewing"]);
        expect(links(after).filter(link => link.text === "Add me as reviewer")).to.deep.equal([]);
        expect(readyDiscussions().reviewers.map(user => user.toLowerCase())).to.include(ME);
        expect(statuses).to.include(`$(person-add) Added you as a reviewer on review #${REVIEW_ID}`);
        await settle(until(() => needsMe().reviews.some(review => review.id === REVIEW_ID)), "Needs My Review after");
        expect(needsMe().reviews.map(review => review.id)).to.deep.equal(needsMyReview());

        // Run again, it sends nothing and asks nothing: the cm user is a reviewer now.
        await settle(commands.executeCommand("plastic-scm.reviews.addMeAsReviewer"), "Add Me as Reviewer again");
        expect([ rest.writes().length, asked.length, cm.count("create") ]).to.deep.equal([ 1, 1, 1 ]);
        expect(errors, "errors shown").to.deep.equal([]);
        expect(output.join("\n")).to.not.contain(cm.revealed[0]);
      } finally {
        const row = server.comments.findIndex(comment => comment.id === added);
        if (row >= 0) {
          server.comments.splice(row, 1);
        }
        reviews.dispose();
        reviews = new PlasticReviews(host);
      }
    });
});
