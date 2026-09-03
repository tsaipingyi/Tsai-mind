/** Error carrying an HTTP status and a machine-readable code; the REST layer renders it as {error, message}. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string, extra?: Record<string, unknown>) => new HttpError(400, 'invalid', message, extra);
export const conflict = (message: string, extra?: Record<string, unknown>) => new HttpError(409, 'conflict', message, extra);
