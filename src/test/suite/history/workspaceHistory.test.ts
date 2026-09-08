import { Event, EventEmitter, OutputChannel } from "vscode";
import {
  FileChangeStatus,
  IBranchInfo,
  IChangesetFileChange,
  IHistoryChangeset,
  IMergeLink,
  IWorkspaceConfig,
  IWorkspaceInfo,
  RevisionType,
  WkConfigType,
} from "../../../models";
import { ICmParser, ICmResult, ICmShell } from "../../../cm/shell";
import { IMock, It, Mock, MockBehavior, Times } from "typemoq";
import { expect } from "chai";
import { IConfig } from "../../../config";
import { Workspace } from "../../../workspace";
import { WorkspaceHistory } from "../../../history/workspaceHistory";

const X = "/main/X";
const MAIN = "/main";
const OWNER = "dana.kim@example.com";
const REPOSITORY = "Nimbus/Nimbus";
const SERVER = "acme-studio@unity";
const FIND_ARGS = [ "--xml", "--nototal", "--encoding=utf-8" ];

interface ICall {
  readonly args: string[];
  readonly command: string;
}

/** Parks matching cm calls until `released` resolves, so a test can observe the in-between state. */
interface IHold {
  readonly matches: (call: ICall) => boolean;
  readonly released: Promise<void>;
}

/**
 * Stands in for the cm server: answers the same queries the real commands
 * build, so paging and where clauses are exercised for real.
 */
interface IFakeRepo {
  readonly branches: Map<string, IBranchInfo>;
  readonly calls: ICall[];
  changesets: IHistoryChangeset[];
  /** `branch`, `merge`, `diff`, `byid` or `changeset:<branch>`. */
  readonly failing: Set<string>;
  readonly files: Map<number, IChangesetFileChange[]>;
  readonly holds: IHold[];
  merges: IMergeLink[];
}

interface IFakeWorkspace {
  currentChangeset: number;
  readonly info: IWorkspaceInfo;
  readonly onDidRunStatus: Event<void>;
  readonly shell: ICmShell;
  workspaceConfig: IWorkspaceConfig | undefined;
}

interface IHarnessOptions {
  configType?: WkConfigType;
  currentChangeset?: number;
  location?: string;
  pageSize?: number;
  startResult?: boolean;
}

interface IHarness {
  readonly changes: () => number;
  readonly clock: { now: number };
  readonly history: WorkspaceHistory;
  readonly ownShell: IMock<ICmShell>;
  readonly repo: IFakeRepo;
  readonly statusEmitter: EventEmitter<void>;
  readonly workspace: IFakeWorkspace;
  readonly workspaceShell: IMock<ICmShell>;
}

function changeset(id: number, branch: string, parentId: number, comment = `cs ${id}`): IHistoryChangeset {
  return {
    branch,
    comment,
    date: new Date(Date.UTC(2026, 8, 1, 12, 0, id % 60)),
    guid: `guid-${id}`,
    id,
    owner: OWNER,
    parentId,
    repository: REPOSITORY,
    server: SERVER,
  };
}

function branchInfo(name: string, headChangesetId: number, parent?: string): IBranchInfo {
  return {
    comment: "",
    date: new Date(0),
    guid: `guid-${name}`,
    headChangesetId,
    name,
    owner: OWNER,
    parent,
    repository: REPOSITORY,
    server: SERVER,
  };
}

function mergeLink(
    sourceBranch: string,
    sourceChangesetId: number,
    destinationBranch: string,
    destinationChangesetId: number): IMergeLink {
  return { destinationBranch, destinationChangesetId, sourceBranch, sourceChangesetId, type: "merge" };
}

function fileChange(path: string): IChangesetFileChange {
  return {
    baseRevisionId: 1,
    parentRevisionId: 1,
    path,
    repository: `${REPOSITORY}@${SERVER}`,
    revisionId: 2,
    revisionType: RevisionType.TextFile,
    status: FileChangeStatus.Changed,
  };
}

/** `/main` 10..50 and `/main/X` 15..55 forked at 10, merged both ways. */
function createRepo(): IFakeRepo {
  return {
    branches: new Map<string, IBranchInfo>([
      [ MAIN, branchInfo(MAIN, 50) ],
      [ X, branchInfo(X, 55, MAIN) ],
    ]),
    calls: [],
    changesets: [
      changeset(10, MAIN, -1),
      changeset(20, MAIN, 10),
      changeset(30, MAIN, 20),
      changeset(40, MAIN, 30),
      changeset(50, MAIN, 40),
      changeset(15, X, 10),
      changeset(25, X, 15),
      changeset(35, X, 25),
      changeset(45, X, 35),
      changeset(55, X, 45),
    ],
    failing: new Set<string>(),
    files: new Map<number, IChangesetFileChange[]>(),
    holds: [],
    merges: [
      mergeLink(MAIN, 40, X, 45),
      mergeLink(X, 35, MAIN, 50),
    ],
  };
}

