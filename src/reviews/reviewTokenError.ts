/**
 * Why there is no personal access token, with a message that is safe to show:
 * `consent` (the user has not agreed to create one), `notAllowed` and
 * `disabled` (cm refused to create one; the message says what an admin can
 * do), or `failed`.
 */
export class ReviewTokenError extends Error {
  public constructor(message: string, public readonly kind: "consent" | "notAllowed" | "disabled" | "failed") {
    super(message);
  }
}
