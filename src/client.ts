import { ReportsError, ReportsTransportError, reportLimits, type ReportCancellation, type ReportInput, type ReportResult, type ReportSubmission, type ReportsClient, type ReportsClientOptions, type ReportsSnapshot } from "./contracts.js";
import { abortable, requestLifetime } from "./async.js";
import { parseReceipt, parseSubmission } from "./validation.js";

export const serverReportsSnapshot: ReportsSnapshot = Object.freeze({ phase: "idle", submissionId: null, receipt: null, retryAt: null, errorCode: null });

interface Command {
  readonly submission: ReportSubmission;
  readonly abort: AbortController;
  sent: boolean;
}

export function createReportsClient(options: ReportsClientOptions): ReportsClient {
  if (typeof options.transport !== "function") throw new ReportsError("INVALID_TRANSPORT");
  const transport = options.transport;
  const timeoutMs = options.timeoutMs ?? reportLimits.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new ReportsError("INVALID_TIMEOUT");
  const now = options.now ?? Date.now;
  let snapshot = serverReportsSnapshot;
  let disposed = false;
  let command: Command | null = null;
  let flight: Promise<ReportResult> | null = null;
  const observers = new Set<() => void>();
  function publish(value: ReportsSnapshot) {
    snapshot = Object.freeze(value);
    for (const observer of [...observers]) {
      try { observer(); } catch {}
    }
  }
  const current = (active: Command) => !disposed && command === active && !active.abort.signal.aborted;
  function clear(phase: "cancelled" | "disposed"): ReportCancellation {
    const outcome = snapshot.phase === "accepted" ? "already-acknowledged" : command?.sent ? "may-have-been-sent" : "not-sent";
    command?.abort.abort();
    command = null;
    flight = null;
    publish({ phase, submissionId: null, receipt: null, retryAt: null, errorCode: null });
    return outcome;
  }
  function attempt(retry: boolean): Promise<ReportResult> {
    if (flight) return flight;
    if (!disposed && snapshot.phase === "accepted" && snapshot.receipt) return Promise.resolve({ status: "accepted", receipt: snapshot.receipt });
    const active = command;
    if (disposed || !active) return Promise.resolve({ status: "not-ready" });
    if (retry ? !["uncertain", "rate-limited"].includes(snapshot.phase) : snapshot.phase !== "prepared") return Promise.resolve({ status: "not-ready" });
    if (snapshot.retryAt !== null && now() < snapshot.retryAt) return Promise.resolve({ status: "retry-later" });
    const lifetime = requestLifetime(active.abort.signal, timeoutMs);
    const work = async (): Promise<ReportResult> => {
      try {
        if (!current(active)) return { status: "stale" };
        active.sent = true;
        const value = await abortable(Promise.resolve().then(() => {
          if (lifetime.signal.aborted) throw new ReportsError("REQUEST_ABORTED");
          return transport(active.submission, { signal: lifetime.signal });
        }), lifetime.signal);
        if (!current(active)) return { status: "stale" };
        const receipt = parseReceipt(value, active.submission.submissionId);
        command = null;
        flight = null;
        publish({ phase: "accepted", submissionId: receipt.submissionId, receipt, retryAt: null, errorCode: null });
        return { status: "accepted", receipt };
      } catch (error: unknown) {
        if (!current(active)) return { status: "stale" };
        if (error instanceof ReportsTransportError && error.status === 429) {
          publish({ phase: "rate-limited", submissionId: active.submission.submissionId, receipt: null, retryAt: error.retryAt ?? now() + 60_000, errorCode: "RATE_LIMITED" });
          return { status: "retry-later" };
        }
        if (error instanceof ReportsTransportError && error.status >= 400 && error.status < 500 && ![408, 425].includes(error.status)) {
          publish({ phase: "rejected", submissionId: active.submission.submissionId, receipt: null, retryAt: null, errorCode: error.code });
          return { status: "rejected" };
        }
        publish({ phase: "uncertain", submissionId: active.submission.submissionId, receipt: null, retryAt: null, errorCode: "ACK_UNCONFIRMED" });
        return { status: "uncertain" };
      } finally {
        lifetime.release();
      }
    };
    const promise = Promise.resolve().then(work);
    flight = promise;
    publish({ phase: "sending", submissionId: active.submission.submissionId, receipt: null, retryAt: null, errorCode: null });
    void promise.then(() => { if (flight === promise) flight = null; });
    return promise;
  }
  return Object.freeze({
    prepare(input: ReportInput) {
      if (disposed) throw new ReportsError("CLIENT_DISPOSED");
      if (command) throw new ReportsError("REPORT_PENDING");
      const submission = parseSubmission(input, (options.createId ?? (() => crypto.randomUUID()))(), now());
      command = { submission, abort: new AbortController(), sent: false };
      publish({ phase: "prepared", submissionId: submission.submissionId, receipt: null, retryAt: null, errorCode: null });
      return submission.submissionId;
    },
    send: () => attempt(false),
    retry: () => attempt(true),
    cancel: () => disposed ? "not-sent" : clear("cancelled"),
    getSnapshot: () => snapshot,
    subscribe(observer: () => void) {
      if (disposed) return () => {};
      observers.add(observer);
      return () => { observers.delete(observer); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clear("disposed");
      observers.clear();
    },
  });
}