function ok(result: unknown): ICmResult<unknown> {
  return { result, success: true };
}

function fail(message: string): ICmResult<unknown> {
  return { error: new Error(message), success: false };
}

function shortName(branch: string): string {
  return branch.substring(branch.lastIndexOf("/") + 1);
}

function findChangesets(repo: IFakeRepo, where: string): ICmResult<unknown> {
  const byId = /^where changesetid=(\d+)$/.exec(where);
  if (byId) {
    if (repo.failing.has("byid")) {
      return fail("Error: cannot query changeset");
    }
    const id = parseInt(byId[1], 10);
    return ok(repo.changesets.filter(cs => cs.id === id));
  }

  const paged = /^where branch='([^']+)'(?: and changesetid < (\d+))? order by changesetid desc limit (\d+)$/
    .exec(where);
  if (!paged) {
    return fail(`unexpected changeset query: ${where}`);
  }

  const [ , branch, before, limit ] = paged;
  if (repo.failing.has(`changeset:${branch}`)) {
    return fail(`Error: cannot query ${branch}`);
  }

  const rows = repo.changesets
    .filter(cs => cs.branch === branch && (!before || cs.id < parseInt(before, 10)))
    .sort((a, b) => b.id - a.id)
    .slice(0, parseInt(limit, 10));
  return ok(rows);
}

function findBranches(repo: IFakeRepo, where: string): ICmResult<unknown> {
  if (repo.failing.has("branch")) {
    return fail("Error: cannot query branches");
  }
  const match = /^where name='([^']+)'$/.exec(where);
  if (!match) {
    return fail(`unexpected branch query: ${where}`);
  }
  return ok(Array.from(repo.branches.values()).filter(branch => shortName(branch.name) === match[1]));
}

function findMerges(repo: IFakeRepo, where: string): ICmResult<unknown> {
  if (repo.failing.has("merge")) {
    return fail("Error: cannot query merges");
  }
  const match = /^where \(dstbranch='br:([^']+)' or srcbranch='br:\1'\) and dstchangeset >= (\d+)$/.exec(where);
  if (!match) {
    return fail(`unexpected merge query: ${where}`);
  }
  const branch = match[1];
  const from = parseInt(match[2], 10);
  return ok(repo.merges.filter(merge =>
    (merge.sourceBranch === branch || merge.destinationBranch === branch) && merge.destinationChangesetId >= from));
}

async function dispatch(repo: IFakeRepo, command: string, args: string[]): Promise<ICmResult<unknown>> {
  const call: ICall = { args, command };
  repo.calls.push(call);
  for (const pending of repo.holds) {
    if (pending.matches(call)) {
      await pending.released;
    }
  }

  if (command === "diff") {
    if (repo.failing.has("diff")) {
      return fail("Error: diff failed");
    }
    return ok(repo.files.get(parseInt(args[0].replace("cs:", ""), 10)) ?? []);
  }

  if (command !== "find") {
    return fail(`unexpected command: ${command}`);
  }

  switch (args[0]) {
  case "changeset":
    return findChangesets(repo, args[1]);
  case "branch":
    return findBranches(repo, args[1]);
  case "merge":
    return findMerges(repo, args[1]);
  default:
    return fail(`unexpected find: ${args[0]}`);
  }
}

function createShellMock(repo: IFakeRepo, startResult: boolean): IMock<ICmShell> {
  const mock = Mock.ofType<ICmShell>(undefined, MockBehavior.Strict);
  mock.setup(m => m.start()).returns(() => Promise.resolve(startResult));
  mock.setup(m => m.stop()).returns(() => Promise.resolve());
  mock.setup(m => {
    m.dispose();
  });
  mock
    .setup(m => m.exec(It.isAnyString(), It.is(() => true), It.is<ICmParser<unknown>>(() => true)))
    .returns((command: string, args: string[]) => dispatch(repo, command, args));
  return mock;
}

function createConfig(pageSize: number): IConfig {
  return {
    autorefresh: false,
    cmConfiguration: { cmPath: "cm", millisCommandTimeout: 1000, millisToStop: 100, millisToWaitUntilUp: 100 },
    consolidateUnrealOneFilePerActorChanges: false,
    enabled: true,
    history: { pageSize },
    ignoredDirectories: [],
  };
}

