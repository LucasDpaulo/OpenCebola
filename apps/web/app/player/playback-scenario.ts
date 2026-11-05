import type { PlaybackScenario, PlaybackSource, PlaybackTrackSelection } from "@cebola/contracts";
import type { SourceCandidate } from "./player-source-options.js";
import { normalizedTrackLanguage } from "./subtitle-selection";

/**
 * Identidade estável de fonte e trilhas — nunca `url`, que é sempre temporária (mídia direta ou
 * resolução de debrid) e não sobrevive a uma nova sessão. Funções puras: nada aqui lê estado,
 * dispara efeito ou fala com o player. Quem chama decide o que fazer com o resultado.
 */

/** Forma mínima de trilha (áudio/legenda) usada tanto pelo player nativo quanto pelos testes. */
export interface PlaybackTrackLike {
  readonly id: string;
  readonly label?: string | null;
  readonly language?: string | null;
}

export type PlaybackScenarioPatch = Partial<PlaybackScenario>;

export interface PlaybackReading {
  readonly positionSeconds: number;
  readonly durationSeconds: number;
}

function normalizedReleaseKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

/** Deriva a identidade persistível de uma fonte. Nunca inclui `url`. */
export function scenarioForStream(stream: SourceCandidate): PlaybackSource {
  const isTorrent = stream.kind === "torrent" && typeof stream.infoHash === "string";
  return {
    addonId: stream.addonId,
    streamId: stream.id,
    infoHash: isTorrent ? (stream.infoHash as string) : null,
    fileIdx: isTorrent ? stream.fileIdx ?? null : null,
    releaseTitle: stream.label.trim().length > 0 ? stream.label : null
  };
}

/**
 * Reencontra o stream salvo na lista atual, na seguinte ordem:
 *   1. infoHash + fileIdx — identidade do conteúdo, válida entre add-ons diferentes (TPB+, Orion
 *      e Torrentio costumam entregar o mesmo hash de origens distintas).
 *   2. streamId dentro do MESMO addonId — o ID sozinho não é global, então nunca casa entre
 *      add-ons diferentes.
 *   3. chave normalizada do título de release, quando ela aponta para exatamente um stream.
 * Qualquer critério ambíguo (mais de um candidato) é descartado e o próximo é tentado. Sem
 * nenhuma evidência utilizável, ou sem cenário salvo, devolve `null` — quem chama decide o
 * fallback automático.
 */
export function matchSavedStream<T extends SourceCandidate>(
  streams: readonly T[],
  source: PlaybackSource | null | undefined
): T | null {
  if (!source) return null;

  if (source.infoHash) {
    const savedHash = source.infoHash.toLowerCase();
    const hashMatches = streams.filter(
      (stream) => stream.kind === "torrent" && typeof stream.infoHash === "string" &&
        stream.infoHash.toLowerCase() === savedHash
    );
    if (hashMatches.length > 0) {
      if (source.fileIdx !== null) {
        const exact = hashMatches.find((stream) => stream.fileIdx === source.fileIdx);
        if (exact) return exact;
      } else if (hashMatches.length === 1) {
        return hashMatches[0];
      }
    }
  }

  if (source.streamId) {
    const byId = streams.find((stream) => stream.addonId === source.addonId && stream.id === source.streamId);
    if (byId) return byId;
  }

  if (source.releaseTitle) {
    const key = normalizedReleaseKey(source.releaseTitle);
    if (key.length > 0) {
      const releaseMatches = streams.filter((stream) => normalizedReleaseKey(stream.label) === key);
      if (releaseMatches.length === 1) return releaseMatches[0];
    }
  }

  return null;
}

// Remove a marcação de episódio ("S01E02", "E02", "Episode 2") antes de normalizar, para que dois
// episódios do MESMO lançamento (mesmo grupo, mesma qualidade) produzam a mesma chave mesmo com
// números de episódio diferentes.
function releasePackKey(label: string): string {
  return normalizedReleaseKey(
    label
      .replace(/\bS\d{1,3}E\d{1,4}\b/gi, " ")
      .replace(/\b(?:episode|ep)\.?\s*\d{1,4}\b/gi, " ")
      .replace(/\bE\d{1,4}\b/g, " ")
  );
}

/**
 * Reencontra, no episódio NOVO, a fonte do MESMO lançamento do episódio que a pessoa está
 * deixando: um pacote de temporada (mesmo infoHash — o arquivo dentro dele é outro, então
 * `fileIdx` não precisa bater) ou o mesmo grupo de release no mesmo add-on (rótulo igual depois de
 * remover a marcação de episódio). Ambíguo é descartado, igual a `matchSavedStream`. Isto NÃO é a
 * retomada salva do próprio episódio — é só a semente de continuidade quando não há uma.
 */
