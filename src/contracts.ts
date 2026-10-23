export const reportLimits = Object.freeze({
  messageBytes: 4096,
  imageBytes: 2 * 1024 * 1024,
  bodyBytes: 3 * 1024 * 1024,
  responseBytes: 4096,
  timeoutMs: 10_000,
});

export interface ReportImage {
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp";
  readonly data: string;
}

export interface ReportContext {
  readonly pathname?: string;
  readonly browser?: string;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly appVersion?: string;
  readonly capturedAt: string;
}

export interface ReportInput {
  readonly message: string;
  readonly image?: ReportImage;
  readonly context?: ReportContext;
}

export interface ReportSubmission extends ReportInput {
  readonly submissionId: string;
  readonly context: ReportContext;
}

export interface ReportReceipt {
  readonly submissionId: string;
  readonly reportId: string;
  readonly documentId: number;
  readonly receivedAt: string;
  readonly status: "accepted" | "duplicate";
}

export type ReportsTransport = (
  submission: ReportSubmission,
  options: { readonly signal: AbortSignal },
) => Promise<unknown>;

export type ReportPhase = "idle" | "prepared" | "sending" | "uncertain" | "rate-limited" | "accepted" | "rejected" | "cancelled" | "disposed";

export interface ReportsSnapshot {
  readonly phase: ReportPhase;
  readonly submissionId: string | null;
  readonly receipt: ReportReceipt | null;
  readonly retryAt: number | null;
  readonly errorCode: string | null;
}

export type ReportResult =
  | { readonly status: "accepted"; readonly receipt: ReportReceipt }
  | { readonly status: "uncertain" | "rejected" | "stale" | "not-ready" | "retry-later" };

export type ReportCancellation = "not-sent" | "may-have-been-sent" | "already-acknowledged";

export interface ReportsClient {
  prepare(input: ReportInput): string;
  send(): Promise<ReportResult>;
  retry(): Promise<ReportResult>;
  cancel(): ReportCancellation;
  getSnapshot(): ReportsSnapshot;
  subscribe(observer: () => void): () => void;
  dispose(): void;
}

export interface ReportsClientOptions {
  readonly transport: ReportsTransport;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly createId?: () => string;
}

export class ReportsError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ReportsError";
  }
}

export class ReportsTransportError extends ReportsError {
  constructor(code: string, readonly status: number, readonly retryAt: number | null = null) {
    super(code);
    this.name = "ReportsTransportError";
  }
}
