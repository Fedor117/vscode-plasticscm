/**
 * A posting failure whose message is safe to show. `uncertain` means the
 * request may have reached the service, so a retry could post a duplicate.
 * `refused` means cm ran and said no, so nothing was written: unlike a cm that
 * was not found, could not start or could not reach the server, the same
 * request will be refused again, and another kind of write may be the way.
 */
export class ReviewWriteError extends Error {
  public constructor(message: string, public readonly uncertain = false, public readonly refused = false) {
    super(message);
  }
}
