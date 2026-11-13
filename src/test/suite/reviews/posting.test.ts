import { Comment, CommentThread, EventEmitter, Uri } from "vscode";
import { commentGuid, exited, FakeCm, OLD_USAGE } from "./cmFixtures";
import { fakePostingEditors, fakeThread, IFakePostingEditors, memorySecrets, until } from "./editorFixtures";
import { IReviewDraft, ReviewWriter } from "../../../reviews/reviewWriter";
import { ISettingInspector, ReviewPosting, writesSettingOn } from "../../../reviews/reviewPosting";
import { expect } from "chai";

/**
 * Comments and replies with cm, on a fake runner: nothing runs cm or reaches
 * a server. Every repository, review, revision and GUID is made up.
 */

const REPOSITORY = "Nimbus/Nimbus@acme-studio@unity";
const ROOT = "/work/nimbus";
const PARENT = "5a1e0000-1111-4222-8333-444455556666";
const draft: IReviewDraft = {
  key: "draft-one",
  location: 4,
  path: "/Code/Test.cs",
  reviewId: 12831,
  revisionId: 42,
  workspaceId: "workspace",
};
const replyTarget: IReviewDraft = { ...draft, key: "", parentGuid: PARENT };
const uri = Uri.from({ path: "/Code/Test.cs", query: "{}", scheme: "plastic-review" });
const ADD = [
  "codereview", "comment", "add", "12831", "-commentsfile=-", "--revision=revid:42", "--line=5", "--type=Comment",
];

