/**
 * Why a request to the review service has no answer: cancelled, failed before
 * a response, or interrupted during one. `sent` means it may have reached the
 * service. The writer turns it into a message for what it was doing.
 */
export class ReviewRequestError extends Error {
  public constructor(public readonly reason: "cancelled" | "failed" | "interrupted", public readonly sent: boolean) {
    super(`The review service request ${reason === "failed" ? "failed" : `was ${reason}`}.`);
  }
}
