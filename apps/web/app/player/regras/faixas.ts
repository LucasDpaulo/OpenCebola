// Áudio e legenda automáticos: UMA regra, UM executor. Antes quatro decisores competiam
// (`defaultSubtitleId`, `restoreSubtitle` + restauração de áudio, a escolha automática dos
// controles e o navegador), cada um chamando `selectSubtitleTrack` por conta própria — e o último
// a chegar deixava duas legendas na tela.
//
// REGRA: só `aplicarFaixas` (abaixo) e a escolha manual da pessoa selecionam faixas.
// Puro: sem React, DOM ou rede; só o executor fala com o player que recebe por parâmetro.
import type { PlaybackScenario } from "@cebola/contracts";
import type { NativePlayer, PlayerTrack } from "../native-player";
import { matchSavedAudioTrack, matchSavedTrack, matchSubtitleContinuityTrack, matchTrackByLanguage } from "../playback-scenario";
import {
  bestReleaseMatch, normalizedTrackLanguage, originalAudioTrackId, safeAutomaticSubtitleId, subtitleForAudio,
  type SubtitleCandidate
} from "../subtitle-selection";

/** O que o episódio que a pessoa está deixando usava (mesma forma da semente de continuidade). */
export interface ContinuidadeDeFaixas {
  readonly audioLanguage: string | null;
  readonly subtitle: "off" | {
    readonly language: string;
    readonly details?: string | null;
    readonly origin?: "embedded" | "external";
  } | null;
}

export interface EntradaFaixas {
  /** Id da faixa ou "off", escolhido pela pessoa NESTA sessão; null = ela não escolheu. */
  readonly escolhaDaPessoa: string | null;
  readonly continuidade: ContinuidadeDeFaixas | null;
  readonly salvo: PlaybackScenario | null;
  readonly idiomaOriginal: string | null;
  /** Ids que pertencem às legendas externas (inclusive com prefixo `external:`); o resto é embutida. */
  readonly idsExternos: ReadonlySet<string>;
  /** A externa que `legendaNaAbertura` escolheu para o load; desempata a continuidade por release. */
  readonly legendaPreferidaExterna: string | null;
}

export type DecisaoDeLegenda =
  | { readonly tipo: "manter" }
  | { readonly tipo: "desligar" }
  | { readonly tipo: "faixa"; readonly id: string };

const MANTER: DecisaoDeLegenda = { tipo: "manter" };

/**
 * Qual legenda EXTERNA já vai ligada no `load()`. Prioridade: (1) o episódio que está sendo
 * deixado — desligada de propósito continua desligada, e com idioma tenta a mesma fonte/release
 * (`details`) antes da melhor por idioma; (2) a legenda salva deste vídeo, inclusive "nenhuma"
 * (`subtitle: null`); (3) a automática de sempre, tentando bater com o release da fonte.
 */
export function legendaNaAbertura(
  externas: readonly SubtitleCandidate[],
  entrada: Pick<EntradaFaixas, "continuidade" | "salvo">,
  releaseLabel: string | null
): string | null {
  const continuidade = entrada.continuidade;
  if (continuidade?.subtitle === "off") return null;
  if (continuidade?.subtitle) {
    // Embutida do episódio anterior: quem a liga é o executor, quando o motor publicar as faixas.
    if (continuidade.subtitle.origin === "embedded") return null;
    const alvo = normalizedTrackLanguage({ language: continuidade.subtitle.language, label: "" });
    const comIdioma = (idioma: string | null) => externas.filter((legenda) =>
      normalizedTrackLanguage({ language: legenda.language, label: legenda.label }) === idioma);
    let candidatas = alvo ? comIdioma(alvo) : [];
    // Português é uma família: PT-BR e PT genérico podem substituir um ao outro, nunca outro idioma.
    if (candidatas.length === 0 && (alvo === "pt-BR" || alvo === "pt")) {
      candidatas = comIdioma(alvo === "pt-BR" ? "pt" : "pt-BR");
    }
    const melhor = bestReleaseMatch(candidatas, continuidade.subtitle.details ?? releaseLabel);
    if (melhor) return melhor.id;
    // A embutida pode chegar depois do ready: não troque o idioma escolhido por outro automático.
    return null;
  }
  const cenario = entrada.salvo;
  if (cenario && "subtitle" in cenario) {
    if (!cenario.subtitle) return null;
    const salva = matchSavedTrack(externas, cenario.subtitle);
    if (salva) return salva.id;
  }
  return safeAutomaticSubtitleId(externas, releaseLabel);
}

/**
 * Id do áudio a selecionar, ou null para manter. Com continuidade ou cenário salvo vale a mesma
 * semântica de sempre (idioma do episódio anterior vence o ID salvo, que quase certamente não
 * existe no arquivo novo); sem nenhum dos dois, liga o áudio original do título.
 */
export function decidirAudio(
  faixas: readonly PlayerTrack[],
  faixaAtualId: string | null,
  entrada: EntradaFaixas
): string | null {
  const idioma = entrada.continuidade?.audioLanguage ?? null;
  if (entrada.salvo?.audio || idioma) {
    const alvo = matchTrackByLanguage(faixas, idioma) ?? matchSavedAudioTrack(faixas, entrada.salvo?.audio);
    return alvo && alvo.id !== faixaAtualId ? alvo.id : null;
  }
  return originalAudioTrackId(faixas, entrada.idiomaOriginal, faixaAtualId);
}