describe("Native posting (fake cm)", () => {
  let editors: IFakePostingEditors;
  let posting: ReviewPosting;
  let cm: FakeCm;
  let secrets: ReturnType<typeof memorySecrets>;
  /** The draft key of every comment or reply cm was run for, in order. */
  let keys: string[];
  let confirms: Array<{ message: string; detail: string }>;
  let confirmAnswer: boolean;
  let notices: string[];
  /** Every reload of a review's discussions posting asked for. */
  let reloads: Array<[string, number]>;
  let setting: boolean;
  let trusted: boolean;
  let repository: string | undefined;
  let root: string | undefined;
  let log: string[];
  /** Stands for VS Code's configuration changes. */
  let configuration: EventEmitter<{ affectsConfiguration(section: string): boolean }>;
  const changed = (section: string) => configuration.fire({ affectsConfiguration: name => name === section });

  const create = (fake: FakeCm, postingEditors = editors): ReviewPosting => {
    const writer = new ReviewWriter({
      cmPath: () => "cm", log: message => log.push(message), platform: "linux", run: fake.run,
    });
    const send = writer.send.bind(writer);
    writer.send = async (cwd, sent, text, cancel) => {
      const before = fake.writes().length;
      try {
        return await send(cwd, sent, text, cancel);
      } finally {
        if (fake.writes().length > before) {
          keys.push(sent.key);
        }
      }
    };
    return new ReviewPosting(writer, {
      reloadDiscussions: (workspaceId, reviewId) => {
        reloads.push([ workspaceId, reviewId ]);
        return Promise.resolve();
      },
      repository: workspaceId => (workspaceId === "workspace" ? repository : undefined),
      root: workspaceId => (workspaceId === "workspace" ? root : undefined),
    }, postingEditors, {
      configurationChanges: configuration.event,
      confirm: (message, detail) => {
        confirms.push({ detail, message });
        return Promise.resolve(confirmAnswer);
      },
      notify: message => notices.push(message),
      secrets,
      setting: () => setting,
      trusted: () => trusted,
    });
  };

  beforeEach(async () => {
    configuration = new EventEmitter();
    editors = fakePostingEditors(draft);
    cm = new FakeCm();
    secrets = memorySecrets();
    keys = [];
    confirms = [];
    confirmAnswer = true;
    notices = [];
    reloads = [];
    log = [];
    setting = true;
    trusted = true;
    repository = REPOSITORY;
    root = ROOT;
    posting = create(cm);
    await posting.select("workspace");
  });
  afterEach(() => {
    posting.dispose();
    configuration.dispose();
  });

  it("posts a new comment with cm after the modal, then reloads the review's discussions", async () => {
    const thread = fakeThread(uri, 4);
    await posting.postComment({ text: "Off by one?\nSee line 3.", thread });
    expect(cm.writes()).to.deep.equal([{ args: ADD, cmPath: "cm", cwd: ROOT, stdin: "Off by one?\nSee line 3." }]);
    expect(confirms[0].message).to.equal("Post this comment to review #12831?");
    expect(confirms[0].detail.split("\n")).to.deep.equal([
      "Destination: acme-studio@unity through cm, as the user cm is signed in as",
      "File: /Code/Test.cs, line 5, revision 42",
    ]);
    expect(thread.comments).to.have.length(1);
    expect(thread.comments[0]).to.include({
      body: "Off by one?\nSee line 3.", contextValue: "reviewLocal-posted", label: "Posted",
    });
    expect(thread.comments[0].author.name).to.equal("You");
    expect(editors.adopted).to.deep.equal([thread]);
    expect(thread.canReply).to.equal(false);
    expect(reloads).to.deep.equal([[ "workspace", 12831 ]]);
    // The reload's thread refresh drops it: the server's row shows the comment from then on.
    expect(editors.keepLocalComment(thread.comments[0])).to.equal(false);
  });

  it("names the changeset for a draft written in one changeset's diff", async () => {
    editors.draftAt = (_uri, line) => Promise.resolve({ ...draft, changesetId: 3715, location: line });
    await posting.postComment({ text: "Here", thread: fakeThread(uri, 9) });
    expect(cm.writes()[0].args).to.deep.equal([
      "codereview", "comment", "add", "12831", "-commentsfile=-", "--revision=revid:42", "--line=10",
      "--changeset=cs:3715", "--type=Comment",
    ]);
  });

  it("sends nothing when the modal is cancelled", async () => {
    confirmAnswer = false;
    const thread = fakeThread(uri, 4);
    await posting.postComment({ text: "Never mind", thread });
    expect(confirms).to.have.length(1);
    expect(cm.writes()).to.have.length(0);
    expect(thread.comments).to.have.length(0);
    expect(editors.adopted).to.have.length(0);
    expect(reloads).to.deep.equal([]);
  });

  it("takes a reply's draft from its review thread, replies to the parent's GUID and reloads", async () => {
    const thread = fakeThread(uri, 4, [{ author: { name: "priya" }, body: "Why?", mode: 1 }]);
    editors.replies.set(thread, replyTarget);
    await posting.postReply({ text: "Because.", thread });
    expect(cm.writes()).to.deep.equal([{
      args: [ "codereview", "comment", "reply", PARENT, "-commentsfile=-" ], cmPath: "cm", cwd: ROOT,
      stdin: "Because.",
    }]);
    expect(confirms[0].message).to.equal("Post this reply to review #12831?");
    expect(confirms[0].detail.split("\n")).to.deep.equal([
      "Destination: acme-studio@unity through cm, as the user cm is signed in as",
      "Reply in the discussion on /Code/Test.cs, line 5",
    ]);
    expect(thread.comments[1]).to.include({ contextValue: "reviewLocal-posted", label: "Posted" });
    expect(editors.adopted).to.have.length(0);
    expect(reloads).to.deep.equal([[ "workspace", 12831 ]]);
  });

  it("refuses to reply in a thread that was not loaded from the review, or has no GUID yet", async () => {
    await posting.postReply({ text: "Hello", thread: fakeThread(uri) });
    expect(notices[0]).to.contain("Only threads loaded from the review");
    const thread = fakeThread(uri, 4, [{ author: { name: "priya" }, body: "Why?", mode: 1 }]);
    editors.replies.set(thread, { ...replyTarget, parentGuid: "" });
    await posting.postReply({ text: "Hello", thread });
    expect(thread.comments[1].label).to.equal("Not sent: This discussion cannot be replied to yet. Refresh the " +
      "review first.");
    expect(cm.writes()).to.have.length(0);
  });

  it("keeps a comment cm refused, with cm's message, and sends it again with the same key", async () => {
    cm.answer = () => exited(1, "", "Error: The revision revid:42 is not in the diff\nof the code review.\n");
    const thread = fakeThread(uri, 4);
    await posting.postComment({ text: "Keep this text", thread });
    const local = thread.comments[0];
    expect(local.contextValue).to.equal("reviewLocal-failed");
    expect(local.label).to.equal("Not sent: The revision revid:42 is not in the diff of the code review.");
    expect(local.body).to.equal("Keep this text");
    expect(editors.keepLocalComment(local)).to.equal(true);
    expect(reloads).to.deep.equal([]);
    cm.answer = undefined;
    await posting.sendAgain(local);
    expect(keys).to.have.length(2);
    expect(keys[1]).to.equal(keys[0]);
    expect(local.contextValue).to.equal("reviewLocal-posted");
    expect(reloads).to.have.length(1);
    await posting.sendAgain(local);
    expect(keys).to.have.length(2);
    expect(cm.writes().map(call => call.stdin)).to.deep.equal([ "Keep this text", "Keep this text" ]);
  });

  it("requires Allow Another Attempt after an unknown result, which takes a new key", async () => {
    cm.answer = () => ({ code: undefined, killed: "timeout", started: true, stderr: "", stdout: "" });
    const thread = fakeThread(uri, 4);
    await posting.postComment({ text: "Maybe sent", thread });
    const local = thread.comments[0];
    expect(local).to.include({
      contextValue: "reviewLocal-uncertain", label: "Result unknown: check the review before retrying",
    });
    expect(reloads).to.deep.equal([]);
    await posting.sendAgain(local);
    expect(keys).to.have.length(1);
    posting.allowRetry(local);
    expect(local.contextValue).to.equal("reviewLocal-failed");
    expect(local.label).to.contain("duplicate");
    cm.answer = undefined;
    await posting.sendAgain(local);
    expect(keys).to.have.length(2);
    expect(keys[1]).not.to.equal(keys[0]);
    expect(local.contextValue).to.equal("reviewLocal-posted");
  });

  it("does not know the result when cm exits cleanly without naming the comment", async () => {
    cm.answer = () => exited(0, "");
    const thread = fakeThread(uri, 4);
    await posting.postComment({ text: "Maybe sent", thread });
    expect(thread.comments[0].contextValue).to.equal("reviewLocal-uncertain");
  });

  it("blocks a second reply while one is sending, and an identical reply once sent", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    cm.answer = () => held.then(() => undefined);
    const thread = fakeThread(uri, 4, [{ author: { name: "priya" }, body: "Why?", mode: 1 }]);
    editors.replies.set(thread, replyTarget);
    const first = posting.postReply({ text: "Because.", thread });
    await new Promise(resolve => setTimeout(resolve, 10));
    await posting.postReply({ text: "Because!", thread });
    expect(notices[0]).to.contain("still being sent");
    release();
    await first;
    await posting.postReply({ text: "Because.", thread });
    expect(notices[1]).to.contain("already sent");
    expect(cm.writes()).to.have.length(1);
  });

  it("never posts without the setting, a trusted workspace, a known repository and the workspace's folder",
    async () => {
      const attempts: Array<[string, () => void]> = [
        [ "setting", () => {
          setting = false;
        } ],
        [ "trusted workspace", () => {
          trusted = false;
        } ],
        [ "repository is not known yet", () => {
          repository = undefined;
        } ],
        [ "no longer available", () => {
          root = undefined;
        } ],
      ];
      for (const [ reason, apply ] of attempts) {
        setting = true;
        trusted = true;
        repository = REPOSITORY;
        root = ROOT;
        apply();
        expect(posting.enabled, reason).to.equal(false);
        const thread = fakeThread(uri, 4);
        await posting.postComment({ text: "Hello", thread });
        expect(thread.comments).to.have.length(0);
        expect(notices[notices.length - 1]).to.contain(reason);
      }
      setting = true;
      trusted = true;
      repository = REPOSITORY;
      root = ROOT;
      expect(posting.enabled).to.equal(true);
      expect(cm.writes()).to.have.length(0);
      expect(confirms).to.have.length(0);
    });

  it("is ready for any server cm works with, cloud or not", async () => {
    repository = "Nimbus@plastic.example.test:8087";
    expect(await posting.access("workspace")).to.deep.equal({ state: "ready" });
    await posting.postComment({ text: "Hello", thread: fakeThread(uri, 4) });
    expect(confirms[0].detail).to.contain("Destination: plastic.example.test:8087 through cm");
    expect(cm.writes()).to.have.length(1);
  });

  it("learns the access by asking cm for its usage once, and with the setting off not at all", async () => {
    expect(await posting.access("workspace")).to.deep.equal({ state: "ready" });
    await posting.refresh();
    expect(cm.calls.map(call => call.args)).to.deep.equal([[ "codereview", "comment", "--usage" ]]);

    const off = new FakeCm();
    setting = false;
    const other = create(off, fakePostingEditors(draft));
    try {
      await other.select("workspace");
      expect(await other.access("workspace")).to.deep.equal({ state: "settingOff" });
      expect(other.enabled).to.equal(false);
      expect(off.calls).to.deep.equal([]);
    } finally {
      other.dispose();
    }
  });

  it("is blocked with a cm older than the comment commands, and says which client is needed", async () => {
    const old = new FakeCm();
    old.usage = exited(0, OLD_USAGE);
    const other = create(old, fakePostingEditors(draft));
    try {
      await other.select("workspace");
      const reason = "Review writes need Unity Version Control client 11.0.16.10512 or newer.";
      expect(await other.access("workspace")).to.deep.equal({ reason, state: "blocked" });
      expect(other.enabled).to.equal(false);
      await other.postComment({ text: "Hello", thread: fakeThread(uri, 4) });
      expect(notices).to.deep.equal([reason]);
      expect(confirms).to.deep.equal([]);
      expect(old.writes()).to.deep.equal([]);
    } finally {
      other.dispose();
    }
  });

  it("asks cm again when the cm settings change, and finds a client upgraded in place", async () => {
    const upgraded = new FakeCm();
    upgraded.usage = exited(0, OLD_USAGE);
    const otherEditors = fakePostingEditors(draft);
    const other = create(upgraded, otherEditors);
    try {
      await other.select("workspace");
      expect(other.enabled).to.equal(false);
      // Same path, newer client: a no is not kept, so the next look finds it.
      upgraded.usage = exited(0, "    - add | mk\n    - reply\n");
      changed("plastic-scm.cmConfiguration");
      await until(() => other.enabled);
      expect(otherEditors.enabled[otherEditors.enabled.length - 1]).to.equal(true);
      expect(upgraded.probes()).to.have.length(2);
      // A yes is kept until the cm settings change; then cm is asked again.
      await other.refresh();
      expect(upgraded.probes()).to.have.length(2);
      upgraded.usage = exited(0, OLD_USAGE);
      changed("plastic-scm.reviews.fileLayout");
      await other.refresh();
      expect([ upgraded.probes().length, other.enabled ]).to.deep.equal([ 2, true ]);
      changed("plastic-scm.cmConfiguration");
      await until(() => !other.enabled);
      expect(upgraded.probes()).to.have.length(3);
    } finally {
      other.dispose();
    }
  });

  it("turns comments on once an action finds cm ready, after a first look that timed out", async () => {
    const slow = new FakeCm();
    slow.usage = { code: undefined, killed: "timeout", started: true, stderr: "", stdout: "" };
    const otherEditors = fakePostingEditors(draft);
    const other = create(slow, otherEditors);
    try {
      await other.select("workspace");
      expect(other.enabled).to.equal(false);
      slow.usage = exited(0, "    - reply\n");
      // Add Me as Reviewer asks for the access fresh; the answer is the gutter's too.
      expect(await other.access("workspace")).to.deep.equal({ state: "ready" });
      expect(other.enabled).to.equal(true);
      expect(otherEditors.enabled[otherEditors.enabled.length - 1]).to.equal(true);
    } finally {
      other.dispose();
    }
  });

  it("is blocked while cm is missing", async () => {
    const none = new FakeCm();
    none.usage = { code: undefined, missing: true, started: false, stderr: "", stdout: "" };
    const other = create(none, fakePostingEditors(draft));
    try {
      await other.select("workspace");
      expect(await other.access("workspace")).to.deep.equal({
        reason: "cm wasn't found. Check the plastic-scm.cmConfiguration.cmPath setting.", state: "blocked",
      });
      expect(other.enabled).to.equal(false);
    } finally {
      other.dispose();
    }
  });

  it("adds the cm user and sets their verdict from the workspace's folder", async () => {
    await posting.addReviewer("workspace", 312);
    await posting.setMyStatus("workspace", 312, "Rework required");
    expect(cm.writes()).to.deep.equal([
      { args: [ "codereview", "reviewer", "add", "312", "--users=me" ], cmPath: "cm", cwd: ROOT, stdin: undefined },
      { args: [ "codereview", "review", "312", "--rework-required" ], cmPath: "cm", cwd: ROOT, stdin: undefined },
    ]);
    setting = false;
    let message = "";
    await posting.addReviewer("workspace", 312).catch((error: Error) => {
      message = error.message;
    });
    expect(message).to.equal("Turn on the plastic-scm.reviews.commentWrites setting first.");
    expect(cm.writes()).to.have.length(2);
  });

  it("deletes the bearer token 0.4.0 saved for the workspace and its repository, whatever the setting", async () => {
    // The key 0.4.0's Configure Experimental Posting… wrote, per workspace and repository.
    const legacy = (workspaceId: string) =>
      `plastic-reviews.experimental:${JSON.stringify([ workspaceId, REPOSITORY ])}`;
    const stored = JSON.stringify({ organization: "acme-studio", repository: "Nimbus/Nimbus", token: "made-up" });
    secrets.values.set(legacy("workspace"), stored);
    secrets.values.set(legacy("other-workspace"), stored);
    secrets.values.set("someone-else", "kept");
    setting = false;
    const off = new FakeCm();
    const upgraded = create(off, fakePostingEditors(draft));
    try {
      await upgraded.select("workspace");
      expect(Array.from(secrets.values.keys())).to.deep.equal([ legacy("other-workspace"), "someone-else" ]);
      // With the setting off, cm is not asked anything.
      expect(off.calls).to.deep.equal([]);
    } finally {
      upgraded.dispose();
    }
  });

  it("reports whether posting is enabled to the editors", async () => {
    expect(editors.enabled[editors.enabled.length - 1]).to.equal(true);
    setting = false;
    await posting.refresh();
    expect(editors.enabled[editors.enabled.length - 1]).to.equal(false);
  });

  it("posts with the draft's workspace whichever workspace is selected", async () => {
    await posting.select("different-workspace");
    expect(posting.enabled).to.equal(false);
    const thread = fakeThread(uri, 4);
    await posting.postComment({ text: "Still for the first workspace", thread });
    expect(cm.writes().map(call => call.cwd)).to.deep.equal([ROOT]);
    expect(confirms[0].detail).to.contain("Destination: acme-studio@unity");
  });

  it("keeps a posted comment marked Posted when the discussions cannot be reloaded", async () => {
    const failing = new ReviewPosting(new ReviewWriter({ cmPath: () => "cm", platform: "linux", run: cm.run }), {
      reloadDiscussions: () => Promise.reject(new Error("cm is busy")),
      repository: () => REPOSITORY,
      root: () => ROOT,
    }, fakePostingEditors(draft), {
      confirm: () => Promise.resolve(true), notify: message => notices.push(message), setting: () => true,
      trusted: () => true,
    });
    try {
      const thread = fakeThread(uri, 4);
      await failing.postComment({ text: "Hello", thread });
      expect(thread.comments[0]).to.include({ contextValue: "reviewLocal-posted", label: "Posted" });
      expect(notices).to.deep.equal([]);
    } finally {
      failing.dispose();
    }
  });

  it("discards a local failure together with the thread it started", async () => {
    cm.answer = () => exited(1, "", "Error: refused");
    const thread = fakeThread(uri, 4);
    await posting.postComment({ text: "Discard me", thread });
    posting.discardLocal(thread.comments[0]);
    expect(thread.comments).to.have.length(0);
    expect(editors.disposed).to.deep.equal([thread]);
    expect(thread.disposed).to.equal(true);
  });

  it("keeps a posted comment and a reply thread when discarding", async () => {
    const started = fakeThread(uri, 4);
    await posting.postComment({ text: "Posted", thread: started });
    posting.discardLocal(started.comments[0]);
    expect(started.comments).to.have.length(1);
    cm.answer = () => exited(1, "", "Error: refused");
    const first: Comment = { author: { name: "priya" }, body: "Why?", mode: 1 };
    const reply = fakeThread(uri, 4, [first]);
    editors.replies.set(reply, replyTarget);
    await posting.postReply({ text: "Because.", thread: reply });
    posting.discardLocal(reply.comments[1]);
    expect(reply.comments).to.deep.equal([first]);
    expect(reply.disposed).to.equal(false);
  });

  it("follows a local comment to the thread a refresh moved it to", async () => {
    cm.answer = () => exited(1, "", "Error: refused");
    const first = fakeThread(uri, 4);
    await posting.postComment({ text: "Moves", thread: first });
    const local = first.comments[0];
    const moved: CommentThread = fakeThread(uri, 4, [local]);
    editors.threadOf = comment => (comment === local ? moved : undefined);
    cm.answer = undefined;
    await posting.sendAgain(local);
    expect(moved.comments[0]).to.include({ contextValue: "reviewLocal-posted" });
  });

  it("cancels only an empty thread", () => {
    const empty = fakeThread(uri);
    posting.cancel({ text: "", thread: empty });
    expect(empty.disposed).to.equal(true);
    const started = fakeThread(uri, 0, [{ author: { name: "You" }, body: "x", mode: 1 }]);
    posting.cancel(started);
    expect(started.disposed).to.equal(false);
  });

  it("keeps the comment's text out of the log", async () => {
    const text = "A sentence nobody else should read in the output channel.";
    cm.answer = () => exited(1, "", `Error: cannot store "${text}"`);
    const thread = fakeThread(uri, 4);
    await posting.postComment({ text, thread });
    // cm's own message is shown in the thread, where the text already is; the log has neither.
    expect(thread.comments[0].label).to.equal(`Not sent: cannot store "${text}".`);
    cm.answer = undefined;
    await posting.sendAgain(thread.comments[0]);
    expect(log).to.deep.equal([
      "cm codereview comment add 12831 (text on stdin)",
      "cm codereview comment add 12831: exit code 1",
      "cm codereview comment add 12831 (text on stdin)",
      "cm codereview comment add 12831: exit code 0",
    ]);
    expect(log.join("\n")).to.not.contain(commentGuid(1));
  });

  it("reacts to a change of either writes setting, and of nothing else", async () => {
    await posting.select("workspace");
    expect(posting.enabled).to.equal(true);
    setting = false;
    changed("plastic-scm.reviews.fileLayout");
    await posting.refresh();
    changed("plastic-scm.reviews.commentWrites");
    await until(() => !posting.enabled);
    expect(editors.enabled[editors.enabled.length - 1]).to.equal(false);
    setting = true;
    changed("plastic-scm.reviews.experimentalPosting");
    await until(() => posting.enabled);
    expect(editors.enabled[editors.enabled.length - 1]).to.equal(true);
  });
});

