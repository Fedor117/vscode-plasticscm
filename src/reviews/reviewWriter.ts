import { CancellationToken } from "vscode";
import { request } from "https";
import { ReviewRequestError } from "./reviewRequestError";
import { ReviewStatus } from "./models";
import { ReviewWriteError } from "./reviewWriteError";

export { ReviewRequestError, ReviewWriteError };

/**
 * The regional servers of the Unity Version Control Server REST API, as its
 * documentation lists them (https://docs.unity.com/en-us/oas-unity-version-control-server/1.0.0),
 * all on port 7178. No other host is ever sent a request, or a token.
 */
export const REST_HOSTS: readonly string[] = [
  "prd-azure-eastus-01-cloud.plasticscm.com",
  "prd-azure-westeu-01-cloud.plasticscm.com",
  "prd-azure-eastjp-01-cloud.plasticscm.com",
  "prd-azure-seasia-01-cloud.plasticscm.com",
];

/**
 * Where review writes go and as whom: the documented REST origin, the server
 * and the user as cm names them, what the organization may be called in a
 * path, the repository, and the personal access token.
 */
export interface IReviewConnection {
  /** `https://<documented host>:7178`, from `restOrigin`. */
  origin: string;
  /** The repository's server spec, such as `acme-studio@unity`. */
  server: string;
  /** What the organization may be called in a path, in the order to try: cm's `{name}`, then its `{unityid}`. */
  organizations: readonly string[];
  /** The repository's name, as the workspace's spec writes it; `/` separates a sub-repository. */
  repository: string;
  /** The cm user: whose token this is, and whom Add Me as Reviewer adds. */
  user: string;
  /**
   * The token. Given the one the server answered 401 to, it drops that one
   * and reveals it again. Rejects with a message that is safe to show.
   */
  token(stale?: string): Promise<string>;
}
export interface IReviewDraft {
  key: string;
  workspaceId: string;
  reviewId: number;
  revisionId: number;
  changesetId: number;
  location: number;
  path: string;
  parentId?: number;
}
/** One request to the REST API, complete but for its length; the transport sends it as it is. */
export interface IWriteRequest {
  method: "GET" | "POST" | "PUT";
  url: URL;
  headers: { readonly [name: string]: string };
  /** JSON; POST and PUT only. */
  body?: string;
}
export interface IWriteResponse {
  status: number;
  body: string;
}
/**
 * Sends one request and resolves the answer, whatever its status, or rejects
 * with a ReviewRequestError when no complete answer came. The only code here
 * that reaches the network, so tests replace it.
 */
export type ReviewTransport = (call: IWriteRequest, cancel?: CancellationToken) => Promise<IWriteResponse>;

/** A write, for its request and its messages: `effect` says what may have happened when the answer is unknown. */
interface IWrite {
  reviewId: number;
  method: "POST" | "PUT";
  /** After `…/codereview/{id}`. */
  path: string;
  payload: object;
  effect: string;
  /** Said after a 403. */
  forbidden?: string;
}

const REST_PORT = "7178";
const STATUSES: readonly ReviewStatus[] = [ "Under review", "Reviewed", "Rework required" ];
const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;
/** A token that can go into a header as it is: printable ASCII without spaces. */
const HEADER_TOKEN = /^[\x21-\x7e]+$/;
/** Something@somewhere.tld without spaces or the characters an address list would split on. */
const EMAIL = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:".]+$/;
const SERVER = "The Unity Version Control server";

/** Whether a cm user name is an e-mail address, which is how Unity Version Control names reviewers. */
export function isEmailAddress(user: string): boolean {
  return EMAIL.test(user.trim());
}

/**
 * The REST API's origin for an organization in `region`, which `cm getconfig
 * organization` prints as a host; undefined unless it is a documented one.
 */
export function restOrigin(region: string): string | undefined {
  const host = region.trim();
  return REST_HOSTS.includes(host) ? `https://${host}:${REST_PORT}` : undefined;
}

/**
 * A REST API URL: a documented origin and a path of percent-encoded segments.
 * Refuses any other origin, and an empty, `.` or `..` segment, which a URL
 * would resolve into another path.
 */
