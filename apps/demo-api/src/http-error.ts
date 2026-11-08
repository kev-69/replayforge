/**
 * An error that maps directly to an HTTP response.
 * The app's error handler sends `{ error: code, message }` with `statusCode`.
 */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
