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
import { CancellationToken, CancellationTokenSource, OutputChannel } from "vscode";
import { cmFailure, FakeTokenCm } from "./tokenFixtures";
import { CONSENT_MESSAGE, consentDetail, ReviewTokens } from "../../../reviews/reviewTokens";
import { fakePostingEditors, memorySecrets, until } from "./editorFixtures";
import { FakeRest, IRestCall, json } from "./restFixtures";
import { IReviewComment, IReviewDiscussions, ReviewStatus } from "../../../reviews/models";
import { IReviewSessionUi, IReviewWorkspace, ReviewSession } from "../../../reviews/reviewSession";
import { IWriteRequest, IWriteResponse, ReviewRequestError, ReviewWriter } from "../../../reviews/reviewWriter";
import { expect } from "chai";
import { IReviewLink } from "../../../reviews/reviewLinks";
import { reviewerStates } from "../../../reviews/timeline";
import { ReviewPosting } from "../../../reviews/reviewPosting";
import { ReviewService } from "../../../reviews/reviewService";

/**
 * Add Me as Reviewer and Set Review Status…, on the fixture shell with
 * experimental posting on a fake cm for tokens and a fake Server REST API:
 * nothing runs cm or reaches the network, and cm `codereview` calls are
 * counted. Every name, id and token here is made up.
 */

const CONFIG = { cmPath: "cm", millisCommandTimeout: 1000, millisToStop: 1000, millisToWaitUntilUp: 1000 };
const WORKSPACE: IReviewWorkspace = { id: "wk", name: "Nimbus", path: WORKSPACE_ROOT, repository: REPOSITORY };
const OTHER = "sam.rivera@example.com";
const SERVER = "acme-studio@unity";
const API = "/api/v1/organizations/acme-studio/repos/Nimbus%2FNimbus/codereview/12831";
const LINK = "plastic://acme-studio@unity/repos/Nimbus/Nimbus/code-reviews/12831";
const ADMIN = "Your organization hasn't enabled personal access tokens for you. An organization admin can allow " +
  `them with: cm accesstoken admin allowlist add --users=${ME} ${SERVER}`;
const DISABLED = "Personal access tokens aren't enabled for acme-studio@unity. Ask an organization admin to enable " +
  "them.";
/** A region `cm getconfig organization` could print that is none of the REST API's documented servers. */
const UNDOCUMENTED = "acme-studio|unity|-1|plastic.example.test";
const SET_ANYWAY = "Set Status Anyway";
const CREATE_AND_ADD = "Create Token and Add";
const CREATE_AND_SET = "Create Token and Set";
const WITHOUT_ADDING = "Set Status Without Adding";
const WITH_CM = "Set Review Status with cm";
const OPEN_IN_DESKTOP = "Open in Unity Version Control";
const COPY_COMMAND = "Copy Command";
const MARKERS: { [status in ReviewStatus]: string } = {
  "Reviewed": "status-reviewed",
  "Rework required": "status-rework-required",
  "Under review": "status-under-review",
};
const DRAFT = {
  changesetId: 1, key: "draft", location: 0, path: "/A.cs", reviewId: 1, revisionId: 1, workspaceId: "wk",
};

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
   * `add` for every add the REST API was sent, `verdict <status>` for every verdict, `codereview <args>` for every
   * status write through cm, in order.
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
  cm: FakeTokenCm;
  rest: FakeRest;
  lines: string[];
  links: IReviewLink[];
  ui: {
    confirms: Array<{ message: string; detail: string }>;
    choices: Array<{ message: string; detail: string; actions: readonly string[] }>;
    alerts: Array<{ message: string; actions: readonly string[] }>;
    errors: string[];
    infos: string[];
    statuses: string[];
    notifications: string[];
    opened: string[];
    copied: string[];
    answer: boolean;
    choice?: string;
    alertChoice?: string;
    cancel?: CancellationTokenSource;
  };
  setting: boolean;
}

type Respond = (call: IWriteRequest, cancel?: CancellationToken) => Promise<IWriteResponse>;

