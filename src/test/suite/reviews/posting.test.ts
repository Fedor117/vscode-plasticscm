import { Comment, CommentThread, Uri } from "vscode";
import { fakePostingEditors, fakeThread, IFakePostingEditors, memorySecrets } from "./editorFixtures";
import { IReviewDraft, IWriteResponse, ReviewWriter } from "../../../reviews/reviewWriter";
import { isCloudRepository, ReviewPosting } from "../../../reviews/reviewPosting";
import { expect } from "chai";

const REPOSITORY = "project/repo@org@cloud";
const connection = { organization: "org", repository: "project/repo", token: "test-token" };
const draft: IReviewDraft = {
  changesetId: 21,
  key: "draft-one",
  location: 4,
  path: "/Code/Test.cs",
  reviewId: 7,
  revisionId: 42,
  workspaceId: "workspace",
};
const uri = Uri.from({ path: "/Code/Test.cs", query: "{}", scheme: "plastic-review" });

function secretKey(workspaceId: string): string {
  return `plastic-reviews.experimental:${JSON.stringify([ workspaceId, REPOSITORY ])}`;
}

describe("Experimental native posting (mock HTTP only)", () => {
  let editors: IFakePostingEditors;
  let posting: ReviewPosting;
  let requests: Array<{ url: URL; body: string; key: string }>;
  let respond: () => Promise<IWriteResponse>;
  let confirms: Array<{ message: string; detail: string }>;
  let confirmAnswer: boolean;
  let notices: string[];
  let setting: boolean;
  let trusted: boolean;
  let repository: string | undefined;
  let secrets: ReturnType<typeof memorySecrets>;

  beforeEach(async () => {
    editors = fakePostingEditors(draft);
    requests = [];
    respond = () => Promise.resolve({ body: "{}", status: 201 });
    confirms = [];
    confirmAnswer = true;
    notices = [];
    setting = true;
    trusted = true;
    repository = REPOSITORY;
    secrets = memorySecrets({ [secretKey("workspace")]: JSON.stringify(connection) });
    let key = "";
    const writer = new ReviewWriter((url, _token, body) => {
      requests.push({ body, key, url });
      return respond();
    });
    const send = writer.send.bind(writer);
    writer.send = (target, sent, text) => {
      key = sent.key;
      return send(target, sent, text);
    };
    posting = new ReviewPosting(secrets, () => repository, editors, {
      confirm: (message, detail) => {
        confirms.push({ detail, message });
        return Promise.resolve(confirmAnswer);
      },
      notify: message => notices.push(message),
      setting: () => setting,
      trusted: () => trusted,
      writer,
    });
    await posting.select("workspace");
  });
  afterEach(() => posting.dispose());

  it("posts a new comment after the modal and keeps it in the thread as posted", async () => {
    const thread = fakeThread(uri, 4);
    await posting.postComment({ text: "Off by one?", thread });
    expect(requests).to.have.length(1);
    expect(JSON.parse(requests[0].body)).to.deep.equal({
      changesetId: 21, commentText: "Off by one?", locationSpec: "4", revisionId: 42, type: "Comment",
    });
    expect(confirms[0].message).to.equal("Post this comment to review #7?");
    expect(confirms[0].detail).to.contain("Destination: org / project/repo");
    expect(confirms[0].detail).to.contain("File: /Code/Test.cs, line 5, revision 42");
    expect(confirms[0].detail).to.contain("Experimental: authentication and line encoding are unverified.");
    expect(thread.comments).to.have.length(1);
    expect(thread.comments[0]).to.include({
      body: "Off by one?", contextValue: "reviewLocal-posted", label: "Posted · refresh to verify",
    });
    expect(thread.comments[0].author.name).to.equal("You");
    expect(editors.adopted).to.deep.equal([thread]);
    expect(thread.canReply).to.equal(false);
    expect(editors.keepLocalComment(thread.comments[0])).to.equal(false);
  });

  it("sends nothing when the modal is cancelled", async () => {
    confirmAnswer = false;
    const thread = fakeThread(uri, 4);
    await posting.postComment({ text: "Never mind", thread });
    expect(confirms).to.have.length(1);
    expect(requests).to.have.length(0);
    expect(thread.comments).to.have.length(0);
    expect(editors.adopted).to.have.length(0);
  });

  it("takes a reply's draft from its review thread and posts to the parent", async () => {
    const thread = fakeThread(uri, 4, [{ author: { name: "priya" }, body: "Why?", mode: 1 }]);
    editors.replies.set(thread, { ...draft, key: "", parentId: 2227 });
    await posting.postReply({ text: "Because.", thread });
    expect(requests).to.have.length(1);
    expect(requests[0].url.pathname).to.match(/code-reviews\/7\/comments\/2227\/replies$/);
    expect(JSON.parse(requests[0].body)).to.deep.equal({ commentText: "Because." });
    expect(confirms[0].message).to.equal("Post this reply to review #7?");
    expect(confirms[0].detail).to.contain("Reply in the discussion on /Code/Test.cs, line 5");
    expect(thread.comments[1]).to.include({ contextValue: "reviewLocal-posted" });
    expect(editors.adopted).to.have.length(0);
  });

  it("refuses to reply in a thread that was not loaded from the review", async () => {
    await posting.postReply({ text: "Hello", thread: fakeThread(uri) });
    expect(requests).to.have.length(0);
    expect(notices[0]).to.contain("Only threads loaded from the review");
  });

  it("keeps a rejected comment's text and sends it again with the same key", async () => {
    respond = () => Promise.resolve({ body: "bad request", status: 400 });
    const thread = fakeThread(uri, 4);
    await posting.postComment({ text: "Keep this text", thread });
    const local = thread.comments[0];
    expect(local.contextValue).to.equal("reviewLocal-failed");
    expect(local.label).to.match(/^Not sent: Comment rejected \(HTTP 400\)/);
    expect(local.body).to.equal("Keep this text");
    expect(editors.keepLocalComment(local)).to.equal(true);
    respond = () => Promise.resolve({ body: "{}", status: 201 });
    await posting.sendAgain(local);
    expect(requests).to.have.length(2);
    expect(requests[1].key).to.equal(requests[0].key);
    expect(local.contextValue).to.equal("reviewLocal-posted");
    await posting.sendAgain(local);
    expect(requests).to.have.length(2);
  });

  it("requires Allow Another Attempt after an unknown result, which takes a new key", async () => {
    respond = () => Promise.reject(new Error("network dropped"));
    const thread = fakeThread(uri, 4);
    await posting.postComment({ text: "Maybe sent", thread });
    const local = thread.comments[0];
    expect(local).to.include({
      contextValue: "reviewLocal-uncertain", label: "Result unknown: check the review before retrying",
    });
    await posting.sendAgain(local);
    expect(requests).to.have.length(1);
    posting.allowRetry(local);
    expect(local.contextValue).to.equal("reviewLocal-failed");
    expect(local.label).to.contain("duplicate");
    respond = () => Promise.resolve({ body: "{}", status: 201 });
    await posting.sendAgain(local);
    expect(requests).to.have.length(2);
    expect(requests[1].key).not.to.equal(requests[0].key);
    expect(local.contextValue).to.equal("reviewLocal-posted");
  });

  it("blocks a second reply while one is sending, and an identical reply once sent", async () => {
    let release!: () => void;
    respond = () => new Promise(resolve => {
      release = () => resolve({ body: "{}", status: 201 });
    });
    const thread = fakeThread(uri, 4, [{ author: { name: "priya" }, body: "Why?", mode: 1 }]);
    editors.replies.set(thread, { ...draft, key: "", parentId: 2227 });
    const first = posting.postReply({ text: "Because.", thread });
    await new Promise(resolve => setTimeout(resolve, 0));
    await posting.postReply({ text: "Because!", thread });
    expect(notices[0]).to.contain("still being sent");
    release();
    await first;
    await posting.postReply({ text: "Because.", thread });
    expect(notices[1]).to.contain("already sent");
    expect(requests).to.have.length(1);
  });

  it("never posts without the setting, a trusted workspace, a cloud repository and a saved token", async () => {
    const attempts: Array<[string, () => void]> = [
      [ "setting", () => {
        setting = false;
      } ],
      [ "trusted workspace", () => {
        trusted = false;
      } ],
      [ "cloud repositories", () => {
        repository = "project/repo@localhost:8087";
      } ],
    ];
    for (const [ reason, apply ] of attempts) {
      setting = true;
      trusted = true;
      repository = REPOSITORY;
      apply();
      expect(posting.enabled).to.equal(false);
      const thread = fakeThread(uri, 4);
      await posting.postComment({ text: "Hello", thread });
      expect(thread.comments).to.have.length(0);
      expect(notices[notices.length - 1]).to.contain(reason);
    }
    setting = true;
    trusted = true;
    repository = REPOSITORY;
    expect(posting.enabled).to.equal(true);
    await posting.forget();
    expect(secrets.values.size).to.equal(0);
    expect(posting.enabled).to.equal(false);
    expect(posting.configured).to.equal(false);
    await posting.postComment({ text: "Hello", thread: fakeThread(uri, 4) });
    expect(notices[notices.length - 1]).to.contain("Configure experimental posting");
    expect(requests).to.have.length(0);
    expect(confirms).to.have.length(0);
  });

  it("reports whether posting is enabled to the editors", async () => {
    expect(editors.enabled[editors.enabled.length - 1]).to.equal(true);
    await posting.forget();
    expect(editors.enabled[editors.enabled.length - 1]).to.equal(false);
  });

  it("posts with the draft's workspace connection whichever workspace is selected", async () => {
    await posting.select("different-workspace");
    expect(posting.enabled).to.equal(false);
    const thread = fakeThread(uri, 4);
    await posting.postComment({ text: "Still for the first workspace", thread });
    expect(requests).to.have.length(1);
    expect(posting.destination("workspace")).to.equal("org / project/repo");
  });

  it("discards a local failure together with the thread it started", async () => {
    respond = () => Promise.resolve({ body: "", status: 422 });
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
    respond = () => Promise.resolve({ body: "", status: 400 });
    const root: Comment = { author: { name: "priya" }, body: "Why?", mode: 1 };
    const reply = fakeThread(uri, 4, [root]);
    editors.replies.set(reply, { ...draft, key: "", parentId: 2227 });
    await posting.postReply({ text: "Because.", thread: reply });
    posting.discardLocal(reply.comments[1]);
    expect(reply.comments).to.deep.equal([root]);
    expect(reply.disposed).to.equal(false);
  });

  it("follows a local comment to the thread a refresh moved it to", async () => {
    respond = () => Promise.resolve({ body: "", status: 400 });
    const first = fakeThread(uri, 4);
    await posting.postComment({ text: "Moves", thread: first });
    const local = first.comments[0];
    const moved: CommentThread = fakeThread(uri, 4, [local]);
    editors.threadOf = comment => comment === local ? moved : undefined;
    respond = () => Promise.resolve({ body: "{}", status: 201 });
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

  it("keeps credentials out of comments, labels and messages", async () => {
    respond = () => Promise.resolve({ body: "test-token private server detail", status: 403 });
    const thread = fakeThread(uri, 4);
    await posting.postComment({ text: "Hello", thread });
    expect(JSON.stringify(thread.comments)).not.to.contain("test-token");
    expect(JSON.stringify(thread.comments)).not.to.contain("private server detail");
    expect(notices.join("\n")).not.to.contain("test-token");
  });

  it("recognises Unity Version Control cloud repositories", () => {
    expect(isCloudRepository("Nimbus/Nimbus@acme-studio@unity")).to.equal(true);
    expect(isCloudRepository("repo@org@cloud")).to.equal(true);
    expect(isCloudRepository("repo@localhost:8087")).to.equal(false);
    expect(isCloudRepository("")).to.equal(false);
  });
});
