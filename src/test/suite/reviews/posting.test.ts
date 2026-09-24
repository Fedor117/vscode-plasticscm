import { Comment, CommentThread, Uri } from "vscode";
import { CONSENT_MESSAGE, consentDetail, ReviewTokens } from "../../../reviews/reviewTokens";
import { fakePostingEditors, fakeThread, IFakePostingEditors, memorySecrets } from "./editorFixtures";
import { FakeRest, IRestCall, json } from "./restFixtures";
import { FakeTokenCm, REGION } from "./tokenFixtures";
import { IReviewDraft, ReviewWriter } from "../../../reviews/reviewWriter";
import { isCloudRepository, ReviewPosting } from "../../../reviews/reviewPosting";
import { expect } from "chai";

/**
 * Comments and replies through the Server REST API, with a personal access
 * token from a fake cm and a fake REST API: nothing runs cm or reaches the
 * network. Every organization, repository, review, user and token is made up.
 */

const REPOSITORY = "Nimbus/Nimbus@acme-studio@unity";
const SERVER = "acme-studio@unity";
const USER = "dana.kim@example.test";
const API = "/api/v1/organizations/acme-studio/repos/Nimbus%2FNimbus/codereview/12831";
const draft: IReviewDraft = {
  changesetId: 21,
  key: "draft-one",
  location: 4,
  path: "/Code/Test.cs",
  reviewId: 12831,
  revisionId: 42,
  workspaceId: "workspace",
};
const uri = Uri.from({ path: "/Code/Test.cs", query: "{}", scheme: "plastic-review" });