function createHarness(options: IHarnessOptions = {}): IHarness {
  const repo = createRepo();
  const ownShell = createShellMock(repo, options.startResult ?? true);
  const workspaceShell = createShellMock(repo, true);
  const statusEmitter = new EventEmitter<void>();
  const workspace: IFakeWorkspace = {
    currentChangeset: options.currentChangeset ?? 55,
    info: { id: "wk1", name: "Nimbus", path: "/wk/Nimbus" },
    onDidRunStatus: statusEmitter.event,
    shell: workspaceShell.object,
    workspaceConfig: {
      configType: options.configType ?? WkConfigType.Branch,
      location: options.location ?? X,
      repSpec: `${REPOSITORY}@${SERVER}`,
    },
  };
  const channel = { appendLine: (): void => undefined } as unknown as OutputChannel;
  const clock = { now: 1_000_000 };

  const history = new WorkspaceHistory(
    workspace as unknown as Workspace,
    channel,
    () => createConfig(options.pageSize ?? 50),
    () => ownShell.object,
    () => clock.now);

  let changeCount = 0;
  history.onDidChange(() => {
    changeCount += 1;
  });

  return {
    changes: () => changeCount,
    clock,
    history,
    ownShell,
    repo,
    statusEmitter,
    workspace,
    workspaceShell,
  };
}

function findCalls(repo: IFakeRepo, kind: string): ICall[] {
  return repo.calls.filter(call => call.command === "find" && call.args[0] === kind);
}

function diffCalls(repo: IFakeRepo, changesetId: number): ICall[] {
  return repo.calls.filter(call => call.command === "diff" && call.args[0] === `cs:${changesetId}`);
}

function isLaneQuery(call: ICall, branch: string): boolean {
  return call.command === "find" && call.args[0] === "changeset" && call.args[1].startsWith(`where branch='${branch}'`);
}

function hold(repo: IFakeRepo, matches: (call: ICall) => boolean): () => void {
  let release: () => void = () => undefined;
  const released = new Promise<void>(resolve => {
    release = resolve;
  });
  repo.holds.push({ matches, released });
  return release;
}

/** Lets every pending microtask run, so a held call is really parked before the test inspects state. */
function flush(): Promise<void> {
  return new Promise<void>(resolve => setImmediate(() => resolve()));
}

function rowIds(harness: IHarness): number[] {
  return harness.history.model!.rows.map(row => row.id);
}

