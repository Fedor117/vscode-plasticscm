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
import { fakePostingEditors, memorySecrets, until } from "./editorFixtures";
import { IReviewComment, IReviewDiscussions } from "../../../reviews/models";
import { IReviewSessionUi, IReviewWorkspace, ReviewSession } from "../../../reviews/reviewSession";
import { IWriteRequest, IWriteResponse, ReviewRequestError, ReviewWriter } from "../../../reviews/reviewWriter";
import { expect } from "chai";
import { IReviewLink } from "../../../reviews/reviewLinks";
import { reviewerStates } from "../../../reviews/timeline";
import { ReviewPosting } from "../../../reviews/reviewPosting";
import { ReviewService } from "../../../reviews/reviewService";

/**
 * Add Me as Reviewer and the add that Set Review Status… makes first, on the
 * fixture shell with experimental posting on a writer whose transport is
 * fake: nothing reaches the network, and cm `codereview` calls are counted.
 * Every name, id and token here is made up.
 */

const CONFIG = { cmPath: "cm", millisCommandTimeout: 1000, millisToStop: 1000, millisToWaitUntilUp: 1000 };
const WORKSPACE: IReviewWorkspace = { id: "wk", name: "Nimbus", path: WORKSPACE_ROOT, repository: REPOSITORY };
const OTHER = "sam.rivera@example.com";
const CONNECTION = { organization: "acme-studio", repository: "Nimbus/Nimbus", token: "test-token" };
const SECRET_KEY = `plastic-reviews.experimental:${JSON.stringify([ "wk", REPOSITORY ])}`;
const SET_ANYWAY = "Set Status Anyway";
const CONFIGURE_AND_ADD = "Configure and Add…";
const WITHOUT_ADDING = "Set Status Without Adding";
const DRAFT = {
  changesetId: 1, key: "draft", location: 0, path: "/A.cs", reviewId: 1, revisionId: 1, workspaceId: "wk",
};
const ADDED = {
  body: JSON.stringify({ reviewers: [{ isGroup: false, name: ME, status: "under-review" }] }),
  status: 201,
};

function timeline(id: number, date: string, text: string, owner = OTHER): IReviewComment {
  return comment({
    changesetId: -1, date, guid: `guid-${id}`, id, location: -1, owner, reviewId: BRANCH_REVIEW_ID, revisionId: -1,
    text, type: "timeline",
  });
}

/** The review as the fixture server holds it; the cm user is not its reviewer unless a test says so. */
interface IWorld {
  owner: string;
  assignee: string;
  status: string;
  user: string;
  comments: IReviewComment[];
  /** `add` for every request the writer sends, `codereview <args>` for every status write, in order. */
  events: string[];
  requests: IWriteRequest[];
}