/**
 * O que fazer com a legenda. Degraus, o de cima vence: escolha da pessoa > episódio anterior >
 * cenário salvo > automática pelo áudio ativo. Devolve "manter" quando o resultado já é o estado
 * atual, para o executor nunca reselecionar (e reiniciar) o que já está ligado.
 */
export function decidirLegenda(
  faixas: readonly PlayerTrack[],
  audioAtivo: PlayerTrack | null,
  legendaAtualId: string | null,
  entrada: EntradaFaixas
): DecisaoDeLegenda {
  const resultado = (id: string | null): DecisaoDeLegenda => {
    if (id === legendaAtualId) return MANTER;
    return id === null ? { tipo: "desligar" } : { tipo: "faixa", id };
  };

  if (entrada.escolhaDaPessoa === "off") return resultado(null);
  // O ID manual vale dentro do arquivo em que foi escolhido. Se uma nova fonte mudou os
  // IDs, restaura a intenção salva por idioma em vez de manter a legenda desligada.
  if (entrada.escolhaDaPessoa !== null) {
    const saved = entrada.salvo?.subtitle?.id === entrada.escolhaDaPessoa ? entrada.salvo.subtitle : null;
    const sameId = faixas.find((track) => track.id === entrada.escolhaDaPessoa);
    const language = saved?.language ? normalizedTrackLanguage({ language: saved.language, label: "" }) : null;
    if (sameId && (!language || normalizedTrackLanguage(sameId) === language)) return resultado(sameId.id);
    // A escolha manual atual vence a preferência herdada do episódio anterior mesmo
    // quando o fallback troca todos os IDs das trilhas.
    const restored = saved ? matchSubtitleContinuityTrack(faixas, saved.language ?? "", undefined, entrada.idsExternos) : null;
    return restored ? resultado(restored.id) : MANTER;
  }

  const continuidade = entrada.continuidade?.subtitle ?? null;
  if (continuidade === "off") return resultado(null);
  if (continuidade) {
    const alvo = matchSubtitleContinuityTrack(
      faixas, continuidade.language, continuidade.origin, entrada.idsExternos,
      continuidade.origin === "external" ? entrada.legendaPreferidaExterna : null
    );
    return resultado(alvo?.id ?? null);
  }

  const cenario = entrada.salvo;
  if (cenario && "subtitle" in cenario) {
    return resultado(cenario.subtitle ? (matchSavedTrack(faixas, cenario.subtitle)?.id ?? null) : null);
  }

  // Sem áudio ativo conhecido não há como julgar; melhor não mexer.
  if (!audioAtivo) return MANTER;
  const candidatas = faixas.map((faixa) => ({ id: faixa.id, language: faixa.language ?? "", label: faixa.label }));
  return resultado(subtitleForAudio(audioAtivo, candidatas, legendaAtualId));
}

export interface ResultadoDasFaixas {
  readonly audioFalhou: boolean;
  readonly legendaFalhou: boolean;
  /** A decisão de áudio rodou com faixas de verdade (`opcoes.audio` e lista não vazia); com a lista vazia o motor ainda não publicou. */
  readonly audioAvaliado: boolean;
}

/**
 * O executor único: decide e seleciona o áudio (se `opcoes.audio`), depois a legenda coerente com
 * o áudio que ficou ativo. A falha de uma seleção (motor recusando o id) não impede a outra; a
 * tela decide o aviso. Idempotente: rodar de novo com as mesmas faixas não troca nada.
 */
export async function aplicarFaixas(
  player: NativePlayer,
  entrada: EntradaFaixas,
  opcoes: { readonly audio: boolean; readonly isCurrent?: () => boolean }
): Promise<ResultadoDasFaixas> {
  let audioFalhou = false;
  let legendaFalhou = false;
  let audioAvaliado = false;

  const [audios, legendas] = await Promise.all([player.audioTracks(), player.subtitleTracks()]);
  const current = opcoes.isCurrent ?? (() => true);
  if (!current()) return { audioFalhou, legendaFalhou, audioAvaliado };
  let audioAtivoId = player.state().audioTrackId;

  if (opcoes.audio) {
    audioAvaliado = audios.length > 0;
    const escolhido = decidirAudio(audios, audioAtivoId, entrada);
    if (escolhido !== null) {
      try {
        await player.selectAudioTrack(escolhido);
        audioAtivoId = escolhido;
      } catch {
        audioFalhou = true;
      }
    }
  }

  try {
    if (!current()) return { audioFalhou, legendaFalhou, audioAvaliado };
    // Relê o estado: trocar o áudio pode ter mexido na legenda em alguns motores.
    const audioAtivo = audios.find((faixa) => faixa.id === audioAtivoId) ?? null;
    const decisao = decidirLegenda(legendas, audioAtivo, player.state().subtitleTrackId, entrada);
    if (decisao.tipo === "desligar") await player.selectSubtitleTrack(null);
    else if (decisao.tipo === "faixa") await player.selectSubtitleTrack(decisao.id);
  } catch {
    legendaFalhou = true;
  }

  return { audioFalhou, legendaFalhou, audioAvaliado };
}
