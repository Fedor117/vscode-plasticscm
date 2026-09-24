import { CancellationToken } from "vscode";
import { request } from "https";
import { ReviewRequestError } from "./reviewRequestError";
import { ReviewWriteError } from "./reviewWriteError";

export { ReviewRequestError, ReviewWriteError };

export interface IReviewWriteConnection {
  organization: string;
  repository: string;
  token: string;
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
/** One request to the review service, complete but for its length; the transport sends it as it is. */
export interface IWriteRequest {
  method: "POST";
  url: URL;
  headers: { readonly [name: string]: string };
  body: string;
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

const SERVICE = "https://services.api.unity.com/plastic/v1";
/** Something@somewhere.tld without spaces or the characters an address list would split on. */
const EMAIL = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:".]+$/;

/** Whether a cm user name is an e-mail address, which is how the hosted API names reviewers. */
export function isEmailAddress(user: string): boolean {
  return EMAIL.test(user.trim());
}

/** Deliberately fixed host: workspace settings cannot redirect a saved credential. */
export function commentRequest(connection: IReviewWriteConnection, draft: IReviewDraft, text: string): IWriteRequest {
  if (!text.trim() || text.length > 64000) {
    throw new ReviewWriteError("Enter a comment of at most 64,000 characters.");
  }
  for (const value of draft.parentId === undefined ?
    [ draft.reviewId, draft.revisionId, draft.changesetId, draft.location ] : [draft.reviewId]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ReviewWriteError("This comment does not have a valid pinned revision and line.");
    }
  }
  let path = "/comments";
  let payload: object;
  if (draft.parentId !== undefined) {
    if (!Number.isSafeInteger(draft.parentId) || draft.parentId < 0) {
      throw new ReviewWriteError("Invalid reply target.");
    }
    path += `/${draft.parentId}/replies`;
    // Experimental: the published reply endpoint omits its body schema.
    payload = { commentText: text };
  } else {
    // Experimental: cm uses zero-based locations; the hosted string encoding is unverified.
    payload = {
      changesetId: draft.changesetId,
      commentText: text,
      locationSpec: String(draft.location),
      revisionId: draft.revisionId,
      type: "Comment",
    };
  }
  return post(connection, reviewUrl(connection, draft.reviewId, path), payload);
}

/**
 * The hosted API's `addReviewers` (POST …/code-reviews/{id}/reviewers) for one
 * user, named by e-mail address. The body could also carry reviewer objects
 * with a status; a plain string is all this needs.
 */
export function addReviewersRequest(connection: IReviewWriteConnection, reviewId: number, user: string): IWriteRequest {
  if (!Number.isSafeInteger(reviewId) || reviewId <= 0) {
    throw new ReviewWriteError(`Invalid review id: ${String(reviewId)}`);
  }
  if (!isEmailAddress(user)) {
    throw new ReviewWriteError(`"${user.trim()}" is not an e-mail address, and the review service names reviewers ` +
      "by e-mail address.");
  }
  return post(connection, reviewUrl(connection, reviewId, "/reviewers"), { reviewers: [user.trim()] });
}

function reviewUrl(connection: IReviewWriteConnection, reviewId: number, path: string): URL {
  if (!connection.organization.trim() || !connection.repository.trim() ||
    [ ".", ".." ].includes(connection.organization) || [ ".", ".." ].includes(connection.repository)) {
    throw new ReviewWriteError("Configure the hosted organization and repository first.");
  }
  if (!connection.token || /\s/.test(connection.token)) {
    throw new ReviewWriteError("Configure a valid review-service bearer token first.");
  }
  return new URL(`${SERVICE}/organizations/${encodeURIComponent(connection.organization)}` +
    `/repositories/${encodeURIComponent(connection.repository)}/code-reviews/${reviewId}${path}`);
}

function post(connection: IReviewWriteConnection, url: URL, payload: object): IWriteRequest {
  return {
    body: JSON.stringify(payload),
    headers: { "Authorization": `Bearer ${connection.token}`, "Content-Type": "application/json" },
    method: "POST",
    url,
  };
}

/** Over https, with a 30-second timeout; cancelling destroys the request. Redirects are not followed. */
export const httpsTransport: ReviewTransport = (call, cancel) => new Promise((resolve, reject) => {
  if (cancel?.isCancellationRequested) {
    reject(new ReviewRequestError("cancelled", false));
    return;
  }
  let cancelled = false;
  const req = request(call.url, {
    headers: { ...call.headers, "Content-Length": Buffer.byteLength(call.body) },
    method: call.method,
  }, response => {
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

export class ReviewWriter {
  private readonly sending = new Set<string>();
  private readonly completed = new Set<string>();
  public constructor(private readonly transport: ReviewTransport = httpsTransport) {}
  public async send(connection: IReviewWriteConnection, draft: IReviewDraft, text: string): Promise<void> {
    if (this.sending.has(draft.key) || this.completed.has(draft.key)) {
      throw new ReviewWriteError("This draft is already sending or has been sent.");
    }
    const call = commentRequest(connection, draft, text);
    this.sending.add(draft.key);
    try {
      const response = await this.transport(call);
      if (response.status >= 200 && response.status < 300) {
        this.completed.add(draft.key);
        return;
      }
      if (response.status === 401 || response.status === 403) {
        throw new ReviewWriteError(
          "The review service rejected authorization. Configure a valid token with permission to comment.");
      }
      if (isUncertain(response.status)) {
        throw new ReviewWriteError(
          `The review service returned HTTP ${response.status}. Check whether the comment arrived before retrying.`,
          true);
      }
      throw new ReviewWriteError(`Comment rejected (HTTP ${response.status}). ` +
        "The experimental request format or repository mapping may not match this service.");
    } catch (error) {
      throw writeError(error, "The comment may have been posted.");
    } finally {
      this.sending.delete(draft.key);
    }
  }

  /**
   * Adds the user to a review's reviewers. 200 and 201 are success, but a 201
   * lists the reviewers, and one that does not list the user is not. What the
   * service answers for someone who is already a reviewer is not verified, so
   * the caller must not send a second add while one is in flight: unlike
   * `send`, this sends every call (ReviewSession keeps one add per review).
   */
  public async addReviewer(
      connection: IReviewWriteConnection,
      reviewId: number,
      user: string,
      cancel?: CancellationToken): Promise<void> {
    const call = addReviewersRequest(connection, reviewId, user);
    let response: IWriteResponse;
    try {
      response = await this.transport(call, cancel);
    } catch (error) {
      throw writeError(error, "You may have been added.");
    }
    const { status } = response;
    if (status === 200 || (status === 201 && listedReviewers(response.body).some(name => sameAddress(name, user)))) {
      return;
    }
    if (status === 201) {
      throw new ReviewWriteError(
        "The review service answered, but its list of reviewers does not include you. Refresh the review to check.",
        true);
    }
    if (status === 401 || status === 403) {
      throw new ReviewWriteError("The review service refused the token: it has expired or lacks permission to " +
        "change reviewers. Unity user tokens are short-lived; set a new one with Configure Experimental Posting… " +
        "and try again.");
    }
    if (status === 404) {
      throw new ReviewWriteError(`The review service has no review #${reviewId} in ${connection.organization} / ` +
        `${connection.repository}. Check both names with Configure Experimental Posting… and try again.`);
    }
    if (isUncertain(status)) {
      throw new ReviewWriteError(
        `The review service returned HTTP ${status}. You may have been added; refresh the review before retrying.`,
        true);
    }
    throw new ReviewWriteError(`The review service refused the request (HTTP ${status}). ` +
      "The experimental request format or repository mapping may not match this service.");
  }
}

/** A status after which the request may or may not have taken effect. */
function isUncertain(status: number): boolean {
  return status >= 500 || status === 0 || status === 408;
}

/** A failed exchange as a message safe to show; `effect` says what may have happened anyway. */
function writeError(error: unknown, effect: string): ReviewWriteError {
  if (error instanceof ReviewWriteError) {
    return error;
  }
  if (error instanceof ReviewRequestError) {
    if (!error.sent) {
      return new ReviewWriteError("Cancelled before anything was sent.");
    }
    if (error.reason === "interrupted") {
      return new ReviewWriteError("The response was interrupted. Check the review before retrying.", true);
    }
    const what = error.reason === "cancelled"
      ? "Cancelled before the review service answered."
      : "No complete response was received.";
    return new ReviewWriteError(`${what} ${effect} Check the review before retrying.`, true);
  }
  return new ReviewWriteError(
    `The request ended without a confirmed result. ${effect} Check the review before retrying.`, true);
}

/** The reviewers a 201 lists, `{ "reviewers": [ { "name": "<e-mail>", … } | "<e-mail>" ] }`; none if it lists none. */
function listedReviewers(body: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return [];
  }
  const reviewers = isRecord(value) ? value.reviewers : undefined;
  if (!Array.isArray(reviewers)) {
    return [];
  }
  return reviewers.map((entry: unknown) => (typeof entry === "string" ? entry
    : isRecord(entry) && typeof entry.name === "string" ? entry.name : ""));
}

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** E-mail addresses compare without case: cm and the service may spell one differently. */
function sameAddress(a: string, b: string): boolean {
  return !!a.trim() && a.trim().toLowerCase() === b.trim().toLowerCase();
}