describe("WorkspaceHistory", () => {
  context("Before the first load", () => {
    const harness = createHarness();

    it("is idle and stale", () => {
      expect(harness.history.status).to.equal("idle");
      expect(harness.history.isStale).to.be.true;
      expect(harness.history.model).to.be.undefined;
      expect(harness.history.currentBranch).to.be.undefined;
    });

    it("does not touch cm", () => {
      harness.ownShell.verify(m => m.start(), Times.never());
      expect(harness.repo.calls).to.be.empty;
    });
  });

  context("When the workspace is on a branch", () => {
    let harness: IHarness;

    before(async () => {
      harness = createHarness();
      await harness.history.load();
    });

    it("is ready with the branch and its parent as lanes", () => {
      expect(harness.history.status).to.equal("ready");
      expect(harness.history.message).to.be.undefined;
      expect(harness.history.currentBranch).to.equal(X);
      expect(harness.history.model!.lanes.map(lane => lane.branch)).to.eql([ X, MAIN ]);
      expect(harness.history.model!.lanes.map(lane => lane.kind)).to.eql([ "current", "parent" ]);
    });

    it("lists both lanes in one sequence, newest first, without paging", () => {
      expect(rowIds(harness)).to.eql([ 55, 50, 45, 40, 35, 30, 25, 20, 15, 10 ]);
      expect(harness.history.model!.lanes.map(lane => lane.hasMore)).to.eql([ false, false ]);
    });

    it("marks the workspace changeset", () => {
      expect(harness.history.model!.currentLoaded).to.be.true;
      expect(harness.history.model!.rows[0].isCurrent).to.be.true;
    });

    it("queries the branch with the configured page size", () => {
      expect(findCalls(harness.repo, "changeset")[0].args).to.eql([
        "changeset", `where branch='${X}' order by changesetid desc limit 50`, ...FIND_ARGS,
      ]);
    });

    it("looks the branch up by its short name before the rows", () => {
      const branchCall = findCalls(harness.repo, "branch")[0];
      expect(branchCall.args).to.eql([ "branch", "where name='X'", ...FIND_ARGS ]);
      expect(harness.repo.calls.indexOf(branchCall)).to.be.lessThan(
        harness.repo.calls.indexOf(findCalls(harness.repo, "changeset")[0]));
    });

    it("queries merges from the oldest loaded changeset", () => {
      expect(findCalls(harness.repo, "merge").map(call => call.args[1])).to.eql([
        `where (dstbranch='br:${X}' or srcbranch='br:${X}') and dstchangeset >= 10`,
      ]);
      expect(harness.history.model!.links.filter(link => link.kind === "merge")).to.have.length(2);
    });

    it("runs on its own shell", () => {
      harness.ownShell.verify(m => m.start(), Times.once());
      harness.workspaceShell.verify(
        m => m.exec(It.isAnyString(), It.is(() => true), It.is<ICmParser<unknown>>(() => true)),
        Times.never());
    });

    it("is no longer stale and reported progress", () => {
      expect(harness.history.isStale).to.be.false;
      // loading, lane 0, lane 1, merges, ready at the very least.
      expect(harness.changes()).to.be.at.least(4);
    });
  });

  context("When the workspace is on a changeset", () => {
    let harness: IHarness;

    before(async () => {
      harness = createHarness({ configType: WkConfigType.Changeset, currentChangeset: 45, location: "45" });
      await harness.history.load();
    });

    it("resolves the branch from the changeset", () => {
      expect(findCalls(harness.repo, "changeset")[0].args[1]).to.equal("where changesetid=45");
      expect(harness.history.currentBranch).to.equal(X);
      expect(harness.history.status).to.equal("ready");
    });

    it("marks that changeset as current", () => {
      expect(harness.history.model!.rows.find(row => row.isCurrent)?.id).to.equal(45);
    });
  });

  context("When the history is unsupported", () => {
    it("rejects a shelve without querying cm", async () => {
      const harness = createHarness({ configType: WkConfigType.Shelve, location: "12" });
      await harness.history.load();

      expect(harness.history.status).to.equal("unsupported");
      expect(harness.history.message).to.equal(
        "Switch the workspace to a branch or a changeset to see its history.");
      expect(harness.history.model).to.be.undefined;
      expect(harness.repo.calls).to.be.empty;
    });

    it("rejects a workspace without a changeset", async () => {
      const harness = createHarness({ currentChangeset: -1 });
      await harness.history.load();

      expect(harness.history.status).to.equal("unsupported");
    });

    it("rejects a changeset cm does not know", async () => {
      const harness = createHarness({ configType: WkConfigType.Changeset, currentChangeset: 2441, location: "2441" });
      await harness.history.load();

      expect(harness.history.status).to.equal("unsupported");
    });
  });

  context("When the parent branch lookup fails", () => {
    let harness: IHarness;

    before(async () => {
      harness = createHarness();
      harness.repo.failing.add("branch");
      await harness.history.load();
    });

    it("shows a single lane and stays ready", () => {
      expect(harness.history.status).to.equal("ready");
      expect(harness.history.model!.lanes).to.have.length(1);
      expect(rowIds(harness)).to.eql([ 55, 45, 35, 25, 15 ]);
    });

    it("does not query merges", () => {
      expect(findCalls(harness.repo, "merge")).to.be.empty;
    });
  });

  context("When the branch has no parent", () => {
    let harness: IHarness;

    before(async () => {
      harness = createHarness({ currentChangeset: 50, location: MAIN });
      await harness.history.load();
    });

    it("shows a single lane", () => {
      expect(harness.history.model!.lanes).to.have.length(1);
      expect(rowIds(harness)).to.eql([ 50, 40, 30, 20, 10 ]);
      expect(findCalls(harness.repo, "branch")[0].args[1]).to.equal("where name='main'");
    });

    it("knows the head is loaded", () => {
      expect(harness.history.model!.lanes[0].hasNewer).to.be.false;
    });
  });

  context("When the parent lane fails", () => {
    let harness: IHarness;

    before(async () => {
      harness = createHarness();
      harness.repo.failing.add(`changeset:${MAIN}`);
      await harness.history.load();
    });

    it("keeps the current lane and reports the error on the parent lane", () => {
      expect(harness.history.status).to.equal("ready");
      expect(harness.history.model!.lanes[0].count).to.equal(5);
      expect(harness.history.model!.lanes[1].count).to.equal(0);
      expect(harness.history.model!.lanes[1].error).to.equal(`cannot query ${MAIN}`);
      expect(harness.history.model!.lanes[1].loading).to.be.false;
    });
  });

  context("When the current lane fails", () => {
    it("reports the error", async () => {
      const harness = createHarness();
      harness.repo.failing.add(`changeset:${X}`);
      await harness.history.load();

      expect(harness.history.status).to.equal("error");
      expect(harness.history.message).to.equal(`cannot query ${X}`);
      expect(harness.history.model).to.be.undefined;
    });
  });

  context("When the current changeset is not on the first page", () => {
    function createDeepHarness(currentChangeset: number): IHarness {
      const harness = createHarness({ currentChangeset, pageSize: 2 });
      harness.repo.changesets = harness.repo.changesets.filter(cs => cs.branch === MAIN);
      for (let id = 1; id <= 12; id++) {
        harness.repo.changesets.push(changeset(id, X, id === 1 ? -1 : id - 1));
      }
      harness.repo.branches.set(X, branchInfo(X, 12, MAIN));
      return harness;
    }

    it("pages until the current changeset is loaded", async () => {
      const harness = createDeepHarness(7);
      await harness.history.load();

      const laneQueries = harness.repo.calls.filter(call => isLaneQuery(call, X));
      expect(laneQueries.map(call => call.args[1])).to.eql([
        `where branch='${X}' order by changesetid desc limit 2`,
        `where branch='${X}' and changesetid < 11 order by changesetid desc limit 2`,
        `where branch='${X}' and changesetid < 9 order by changesetid desc limit 2`,
      ]);
      expect(harness.history.model!.lanes[0].count).to.equal(6);
      expect(harness.history.model!.lanes[0].hasMore).to.be.true;
      expect(harness.history.model!.currentLoaded).to.be.true;
    });

    it("gives up after five pages", async () => {
      const harness = createDeepHarness(1);
      await harness.history.load();

      expect(harness.repo.calls.filter(call => isLaneQuery(call, X))).to.have.length(5);
      expect(harness.history.model!.lanes[0].count).to.equal(10);
      expect(harness.history.model!.lanes[0].hasMore).to.be.true;
      expect(harness.history.model!.currentLoaded).to.be.false;
      expect(harness.history.status).to.equal("ready");
    });

    it("does not dig deeper on every reload when the changeset stays out of reach", async () => {
      const harness = createDeepHarness(1);
      await harness.history.load();
      const afterFirst = harness.history.model!.lanes[0].count;

      await harness.history.load(true);
      const afterSecond = harness.history.model!.lanes[0].count;
      await harness.history.load(true);

      // The reload asks for the rows it already had; counting pages from there
      // would add five more each time until the branch ran out.
      expect(afterSecond).to.equal(afterFirst);
      expect(harness.history.model!.lanes[0].count).to.equal(afterFirst);
    });

    it("does not page when the current changeset cannot be older than the loaded rows", async () => {
      const harness = createDeepHarness(2080);
      await harness.history.load();

      expect(harness.repo.calls.filter(call => isLaneQuery(call, X))).to.have.length(1);
    });
  });

  context("When loading more", () => {
    let harness: IHarness;
    let countsAfterFirstPage: number[];
    let hasMoreAfterFirstPage: boolean[];

    before(async () => {
      harness = createHarness({ pageSize: 2 });
      await harness.history.load();
      countsAfterFirstPage = harness.history.model!.lanes.map(lane => lane.count);
      hasMoreAfterFirstPage = harness.history.model!.lanes.map(lane => lane.hasMore);
      await harness.history.loadMore(X);
    });

    it("started with one page per lane", () => {
      expect(countsAfterFirstPage).to.eql([ 2, 2 ]);
      expect(hasMoreAfterFirstPage).to.eql([ true, true ]);
    });

    it("appends the next page below the oldest loaded changeset", () => {
      const moreQuery = harness.repo.calls.filter(call => isLaneQuery(call, X))[1];
      expect(moreQuery.args[1]).to.equal(`where branch='${X}' and changesetid < 45 order by changesetid desc limit 2`);
      // /main has pages left below 40, so X's 35 and 25 are held back until it
      // is loaded that far; /main is now the lane to page.
      expect(rowIds(harness)).to.eql([ 55, 50, 45, 40 ]);
      expect(harness.history.model!.lanes[0]).to.include({ count: 4, hidden: 2 });
      expect(harness.history.model!.loadMoreBranch).to.equal(MAIN);
      expect(harness.history.model!.lanes[0].hasMore).to.be.true;
      expect(harness.history.model!.lanes[0].loading).to.be.false;
      expect(harness.history.status).to.equal("ready");
    });

    it("re-queries the merges from the new oldest changeset", () => {
      const mergeQueries = findCalls(harness.repo, "merge").map(call => call.args[1]);
      expect(mergeQueries).to.have.length(2);
      expect(mergeQueries[1]).to.match(/dstchangeset >= 25$/);
    });

    it("clears hasMore on a short page and then ignores further requests", async () => {
      await harness.history.loadMore(X);
      expect(rowIds(harness)).to.eql([ 55, 50, 45, 40 ]);
      expect(harness.history.model!.lanes[0]).to.include({ count: 5, hidden: 3 });
      expect(harness.history.model!.lanes[0].hasMore).to.be.false;

      const callCount = harness.repo.calls.length;
      await harness.history.loadMore(X);
      expect(harness.repo.calls).to.have.length(callCount);
    });

    it("ignores unknown branches", async () => {
      const callCount = harness.repo.calls.length;
      await harness.history.loadMore("/main/other");
      expect(harness.repo.calls).to.have.length(callCount);
    });

    it("releases the held-back rows as the parent lane catches up", async () => {
      await harness.history.loadMore(MAIN);
      expect(rowIds(harness)).to.eql([ 55, 50, 45, 40, 35, 30, 25, 20 ]);
      expect(harness.history.model!.lanes[0]).to.include({ count: 5, hidden: 1 });
    });

    it("reports a failed page on the lane and keeps the rows", async () => {
      harness.repo.failing.add(`changeset:${MAIN}`);
      await harness.history.loadMore(MAIN);
      harness.repo.failing.delete(`changeset:${MAIN}`);

      expect(harness.history.model!.lanes[1].error).to.equal(`cannot query ${MAIN}`);
      expect(harness.history.model!.lanes[1].count).to.equal(4);
      expect(harness.history.model!.lanes[1].hasMore).to.be.true;
      expect(harness.history.status).to.equal("ready");
    });
  });

  context("When fetching the files of a changeset", () => {
    let harness: IHarness;

    before(async () => {
      harness = createHarness();
      harness.repo.files.set(45, [fileChange("/Assets/a.cs")]);
      harness.repo.files.set(46, [fileChange("/Assets/b.cs")]);
      await harness.history.load();
    });

    it("runs cm diff once and caches the promise", async () => {
      const first = harness.history.getFiles(45);
      const second = harness.history.getFiles(45);
      expect(first).to.equal(second);

      const files = await first;
      expect(files.map(file => file.path)).to.eql(["/Assets/a.cs"]);
      expect(diffCalls(harness.repo, 45)).to.have.length(1);
      expect(diffCalls(harness.repo, 45)[0].args[2]).to.equal("--repositorypaths");
    });

    it("forgets a rejected query so the next call retries", async () => {
      harness.repo.failing.add("diff");
      let error: unknown;
      try {
        await harness.history.getFiles(46);
      } catch (e) {
        error = e;
      }
      harness.repo.failing.delete("diff");
      expect(error).to.be.instanceOf(Error);

      const files = await harness.history.getFiles(46);
      expect(files.map(file => file.path)).to.eql(["/Assets/b.cs"]);
      expect(diffCalls(harness.repo, 46)).to.have.length(2);
    });

    it("keeps the cache across a plain reload and drops it on load(true)", async () => {
      await harness.history.load();
      await harness.history.getFiles(45);
      expect(diffCalls(harness.repo, 45)).to.have.length(1);

      await harness.history.load(true);
      await harness.history.getFiles(45);
      expect(diffCalls(harness.repo, 45)).to.have.length(2);
    });

    it("works before the first load", async () => {
      const fresh = createHarness();
      fresh.repo.files.set(45, [fileChange("/Assets/a.cs")]);

      const files = await fresh.history.getFiles(45);
      expect(files).to.have.length(1);
      fresh.ownShell.verify(m => m.start(), Times.once());
    });
  });

  context("When looking a changeset up", () => {
    let harness: IHarness;

    before(async () => {
      harness = createHarness({ pageSize: 2 });
      await harness.history.load();
    });

    it("returns a loaded row without asking cm", async () => {
      const result = await harness.history.getChangeset(45);
      expect(result?.id).to.equal(45);
      expect(findCalls(harness.repo, "changeset").some(call => call.args[1].startsWith("where changesetid=")))
        .to.be.false;
    });

    it("asks cm for a changeset that is not loaded", async () => {
      const result = await harness.history.getChangeset(15);
      expect(result?.branch).to.equal(X);
      expect(findCalls(harness.repo, "changeset").map(call => call.args[1])).to.include("where changesetid=15");
    });

    it("returns undefined for an unknown changeset", async () => {
      expect(await harness.history.getChangeset(2441)).to.be.undefined;
    });
  });

  context("When reloading", () => {
    let harness: IHarness;
    let statusWhileLoading: string;
    let rowsWhileLoading: number[];

    before(async () => {
      harness = createHarness({ pageSize: 2 });
      await harness.history.load();
      await harness.history.loadMore(X);

      const release = hold(harness.repo, call => isLaneQuery(call, X));
      const reload = harness.history.load();
      await flush();
      statusWhileLoading = harness.history.status;
      rowsWhileLoading = rowIds(harness);
      release();
      await reload;
    });

    it("keeps the previous model until the first lane arrives", () => {
      expect(statusWhileLoading).to.equal("loading");
      expect(rowsWhileLoading).to.eql([ 55, 50, 45, 40 ]);
    });

    it("reloads each lane as deep as it was", () => {
      const laneQueries = harness.repo.calls.filter(call => isLaneQuery(call, X)).map(call => call.args[1]);
      expect(laneQueries[laneQueries.length - 1]).to.equal(`where branch='${X}' order by changesetid desc limit 4`);
      expect(harness.history.model!.lanes.map(lane => lane.count)).to.eql([ 4, 2 ]);
      expect(rowIds(harness)).to.eql([ 55, 50, 45, 40 ]);
      expect(harness.history.status).to.equal("ready");
    });

    it("coalesces a load requested while one is running into a single extra pass", async () => {
      const fresh = createHarness();
      const release = hold(fresh.repo, call => isLaneQuery(call, X));

      const first = fresh.history.load();
      const second = fresh.history.load();
      const third = fresh.history.load();
      expect(second).to.equal(first);
      expect(third).to.equal(first);

      release();
      await first;
      expect(fresh.repo.calls.filter(call => isLaneQuery(call, X))).to.have.length(2);
      expect(fresh.history.status).to.equal("ready");
    });

    it("clears the model when the branch changed", async () => {
      const fresh = createHarness();
      await fresh.history.load();

      fresh.workspace.workspaceConfig = { ...fresh.workspace.workspaceConfig!, location: MAIN };
      fresh.workspace.currentChangeset = 50;
      const release = hold(fresh.repo, call => isLaneQuery(call, MAIN));
      const reload = fresh.history.load();
      await flush();
      const modelWhileLoading = fresh.history.model;
      release();
      await reload;

      expect(modelWhileLoading).to.be.undefined;
      expect(fresh.history.currentBranch).to.equal(MAIN);
      expect(rowIds(fresh)).to.eql([ 50, 40, 30, 20, 10 ]);
    });
  });

  context("When a load supersedes a page in flight", () => {
    it("discards the stale page", async () => {
      const harness = createHarness({ pageSize: 2 });
      await harness.history.load();

      const release = hold(harness.repo, call => isLaneQuery(call, X) && call.args[1].includes("changesetid <"));
      const more = harness.history.loadMore(X);
      await flush();
      expect(harness.history.model!.lanes[0].loading).to.be.true;

      await harness.history.load();
      expect(harness.history.model!.lanes[0].loading).to.be.false;
      expect(harness.history.model!.lanes[0].count).to.equal(2);

      release();
      await more;
      // /main's 40 is held back behind X's oldest loaded 45 until X pages further.
      expect(rowIds(harness)).to.eql([ 55, 50, 45 ]);
      expect(harness.history.model!.lanes[0].hasMore).to.be.true;
    });

    it("does not load more while a load is running", async () => {
      const harness = createHarness({ pageSize: 2 });
      await harness.history.load();

      const release = hold(harness.repo, call => isLaneQuery(call, X));
      const reload = harness.history.load();
      await flush();
      const callCount = harness.repo.calls.length;
      await harness.history.loadMore(X);
      expect(harness.repo.calls).to.have.length(callCount);

      release();
      await reload;
    });
  });

  context("When the workspace status runs", () => {
    let harness: IHarness;

    before(async () => {
      harness = createHarness();
      await harness.history.load();
    });

    it("stays fresh while the workspace did not move", () => {
      const changes = harness.changes();
      harness.statusEmitter.fire();
      expect(harness.history.isStale).to.be.false;
      expect(harness.changes()).to.equal(changes);
    });

    it("becomes stale when the changeset moved", () => {
      const changes = harness.changes();
      harness.workspace.currentChangeset = 99;
      harness.statusEmitter.fire();
      expect(harness.history.isStale).to.be.true;
      expect(harness.changes()).to.equal(changes + 1);
      expect(harness.history.status).to.equal("ready");
    });

    it("is fresh again after a load", async () => {
      await harness.history.load();
      expect(harness.history.isStale).to.be.false;
    });

    it("becomes stale when the branch moved", () => {
      harness.workspace.workspaceConfig = { ...harness.workspace.workspaceConfig!, location: MAIN };
      harness.statusEmitter.fire();
      expect(harness.history.isStale).to.be.true;
    });
  });

  context("When checking for newer changesets", () => {
    let harness: IHarness;
    let branchCallsAfterLoad: number;

    before(async () => {
      harness = createHarness();
      await harness.history.load();
      branchCallsAfterLoad = findCalls(harness.repo, "branch").length;
    });

    it("starts without newer changesets", () => {
      expect(harness.history.model!.lanes.map(lane => lane.hasNewer)).to.eql([ false, false ]);
    });

    it("asks cm for each lane's head and flags the lane", async () => {
      harness.repo.branches.set(X, branchInfo(X, 77, MAIN));
      const changes = harness.changes();
      await harness.history.checkForNewer();

      expect(findCalls(harness.repo, "branch")).to.have.length(branchCallsAfterLoad + 2);
      expect(harness.history.model!.lanes.map(lane => lane.hasNewer)).to.eql([ true, false ]);
      expect(harness.changes()).to.equal(changes + 1);
    });

    it("skips a check within a minute of the previous one", async () => {
      harness.repo.branches.set(MAIN, branchInfo(MAIN, 88));
      harness.clock.now += 30 * 1000;
      await harness.history.checkForNewer();

      expect(findCalls(harness.repo, "branch")).to.have.length(branchCallsAfterLoad + 2);
      expect(harness.history.model!.lanes[1].hasNewer).to.be.false;
    });

    it("checks again once a minute passed", async () => {
      harness.clock.now += 31 * 1000;
      await harness.history.checkForNewer();

      expect(findCalls(harness.repo, "branch")).to.have.length(branchCallsAfterLoad + 4);
      expect(harness.history.model!.lanes.map(lane => lane.hasNewer)).to.eql([ true, true ]);
    });

    it("does nothing while a load is running", async () => {
      const release = hold(harness.repo, call => isLaneQuery(call, X));
      const reload = harness.history.load();
      await flush();
      const branchCalls = findCalls(harness.repo, "branch").length;

      harness.clock.now += 120 * 1000;
      await harness.history.checkForNewer();
      expect(findCalls(harness.repo, "branch")).to.have.length(branchCalls);

      release();
      await reload;
    });

    it("does nothing before the first load", async () => {
      const fresh = createHarness();
      await fresh.history.checkForNewer();
      expect(fresh.repo.calls).to.be.empty;
    });
  });

  context("When the history shell fails to start", () => {
    let harness: IHarness;

    before(async () => {
      harness = createHarness({ startResult: false });
      await harness.history.load();
    });

    it("falls back to the workspace shell", () => {
      expect(harness.history.status).to.equal("ready");
      harness.workspaceShell.verify(
        m => m.exec(It.isAnyString(), It.is(() => true), It.is<ICmParser<unknown>>(() => true)),
        Times.atLeastOnce());
      harness.ownShell.verify(
        m => m.exec(It.isAnyString(), It.is(() => true), It.is<ICmParser<unknown>>(() => true)),
        Times.never());
    });

    it("disposes the shell that failed without stopping it", () => {
      harness.ownShell.verify(m => {
        m.dispose();
      }, Times.once());
      harness.ownShell.verify(m => m.stop(), Times.never());
    });

    it("leaves the workspace shell running on dispose", async () => {
      harness.history.dispose();
      await flush();
      harness.workspaceShell.verify(m => m.stop(), Times.never());
      harness.workspaceShell.verify(m => {
        m.dispose();
      }, Times.never());
    });
  });

  context("When disposed", () => {
    it("stops and then disposes its shell", async () => {
      const harness = createHarness();
      await harness.history.load();

      harness.history.dispose();
      harness.ownShell.verify(m => m.stop(), Times.once());
      await flush();
      harness.ownShell.verify(m => {
        m.dispose();
      }, Times.once());
    });

    it("drops results that arrive afterwards", async () => {
      const harness = createHarness();
      const release = hold(harness.repo, call => isLaneQuery(call, X));
      const load = harness.history.load();
      await flush();

      harness.history.dispose();
      release();
      await load;

      expect(harness.history.status).to.equal("loading");
      expect(harness.history.model).to.be.undefined;
    });

    it("does nothing when it never started a shell", () => {
      const harness = createHarness();
      harness.history.dispose();
      harness.ownShell.verify(m => m.stop(), Times.never());
    });
  });
});