export function restUrl(origin: string, path: string): URL {
  let url: URL | undefined;
  try {
    url = new URL(path, origin);
  } catch {
    url = undefined;
  }
  if (!url || url.protocol !== "https:" || !REST_HOSTS.includes(url.hostname) || url.port !== REST_PORT ||
    url.origin !== origin) {
    throw new ReviewWriteError("Review writes only go to the documented Unity Version Control Server REST API.");
  }
  const segments = path.split("/").slice(1);
  if (!path.startsWith("/") || segments.some(segment => !segment || /^(?:\.|%2e){1,2}$/i.test(segment)) ||
    url.pathname !== path || url.search || url.hash) {
    throw new ReviewWriteError("This review, organization or repository cannot be named in a request.");
  }
  return url;
}

/**
 * How a repository's name may go into a path, in the order to try: as one
 * segment (a `/` encoded as `%2F`), then a segment per `/`-separated part.
 * One form for a name without `/`.
 */
export function repositoryForms(repository: string): string[] {
  const whole = encodeURIComponent(repository);
  const parts = repository.split("/").map(part => encodeURIComponent(part)).join("/");
  return whole === parts ? [whole] : [ whole, parts ];
}

/**
 * What an ErrorResponse (`{ "error": { "message" } }`) or ProblemDetails
 * (`title`, `detail`) body says: its first message, title or detail, on one
 * line and at most 200 characters, without anything JWT-shaped or the token.
 * Undefined for any other body.
 */
export function serverMessage(body: string, token?: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const nested = isRecord(value.error) ? value.error.message : undefined;
  const text = [ value.message, nested, value.title, value.detail ]
    .find((candidate): candidate is string => typeof candidate === "string" && !!candidate.trim());
  if (text === undefined) {
    return undefined;
  }
  let clean = text.replace(JWT, "[token]");
  if (token) {
    clean = clean.split(token).join("[token]");
  }
  return clean.replace(/\s+/g, " ").trim().substring(0, 200);
}

/** Over https, with a 30-second timeout; cancelling destroys the request. Redirects are not followed. */
export const httpsTransport: ReviewTransport = (call, cancel) => new Promise((resolve, reject) => {
  if (cancel?.isCancellationRequested) {
    reject(new ReviewRequestError("cancelled", false));
    return;
  }
  let cancelled = false;
  const headers = call.body === undefined
    ? { ...call.headers }
    : { ...call.headers, "Content-Length": Buffer.byteLength(call.body) };
  const req = request(call.url, { headers, method: call.method }, response => {
    let data = "";
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      if (data.length + chunk.length > 1024 * 1024) {
        req.destroy(new Error("Response too large"));
        return;
      }
      data += chunk;
    });
    response.on("error", () => reject(new ReviewRequestError(cancelled ? "cancelled" : "interrupted", true)));
    response.on("end", () => resolve({ body: data, status: response.statusCode ?? 0 }));
  });
  const listener = cancel?.onCancellationRequested(() => {
    cancelled = true;
    req.destroy(new Error("Cancelled"));
  });
  req.on("close", () => {
    listener?.dispose();
  });
  req.setTimeout(30000, () => req.destroy(new Error("Timeout")));
  req.on("error", () => reject(new ReviewRequestError(cancelled ? "cancelled" : "failed", true)));
  req.end(call.body);
});

/**
 * Review writes through the Unity Version Control Server REST API: Add Me as
 * Reviewer, the cm user's own verdict, comments and replies. How a path names
 * the organization and the repository is not documented for every kind of
 * organization, so before the first write each is settled with a read, and
 * the answer is kept. A 401 is answered once with a renewed token: the server
 * did not process the call. Nothing else is retried, and nothing a write may
 * have done is sent again without the caller asking.
 */
export class ReviewWriter {
  private readonly sending = new Set<string>();
  private readonly completed = new Set<string>();
  /** The organization name the REST API took, per origin, server and user; see `organization`. */
  private readonly organizations = new Map<string, string>();
  /** How a repository's name goes into a path, once a review read answered to it; see `repositoryPath`. */
  private readonly repositories = new Map<string, string>();
  public constructor(private readonly transport: ReviewTransport = httpsTransport) {}

