"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../api-client";
import { CASOS, type CasoDeTeste } from "./casos";
import { player, type StatusNativo } from "./player-bridge";
import styles from "./page.module.css";

/**
 * Tela de teste da matriz de codecs.
 *
 * Existe porque a pergunta que decide a fase 1b — "o libVLC toca ESTE arquivo neste aparelho?"
 * — não tem como ser respondida do computador. O emulador não prova decodificação por
 * hardware, e `chrome://inspect` exige cabo. Então quem faz o teste é o próprio app: a lista
 * abaixo já vem com o codec REAL de cada arquivo, medido com ffprobe sobre o cabeçalho, e o
 * aparelho só precisa dizer o que aconteceu.
 *
 * O julgamento final é do ouvido de quem testa. O libVLC informa se criou saída de vídeo, mas
 * não existe evento "o alto-falante emitiu som" — e é exatamente o som que está em questão.
 */

type Veredito = "ok" | "sem-som" | "sem-imagem" | "nada" | null;

type Resultado = {
  readonly veredito: Veredito;
  readonly hardware: boolean;
  readonly evento: string;
  readonly vout: number;
  readonly faixasVistas: string;
};

const CHAVE = "cebola.teste-codecs";

function carregar(): Record<string, Resultado> {
  try {
    const cru = window.localStorage.getItem(CHAVE);
    return cru ? JSON.parse(cru) as Record<string, Resultado> : {};
  } catch { return {}; }
}

function resumoDeFaixas(status: StatusNativo | null): string {
  if (!status || status.faixas.length === 0) return "—";
  return status.faixas.map((f) => {
    if (f.tipo === "audio") return `A:${f.codec ?? "?"}${f.canais ? `/${f.canais}ch` : ""}${f.idioma ? `(${f.idioma})` : ""}`;
    if (f.tipo === "video") return `V:${f.codec ?? "?"}${f.largura ? ` ${f.largura}x${f.altura}` : ""}`;
    return `L:${f.idioma ?? f.codec ?? "?"}`;
  }).join(" · ");
}