function harness(options: {
  setting?: boolean;
  /** Whether the user agreed to a token before; by default they did. */
  consent?: boolean;
  state?: Partial<IWorld>;
  /** What `cm getconfig organization` prints; by default a documented region. */
  organization?: string;
  /** What the fake REST API answers a write; by default it does what it is asked, as the real one would. */
  respond?: Respond;
  /** The fake REST API answers writes only once this resolves; by default it answers at once. */
  hold?: Promise<void>;
} = {}): IHarness {
  const state = world(options.state);
  const shell = new ReviewShell();
  shell.answer = answer(state);
  const lines: string[] = [];
  const channel = { appendLine: (line: string) => lines.push(line) } as unknown as OutputChannel;
  const cm = new FakeTokenCm();
  if (options.organization) {
    cm.organization = options.organization;
  }
  const rest = new FakeRest();
  // As the service would: an add writes the request row, and a verdict its status row, both as the cm user's own.
  rest.onWrite = call => {
    if (call.path.endsWith("/reviewers")) {
      state.comments = state.comments.concat(
        timeline(13001, "2026-09-22T17:55:00+01:00", `[requested-review-from]${ME}`, ME));
    } else if (call.path.endsWith("/status")) {
      const status = (call.body as { status: ReviewStatus }).status;
      state.comments = state.comments.concat(timeline(13005, "2026-09-22T17:56:00+01:00", `[${MARKERS[status]}]`, ME));
    }
  };
  const writer = new ReviewWriter(async (call, cancel) => {
    if (call.method === "GET") {
      return rest.transport(call, cancel);
    }
    state.events.push(call.method === "POST" ? "add"
      : `verdict ${(JSON.parse(call.body!) as { status: string }).status}`);
    await options.hold;
    return options.respond ? options.respond(call, cancel) : rest.transport(call, cancel);
  });
  const consent = new Map<string, unknown>();
  const tokens = new ReviewTokens(memorySecrets(), {
    get: <T>(key: string) => consent.get(key) as T | undefined,
    update: (key: string, value: unknown) => {
      consent.set(key, value);
      return Promise.resolve();
    },
  }, cm);
  const test = { cm, lines, links: [] as IReviewLink[], rest, setting: options.setting ?? true, shell, state } as
    IHarness;
  test.posting = new ReviewPosting(tokens, {
    repository: id => (id === "wk" ? REPOSITORY : undefined),
    user: id => test.session.service(id)?.whoami() ?? Promise.reject(new Error("No such workspace.")),
  }, fakePostingEditors(DRAFT), { setting: () => test.setting, trusted: () => true, writer });
  if (options.consent !== false) {
    void tokens.consent(SERVER, ME);
  }
  test.ui = {
    alerts: [], answer: false, choices: [], confirms: [], copied: [], errors: [], infos: [], notifications: [],
    opened: [], statuses: [],
  };
  const ui: IReviewSessionUi = {
    alert: (message, actions) => {
      test.ui.alerts.push({ actions, message });
      return Promise.resolve(test.ui.alertChoice);
    },
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
    copy: text => {
      test.ui.copied.push(text);
      return Promise.resolve();
    },
    error: message => {
      test.ui.errors.push(message);
    },
    info: message => {
      test.ui.infos.push(message);
    },
    openExternal: link => {
      test.ui.opened.push(link);
      return Promise.resolve(true);
    },
    progress: (_viewId, task) => task(),
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
      consent: workspaceId => posting.consent(workspaceId),
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

/** What the token cm was asked: `accesstoken` subcommands only. */
function tokenWork(test: IHarness): string[] {
  return test.cm.calls.filter(call => call[0] === "accesstoken").map(call => call[1]);
}

/** From now on cm refuses to create a token, and says `why`. */
function refuseTokens(test: IHarness, why: string): void {
  test.cm.answer = args => (args[1] === "create" ? cmFailure(why) : undefined);
}

/** Each write the REST API received, as `METHOD path-after-the-review`. */
function restWrites(test: IHarness): string[] {
  return test.rest.writes().map((call: IRestCall) => `${call.method} ${call.path.substring(API.length)}`);
}

async function activated(options: Parameters<typeof harness>[0] = {}): Promise<IHarness> {
  const test = harness(options);
  await test.session.activate("wk", BRANCH_REVIEW_ID);
  await test.session.service("wk")!.whoami();
  return test;
}

describe("Add Me as Reviewer and Set Review Status… (fake cm and REST API, no network)", () => {
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
    it("adds a user who can be added, then gives their own verdict through the REST API and reads the review back",
      async () => {
        const test = track(await activated());
        expect(test.session.canAddMe()).to.equal(true);
        // As the service might: the verdict changes the review's status, which only cm's read-back shows here.
        const write = test.rest.onWrite;
        test.rest.onWrite = call => {
          write?.(call);
          test.state.status = call.path.endsWith("/status") ? "Rework required" : test.state.status;
        };
        const fresh = await test.session.setStatus("wk", test.session.active!.review, "Rework required");
        expect([ fresh?.id, fresh?.status ]).to.deep.equal([ BRANCH_REVIEW_ID, "Rework required" ]);
        expect(test.session.active!.review.status).to.equal("Rework required");
        expect(test.state.events).to.deep.equal([ "add", "verdict Rework required" ]);
        expect(restWrites(test))
          .to.deep.equal([ "POST /reviewers", `PUT /reviewers/${encodeURIComponent(ME)}/status` ]);
        expect(test.rest.writes().map(call => call.body)).to.deep.equal([
          { reviewers: [ME] }, { status: "Rework required" },
        ]);
        expect(statusWrites(test)).to.deep.equal([]);
        expect(test.ui.notifications).to.deep.equal(["Adding you as a reviewer on review #12831…"]);
        expect([ ...test.ui.choices, ...test.ui.confirms ]).to.deep.equal([]);
        expect(test.ui.statuses).to.deep.equal(["Your status on review #12831: Rework required"]);
        // Reloaded: the request and verdict rows are in the timeline, the card has both, and the button would hide.
        const me = reviewerStates(discussions(test).timeline, test.session.active!.review).find(row => row.user === ME);
        expect([ me?.request?.id, me?.verdict?.id, me?.state ]).to.deep.equal([ 13001, 13005, "reworkRequired" ]);
        expect(test.session.canAddMe()).to.equal(false);
        expect(tokenWork(test)).to.deep.equal([ "create", "reveal" ]);
        for (const token of test.cm.revealed) {
          expect(test.lines.join("\n")).not.to.contain(token);
        }
      });

    it("gives a requested reviewer's verdict through the REST API without a question, and adds no one", async () => {
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
      expect(test.ui.choices).to.deep.equal([]);
      expect(test.ui.notifications).to.deep.equal([]);
      expect(test.ui.statuses).to.deep.equal(["Your status on review #12831: Reviewed"]);
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

    it("sets the status with cm for the author and the assignee, with no token work", async () => {
      for (const people of [{ owner: ME }, { assignee: ME }]) {
        const test = track(await activated({ state: people }));
        expect(test.session.canAddMe()).to.equal(false);
        await test.session.setStatus("wk", test.session.active!.review, "Rework required");
        expect(test.state.events, JSON.stringify(people)).to.deep.equal(["codereview --status=Rework required"]);
        expect(test.ui.choices).to.deep.equal([]);
        expect(tokenWork(test)).to.deep.equal([]);
        expect(test.rest.calls).to.deep.equal([]);
      }
    });

    it("with the setting off, sets the status as before: no question, no add, no token and no extra cm query",
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

    it("without a token asks once to create one and add, or to set the status with cm, which needs no token",
      async () => {
        const test = track(await activated({ consent: false }));
        const review = () => test.session.active!.review;
        expect(await test.session.setStatus("wk", review(), "Rework required")).to.equal(undefined);
        expect(test.ui.choices).to.deep.equal([{
          actions: [ CREATE_AND_ADD, WITHOUT_ADDING ],
          detail: `Adding yourself needs a personal access token. ${consentDetail(SERVER)}`,
          message: "You're not a reviewer on #12831. Add yourself first?",
        }]);
        expect(test.state.events).to.deep.equal([]);

        test.ui.choice = WITHOUT_ADDING;
        await test.session.setStatus("wk", review(), "Rework required");
        expect(test.state.events).to.deep.equal(["codereview --status=Rework required"]);
        expect(tokenWork(test)).to.deep.equal([]);
        expect(test.rest.calls).to.deep.equal([]);

        test.ui.choice = CREATE_AND_ADD;
        expect((await test.session.setStatus("wk", review(), "Rework required"))?.id).to.equal(BRANCH_REVIEW_ID);
        expect(test.state.events.slice(1)).to.deep.equal([ "add", "verdict Rework required" ]);
        expect(tokenWork(test)).to.deep.equal([ "create", "reveal" ]);
        expect(test.ui.choices).to.have.length(3);
        expect(test.ui.confirms).to.deep.equal([]);
        expect(test.session.canAddMe()).to.equal(false);
      });

    it("puts the Reviewed warning in the one question when there is no token", async () => {
      const test = track(await activated({ consent: false }));
      expect(await test.session.setStatus("wk", test.session.active!.review, "Reviewed")).to.equal(undefined);
      expect(test.ui.confirms).to.deep.equal([]);
      expect(test.ui.choices.map(choice => choice.detail)).to.deep.equal([
        "Marking it Reviewed: 1 change request is still pending. 5 of 5 files are not viewed.\n" +
        `Adding yourself needs a personal access token. ${consentDetail(SERVER)}`,
      ]);
      expect(statusWrites(test)).to.deep.equal([]);
    });

    it("asks a requested reviewer without a token whether to create one, or to set the review's status with cm",
      async () => {
        const test = track(await activated({ consent: false, state: { comments: world().comments.concat(REQUESTED) }}));
        const review = () => test.session.active!.review;
        test.ui.choice = WITH_CM;
        await test.session.setStatus("wk", review(), "Rework required");
        expect(test.ui.choices).to.deep.equal([{
          actions: [ CREATE_AND_SET, WITH_CM ],
          detail: `Your own status needs a personal access token. ${consentDetail(SERVER)}`,
          message: "Set your own status on #12831?",
        }]);
        expect(test.state.events).to.deep.equal(["codereview --status=Rework required"]);
        expect(tokenWork(test)).to.deep.equal([]);

        test.ui.choice = CREATE_AND_SET;
        await test.session.setStatus("wk", review(), "Rework required");
        expect(test.state.events.slice(1)).to.deep.equal(["verdict Rework required"]);
        expect(tokenWork(test)).to.deep.equal([ "create", "reveal" ]);
      });

    it("where cm may not create a token, offers the status with cm or the desktop app, from the first try on",
      async () => {
        const test = track(await activated());
        refuseTokens(test, "You don't have permission to create personal access tokens.");
        const review = () => test.session.active!.review;
        const refused = {
          actions: [ WITHOUT_ADDING, OPEN_IN_DESKTOP ], detail: ADMIN,
          message: "Couldn't add you as a reviewer on review #12831.",
        };
        // The first try learns it from cm, when the add asks for the token, and asks as later tries do.
        expect(await test.session.setStatus("wk", review(), "Rework required")).to.equal(undefined);
        expect(test.ui.choices).to.deep.equal([refused]);
        expect(test.state.events).to.deep.equal([]);
        expect(test.ui.errors).to.deep.equal([]);
        test.ui.choice = OPEN_IN_DESKTOP;
        expect(await test.session.setStatus("wk", review(), "Rework required")).to.equal(undefined);
        expect(test.ui.choices).to.deep.equal([ refused, refused ]);
        expect(test.ui.opened).to.deep.equal([LINK]);
        expect(test.state.events).to.deep.equal([]);
        test.ui.choice = WITHOUT_ADDING;
        await test.session.setStatus("wk", review(), "Rework required");
        expect(test.state.events).to.deep.equal(["codereview --status=Rework required"]);
        expect(tokenWork(test)).to.deep.equal(["create"]);
        expect(test.rest.calls).to.deep.equal([]);
      });

    it("offers the first time Set Status Without Adding when cm refuses the token for the add", async () => {
      const test = track(await activated());
      refuseTokens(test, "Personal access tokens are not enabled.");
      test.ui.choice = WITHOUT_ADDING;
      expect((await test.session.setStatus("wk", test.session.active!.review, "Rework required"))?.status)
        .to.equal("Rework required");
      expect(test.ui.choices.map(choice => [ choice.detail, choice.actions ])).to.deep.equal([
        [ DISABLED, [ WITHOUT_ADDING, OPEN_IN_DESKTOP ]],
      ]);
      expect(test.state.events).to.deep.equal(["codereview --status=Rework required"]);
    });

    it("offers a requested reviewer the status with cm when cm refuses the token, then uses cm unasked", async () => {
      const test = track(await activated({ state: { comments: world().comments.concat(REQUESTED) }}));
      refuseTokens(test, "Personal access tokens are not enabled.");
      const review = () => test.session.active!.review;
      const message = "Couldn't set your own status on review #12831.";
      const refused = { actions: [ WITH_CM, OPEN_IN_DESKTOP ], detail: DISABLED, message };
      // The first try learns it from cm: nothing is written unless the user picks cm.
      expect(await test.session.setStatus("wk", review(), "Rework required")).to.equal(undefined);
      expect(test.ui.choices).to.deep.equal([refused]);
      expect(test.state.events).to.deep.equal([]);
      // Picked before cm refused, the personal route still offers cm.
      test.ui.choice = WITH_CM;
      expect((await test.session.setStatus("wk", review(), "Rework required", {
        add: false, current: "Under review", kind: "personal", user: ME,
      }))?.status).to.equal("Rework required");
      expect(test.ui.choices).to.deep.equal([ refused, refused ]);
      expect(test.ui.errors).to.deep.equal([]);
      expect(test.state.events).to.deep.equal(["codereview --status=Rework required"]);
      // Known now: the review's status with cm, unasked.
      expect(await test.session.statusPlan("wk", review())).to.deep.equal({ current: "Rework required", kind: "cm" });
      await test.session.setStatus("wk", review(), "Under review");
      expect(test.state.events.slice(1)).to.deep.equal(["codereview --status=Under review"]);
      expect(test.ui.choices).to.have.length(2);
      expect(tokenWork(test)).to.deep.equal(["create"]);
    });

    it("sets the status with cm, unasked and with no token work, where the region is not a documented server",
      async () => {
        const test = track(await activated({ organization: UNDOCUMENTED }));
        const review = () => test.session.active!.review;
        expect(await test.session.statusPlan("wk", review())).to.deep.equal({ current: "Under review", kind: "cm" });
        await test.session.setStatus("wk", review(), "Rework required");
        expect(test.state.events).to.deep.equal(["codereview --status=Rework required"]);
        expect([ ...test.ui.choices, ...test.ui.confirms ]).to.deep.equal([]);
        expect(tokenWork(test)).to.deep.equal([]);
        expect(test.rest.calls).to.deep.equal([]);
      });

    it("asks before setting the status with cm when the add fails for sure, and writes nothing on Cancel",
      async () => {
        const test = track(await activated({ respond: () => Promise.resolve(json(404, {})) }));
        const review = test.session.active!.review;
        expect(await test.session.setStatus("wk", review, "Rework required")).to.equal(undefined);
        expect(test.ui.choices).to.deep.equal([{
          actions: [SET_ANYWAY],
          detail: "The Unity Version Control server has no review #12831 in Nimbus/Nimbus.",
          message: "Couldn't add you as a reviewer on review #12831.",
        }]);
        expect(statusWrites(test)).to.deep.equal([]);
        expect(test.session.active!.review.status).to.equal("Under review");

        test.ui.choice = SET_ANYWAY;
        expect((await test.session.setStatus("wk", review, "Rework required"))?.status).to.equal("Rework required");
        expect(test.state.events).to.deep.equal([ "add", "add", "codereview --status=Rework required" ]);
        expect(test.ui.errors).to.deep.equal([]);
        expect(test.lines.join("\n")).to.contain("Couldn't add you as a reviewer on review #12831");
      });

    it("stops with an error, and writes no status, when the add's result is unknown", async () => {
      const test = track(await activated({ respond: () => Promise.resolve(json(503, {})) }));
      expect(await test.session.setStatus("wk", test.session.active!.review, "Rework required")).to.equal(undefined);
      expect(test.ui.errors).to.deep.equal(["Couldn't add you as a reviewer on review #12831: The Unity Version " +
        "Control server returned HTTP 503. You may have been added; refresh the review before retrying."]);
      expect(test.ui.choices).to.deep.equal([]);
      expect(test.state.events).to.deep.equal(["add"]);
    });

    it("with a token, adds after the one Reviewed warning, which says so; Cancel writes nothing", async () => {
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

    it("stops without a word when the add is cancelled, and writes nothing", async () => {
      const test = track(await activated({
        respond: (_call, cancel) => new Promise((_resolve, reject) => {
          cancel!.onCancellationRequested(() => reject(new ReviewRequestError("cancelled", true)));
        }),
      }));
      const setting = test.session.setStatus("wk", test.session.active!.review, "Rework required");
      await until(() => test.state.events.includes("add"));
      test.ui.cancel!.cancel();
      expect(await setting).to.equal(undefined);
      expect(test.state.events).to.deep.equal(["add"]);
      expect([ ...test.ui.choices, ...test.ui.confirms ]).to.deep.equal([]);
      expect(test.ui.errors).to.deep.equal([]);
    });

    it("does not guess an address for a cm user that is not an e-mail address", async () => {
      const test = track(await activated({ state: { user: "dana" }}));
      const why = "cm names you \"dana\", which is not an e-mail address, and Unity Version Control names reviewers " +
        "by e-mail address.";
      expect(await test.session.setStatus("wk", test.session.active!.review, "Rework required")).to.equal(undefined);
      expect(test.ui.choices).to.deep.equal([{
        actions: [SET_ANYWAY], detail: why, message: "Couldn't add you as a reviewer on review #12831.",
      }]);
      expect(test.state.events).to.deep.equal([]);
      expect(await test.session.addMe("wk", test.session.active!.review)).to.equal(false);
      expect(test.ui.errors).to.deep.equal([`Couldn't add you as a reviewer on review #12831: ${why}`]);
      expect(test.rest.calls).to.deep.equal([]);
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
      expect(restWrites(test)).to.deep.equal(["POST /reviewers"]);
    });

    it("asks to create a token first when there is none, and sends nothing when declined", async () => {
      const test = track(await activated({ consent: false }));
      const review = test.session.active!.review;
      expect(await test.session.addMe("wk", review)).to.equal(false);
      expect(test.ui.choices).to.deep.equal([{
        actions: [CREATE_AND_ADD], detail: consentDetail(SERVER), message: CONSENT_MESSAGE,
      }]);
      expect(tokenWork(test)).to.deep.equal([]);
      expect(test.rest.calls).to.deep.equal([]);
      expect(test.session.canAddMe()).to.equal(true);

      test.ui.choice = CREATE_AND_ADD;
      expect(await test.session.addMe("wk", review)).to.equal(true);
      expect(tokenWork(test)).to.deep.equal([ "create", "reveal" ]);
      expect(restWrites(test)).to.deep.equal(["POST /reviewers"]);
    });

    it("says what an admin can do where cm may not create a token, with the command and the desktop app at hand",
      async () => {
        const test = track(await activated());
        refuseTokens(test, "You don't have permission to create personal access tokens.");
        const review = test.session.active!.review;
        const message = `Couldn't add you as a reviewer on review #12831: ${ADMIN}`;
        const refused = { actions: [ COPY_COMMAND, OPEN_IN_DESKTOP ], message };
        // The first add learns it from cm, and says so as the later ones do.
        test.ui.alertChoice = COPY_COMMAND;
        expect(await test.session.addMe("wk", review)).to.equal(false);
        await until(() => test.ui.copied.length > 0);
        expect(test.ui.errors).to.deep.equal([]);
        expect(test.ui.alerts).to.deep.equal([refused]);
        expect(test.ui.copied).to.deep.equal([`cm accesstoken admin allowlist add --users=${ME} ${SERVER}`]);
        test.ui.alertChoice = OPEN_IN_DESKTOP;
        expect(await test.session.addMe("wk", review)).to.equal(false);
        await until(() => test.ui.opened.length > 0);
        expect(test.ui.alerts).to.deep.equal([ refused, refused ]);
        expect(test.ui.opened).to.deep.equal([LINK]);
        expect(tokenWork(test)).to.deep.equal(["create"]);
        expect(test.rest.calls).to.deep.equal([]);
      });

    it("offers only the desktop app where personal access tokens are not enabled", async () => {
      const test = track(await activated());
      refuseTokens(test, "Personal access tokens are not enabled.");
      const review = test.session.active!.review;
      await test.session.addMe("wk", review);
      await test.session.addMe("wk", review);
      expect(test.ui.alerts.map(alert => alert.actions)).to.deep.equal([[OPEN_IN_DESKTOP], [OPEN_IN_DESKTOP]]);
      expect(test.ui.alerts[0].message).to.equal(`Couldn't add you as a reviewer on review #12831: ${DISABLED}`);
      expect(test.ui.errors).to.deep.equal([]);
    });

    it("says why, and sends nothing, where the region is not a documented server", async () => {
      const test = track(await activated({ organization: UNDOCUMENTED }));
      expect(await test.session.addMe("wk", test.session.active!.review)).to.equal(false);
      expect(test.ui.errors).to.deep.equal(["Couldn't add you as a reviewer on review #12831: The Unity Version " +
        "Control Server REST API documents no server for acme-studio@unity, whose region is " +
        "\"plastic.example.test\"."]);
      expect([ ...test.ui.choices, ...test.ui.alerts ]).to.deep.equal([]);
      expect(tokenWork(test)).to.deep.equal([]);
      expect(test.rest.calls).to.deep.equal([]);
    });

    it("tells the author, the assignee and a requested reviewer why it does nothing", async () => {
      const infos: string[] = [];
      for (const state of [{ owner: ME }, { assignee: ME }, { comments: world().comments.concat(REQUESTED) }]) {
        const test = track(await activated({ state }));
        expect(await test.session.addMe("wk", test.session.active!.review)).to.equal(false);
        infos.push(...test.ui.infos);
        expect(test.rest.calls).to.deep.equal([]);
      }
      expect(infos).to.deep.equal([
        "You opened review #12831, and authors don't review their own change.",
        "You're the assignee of review #12831, which already makes you a reviewer.",
        "You're already a reviewer on review #12831.",
      ]);
    });

    it("shows a failed add and changes nothing", async () => {
      const test = track(await activated({ respond: () => Promise.resolve(json(404, {})) }));
      const before = test.shell.calls.length;
      expect(await test.session.addMe("wk", test.session.active!.review)).to.equal(false);
      expect(test.ui.errors).to.deep.equal(["Couldn't add you as a reviewer on review #12831: The Unity Version " +
        "Control server has no review #12831 in Nimbus/Nimbus."]);
      expect(test.ui.statuses).to.deep.equal([]);
      expect(test.shell.calls.slice(before)).to.deep.equal([]);
      expect(test.session.canAddMe()).to.equal(true);
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
    /** A gate the fake REST API waits behind until `release`. */
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

    it("asks before setting the status with cm anyway when the Add Me add it waited for fails", async () => {
      const { hold, release } = gate();
      const test = track(await activated({ hold, respond: () => Promise.resolve(json(404, {})) }));
      const review = test.session.active!.review;
      const adding = test.session.addMe("wk", review);
      await until(() => test.state.events.length === 1);
      const setting = test.session.setStatus("wk", review, "Rework required");
      await moment();
      release();
      expect(await adding).to.equal(false);
      expect(await setting).to.equal(undefined);
      expect(test.ui.choices.map(choice => [ choice.message, choice.actions ])).to.deep.equal([
        [ "Couldn't add you as a reviewer on review #12831.", [SET_ANYWAY]],
      ]);
      expect(test.ui.choices[0].detail).to.contain("has no review #12831");
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
