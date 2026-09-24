import * as https from "https";
import { FakeRest, IRestCall, json } from "./restFixtures";
import {
  httpsTransport,
  IReviewConnection,
  IReviewDraft,
  repositoryForms,
  REST_HOSTS,
  restOrigin,
  restUrl,
  ReviewRequestError,
  ReviewWriteError,
  ReviewWriter,
  serverMessage,
} from "../../../reviews/reviewWriter";
import { ORIGIN, REGION } from "./tokenFixtures";
import { CancellationTokenSource } from "vscode";
import { expect } from "chai";

/**
 * Review writes to the Unity Version Control Server REST API, on a fake
 * transport: nothing reaches the network. Every organization, repository,
 * review, user and token here is made up.
 */

const ME = "dana.kim@example.test";
const REVIEW = 12831;
const API = "/api/v1/organizations/acme-studio/repos/Nimbus%2FNimbus/codereview/12831";
const draft: IReviewDraft = {
  changesetId: 21,
  key: "draft-one",
  location: 4,
  path: "/Code/Test.cs",
  reviewId: REVIEW,
  revisionId: 42,
  workspaceId: "workspace",
};

/** A connection whose tokens are `synthetic-token-1`, then `-2` and on, a new one per renewal it is asked for. */
function connection(overrides: Partial<IReviewConnection> = {}):
    IReviewConnection & { stale: Array<string | undefined> } {
  const stale: Array<string | undefined> = [];
  let current = 1;
  return {
    organizations: ["acme-studio"],
    origin: ORIGIN,
    repository: "Nimbus/Nimbus",
    server: "acme-studio@unity",
    stale,
    token: previous => {
      stale.push(previous);
      if (previous !== undefined) {
        current++;
      }
      return Promise.resolve(`synthetic-token-${current}`);
    },
    user: ME,
    ...overrides,
  };
}

async function failure(action: Promise<unknown>): Promise<ReviewWriteError> {
  try {
    await action;
  } catch (error) {
    return error as ReviewWriteError;
  }
  throw new Error("Expected rejection");
}

/** Each call as `METHOD path`. */
function lines(calls: readonly IRestCall[]): string[] {
  return calls.map(call => `${call.method} ${call.path}`);
}

/** A fake API that answers writes with `status` and `body`, and the settling reads as usual. */
function answeringWrites(status: number, body: object | string = {}): FakeRest {
  const rest = new FakeRest();
  rest.respond = call => (call.method === "GET" ? undefined
    : { body: typeof body === "string" ? body : JSON.stringify(body), status });
  return rest;
}