function world(overrides: Partial<IWorld> = {}): IWorld {
  // The scenario's comments without the rows that request the cm user; their verdicts stay.
  const comments = SCENARIO_COMMENTS.filter(row => !/^\[requested-review-from/.test(row.text));
  return { assignee: OTHER, comments, events: [], owner: AUTHOR, requests: [], status: "Under review", user: ME,
    ...overrides };
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
  shell: ReviewShell;
  state: IWorld;
  secrets: ReturnType<typeof memorySecrets>;
  lines: string[];
  links: IReviewLink[];
  configures: number;
  ui: {
    confirms: Array<{ message: string; detail: string }>;
    choices: Array<{ message: string; detail: string; actions: readonly string[] }>;
    errors: string[];
    infos: string[];
    statuses: string[];
    notifications: string[];
    answer: boolean;
    choice?: string;
    configure: boolean;
    cancel?: CancellationTokenSource;
  };
  setting: boolean;
}

type Respond = (call: IWriteRequest, cancel?: CancellationToken) => Promise<IWriteResponse>;

function harness(options: {
  setting?: boolean;
  connection?: boolean;
  state?: Partial<IWorld>;
  /** What the fake service answers; by default it adds the user, as the real one would. */
  respond?: Respond;
  /** The fake service answers only once this resolves; by default it answers at once. */
  hold?: Promise<void>;
} = {}): IHarness {
  const state = world(options.state);
  const shell = new ReviewShell();
  shell.answer = answer(state);
  const lines: string[] = [];
  const channel = { appendLine: (line: string) => lines.push(line) } as unknown as OutputChannel;
  const secrets = memorySecrets(options.connection === false ? {} : { [SECRET_KEY]: JSON.stringify(CONNECTION) });
  const added: Respond = () => {
    // As the service would: the timeline gains the request row.
    state.comments = state.comments.concat(
      timeline(13001, "2026-09-22T17:55:00+01:00", `[requested-review-from]${ME}`, ME));
    return Promise.resolve(ADDED);
  };
  const respond = options.respond ?? added;
  const writer = new ReviewWriter((call, cancel) => {
    state.events.push("add");
    state.requests.push(call);
    return options.hold ? options.hold.then(() => respond(call, cancel)) : respond(call, cancel);
  });
  const test = { configures: 0, lines, links: [] as IReviewLink[], secrets, setting: options.setting ?? true, shell,
    state } as IHarness;
  const posting = new ReviewPosting(secrets, id => (id === "wk" ? REPOSITORY : undefined), fakePostingEditors(DRAFT), {
    setting: () => test.setting, trusted: () => true, writer,
  });
  test.ui = {
    answer: false, choices: [], configure: true, confirms: [], errors: [], infos: [], notifications: [], statuses: [],
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
    progress: (_viewId, task) => task(),
    status: message => {
      test.ui.statuses.push(message);
    },
  };
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
      access: workspaceId => posting.reviewerAccess(workspaceId),
      add: (workspaceId, reviewId, user, cancel) => posting.addReviewer(workspaceId, reviewId, user, cancel),
      // Configure Experimental Posting… without its input boxes: it saves the connection, or is cancelled.
      configure: async () => {
        test.configures++;
        if (test.ui.configure) {
          await secrets.store(SECRET_KEY, JSON.stringify(CONNECTION));
        }
        return test.ui.configure;
      },
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

async function activated(options: Parameters<typeof harness>[0] = {}): Promise<IHarness> {
  const test = harness(options);
  await test.session.activate("wk", BRANCH_REVIEW_ID);
  await test.session.service("wk")!.whoami();
  return test;
}

describe("Add Me as Reviewer and Set Review Status… (fake writer, no network)", () => {
  const sessions: ReviewSession[] = [];
  const track = (test: IHarness): IHarness => {
    sessions.push(test.session);
    return test;
  };
  afterEach(() => sessions.splice(0).forEach(session => session.dispose()));

  it("adds a user who can be added before the status write, then loads the timeline again", async () => {
    const test = track(await activated());
    expect(test.session.canAddMe()).to.equal(true);
    const fresh = await test.session.setStatus("wk", test.session.active!.review, "Rework required");
    expect(fresh?.status).to.equal("Rework required");
    expect(test.state.events).to.deep.equal([ "add", "codereview --status=Rework required" ]);
    expect(test.state.requests[0].url.pathname).to.match(/\/code-reviews\/12831\/reviewers$/);
    expect(JSON.parse(test.state.requests[0].body)).to.deep.equal({ reviewers: [ME] });
    expect(test.ui.notifications).to.deep.equal(["Adding you as a reviewer on review #12831…"]);
    expect([ ...test.ui.choices, ...test.ui.confirms ]).to.deep.equal([]);
    expect(test.ui.statuses).to.deep.equal(["Review #12831 marked Rework required"]);
    // Reloaded: the request row is in the timeline, the reviewer card has it, and the button would hide.
    const me = reviewerStates(discussions(test).timeline, test.session.active!.review).find(row => row.user === ME);
    expect(me?.request?.id).to.equal(13001);
    expect(test.session.canAddMe()).to.equal(false);
    expect(test.lines.join("\n")).not.to.contain("test-token");
  });

  it("asks before setting the status anyway when the add fails, and writes nothing on Cancel", async () => {
    const test = track(await activated({ respond: () => Promise.resolve({ body: "test-token detail", status: 401 }) }));
    const review = test.session.active!.review;
    expect(await test.session.setStatus("wk", review, "Rework required")).to.equal(undefined);
    expect(test.ui.choices).to.deep.equal([{
      actions: [SET_ANYWAY],
      detail: "The review service refused the token: it has expired or lacks permission to change reviewers. " +
        "Unity user tokens are short-lived; set a new one with Configure Experimental Posting… and try again.",
      message: "Couldn't add you as a reviewer on review #12831.",
    }]);
    expect(statusWrites(test)).to.deep.equal([]);
    expect(test.session.active!.review.status).to.equal("Under review");

    test.ui.choice = SET_ANYWAY;
    expect((await test.session.setStatus("wk", review, "Rework required"))?.status).to.equal("Rework required");
    expect(test.state.events).to.deep.equal([ "add", "add", "codereview --status=Rework required" ]);
    expect(test.ui.errors).to.deep.equal([]);
    expect(test.lines.join("\n")).to.contain("Couldn't add you as a reviewer on review #12831")
      .and.not.contain("test-token");
  });

  it("without a connection asks once, and Cancel, Set Status Without Adding and Configure and Add… do what they say",
    async () => {
      const test = track(await activated({ connection: false }));
      const review = () => test.session.active!.review;
      expect(await test.session.setStatus("wk", review(), "Rework required")).to.equal(undefined);
      expect(test.ui.choices).to.deep.equal([{
        actions: [ CONFIGURE_AND_ADD, WITHOUT_ADDING ],
        detail: "Adding yourself needs a Unity user token, which Configure Experimental Posting… saves.",
        message: "You're not a reviewer on #12831. Add yourself first?",
      }]);
      expect(test.state.events).to.deep.equal([]);
      expect(test.configures).to.equal(0);

      test.ui.choice = WITHOUT_ADDING;
      await test.session.setStatus("wk", review(), "Rework required");
      expect(test.state.events).to.deep.equal(["codereview --status=Rework required"]);

      // Configure and Add…, cancelled in the configuration: nothing is written.
      test.ui.choice = CONFIGURE_AND_ADD;
      test.ui.configure = false;
      expect(await test.session.setStatus("wk", review(), "Under review")).to.equal(undefined);
      expect(test.configures).to.equal(1);
      expect(test.state.events).to.have.length(1);

      test.ui.configure = true;
      expect((await test.session.setStatus("wk", review(), "Under review"))?.status).to.equal("Under review");
      expect(test.configures).to.equal(2);
      expect(test.state.events.slice(1)).to.deep.equal([ "add", "codereview --status=Under review" ]);
      expect(test.ui.choices).to.have.length(4);
      expect(test.ui.confirms).to.deep.equal([]);
      expect(test.session.canAddMe()).to.equal(false);
    });

  it("puts the Reviewed warning in the one question when there is no connection", async () => {
    const test = track(await activated({ connection: false }));
    expect(await test.session.setStatus("wk", test.session.active!.review, "Reviewed")).to.equal(undefined);
    expect(test.ui.confirms).to.deep.equal([]);
    expect(test.ui.choices.map(choice => choice.detail)).to.deep.equal([
      "Marking it Reviewed: 1 change request is still pending. 5 of 5 files are not viewed.\n" +
      "Adding yourself needs a Unity user token, which Configure Experimental Posting… saves.",
    ]);
    expect(statusWrites(test)).to.deep.equal([]);
  });

  it("with a connection, adds after the one Reviewed warning, which says so; Cancel writes nothing", async () => {
    const test = track(await activated());
    const review = test.session.active!.review;
    expect(await test.session.setStatus("wk", review, "Reviewed")).to.equal(undefined);
    expect(test.ui.confirms).to.deep.equal([{
      detail: "1 change request is still pending. 5 of 5 files are not viewed. You will be added as a reviewer first.",
      message: "Mark review #12831 as Reviewed?",
    }]);
    expect(test.state.events).to.deep.equal([]);
    test.ui.answer = true;
    expect((await test.session.setStatus("wk", review, "Reviewed"))?.status).to.equal("Reviewed");
    expect(test.state.events).to.deep.equal([ "add", "codereview --status=Reviewed" ]);
    expect(test.ui.choices).to.deep.equal([]);
  });

  it("with the setting off, sets the status as before: no question, no add and no extra cm query", async () => {
    const test = track(await activated({ setting: false }));
    const before = test.shell.calls.length;
    await test.session.setStatus("wk", test.session.active!.review, "Rework required");
    expect(test.shell.calls.slice(before).map(call => `${call.command} ${call.args[0]}`))
      .to.deep.equal([ "codereview -e", "find review" ]);
    expect(test.state.events).to.deep.equal(["codereview --status=Rework required"]);
    expect([ ...test.ui.choices, ...test.ui.confirms ]).to.deep.equal([]);
    expect(test.ui.notifications).to.deep.equal([]);
  });

  it("never adds the author, the assignee or someone already requested", async () => {
    const requested = world().comments.concat(
      timeline(13002, "2026-09-22T16:11:21+01:00", `[requested-review-from]${ME}`));
    for (const state of [{ owner: ME }, { assignee: ME }, { comments: requested }]) {
      const test = track(await activated({ state }));
      expect(test.session.canAddMe(), JSON.stringify(state).substring(0, 40)).to.equal(false);
      await test.session.setStatus("wk", test.session.active!.review, "Rework required");
      expect(test.state.events).to.deep.equal(["codereview --status=Rework required"]);
      expect(test.ui.choices).to.deep.equal([]);
    }
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
    expect(await test.session.setStatus("wk", test.session.active!.review, "Rework required")).to.equal(undefined);
    expect(test.ui.choices).to.deep.equal([{
      actions: [SET_ANYWAY],
      detail: "cm names you \"dana\", which is not an e-mail address, and the review service names reviewers by " +
        "e-mail address.",
      message: "Couldn't add you as a reviewer on review #12831.",
    }]);
    expect(test.state.events).to.deep.equal([]);
    expect(await test.session.addMe("wk", test.session.active!.review)).to.equal(false);
    expect(test.ui.errors).to.deep.equal(["Couldn't add you as a reviewer on review #12831: cm names you \"dana\", " +
      "which is not an e-mail address, and the review service names reviewers by e-mail address."]);
    expect(test.state.requests).to.deep.equal([]);
  });

  it("adds the user with Add Me as Reviewer, loads the discussions again and says so", async () => {
    const test = track(await activated());
    const comments = () => test.shell.queries("changereviewcomment").length;
    const before = comments();
    expect(await test.session.addMe("wk", test.session.active!.review)).to.equal(true);
    expect(test.ui.statuses).to.deep.equal(["$(person-add) Added you as a reviewer on review #12831"]);
    expect(comments()).to.equal(before + 1);
    expect(discussions(test).reviewers).to.include(ME);
    expect(test.session.canAddMe()).to.equal(false);
    expect(statusWrites(test)).to.deep.equal([]);
  });

  it("tells the author, the assignee and a requested reviewer why Add Me as Reviewer does nothing", async () => {
    const requested = world().comments.concat(
      timeline(13002, "2026-09-22T16:11:21+01:00", `[requested-review-from]${ME}`));
    const infos: string[] = [];
    for (const state of [{ owner: ME }, { assignee: ME }, { comments: requested }]) {
      const test = track(await activated({ state }));
      expect(await test.session.addMe("wk", test.session.active!.review)).to.equal(false);
      infos.push(...test.ui.infos);
      expect(test.state.requests).to.deep.equal([]);
    }
    expect(infos).to.deep.equal([
      "You opened review #12831, and authors don't review their own change.",
      "You're the assignee of review #12831, which already makes you a reviewer.",
      "You're already a reviewer on review #12831.",
    ]);
  });

  it("shows a failed Add Me as Reviewer and changes nothing", async () => {
    const test = track(await activated({ respond: () => Promise.resolve({ body: "", status: 404 }) }));
    const before = test.shell.calls.length;
    expect(await test.session.addMe("wk", test.session.active!.review)).to.equal(false);
    expect(test.ui.errors).to.deep.equal(["Couldn't add you as a reviewer on review #12831: The review service has " +
      "no review #12831 in acme-studio / Nimbus/Nimbus. Check both names with Configure Experimental Posting… and " +
      "try again."]);
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

  describe("one add per review in flight", () => {
    /** A gate the fake service waits behind until `release`. */
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
      await until(() => test.state.requests.length === 1);
      expect(test.session.canAddMe()).to.equal(false);
      expect(test.session.overview("wk", BRANCH_REVIEW_ID)).to.not.contain("Add me as reviewer");
      expect(changes).to.be.greaterThan(0);
      const during = changes;
      expect(await test.session.addMe("wk", review)).to.equal(false);
      expect(test.ui.infos).to.deep.equal([busy]);
      release();
      expect(await first).to.equal(true);
      expect(changes).to.be.greaterThan(during);
      expect(test.state.requests).to.have.length(1);
      expect(test.ui.statuses).to.deep.equal(["$(person-add) Added you as a reviewer on review #12831"]);
      expect(test.ui.errors).to.deep.equal([]);
    });

    it("makes Set Review Status… wait for Add Me's add and use it, so the status write follows one request",
      async () => {
        const { hold, release } = gate();
        const test = track(await activated({ hold }));
        const review = test.session.active!.review;
        const adding = test.session.addMe("wk", review);
        await until(() => test.state.requests.length === 1);
        const setting = test.session.setStatus("wk", review, "Rework required");
        await moment();
        expect(test.state.events).to.deep.equal(["add"]);
        release();
        expect(await adding).to.equal(true);
        expect((await setting)?.status).to.equal("Rework required");
        expect(test.state.events).to.deep.equal([ "add", "codereview --status=Rework required" ]);
        expect(test.ui.notifications).to.have.length(1);
        expect([ ...test.ui.choices, ...test.ui.confirms, ...test.ui.infos ]).to.deep.equal([]);
        expect(test.session.canAddMe()).to.equal(false);
      });

    it("asks before setting the status anyway when the Add Me add it waited for fails", async () => {
      const { hold, release } = gate();
      const test = track(await activated({ hold, respond: () => Promise.resolve({ body: "", status: 404 }) }));
      const review = test.session.active!.review;
      const adding = test.session.addMe("wk", review);
      await until(() => test.state.requests.length === 1);
      const setting = test.session.setStatus("wk", review, "Rework required");
      await moment();
      release();
      expect(await adding).to.equal(false);
      expect(await setting).to.equal(undefined);
      expect(test.ui.choices.map(choice => choice.message)).to.deep.equal([
        "Couldn't add you as a reviewer on review #12831.",
      ]);
      expect(test.ui.choices[0].actions).to.deep.equal([SET_ANYWAY]);
      expect(test.ui.choices[0].detail).to.contain("The review service has no review #12831");
      expect(test.state.events).to.deep.equal(["add"]);
      expect(test.session.canAddMe()).to.equal(true);
    });

    it("answers Add Me with a message while Set Review Status… adds the user", async () => {
      const { hold, release } = gate();
      const test = track(await activated({ hold }));
      const review = test.session.active!.review;
      const setting = test.session.setStatus("wk", review, "Rework required");
      await until(() => test.state.requests.length === 1);
      expect(test.session.canAddMe()).to.equal(false);
      expect(await test.session.addMe("wk", review)).to.equal(false);
      expect(test.ui.infos).to.deep.equal([busy]);
      release();
      expect((await setting)?.status).to.equal("Rework required");
      expect(test.state.events).to.deep.equal([ "add", "codereview --status=Rework required" ]);
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
