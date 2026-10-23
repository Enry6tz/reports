import { abortable } from "./async.js";
import { reportLimits, ReportsError, ReportsTransportError, type ReportsTransport } from "./contracts.js";
import { record, utf8Bytes } from "./validation.js";

export interface HttpReportsTransportOptions {
  readonly endpoint: string;
  readonly headers?: HeadersInit | ((options: { readonly signal: AbortSignal }) => HeadersInit | Promise<HeadersInit>);
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => number;
}

function validateEndpoint(value: string): string {
  let endpoint: URL;
  try { endpoint = new URL(value, "https://aside.invalid"); } catch { throw new ReportsError("INVALID_ENDPOINT"); }
  if (!/^https?:$/.test(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash || value.startsWith("//") || (!/^https?:\/\//.test(value) && !value.startsWith("/"))) throw new ReportsError("INVALID_ENDPOINT");
  return value;
}

async function readBody(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "")) throw new ReportsError("INVALID_RESPONSE");
  const reader = response.body?.getReader();
  if (!reader) throw new ReportsError("INVALID_RESPONSE");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > reportLimits.responseBytes) throw new ReportsError("RESPONSE_TOO_LARGE");
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function retryAt(value: string | null, now: number): number {
  const seconds = value === null || !/^\d+$/.test(value.trim()) ? Number.NaN : Number(value);
  const date = value === null ? Number.NaN : Date.parse(value);
  const target = Number.isFinite(seconds) ? now + seconds * 1000 : date;
  return Number.isFinite(target) ? Math.max(now, Math.min(target, now + 24 * 60 * 60 * 1000)) : now + 60_000;
}

export function createHttpReportsTransport(options: HttpReportsTransportOptions): ReportsTransport {
  const endpoint = validateEndpoint(options.endpoint);
  const fetcher = options.fetch ?? fetch;
  const configuredHeaders = typeof options.headers === "function" ? options.headers : new Headers(options.headers);
  const now = options.now ?? Date.now;
  return async (submission, { signal }) => {
    const body = JSON.stringify(submission);
    if (utf8Bytes(body) > reportLimits.bodyBytes) throw new ReportsError("REPORT_TOO_LARGE");
    if (signal.aborted) throw new ReportsError("REQUEST_ABORTED");
    const supplied = typeof configuredHeaders === "function" ? await abortable(Promise.resolve(configuredHeaders({ signal })), signal) : configuredHeaders;
    if (signal.aborted) throw new ReportsError("REQUEST_ABORTED");
    const headers = new Headers(supplied);
    headers.set("Accept", "application/json");
    headers.set("Content-Type", "application/json");
    const response = await abortable(fetcher(endpoint, { method: "POST", headers, body, credentials: "omit", redirect: "error", cache: "no-store", signal }), signal);
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new ReportsTransportError(response.status === 409 ? "SUBMISSION_CONFLICT" : response.status === 429 ? "RATE_LIMITED" : "REPORT_REJECTED", response.status, response.status === 429 ? retryAt(response.headers.get("Retry-After"), now()) : null);
    }
    const value = await readBody(response, signal);
    if (!record(value) || !record(value.data)) throw new ReportsError("INVALID_ACK");
    return value.data;
  };
}
