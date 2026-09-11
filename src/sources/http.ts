const DEFAULT_TIMEOUT_MS = 10_000;

export interface FetchOptions {
  headers?: Record<string, string> | undefined;
  timeoutMs?: number | undefined;
}

/** A non-2xx HTTP response. Carries status and headers so a caller can react (429 reset header, etc). */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly headers: Headers;
  readonly method: string;
  readonly path: string;

  constructor(status: number, headers: Headers, method: string, path: string) {
    super(`${method} ${path} responded ${status}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.headers = headers;
    this.method = method;
    this.path = path;
  }
}

/** The request took longer than `timeoutMs`. */
export class HttpTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`request timed out after ${timeoutMs}ms`);
    this.name = "HttpTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * GET with a timeout and a typed error on failure. Shared by football-data.ts,
 * api-football.ts and rss.ts — each source's own client turns a generic HttpStatusError /
 * HttpTimeoutError into a source-specific, legible message (rate limit, bad token, ...)
 * where that matters; the generic error here never includes the token, only method and path.
 */
async function request(url: string, options?: FetchOptions): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { pathname } = new URL(url);

  let response: Response;
  try {
    response = await fetch(url, {
      ...(options?.headers !== undefined ? { headers: options.headers } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new HttpTimeoutError(timeoutMs);
    }
    throw error;
  }

  if (!response.ok) {
    throw new HttpStatusError(response.status, response.headers, "GET", pathname);
  }

  return response;
}

export async function fetchJson(url: string, options?: FetchOptions): Promise<unknown> {
  const response = await request(url, options);
  return response.json();
}

export async function fetchText(url: string, options?: FetchOptions): Promise<string> {
  const response = await request(url, options);
  return response.text();
}
