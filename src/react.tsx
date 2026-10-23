"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { collectReportContext, readReportImage } from "./browser.js";
import { serverReportsSnapshot } from "./client.js";
import { ReportsError, reportLimits, type ReportReceipt, type ReportsClient } from "./contracts.js";

export function useReportsSnapshot(client: ReportsClient) {
  return useSyncExternalStore(client.subscribe, client.getSnapshot, () => serverReportsSnapshot);
}

export interface ReportFormLabels {
  readonly message: string;
  readonly image: string;
  readonly imageHelp: string;
  readonly submit: string;
  readonly sending: string;
  readonly retry: string;
  readonly discard: string;
  readonly uncertain: string;
  readonly rejected: string;
  readonly rateLimited: string;
  readonly cancelled: string;
  readonly disposed: string;
  readonly invalidMessage: string;
  readonly invalidImage: string;
  readonly invalidReport: string;
  readonly accepted: (receipt: ReportReceipt) => string;
}

const defaultLabels: ReportFormLabels = {
  message: "Qué pasó o qué querés mejorar",
  image: "Imagen opcional",
  imageHelp: "Elegí PNG, JPEG o WebP de hasta 2 MiB. Revisá que no contenga datos sensibles.",
  submit: "Enviar reporte",
  sending: "Enviando…",
  retry: "Reintentar el mismo reporte",
  discard: "Descartar intento",
  uncertain: "No se confirmó la recepción. Reintentá el mismo reporte para evitar duplicados.",
  rejected: "El receptor rechazó el reporte. Conservamos el texto. Revisá la configuración o descartá este intento.",
  rateLimited: "El receptor pide esperar antes de reintentar. Conservamos el reporte.",
  cancelled: "Se descartó el intento local. Si ya se había enviado, el receptor puede haberlo recibido.",
  disposed: "El formulario está desconectado.",
  invalidMessage: "Escribí un mensaje de hasta 4096 bytes UTF-8.",
  invalidImage: "Elegí una imagen PNG, JPEG o WebP válida de hasta 2 MiB.",
  invalidReport: "No se pudo preparar el reporte. Conservamos el texto para que lo revises.",
  accepted: receipt => `Reporte ${receipt.reportId} recibido.`,
};

export interface ReportFormProps {
  readonly client: ReportsClient;
  readonly appVersion?: string;
  readonly className?: string;
  readonly labels?: Partial<ReportFormLabels>;
  readonly onAccepted?: (receipt: ReportReceipt) => void;
}

export function ReportForm({ client, appVersion, className, labels: overrides, onAccepted }: ReportFormProps) {
  const labels = { ...defaultLabels, ...overrides };
  const snapshot = useReportsSnapshot(client);
  const identifier = useId();
  const [message, setMessage] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setRetryClock] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  useEffect(() => {
    setPreparing(false);
    setError(null);
    return () => { generation.current += 1; };
  }, [client]);
  useEffect(() => {
    if (snapshot.retryAt === null) return;
    const timeout = setTimeout(() => setRetryClock(value => value + 1), Math.max(0, snapshot.retryAt - Date.now()));
    return () => clearTimeout(timeout);
  }, [snapshot.retryAt]);
  const locked = preparing || ["prepared", "sending", "uncertain", "rate-limited", "rejected", "disposed"].includes(snapshot.phase);
  const busy = preparing || snapshot.phase === "sending";
  const retryable = snapshot.phase === "uncertain" || snapshot.phase === "rate-limited";
  const discardable = ["prepared", "sending", "uncertain", "rate-limited", "rejected"].includes(snapshot.phase) || preparing;
  const status = snapshot.phase === "accepted" && snapshot.receipt ? labels.accepted(snapshot.receipt)
    : snapshot.phase === "uncertain" ? labels.uncertain
      : snapshot.phase === "rate-limited" ? labels.rateLimited
        : snapshot.phase === "rejected" ? labels.rejected
          : snapshot.phase === "cancelled" ? labels.cancelled
            : snapshot.phase === "disposed" ? labels.disposed
              : busy ? labels.sending : "";
  async function deliver(retry: boolean) {
    const active = ++generation.current;
    setError(null);
    try {
      if (!retry) {
        setPreparing(true);
        const image = file ? await readReportImage(file) : undefined;
        if (generation.current !== active) return;
        client.prepare({ message, ...(image ? { image } : {}), context: collectReportContext({ appVersion }) });
        setPreparing(false);
      }
      const result = await (retry ? client.retry() : client.send());
      if (generation.current !== active) return;
      if (result.status === "accepted") {
        setMessage("");
        setFile(null);
        if (fileInput.current) fileInput.current.value = "";
        try { onAccepted?.(result.receipt); } catch {}
      }
    } catch (caught: unknown) {
      if (generation.current !== active) return;
      const code = caught instanceof ReportsError ? caught.code : "UNKNOWN";
      setError(code === "INVALID_MESSAGE" ? labels.invalidMessage : code.includes("IMAGE") ? labels.invalidImage : labels.invalidReport);
    } finally {
      if (generation.current === active) setPreparing(false);
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!locked) void deliver(false);
  }
  function discard() {
    generation.current += 1;
    setPreparing(false);
    setError(null);
    client.cancel();
  }
  return <form className={className} onSubmit={submit} aria-busy={busy} data-aside-reports="form">
    <div>
      <label htmlFor={`${identifier}-message`}>{labels.message}</label>
      <textarea id={`${identifier}-message`} name="message" required rows={4} maxLength={reportLimits.messageBytes} disabled={locked} value={message} onChange={event => setMessage(event.currentTarget.value)} aria-describedby={`${identifier}-status`} aria-invalid={error === labels.invalidMessage || undefined} />
    </div>
    <div>
      <label htmlFor={`${identifier}-image`}>{labels.image}</label>
      <input ref={fileInput} id={`${identifier}-image`} name="image" type="file" accept="image/png,image/jpeg,image/webp" disabled={locked} onChange={event => { setFile(event.currentTarget.files?.item(0) ?? null); setError(null); }} aria-describedby={`${identifier}-image-help`} />
      <p id={`${identifier}-image-help`}>{labels.imageHelp}</p>
    </div>
    <p id={`${identifier}-status`} role="status" aria-live="polite">{error ?? status}</p>
    {retryable ? <button type="button" onClick={() => { void deliver(true); }} disabled={busy || (snapshot.retryAt !== null && Date.now() < snapshot.retryAt)}>{labels.retry}</button>
      : <button type="submit" disabled={locked || !message.trim()}>{busy ? labels.sending : labels.submit}</button>}
    {discardable ? <button type="button" onClick={discard}>{labels.discard}</button> : null}
  </form>;
}
