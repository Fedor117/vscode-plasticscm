/**
 * A posting failure whose message is safe to show. `uncertain` means the
 * request may have reached the service, so a retry could post a duplicate.
 */
export class ReviewWriteError extends Error {
  public constructor(message: string, public readonly uncertain = false) {
    super(message);
  }
}
