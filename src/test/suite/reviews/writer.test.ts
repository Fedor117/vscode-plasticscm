import * as https from "https";
import { CancellationToken, CancellationTokenSource } from "vscode";
import {
  commentRequest,
  httpsTransport,
  IReviewDraft,
  IReviewWriteConnection,
  IWriteRequest,
  IWriteResponse,
  ReviewRequestError,
  ReviewWriteError,
  ReviewWriter,
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

describe("Experimental Add Reviewers request (mock HTTP only)", () => {
  const ME = "dana.kim@example.com";
  const nimbus: IReviewWriteConnection = { organization: "acme studio", repository: "Nimbus/Nimbus", token: "test-token" };
  const listing = (...reviewers: unknown[]) => JSON.stringify({ reviewers });

  /** A writer whose transport records every request and answers with `respond`. */
  function recording(respond: (call: IWriteRequest, cancel?: CancellationToken) => Promise<IWriteResponse>): {
    calls: IWriteRequest[]; writer: ReviewWriter;
  } {
    const calls: IWriteRequest[] = [];
    const writer = new ReviewWriter((call, cancel) => {
      calls.push(call);
      return respond(call, cancel);
    });
    return { calls, writer };
  }
  const answering = (status: number, body = "") => recording(() => Promise.resolve({ body, status }));

  it("posts the user's e-mail address to the review's reviewers, with the token only in the Authorization header",
    async () => {
      const { calls, writer } = answering(201, listing({ isGroup: false, name: ME, status: "under-review" }));
      await writer.addReviewer(nimbus, 312, ` ${ME} `);
      expect(calls).to.have.length(1);
      const [call] = calls;
      expect(call.method).to.equal("POST");
      expect(call.url.toString()).to.equal("https://services.api.unity.com/plastic/v1/organizations/acme%20studio" +
        "/repositories/Nimbus%2FNimbus/code-reviews/312/reviewers");
      expect(call.headers).to.deep.equal({ "Authorization": "Bearer test-token", "Content-Type": "application/json" });
      expect(JSON.parse(call.body)).to.deep.equal({ reviewers: [ME] });
      expect(call.url.toString() + call.body).not.to.contain("test-token");
    });

  it("percent-encodes the organization and repository as one path segment each, on the fixed host", async () => {
    const { calls, writer } = answering(200);
    await writer.addReviewer({ ...nimbus, organization: "acme/../x?y", repository: "Nimbus#1/../../elsewhere" }, 7, ME);
    const url = calls[0].url;
    expect(url.origin).to.equal("https://services.api.unity.com");
    expect(url.pathname).to.equal("/plastic/v1/organizations/acme%2F..%2Fx%3Fy" +
      "/repositories/Nimbus%231%2F..%2F..%2Felsewhere/code-reviews/7/reviewers");
    expect(url.search + url.hash).to.equal("");
  });

  it("takes 200, and a 201 that lists the user in any case as a name or a reviewer, as success", async () => {
    await answering(200).writer.addReviewer(nimbus, 312, ME);
    await answering(201, listing("priya.nair@example.com", "DANA.KIM@EXAMPLE.COM")).writer.addReviewer(nimbus, 312, ME);
    await answering(201, listing({ isGroup: false, name: "Dana.Kim@Example.com", status: "under-review" }))
      .writer.addReviewer(nimbus, 312, ME);
  });

  it("fails a 201 whose reviewers leave the user out, or that lists none, as a result to check", async () => {
    const bodies = [ listing({ isGroup: false, name: "priya.nair@example.com" }), listing(), "", "{\"reviewers\":5}" ];
    for (const body of bodies) {
      const error = await failure(answering(201, body).writer.addReviewer(nimbus, 312, ME));
      expect(error, body).to.be.instanceOf(ReviewWriteError);
      expect(error.message, body).to.equal(
        "The review service answered, but its list of reviewers does not include you. Refresh the review to check.");
      expect(error.uncertain, body).to.equal(true);
    }
  });

  it("says a token refused with 401 or 403 has expired or lacks permission, and echoes nothing the server sent",
    async () => {
      for (const status of [ 401, 403 ]) {
        const error = await failure(answering(status, "test-token private server detail").writer
          .addReviewer(nimbus, 312, ME));
        expect(error.message).to.equal("The review service refused the token: it has expired or lacks permission to " +
          "change reviewers. Unity user tokens are short-lived; set a new one with Configure Experimental Posting… " +
          "and try again.");
        expect(error.uncertain).to.equal(false);
      }
    });

  it("names what a 404 did not find, and refuses other 4XX RestFailures without echoing them", async () => {
    const missing = await failure(answering(404, "{\"errors\":[{\"message\":\"test-token\"}]}").writer
      .addReviewer(nimbus, 312, ME));
    expect(missing.message).to.equal("The review service has no review #312 in acme studio / Nimbus/Nimbus. " +
      "Check both names with Configure Experimental Posting… and try again.");
    const failures = JSON.stringify({
      errors: [{ code: "InvalidReviewer", message: "test-token private server detail" }],
    });
    for (const status of [ 400, 409, 422, 429, 301 ]) {
      const error = await failure(answering(status, failures).writer.addReviewer(nimbus, 312, ME));
      expect(error.message).to.equal(`The review service refused the request (HTTP ${status}). ` +
        "The experimental request format or repository mapping may not match this service.");
      expect(error.uncertain).to.equal(false);
    }
    for (const status of [ 500, 503, 408 ]) {
      const error = await failure(answering(status, failures).writer.addReviewer(nimbus, 312, ME));
      expect(error.message).to.equal(`The review service returned HTTP ${status}. ` +
        "You may have been added; refresh the review before retrying.");
      expect(error.uncertain).to.equal(true);
    }
  });

  it("turns a network failure, an interrupted answer and a cancellation into what may have happened", async () => {
    const rejecting = (error: Error) => recording(() => Promise.reject(error)).writer;
    const network = await failure(rejecting(new ReviewRequestError("failed", true)).addReviewer(nimbus, 312, ME));
    expect(network.message).to.equal(
      "No complete response was received. You may have been added. Check the review before retrying.");
    expect(network.uncertain).to.equal(true);
    const interrupted = await failure(
      rejecting(new ReviewRequestError("interrupted", true)).addReviewer(nimbus, 312, ME));
    expect(interrupted.message).to.equal("The response was interrupted. Check the review before retrying.");
    const unknown = await failure(rejecting(new Error("test-token socket detail")).addReviewer(nimbus, 312, ME));
    expect(unknown.message).to.equal(
      "The request ended without a confirmed result. You may have been added. Check the review before retrying.");

    // Cancelled while the request is out: the transport sees the token fire.
    const source = new CancellationTokenSource();
    const { writer } = recording((_call, cancel) => new Promise((_resolve, reject) => {
      cancel!.onCancellationRequested(() => reject(new ReviewRequestError("cancelled", true)));
    }));
    const pending = failure(writer.addReviewer(nimbus, 312, ME, source.token));
    source.cancel();
    const cancelled = await pending;
    expect(cancelled.message).to.equal(
      "Cancelled before the review service answered. You may have been added. Check the review before retrying.");
    expect(cancelled.uncertain).to.equal(true);
    source.dispose();
  });

  it("sends nothing when cancelled first: the https transport rejects before it opens a request", async () => {
    const api = https as unknown as { request: unknown };
    const original = api.request;
    let opened = 0;
    api.request = () => {
      opened++;
      throw new Error("A test tried to open a real request.");
    };
    const source = new CancellationTokenSource();
    source.cancel();
    try {
      const error = await failure(new ReviewWriter(httpsTransport).addReviewer(nimbus, 312, ME, source.token));
      expect(error.message).to.equal("Cancelled before anything was sent.");
      expect(error.uncertain).to.equal(false);
      const direct = await failure(httpsTransport({ body: "{}", headers: {}, method: "POST",
        url: new URL("https://services.api.unity.com/plastic/v1") }, source.token));
      expect(direct).to.be.instanceOf(ReviewRequestError);
      expect(opened).to.equal(0);
    } finally {
      api.request = original;
      source.dispose();
    }
  });

  it("refuses a user that is not an e-mail address, a bad review id and a token that injects a header", async () => {
    const { calls, writer } = answering(201, listing(ME));
    for (const user of [ "dana", "dana@localhost", "dana kim@example.com", "", "<dana@example.com>" ]) {
      const error = await failure(writer.addReviewer(nimbus, 312, user));
      expect(error.message, user).to.contain("is not an e-mail address");
    }
    for (const id of [ 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1 ]) {
      expect((await failure(writer.addReviewer(nimbus, id, ME))).message, String(id)).to.match(/^Invalid review id/);
    }
    const injected = await failure(writer.addReviewer({ ...nimbus, token: "test-token\r\nX-Evil: 1" }, 312, ME));
    expect(injected.message).to.equal("Configure a valid review-service bearer token first.");
    expect(calls).to.deep.equal([]);
  });
});
