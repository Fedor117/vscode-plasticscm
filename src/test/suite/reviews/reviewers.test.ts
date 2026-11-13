import {
  AUTHOR,
  BRANCH_REVIEW_ID,
  comment,
  commentsXml,
  ME,
  REPOSITORY,
  ReviewShell,
  reviewsXml,
  SCENARIO_COMMENTS,
  scenarioAnswer,
  WORKSPACE_ROOT,
} from "./fixtures";
import { CancellationTokenSource, OutputChannel } from "vscode";
import { exited, FakeCm, IFakeCmCall, OLD_USAGE } from "./cmFixtures";
import { fakePostingEditors, until } from "./editorFixtures";
import { IReviewComment, IReviewDiscussions, ReviewStatus } from "../../../reviews/models";
import { IReviewSessionUi, IReviewWorkspace, ReviewSession } from "../../../reviews/reviewSession";
import { expect } from "chai";
import { ICmOutput } from "../../../reviews/cmRunner";
import { IReviewLink } from "../../../reviews/reviewLinks";
import { reviewerStates } from "../../../reviews/timeline";
import { ReviewPosting } from "../../../reviews/reviewPosting";
import { ReviewService } from "../../../reviews/reviewService";
import { ReviewWriter } from "../../../reviews/reviewWriter";

/**
 * Add Me as Reviewer and Set Review Status…, on the fixture shell with
 * review writes on a fake one-shot cm: nothing runs cm or reaches a
 * server, and the shell's `codereview` calls are counted. Every name and id
 * here is made up.
 */

const CONFIG = { cmPath: "cm", millisCommandTimeout: 1000, millisToStop: 1000, millisToWaitUntilUp: 1000 };
const WORKSPACE: IReviewWorkspace = { id: "wk", name: "Nimbus", path: WORKSPACE_ROOT, repository: REPOSITORY };
const OTHER = "sam.rivera@example.com";
const LINK = "plastic://acme-studio@unity/repos/Nimbus/Nimbus/code-reviews/12831";
const WITHOUT_ADDING = "Set Status Without Adding";
const REVIEW_STATUS = "Set the Review's Status";
const UNSUPPORTED = "Review writes need Unity Version Control client 11.0.16.10512 or newer.";
const NO_REVIEW = "The code review 12831 does not exist.";
const NOT_REVIEWER = "You are not a reviewer of the code review 12831.";
/** cm's flag for each verdict, and the status it stands for. */
const VERDICTS: { [flag: string]: ReviewStatus } = {
  "--reviewed": "Reviewed",
  "--rework-required": "Rework required",
  "--under-review": "Under review",
};
const MARKERS: { [status in ReviewStatus]: string } = {
  "Reviewed": "status-reviewed",
  "Rework required": "status-rework-required",
  "Under review": "status-under-review",
};
const DRAFT = { key: "draft", location: 0, path: "/A.cs", reviewId: 1, revisionId: 1, workspaceId: "wk" };

function timeline(id: number, date: string, text: string, owner = OTHER): IReviewComment {
  return comment({
    changesetId: -1, date, guid: `guid-${id}`, id, location: -1, owner, reviewId: BRANCH_REVIEW_ID, revisionId: -1,
    text, type: "timeline",
  });
}

/** A row that requests the cm user, as someone else wrote it. */
const REQUESTED = timeline(13002, "2026-09-22T16:11:21+01:00", `[requested-review-from]${ME}`);

/** The review as the fixture server holds it; the cm user is not its reviewer unless a test says so. */
interface IWorld {
  owner: string;
  assignee: string;
  status: string;
  user: string;
  comments: IReviewComment[];
  /**
   * `add` for every add the one-shot cm was run for, `verdict <status>` for every verdict, `codereview <args>` for
   * every status write through the cm shell, in order.
   */
  events: string[];
}