  /** A comment, or a reply when the draft has a parent; a draft that is sending or was sent is refused. */
  public async send(connection: IReviewConnection, draft: IReviewDraft, text: string, cancel?: CancellationToken):
      Promise<void> {
    if (this.sending.has(draft.key) || this.completed.has(draft.key)) {
      throw new ReviewWriteError("This draft is already sending or has been sent.");
    }
    const write = commentWrite(draft, text);
    this.sending.add(draft.key);
    try {
      await this.write(connection, write, cancel);
      this.completed.add(draft.key);
    } finally {
      this.sending.delete(draft.key);
    }
  }

  /**
   * Adds the cm user to a review's reviewers. Any 2xx is success, but an
   * answer that names another reviewer is not. What the server answers for
   * someone who is already a reviewer is not verified, so the caller must not
   * send a second add while one is in flight: unlike `send`, this sends every
   * call (ReviewSession keeps one add per review).
   */
  public async addReviewer(connection: IReviewConnection, reviewId: number, cancel?: CancellationToken):
      Promise<void> {
    checkReviewId(reviewId);
    const user = connection.user.trim();
    if (!isEmailAddress(user)) {
      throw new ReviewWriteError(`"${user}" is not an e-mail address, and Unity Version Control names reviewers ` +
        "by e-mail address.");
    }
    const response = await this.write(connection, {
      effect: "You may have been added",
      method: "POST",
      path: "/reviewers",
      payload: { reviewers: [user] },
      reviewId,
    }, cancel);
    const reviewer = answeredReviewer(response.body);
    if (reviewer !== undefined && !sameAddress(reviewer, user)) {
      throw new ReviewWriteError(`${SERVER} answered with another reviewer. Refresh the review to check whether ` +
        "you were added.", true);
    }
  }

  /** The cm user's own verdict on a review, which only a reviewer can give. */
  public async setStatus(
      connection: IReviewConnection,
      reviewId: number,
      status: ReviewStatus,
      cancel?: CancellationToken): Promise<void> {
    checkReviewId(reviewId);
    if (!STATUSES.includes(status)) {
      throw new ReviewWriteError(`Invalid review status: ${String(status)}`);
    }
    await this.write(connection, {
      effect: "Your status may have been set",
      forbidden: "Only reviewers can set their own status.",
      method: "PUT",
      path: `/reviewers/${encodeURIComponent(connection.user.trim())}/status`,
      payload: { status },
      reviewId,
    }, cancel);
  }

  /** Settles the organization and the repository's path with reads, then sends the write; resolves a 2xx answer. */
  private async write(connection: IReviewConnection, write: IWrite, cancel?: CancellationToken):
      Promise<IWriteResponse> {
    const organization = await this.organization(connection, cancel);
    const repository = await this.repositoryPath(connection, organization, write.reviewId, cancel);
    const url = restUrl(connection.origin, `/api/v1/organizations/${encodeURIComponent(organization)}` +
      `/repos/${repository}/codereview/${write.reviewId}${write.path}`);
    let answer: { response: IWriteResponse; token: string };
    try {
      answer = await this.exchange(connection, { body: JSON.stringify(write.payload), method: write.method, url },
        cancel);
    } catch (error) {
      throw exchangeError(error, write.effect);
    }
    const { response, token } = answer;
    if (response.status >= 200 && response.status < 300) {
      return response;
    }
    throw writeFailure(response.status, serverMessage(response.body, token), write, connection.repository);
  }

  /**
   * The organization's name in a path: each of cm's names in turn, until
   * `GET …/organizations/{orgName}/user` answers 200 to one. Kept per origin,
   * server and user once one has.
   */
  private async organization(connection: IReviewConnection, cancel?: CancellationToken): Promise<string> {
    const key = JSON.stringify([ connection.origin, connection.server, connection.user.trim().toLowerCase() ]);
    const known = this.organizations.get(key);
    if (known !== undefined) {
      return known;
    }
    const names = connection.organizations.filter((name, index, all) => !!name.trim() && all.indexOf(name) === index);
    for (const name of names) {
      const url = tryUrl(connection.origin, `/api/v1/organizations/${encodeURIComponent(name)}/user`);
      if (!url) {
        continue;
      }
      const { response } = await this.read(connection, url, cancel);
      if (response.status === 200) {
        this.organizations.set(key, name);
        return name;
      }
      if (isUncertain(response.status)) {
        throw new ReviewWriteError(`${SERVER} returned HTTP ${response.status}. Nothing was changed; try again.`);
      }
    }
    throw new ReviewWriteError("The Unity Version Control REST API did not accept the token for this organization.");
  }