export function matchPreviousEpisodeStream<T extends SourceCandidate>(
  streams: readonly T[],
  previous: PlaybackSource | null | undefined
): T | null {
  if (!previous) return null;

  if (previous.infoHash) {
    const savedHash = previous.infoHash.toLowerCase();
    const hashMatches = streams.filter(
      (stream) => stream.kind === "torrent" && typeof stream.infoHash === "string" &&
        stream.infoHash.toLowerCase() === savedHash
    );
    if (hashMatches.length === 1) return hashMatches[0];
    if (hashMatches.length > 1) {
      const sameAddon = hashMatches.filter((stream) => stream.addonId === previous.addonId);
      if (sameAddon.length === 1) return sameAddon[0];
    }
  }

  if (previous.releaseTitle) {
    const key = releasePackKey(previous.releaseTitle);
    if (key.length >= 12) {
      const matches = streams.filter(
        (stream) => stream.addonId === previous.addonId && releasePackKey(stream.label) === key
      );
      if (matches.length === 1) return matches[0];
    }
  }

  return null;
}

/**
 * Combina a continuidade entre episódios com a retomada salva do próprio episódio: quando existe
 * um episódio sendo deixado (`previousEpisode`, só preenchido dentro de uma sessão ativa — nunca
 * numa abertura do zero), o lançamento dele vence; a retomada salva do episódio novo é o segundo
 * critério; sem nenhum dos dois, quem chama recorre à escolha automática.
 */
export function resolveContinuitySource<T extends SourceCandidate>(
  streams: readonly T[],
  options: {
    readonly ownSaved: PlaybackSource | null | undefined;
    readonly previousEpisode: PlaybackSource | null | undefined;
  }
): T | null {
  if (options.previousEpisode) {
    return matchPreviousEpisodeStream(streams, options.previousEpisode) ??
      matchSavedStream(streams, options.ownSaved);
  }
  return matchSavedStream(streams, options.ownSaved);
}

/**
 * Casa uma trilha salva (áudio/legenda) com as trilhas atuais do player: primeiro por ID, depois
 * por idioma+nome combinados — evidência auxiliar para quando o ID mudou entre sessões. Mais de
 * uma trilha batendo com idioma+nome é ambíguo e devolve `null`.
 */
export function matchSavedTrack<T extends PlaybackTrackLike>(
  tracks: readonly T[],
  saved: PlaybackTrackSelection | null | undefined
): T | null {
  if (!saved) return null;

  if (saved.id) {
    const byId = tracks.find((track) => track.id === saved.id);
    if (byId) return byId;
  }

  if (saved.language && saved.name) {
    const matches = tracks.filter((track) => track.language === saved.language && track.label === saved.name);
    if (matches.length === 1) return matches[0];
  }

  return null;
}

/**
 * Casa uma trilha pelo IDIOMA apenas — o ID e o nome quase certamente mudam de um episódio para
 * o outro (arquivo diferente), então herdar o áudio/legenda do episódio anterior só pode se
 * apoiar no idioma. Compara pelo idioma NORMALIZADO (`normalizedTrackLanguage`, o mesmo usado
 * pelo áudio original): "pob" e "pt-BR" são o mesmo idioma, "jpn" e "ja" também — mas PT-BR e PT
 * genérico continuam DISTINTOS aqui (a substituição entre os dois só vale para legenda, nunca
 * para áudio). Primeira trilha com o idioma pedido; sem idioma pedido, sem trilha.
 */
export function matchTrackByLanguage<T extends PlaybackTrackLike>(
  tracks: readonly T[],
  language: string | null | undefined
): T | null {
  if (!language?.trim()) return null;
  const target = normalizedTrackLanguage({ language, label: "" });
  if (!target) return null;
  return tracks.find((track) => normalizedTrackLanguage({ language: track.language ?? null, label: track.label ?? "" }) === target) ?? null;
}

/**
 * Escolhe a trilha (áudio ou legenda) a restaurar ao abrir um episódio: dentro de uma sessão
 * ativa, o IDIOMA do episódio que está sendo deixado vence — mesmo sobre a retomada salva do
 * episódio novo, porque a pessoa acabou de escolher aquele idioma de propósito. Sem episódio
 * sendo deixado (abertura do zero), só a retomada salva do próprio episódio vale, como sempre.
 */
export function resolveContinuityTrack<T extends PlaybackTrackLike>(
  tracks: readonly T[],
  options: {
    readonly ownSaved: PlaybackTrackSelection | null | undefined;
    readonly previousEpisodeLanguage: string | null | undefined;
  }
): T | null {
  return matchTrackByLanguage(tracks, options.previousEpisodeLanguage) ?? matchSavedTrack(tracks, options.ownSaved);
}