function world(overrides: Partial<IWorld> = {}): IWorld {
  // The scenario's comments without the rows that request the cm user or give their verdict.
  const comments = SCENARIO_COMMENTS.filter(row => !/^\[(requested-review-from|status-)/.test(row.text));
  return { assignee: OTHER, comments, events: [], owner: AUTHOR, status: "Under review", user: ME, ...overrides };
}

function answer(state: IWorld): (command: string, args: string[]) => string {
  return (command, args) => {
    if (command === "whoami") {
      return `${state.user}\n`;
    }
    if (command === "codereview") {
      state.events.push(`codereview ${args[2]}`);
      state.status = /--status=(.+)$/.exec(args[2])![1];
      return "";
    }
    if (args[0] === "review" && (args[1] ?? "").includes(`id = ${BRANCH_REVIEW_ID}`)) {
      return reviewsXml([{
        assignee: state.assignee, id: BRANCH_REVIEW_ID, owner: state.owner, status: state.status,
        title: "Lap Timer Accuracy",
      }]);
    }
    if (args[0] === "changereviewcomment") {
      return commentsXml(state.comments);
    }
    return scenarioAnswer(command, args);
  };
}

interface IHarness {
  session: ReviewSession;
  posting: ReviewPosting;
  shell: ReviewShell;
  state: IWorld;
  cm: FakeCm;
  lines: string[];
  links: IReviewLink[];
  ui: {
    confirms: Array<{ message: string; detail: string }>;
    choices: Array<{ message: string; detail: string; actions: readonly string[] }>;
    errors: string[];
    infos: string[];
    statuses: string[];
    notifications: string[];
    opened: string[];
    answer: boolean;
    choice?: string;
    cancel?: CancellationTokenSource;
  };
  setting: boolean;
}

/** What the fake cm answers a write instead of doing it; undefined to do it. */
type Respond = (call: IFakeCmCall, cancel?: { onCancellationRequested(listener: () => void): unknown }) =>
  ICmOutput | Promise<ICmOutput> | undefined;

function harness(options: {
  setting?: boolean;
  state?: Partial<IWorld>;
  /** What `cm codereview comment --usage` prints; by default what a cm with the review write commands does. */
  usage?: ICmOutput;
  /** What the fake cm answers a write; by default it does what it is asked, as the real one would. */
  respond?: Respond;
  /** The fake cm answers writes only once this resolves; by default it answers at once. */
  hold?: Promise<void>;
} = {}): IHarness {
  const state = world(options.state);
  const shell = new ReviewShell();
  shell.answer = answer(state);
  const lines: string[] = [];
  const channel = { appendLine: (line: string) => lines.push(line) } as unknown as OutputChannel;
  const cm = new FakeCm();
  if (options.usage) {
    cm.usage = options.usage;
  }
  cm.answer = async (call, run) => {
    const verdict = call.args[1] === "review" ? VERDICTS[call.args[3]] : undefined;
    state.events.push(verdict ? `verdict ${verdict}` : "add");
    await options.hold;
    const refused = await options.respond?.(call, run.cancel);
    if (refused) {
      return refused;
    }
    // As the server would: an add writes the request row, and a verdict its status row, both as the cm user's own.
    state.comments = state.comments.concat(verdict
      ? timeline(13005, "2026-09-22T17:56:00+01:00", `[${MARKERS[verdict]}]`, ME)
      : timeline(13001, "2026-09-22T17:55:00+01:00", `[requested-review-from]${ME}`, ME));
    return undefined;
  };
  const writer = new ReviewWriter({
    cmPath: () => CONFIG.cmPath, log: line => lines.push(line), platform: "linux", run: cm.run,
  });
  const test = { cm, lines, links: [] as IReviewLink[], setting: options.setting ?? true, shell, state } as IHarness;
  test.posting = new ReviewPosting(writer, {
    reloadDiscussions: (workspaceId, reviewId) => test.session.reloadDiscussions(workspaceId, reviewId),
    repository: id => (id === "wk" ? REPOSITORY : undefined),
    root: id => (id === "wk" ? WORKSPACE_ROOT : undefined),
  }, fakePostingEditors(DRAFT), { setting: () => test.setting, trusted: () => true });
  test.ui = {
    answer: false, choices: [], confirms: [], errors: [], infos: [], notifications: [], opened: [], statuses: [],
  };
  const ui: IReviewSessionUi = {
    cancellable: (title, task) => {
      test.ui.notifications.push(title);
      test.ui.cancel = new CancellationTokenSource();
      return task(test.ui.cancel.token);
    },
    choose: (message, detail, actions) => {
      test.ui.choices.push({ actions, detail, message });
      return Promise.resolve(test.ui.choice);
    },
    confirm: (message, detail) => {
      test.ui.confirms.push({ detail, message });
      return Promise.resolve(test.ui.answer);
    },
    error: message => {
      test.ui.errors.push(message);
    },
    info: message => {
      test.ui.infos.push(message);
    },
    loadUpdates: () => undefined,
    notify: () => Promise.resolve(undefined),
    openExternal: link => {
      test.ui.opened.push(link);
      return Promise.resolve(true);
    },
    progress: (_viewId, task) => task(),
    showDiscussions: () => undefined,
    status: message => {
      test.ui.statuses.push(message);
    },
  };
  const posting = test.posting;
  test.session = new ReviewSession({
    channel,
    createService: wk => new ReviewService(wk.id, wk.path, channel, CONFIG, shell),
    fileLayout: () => "tree",
    globalState: memento(),
    overviewLink: link => {
      test.links.push(link);
      return `vscode://plastic.test/link${test.links.length}`;
    },
    pollInterval: 60 * 60 * 1000,
    reviewers: {
      access: workspaceId => posting.access(workspaceId),
      add: (workspaceId, reviewId, cancel) => posting.addReviewer(workspaceId, reviewId, cancel),
      setStatus: (workspaceId, reviewId, status) => posting.setMyStatus(workspaceId, reviewId, status),
      settingOn: () => posting.settingOn(),
    },
    shellConfig: () => CONFIG,
    ui,
    workspaceState: memento(),
    workspaces: () => [WORKSPACE],
  });
  return test;
}

function memento(): { get: <T>(key: string) => T | undefined; update: (key: string, value: unknown) => Promise<void> } {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: (key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    },
  };
}