  /**
   * The repository's name in a path: `GET …/repos/{repoName}/codereview/{id}`
   * with each of `repositoryForms` in turn, the next only after a 404. The
   * form that answered 200 is kept for the repository.
   */
  private async repositoryPath(
      connection: IReviewConnection,
      organization: string,
      reviewId: number,
      cancel?: CancellationToken): Promise<string> {
    const key = JSON.stringify([ connection.origin, organization, connection.repository ]);
    const known = this.repositories.get(key);
    if (known !== undefined) {
      return known;
    }
    for (const form of repositoryForms(connection.repository)) {
      const url = tryUrl(connection.origin,
        `/api/v1/organizations/${encodeURIComponent(organization)}/repos/${form}/codereview/${reviewId}`);
      if (!url) {
        continue;
      }
      const { response, token } = await this.read(connection, url, cancel);
      if (response.status === 200) {
        this.repositories.set(key, form);
        return form;
      }
      if (response.status !== 404) {
        throw readFailure(response.status, serverMessage(response.body, token));
      }
    }
    throw new ReviewWriteError(`The Unity Version Control REST API has no review #${reviewId} in ` +
      `${connection.repository}, with the repository's name as one path segment or as a path.`);
  }

  /** A read before a write: it changes nothing whatever happens, so its failure is certain. */
  private async read(connection: IReviewConnection, url: URL, cancel?: CancellationToken):
      Promise<{ response: IWriteResponse; token: string }> {
    try {
      return await this.exchange(connection, { method: "GET", url }, cancel);
    } catch (error) {
      if (error instanceof ReviewWriteError) {
        throw error;
      }
      throw new ReviewWriteError(error instanceof ReviewRequestError && error.reason === "cancelled"
        ? "Cancelled before anything was changed."
        : `${SERVER} did not answer. Nothing was changed; try again.`);
    }
  }

  /**
   * Sends a call with the token, and once more with a renewed one when the
   * answer is 401, which means the server did not process it. Resolves the
   * last answer and the token it went with.
   */
  private async exchange(
      connection: IReviewConnection,
      call: Pick<IWriteRequest, "method" | "url" | "body">,
      cancel?: CancellationToken): Promise<{ response: IWriteResponse; token: string }> {
    let token = await this.token(connection);
    let response = await this.transport(authorized(call, token), cancel);
    if (response.status === 401) {
      token = await this.token(connection, token);
      response = await this.transport(authorized(call, token), cancel);
    }
    return { response, token };
  }

  private async token(connection: IReviewConnection, stale?: string): Promise<string> {
    let token: string;
    try {
      token = await connection.token(stale);
    } catch (error) {
      throw new ReviewWriteError(error instanceof Error ? error.message : String(error));
    }
    if (!HEADER_TOKEN.test(token)) {
      throw new ReviewWriteError("cm revealed a token that cannot be sent in a request.");
    }
    return token;
  }
}

/** A comment's or a reply's write; validated before anything is sent. */
function commentWrite(draft: IReviewDraft, text: string): IWrite {
  if (!text.trim() || text.length > 64000) {
    throw new ReviewWriteError("Enter a comment of at most 64,000 characters.");
  }
  checkReviewId(draft.reviewId);
  if (draft.parentId !== undefined) {
    if (!Number.isSafeInteger(draft.parentId) || draft.parentId < 0) {
      throw new ReviewWriteError("Invalid reply target.");
    }
    return {
      effect: "The reply may have been posted",
      method: "POST",
      path: `/comment/${draft.parentId}/reply`,
      payload: { commentText: text },
      reviewId: draft.reviewId,
    };
  }
  const anchors = [ draft.revisionId, draft.changesetId, draft.location ];
  if (anchors.some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new ReviewWriteError("This comment does not have a valid pinned revision and line.");
  }
  // Experimental: cm uses zero-based locations; the REST API's string encoding of a line is unverified.
  return {
    effect: "The comment may have been posted",
    method: "POST",
    path: "/comment",
    payload: {
      changesetId: draft.changesetId,
      commentText: text,
      locationSpec: String(draft.location),
      revisionId: draft.revisionId,
      type: "Comment",
    },
    reviewId: draft.reviewId,
  };
}

