import { reportLimits, ReportsError, type ReportContext, type ReportImage } from "./contracts.js";
import { parseReportImage, sanitizeReportPath } from "./validation.js";

export interface BrowserReportContextOptions {
  readonly appVersion?: string;
  readonly pathname?: string;
  readonly now?: () => number;
}

export function collectReportContext(options: BrowserReportContextOptions = {}): ReportContext {
  const pathname = options.pathname ?? (typeof window === "undefined" ? undefined : window.location.pathname);
  const browser = typeof navigator === "undefined" ? undefined : navigator.userAgent.slice(0, 512);
  const viewport = typeof window === "undefined" ? undefined : Object.freeze({ width: Math.max(1, Math.min(32768, Math.round(window.innerWidth))), height: Math.max(1, Math.min(32768, Math.round(window.innerHeight))) });
  return Object.freeze({ capturedAt: new Date((options.now ?? Date.now)()).toISOString(), ...(pathname === undefined ? {} : { pathname: sanitizeReportPath(pathname) }), ...(browser ? { browser } : {}), ...(viewport ? { viewport } : {}), ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }) });
}

export async function readReportImage(file: Blob): Promise<ReportImage> {
  if (!(file instanceof Blob) || file.size < 1 || file.size > reportLimits.imageBytes || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new ReportsError("INVALID_IMAGE");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return parseReportImage({ mediaType: file.type, data: btoa(binary) });
}
