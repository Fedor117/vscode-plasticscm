import {
  BRANCH_ID,
  BRANCH_NAME,
  BRANCH_REVIEW_ID,
  branchRowXml,
  CHANGESET_REVIEW_ID,
  EMPTY_QUERY,
  HEAD,
  ME,
  PLAIN_ROW_COUNT,
  REPOSITORY,
  ReviewShell,
  reviewsXml,
  scenarioAnswer,
  WORKSPACE_ROOT,
} from "./fixtures";
import {
  errorText,
  IReviewSessionUi,
  IReviewWorkspace,
  LAST_REVIEW_KEY,
  ReviewSession,
} from "../../../reviews/reviewSession";
import { IReviewChangesets, scopeRows, viewableRows } from "../../../reviews/models";
import {
  IReviewEditorContext,
  overviewViewId,
  ReviewEditors,
  reviewOverviewUri,
} from "../../../reviews/reviewEditors";
import { NOW, review as reviewRow } from "./viewFixtures";
import { OutputChannel, TabInputText, TabInputTextDiff, window } from "vscode";
import { ReviewListProvider, reviewListViewId } from "../../../reviews/reviewListProvider";
import { discussionsViewId } from "../../../reviews/discussionsProvider";
import { expect } from "chai";
import { IActiveReview } from "../../../reviews/sessionTypes";
import { IReviewLink } from "../../../reviews/reviewLinks";
import { IViewedMemento } from "../../../reviews/viewedStore";
import { ReviewService } from "../../../reviews/reviewService";
import { reviewTreeViewId } from "../../../reviews/reviewTreeProvider";
import { until } from "./editorFixtures";
import { visible } from "./overviewFixtures";

const CONFIG = { cmPath: "cm", millisCommandTimeout: 1000, millisToStop: 1000, millisToWaitUntilUp: 1000 };
const WORKSPACES: IReviewWorkspace[] = [
  { id: "wk", name: "Nimbus", path: WORKSPACE_ROOT, repository: REPOSITORY },
  { id: "wk2", name: "Tools", path: "/Users/dev/Tools", repository: "Tools@acme-studio@unity" },
];
const PERSONAL_KEYS = [ "needsMyReview", "reworkRequested", "waitingForReviewers" ] as const;

interface IMemento extends IViewedMemento {
  values: Map<string, unknown>;
}

function memento(): IMemento {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: (key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    },
    values,
  };
}

interface IHarness {
  session: ReviewSession;
  shell: ReviewShell;
  ui: {
    confirms: Array<{ message: string; detail: string }>;
    errors: string[];
    statuses: string[];
    progress: string[];
    answer: boolean;
  };
  workspaceState: IMemento;
  globalState: IMemento;
}

let channel: OutputChannel | undefined;

function harness(options: {
  answer?: (command: string, args: string[]) => string | Promise<string>;
  editors?: ReviewEditors;
  overviewLink?: (link: IReviewLink) => string;
  workspaces?: IReviewWorkspace[];
  workspaceState?: IMemento;
  globalState?: IMemento;
  now?: () => number;
} = {}): IHarness {
  channel = channel ?? window.createOutputChannel("Review session tests");
  const shell = new ReviewShell();
  shell.answer = options.answer ?? scenarioAnswer;
  const log: IHarness["ui"] = { answer: false, confirms: [], errors: [], progress: [], statuses: [] };
  const ui: Partial<IReviewSessionUi> = {
    confirm: (message, detail) => {
      log.confirms.push({ detail, message });
      return Promise.resolve(log.answer);
    },
    error: message => {
      log.errors.push(message);
    },
    progress: (viewId, task) => {
      log.progress.push(viewId);
      return task();
    },
    status: message => {
      log.statuses.push(message);
    },
  };
  const workspaceState = options.workspaceState ?? memento();
  const globalState = options.globalState ?? memento();
  const out = channel;
  const session = new ReviewSession({
    channel: out,
    createService: wk => new ReviewService(wk.id, wk.path, out, CONFIG, shell),
    editors: options.editors,
    fileLayout: () => "tree",
    globalState,
    now: options.now ?? (() => NOW),
    overviewLink: options.overviewLink,
    pollInterval: 60 * 60 * 1000,
    shellConfig: () => CONFIG,
    ui,
    workspaceState,
    workspaces: () => options.workspaces ?? WORKSPACES.slice(0, 1),
  });
  return { globalState, session, shell, ui: log, workspaceState };
}

/** ReviewEditors whose `open` and `openComment` only count; `setContext` still runs for real. */
function spyEditors(resolve: () => ReviewSession): { editors: ReviewEditors; opened: string[]; contexts: number } {
  const editors = new ReviewEditors({ resolveService: id => resolve().service(id) });
  const spy = { contexts: 0, editors, opened: [] as string[] };
  editors.open = (_context, _comparison, file) => {
    spy.opened.push(`open ${file.path}`);
    return Promise.resolve();
  };
  editors.openComment = (_context, thread) => {
    spy.opened.push(`openComment ${thread.id}`);
    return Promise.resolve();
  };
  const setContext = editors.setContext.bind(editors);
  editors.setContext = (context: IReviewEditorContext | undefined) => {
    spy.contexts++;
    setContext(context);
  };
  return spy;
}

function reviewTabs(): number {
  let count = 0;
  window.tabGroups.all.forEach(group => group.tabs.forEach(tab => {
    const input = tab.input;
    const uris = input instanceof TabInputTextDiff ? [ input.original, input.modified ]
      : input instanceof TabInputText ? [input.uri] : [];
    count += uris.filter(uri => uri.scheme === "plastic-review").length;
  }));
  return count;
}