describe("Experimental native posting (fake cm and REST API)", () => {
  let editors: IFakePostingEditors;
  let posting: ReviewPosting;
  let cm: FakeTokenCm;
  let rest: FakeRest;
  let tokens: ReviewTokens;
  let secrets: ReturnType<typeof memorySecrets>;
  /** The draft key of every write the REST API received, in order. */
  let keys: string[];
  let confirms: Array<{ message: string; detail: string }>;
  let confirmAnswer: boolean;
  let consents: Array<{ message: string; detail: string }>;
  let consentAnswer: boolean;
  let notices: string[];
  let setting: boolean;
  let trusted: boolean;
  let repository: string | undefined;

  /** The writes the REST API received: comments and replies. */
  const writes = (): IRestCall[] => rest.writes();
  /** Answers every write with `status` and `body`; the reads before it as usual. */
  const answerWrites = (status: number, body: object | string = {}) => {
    rest.respond = call => (call.method === "GET" ? undefined
      : { body: typeof body === "string" ? body : JSON.stringify(body), status });
  };

  beforeEach(async () => {
    editors = fakePostingEditors(draft);
    cm = new FakeTokenCm();
    rest = new FakeRest();
    secrets = memorySecrets();
    const consent = new Map<string, unknown>();
    tokens = new ReviewTokens(secrets, {
      get: <T>(key: string) => consent.get(key) as T | undefined,
      update: (key: string, value: unknown) => {
        consent.set(key, value);
        return Promise.resolve();
      },
    }, cm, { hostname: () => "build-box" });
    keys = [];
    confirms = [];
    confirmAnswer = true;
    consents = [];
    consentAnswer = true;
    notices = [];
    setting = true;
    trusted = true;
    repository = REPOSITORY;
    let key = "";
    const writer = new ReviewWriter((call, cancel) => {
      if (call.method !== "GET") {
        keys.push(key);
      }
      return rest.transport(call, cancel);
    });
    const send = writer.send.bind(writer);
    writer.send = (target, sent, text, cancel) => {
      key = sent.key;
      return send(target, sent, text, cancel);
    };
    posting = new ReviewPosting(tokens, {
      repository: workspaceId => (workspaceId === "workspace" ? repository : undefined),
      user: () => Promise.resolve(USER),
    }, editors, {
      confirm: (message, detail) => {
        confirms.push({ detail, message });
        return Promise.resolve(confirmAnswer);
      },
      consent: (message, detail) => {
        consents.push({ detail, message });
        return Promise.resolve(consentAnswer);
      },
      notify: message => notices.push(message),
      setting: () => setting,
      trusted: () => trusted,
      writer,
    });
    // Most tests start after the user agreed to a token; those about consent take it back.
    await tokens.consent(SERVER, USER);
    await posting.select("workspace");
  });
  afterEach(() => posting.dispose());

  it("posts a new comment after the modal and keeps it in the thread as posted", async () => {
    const thread = fakeThread(uri, 4);
    await posting.postComment({ text: "Off by one?", thread });
    expect(writes().map(call => call.path)).to.deep.equal([`${API}/comment`]);
    expect(writes()[0].body).to.deep.equal({
      changesetId: 21, commentText: "Off by one?", locationSpec: "4", revisionId: 42, type: "Comment",
    });
    expect(confirms[0].message).to.equal("Post this comment to review #12831?");
    expect(confirms[0].detail.split("\n")).to.deep.equal([
      "Destination: acme-studio@unity through the Unity Version Control REST API",
      "File: /Code/Test.cs, line 5, revision 42",
      "Experimental: line encoding is unverified. Refresh the review afterwards to check the result.",
    ]);
    expect(thread.comments).to.have.length(1);
    expect(thread.comments[0]).to.include({
      body: "Off by one?", contextValue: "reviewLocal-posted", label: "Posted · refresh to verify",
    });
    expect(thread.comments[0].author.name).to.equal("You");
    expect(editors.adopted).to.deep.equal([thread]);
    expect(thread.canReply).to.equal(false);
    expect(editors.keepLocalComment(thread.comments[0])).to.equal(false);
  });

  it("asks once before the first token of a server, creates it with cm, then posts; declining sends nothing",
    async () => {
      await tokens.revoke(SERVER, USER);
      await posting.refresh();
      expect(posting.enabled, "the gutter + is offered: the modal asks").to.equal(true);
      consentAnswer = false;
      await posting.postComment({ text: "Hello", thread: fakeThread(uri, 4) });
      expect(consents).to.deep.equal([{ detail: consentDetail(SERVER), message: CONSENT_MESSAGE }]);
      expect([ confirms.length, writes().length, notices.length ]).to.deep.equal([ 0, 0, 0 ]);
      expect(cm.calls.filter(call => call[0] === "accesstoken")).to.deep.equal([]);

      consentAnswer = true;
      const thread = fakeThread(uri, 4);
      await posting.postComment({ text: "Hello", thread });
      expect(consents).to.have.length(2);
      expect(cm.calls.filter(call => call[0] === "accesstoken").map(call => call[1])).to.deep.equal([
        "create", "reveal",
      ]);
      expect(thread.comments[0]).to.include({ contextValue: "reviewLocal-posted" });
      expect(writes()[0].token).to.equal(cm.revealed[0]);
      expect(posting.hasToken).to.equal(true);

      // The token is kept: the next post, a reply, asks nothing and runs no cm.
      const replied = fakeThread(uri, 8, [{ author: { name: "priya" }, body: "Why?", mode: 1 }]);
      editors.replies.set(replied, { ...draft, key: "", parentId: 2227 });
      await posting.postReply({ text: "Again", thread: replied });
      expect(consents).to.have.length(2);
      expect(cm.count("create") + cm.count("reveal")).to.equal(2);
      expect(writes()).to.have.length(2);
    });

  it("says what an admin can do when cm may not create a token, and then offers no posting", async () => {
    cm.answer = args => (args[1] === "create"
      ? { code: 1, stderr: "Error: you don't have permission to create personal access tokens.", stdout: "" }
      : undefined);
    const thread = fakeThread(uri, 4);
    await posting.postComment({ text: "Hello", thread });
    const admin = "Your organization hasn't enabled personal access tokens for you. An organization admin can " +
      `allow them with: cm accesstoken admin allowlist add --users=${USER} ${SERVER}`;
    expect(thread.comments[0]).to.include({ contextValue: "reviewLocal-failed", label: `Not sent: ${admin}` });
    expect(writes()).to.deep.equal([]);
    await posting.refresh();
    expect(posting.enabled).to.equal(false);
    expect(await posting.access("workspace")).to.deep.equal({
      command: `cm accesstoken admin allowlist add --users=${USER} ${SERVER}`, message: admin, state: "notAllowed",
    });
    await posting.postComment({ text: "Hello again", thread: fakeThread(uri, 8) });
    expect(notices).to.deep.equal([admin]);
    expect(cm.count("create")).to.equal(1);
  });

  it("learns the access with cm getconfig only: no token is created or revealed, and the REST API is not asked",
    async () => {
      // Selecting the workspace asked cm about the organization, once; nothing about a token.
      expect(cm.calls)
        .to.deep.equal([[ "getconfig", "organization", SERVER, "--format={name}|{type}|{unityid}|{region}" ]]);
      await tokens.revoke(SERVER, USER);
      cm.calls.length = 0;
      expect(await posting.access("workspace")).to.deep.equal({ server: SERVER, state: "needsConsent" });
      await posting.refresh();
      expect(cm.calls).to.deep.equal([]);
      expect(rest.calls).to.deep.equal([]);
    });

  it("is blocked where the organization's region is not a documented REST server", async () => {
    cm.organization = "acme-studio|unity|-1|plastic.example.test";
    const blocked = new ReviewTokens(memorySecrets(), { get: () => undefined, update: () => Promise.resolve() }, cm);
    const other = new ReviewPosting(blocked, { repository: () => REPOSITORY, user: () => Promise.resolve(USER) },
      fakePostingEditors(draft), { notify: message => notices.push(message), setting: () => true,
        trusted: () => true, writer: new ReviewWriter(rest.transport) });
    try {
      await other.select("workspace");
      const reason = "The Unity Version Control Server REST API documents no server for acme-studio@unity, whose " +
        "region is \"plastic.example.test\".";
      expect(await other.access("workspace")).to.deep.equal({ reason, state: "blocked" });
      expect(other.enabled).to.equal(false);
      await other.postComment({ text: "Hello", thread: fakeThread(uri, 4) });
      expect(notices).to.deep.equal([reason]);
      expect(rest.calls).to.deep.equal([]);
    } finally {
      other.dispose();
    }
  });

  it("names the organization in paths by its unityid when the REST API does not take its name", async () => {
    cm.organization = `acme-studio|unity|1234567890123|${REGION}`;
    rest.organizations = ["1234567890123"];
    const other = new ReviewPosting(new ReviewTokens(memorySecrets(), {
      get: <T>() => true as unknown as T,
      update: () => Promise.resolve(),
    }, cm), { repository: () => REPOSITORY, user: () => Promise.resolve(USER) }, fakePostingEditors(draft), {
      confirm: () => Promise.resolve(true), setting: () => true, trusted: () => true,
      writer: new ReviewWriter(rest.transport),
    });
    try {
      await other.postComment({ text: "Hello", thread: fakeThread(uri, 4) });
      expect(rest.calls.map(call => `${call.method} ${call.path}`)).to.deep.equal([
        "GET /api/v1/organizations/acme-studio/user",
        "GET /api/v1/organizations/1234567890123/user",
        "GET /api/v1/organizations/1234567890123/repos/Nimbus%2FNimbus/codereview/12831",
        "POST /api/v1/organizations/1234567890123/repos/Nimbus%2FNimbus/codereview/12831/comment",
      ]);
    } finally {
      other.dispose();
    }
  });

  it("sends nothing when the modal is cancelled", async () => {
    confirmAnswer = false;
    const thread = fakeThread(uri, 4);
    await posting.postComment({ text: "Never mind", thread });
    expect(confirms).to.have.length(1);
    expect(writes()).to.have.length(0);
    expect(thread.comments).to.have.length(0);
    expect(editors.adopted).to.have.length(0);
  });

  it("takes a reply's draft from its review thread and posts to the parent", async () => {
    const thread = fakeThread(uri, 4, [{ author: { name: "priya" }, body: "Why?", mode: 1 }]);
    editors.replies.set(thread, { ...draft, key: "", parentId: 2227 });
    await posting.postReply({ text: "Because.", thread });
    expect(writes().map(call => [ call.path, call.body ])).to.deep.equal([
      [ `${API}/comment/2227/reply`, { commentText: "Because." }],
    ]);
    expect(confirms[0].message).to.equal("Post this reply to review #12831?");
    expect(confirms[0].detail).to.contain("Reply in the discussion on /Code/Test.cs, line 5");
    expect(thread.comments[1]).to.include({ contextValue: "reviewLocal-posted" });
    expect(editors.adopted).to.have.length(0);
  });

  it("refuses to reply in a thread that was not loaded from the review", async () => {
    await posting.postReply({ text: "Hello", thread: fakeThread(uri) });
    expect(writes()).to.have.length(0);
    expect(notices[0]).to.contain("Only threads loaded from the review");
  });

  it("keeps a rejected comment's text and sends it again with the same key", async () => {
    answerWrites(400, "bad request");
    const thread = fakeThread(uri, 4);
    await posting.postComment({ text: "Keep this text", thread });
    const local = thread.comments[0];
    expect(local.contextValue).to.equal("reviewLocal-failed");
    expect(local.label).to.equal("Not sent: The Unity Version Control server rejected the request (HTTP 400).");
    expect(local.body).to.equal("Keep this text");
    expect(editors.keepLocalComment(local)).to.equal(true);
    rest.respond = undefined;
    await posting.sendAgain(local);
    expect(keys).to.have.length(2);
    expect(keys[1]).to.equal(keys[0]);
    expect(local.contextValue).to.equal("reviewLocal-posted");
    await posting.sendAgain(local);
    expect(keys).to.have.length(2);
  });

  it("requires Allow Another Attempt after an unknown result, which takes a new key", async () => {
    rest.respond = call => (call.method === "GET" ? undefined : Promise.reject(new Error("network dropped")));
    const thread = fakeThread(uri, 4);
    await posting.postComment({ text: "Maybe sent", thread });
    const local = thread.comments[0];
    expect(local).to.include({
      contextValue: "reviewLocal-uncertain", label: "Result unknown: check the review before retrying",
    });
    await posting.sendAgain(local);
    expect(keys).to.have.length(1);
    posting.allowRetry(local);
    expect(local.contextValue).to.equal("reviewLocal-failed");
    expect(local.label).to.contain("duplicate");
    rest.respond = undefined;
    await posting.sendAgain(local);
    expect(keys).to.have.length(2);
    expect(keys[1]).not.to.equal(keys[0]);
    expect(local.contextValue).to.equal("reviewLocal-posted");
  });

  it("blocks a second reply while one is sending, and an identical reply once sent", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    rest.respond = call => (call.method === "GET" ? undefined : held.then(() => json(201, { id: 20001 })));
    const thread = fakeThread(uri, 4, [{ author: { name: "priya" }, body: "Why?", mode: 1 }]);
    editors.replies.set(thread, { ...draft, key: "", parentId: 2227 });
    const first = posting.postReply({ text: "Because.", thread });
    await new Promise(resolve => setTimeout(resolve, 10));
    await posting.postReply({ text: "Because!", thread });
    expect(notices[0]).to.contain("still being sent");
    release();
    await first;
    await posting.postReply({ text: "Because.", thread });
    expect(notices[1]).to.contain("already sent");
    expect(writes()).to.have.length(1);
  });

  it("never posts without the setting, a trusted workspace and a cloud repository", async () => {
    const attempts: Array<[string, () => void]> = [
      [ "setting", () => {
        setting = false;
      } ],
      [ "trusted workspace", () => {
        trusted = false;
      } ],
      [ "cloud repositories", () => {
        repository = "Nimbus/Nimbus@localhost:8087";
      } ],
    ];
    for (const [ reason, apply ] of attempts) {
      setting = true;
      trusted = true;
      repository = REPOSITORY;
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
    expect(posting.enabled).to.equal(true);
    expect(writes()).to.have.length(0);
    expect(confirms).to.have.length(0);
    expect(cm.calls.filter(call => call[0] === "accesstoken")).to.deep.equal([]);
  });

  it("revokes the token with cm and forgets the consent, so the next post asks again", async () => {
    await posting.postComment({ text: "Hello", thread: fakeThread(uri, 4) });
    expect(posting.hasToken).to.equal(true);
    const id = cm.calls.find(call => call[1] === "reveal")![2];
    expect(await posting.revoke()).to.equal("Revoked the review access token for acme-studio@unity.");
    expect(cm.calls[cm.calls.length - 1]).to.deep.equal([ "accesstoken", "revoke", id, SERVER ]);
    expect(secrets.values.size).to.equal(0);
    expect(posting.hasToken).to.equal(false);
    expect(await posting.revoke()).to.equal("No review access token is saved for acme-studio@unity.");
    consentAnswer = false;
    await posting.postComment({ text: "Hello", thread: fakeThread(uri, 8) });
    expect(consents).to.have.length(1);
    expect(writes()).to.have.length(1);
  });

  it("deletes the bearer token 0.4.0 saved for the workspace and its repository, whatever the setting", async () => {
    // The key 0.4.0's Configure Experimental Posting… wrote, per workspace and repository.
    const legacy = (workspaceId: string) =>
      `plastic-reviews.experimental:${JSON.stringify([ workspaceId, REPOSITORY ])}`;
    const stored = JSON.stringify({ organization: "acme-studio", repository: "Nimbus/Nimbus", token: "made-up" });
    secrets.values.set(legacy("workspace"), stored);
    secrets.values.set(legacy("other-workspace"), stored);
    setting = false;
    const asked = cm.calls.length;
    const upgraded = new ReviewPosting(tokens, {
      repository: workspaceId => (workspaceId === "workspace" ? repository : undefined),
      user: () => Promise.resolve(USER),
    }, fakePostingEditors(draft), { setting: () => setting, trusted: () => trusted });
    try {
      await upgraded.select("workspace");
      expect(Array.from(secrets.values.keys())).to.deep.equal([legacy("other-workspace")]);
      // With the setting off, cm is not asked anything.
      expect(cm.calls.slice(asked)).to.deep.equal([]);
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
    expect(writes()).to.have.length(1);
    expect(confirms[0].detail).to.contain("Destination: acme-studio@unity");
  });

  it("discards a local failure together with the thread it started", async () => {
    answerWrites(422, "");
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
    answerWrites(400, "");
    const root: Comment = { author: { name: "priya" }, body: "Why?", mode: 1 };
    const reply = fakeThread(uri, 4, [root]);
    editors.replies.set(reply, { ...draft, key: "", parentId: 2227 });
    await posting.postReply({ text: "Because.", thread: reply });
    posting.discardLocal(reply.comments[1]);
    expect(reply.comments).to.deep.equal([root]);
    expect(reply.disposed).to.equal(false);
  });

  it("follows a local comment to the thread a refresh moved it to", async () => {
    answerWrites(400, "");
    const first = fakeThread(uri, 4);
    await posting.postComment({ text: "Moves", thread: first });
    const local = first.comments[0];
    const moved: CommentThread = fakeThread(uri, 4, [local]);
    editors.threadOf = comment => (comment === local ? moved : undefined);
    rest.respond = undefined;
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

  it("keeps the token out of comments, labels and messages", async () => {
    rest.respond = call => (call.method === "GET" ? undefined
      : json(403, { error: { message: `Token ${call.token} may not comment.` }}));
    const thread = fakeThread(uri, 4);
    await posting.postComment({ text: "Hello", thread });
    await posting.postReply({ text: "Hello", thread: fakeThread(uri) });
    expect(thread.comments[0].label).to.equal("Not sent: The Unity Version Control server refused the request: " +
      "Token [token] may not comment.");
    const shown = JSON.stringify(thread.comments) + notices.join("\n");
    expect(cm.revealed).to.have.length(1);
    for (const token of cm.revealed) {
      expect(shown).to.not.contain(token);
    }
  });

  it("recognises Unity Version Control cloud repositories", () => {
    expect(isCloudRepository("Nimbus/Nimbus@acme-studio@unity")).to.equal(true);
    expect(isCloudRepository("repo@1234567890123@cloud")).to.equal(true);
    expect(isCloudRepository("repo@localhost:8087")).to.equal(false);
    expect(isCloudRepository("")).to.equal(false);
  });
});
