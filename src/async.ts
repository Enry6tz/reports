import { ReportsError } from "./contracts.js";

export function abortable<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new ReportsError("REQUEST_ABORTED"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    if (signal.aborted) abort();
  });
}

export function requestLifetime(parent: AbortSignal, timeoutMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, timeoutMs);
  if (parent.aborted) abort();
  return {
    signal: controller.signal,
    release() {
      clearTimeout(timeout);
      parent.removeEventListener("abort", abort);
    },
  };
}
