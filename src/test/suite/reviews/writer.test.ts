import {
  commentRequest, IReviewDraft, IReviewWriteConnection, ReviewWriteError, ReviewWriter,
} from "../../../reviews/reviewWriter";
import { expect } from "chai";

const connection: IReviewWriteConnection = { organization: "org", repository: "project/repo", token: "test-token" };
const draft: IReviewDraft = {
  changesetId: 21,
  key: "draft-one",
  location: 4,
  path: "/Code/Test.cs",
  reviewId: 7,
  revisionId: 42,
  workspaceId: "workspace",
};
async function failure(action: Promise<unknown>): Promise<ReviewWriteError> {
  try {
    await action;
  } catch (error) {
    return error as ReviewWriteError;
  }
  throw new Error("Expected rejection");
}
describe("Experimental review writer (mock HTTP only)", () => {
  it("builds a pinned inline comment with the isolated speculative location encoding", () => {
    const call = commentRequest(connection, draft, "First line\nSecond line");
    expect(call.url.origin).to.equal("https://services.api.unity.com");
    expect(call.url.pathname).to.contain("repositories/project%2Frepo/code-reviews/7/comments");
    expect(call.url.toString()).not.to.contain(connection.token);
    expect(JSON.parse(call.body)).to.deep.equal({
      changesetId: 21, commentText: "First line\nSecond line", locationSpec: "4", revisionId: 42, type: "Comment",
    });
  });
  it("builds a reply to the parent, including general conversations without revision anchors", () => {
    const call = commentRequest(connection, { ...draft, location: -1, parentId: 2227, revisionId: -1 }, "Reply");
    expect(call.url.pathname).to.match(/comments\/2227\/replies$/);
    expect(JSON.parse(call.body)).to.deep.equal({ commentText: "Reply" });
  });
  it("rejects empty text, invalid anchors and header injection before contacting the service", () => {
    expect(() => commentRequest(connection, draft, "  ")).to.throw();
    expect(() => commentRequest(connection, { ...draft, location: -1 }, "Hello")).to.throw();
    expect(() => commentRequest({ ...connection, token: "secret\nheader" }, draft, "Hello")).to.throw();
    expect(commentRequest({ ...connection, repository: "../../elsewhere" }, draft, "Hello").url.origin)
      .to.equal("https://services.api.unity.com");
  });
  it("blocks concurrent duplicate sends and never resends an accepted draft", async () => {
    let release!: () => void;
    let calls = 0;
    const writer = new ReviewWriter(() => {
      calls++;
      return new Promise(resolve => {
        release = () => resolve({ body: "{}", status: 201 });
      });
    });
    const first = writer.send(connection, draft, "Hello");
    expect((await failure(writer.send(connection, draft, "Hello"))).message).to.contain("already");
    release();
    await first;
    expect((await failure(writer.send(connection, draft, "Hello"))).message).to.contain("already");
    expect(calls).to.equal(1);
  });
  it("does not retry, follow redirects, or echo response bodies and credentials in errors", async () => {
    for (const status of [ 301, 401, 403, 400, 429, 500 ]) {
      let calls = 0;
      const writer = new ReviewWriter(() => {
        calls++;
        return Promise.resolve({ body: "test-token private server detail", status });
      });
      const error = await failure(writer.send(connection, draft, "Hello"));
      expect(calls).to.equal(1);
      expect(error.message).not.to.contain("test-token");
      expect(error.message).not.to.contain("private server detail");
      expect(error.uncertain).to.equal(status === 500);
    }
  });
});
