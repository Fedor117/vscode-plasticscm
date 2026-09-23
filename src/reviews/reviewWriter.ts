import { request } from "https";
import { ReviewWriteError } from "./reviewWriteError";

export { ReviewWriteError };

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
export interface IWriteResponse {
  status: number;
  body: string;
}
export type ReviewPost = (url: URL, token: string, body: string) => Promise<IWriteResponse>;

/** Deliberately fixed host: workspace settings cannot redirect a saved credential. */
export function commentRequest(connection: IReviewWriteConnection, draft: IReviewDraft, text: string): {
  url: URL; body: string;
} {
  if (!text.trim() || text.length > 64000) {
    throw new ReviewWriteError("Enter a comment of at most 64,000 characters.");
  }
  for (const value of draft.parentId === undefined ?
    [ draft.reviewId, draft.revisionId, draft.changesetId, draft.location ] : [draft.reviewId]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ReviewWriteError("This comment does not have a valid pinned revision and line.");
    }
  }
  if (!connection.organization.trim() || !connection.repository.trim() ||
    [ ".", ".." ].includes(connection.organization) || [ ".", ".." ].includes(connection.repository)) {
    throw new ReviewWriteError("Configure the hosted organization and repository first.");
  }
  if (!connection.token || /\s/.test(connection.token)) {
    throw new ReviewWriteError("Configure a valid review-service bearer token first.");
  }
  let path = `/organizations/${encodeURIComponent(connection.organization)}` +
    `/repositories/${encodeURIComponent(connection.repository)}` +
    `/code-reviews/${draft.reviewId}/comments`;
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
  return { body: JSON.stringify(payload), url: new URL(`https://services.api.unity.com/plastic/v1${path}`) };
}

export const postReviewComment: ReviewPost = (url, token, body) => new Promise((resolve, reject) => {
  const req = request(url, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Length": Buffer.byteLength(body),
      "Content-Type": "application/json",
    },
    method: "POST",
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
    response.on("error", () => reject(
      new ReviewWriteError("The response was interrupted. Check the review before retrying.", true)));
    response.on("end", () => resolve({ body: data, status: response.statusCode ?? 0 }));
  });
  req.setTimeout(30000, () => req.destroy(new Error("Timeout")));
  req.on("error", () => reject(new ReviewWriteError(
    "No complete response was received. The comment may have been posted. Check the review before retrying.", true)));
  req.end(body);
});

export class ReviewWriter {
  private readonly sending = new Set<string>();
  private readonly completed = new Set<string>();
  public constructor(private readonly post: ReviewPost = postReviewComment) {}
  public async send(connection: IReviewWriteConnection, draft: IReviewDraft, text: string): Promise<void> {
    if (this.sending.has(draft.key) || this.completed.has(draft.key)) {
      throw new ReviewWriteError("This draft is already sending or has been sent.");
    }
    const call = commentRequest(connection, draft, text);
    this.sending.add(draft.key);
    try {
      const response = await this.post(call.url, connection.token, call.body);
      if (response.status >= 200 && response.status < 300) {
        this.completed.add(draft.key);
        return;
      }
      if (response.status === 401 || response.status === 403) {
        throw new ReviewWriteError(
          "The review service rejected authorization. Configure a valid token with permission to comment.");
      }
      if (response.status >= 500 || response.status === 0 || response.status === 408) {
        throw new ReviewWriteError(
          `The review service returned HTTP ${response.status}. Check whether the comment arrived before retrying.`,
          true);
      }
      throw new ReviewWriteError(`Comment rejected (HTTP ${response.status}). ` +
        "The experimental request format or repository mapping may not match this service.");
    } catch (error) {
      if (error instanceof ReviewWriteError) {
        throw error;
      }
      throw new ReviewWriteError("Posting ended without a confirmed result. Check the review before retrying.", true);
    } finally {
      this.sending.delete(draft.key);
    }
  }
}