function checkReviewId(reviewId: number): void {
  if (!Number.isSafeInteger(reviewId) || reviewId <= 0) {
    throw new ReviewWriteError(`Invalid review id: ${String(reviewId)}`);
  }
}

function tryUrl(origin: string, path: string): URL | undefined {
  try {
    return restUrl(origin, path);
  } catch {
    return undefined;
  }
}

function authorized(call: Pick<IWriteRequest, "method" | "url" | "body">, token: string): IWriteRequest {
  const headers: { [name: string]: string } = { Accept: "application/json", Authorization: `Bearer ${token}` };
  if (call.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  return { ...call, headers };
}

/** A status after which the request may or may not have taken effect. */
function isUncertain(status: number): boolean {
  return status >= 500 || status === 0 || status === 408;
}

/** A write's answer that is not a 2xx, as a message safe to show. */
function writeFailure(status: number, message: string | undefined, write: IWrite, repository: string):
    ReviewWriteError {
  if (status === 401 || status === 403) {
    return new ReviewWriteError([ refused(message), status === 403 ? write.forbidden : undefined ]
      .filter(Boolean).join(" "));
  }
  if (status === 404) {
    return new ReviewWriteError(`${SERVER} has no review #${write.reviewId} in ${repository}.`);
  }
  if (status === 400) {
    return new ReviewWriteError(message
      ? `${SERVER} rejected the request: ${sentence(message)}`
      : `${SERVER} rejected the request (HTTP 400).`);
  }
  if (isUncertain(status)) {
    return new ReviewWriteError(
      `${SERVER} returned HTTP ${status}. ${write.effect}; refresh the review before retrying.`, true);
  }
  return new ReviewWriteError(`${SERVER} refused the request (HTTP ${status})` +
    (message ? `: ${sentence(message)}` : "."));
}

/** A read's answer that is neither 200 nor 404: nothing was written. */
function readFailure(status: number, message: string | undefined): ReviewWriteError {
  if (status === 401 || status === 403) {
    return new ReviewWriteError(refused(message));
  }
  return new ReviewWriteError(isUncertain(status)
    ? `${SERVER} returned HTTP ${status}. Nothing was changed; try again.`
    : `${SERVER} refused the request (HTTP ${status})${message ? `: ${sentence(message)}` : "."}`);
}

function refused(message: string | undefined): string {
  return message ? `${SERVER} refused the request: ${sentence(message)}` : `${SERVER} refused the request.`;
}

/** The text with a full stop, unless it ends a sentence already. */
function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** An exchange that ended without an answer, as a message safe to show; `effect` says what may have happened. */
function exchangeError(error: unknown, effect: string): ReviewWriteError {
  if (error instanceof ReviewWriteError) {
    return error;
  }
  if (error instanceof ReviewRequestError) {
    if (!error.sent) {
      return new ReviewWriteError("Cancelled before anything was sent.");
    }
    const what = error.reason === "interrupted" ? "The response was interrupted."
      : error.reason === "cancelled" ? "Cancelled before the Unity Version Control server answered."
        : "No complete response was received.";
    return new ReviewWriteError(`${what} ${effect}; refresh the review before retrying.`, true);
  }
  return new ReviewWriteError(
    `The request ended without a confirmed result. ${effect}; refresh the review before retrying.`, true);
}

/** The reviewer a CodeReviewerModel answer names, `{ "reviewer": "<name>", … }`; undefined for any other body. */
function answeredReviewer(body: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  return isRecord(value) && typeof value.reviewer === "string" ? value.reviewer : undefined;
}

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** E-mail addresses compare without case: cm and the server may spell one differently. */
function sameAddress(a: string, b: string): boolean {
  return !!a.trim() && a.trim().toLowerCase() === b.trim().toLowerCase();
}
