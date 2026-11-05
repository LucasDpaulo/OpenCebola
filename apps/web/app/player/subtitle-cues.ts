import { parseTimestamp } from "./subtitle-timing";

export interface FalaLegenda { readonly start: number; readonly end: number; readonly text: string }
type CueDeTexto = { readonly id: string; readonly text: string };

/**
 * Tira de uma fala o que o desenho da interface não entende: marcas ASS (`{\an8}`, `{y:i}`) e as
 * quebras de linha do ASS (`\N`). Tags `<i>` ficam — `renderCueText` (player-controls.tsx) as
 * transforma em itálico e descarta as demais.
 */
export function limparTextoDeLegenda(texto: string): string {
  return texto
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\[Nn]/g, "\n")
    .replace(/\\h/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&(?:lrm|rlm);/gi, "")
    .replace(/&quot;/gi, "\"")
    .replace(/&amp;/gi, "&")
    .trim();
}

/**
 * Lê as falas de um arquivo WebVTT ou SubRip (a API entrega VTT, mas SRT cru também passa):
 * blocos separados por linha em branco, com uma linha `início --> fim` e o texto logo abaixo.
 * Cabeçalho, `NOTE`/`STYLE`/`REGION`, índices numéricos e blocos malformados são ignorados — o
 * que interessa é quando cada fala aparece. O resultado vem ordenado pelo início.
 */
export function parseVttCues(texto: string): readonly FalaLegenda[] {
  const falas: FalaLegenda[] = [];
  const blocos = texto.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const bloco of blocos) {
    const linhas = bloco.split("\n");
    if (/^(?:NOTE|STYLE|REGION)\b/.test((linhas[0] ?? "").trim())) continue;
    const posicao = linhas.findIndex((linha) => linha.includes("-->"));
    if (posicao === -1) continue;
    const [esquerda, direita] = (linhas[posicao] ?? "").split("-->", 2);
    if (esquerda === undefined || direita === undefined) continue;
    // Configurações depois do tempo (`align:middle line:90%`) ficam de fora: só o primeiro token.
    const start = parseTimestamp(esquerda.trim().split(/\s+/)[0] ?? "");
    const end = parseTimestamp(direita.trim().split(/\s+/)[0] ?? "");
    if (start === null || end === null || end <= start) continue;
    const fala = limparTextoDeLegenda(linhas.slice(posicao + 1).join("\n"));
    if (fala) falas.push({ start, end, text: fala });
  }
  return falas.sort((a, b) => a.start - b.start);
}

/**
 * Falas na tela no instante `segundos`, com a mesma conta do ajuste de legenda do player do
 * navegador (title-experience.tsx): o deslocamento move início e fim, e a duração extra só
 * estica o fim — sem começar antes do zero nem acabar antes de começar. Linear de propósito: a
 * lista é ordenada pelo início, então para na primeira fala que ainda não começou.
 */
export function falasAtivasEm(
  falas: readonly FalaLegenda[], segundos: number, deslocamento = 0, duracaoExtra = 0
): readonly CueDeTexto[] {
  const ativas: CueDeTexto[] = [];
  for (let i = 0; i < falas.length; i += 1) {
    const fala = falas[i]!;
    const inicio = Math.max(0, fala.start + deslocamento);
    if (inicio > segundos) break;
    const fim = Math.max(inicio + 0.1, fala.end + deslocamento + duracaoExtra);
    if (segundos < fim) ativas.push({ id: `externa:${i}`, text: fala.text });
  }
  return ativas;
}

