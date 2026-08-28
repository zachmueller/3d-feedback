/**
 * The HTTP seam shared by the publish client and the site reads.
 *
 * Two reasons it exists rather than each module calling `fetch` directly:
 *
 *  - Every request needs a deadline. A harness calls these tools inside its own
 *    timeout, and a `fetch` with no signal can hang until the socket dies, which
 *    turns "the API is unreachable" into a tool call that never answers.
 *  - `FetchLike` keeps the retry, polling and verification rules testable without
 *    a network. The real implementation is one line at the bottom.
 */

export interface RequestInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
}

export interface FetchResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (url: string, init?: RequestInitLike) => Promise<FetchResponseLike>;

/** What every caller here actually wants: status, headers and the body as text. */
export interface HttpResult {
  status: number;
  headers: { get(name: string): string | null };
  body: string;
  /** Set when the request never produced a response (DNS, TLS, timeout, reset). */
  networkError: string | null;
}

export const nodeFetch: FetchLike = (url, init) =>
  fetch(url, init as RequestInit) as unknown as Promise<FetchResponseLike>;

/**
 * One request, with a deadline, that never throws for a transport failure —
 * a network error comes back as `networkError` with `status: 0`, so callers
 * classify it with the same rules they use for a 500 instead of wrapping every
 * call in try/catch.
 */
export async function request(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInitLike,
  timeoutMs: number,
): Promise<HttpResult> {
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, headers: res.headers, body: await res.text(), networkError: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 0,
      headers: { get: () => null },
      body: '',
      networkError: timedOut ? `no response within ${Math.round(timeoutMs / 1000)}s` : message,
    };
  }
}

/** Parse a JSON body, or return null when it is not JSON at all. */
export function parseJson<T>(body: string): T | null {
  try {
    const value = JSON.parse(body);
    return value && typeof value === 'object' ? (value as T) : null;
  } catch {
    return null;
  }
}

/**
 * The most useful sentence out of an error response: the API's own `error`
 * field when it sent one, else the first line of the body, else the status.
 * An S3 error is XML, so `<Message>` is pulled out too.
 */
export function errorDetail(result: HttpResult): string {
  if (result.networkError) return result.networkError;
  const json = parseJson<{ error?: string; message?: string }>(result.body);
  const fromJson = json?.error ?? json?.message;
  if (fromJson) return String(fromJson);
  const fromXml = /<Message>([^<]+)<\/Message>/.exec(result.body)?.[1];
  if (fromXml) return fromXml;
  const firstLine = result.body.split('\n').find((line) => line.trim());
  return firstLine?.slice(0, 500) ?? `HTTP ${result.status}`;
}