function discussions(test: IHarness): IReviewDiscussions {
  const stage = test.session.active!.discussions;
  expect(stage.state).to.equal("ready");
  return (stage as { value: IReviewDiscussions }).value;
}

function statusWrites(test: IHarness): string[] {
  return test.shell.calls.filter(call => call.command === "codereview").map(call => call.args[2]);
}

/** The arguments of each write the one-shot cm was run for, in the workspace's folder. */
function cmWrites(test: IHarness): string[][] {
  const writes = test.cm.writes();
  expect(writes.every(call => call.cwd === WORKSPACE_ROOT && call.stdin === undefined)).to.equal(true);
  return writes.map(call => call.args);
}

/** cm refuses with `message`, as it prints its own errors. */
function refuse(message: string): Respond {
  return () => exited(1, "", `Error: ${message}\n`);
}

/** cm is killed at its timeout: what it did is not known. */
const TIMED_OUT: Respond = () => ({ code: undefined, killed: "timeout", started: true, stderr: "", stdout: "" });

async function activated(options: Parameters<typeof harness>[0] = {}): Promise<IHarness> {
  const test = harness(options);
  await test.session.activate("wk", BRANCH_REVIEW_ID);
  await test.session.service("wk")!.whoami();
  return test;
}

describe("Add Me as Reviewer and Set Review Status… (fake cm, no server)", () => {
  const tests: IHarness[] = [];
  const track = (test: IHarness): IHarness => {
    tests.push(test);
    return test;
  };
  afterEach(() => tests.splice(0).forEach(test => {
    test.session.dispose();
    test.posting.dispose();
  }));

  describe("Set Review Status…", () => {
    it("adds a user who can be added, then gives their own verdict with cm and reads the review back",
      async () => {
        const test = track(await activated());
        expect(test.session.canAddMe()).to.equal(true);
        // As the server might: the verdict changes the review's status, which only the read-back shows here.
        const write = test.cm.answer!;
        test.cm.answer = async (call, run) => {
          const answered = await write(call, run);
          test.state.status = call.args[1] === "review" ? "Rework required" : test.state.status;
          return answered;
        };
        const fresh = await test.session.setStatus("wk", test.session.active!.review, "Rework required");
        expect([ fresh?.id, fresh?.status ]).to.deep.equal([ BRANCH_REVIEW_ID, "Rework required" ]);
        expect(test.session.active!.review.status).to.equal("Rework required");
        expect(test.state.events).to.deep.equal([ "add", "verdict Rework required" ]);
        expect(cmWrites(test)).to.deep.equal([
          [ "codereview", "reviewer", "add", "12831", "--users=me" ],
          [ "codereview", "review", "12831", "--rework-required" ],
        ]);
        expect(statusWrites(test)).to.deep.equal([]);
        expect(test.ui.notifications).to.deep.equal(["Adding you as a reviewer on review #12831…"]);
        expect([ ...test.ui.choices, ...test.ui.confirms ]).to.deep.equal([]);
        expect(test.ui.statuses).to.deep.equal(["Your status on review #12831: Rework required"]);
        // Reloaded: the request and verdict rows are in the timeline, the card has both, and the button would hide.
        const me = reviewerStates(discussions(test).timeline, test.session.active!.review).find(row => row.user === ME);
        expect([ me?.request?.id, me?.verdict?.id, me?.state ]).to.deep.equal([ 13001, 13005, "reworkRequired" ]);
        expect(test.session.canAddMe()).to.equal(false);
        expect(test.lines.filter(line => line.startsWith("cm "))).to.deep.equal([
          "cm codereview reviewer add 12831",
          "cm codereview reviewer add 12831: exit code 0",
          "cm codereview review 12831 --rework-required",
          "cm codereview review 12831 --rework-required: exit code 0",
        ]);
      });

    it("gives a requested reviewer's verdict with cm without a question, and adds no one", async () => {
      const test = track(await activated({ state: { comments: world().comments.concat(REQUESTED) }}));
      const review = test.session.active!.review;
      expect(await test.session.statusPlan("wk", review))
        .to.deep.equal({ add: false, current: "Under review", kind: "personal", user: ME });
      expect(await test.session.setStatus("wk", review, "Reviewed", await test.session.statusPlan("wk", review)))
        .to.equal(undefined);
      // The Reviewed warning still asks first.
      expect(test.ui.confirms.map(confirm => confirm.detail)).to.deep.equal([
        "1 change request is still pending. 5 of 5 files are not viewed.",
      ]);
      test.ui.answer = true;
      await test.session.setStatus("wk", review, "Reviewed");
      expect(test.state.events).to.deep.equal(["verdict Reviewed"]);
      expect(cmWrites(test)).to.deep.equal([[ "codereview", "review", "12831", "--reviewed" ]]);
      expect(test.ui.choices).to.deep.equal([]);
      expect(test.ui.notifications).to.deep.equal([]);
      expect(test.ui.statuses).to.deep.equal(["Your status on review #12831: Reviewed"]);
    });

    it("adds a cm user whose name is not an e-mail address: cm knows who it is signed in as", async () => {
      const test = track(await activated({ state: { user: "dana" }}));
      expect(await test.session.statusPlan("wk", test.session.active!.review))
        .to.deep.equal({ add: true, current: "Under review", kind: "personal", user: "dana" });
      expect(await test.session.addMe("wk", test.session.active!.review)).to.equal(true);
      expect(cmWrites(test)).to.deep.equal([[ "codereview", "reviewer", "add", "12831", "--users=me" ]]);
    });

    it("starts the picker from the user's own verdict on the personal route, and the review's on cm's", async () => {
      const verdict = timeline(13003, "2026-09-22T17:30:00+01:00", "[status-rework-required]", ME);
      const test = track(await activated({ state: { comments: world().comments.concat(verdict), status: "Reviewed" }}));
      const review = test.session.active!.review;
      expect(await test.session.statusPlan("wk", review))
        .to.deep.equal({ add: true, current: "Rework required", kind: "personal", user: ME });
      // The review is Reviewed, but the user's own verdict is Rework required: choosing that changes nothing.
      expect(await test.session.setStatus("wk", review, "Rework required")).to.equal(undefined);
      expect(test.state.events).to.deep.equal([]);

      for (const people of [{ owner: ME }, { assignee: ME }]) {
        const other = track(await activated({ state: { ...people, status: "Rework required" }}));
        expect(await other.session.statusPlan("wk", other.session.active!.review), JSON.stringify(people))
          .to.deep.equal({ current: "Rework required", kind: "cm" });
      }
      const off = track(await activated({ setting: false, state: { comments: world().comments.concat(verdict) }}));
      expect(await off.session.statusPlan("wk", off.session.active!.review))
        .to.deep.equal({ current: "Under review", kind: "cm" });
    });

    it("sets the review's status through the cm shell for the author and the assignee", async () => {
      for (const people of [{ owner: ME }, { assignee: ME }]) {
        const test = track(await activated({ state: people }));
        expect(test.session.canAddMe()).to.equal(false);
        await test.session.setStatus("wk", test.session.active!.review, "Rework required");
        expect(test.state.events, JSON.stringify(people)).to.deep.equal(["codereview --status=Rework required"]);
        expect(test.ui.choices).to.deep.equal([]);
        expect(test.cm.writes()).to.deep.equal([]);
      }
    });

    it("with the setting off, sets the status as before: no question, no add, and no cm run but the shell's",
      async () => {
        const test = track(await activated({ setting: false }));
        const before = test.shell.calls.length;
        await test.session.setStatus("wk", test.session.active!.review, "Rework required");
        expect(test.shell.calls.slice(before).map(call => `${call.command} ${call.args[0]}`))
          .to.deep.equal([ "codereview -e", "find review" ]);
        expect(test.state.events).to.deep.equal(["codereview --status=Rework required"]);
        expect([ ...test.ui.choices, ...test.ui.confirms ]).to.deep.equal([]);
        expect(test.ui.notifications).to.deep.equal([]);
        expect(test.cm.calls).to.deep.equal([]);
      });

    it("sets the review's status through the cm shell, unasked, where cm is older than the review write commands",
      async () => {
        const test = track(await activated({ usage: exited(0, OLD_USAGE) }));
        const review = () => test.session.active!.review;
        expect(await test.session.statusPlan("wk", review())).to.deep.equal({ current: "Under review", kind: "cm" });
        await test.session.setStatus("wk", review(), "Rework required");
        expect(test.state.events).to.deep.equal(["codereview --status=Rework required"]);
        expect([ ...test.ui.choices, ...test.ui.confirms ]).to.deep.equal([]);
        expect(test.cm.writes()).to.deep.equal([]);
      });

    it("asks before setting the status without adding when cm refuses the add, and writes nothing on Cancel",
      async () => {
        const test = track(await activated({ respond: refuse(NO_REVIEW) }));
        const review = test.session.active!.review;
        expect(await test.session.setStatus("wk", review, "Rework required")).to.equal(undefined);
        expect(test.ui.choices).to.deep.equal([{
          actions: [WITHOUT_ADDING], detail: NO_REVIEW, message: "Couldn't add you as a reviewer on review #12831.",
        }]);
        expect(statusWrites(test)).to.deep.equal([]);
        expect(test.session.active!.review.status).to.equal("Under review");

        test.ui.choice = WITHOUT_ADDING;
        expect((await test.session.setStatus("wk", review, "Rework required"))?.status).to.equal("Rework required");
        expect(test.state.events).to.deep.equal([ "add", "add", "codereview --status=Rework required" ]);
        expect(test.ui.errors).to.deep.equal([]);
        expect(test.lines.join("\n")).to.contain("Couldn't add you as a reviewer on review #12831");
      });

    it("stops with an error, and writes no status, when the add's result is unknown", async () => {
      const test = track(await activated({ respond: TIMED_OUT }));
      expect(await test.session.setStatus("wk", test.session.active!.review, "Rework required")).to.equal(undefined);
      expect(test.ui.errors).to.deep.equal(["Couldn't add you as a reviewer on review #12831: cm did not finish in " +
        "time. You may have been added; refresh the review before retrying."]);
      expect(test.ui.choices).to.deep.equal([]);
      expect(test.state.events).to.deep.equal(["add"]);
    });

    it("offers the review's status when cm refuses a requested reviewer's own, and writes nothing on Cancel",
      async () => {
        const test = track(await activated({
          respond: refuse(NOT_REVIEWER), state: { comments: world().comments.concat(REQUESTED) },
        }));
        const review = () => test.session.active!.review;
        const refused = {
          actions: [REVIEW_STATUS], detail: NOT_REVIEWER, message: "Couldn't set your own status on review #12831.",
        };
        expect(await test.session.setStatus("wk", review(), "Rework required")).to.equal(undefined);
        expect(test.ui.choices).to.deep.equal([refused]);
        expect(test.state.events).to.deep.equal(["verdict Rework required"]);
        expect(test.ui.errors).to.deep.equal([]);
        test.ui.choice = REVIEW_STATUS;
        expect((await test.session.setStatus("wk", review(), "Rework required"))?.status).to.equal("Rework required");
        expect(test.state.events.slice(1)).to.deep.equal([
          "verdict Rework required", "codereview --status=Rework required",
        ]);
        expect(test.lines.join("\n")).to.contain("Couldn't set your status on review #12831 to Rework required: " +
          NOT_REVIEWER);
      });

    it("shows an error, and offers nothing, when the verdict's result is unknown", async () => {
      const test = track(await activated({
        respond: TIMED_OUT, state: { comments: world().comments.concat(REQUESTED) },
      }));
      expect(await test.session.setStatus("wk", test.session.active!.review, "Rework required")).to.equal(undefined);
      expect(test.ui.errors).to.deep.equal(["Couldn't set your status on review #12831 to Rework required: cm did " +
        "not finish in time. Your status may have been set; refresh the review before retrying."]);
      expect(test.ui.choices).to.deep.equal([]);
      expect(statusWrites(test)).to.deep.equal([]);
    });

    it("keeps the add when the verdict after it is refused, and shows it", async () => {
      const test = track(await activated({
        respond: call => (call.args[1] === "review" ? exited(1, "", `Error: ${NOT_REVIEWER}`) : undefined),
      }));
      expect(await test.session.setStatus("wk", test.session.active!.review, "Rework required")).to.equal(undefined);
      expect(test.state.events).to.deep.equal([ "add", "verdict Rework required" ]);
      expect(test.ui.choices.map(choice => choice.actions)).to.deep.equal([[REVIEW_STATUS]]);
      // The discussions loaded again: the request row is there, and the user cannot be added a second time.
      expect(discussions(test).reviewers).to.include(ME);
      expect(test.session.canAddMe()).to.equal(false);
    });

    it("adds after the one Reviewed warning, which says so; Cancel writes nothing", async () => {
      const test = track(await activated());
      const review = test.session.active!.review;
      expect(await test.session.setStatus("wk", review, "Reviewed")).to.equal(undefined);
      expect(test.ui.confirms).to.deep.equal([{
        detail: "1 change request is still pending. 5 of 5 files are not viewed. " +
          "You will be added as a reviewer first.",
        message: "Mark review #12831 as Reviewed?",
      }]);
      expect(test.state.events).to.deep.equal([]);
      test.ui.answer = true;
      await test.session.setStatus("wk", review, "Reviewed");
      expect(test.state.events).to.deep.equal([ "add", "verdict Reviewed" ]);
      expect(test.ui.choices).to.deep.equal([]);
    });

    it("says the add's result is unknown when it is cancelled once cm has started, and shows what the server has",
      async () => {
        const test = track(await activated({
          respond: (_call, cancel) => new Promise<ICmOutput>(resolve => {
            // As the server might have: the add arrived before cm was killed.
            cancel!.onCancellationRequested(() => {
              test.state.comments = test.state.comments.concat(
                timeline(13001, "2026-09-22T17:55:00+01:00", `[requested-review-from]${ME}`, ME));
              resolve({ code: undefined, killed: "cancelled", started: true, stderr: "", stdout: "" });
            });
          }),
        }));
        const comments = () => test.shell.queries("changereviewcomment").length;
        const before = comments();
        const setting = test.session.setStatus("wk", test.session.active!.review, "Rework required");
        await until(() => test.state.events.includes("add"));
        test.ui.cancel!.cancel();
        expect(await setting).to.equal(undefined);
        expect(test.state.events).to.deep.equal(["add"]);
        expect([ ...test.ui.choices, ...test.ui.confirms ]).to.deep.equal([]);
        expect(test.ui.errors).to.deep.equal(["Couldn't add you as a reviewer on review #12831: Cancelled before cm " +
          "finished. You may have been added; refresh the review before retrying."]);
        // The discussions loaded again: the add did arrive, and the user cannot be added a second time.
        expect(comments()).to.equal(before + 1);
        expect(discussions(test).reviewers).to.include(ME);
        expect(test.session.canAddMe()).to.equal(false);
      });

    it("stops without a word when the add is cancelled before cm starts, and writes nothing", async () => {
      const test = track(await activated({
        respond: () => {
          test.ui.cancel!.cancel();
          return { code: undefined, killed: "cancelled", started: false, stderr: "", stdout: "" };
        },
      }));
      expect(await test.session.setStatus("wk", test.session.active!.review, "Rework required")).to.equal(undefined);
      expect([ ...test.ui.choices, ...test.ui.confirms ]).to.deep.equal([]);
      expect(test.ui.errors).to.deep.equal([]);
      expect(statusWrites(test)).to.deep.equal([]);
    });

    it("offers the review's status only when cm refused the verdict, not when cm could not answer", async () => {
      const cases: Array<[string, Respond, string]> = [
        [ "cm missing", () => ({ code: undefined, missing: true, started: false, stderr: "", stdout: "" }),
          "cm wasn't found. Check the plastic-scm.cmConfiguration.cmPath setting." ],
        [ "cm not started", () => ({ code: undefined, started: false, stderr: "", stdout: "" }),
          "cm could not be started. Check the plastic-scm.cmConfiguration.cmPath setting." ],
        [ "the server lost", refuse("Unable to connect to the remote server"), "Unable to connect to the remote " +
          "server. Your status may have been set; refresh the review before retrying." ],
      ];
      for (const [ what, respond, message ] of cases) {
        const test = track(await activated({ respond, state: { comments: world().comments.concat(REQUESTED) }}));
        test.ui.choice = REVIEW_STATUS;
        expect(await test.session.setStatus("wk", test.session.active!.review, "Rework required"), what)
          .to.equal(undefined);
        expect(test.ui.choices, what).to.deep.equal([]);
        expect(test.ui.errors, what)
          .to.deep.equal([`Couldn't set your status on review #12831 to Rework required: ${message}`]);
        expect(statusWrites(test), what).to.deep.equal([]);
      }
    });
  });

  describe("Add Me as Reviewer", () => {
    it("adds the user, loads the discussions again and says so", async () => {
      const test = track(await activated());
      const comments = () => test.shell.queries("changereviewcomment").length;
      const before = comments();
      expect(await test.session.addMe("wk", test.session.active!.review)).to.equal(true);
      expect(test.ui.statuses).to.deep.equal(["$(person-add) Added you as a reviewer on review #12831"]);
      expect(comments()).to.equal(before + 1);
      expect(discussions(test).reviewers).to.include(ME);
      expect(test.session.canAddMe()).to.equal(false);
      expect(statusWrites(test)).to.deep.equal([]);
      expect(cmWrites(test)).to.deep.equal([[ "codereview", "reviewer", "add", "12831", "--users=me" ]]);
    });

    it("says which client is needed, and runs no write, where cm is older than the review write commands",
      async () => {
        const test = track(await activated({ usage: exited(0, OLD_USAGE) }));
        expect(await test.session.addMe("wk", test.session.active!.review)).to.equal(false);
        expect(test.ui.errors).to.deep.equal([`Couldn't add you as a reviewer on review #12831: ${UNSUPPORTED}`]);
        expect(test.ui.choices).to.deep.equal([]);
        expect(test.cm.writes()).to.deep.equal([]);
      });

    it("tells the author, the assignee and a requested reviewer why it does nothing", async () => {
      const infos: string[] = [];
      for (const state of [{ owner: ME }, { assignee: ME }, { comments: world().comments.concat(REQUESTED) }]) {
        const test = track(await activated({ state }));
        expect(await test.session.addMe("wk", test.session.active!.review)).to.equal(false);
        infos.push(...test.ui.infos);
        expect(test.cm.writes()).to.deep.equal([]);
      }
      expect(infos).to.deep.equal([
        "You opened review #12831, and authors don't review their own change.",
        "You're the assignee of review #12831, which already makes you a reviewer.",
        "You're already a reviewer on review #12831.",
      ]);
    });

    it("shows a failed add and changes nothing", async () => {
      const test = track(await activated({ respond: refuse(NO_REVIEW) }));
      const before = test.shell.calls.length;
      expect(await test.session.addMe("wk", test.session.active!.review)).to.equal(false);
      expect(test.ui.errors).to.deep.equal([`Couldn't add you as a reviewer on review #12831: ${NO_REVIEW}`]);
      expect(test.ui.statuses).to.deep.equal([]);
      expect(test.shell.calls.slice(before)).to.deep.equal([]);
      expect(test.session.canAddMe()).to.equal(true);
    });

    it("says the result is unknown, and shows what the server has, when the add is cancelled once cm has started",
      async () => {
        const test = track(await activated({
          respond: (_call, cancel) => new Promise<ICmOutput>(resolve => {
            cancel!.onCancellationRequested(
              () => resolve({ code: undefined, killed: "cancelled", started: true, stderr: "", stdout: "" }));
          }),
        }));
        const comments = () => test.shell.queries("changereviewcomment").length;
        const before = comments();
        const adding = test.session.addMe("wk", test.session.active!.review);
        await until(() => test.state.events.includes("add"));
        test.ui.cancel!.cancel();
        expect(await adding).to.equal(false);
        expect(test.ui.errors).to.deep.equal(["Couldn't add you as a reviewer on review #12831: Cancelled before cm " +
          "finished. You may have been added; refresh the review before retrying."]);
        expect(comments()).to.equal(before + 1);
        expect(test.ui.statuses).to.deep.equal([]);
      });

    it("adds from a Reviews row of a review that is not open, and Needs My Review follows", async () => {
      const test = track(harness());
      test.session.expandGroup("needsMyReview");
      await until(() => test.session.group("needsMyReview").loadedOnce);
      expect(test.session.group("needsMyReview").reviews.map(review => review.id)).to.not.include(BRANCH_REVIEW_ID);
      const row = (await test.session.service("wk")!.review(BRANCH_REVIEW_ID))!;
      expect(await test.session.addMe("wk", row)).to.equal(true);
      await until(() => test.session.group("needsMyReview").reviews.some(review => review.id === BRANCH_REVIEW_ID));
      expect(test.state.events).to.deep.equal(["add"]);
    });

    it("opens the review in the desktop app whatever the setting", async () => {
      const test = track(await activated({ setting: false }));
      expect(await test.session.openInDesktop("wk", BRANCH_REVIEW_ID)).to.equal(true);
      expect(await test.session.openInDesktop("elsewhere", BRANCH_REVIEW_ID)).to.equal(false);
      expect(test.ui.opened).to.deep.equal([LINK]);
      expect(test.ui.infos).to.deep.equal(["The repository of review #12831 is not known yet, so it can't open in " +
        "Unity Version Control."]);
    });
  });

  describe("one add per review in flight", () => {
    /** A gate the fake cm waits behind until `release`. */
    function gate(): { hold: Promise<void>; release: () => void } {
      let release!: () => void;
      const hold = new Promise<void>(resolve => {
        release = resolve;
      });
      return { hold, release };
    }

    /** Long enough for a Set Review Status… started now to reach its add, which must not send. */
    const moment = () => new Promise(resolve => setTimeout(resolve, 50));
    const busy = "You're already being added as a reviewer on review #12831.";

    it("answers a second Add Me with a message, not a second request, and offers nothing meanwhile", async () => {
      const { hold, release } = gate();
      const test = track(await activated({ hold }));
      let changes = 0;
      test.session.onDidChangeCanAddMe(() => changes++);
      const review = test.session.active!.review;
      const first = test.session.addMe("wk", review);
      await until(() => test.state.events.length === 1);
      expect(test.session.canAddMe()).to.equal(false);
      expect(test.session.overview("wk", BRANCH_REVIEW_ID)).to.not.contain("Add me as reviewer");
      expect(changes).to.be.greaterThan(0);
      const during = changes;
      expect(await test.session.addMe("wk", review)).to.equal(false);
      expect(test.ui.infos).to.deep.equal([busy]);
      release();
      expect(await first).to.equal(true);
      expect(changes).to.be.greaterThan(during);
      expect(test.state.events).to.deep.equal(["add"]);
      expect(test.ui.statuses).to.deep.equal(["$(person-add) Added you as a reviewer on review #12831"]);
      expect(test.ui.errors).to.deep.equal([]);
    });

    it("makes Set Review Status… wait for Add Me's add and use it, so the verdict follows one add", async () => {
      const { hold, release } = gate();
      const test = track(await activated({ hold }));
      const review = test.session.active!.review;
      const adding = test.session.addMe("wk", review);
      await until(() => test.state.events.length === 1);
      const setting = test.session.setStatus("wk", review, "Rework required");
      await moment();
      expect(test.state.events).to.deep.equal(["add"]);
      release();
      expect(await adding).to.equal(true);
      expect((await setting)?.id).to.equal(BRANCH_REVIEW_ID);
      expect(test.state.events).to.deep.equal([ "add", "verdict Rework required" ]);
      expect(test.ui.notifications).to.have.length(1);
      expect([ ...test.ui.choices, ...test.ui.confirms, ...test.ui.infos ]).to.deep.equal([]);
      expect(test.session.canAddMe()).to.equal(false);
    });

    it("asks before setting the status without adding when the Add Me add it waited for fails", async () => {
      const { hold, release } = gate();
      const test = track(await activated({ hold, respond: refuse(NO_REVIEW) }));
      const review = test.session.active!.review;
      const adding = test.session.addMe("wk", review);
      await until(() => test.state.events.length === 1);
      const setting = test.session.setStatus("wk", review, "Rework required");
      await moment();
      release();
      expect(await adding).to.equal(false);
      expect(await setting).to.equal(undefined);
      expect(test.ui.choices.map(choice => [ choice.message, choice.actions ])).to.deep.equal([
        [ "Couldn't add you as a reviewer on review #12831.", [WITHOUT_ADDING]],
      ]);
      expect(test.ui.choices[0].detail).to.equal(NO_REVIEW);
      expect(test.state.events).to.deep.equal(["add"]);
      expect(test.session.canAddMe()).to.equal(true);
    });

    it("answers Add Me with a message while Set Review Status… adds the user", async () => {
      const { hold, release } = gate();
      const test = track(await activated({ hold }));
      const review = test.session.active!.review;
      const setting = test.session.setStatus("wk", review, "Rework required");
      await until(() => test.state.events.length === 1);
      expect(test.session.canAddMe()).to.equal(false);
      expect(await test.session.addMe("wk", review)).to.equal(false);
      expect(test.ui.infos).to.deep.equal([busy]);
      release();
      expect((await setting)?.id).to.equal(BRANCH_REVIEW_ID);
      expect(test.state.events).to.deep.equal([ "add", "verdict Rework required" ]);
    });

    it("sends no second add when Add Me's add ended after Set Review Status…'s plan was made", async () => {
      const { hold, release } = gate();
      const test = track(await activated({ hold }));
      const review = test.session.active!.review;
      const adding = test.session.addMe("wk", review);
      await until(() => test.state.events.length === 1);
      // Set Review Status… from the view's title while the add is in flight: the picker opens with this plan.
      const plan = await test.session.statusPlan("wk", review);
      expect(plan).to.deep.equal({ add: true, current: "Under review", kind: "personal", user: ME });
      release();
      expect(await adding).to.equal(true);
      expect((await test.session.setStatus("wk", review, "Rework required", plan))?.id).to.equal(BRANCH_REVIEW_ID);
      expect(test.state.events).to.deep.equal([ "add", "verdict Rework required" ]);
      expect(test.ui.notifications).to.have.length(1);
      expect([ ...test.ui.choices, ...test.ui.confirms, ...test.ui.errors ]).to.deep.equal([]);
    });
  });

  it("offers Add me as reviewer on the Overview with the session's key, only with the setting on and while it applies",
    async () => {
      const test = track(await activated());
      const addLinks = () => test.links.filter(link => link.target.kind === "addMeAsReviewer");
      const offered = /<p class="add-me"><a href="vscode:\/\/plastic\.test\/link\d+">Add me as reviewer<\/a><\/p>/;
      expect(test.session.overview("wk", BRANCH_REVIEW_ID)).to.match(offered);
      expect(addLinks()).to.deep.equal([{
        key: test.session.linkKey, reviewId: BRANCH_REVIEW_ID, target: { kind: "addMeAsReviewer" }, workspaceId: "wk",
      }]);
      test.setting = false;
      expect(test.session.overview("wk", BRANCH_REVIEW_ID)).to.not.contain("Add me as reviewer");
      test.setting = true;
      await test.session.addMe("wk", test.session.active!.review);
      expect(test.session.overview("wk", BRANCH_REVIEW_ID)).to.not.contain("Add me as reviewer");
      expect(addLinks()).to.have.length(1);
    });
});
