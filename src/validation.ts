import { reportLimits, ReportsError, type ReportContext, type ReportImage, type ReportReceipt, type ReportSubmission } from "./contracts.js";

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}

function boundedText(value: unknown, bytes: number, code: string): string {
  if (typeof value !== "string" || !value.trim() || utf8Bytes(value) > bytes || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new ReportsError(code);
  return value;
}

export function sanitizeReportPath(value: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\u0000-\u0020\u007f\\]/.test(value)) throw new ReportsError("INVALID_PATHNAME");
  const pathname = value.split(/[?#]/, 1)[0];
  if (!pathname || utf8Bytes(pathname) > 1024) throw new ReportsError("INVALID_PATHNAME");
  return pathname;
}

export function parseReportImage(value: unknown): ReportImage {
  if (!record(value) || (value.mediaType !== "image/png" && value.mediaType !== "image/jpeg" && value.mediaType !== "image/webp") || typeof value.data !== "string") throw new ReportsError("INVALID_IMAGE");
  const data = value.data;
  if (!data.length || data.length > 4 * Math.ceil(reportLimits.imageBytes / 3) || data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new ReportsError("INVALID_IMAGE");
  const size = data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  if (size > reportLimits.imageBytes) throw new ReportsError("IMAGE_TOO_LARGE");
  const prefix = atob(data.slice(0, Math.min(24, data.length)));
  const bytes = [...prefix].map(character => character.charCodeAt(0));
  const matches = value.mediaType === "image/png"
    ? size >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte) && prefix.slice(12, 16) === "IHDR"
    : value.mediaType === "image/jpeg"
      ? size >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : size >= 16 && prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP";
  if (!matches) throw new ReportsError("INVALID_IMAGE");
  return Object.freeze({ mediaType: value.mediaType, data });
}

function parseContext(value: unknown, now: number): ReportContext {
  if (value === undefined) return Object.freeze({ capturedAt: new Date(now).toISOString() });
  if (!record(value) || !validDate(value.capturedAt)) throw new ReportsError("INVALID_CONTEXT");
  const pathname = value.pathname === undefined ? undefined : sanitizeReportPath(boundedText(value.pathname, 2048, "INVALID_PATHNAME"));
  const browser = value.browser === undefined ? undefined : boundedText(value.browser, 512, "INVALID_BROWSER");
  const appVersion = value.appVersion === undefined ? undefined : boundedText(value.appVersion, 128, "INVALID_APP_VERSION");
  let viewport: ReportContext["viewport"];
  if (value.viewport !== undefined) {
    const source = value.viewport;
    if (!record(source) || !Number.isSafeInteger(source.width) || !Number.isSafeInteger(source.height) || typeof source.width !== "number" || typeof source.height !== "number" || source.width < 1 || source.width > 32768 || source.height < 1 || source.height > 32768) throw new ReportsError("INVALID_VIEWPORT");
    viewport = Object.freeze({ width: source.width, height: source.height });
  }
  return Object.freeze({ capturedAt: value.capturedAt, ...(pathname === undefined ? {} : { pathname }), ...(browser === undefined ? {} : { browser }), ...(appVersion === undefined ? {} : { appVersion }), ...(viewport === undefined ? {} : { viewport }) });
}

export function parseSubmission(input: unknown, submissionId: string, now: number): ReportSubmission {
  if (!record(input)) throw new ReportsError("INVALID_REPORT");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(submissionId)) throw new ReportsError("INVALID_SUBMISSION_ID");
  const message = boundedText(input.message, reportLimits.messageBytes, "INVALID_MESSAGE");
  const context = parseContext(input.context, now);
  const image = input.image === undefined ? undefined : parseReportImage(input.image);
  const submission = Object.freeze({ submissionId, message, context, ...(image ? { image } : {}) });
  if (utf8Bytes(JSON.stringify(submission)) > reportLimits.bodyBytes) throw new ReportsError("REPORT_TOO_LARGE");
  return submission;
}

export function parseReceipt(value: unknown, submissionId: string): ReportReceipt {
  if (!record(value) || value.submissionId !== submissionId || typeof value.reportId !== "string" || !/^REP-[1-9]\d{0,14}$/.test(value.reportId) || typeof value.documentId !== "number" || !Number.isSafeInteger(value.documentId) || value.documentId < 1 || !validDate(value.receivedAt) || (value.status !== "accepted" && value.status !== "duplicate")) throw new ReportsError("INVALID_ACK");
  return Object.freeze({ submissionId, reportId: value.reportId, documentId: value.documentId, receivedAt: value.receivedAt, status: value.status });
}