describe("Review writes through the Server REST API (fake transport)", () => {
  it("settles the organization and the repository with reads, then adds the user with the token only in a header",
    async () => {
      const rest = new FakeRest();
      const requests: Array<{ headers: { readonly [name: string]: string }; url: string }> = [];
      const writer = new ReviewWriter((call, cancel) => {
        requests.push({ headers: call.headers, url: call.url.toString() });
        return rest.transport(call, cancel);
      });
      await writer.addReviewer(connection({ user: ` ${ME} ` }), REVIEW);
      expect(lines(rest.calls)).to.deep.equal([
        "GET /api/v1/organizations/acme-studio/user",
        `GET ${API}`,
        `POST ${API}/reviewers`,
      ]);
      expect(rest.calls[2].body).to.deep.equal({ reviewers: [ME] });
      expect(requests[0].headers)
        .to.deep.equal({ Accept: "application/json", Authorization: "Bearer synthetic-token-1" });
      expect(requests[2].headers).to.deep.equal({
        "Accept": "application/json", "Authorization": "Bearer synthetic-token-1", "Content-Type": "application/json",
      });
      expect(requests.map(request => request.url).join(" ")).to.not.contain("synthetic-token");
      expect(requests[2].url).to.equal(`https://${REGION}:7178${API}/reviewers`);

      // Both answers are kept: the next write is the only request.
      await writer.setStatus(connection(), REVIEW, "Reviewed");
      expect(lines(rest.calls.slice(3))).to.deep.equal([`PUT ${API}/reviewers/dana.kim%40example.test/status`]);
      expect(rest.calls[3].body).to.deep.equal({ status: "Reviewed" });
    });

  it("sends each write's documented method, path and body", async () => {
    const rest = new FakeRest();
    const writer = new ReviewWriter(rest.transport);
    for (const status of [ "Under review", "Reviewed", "Rework required" ] as const) {
      await writer.setStatus(connection(), REVIEW, status);
    }
    await writer.send(connection(), draft, "First line\nSecond line");
    await writer.send(connection(), { ...draft, key: "reply", location: -1, parentId: 2227, revisionId: -1 }, "Reply");
    expect(rest.writes().map(call => [ call.method, call.path.substring(API.length), call.body ])).to.deep.equal([
      [ "PUT", "/reviewers/dana.kim%40example.test/status", { status: "Under review" }],
      [ "PUT", "/reviewers/dana.kim%40example.test/status", { status: "Reviewed" }],
      [ "PUT", "/reviewers/dana.kim%40example.test/status", { status: "Rework required" }],
      [ "POST", "/comment", {
        changesetId: 21, commentText: "First line\nSecond line", locationSpec: "4", revisionId: 42, type: "Comment",
      }],
      [ "POST", "/comment/2227/reply", { commentText: "Reply" }],
    ]);
  });

  it("names the organization by its unityid when the REST API does not take its name, and says when it takes neither",
    async () => {
      const rest = new FakeRest();
      rest.organizations = ["1234567890123"];
      const writer = new ReviewWriter(rest.transport);
      await writer.addReviewer(connection({ organizations: [ "acme-studio", "1234567890123" ] }), REVIEW);
      expect(lines(rest.calls)).to.deep.equal([
        "GET /api/v1/organizations/acme-studio/user",
        "GET /api/v1/organizations/1234567890123/user",
        "GET /api/v1/organizations/1234567890123/repos/Nimbus%2FNimbus/codereview/12831",
        "POST /api/v1/organizations/1234567890123/repos/Nimbus%2FNimbus/codereview/12831/reviewers",
      ]);

      const refusing = new FakeRest();
      refusing.organizations = [];
      const error = await failure(new ReviewWriter(refusing.transport)
        .addReviewer(connection({ organizations: [ "acme-studio", "1234567890123" ] }), REVIEW));
      expect(error.message)
        .to.equal("The Unity Version Control REST API did not accept the token for this organization.");
      expect(error.uncertain).to.equal(false);
      expect(refusing.writes()).to.deep.equal([]);
    });

  it("encodes the repository as one segment, then as a path after a 404, and names the review when neither answers",
    async () => {
      const rest = new FakeRest();
      rest.repositories = ["Nimbus/Nimbus"];
      const writer = new ReviewWriter(rest.transport);
      await writer.send(connection(), draft, "Hello");
      expect(lines(rest.calls).slice(1)).to.deep.equal([
        `GET ${API}`,
        "GET /api/v1/organizations/acme-studio/repos/Nimbus/Nimbus/codereview/12831",
        "POST /api/v1/organizations/acme-studio/repos/Nimbus/Nimbus/codereview/12831/comment",
      ]);
      // The form that answered is kept for the repository, whichever review comes next.
      await writer.addReviewer(connection(), 312);
      expect(lines(rest.calls).slice(4))
        .to.deep.equal(["POST /api/v1/organizations/acme-studio/repos/Nimbus/Nimbus/codereview/312/reviewers"]);

      rest.repositories = [];
      const missing = await failure(new ReviewWriter(rest.transport).addReviewer(connection(), 7));
      expect(missing.message).to.equal("The Unity Version Control REST API has no review #7 in Nimbus/Nimbus, " +
        "with the repository's name as one path segment or as a path.");
      expect(repositoryForms("Nimbus")).to.deep.equal(["Nimbus"]);
      expect(repositoryForms("Nimbus/Sub Repo")).to.deep.equal([ "Nimbus%2FSub%20Repo", "Nimbus/Sub%20Repo" ]);
    });

  it("answers a 401 once with a renewed token, and a second 401 is an error", async () => {
    const rest = new FakeRest();
    rest.expired.add("synthetic-token-1");
    const conn = connection();
    const writer = new ReviewWriter(rest.transport);
    await writer.addReviewer(conn, REVIEW);
    expect(conn.stale).to.deep.equal([ undefined, "synthetic-token-1", undefined, undefined ]);
    expect(rest.calls.map(call => call.token)).to.deep.equal([
      "synthetic-token-1", "synthetic-token-2", "synthetic-token-2", "synthetic-token-2",
    ]);

    // Expired again at the write, and the renewed one too: sent twice, then refused, never a third time.
    rest.respond = call => (call.method === "POST" ? json(401, { error: { message: "The token has expired." }})
      : undefined);
    const error = await failure(writer.addReviewer(conn, REVIEW));
    expect(rest.writes().map(call => call.token).slice(1)).to.deep.equal([ "synthetic-token-2", "synthetic-token-3" ]);
    expect(error.message).to.equal("The Unity Version Control server refused the request: The token has expired.");
    expect(error.uncertain).to.equal(false);
  });

  it("sends nothing to a host the REST API does not document", async () => {
    expect(REST_HOSTS.map(host => restOrigin(host))).to.deep.equal(REST_HOSTS.map(host => `https://${host}:7178`));
    for (const region of [ "", "-", "cloud.plasticscm.com", `${REGION}.example.test`, `evil.${REGION}`, "localhost" ]) {
      expect(restOrigin(region), region).to.equal(undefined);
    }
    for (const origin of [ "https://api.example.test:7178", `http://${REGION}:7178`, `https://${REGION}:443`,
      `https://${REGION}` ]) {
      expect(() => restUrl(origin, "/api/v1/organizations"), origin).to.throw(ReviewWriteError);
    }
    expect(() => restUrl(ORIGIN, "//api.example.test/api")).to.throw(ReviewWriteError);
    expect(() => restUrl(ORIGIN, "/api/v1/organizations/../x")).to.throw(ReviewWriteError);
    expect(() => restUrl(ORIGIN, "/api/v1/organizations/%2e%2e/x")).to.throw(ReviewWriteError);
    expect(() => restUrl(ORIGIN, "/api/v1/organizations/a?b")).to.throw(ReviewWriteError);
    expect(restUrl(ORIGIN, "/api/v1/organizations/acme-studio/user").toString())
      .to.equal(`${ORIGIN}/api/v1/organizations/acme-studio/user`);

    let sent = 0;
    const writer = new ReviewWriter(() => {
      sent++;
      return Promise.resolve(json(200, {}));
    });
    const elsewhere = await failure(
      writer.addReviewer(connection({ origin: "https://api.example.test:7178" }), REVIEW));
    expect(elsewhere.message).to.equal("The Unity Version Control REST API did not accept the token for this " +
      "organization.");
    // A repository that would climb out of its path has no form to send.
    const climbing = await failure(writer.addReviewer(connection({ repository: ".." }), REVIEW));
    expect(climbing.message).to.contain("has no review #12831 in ..");
    expect(sent).to.equal(1);
  });

  it("takes any 2xx as success, and maps 400, 403, 404 and other 4xx to what the server said", async () => {
    for (const status of [ 200, 201, 204 ]) {
      await new ReviewWriter(answeringWrites(status).transport).setStatus(connection(), REVIEW, "Reviewed");
    }
    const message = { error: { message: "Status is not valid for this review." }};
    const cases: Array<{ status: number; body: object | string; expected: string; write?: "status" }> = [
      { body: message, expected: "The Unity Version Control server rejected the request: Status is not valid for " +
        "this review.", status: 400 },
      { body: "", expected: "The Unity Version Control server rejected the request (HTTP 400).", status: 400 },
      { body: { title: "Forbidden", type: "about:blank" }, expected: "The Unity Version Control server refused the " +
        "request: Forbidden. Only reviewers can set their own status.", status: 403, write: "status" },
      { body: {}, expected: "The Unity Version Control server refused the request.", status: 403 },
      { body: message, expected: "The Unity Version Control server has no review #12831 in Nimbus/Nimbus.",
        status: 404 },
      { body: { detail: "Too many requests" }, expected: "The Unity Version Control server refused the request " +
        "(HTTP 429): Too many requests.", status: 429 },
      { body: "", expected: "The Unity Version Control server refused the request (HTTP 302).", status: 302 },
    ];
    for (const entry of cases) {
      const rest = answeringWrites(entry.status, entry.body);
      const writer = new ReviewWriter(rest.transport);
      const error = await failure(entry.write === "status"
        ? writer.setStatus(connection(), REVIEW, "Reviewed")
        : writer.send(connection(), draft, "Hello"));
      expect(error.message, `${entry.status} ${JSON.stringify(entry.body)}`).to.equal(entry.expected);
      expect(error.uncertain).to.equal(false);
      expect(rest.writes(), String(entry.status)).to.have.length(1);
    }
  });

  it("says a 5xx, a 408 and no complete answer may have taken effect, and never sends such a write again",
    async () => {
      for (const status of [ 500, 502, 503, 408 ]) {
        const rest = answeringWrites(status, { error: { message: "Internal error" }});
        const error = await failure(new ReviewWriter(rest.transport).addReviewer(connection(), REVIEW));
        expect(error.message).to.equal(`The Unity Version Control server returned HTTP ${status}. You may have been ` +
          "added; refresh the review before retrying.");
        expect(error.uncertain).to.equal(true);
        expect(rest.writes()).to.have.length(1);
      }
      const rejecting = (reason: Error) => {
        const rest = new FakeRest();
        rest.respond = call => (call.method === "GET" ? undefined : Promise.reject(reason));
        return rest;
      };
      const cases: Array<[Error, string]> = [
        [ new ReviewRequestError("failed", true), "No complete response was received. Your status may have been " +
          "set; refresh the review before retrying." ],
        [ new ReviewRequestError("interrupted", true), "The response was interrupted. Your status may have been set; " +
          "refresh the review before retrying." ],
        [ new ReviewRequestError("cancelled", true), "Cancelled before the Unity Version Control server answered. " +
          "Your status may have been set; refresh the review before retrying." ],
        [ new Error("synthetic-token-1 socket detail"), "The request ended without a confirmed result. Your status " +
          "may have been set; refresh the review before retrying." ],
      ];
      for (const [ reason, expected ] of cases) {
        const rest = rejecting(reason);
        const error = await failure(new ReviewWriter(rest.transport).setStatus(connection(), REVIEW, "Reviewed"));
        expect(error.message).to.equal(expected);
        expect(error.uncertain).to.equal(true);
        expect(rest.writes()).to.have.length(1);
      }
      const unsent = rejecting(new ReviewRequestError("cancelled", false));
      const cancelled = await failure(new ReviewWriter(unsent.transport).send(connection(), draft, "Hello"));
      expect(cancelled.message).to.equal("Cancelled before anything was sent.");
      expect(cancelled.uncertain).to.equal(false);
    });

  it("treats a failed read as certain: nothing was written", async () => {
    const rest = new FakeRest();
    rest.respond = call => (call.path.endsWith("/user") ? json(503, {}) : undefined);
    const busy = await failure(new ReviewWriter(rest.transport).addReviewer(connection(), REVIEW));
    expect(busy.message)
      .to.equal("The Unity Version Control server returned HTTP 503. Nothing was changed; try again.");
    expect(busy.uncertain).to.equal(false);

    rest.respond = call => (call.method === "GET" && !call.path.endsWith("/user")
      ? Promise.reject(new ReviewRequestError("failed", true)) : undefined);
    const silent = await failure(new ReviewWriter(rest.transport).addReviewer(connection(), REVIEW));
    expect(silent.message).to.equal("The Unity Version Control server did not answer. Nothing was changed; try again.");
    expect(silent.uncertain).to.equal(false);

    rest.respond = call => (call.method === "GET" && !call.path.endsWith("/user")
      ? json(403, { message: "No access to this repository." }) : undefined);
    const refused = await failure(new ReviewWriter(rest.transport).addReviewer(connection(), REVIEW));
    expect(refused.message).to.equal("The Unity Version Control server refused the request: No access to this " +
      "repository.");
    expect(rest.writes()).to.deep.equal([]);
  });

  it("fails an add answered with another reviewer as a result to check, and takes the user in any case", async () => {
    const other = answeringWrites(201, { isGroup: false, reviewer: "sam.rivera@example.test", status: "Under review" });
    const error = await failure(new ReviewWriter(other.transport).addReviewer(connection(), REVIEW));
    expect(error.message).to.equal("The Unity Version Control server answered with another reviewer. Refresh the " +
      "review to check whether you were added.");
    expect(error.uncertain).to.equal(true);
    const same = answeringWrites(201, { isGroup: false, reviewer: "Dana.Kim@Example.TEST", status: "Under review" });
    await new ReviewWriter(same.transport).addReviewer(connection(), REVIEW);
    // A body that is not a CodeReviewerModel says nothing about who was added.
    await new ReviewWriter(answeringWrites(200, "[]").transport).addReviewer(connection(), REVIEW);
  });

  it("refuses a user that is not an e-mail address, a bad review id, status or anchor, and a token unfit for a header",
    async () => {
      const rest = new FakeRest();
      const writer = new ReviewWriter(rest.transport);
      for (const user of [ "dana", "dana@localhost", "dana kim@example.test", "", "<dana@example.test>" ]) {
        const error = await failure(writer.addReviewer(connection({ user }), REVIEW));
        expect(error.message, user).to.contain("is not an e-mail address");
      }
      for (const id of [ 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1 ]) {
        expect((await failure(writer.addReviewer(connection(), id))).message, String(id))
          .to.match(/^Invalid review id/);
      }
      expect((await failure(writer.setStatus(connection(), REVIEW, "Approved" as "Reviewed"))).message)
        .to.equal("Invalid review status: Approved");
      expect((await failure(writer.send(connection(), draft, "  "))).message)
        .to.equal("Enter a comment of at most 64,000 characters.");
      expect((await failure(writer.send(connection(), { ...draft, location: -1 }, "Hello"))).message)
        .to.equal("This comment does not have a valid pinned revision and line.");
      expect((await failure(writer.send(connection(), { ...draft, parentId: -2 }, "Hello"))).message)
        .to.equal("Invalid reply target.");
      const injected = await failure(writer.addReviewer(connection({
        token: () => Promise.resolve("synthetic-token\r\nX-Evil: 1"),
      }), REVIEW));
      expect(injected.message).to.equal("cm revealed a token that cannot be sent in a request.");
      const refused = await failure(writer.addReviewer(connection({
        token: () => Promise.reject(new Error("Create a personal access token for acme-studio@unity first.")),
      }), REVIEW));
      expect(refused.message).to.equal("Create a personal access token for acme-studio@unity first.");
      expect(refused.uncertain).to.equal(false);
      expect(rest.calls).to.deep.equal([]);
    });

  it("blocks concurrent duplicate sends and never resends an accepted draft", async () => {
    const rest = new FakeRest();
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    rest.respond = call => (call.method === "POST" ? held.then(() => json(201, { id: 20001 })) : undefined);
    const writer = new ReviewWriter(rest.transport);
    const first = writer.send(connection(), draft, "Hello");
    expect((await failure(writer.send(connection(), draft, "Hello"))).message)
      .to.equal("This draft is already sending or has been sent.");
    release();
    await first;
    expect((await failure(writer.send(connection(), draft, "Hello"))).message).to.contain("already");
    expect(rest.writes()).to.have.length(1);
  });

  it("shows what an ErrorResponse or ProblemDetails says, without anything shaped like a token", () => {
    const jwt = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJzeW50aGV0aWMifQ.c3ludGhldGlj";
    expect(serverMessage(JSON.stringify({ error: { message: `Token ${jwt} is not valid.` }})))
      .to.equal("Token [token] is not valid.");
    expect(serverMessage(JSON.stringify({ message: "Plain synthetic-token-1 text" }), "synthetic-token-1"))
      .to.equal("Plain [token] text");
    expect(serverMessage(JSON.stringify({ detail: "Details", title: "  Title\nhere " }))).to.equal("Title here");
    expect(serverMessage(JSON.stringify({ detail: "x".repeat(300) }))).to.have.length(200);
    for (const body of [ "", "not json", "[]", "{}", JSON.stringify({ message: 5 }), JSON.stringify({ title: " " }) ]) {
      expect(serverMessage(body), body).to.equal(undefined);
    }
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
      const writer = new ReviewWriter(httpsTransport);
      const error = await failure(writer.addReviewer(connection(), REVIEW, source.token));
      expect(error.message).to.equal("Cancelled before anything was changed.");
      expect(error.uncertain).to.equal(false);
      const direct = await failure(httpsTransport({ body: "{}", headers: {}, method: "POST",
        url: restUrl(ORIGIN, "/api/v1/organizations/acme-studio/user") }, source.token));
      expect(direct).to.be.instanceOf(ReviewRequestError);
      expect(opened).to.equal(0);
    } finally {
      api.request = original;
      source.dispose();
    }
  });
});