describe("The effective review writes setting", () => {
  interface IScopes { globalValue?: boolean; workspaceValue?: boolean; workspaceFolderValue?: boolean }
  const configuration = (values: { [section: string]: IScopes }): ISettingInspector => ({
    inspect: <T>(section: string) => values[section] as { globalValue?: T } | undefined,
  });
  const NEW = "plastic-scm.reviews.commentWrites";
  const OLD = "plastic-scm.reviews.experimentalPosting";

  it("is on when neither setting is set explicitly, whatever their defaults say", () => {
    expect(writesSettingOn(configuration({}))).to.equal(true);
    expect(writesSettingOn(configuration({ [NEW]: {}, [OLD]: {}}))).to.equal(true);
  });

  it("takes the deprecated setting where the new one is not set, so an explicit off stays off", () => {
    expect(writesSettingOn(configuration({ [OLD]: { globalValue: false }}))).to.equal(false);
    expect(writesSettingOn(configuration({ [OLD]: { workspaceValue: false }}))).to.equal(false);
    expect(writesSettingOn(configuration({ [OLD]: { workspaceFolderValue: true }}))).to.equal(true);
  });

  it("takes the new setting at any scope over the deprecated one", () => {
    for (const scope of [ "globalValue", "workspaceValue", "workspaceFolderValue" ] as const) {
      expect(writesSettingOn(configuration({ [NEW]: { [scope]: true }, [OLD]: { globalValue: false }})), scope)
        .to.equal(true);
      expect(writesSettingOn(configuration({ [NEW]: { [scope]: false }, [OLD]: { globalValue: true }})), scope)
        .to.equal(false);
    }
  });

  it("prefers the more specific scope of the new setting", () => {
    expect(writesSettingOn(configuration({ [NEW]: { globalValue: true, workspaceValue: false }}))).to.equal(false);
  });
});