function ready<T>(stage: { state: string; value?: T }): T {
  expect(stage.state).to.equal("ready");
  return (stage as { value: T }).value;
}

/** Answers like the scenario, but the review reads back as `status` once a status was written. */
function statusAnswer(fail?: string): (command: string, args: string[]) => string {
  let written: string | undefined;
  return (command, args) => {
    if (command === "codereview") {
      if (fail) {
        throw new Error(fail);
      }
      written = /--status=(.+)$/.exec(args[2])?.[1];
      return "";
    }
    if (written && args[0] === "review" && args[1].includes(`id = ${BRANCH_REVIEW_ID}`)) {
      const title = "Lap Timer Accuracy";
      return reviewsXml([{ assignee: ME, id: BRANCH_REVIEW_ID, status: written, title }]);
    }
    return scenarioAnswer(command, args);
  };
}

describe("Review session", () => {
  const sessions: ReviewSession[] = [];
  const editorsToDispose: ReviewEditors[] = [];
  const track = (value: IHarness): IHarness => {
    sessions.push(value.session);
    return value;
  };
  afterEach(() => {
    sessions.splice(0).forEach(session => session.dispose());
    editorsToDispose.splice(0).forEach(editors => editors.dispose());
  });

  it("loads the stages in order and never opens an editor on activate, restore, refresh or poll", async () => {
    let session: ReviewSession | undefined;
    const spy = spyEditors(() => session!);
    editorsToDispose.push(spy.editors);
    const tabsBefore = reviewTabs();
    const test = track(harness({ editors: spy.editors }));
    session = test.session;
    const order: string[] = [];
    session.onDidChangeActive(() => {
      const active = session!.active;
      if (active) {
        const states = `${active.files.state}/${active.discussions.state}/${active.changesets.state}`;
        if (order[order.length - 1] !== states) {
          order.push(states);
        }
      }
    });

    await session.activate("wk", BRANCH_REVIEW_ID);
    expect(order[0]).to.equal("loading/idle/idle");
    expect(order).to.include.members([ "ready/loading/idle", "ready/ready/loading", "ready/ready/ready" ]);
    expect(order.indexOf("ready/loading/idle")).to.be.lessThan(order.indexOf("ready/ready/loading"));
    const active = session.active!;
    expect(ready(active.files).final.files).to.have.length(PLAIN_ROW_COUNT);
    expect(ready(active.discussions).threads.length).to.be.greaterThan(0);
    expect(ready(active.changesets).items.map(item => item.id)).to.deep.equal([ 3715, 3699, 3477 ]);
    expect(test.workspaceState.values.get(LAST_REVIEW_KEY)).to.deep.equal({ wk: BRANCH_REVIEW_ID });
    // The editors follow the stages: the last context carries the files and the threads.
    const context = session.editorContext()!;
    expect(context.files).to.equal(ready(active.files));
    expect(context.threads).to.equal(ready(active.discussions).threads);

    await session.reload();
    expect(session.active!.review.id).to.equal(BRANCH_REVIEW_ID);
    session.setViewVisible(reviewListViewId, true);
    session.setViewVisible(reviewTreeViewId, true);
    await session.refreshList();
    await session.poll();

    // A new window: the review comes back from workspaceState, still without an editor.
    const restored = track(harness({ editors: spy.editors, workspaceState: test.workspaceState }));
    session = restored.session;
    await session.restore();
    expect(session.active?.review.id).to.equal(BRANCH_REVIEW_ID);
    expect(session.active?.files.state).to.equal("ready");
    await session.restore();

    expect(spy.opened).to.deep.equal([]);
    expect(spy.contexts).to.be.greaterThan(3);
    expect(reviewTabs()).to.equal(tabsBefore);
  });

  it("ignores the results of an activation that a newer one superseded", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const test = track(harness({
      answer: async (command, args) => {
        if (command === "diff" && args[0].startsWith("br:") && !args.includes("--clean")) {
          await gate;
        }
        return scenarioAnswer(command, args);
      },
    }));
    const session = test.session;
    const first = session.activate("wk", BRANCH_REVIEW_ID);
    await until(() => test.shell.calls.some(call => call.command === "diff"));
    await session.activate("wk", CHANGESET_REVIEW_ID);
    expect(session.active!.review.id).to.equal(CHANGESET_REVIEW_ID);
    const changesetFiles = ready(session.active!.files);
    release();
    await first;
    expect(session.active!.review.id).to.equal(CHANGESET_REVIEW_ID);
    expect(session.active!.files).to.deep.equal({ state: "ready", value: changesetFiles });
    expect(ready(session.active!.files).final.files.map(file => file.path))
      .to.have.members([ "/Jenkinsfile_test_generator", "/artifacts" ]);
    // The superseded load stopped at the diff: no discussions or changesets were read for it.
    const afterDiff = test.shell.calls.slice(test.shell.calls.findIndex(call =>
      call.command === "diff" && call.args[0].startsWith("br:")) + 1);
    expect(afterDiff.some(call => call.command === "find" && call.args[1] === `where reviewid = ${BRANCH_REVIEW_ID}`))
      .to.equal(false);
  });

  it("finishes loading the open review when Open by ID names a review that does not exist", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const test = track(harness({
      answer: async (command, args) => {
        if (command === "diff" && args[0].startsWith("br:") && !args.includes("--clean")) {
          await gate;
        }
        return scenarioAnswer(command, args);
      },
    }));
    const session = test.session;
    const first = session.activate("wk", BRANCH_REVIEW_ID);
    await until(() => test.shell.calls.some(call => call.command === "diff"));
    const missing = await session.activate("wk", 6251).then(() => "no error", (error: Error) => error.message);
    expect(missing).to.equal("Review #6251 was not found in Nimbus.");
    expect(session.active!.review.id).to.equal(BRANCH_REVIEW_ID);
    release();
    await first;
    // The first load was superseded by the failed lookup; its stages load again instead of spinning forever.
    await until(() => session.active!.changesets.state === "ready");
    expect(ready(session.active!.files).final.files).to.have.length(PLAIN_ROW_COUNT);
    expect(session.active!.discussions.state).to.equal("ready");
  });

  it("keeps the status and reports the error when the status write fails", async () => {
    const test = track(harness({ answer: statusAnswer("Error: You are not allowed to change the status") }));
    const session = test.session;
    await session.activate("wk", BRANCH_REVIEW_ID);
    const before: IActiveReview = session.active!;
    const result = await session.setStatus("wk", before.review, "Rework required");
    expect(result).to.equal(undefined);
    expect(session.active!.review.status).to.equal("Under review");
    expect(test.ui.errors).to.deep.equal([
      "Couldn't set review #12831 to Rework required: You are not allowed to change the status",
    ]);
    expect(test.ui.statuses).to.deep.equal([]);
    expect(test.ui.confirms).to.deep.equal([]);
  });

  it("asks before marking Reviewed with pending change requests and unviewed files, and cancelling writes nothing",
    async () => {
      const test = track(harness({ answer: statusAnswer() }));
      const session = test.session;
      await session.activate("wk", BRANCH_REVIEW_ID);
      const review = session.active!.review;

      expect(await session.setStatus("wk", review, "Reviewed")).to.equal(undefined);
      expect(test.ui.confirms).to.deep.equal([{
        detail: "1 change request is still pending. 5 of 5 files are not viewed.",
        message: "Mark review #12831 as Reviewed?",
      }]);
      expect(test.shell.calls.filter(call => call.command === "codereview")).to.deep.equal([]);
      expect(session.active!.review.status).to.equal("Under review");

      test.ui.answer = true;
      const fresh = await session.setStatus("wk", review, "Reviewed");
      expect(fresh?.status).to.equal("Reviewed");
      expect(test.shell.calls.filter(call => call.command === "codereview").map(call => call.args))
        .to.deep.equal([[ "-e", String(BRANCH_REVIEW_ID), "--status=Reviewed" ]]);
      expect(session.active!.review.status).to.equal("Reviewed");
      expect(test.ui.statuses).to.deep.equal(["$(pass) Review #12831 marked Reviewed"]);
    });

  it("marks Reviewed without asking once every file is viewed and nothing is pending", async () => {
    const status = statusAnswer();
    const test = track(harness({
      answer: (command, args) => command === "find" && args[0] === "changereviewcomment" && args[1].includes("reviewid")
        ? EMPTY_QUERY
        : status(command, args),
    }));
    const session = test.session;
    await session.activate("wk", BRANCH_REVIEW_ID);
    session.setViewed(ready(session.active!.files).final.files, true);
    await session.setStatus("wk", session.active!.review, "Reviewed");
    expect(test.ui.confirms).to.deep.equal([]);
    expect(test.shell.calls.filter(call => call.command === "codereview")).to.have.length(1);
  });

  it("counts the unviewed files with the right verb, and ignores a status that differs only in case", async () => {
    const test = track(harness({ answer: statusAnswer() }));
    const session = test.session;
    await session.activate("wk", BRANCH_REVIEW_ID);
    const changes = viewableRows(scopeRows(ready(session.active!.files), "changes"));
    session.setViewed(changes.slice(1), true);
    await session.setStatus("wk", session.active!.review, "Reviewed");
    expect(test.ui.confirms.map(confirm => confirm.detail))
      .to.deep.equal(["1 change request is still pending. 1 of 5 files is not viewed."]);
    expect(await session.setStatus("wk", { ...session.active!.review, status: "under review" }, "Under review"))
      .to.equal(undefined);
    expect(test.ui.confirms).to.have.length(1);
    expect(test.shell.calls.filter(call => call.command === "codereview")).to.deep.equal([]);
  });

  it("asks before marking a review that is not open Reviewed, and says what it cannot count", async () => {
    let comments = true;
    const status = statusAnswer();
    const test = track(harness({
      answer: (command, args) => {
        if (!comments && command === "find" && args[0] === "changereviewcomment") {
          throw new Error("Error: The server is unreachable");
        }
        return status(command, args);
      },
    }));
    const session = test.session;
    const row = reviewRow({ id: BRANCH_REVIEW_ID });
    expect(await session.setStatus("wk", row, "Reviewed")).to.equal(undefined);
    comments = false;
    expect(await session.setStatus("wk", row, "Reviewed")).to.equal(undefined);
    expect(test.ui.confirms.map(confirm => confirm.detail)).to.deep.equal([
      "1 change request is still pending. It is not the open review, so unviewed files are unknown.",
      "Its discussions could not be read, so pending change requests are unknown. " +
      "It is not the open review, so unviewed files are unknown.",
    ]);
    expect(test.shell.calls.filter(call => call.command === "codereview")).to.deep.equal([]);
  });

  it("asks while the open review's files are still loading, since unviewed files are unknown", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const test = track(harness({
      answer: async (command, args) => {
        if (command === "diff" && args[0].startsWith("br:") && !args.includes("--clean")) {
          await gate;
        }
        return scenarioAnswer(command, args);
      },
    }));
    const session = test.session;
    const loading = session.activate("wk", BRANCH_REVIEW_ID);
    await until(() => test.shell.calls.some(call => call.command === "diff"));
    await session.setStatus("wk", session.active!.review, "Reviewed");
    expect(test.ui.confirms.map(confirm => confirm.detail)).to.deep.equal([
      "1 change request is still pending. Its files have not loaded yet, so unviewed files are unknown.",
    ]);
    release();
    await loading;
  });

  it("loads more changesets under the Review view's progress bar, once however often it is asked", async () => {
    const test = track(harness());
    const session = test.session;
    await session.activate("wk", BRANCH_REVIEW_ID);
    const shown = ready(session.active!.changesets);
    shown.hasMore = true;
    let release!: (value: IReviewChangesets) => void;
    let calls = 0;
    session.service("wk")!.moreChangesets = () => {
      calls++;
      return new Promise<IReviewChangesets>(resolve => {
        release = resolve;
      });
    };
    let fired = 0;
    session.onDidChangeActive(() => fired++);
    test.ui.progress.length = 0;
    const first = session.loadMoreChangesets();
    expect(session.loadingMoreChangesets).to.equal(true);
    expect(fired).to.equal(1);
    await session.loadMoreChangesets();
    expect(calls).to.equal(1);
    expect(test.ui.progress).to.deep.equal([reviewTreeViewId]);
    const more: IReviewChangesets = { hasMore: false, items: shown.items.slice() };
    release(more);
    await first;
    expect(session.loadingMoreChangesets).to.equal(false);
    expect(ready(session.active!.changesets)).to.equal(more);
  });

  it("skips polls while a user operation runs, and reports changes as updates afterwards", async () => {
    let comments = scenarioAnswer("find", [ "changereviewcomment", `where reviewid = ${BRANCH_REVIEW_ID}` ]);
    const test = track(harness({
      answer: (command, args) => command === "find" && args[0] === "changereviewcomment" && args[1].includes("reviewid")
        ? comments
        : scenarioAnswer(command, args),
    }));
    const session = test.session;
    await session.activate("wk", BRANCH_REVIEW_ID);
    session.expandGroup("needsMyReview");
    await until(() => session.group("needsMyReview").loadedOnce);
    session.setViewVisible(reviewListViewId, true);
    session.setViewVisible(discussionsViewId, true);

    let release!: () => void;
    const operation = session.track(() => new Promise<void>(resolve => {
      release = resolve;
    }));
    const calls = test.shell.calls.length;
    await session.poll();
    expect(test.shell.calls.length).to.equal(calls);
    release();
    await operation;

    comments = comments.replace("Appreciate the quick look!", "Appreciate the very quick look!");
    await session.poll();
    expect(test.shell.calls.length).to.be.greaterThan(calls);
    expect(session.active!.updates).to.deep.equal({ newComments: 1, removedComments: 0 });
    // The pinned stages did not change; Load Updates reloads them and clears the row.
    await session.reload();
    expect(session.active!.updates).to.equal(undefined);
  });

  it("loads the personal groups with one query per part however often the view asks", async () => {
    const test = track(harness());
    const session = test.session;
    const provider = new ReviewListProvider(session);
    try {
      provider.getChildren();
      provider.getChildren();
      session.expandGroup("reworkRequested");
      await until(() => session.group("needsMyReview").loadedOnce && session.group("reworkRequested").loadedOnce);
      expect(test.shell.queries("review").filter(where => where.includes("assignee = 'me'"))).to.have.length(1);
      expect(test.shell.queries("review").filter(where => where.includes("owner = 'me'"))).to.have.length(1);
      expect(session.group("needsMyReview").reviews.map(review => review.id)).to.deep.equal([BRANCH_REVIEW_ID]);
      expect(test.shell.queries("review").some(where => where.includes("offset"))).to.equal(false);
    } finally {
      provider.dispose();
    }
  });

  it("keeps Needs My Review when the query for your own reviews fails, and retries that part", async () => {
    let fail = true;
    const test = track(harness({
      answer: (command, args) => {
        if (fail && args[0] === "review" && args[1].includes("owner = 'me'")) {
          throw new Error("Error: Connection to the server was lost");
        }
        return scenarioAnswer(command, args);
      },
    }));
    const session = test.session;
    session.expandGroup("needsMyReview");
    await until(() => session.group("waitingForReviewers").stage.state === "error");
    await until(() => session.group("needsMyReview").loadedOnce);
    expect(session.group("needsMyReview").stage.state).to.equal("ready");
    expect(session.group("needsMyReview").reviews.map(review => review.id)).to.deep.equal([BRANCH_REVIEW_ID]);
    for (const key of [ "reworkRequested", "waitingForReviewers" ] as const) {
      expect(session.group(key).stage).to.deep.equal({ message: "Connection to the server was lost", state: "error" });
    }
    fail = false;
    session.retryGroup("waitingForReviewers");
    await until(() => session.group("waitingForReviewers").stage.state === "ready");
    expect(session.group("reworkRequested").stage.state).to.equal("ready");
    expect(session.group("needsMyReview").stage.state).to.equal("ready");
  });

  it("pages All Open and keeps the rows it showed while the next page loads", async () => {
    const page = (offset: number, count: number) => reviewsXml(Array.from({ length: count }, (_, index) => ({
      id: 9842 - offset - index,
    })));
    const test = track(harness({
      answer: (command, args) => {
        const offset = /offset (\d+)/.exec(args[1] ?? "");
        return offset ? page(Number(offset[1]), offset[1] === "0" ? 50 : 3) : scenarioAnswer(command, args);
      },
    }));
    const session = test.session;
    session.expandGroup("allOpen");
    await until(() => session.group("allOpen").loadedOnce);
    expect(session.group("allOpen").reviews).to.have.length(50);
    expect(session.group("allOpen").hasMore).to.equal(true);
    session.loadMore("allOpen");
    expect(session.group("allOpen").stage.state).to.equal("loading");
    expect(session.group("allOpen").reviews).to.have.length(50);
    await until(() => session.group("allOpen").stage.state === "ready");
    expect(session.group("allOpen").reviews).to.have.length(53);
    expect(session.group("allOpen").hasMore).to.equal(false);
  });

  it("pages All Reviews of anyone's in any status, and Refresh takes it back to its first page in place", async () => {
    const page = (offset: number, count: number) => reviewsXml(Array.from({ length: count }, (_, index) => ({
      id: 7400 - offset - index,
      owner: `author${index % 3}@example.com`,
      status: [ "Under review", "Reviewed", "Rework required" ][index % 3],
    })));
    let answered = 0;
    const test = track(harness({
      answer: (command, args) => {
        const offset = /^where id > 0 order by date desc limit 50 offset (\d+)$/.exec(args[1] ?? "");
        if (offset) {
          answered++;
          return page(Number(offset[1]), offset[1] === "0" ? 50 : 7);
        }
        return scenarioAnswer(command, args);
      },
    }));
    const session = test.session;
    const provider = new ReviewListProvider(session);
    const rowIds = () => {
      const group = provider.getChildren().find(node => node.kind === "group" && node.key === "allReviews")!;
      return provider.getChildren(group).map(node => node.id);
    };
    const allQueries = () => test.shell.queries("review").filter(where => where.startsWith("where id > 0"));
    try {
      session.expandGroup("allReviews");
      await until(() => session.group("allReviews").loadedOnce);
      expect(session.group("allReviews").reviews).to.have.length(50);
      expect(new Set(session.group("allReviews").reviews.map(review => review.status)).size).to.equal(3);
      expect(session.group("allReviews").hasMore).to.equal(true);
      const firstPage = rowIds();
      expect(firstPage).to.have.length(51);
      expect(firstPage[50]).to.equal("list/wk/allReviews/more");

      session.loadMore("allReviews");
      // A second Load More while the page loads is ignored, and the rows shown stay.
      session.loadMore("allReviews");
      expect(session.group("allReviews").stage.state).to.equal("loading");
      expect(session.group("allReviews").reviews).to.have.length(50);
      await until(() => session.group("allReviews").stage.state === "ready");
      expect(session.group("allReviews").reviews).to.have.length(57);
      expect(session.group("allReviews").hasMore).to.equal(false);
      expect(allQueries()).to.deep.equal([
        "where id > 0 order by date desc limit 50 offset 0",
        "where id > 0 order by date desc limit 50 offset 50",
      ]);
      // A short page was the last one: Load More asks nothing more, and neither does a group with one page.
      session.loadMore("allReviews");
      session.loadMore("needsMyReview");
      expect(session.group("allReviews").stage.state).to.equal("ready");
      expect(answered).to.equal(2);

      const refreshed = session.refreshList();
      expect(session.group("allReviews").stage.state).to.equal("loading");
      expect(session.group("allReviews").reviews, "the rows stay until the first page is back").to.have.length(57);
      await refreshed;
      expect(allQueries().slice(2)).to.deep.equal(["where id > 0 order by date desc limit 50 offset 0"]);
      expect(session.group("allReviews").reviews).to.have.length(50);
      expect(session.group("allReviews").hasMore).to.equal(true);
      expect(rowIds(), "the first page keeps its row ids").to.deep.equal(firstPage);
    } finally {
      provider.dispose();
    }
  });

  it("shows a failed group as an error until a retry succeeds", async () => {
    let fail = true;
    const test = track(harness({
      answer: (command, args) => {
        if (fail && args[0] === "review" && args[1].startsWith("where id > 0")) {
          throw new Error("Error: The server is unreachable");
        }
        return scenarioAnswer(command, args);
      },
    }));
    const session = test.session;
    session.expandGroup("allReviews");
    await until(() => session.group("allReviews").stage.state !== "loading");
    expect(session.group("allReviews").stage)
      .to.deep.equal({ message: "The server is unreachable", state: "error" });
    fail = false;
    session.retryGroup("allReviews");
    await until(() => session.group("allReviews").stage.state === "ready");
    expect(session.group("allReviews").loadedOnce).to.equal(true);
  });

  it("marks the next page of a group as loading until it arrives or fails, and not a Refresh", async () => {
    let fail = false;
    const test = track(harness({
      answer: (command, args) => {
        const offset = /^where id > 0 order by date desc limit 50 offset (\d+)$/.exec(args[1] ?? "");
        if (!offset) {
          return scenarioAnswer(command, args);
        }
        if (fail) {
          throw new Error("Error: The server is unreachable");
        }
        return reviewsXml(Array.from({ length: 50 }, (_, index) => ({ id: 7400 - Number(offset[1]) - index })));
      },
    }));
    const session = test.session;
    const group = () => session.group("allReviews");
    session.expandGroup("allReviews");
    expect(group().stage.state).to.equal("loading");
    expect(group().loadingMore, "the first page is not a next one").to.equal(false);
    await until(() => group().loadedOnce);
    session.loadMore("allReviews");
    expect(group().loadingMore).to.equal(true);
    await until(() => group().stage.state === "ready");
    expect(group().loadingMore).to.equal(false);
    expect(group().reviews).to.have.length(100);

    fail = true;
    session.loadMore("allReviews");
    expect(group().loadingMore).to.equal(true);
    await until(() => group().stage.state === "error");
    expect(group().loadingMore).to.equal(false);
    expect(group().reviews, "the rows shown stay").to.have.length(100);

    fail = false;
    const refreshed = session.refreshList();
    expect(group().stage.state).to.equal("loading");
    expect(group().loadingMore, "a Refresh reloads the first page").to.equal(false);
    await refreshed;
    expect(group().loadingMore).to.equal(false);
  });

  it("keeps the pages of All Reviews and a deep All Open when a status is set, and reloads what the status moves",
    async () => {
      const written = new Map<number, string>();
      const row = (id: number) => ({ id, status: written.get(id) ?? "Under review" });
      const test = track(harness({
        answer: (command, args) => {
          if (command === "codereview") {
            written.set(Number(args[1]), /--status=(.+)$/.exec(args[2])![1]);
            return "";
          }
          const where = args[1] ?? "";
          const offset = /limit 50 offset (\d+)$/.exec(where);
          if (args[0] === "review" && offset) {
            return reviewsXml(Array.from({ length: 50 }, (_, index) => row(7400 - Number(offset[1]) - index)));
          }
          const one = /^where id = (73\d\d|7400)$/.exec(where);
          if (args[0] === "review" && one) {
            return reviewsXml([row(Number(one[1]))]);
          }
          if (args[0] === "review" && where.endsWith("limit 2000")) {
            return reviewsXml([row(7400)]);
          }
          return scenarioAnswer(command, args);
        },
      }));
      const session = test.session;
      const queries = (part: string) => test.shell.queries("review").filter(where => where.includes(part)).length;
      const firstPages = () => queries("offset 0");
      const deep = 7323;
      session.expandGroup("needsMyReview");
      for (const key of [ "allReviews", "allOpen" ] as const) {
        session.expandGroup(key);
        await until(() => session.group(key).loadedOnce);
        session.loadMore(key);
        await until(() => session.group(key).stage.state === "ready");
        expect(session.group(key).reviews).to.have.length(100);
      }
      await until(() => session.group("needsMyReview").loadedOnce);
      const found = await session.findReviews();
      const assigned = queries("assignee = 'me'");
      const owned = queries("owner = 'me'");
      const finds = queries("limit 2000");
      expect(firstPages()).to.equal(2);

      const review = session.group("allReviews").reviews.find(candidate => candidate.id === deep)!;
      expect((await session.setStatus("wk", review, "Rework required"))?.status).to.equal("Rework required");
      await until(() => PERSONAL_KEYS.every(key => session.group(key).stage.state === "ready"));
      expect(firstPages(), "neither paged group went back to its first page").to.equal(2);
      for (const key of [ "allReviews", "allOpen" ] as const) {
        expect(session.group(key).reviews, key).to.have.length(100);
        expect(session.group(key).reviews.find(candidate => candidate.id === deep)?.status, key)
          .to.equal("Rework required");
      }
      // The personal groups are what the status moves a review between.
      expect(queries("assignee = 'me'")).to.equal(assigned + 1);
      expect(queries("owner = 'me'")).to.equal(owned + 1);
      expect(await session.findReviews(), "Find Review… asks cm again").to.not.equal(found);
      expect(queries("limit 2000")).to.equal(finds + 1);

      test.ui.answer = true;
      const fresh = session.group("allReviews").reviews.find(candidate => candidate.id === deep)!;
      expect((await session.setStatus("wk", fresh, "Reviewed"))?.status).to.equal("Reviewed");
      expect(firstPages()).to.equal(2);
      expect(session.group("allOpen").reviews.map(candidate => candidate.id)).to.have.length(99).and.not.include(deep);
      expect(session.group("allReviews").reviews).to.have.length(100);
      expect(session.group("allReviews").reviews.find(candidate => candidate.id === deep)?.status).to.equal("Reviewed");

      // All Open on its first page loses nothing by loading it again; personal groups never loaded stay so.
      const shallow = track(harness({ answer: test.shell.answer }));
      shallow.session.expandGroup("allOpen");
      await until(() => shallow.session.group("allOpen").loadedOnce);
      const opened = shallow.session.group("allOpen").reviews[3];
      await shallow.session.setStatus("wk", opened, "Rework required");
      await until(() => shallow.session.group("allOpen").stage.state === "ready");
      expect(shallow.shell.queries("review").filter(where => where.startsWith("where status != 'Reviewed'")))
        .to.deep.equal(Array(2).fill("where status != 'Reviewed' order by date desc limit 50 offset 0"));
      expect(shallow.shell.queries("review").some(where => where.includes("assignee = 'me'"))).to.equal(false);
    });

  it("reads Find Review…'s reviews and branch names once, and again once old, on Refresh, a queue change or " +
    "a workspace switch, but keeps no failed query", async () => {
    let fail = true;
    let assigned = false;
    let now = NOW;
    const test = track(harness({
      answer: (command, args) => {
        if (args[0] === "review" && args[1] === "where id > 0 order by date desc limit 2000") {
          if (fail) {
            throw new Error("Error: The server is unreachable");
          }
          return reviewsXml([
            { id: 3, status: "Reviewed" },
            { id: 2, title: "Review of branch /main/named" },
            { id: 1, owner: ME, target: `id:${BRANCH_ID}` },
          ]);
        }
        if (args[0] === "branch" && args[1].startsWith("where (")) {
          return args[1].endsWith("and hidden = 'true'") ? branchRowXml(BRANCH_ID, BRANCH_NAME, HEAD) : EMPTY_QUERY;
        }
        if (assigned && args[0] === "review" && args[1].includes("assignee = 'me'")) {
          return reviewsXml([{ assignee: ME, id: 9 }]);
        }
        return scenarioAnswer(command, args);
      },
      now: () => now,
      workspaces: WORKSPACES,
    }));
    const session = test.session;
    const finds = () => test.shell.queries("review").filter(where => where.endsWith("limit 2000")).length;
    const failed = await session.findReviews().then(() => "loaded", (error: unknown) => errorText(error));
    expect(failed).to.equal("The server is unreachable");
    expect(test.ui.errors, "the command shows the error, not the session").to.deep.equal([]);

    fail = false;
    const first = session.findReviews();
    expect(session.findReviews(), "one query while it runs").to.equal(first);
    const found = await first;
    expect(found.reviews.map(review => review.id)).to.deep.equal([ 3, 2, 1 ]);
    expect(found.reviews.map(review => review.status)).to.deep.equal([ "Reviewed", "Under review", "Under review" ]);
    // The titles Plastic wrote name their branch; the others' one branch is asked for once, found hidden.
    expect(Array.from(found.branches)).to.deep.equal([[ BRANCH_ID, BRANCH_NAME ]]);
    expect(test.shell.queries("branch")).to.deep.equal([
      `where (id = ${BRANCH_ID})`,
      `where (id = ${BRANCH_ID}) and hidden = 'true'`,
    ]);
    expect(await session.findReviews()).to.equal(found);
    expect(finds()).to.equal(2);

    now += 60 * 1000 - 1;
    expect(await session.findReviews(), "kept for a minute").to.equal(found);
    now += 1;
    const aged = await session.findReviews();
    expect(aged).to.not.equal(found);
    expect(aged).to.deep.equal(found);
    expect(finds()).to.equal(3);
    expect(test.shell.queries("branch")).to.have.length(4);

    await session.refreshList();
    const again = await session.findReviews();
    expect(again).to.not.equal(aged);
    expect(again).to.deep.equal(found);
    expect(await session.findReviews()).to.equal(again);
    expect(finds()).to.equal(4);

    // A poll that sees the queue unchanged keeps the reviews; one that sees a new review assigned drops them.
    await until(() => session.group("needsMyReview").loadedOnce);
    session.setViewVisible(reviewListViewId, true);
    await session.poll();
    expect(await session.findReviews()).to.equal(again);
    assigned = true;
    await session.poll();
    expect(session.group("needsMyReview").reviews.map(review => review.id)).to.include(9);
    const polled = await session.findReviews();
    expect(polled).to.not.equal(again);
    expect(finds()).to.equal(5);

    session.selectWorkspace("wk2");
    expect(await session.findReviews()).to.not.equal(polled);
    expect(finds()).to.equal(6);

    const none = track(harness({ workspaces: [] }));
    expect(await none.session.findReviews().then(() => "loaded", (error: unknown) => errorText(error)))
      .to.equal("Plastic Reviews needs an open Plastic workspace.");
  });

  it("leaves the branches unnamed, and Find Review… working, when the branch query fails", async () => {
    const test = track(harness({
      answer: (command, args) => {
        if (args[0] === "review" && args[1] === "where id > 0 order by date desc limit 2000") {
          return reviewsXml([{ id: 1 }]);
        }
        if (args[0] === "branch") {
          throw new Error("Error: The server is unreachable");
        }
        return scenarioAnswer(command, args);
      },
    }));
    const found = await test.session.findReviews();
    expect(found.reviews.map(review => review.id)).to.deep.equal([1]);
    expect(found.branches.size).to.equal(0);
    expect(test.ui.errors).to.deep.equal([]);
  });

  it("loads a changeset's files once and reports them through onDidChangeActive", async () => {
    const test = track(harness());
    const session = test.session;
    await session.activate("wk", BRANCH_REVIEW_ID);
    let fired = 0;
    session.onDidChangeActive(() => fired++);
    expect(session.changesetFiles(3699).state).to.equal("loading");
    expect(session.changesetFiles(3699).state).to.equal("loading");
    await until(() => session.changesetFiles(3699).state === "ready");
    expect(fired).to.equal(1);
    expect(test.shell.calls.filter(call => call.command === "diff" && call.args[0] === "cs:3699")).to.have.length(1);
    expect(session.loadedComparisons().map(comparison => comparison.kind)).to.deep.equal([ "final", "changeset" ]);
    expect(session.changesetFiles(4301).state).to.equal("idle");
  });

  it("keeps viewed files per revision in globalState, shared by a new session", async () => {
    const test = track(harness());
    await test.session.activate("wk", BRANCH_REVIEW_ID);
    const file = ready(test.session.active!.files).final.files[0];
    let fired = 0;
    test.session.onDidChangeViewed(() => fired++);
    test.session.setViewed([file], true);
    expect(fired).to.equal(1);
    expect(test.session.isViewed(file)).to.equal(true);
    const other = track(harness({ globalState: test.globalState }));
    await other.session.activate("wk", BRANCH_REVIEW_ID);
    expect(other.session.isViewed(file)).to.equal(true);
  });

  it("switches workspace: the queue starts over, the review closes, that workspace's last review returns", async () => {
    const workspaceState = memento();
    await workspaceState.update(LAST_REVIEW_KEY, { wk2: CHANGESET_REVIEW_ID });
    const test = track(harness({ workspaceState, workspaces: WORKSPACES }));
    const session = test.session;
    expect(session.multipleWorkspaces).to.equal(true);
    expect(session.workspaceId).to.equal("wk");
    await session.activate("wk", BRANCH_REVIEW_ID);
    session.expandGroup("needsMyReview");
    await until(() => session.group("needsMyReview").loadedOnce);

    session.selectWorkspace("wk2");
    expect(session.workspaceId).to.equal("wk2");
    expect(session.workspaceName).to.equal("Tools");
    expect(session.group("needsMyReview").loadedOnce).to.equal(false);
    await until(() => session.active?.review.id === CHANGESET_REVIEW_ID && session.active.files.state === "ready");
    expect(session.active!.workspaceId).to.equal("wk2");

    session.close();
    expect(session.active).to.equal(undefined);
    expect(workspaceState.values.get(LAST_REVIEW_KEY)).to.deep.equal({ wk: BRANCH_REVIEW_ID });
  });

  it("forgets a restored review that no longer exists and keeps one the server could not answer for", async () => {
    const workspaceState = memento();
    await workspaceState.update(LAST_REVIEW_KEY, { wk: 6251 });
    const missing = track(harness({ workspaceState }));
    await missing.session.restore();
    expect(missing.session.active).to.equal(undefined);
    expect(workspaceState.values.get(LAST_REVIEW_KEY)).to.deep.equal({});

    await workspaceState.update(LAST_REVIEW_KEY, { wk: BRANCH_REVIEW_ID });
    const offline = track(harness({
      answer: () => {
        throw new Error("Error: The server is unreachable");
      },
      workspaceState,
    }));
    await offline.session.restore();
    expect(offline.session.active).to.equal(undefined);
    expect(workspaceState.values.get(LAST_REVIEW_KEY)).to.deep.equal({ wk: BRANCH_REVIEW_ID });
  });

  it("renders the Overview of the active review only", async () => {
    const test = track(harness());
    await test.session.activate("wk", BRANCH_REVIEW_ID);
    const overview = test.session.overview("wk", BRANCH_REVIEW_ID);
    expect(overview).to.match(/^<div class="plastic-review">\n/);
    expect(overview).to.contain("<h1 class=\"title\">Lap Timer Accuracy</h1>");
    expect(test.session.overview("wk", 1)).to.contain("Open this review in Plastic Reviews");
  });

  it("draws the Overview again when files are marked viewed, once per burst, and marks the cm user", async () => {
    const editors = new ReviewEditors();
    editorsToDispose.push(editors);
    const test = track(harness({ editors }));
    const session = test.session;
    const reads: string[] = [];
    editors.onDidChange(uri => reads.push(uri.toString()));
    const settled = () => new Promise(resolve => setTimeout(resolve, 150));
    await session.activate("wk", BRANCH_REVIEW_ID);
    await settled();
    reads.length = 0;
    const page = () => session.overview("wk", BRANCH_REVIEW_ID);
    // The first render asks cm who the user is, and the Overview is drawn again once it knows.
    expect(visible(page())).to.not.contain("(you)");
    await until(() => reads.length > 0);
    expect(test.shell.calls.filter(call => call.command === "whoami")).to.have.length(1);
    expect(visible(page())).to.contain("erin.author → alex.reviewer (you)");
    await settled();

    reads.length = 0;
    const changes = viewableRows(scopeRows(ready(session.active!.files), "changes"));
    session.setViewed([changes[0]], true);
    session.setViewed([changes[1]], true);
    await until(() => reads.length > 0);
    await settled();
    expect(reads).to.deep.equal([reviewOverviewUri("wk", BRANCH_REVIEW_ID).toString()]);
    expect(page()).to.contain(`aria-valuemax="${changes.length}" aria-valuenow="2"`);
    // Closing the review draws its Overview once more, now saying to open the review.
    session.close();
    await until(() => reads.length === 2);
    expect(page()).to.contain("Open this review in Plastic Reviews");
  });

  it("links the Overview's threads through overviewLink, naming the workspace and the review", async () => {
    const written: IReviewLink[] = [];
    const test = track(harness({
      overviewLink: link => {
        written.push(link);
        return `vscode://plastic.test/link${written.length}`;
      },
    }));
    await test.session.activate("wk", BRANCH_REVIEW_ID);
    const html = test.session.overview("wk", BRANCH_REVIEW_ID);
    expect(written).to.deep.equal([
      { reviewId: BRANCH_REVIEW_ID, target: { kind: "thread", threadId: 12907 }, workspaceId: "wk" },
      { reviewId: BRANCH_REVIEW_ID, target: { kind: "thread", threadId: 12915 }, workspaceId: "wk" },
    ]);
    expect(html).to.contain("<a href=\"vscode://plastic.test/link2\">SaveSystem.cs:154</a>");
  });

  it("polls the active review while only its Overview is on screen", async () => {
    const test = track(harness());
    await test.session.activate("wk", BRANCH_REVIEW_ID);
    test.shell.calls.length = 0;
    await test.session.poll();
    expect(test.shell.calls).to.deep.equal([]);
    test.session.setViewVisible(overviewViewId, true);
    await test.session.poll();
    expect(test.shell.queries("review")).to.have.length(1);
    test.session.setViewVisible(overviewViewId, false);
  });
});
