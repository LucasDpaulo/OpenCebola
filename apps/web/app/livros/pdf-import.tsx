"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../api-client";
import { kindleNotice, saveBook, sendBookToKindle } from "./download";
import styles from "./books.module.css";

export function PdfImport() {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [prepared, setPrepared] = useState<{ blob: Blob; title: string } | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function convert(file: File) {
    if (busy) return;
    setError(""); setNotice(""); setPrepared(null);
    if (file.size === 0 || file.size > 25 * 1024 * 1024) { setError("Escolha um PDF de até 25 MB."); return; }
    const controller = new AbortController(); request.current = controller;
    setBusy(true);
    try {
      const response = await apiFetch("/v1/books/convert", { method: "POST", headers: { "Content-Type": "application/pdf" }, body: file, signal: controller.signal });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(payload?.error?.message ?? "Não foi possível converter o PDF.");
      }
      if (!response.headers.get("content-type")?.startsWith("application/epub+zip")) throw new Error("O servidor não retornou um EPUB.");
      const blob = await response.blob();
      if (!blob.size || blob.size > 25 * 1024 * 1024) throw new Error("O EPUB convertido excede o limite de tamanho.");
      if (!controller.signal.aborted) {
        setPrepared({ blob, title: file.name.replace(/\.pdf$/i, "") });
        setNotice("EPUB pronto. Confira a diagramação no Kindle, especialmente tabelas e exemplos de código.");
      }
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Falha na conversão."); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  async function deliver(kindle: boolean) {
    if (!prepared || busy) return;
    setBusy(true); setError("");
    try {
      const result = kindle ? await sendBookToKindle(prepared.blob, prepared.title) : await saveBook(prepared.blob, prepared.title);
      setNotice(kindle ? kindleNotice(result) : "EPUB salvo ou download iniciado.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível enviar o livro."); }
    finally { setBusy(false); }
  }
  return <details className={styles.kindle}>
    <summary>Preparar PDF para Kindle</summary>
    <p>Converta um PDF com texto em EPUB, com fonte ajustável e margens para leitura. O arquivo é enviado ao servidor e os temporários são apagados após a conversão.</p>
    <p>PDFs escaneados precisam de OCR. Colunas, tabelas e fórmulas podem precisar de revisão.</p>
    <label>Escolher PDF (até 25 MB)<input type="file" accept="application/pdf,.pdf" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void convert(file); }} /></label>
    {busy && <p role="status">Preparando o livro… Isso pode levar até dois minutos.</p>}
    {prepared && <><button type="button" className={styles.download} disabled={busy} onClick={() => void deliver(true)}>Ler no Kindle</button><button type="button" className={styles.back} disabled={busy} onClick={() => void deliver(false)}>Salvar EPUB</button><button type="button" className={styles.back} disabled={busy} onClick={() => { setPrepared(null); setNotice(""); }}>Limpar arquivo preparado</button></>}
    {notice && <p role="status" className={styles.success}>{notice}</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
  </details>;
}