/** Captura a legenda realmente ativa antes de trocar de episódio, inclusive a embutida no MKV. */
export function subtitleContinuityFromTracks<T extends PlaybackTrackLike>(
  tracks: readonly T[],
  selectedId: string | null,
  fallback: PlaybackTrackSelection | null | undefined,
  explicitlyOff = false
): "off" | { readonly language: string } | null {
  if (explicitlyOff) return "off";
  if (selectedId === null) {
    const language = fallback ? normalizedTrackLanguage({ language: fallback.language, label: fallback.name ?? "" }) : null;
    return language ? { language } : null;
  }
  const selected = tracks.find((track) => track.id === selectedId);
  const language = selected
    ? normalizedTrackLanguage({ language: selected.language ?? null, label: selected.label ?? "" })
    : fallback?.id === selectedId
      ? normalizedTrackLanguage({ language: fallback.language, label: fallback.name ?? "" })
      : null;
  return language ? { language } : null;
}

/** Preserva idioma e tipo da legenda entre arquivos cujos IDs de trilha são independentes. */
export function matchSubtitleContinuityTrack<T extends PlaybackTrackLike>(
  tracks: readonly T[],
  language: string,
  origin: "embedded" | "external" | undefined,
  externalIds: ReadonlySet<string>,
  preferredId?: string | null
): T | null {
  const preferred = origin === "embedded"
    ? tracks.filter((track) => !externalIds.has(track.id))
    : origin === "external" ? tracks.filter((track) => externalIds.has(track.id)) : tracks;
  const match = (candidates: readonly T[]) => matchTrackByLanguage(candidates, language) ??
    (language === "pt" || language === "pt-BR"
      ? matchTrackByLanguage(candidates, language === "pt" ? "pt-BR" : "pt") : null);
  const preferredRelease = preferredId ? preferred.find((track) => track.id === preferredId) : null;
  return (preferredRelease ? match([preferredRelease]) : null) ?? match(preferred) ?? match(tracks);
}

/**
 * Combina o cenário atual com um patch parcial. Cada campo do patch substitui o correspondente
 * no cenário atual — inclusive `null` explícito, que limpa o campo — e campos ausentes do patch
 * preservam o valor atual.
 */
export function mergeScenario(
  current: PlaybackScenario | null | undefined,
  patch: PlaybackScenarioPatch
): PlaybackScenario {
  return {
    ...(current ?? {}),
    ...patch
  };
}

/**
 * Confirma uma escolha do usuário no cenário em memória antes de pedir sua persistência. Uma
 * leitura no segundo zero não deve apagar um progresso já salvo; nesse caso o cenário continua
 * em memória e será incluído no próximo evento válido de posição, pausa ou encerramento.
 */
export function commitScenarioChange(options: {
  readonly current: PlaybackScenario | null | undefined;
  readonly patch: PlaybackScenarioPatch;
  readonly reading: PlaybackReading | null;
  readonly update: (scenario: PlaybackScenario) => void;
  readonly persist: (reading: PlaybackReading) => void;
}): void {
  const next = mergeScenario(options.current, options.patch);
  options.update(next);
  if (options.reading && options.reading.durationSeconds >= 1 && options.reading.positionSeconds > 0) {
    options.persist(options.reading);
  }
}

/** O ID só identifica áudio dentro de um arquivo; confirma o idioma ao restaurar outro release. */
export function matchSavedAudioTrack<T extends PlaybackTrackLike>(
  tracks: readonly T[], saved: PlaybackTrackSelection | null | undefined
): T | null {
  if (!saved) return null;
  const language = normalizedTrackLanguage({ language: saved.language, label: saved.name ?? "" });
  const compatible = language ? tracks.filter((track) =>
    normalizedTrackLanguage({ language: track.language ?? null, label: track.label ?? "" }) === language) : tracks;
  // Nome diferencia versões (comentários, audiodescrição, mixagem) dentro do mesmo idioma.
  const named = saved.name ? compatible.filter((track) => track.label === saved.name) : [];
  if (named.length === 1) return named[0]!;
  const byId = compatible.find((track) => track.id === saved.id);
  if (byId) return byId;
  // Sem idioma conhecido ou com várias versões não escolhe uma faixa arbitrária.
  return language && compatible.length === 1 ? compatible[0]! : null;
}

/** Captura o idioma ouvido agora, inclusive quando a faixa foi escolhida automaticamente. */
export function audioContinuityFromTracks<T extends PlaybackTrackLike>(
  tracks: readonly T[], selectedId: string | null,
  fallback: PlaybackTrackSelection | null | undefined
): string | null {
  const selected = tracks.find((track) => track.id === selectedId);
  if (selected) return normalizedTrackLanguage({ language: selected.language ?? null, label: selected.label ?? "" });
  return fallback && fallback.id === selectedId
    ? normalizedTrackLanguage({ language: fallback.language, label: fallback.name ?? "" }) : null;
}