export function CodecTest() {
  const [nativo, setNativo] = useState<boolean | null>(null);
  const [ativo, setAtivo] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusNativo | null>(null);
  const [resultados, setResultados] = useState<Record<string, Resultado>>({});
  const hardwareAtual = useRef(true);

  useEffect(() => {
    setNativo(player() !== null);
    setResultados(carregar());
  }, []);

  // Enquanto algo toca, o status do libVLC é relido a cada segundo. É o que mostra o codec que
  // ele REALMENTE abriu — que às vezes não é o que o nome do arquivo dizia.
  useEffect(() => {
    if (ativo === null) return;
    const ponte = player();
    if (!ponte) return;
    const timer = window.setInterval(() => {
      ponte.status().then(setStatus).catch(() => { /* o plugin some se a tela morrer */ });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [ativo]);

  const tocar = useCallback(async (caso: CasoDeTeste, hardware: boolean) => {
    const ponte = player();
    if (!ponte) { setAviso("Esta tela só funciona dentro do app."); return; }
    setAviso(null);
    setStatus(null);
    setAtivo(caso.hash);
    hardwareAtual.current = hardware;
    try {
      const resposta = await apiFetch("/v1/stremio/streams/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ infoHash: caso.hash, fileIdx: caso.fileIdx })
      });
      const corpo = await resposta.json() as {
        status?: string; url?: string; progress?: number; error?: { message?: string };
      };
      if (resposta.status === 409) {
        setAviso(`Real-Debrid recusou: ${corpo.error?.message ?? "bloqueado"}`);
        setAtivo(null);
        return;
      }
      if (corpo.status === "pending") {
        setAviso(`Ainda preparando no Real-Debrid (${corpo.progress ?? 0}%). Tente de novo daqui a pouco.`);
        setAtivo(null);
        return;
      }
      if (!resposta.ok || typeof corpo.url !== "string") {
        setAviso(corpo.error?.message ?? "Não consegui resolver o link.");
        setAtivo(null);
        return;
      }
      await ponte.load({ url: corpo.url, hardware, startAtSeconds: 0, subtitles: [] });
    } catch (erro) {
      setAviso(erro instanceof Error ? erro.message : "Falhou antes de tocar.");
      setAtivo(null);
    }
  }, []);

  const parar = useCallback(async () => {
    await player()?.stop();
    setAtivo(null);
    setStatus(null);
  }, []);

  const julgar = useCallback((caso: CasoDeTeste, veredito: Veredito) => {
    const registro: Resultado = {
      veredito,
      hardware: hardwareAtual.current,
      evento: status?.evento ?? "—",
      vout: status?.vout ?? 0,
      faixasVistas: resumoDeFaixas(status)
    };
    setResultados((anterior) => {
      const proximo = { ...anterior, [`${caso.hash}:${hardwareAtual.current ? "hw" : "sw"}`]: registro };
      try { window.localStorage.setItem(CHAVE, JSON.stringify(proximo)); } catch { /* sem armazenamento */ }
      return proximo;
    });
  }, [status]);

  const relatorio = useCallback(() => {
    const linhas = CASOS.flatMap((caso) => ["hw", "sw"].flatMap((modo) => {
      const r = resultados[`${caso.hash}:${modo}`];
      if (!r) return [];
      return [`${r.veredito} | ${modo} | ${caso.nome} | esperado ${caso.video} + ${caso.audio} | vlc: ${r.faixasVistas} | evento ${r.evento} vout ${r.vout}`];
    }));
    const texto = linhas.length > 0 ? linhas.join("\n") : "nenhum caso testado ainda";
    navigator.clipboard?.writeText(texto).catch(() => { /* sem área de transferência */ });
    setAviso(`Relatório copiado (${linhas.length} linhas).`);
  }, [resultados]);

  const testados = Object.keys(resultados).length;

  return (
    <main className={styles.tela}>
      <header className={styles.cabecalho}>
        <h1>Teste de codecs</h1>
        <p>
          {CASOS.length} arquivos, com o codec já medido no servidor. Toque em <strong>HW</strong> ou
          {" "}<strong>SW</strong>, olhe e ouça, e diga o que aconteceu.
        </p>
        <div className={styles.acoes}>
          <button type="button" onClick={parar} disabled={ativo === null}>Parar</button>
          <button type="button" onClick={relatorio}>Copiar relatório ({testados})</button>
        </div>
      </header>

      {nativo === false ? (
        <p className={styles.alerta}>
          Esta tela só funciona dentro do app Android — é o player nativo que está sendo testado.
        </p>
      ) : null}
      {aviso ? <p className={styles.alerta}>{aviso}</p> : null}

      {ativo !== null ? (
        <section className={styles.aoVivo}>
          <strong>Tocando agora</strong>
          <p>
            evento <code>{status?.evento ?? "…"}</code> · vout <code>{status?.vout ?? 0}</code>
            {" "}· {hardwareAtual.current ? "hardware solicitado; uso real não confirmado" : "hardware desativado"}
            {" "}· {status ? Math.round(status.posicaoMs / 1000) : 0}s
          </p>
          <p className={styles.faixas}>{resumoDeFaixas(status)}</p>
        </section>
      ) : null}

      <ol className={styles.lista}>
        {CASOS.map((caso) => {
          const hw = resultados[`${caso.hash}:hw`];
          const sw = resultados[`${caso.hash}:sw`];
          return (
            <li key={caso.hash} className={styles.caso}>
              <div className={styles.nome}>{caso.nome}</div>
              <div className={styles.esperado}>
                {caso.qualidade} · <strong>{caso.video}</strong> · {caso.audio}
              </div>
              <div className={styles.acoes}>
                <button type="button" onClick={() => tocar(caso, true)}>HW</button>
                <button type="button" onClick={() => tocar(caso, false)}>SW</button>
                {hw ? <span className={styles.marca}>hw: {hw.veredito}</span> : null}
                {sw ? <span className={styles.marca}>sw: {sw.veredito}</span> : null}
              </div>
              {ativo === caso.hash ? (
                <div className={styles.julgamento}>
                  <button type="button" onClick={() => julgar(caso, "ok")}>imagem e som</button>
                  <button type="button" onClick={() => julgar(caso, "sem-som")}>sem som</button>
                  <button type="button" onClick={() => julgar(caso, "sem-imagem")}>sem imagem</button>
                  <button type="button" onClick={() => julgar(caso, "nada")}>não abriu</button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </main>
  );
}
