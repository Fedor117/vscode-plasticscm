import { IWriteRequest, IWriteResponse, ReviewTransport } from "../../../reviews/reviewWriter";
import { CancellationToken } from "vscode";
import { ORIGIN } from "./tokenFixtures";

/**
 * The Unity Version Control Server REST API in memory, for review writes.
 * Nothing here reaches the network, and every organization, repository,
 * review and token is made up.
 */

/** One request the fake REST API received: its method, raw path, JSON body and token. */
export interface IRestCall {
  method: string;
  path: string;
  body?: unknown;
  token: string;
}

/**
 * The REST API in memory, for the routes review writes use: the organization
 * check, a review read, adding reviewers, a reviewer's status, comments and
 * replies. `respond` may answer any call first; `onWrite` sees every write it
 * accepts. Tokens in `expired` are answered 401.
 */
export class FakeRest {
  public readonly calls: IRestCall[] = [];
  /** The organization names the API accepts in a path. */
  public organizations = ["acme-studio"];
  /** The repository names the API accepts in a path, exactly as the path writes them. */
  public repositories = ["Nimbus%2FNimbus"];
  /** The reviews it knows, in every repository. */
  public reviews = new Set<number>([ 12831, 312, 7 ]);
  public readonly expired = new Set<string>();
  public respond?: (call: IRestCall) => IWriteResponse | Promise<IWriteResponse> | undefined;
  public onWrite?: (call: IRestCall) => void;
  public readonly transport: ReviewTransport = (call, cancel) => this.handle(call, cancel);

  /** The calls that were not reads. */
  public writes(): IRestCall[] {
    return this.calls.filter(call => call.method !== "GET");
  }

  private async handle(request: IWriteRequest, cancel?: CancellationToken): Promise<IWriteResponse> {
    if (request.url.origin !== ORIGIN) {
      throw new Error(`The fake REST API was sent a request for ${request.url.origin}`);
    }
    const token = (request.headers.Authorization ?? "").replace(/^Bearer /, "");
    const call: IRestCall = {
      method: request.method,
      path: request.url.pathname,
      token,
      ...(request.body === undefined ? {} : { body: JSON.parse(request.body) as unknown }),
    };
    this.calls.push(call);
    const custom = await this.respond?.(call);
    if (custom) {
      return custom;
    }
    if (cancel?.isCancellationRequested) {
      throw new Error("cancelled");
    }
    if (!token || this.expired.has(token)) {
      return json(401, { error: { message: "The token has expired." }});
    }
    const organization = /^\/api\/v1\/organizations\/([^/]+)\/(.*)$/.exec(call.path);
    if (!organization || !this.organizations.includes(organization[1])) {
      return json(404, { error: { message: "Organization not found." }});
    }
    const rest = organization[2];
    if (rest === "user") {
      return request.method === "GET" ? json(200, { email: "someone@example.test" }) : json(405, {});
    }
    const review = /^repos\/(.+)\/codereview\/(\d+)(\/.*)?$/.exec(rest);
    if (!review || !this.repositories.includes(review[1]) || !this.reviews.has(Number(review[2]))) {
      return json(404, { error: { message: "Code review not found." }});
    }
    const [ , , id, route = "" ] = review;
    if (request.method === "GET" && !route) {
      return json(200, { id: Number(id), status: "Under review", title: "Synthetic review" });
    }
    const write = (answer: object) => {
      this.onWrite?.(call);
      return json(200, answer);
    };
    if (request.method === "POST" && route === "/reviewers") {
      const [reviewer] = (call.body as { reviewers: string[] }).reviewers;
      return write({ isGroup: false, reviewer, status: "Under review" });
    }
    const status = /^\/reviewers\/([^/]+)\/status$/.exec(route);
    if (request.method === "PUT" && status) {
      return write({ isGroup: false, reviewer: decodeURIComponent(status[1]), ...(call.body as object) });
    }
    if (request.method === "POST" && (route === "/comment" || /^\/comment\/\d+\/reply$/.test(route))) {
      return write({ id: 20001, ...(call.body as object) });
    }
    return json(404, {});
  }
}

export function json(status: number, body: object): IWriteResponse {
  return { body: JSON.stringify(body), status };
}
