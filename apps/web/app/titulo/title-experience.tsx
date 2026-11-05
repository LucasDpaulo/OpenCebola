"use client";

import { KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import type { MediaPlayerInstance } from "@vidstack/react";
import { DOLBY_AUDIO_PATTERN, HEVC_PATTERN } from "@cebola/contracts/codecs";
import type { LibraryItem, PlaybackScenario, PlaybackSource } from "@cebola/contracts";
import { libraryResponseSchema } from "@cebola/contracts";
import {
  audioContinuityFromTracks,
  mergeScenario,
  resolveContinuitySource,
  scenarioForStream,
  subtitleContinuityFromTracks,
  type PlaybackScenarioPatch
} from "../player/playback-scenario";
import { applyLibraryChange } from "../library-client";
import { isEditorialTitle, useEditorial, youtubeId } from "../editorial";
import { useWebTrailers } from "../use-web-trailers";
import { createSubtitleTextCache } from "../player/subtitle-text-cache";
import { TeaserFrame, useDelayedFlag } from "../teaser";
import { isLowEndDevice } from "../device-capability";
import { BrandIcon } from "../brand-icon";
import styles from "./title.module.css";
import { apiFetch, apiUrl, appPagePath } from "../api-client";
import { reportDiagnostic } from "../diagnostics";
import { localStreamingAvailable, onLocalStreamingStopped, prepareLocalTorrent, releaseLocalTorrent } from "../streaming/local-streaming";
import { interceptPlaybackBack } from "../player/playback-back";
import { isRealDebridSource, sourcesForLocalEngine } from "../streaming/local-sources";
import { CapacitorPlayer, nativePlayerDisponivel } from "../player/capacitor-player";
import { TauriPlayer, tauriPlayerDisponivel } from "../player/tauri-player";
import { TizenPlayer, tizenPlayerDisponivel } from "../player/tizen-player";
import { TizenBridgePlayer } from "../player/tizen-bridge-player";
import { durationMismatch, sourceMatch, type SourceMatchTarget } from "../player/source-match";
import { dentroDaCasca } from "../tv/tizen-casca";
import { PlayerControls, type SubtitleSettings } from "../player/player-controls";
import { ajustesIniciais, lerAjustesDoAparelho } from "../player/regras/ajustes-legenda";
import { discoverStreams } from "../player/stream-discovery";
import { readDeviceSource, rememberDeviceSource, forgetDeviceSource, type DeviceSourceKey } from "../player/device-source";
import { autoplayDecision } from "../player/autoplay-decision";
import { pollDebrid, waitForDebrid, isDebridPlaceholder } from "../player/debrid-wait";
import { LatestOperation } from "../player/latest-operation";
import { tracksPreparedFor } from "../player/playback-readiness";
import { PlaybackPreparation, PlaybackStartupTiming, playbackPreparationKey } from "../player/playback-preparation";
import { buildPlayerSourceOptions } from "../player/player-source-options";
import { rankAutomaticSources } from "../player/source-ranking";
import { releaseGroupOf, retrySourceAfterFailure } from "../player/playback-failure-policy";
import { BrowserPlayer } from "../player/browser-player";
import { decidirInicio } from "../player/regras/inicio";
import { aplicarFaixas, legendaNaAbertura, type EntradaFaixas } from "../player/regras/faixas";
import { criarGuardaDoPontoSalvo, type GuardaDoPontoSalvo } from "../player/regras/guarda-do-ponto-salvo";
import { preferredBrowserSubtitleId, watchBrowserSubtitleChanges } from "../player/browser-subtitle-activation";
import { canLoadPlayerSource, LateSubtitleGate, type NativePlayer } from "../player/native-player";
import {
  buildProgressBody,
  createProgressTracker,
  fetchTitleProgress,
  mergeSavedProgress,
  retryPendingProgress,
  findSavedProgress,
  progressForTitle,
  progressVideoId,
  sendProgress,
  type ProgressReading,
  type ProgressTracker,
  type SavedProgressItem
} from "../progress";
import {
  nextSubtitleId,
  rankSubtitleCandidates,
  normalizedTrackLanguage,
  normalizeEmbeddedSubtitles,
  orderSubtitleCandidates,
  withoutOtherTitleSubtitles
} from "../player/subtitle-selection";
import { timingFit, vttCueTimes, type TimingVerdict } from "../player/subtitle-timing";
import {
  editorialSearchQueries,
  matchEditorialCandidate,
  preferredPlaybackVideo,
  settledEditorialCandidates
} from "./editorial-playback-match";
import { adjacentEpisode, orderedEpisodes } from "./episode-order";
import { useReturnToForeground } from "../foreground-refresh";
import { consumedAutoplayUrl } from "./autoplay-query";
import { displayEpisodeNumber, episodeDisplayLabel } from "../episode-display";
import { canAdvanceOnEnded } from "../player/pulos/skip-segments";
import { useBlocosDePulo } from "../player/pulos/use-blocos-de-pulo";
import { useTvLayout } from "../tv/use-tv-layout";

// O Vidstack (~350 KB) só é usado quando não há player nativo/Tauri/Tizen disponível — ou seja,
// só no navegador de PC. `next/dynamic` com `ssr: false` mantém esse chunk fora do bundle do
// celular/TV/Tauri/Tizen, onde ele nunca é montado.
const TitleBrowserPlayer = dynamic(() => import("./title-browser-player"), { ssr: false });

type MediaType = "movie" | "series";
type Video = {
  id: string; title: string; season: number | null; episode: number | null;
  released: string | null; thumbnail: string | null;
};
type Meta = {
  id: string; type: MediaType; name: string; poster: string | null; background: string | null;
  logo?: string | null;
  description: string | null; releaseInfo: string | null; genres?: readonly string[]; videos: Video[];
};
type StreamQuality = "4K" | "1080p" | "720p" | "480p" | "SD" | null;
type StreamBase = {
  id: string; addonId: string; addonName: string; label: string;
  // Metadados de apoio à escolha (popup tipo Netflix): sempre opcionais, ausência é normal.
  quality?: StreamQuality; sizeLabel?: string | null; seeders?: number | null;
  source?: string | null; mayNotPlay?: boolean; audioLanguages?: string[]; subtitleLanguages?: string[]; dubbed?: boolean;
  // true = já está no cache do debrid e abre agora; false = precisaria baixar; null = o add-on
  // não informa. Só o Torrentio informa, e ele é 90% das fontes que chegam.
  readyNow?: boolean | null;
  // Nome/tamanho do ARQUIVO real (behaviorHints do add-on, ou o nome que o Real-Debrid devolveu
  // ao resolver o torrent): usado só para achar a legenda sincronizada com este exato arquivo,
  // nunca exibido como o `label` da fonte.
  filename?: string; videoSize?: number;
  localSessionId?: string;
};
type DirectStream = StreamBase & { kind: "direct"; url: string; infoHash?: string; fileIdx?: number | null };
type TorrentStream = StreamBase & { kind: "torrent"; url: null; infoHash: string; fileIdx: number | null; trackers?: readonly string[] };
type Stream = DirectStream | TorrentStream;

type EditorialMatch = { readonly id: string; readonly addonId: string; readonly type: MediaType; readonly name: string };

function readEditorialMatch(key: string, type: MediaType): EditorialMatch | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? "null") as Partial<EditorialMatch> | null;
    if (!value || typeof value.id !== "string" || typeof value.addonId !== "string") return null;
    return { id: value.id, addonId: value.addonId, type, name: typeof value.name === "string" ? value.name : "" };
  } catch { return null; }
}

function rememberEditorialMatch(key: string, match: EditorialMatch): void {
  try { window.localStorage.setItem(key, JSON.stringify({ id: match.id, addonId: match.addonId, name: match.name })); } catch { /* sem armazenamento */ }
}

function forgetEditorialMatch(key: string): void {
  try { window.localStorage.removeItem(key); } catch { /* sem armazenamento */ }
}

const MAX_REJECTED_SOURCE_SKIPS = 3;
// Trocas automáticas de fonte por episódio quando o PLAYER falha (antes era uma só: bastava a
// primeira alternativa ser do mesmo release quebrado para devolver a escolha à pessoa).
const MAX_AUTOMATIC_SOURCE_RETRIES = 2;

type PlaybackFailureOptions = { readonly avoidSameGroup?: boolean };


// Quanto a abertura espera pela legenda casada com o arquivo antes de desistir e abrir mesmo assim.
const SUBTITLE_REFINE_WAIT_MS = 2_000;

/** Instante (relógio do servidor) de uma gravação; 0 sem data. */
function updatedAtOf(item: { readonly updatedAt?: string }): number {
  return Date.parse(item.updatedAt ?? "") || 0;
}

/** Instante da gravação mais recente da lista (0 sem nenhuma com data). */
function latestUpdate(items: readonly { readonly updatedAt?: string }[]): number {
  return items.reduce((latest, item) => Math.max(latest, updatedAtOf(item)), 0);
}

/** Preferência "pular abertura automaticamente"; ligada por padrão, inclusive se o storage falhar. */
function pularAberturaLigado(): boolean {
  try {
    return window.localStorage.getItem("cebola:player:auto_skip_intro") !== "0";
  } catch {
    return true;
  }
}
// Continuidade entre episódios (série/anime/novela): o que o episódio que a pessoa está DEIXANDO
// estava usando, só guardado em memória (nunca persistido, nunca enviado ao servidor) e só
// capturado quando havia mesmo um player aberto (troca dentro de uma sessão). É a semente do
// episódio seguinte quando ele ainda não tem cenário próprio — ou, para fonte e trilhas, mesmo
// quando tem: ver `resolveContinuitySource`/`resolveContinuityTrack`.
type EpisodeContinuitySeed = {
  readonly seriesId: string;
  readonly source: PlaybackSource;
  readonly audioLanguage: string | null;
  readonly subtitle: "off" | {
    readonly language: string;
    readonly details?: string | null;
    readonly origin?: "embedded" | "external";
  } | null;
  readonly subtitleSettings: SubtitleSettings | null;
};

/** Só vale a semente se ainda estivermos na mesma série — nunca atravessa títulos diferentes. */
function activeContinuity(seed: EpisodeContinuitySeed | null, seriesId: string | undefined): EpisodeContinuitySeed | null {
  return seed && seed.seriesId === seriesId ? seed : null;
}
// Progresso salvo como a API devolve (a leitura e a gravação moram em `../progress`).
type SavedProgress = SavedProgressItem;
type ViewState = "loading" | "ready" | "error";
type BrowserStreamTarget = { addonId: string; addonName: string; url: string };
export type Subtitle = {
  id: string; addonName: string; label: string; details?: string; language: string; url: string;
  // Casada pelo HASH do arquivo de vídeo pelo OpenSubtitles — sincronia confirmada, o sinal mais
  // forte que existe para ranquear/escolher automaticamente.
  hashMatch?: boolean; fps?: number;
};

/**
 * Compartilhado pela busca inicial (por título/episódio) e pelo refinamento por arquivo (depois
 * que uma fonte é escolhida): mesma validação de formato nos dois lugares, para as duas listas
 * poderem ser mescladas sem surpresa de campo ausente/tipo diferente.
 */
function parseSubtitleList(value: unknown): Subtitle[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Subtitle[] => {
    if (typeof item !== "object" || item === null) return [];
    const candidate = item as Partial<Subtitle>;
    if (typeof candidate.id !== "string" || typeof candidate.addonName !== "string" ||
      typeof candidate.label !== "string" ||
      (candidate.details !== undefined && typeof candidate.details !== "string") ||
      (candidate.hashMatch !== undefined && typeof candidate.hashMatch !== "boolean") ||
      (candidate.fps !== undefined && typeof candidate.fps !== "number") ||
      typeof candidate.language !== "string" || typeof candidate.url !== "string") return [];
    return [{ ...candidate as Subtitle, url: candidate.url.startsWith("/") ? apiUrl(candidate.url) : candidate.url }];
  });
}

/**
 * Como a checagem de sincronia (camada 3) lê e troca a legenda ativa sem saber se está falando
 * com o player nativo ou o Vidstack no navegador — cada chamador (efeito nativo, `onLoadedMetadata`
 * do navegador) fornece a implementação certa para o aparelho onde está rodando.
 */
interface SubtitleTimingPlatform {
  /** ID da legenda tocando agora, ou `null` se nenhuma. Lido de novo no fim da checagem para
   *  detectar se a pessoa trocou de legenda (ou de fonte) enquanto os fetches ainda voavam. */
  readonly getActiveId: () => string | null;
  readonly apply: (id: string) => void;
}

// Camada 3 de sincronia (subtitle-timing.ts): tempo máximo por legenda buscada — a checagem roda
// em segundo plano depois que o vídeo já está tocando, então travar a UI esperando uma legenda
// lenta seria pior do que simplesmente desistir dela e tentar a próxima candidata.
const SUBTITLE_TIMING_FETCH_TIMEOUT_MS = 4_000;
// `parseSubtitleList` já resolveu toda URL relativa para absoluta com `apiUrl`; esta é a mesma
// base, usada aqui só para reconhecer QUANDO uma URL é da nossa API (e por isso precisa do
// `apiFetch`, com credencial) e quando é externa (busca direta, sem credencial nossa).
const API_ORIGIN = apiUrl("");

/**
 * Busca o TEXTO da legenda (VTT, já convertido pelo relay — ver `/v1/stremio/subtitles/file`) para
 * a camada 3 medir a sincronia contra a duração real do vídeo. Nunca lança: uma legenda que não
 * responde a tempo só significa "não dá para confirmar", não um erro de reprodução.
 */
async function readSubtitleText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), SUBTITLE_TIMING_FETCH_TIMEOUT_MS);
  try {
    const response = url.startsWith(API_ORIGIN)
      ? await apiFetch(url.slice(API_ORIGIN.length), { signal: controller.signal, headers: { Accept: "text/vtt" } })
      : await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

const fetchSubtitleText = createSubtitleTextCache(readSubtitleText);

/** Aviso de biblioteca acionável: falha ao adicionar/remover, com a retentativa embutida. */
type LibraryNotice = { readonly message: string; readonly retry: () => void };
export interface UserReview {
  readonly id: string;
  readonly mediaId: string;
  readonly profileId: string;
  readonly profileName: string;
  readonly ratingStars: number;
  readonly ratingScore: number;
  readonly comment: string;
  readonly createdAt: string;
}
// A escolha manual segue o modelo do Stremio: origem, qualidade e então o arquivo exato.
const PLAYBACK_ADDON_ORDER: readonly string[] = [
  "com.stremio.thepiratebay.plus",
  "org.community.orion",
  "com.stremio.torrentio.addon"
];

// Elementos considerados pelo focus trap do popup (só há botões dentro dele hoje).
const FOCUSABLE_SELECTOR = "button:not(:disabled), a[href], [tabindex]:not([tabindex=\"-1\"])";


const LANGUAGE_NAMES: Record<string, string> = {
  en: "Inglês", pt: "Português", es: "Espanhol", fr: "Francês", it: "Italiano",
  de: "Alemão", ru: "Russo", uk: "Ucraniano", pl: "Polonês", nl: "Holandês",
  ja: "Japonês", ko: "Coreano", zh: "Chinês", hi: "Hindi", tr: "Turco",
  sv: "Sueco", no: "Norueguês", da: "Dinamarquês", fi: "Finlandês", el: "Grego",
  cs: "Tcheco", hu: "Húngaro", ro: "Romeno", he: "Hebraico", ar: "Árabe",
  th: "Tailandês", vi: "Vietnamita", id: "Indonésio"
};

function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code.toUpperCase();
}

// O navegador sabe o que decodifica. Perguntar a ele custa uma linha e acaba com a adivinhação
// pelo nome do arquivo — que estava errada em duas direções ao mesmo tempo.
//
// Medido com canPlayType no Chrome deste Linux:
//   HEVC (hvc1/hev1) -> ""          não decodifica, e o sintoma é tela PRETA, não erro
//   AC3 / EAC3       -> ""          não decodifica, e o sintoma é vídeo MUDO
//   .mkv com H.264   -> "probably"  toca normalmente
//
// No Chrome do Windows, macOS e Android o HEVC responde "probably". Punir HEVC em todo aparelho,
// como estava, jogava fora as melhores fontes de quem não usa Linux — e ainda assim acusava
// .mkv, que toca em todos eles.
interface DeviceCodecs {
  readonly hevc: boolean;
  readonly dolbyAudio: boolean;
}

// Começa assumindo que o aparelho NÃO tem os codecs extras: é o comportamento de hoje, e erra
// para o lado seguro enquanto a medição não rodou (ela roda num efeito, antes das fontes
// chegarem da API).
const CODECS_DESCONHECIDOS: DeviceCodecs = { hevc: false, dolbyAudio: false };

function detectDeviceCodecs(): DeviceCodecs {
  // Na TV Samsung quem toca é o AVPlay da casca, que decodifica HEVC e Dolby no hardware; o
  // navegador do iframe responde por ele mesmo e marcava todo 4K HEVC como incompatível.
  if (dentroDaCasca()) return { hevc: true, dolbyAudio: true };
  const probe = document.createElement("video");
  const toca = (mime: string) => probe.canPlayType(mime) !== "";
  return {
    hevc: toca('video/mp4; codecs="hvc1.1.6.L93.B0"') || toca('video/mp4; codecs="hev1.1.6.L93.B0"'),
    dolbyAudio: toca('audio/mp4; codecs="ac-3"') || toca('audio/mp4; codecs="ec-3"')
  };
}

// HEVC_PATTERN e DOLBY_AUDIO_PATTERN vêm de @cebola/contracts. O aviso continua importante na
// escolha manual: no Linux, uma fonte Dolby pode abrir normalmente, mas sem som.

// Avisar em 76% das fontes, como acontecia, é o mesmo que não avisar: vira ruído e a pessoa
// aprende a ignorar. Agora só aparece quando ESTE aparelho é realmente o problema, e diz o que
// vai faltar em vez de listar codecs.
function playbackWarning(stream: Stream, codecs: DeviceCodecs): string | null {
  const text = `${stream.label} ${stream.source ?? ""}`.toLowerCase();
  if (!codecs.hevc && HEVC_PATTERN.test(text)) {
    return "Esta fonte pode abrir sem imagem neste aparelho. Se acontecer, escolha outra na lista.";
  }
  if (!codecs.dolbyAudio && DOLBY_AUDIO_PATTERN.test(text)) {
    return "Esta fonte pode abrir sem som neste aparelho. Se acontecer, escolha outra na lista.";
  }
  return null;
}

// Detector de fonte muda ---------------------------------------------------------------------
// O nome do arquivo não basta: em The Bear S01E01, ZERO das 11 fontes declara codec de áudio. Só
// dá para saber depois que está tocando, e o que denuncia é o contador de bytes decodificados.
// Medido no Chrome desta máquina:
//   arquivo com áudio decodificável -> webkitAudioDecodedByteCount = 24576, vídeo 0
//   arquivo sem áudio nenhum        -> webkitAudioDecodedByteCount = 0,     vídeo 635
//
// Isto já esteve no ar e foi revertido no mesmo dia: cada troca de fonte gasta uma chamada de
// resolve, e o teto era de 12 por 5 minutos POR IP — a casa inteira num balde só. Voltou agora
// porque aquilo foi corrigido (chave por sessão, teto de 40) e porque o servidor passou a
// registrar por que uma fonte falha, então dá para verificar em vez de apostar.
interface VideoComContadores extends HTMLVideoElement {
  readonly webkitAudioDecodedByteCount?: number;
  readonly webkitVideoDecodedByteCount?: number;
}

// Segundos de vídeo realmente decodificando, sem um único byte de áudio, antes de desistir da
// fonte. Silêncio NO CONTEÚDO não confunde: o contador mede bytes decodificados, e uma faixa em
// silêncio decodifica normalmente. Zero significa faixa ausente ou codec que o aparelho não abre
// — nunca "está quieto agora". A margem existe para o começo, quando o vídeo já anda e o áudio
// ainda está enchendo o buffer.
const SEGUNDOS_ATE_DECLARAR_MUDA = 6;

/** "17 abr 2011". Data completa não cabe na única linha de texto que o cartão tem. */
function shortDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("pt-BR", { day: "numeric", month: "short", year: "numeric" })
    .replace(/\./g, "");
}

function formatProgressTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0m";
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

function isMeta(value: unknown): value is Meta {
  if (typeof value !== "object" || value === null) return false;
  const meta = value as Partial<Meta>;
  return typeof meta.id === "string" && (meta.type === "movie" || meta.type === "series") &&
    typeof meta.name === "string" && Array.isArray(meta.videos);
}

// Nome certo, obra errada: o arquivo aberto é bem mais curto que o filme (ver `durationMismatch`).
function wrongDurationNotice(durationSeconds: number, runtimeMinutes: number | null | undefined): string {
  return `Esta fonte tem ${Math.round(durationSeconds / 60)} min e o filme tem ${runtimeMinutes ?? "?"} — é outro vídeo.`;
}

function runtimeLabel(minutes: number | null): string | null {
  if (!minutes) return null;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return hours > 0 ? `${hours}h${remaining ? ` ${remaining}min` : ""}` : `${minutes}min`;
}

function isStream(value: unknown): value is Stream {
  if (typeof value !== "object" || value === null) return false;
  const stream = value as Partial<Stream>;
  const common = typeof stream.id === "string" && typeof stream.addonId === "string" &&
    typeof stream.addonName === "string" && typeof stream.label === "string" &&
    (stream.quality === null || stream.quality === undefined || ["4K", "1080p", "720p", "480p", "SD"].includes(stream.quality));
  if (!common) return false;
  if (stream.kind === "direct") return typeof stream.url === "string" && stream.url.startsWith("https://");
  return stream.kind === "torrent" && stream.url === null && typeof stream.infoHash === "string" &&
    /^[a-fA-F0-9]{40}$/.test(stream.infoHash) && (stream.fileIdx === null || Number.isInteger(stream.fileIdx));
}

function isBrowserStreamTarget(value: unknown): value is BrowserStreamTarget {
  if (typeof value !== "object" || value === null) return false;
  const target = value as Partial<BrowserStreamTarget>;
  if (typeof target.addonId !== "string" || typeof target.addonName !== "string" || typeof target.url !== "string") {
    return false;
  }
  try {
    const url = new URL(target.url);
    return url.protocol === "https:" && url.username === "" && url.password === "" &&
      (url.port === "" || url.port === "443");
  } catch {
    return false;
  }
}

function playbackAddonLabel(stream: Stream): string {
  if (stream.addonId === "com.stremio.torrentio.addon") return stream.kind === "torrent" ? "Torrentio" : stream.addonName;
  if (stream.addonId === "com.stremio.thepiratebay.plus") return "ThePirateBay+";
  if (stream.addonId === "org.community.orion") return "Orion";
  return stream.addonName;
}

interface QualityStreamGroup {
  readonly label: string;
  readonly streams: readonly Stream[];
}

interface AddonStreamGroup {
  readonly addonId: string;
  readonly label: string;
  readonly qualities: readonly QualityStreamGroup[];
}

const QUALITY_GROUPS: readonly { quality: StreamQuality | "other"; label: string }[] = [
  { quality: "4K", label: "4K" },
  { quality: "1080p", label: "1080p · Full HD" },
  { quality: "720p", label: "720p · HD" },
  { quality: "other", label: "Outras qualidades" }
];

// A ordem continua estável dentro de cada qualidade, mas a lista agora segue a hierarquia que a
// pessoa usa para decidir: primeiro o add-on, depois 4K/1080p/720p, então o arquivo específico.
function groupStreamsForManualChoice(streams: readonly Stream[]): readonly AddonStreamGroup[] {
  const groups = new Map<string, { label: string; streams: Stream[] }>();
  for (const stream of streams) {
    const bucket = groups.get(stream.addonId);
    if (bucket) bucket.streams.push(stream);
    else groups.set(stream.addonId, { label: playbackAddonLabel(stream), streams: [stream] });
  }
  const orderedIds = [
    ...PLAYBACK_ADDON_ORDER,
    ...[...groups.keys()].filter((id) => !PLAYBACK_ADDON_ORDER.includes(id))
  ];
  return orderedIds.flatMap((id) => {
    const group = groups.get(id);
    if (!group) return [];
    const qualities = QUALITY_GROUPS.flatMap(({ quality, label }) => {
      const matching = group.streams.filter((stream) => quality === "other"
        ? stream.quality !== "4K" && stream.quality !== "1080p" && stream.quality !== "720p"
        : stream.quality === quality);
      return matching.length > 0 ? [{ label, streams: matching }] : [];
    });
    return [{ addonId: id, label: group.label, qualities }];
  });
}

function streamMetaLine(stream: Stream): string {
  return [
    stream.sizeLabel ?? null,
    typeof stream.seeders === "number" ? `${stream.seeders} seeders` : null,
    stream.source ?? null
  ].filter((part): part is string => Boolean(part)).join(" · ");
}

function automaticStream(
  streams: readonly Stream[],
  codecs: DeviceCodecs,
  preferredAddonId: string | null | undefined,
  languages: RankingLanguages
): Stream | null {
  const compactScreen = typeof window !== "undefined" && window.innerWidth < 1200;
  // Antes filtrava para só o add-on da última sessão; agora ele só desempata dentro do ranking
  // (`rankAutomaticSources`), então uma fonte melhor de outro add-on nunca fica de fora.
  return rankAutomaticSources(streams, {
    originalLanguage: languages.original,
    audioLanguage: languages.audio,
    subtitleLanguage: languages.subtitle,
    compactScreen,
    lowPower: isLowEndDevice(),
    // TV Samsung é 4K e decodifica 4K no hardware (AVPlay): 4K saudável vem primeiro. O projetor
    // continua como aparelho fraco.
    prefer4k: dentroDaCasca() && !compactScreen,
    compatible: (stream) => playbackWarning(stream, codecs) === null,
    preferredAddonId: preferredAddonId ?? null,
    preferTorrents: localStreamingAvailable()
  })[0] ?? null;
}

interface RankingLanguages {
  readonly original: string | null;
  readonly audio: string | null;
  readonly subtitle: string | null;
}

/**
 * Idiomas para escolher a fonte: os do cenário salvo (sincronizado entre aparelhos) vêm antes do
 * áudio original. Quem começou no celular em 720p continua na TV com o mesmo áudio e a mesma
 * legenda, mesmo que a TV escolha outro arquivo, em 4K.
 */
function rankingLanguages(original: string | null | undefined, scenario: PlaybackScenario | null): RankingLanguages {
  return { original: original ?? null, audio: scenario?.audio?.language ?? null, subtitle: scenario?.subtitle?.language ?? null };
}

/**
 * Autoplay (abrir/continuar/próximo episódio) tenta, nesta ordem: (1) dentro de uma sessão ativa,
 * o MESMO lançamento do episódio que a pessoa está deixando (`previousEpisodeSource` — só vem
 * preenchido nesse caso, nunca numa abertura do zero); (2) a fonte EXATA salva na última vez que
 * ESTE episódio foi assistido NESTE aparelho/perfil; (3) escolha automática. A fonte do
 * progresso compartilhado não força uma qualidade escolhida em outro dispositivo.
 */
function chooseAutoplayStream(
  streams: readonly Stream[],
  codecs: DeviceCodecs,
  savedSource: PlaybackSource | null,
  languages: RankingLanguages,
  previousEpisodeSource?: PlaybackSource | null
): Stream | null {
  return resolveContinuitySource(streams, {
    ownSaved: savedSource,
    previousEpisode: previousEpisodeSource ?? null
  }) ?? automaticStream(streams, codecs, savedSource?.addonId, languages);
}

/** Ajustes de legenda guardados neste aparelho (sem a sincronia, que é do vídeo). */
function ajustesDoAparelho(): Partial<SubtitleSettings> {
  try {
    return lerAjustesDoAparelho(typeof window === "undefined" ? null : window.localStorage);
  } catch {
    return {};
  }
}

function releaseKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// TPB+ e Orion entregam infoHash; o Torrentio RD frequentemente entrega o MESMO hash já
// resolvido dentro da URL. Nem todo formato de URL preserva o hash; nesse caso o nome completo
// do release é a segunda chave. A consulta já é para um episódio específico, então duas fontes
// com o mesmo release nessa resposta apontam para o mesmo vídeo, inclusive quando o release é
// um pacote de temporada. Quando encontramos uma delas, mantém o card em seu grupo original,
// mas usa o link RD+ pronto. Assim não chamamos addMagnet para um hash que o Real-Debrid pode
// bloquear apesar de o Torrentio já ter uma URL reproduzível para o arquivo.
function attachReadyDirectFallbacks(streams: readonly Stream[]): readonly Stream[] {
  const readyByHash = new Map<string, DirectStream>();
  const readyByRelease = new Map<string, DirectStream>();
  for (const stream of streams) {
    if (stream.kind !== "direct" || stream.readyNow !== true) continue;
    for (const hash of stream.url.match(/[a-fA-F0-9]{40}/g) ?? []) {
      readyByHash.set(hash.toLowerCase(), stream);
    }
    const key = releaseKey(stream.label);
    if (key.length >= 12) readyByRelease.set(key, stream);
  }
  return streams.map((stream): Stream => {
    if (stream.kind !== "torrent") return stream;
    const fallback = readyByHash.get(stream.infoHash.toLowerCase()) ??
      readyByRelease.get(releaseKey(stream.label));
    if (!fallback) return stream;
    return {
      ...stream,
      kind: "direct",
      url: fallback.url,
      readyNow: true,
      mayNotPlay: stream.mayNotPlay || fallback.mayNotPlay,
      audioLanguages: stream.audioLanguages && stream.audioLanguages.length > 0
        ? stream.audioLanguages : fallback.audioLanguages,
      subtitleLanguages: stream.subtitleLanguages && stream.subtitleLanguages.length > 0
        ? stream.subtitleLanguages : fallback.subtitleLanguages,
      dubbed: stream.dubbed || fallback.dubbed
    };
  });
}

export function TitleExperience() {
  const router = useRouter();
  // Só decide MARCAÇÃO (JSX) de TV — CSS puro fica em title.module.css sob `html[data-tv-layout]`.
  // Mesmos estados e handlers do PC/celular; a TV só reorganiza como aparecem na tela.
  const tvLayout = useTvLayout();
  // No export estático, o App Router não expõe os parâmetros por useSearchParams. A URL do
  // navegador continua sendo a fonte correta tanto em `/titulo/` quanto no desenvolvimento.
  // O App Router pode reutilizar esta página quando muda apenas a query string. Ler a URL a
  // cada renderização impede que título, episódio e progresso da escolha anterior sobrevivam.
  const query = new URLSearchParams(
    typeof window === "undefined" ? "" : window.location.search
  );
  const requestedAddonId = query.get("addon") ?? "";
  const type = query.get("type") as MediaType | null;
  const mediaId = query.get("id") ?? "";
  const requestedVideoId = query.get("video") ?? "";
  // Card de "próximo episódio" da home: `video` é o episódio terminado; a página abre o seguinte.
  const requestedNext = query.get("next") === "1";
  const shouldOpenStreamList = query.get("play") === "1";
  const [viewState, setViewState] = useState<ViewState>("loading");
  // TV: a página do título é uma tela só, em abas (referência Netflix) — nada de rolar pra
  // achar episódios, semelhantes ou ficha. Troca de título volta pra "Visão geral".
  const [tvTab, setTvTab] = useState<"geral" | "episodios" | "semelhantes" | "detalhes">("geral");
  useEffect(() => { setTvTab("geral"); }, [mediaId]);
  const addonId = requestedAddonId;
  const [meta, setMeta] = useState<Meta | null>(null);
  const [titleLogoError, setTitleLogoError] = useState(false);
  const [initialEditorial, setInitialEditorial] = useState<ReturnType<typeof useEditorial>>(null);
  const [videoId, setVideoId] = useState("");
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null);
  const [streams, setStreams] = useState<readonly Stream[]>([]);
  const [selectedStream, setSelectedStream] = useState<DirectStream | null>(null);
  const [isPlayerLoading, setIsPlayerLoading] = useState(false);
  // "Continuar" (?play=1): tela preta com o carregamento desde o clique, sem mostrar os detalhes
  // enquanto a fonte é buscada. Depois que uma fonte é escolhida, quem cobre é o `isPlayerLoading`.
  const [cortinaInicial, setCortinaInicial] = useState(true);
  const [pendingAutoplayVideoId, setPendingAutoplayVideoId] = useState<string | null>(null);
  const [playerNativo, setPlayerNativo] = useState<NativePlayer | null>(null);
  const [preparedTracks, setPreparedTracks] = useState<{
    key: string; player: NativePlayer;
  } | null>(null);
  // Fonte que o AVPlay da TV Samsung (via casca) recusou ANTES de tocar. Não é falha da fonte: o
  // Chromium da TV costuma tocá-la, então a MESMA fonte segue no player do navegador em vez de
  // ir para a próxima. Guarda o id (e não um booleano) para a fonte seguinte tentar o AVPlay.
  const [avplayRecusou, setAvplayRecusou] = useState<string | null>(null);
  const [tauriRuntime, setTauriRuntime] = useState(false);
  const [streamState, setStreamState] = useState<"idle" | "loading" | "ready" | "empty" | "error">("idle");
  // Indicador discreto: o primeiro lote já chegou (streamState "ready"), mas add-ons mais lentos
  // ainda podem publicar mais opções. Não bloqueia nada, só avisa que a busca continua.
  const [isSearchingMore, setIsSearchingMore] = useState(false);
  const [sourceNotice, setSourceNotice] = useState<string | null>(null);
  const [orionConsulted, setOrionConsulted] = useState(false);
  const [isStreamModalOpen, setIsStreamModalOpen] = useState(false);
  // Tudo o que o perfil tem salvo (a lista inteira da API). `allSaved`, abaixo, é só o recorte desta obra.
  const [savedItems, setSavedItems] = useState<readonly SavedProgress[]>([]);
  const [progressLoaded, setProgressLoaded] = useState(false);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [deviceProfileLoaded, setDeviceProfileLoaded] = useState(false);
  // A conta é a fonte oficial: em vez de um booleano solto, guarda-se o próprio item da
  // biblioteca (quando existe), que já traz o `id` necessário para o DELETE.
  const [libraryEntry, setLibraryEntry] = useState<LibraryItem | null>(null);
  const savedToLibrary = libraryEntry !== null;
  const [libraryNotice, setLibraryNotice] = useState<LibraryNotice | null>(null);
  const [isReviewModalOpen, setIsReviewModalOpen] = useState(false);
  const [userReviews, setUserReviews] = useState<readonly UserReview[]>([]);
  const [selectedStars, setSelectedStars] = useState(0);
  const [hoverStars, setHoverStars] = useState(0);
  const [reviewComment, setReviewComment] = useState("");
  const reviewDialogRef = useRef<HTMLDivElement>(null);
  const [teaserSound, setTeaserSound] = useState(false);
  const [isUiHidden, setIsUiHidden] = useState(false);
  const [downloadNotice, setDownloadNotice] = useState<string | null>(null);
  const [resolvingStreamId, setResolvingStreamId] = useState<string | null>(null);
  const [resolutionNotice, setResolutionNotice] = useState<string | null>(null);
  const [rawSubtitles, setSubtitles] = useState<readonly Subtitle[]>([]);
  // A SubDL devolve a franquia inteira (Parte 2/3 num filme da Parte 1). O filtro é DERIVADO do
  // estado bruto, não aplicado ao gravar: assim o título que chega depois da busca também filtra,
  // e Tracks do player, legenda automática e painel enxergam sempre a mesma lista.
  const subtitles = useMemo(() => meta ? withoutOtherTitleSubtitles(rawSubtitles, {
    type: meta.type,
    year: Number(meta.releaseInfo?.match(/\b(?:19|20)\d{2}\b/)?.[0]) || null,
    name: meta.name
  }) : rawSubtitles, [rawSubtitles, meta]);
  // `selectStream` é estável; o tipo do título para o refinamento de legenda vem daqui.
  const typeRef = useRef<MediaType | null>(null);
  // null = automático; "off" = desligada pela pessoa; qualquer outro valor é o ID escolhido.
  // Continua valendo se ela fechar e reabrir o mesmo episódio ou trocar só a fonte.
  const [userSubtitleChoice, setUserSubtitleChoice] = useState<string | null>(null);
  // O valor em si não trava mais a abertura do player (Task 8) — só o setter é usado, para o
  // efeito de busca abaixo poder resetar o estado sem precisar de outra variável.
  const [, setSubtitleState] = useState<"idle" | "loading" | "ready">("idle");
  const [subtitleSettings, setSubtitleSettings] = useState<SubtitleSettings>(() => ajustesIniciais({ continuidade: null, salvo: null, aparelho: ajustesDoAparelho() }));
  // Guarda os tempos ORIGINAIS de cada legenda. Sem isso, aplicar o ajuste várias vezes
  // acumularia deslocamento em cima de deslocamento; com isso, cada ajuste parte do original e a
  // operação vira idempotente.
  const cueOriginalTimes = useRef(new WeakMap<object, { start: number; end: number }>());
  const [playerNotice, setPlayerNotice] = useState<string | null>(null);
  // canPlayType precisa de document, então a medição roda num efeito.
  const [deviceCodecs, setDeviceCodecs] = useState<DeviceCodecs>(CODECS_DESCONHECIDOS);
  // Aparelho fraco não recebe o trailer do YouTube atrás do pôster; `heroBackdrop` (CSS, sempre
  // presente quando há imagem) continua igual. Só roda no cliente: SSR/export começa `false`.
  const [lowEndDevice, setLowEndDevice] = useState(false);
  const player = useRef<MediaPlayerInstance>(null);
  const browserPlayer = useRef<BrowserPlayer | null>(null);
  if (browserPlayer.current === null) browserPlayer.current = new BrowserPlayer(() => player.current);
  const refreshBrowserTracksRef = useRef<(() => void) | null>(null);
  const notifyBrowserTracksChanged = useCallback(() => {
    browserPlayer.current?.notify("tracksChanged", undefined);
    refreshBrowserTracksRef.current?.();
  }, []);
  const tauriVideoSurface = useRef<HTMLVideoElement>(null);
  // Sessão de salvamento do vídeo que está tocando (um `createProgressTracker` por vídeo + fonte).
  // Quem decide QUANDO e COMO gravar é o módulo `../progress`; aqui só se entregam os eventos do
  // player. Vive em ref para os handlers (fechar, trocar fonte, trocar cenário) a alcançarem sem
  // entrar nas dependências do efeito que monta o player nativo.
  const progressTrackerRef = useRef<GuardaDoPontoSalvo | null>(null);
  const sessionExpired = useRef(false);
  const startFromBeginningRef = useRef(false);
  const sourceSwitchPositionRef = useRef<number | null>(null);
  // Cenário de reprodução (fonte/áudio/legenda/ajustes) escolhido nesta sessão. Vive em ref, e
  // não em estado, para a gravação de progresso sempre ler o valor mais recente sem precisar
  // entrar nas dependências do efeito que monta o player nativo — do contrário, cada ajuste de
  // legenda reexecutaria o efeito e reabriria a fonte no meio da reprodução.
  const scenarioRef = useRef<PlaybackScenario | null>(null);
  // Semente de continuidade entre episódios (task 7): capturada em `selectEpisode` a partir do
  // episódio que está sendo deixado, só quando havia player aberto. Em memória, nunca persistida.
  // Limpa ao fechar o player e ao trocar de título (ver `closePlayer` e o efeito de reset abaixo).
  const previousEpisodeContinuityRef = useRef<EpisodeContinuitySeed | null>(null);
  const episodeSelectionVersionRef = useRef(0);
  // Espelha `meta?.id` para os efeitos que só precisam disso para ler a continuidade: assim eles
  // não entram em `meta` como dependência (o objeto `meta` é grande e não deve derrubar o player
  // nativo em execução — ver o efeito que monta o player, mais abaixo).
  const metaIdRef = useRef<string | undefined>(undefined);
  // Idem, para a identidade do progresso (título, pôster, addon da URL) e o progresso salvo do
  // vídeo selecionado: lidos só quando uma sessão de salvamento ABRE, nunca como dependência.
  const progressTitleRef = useRef<{ readonly meta: Meta | null; readonly addonId: string }>({ meta: null, addonId: "" });
  const activeSavedRef = useRef<SavedProgress | null>(null);
  // Idem para o callback de falha de reprodução: ele muda de identidade sempre que `streams`
  // cresce (busca em segundo plano), e o efeito que monta o player nativo NUNCA pode reexecutar
  // por causa disso — reexecutar destrói e recria a instância nativa no meio da reprodução.
  const handlePlaybackFailureRef = useRef<(notice: string, options?: PlaybackFailureOptions) => void>(() => {});
  // Lembra fontes que já falharam NESTE vídeo (evento `error` do player nativo/navegador) para
  // nunca escolhê-las de novo — nem a automática nem a salva — e tentar a próxima uma única vez.
  const failedStreamsRef = useRef<{ videoId: string; ids: ReadonlySet<string> }>({ videoId: "", ids: new Set() });
  const autoRetriesRef = useRef<{ videoId: string; count: number }>({ videoId: "", count: 0 });
  // Recusa do Real-Debrid na resolução (arquivo bloqueado, fonte compactada) é permanente para
  // AQUELA fonte e chega em segundos, sem o vídeo nem abrir. Antes só abria a lista, e bastava a
  // ordenação pôr uma fonte recusada em primeiro para o título "parar de abrir". Pula para a
  // próxima sozinho, com teto por vídeo para não varrer a lista inteira gastando resolves.
  const rejectedSkipsRef = useRef<{ videoId: string; count: number }>({ videoId: "", count: 0 });
  const skipRejectedSourceRef = useRef<(rejected: Stream, notice: string) => boolean>(() => false);
  // `selectStream` é estável de propósito (ver dependências); o contexto do registro de erros
  // lê daqui para não sair com o título/episódio anterior.
  const diagnosticIdsRef = useRef<{ mediaId: string; videoId: string }>({ mediaId: "", videoId: "" });
  const preparedProgressRef = useRef(new PlaybackPreparation<readonly SavedProgressItem[]>());
  const preparedSubtitlesRef = useRef(new PlaybackPreparation<void>());
  const startupTimingRef = useRef<{ key: string; timing: PlaybackStartupTiming } | null>(null);
  // Título editorial (TMDB) só casa com o add-on UMA vez. Refazer isso a cada busca de fontes
  // reescolhia o episódio salvo/da URL e desfazia o "próximo/anterior": o autoplay ficava
  // esperando um episódio que nunca voltava, com o carregamento girando para sempre.
  const editorialResolvedForRef = useRef<string | null>(null);
  const selectionOriginRef = useRef<"manual" | "requested" | "automatic">("automatic");
  // Legendas e o ID automático dependem de `subtitles`, que chega depois (busca própria, ver
  // abaixo). Guardá-los em ref, e não como dependência do efeito que monta o player, é o que
  // permite abrir sem esperar essa busca: o efeito lê o valor mais recente na hora de chamar
  // `load`, mas não reexecuta — logo não remonta — quando só a legenda muda.
  const subtitlesRef = useRef<readonly Subtitle[]>([]);
  const defaultSubtitleIdRef = useRef<string | null>(null);
  // Um `LateSubtitleGate` por player carregado: sabe quais legendas entraram no `load` daquela
  // instância para o efeito de aviso (abaixo) distinguir legenda tardia de legenda já conhecida.
  const subtitleGateRef = useRef<LateSubtitleGate | null>(null);
  // Camada 3 (sincronia por conteúdo, `subtitle-timing.ts`): dispara uma única vez por (vídeo,
  // fonte) — chave em `timingCheckedSourcesRef` — e nunca de novo para o mesmo par, mesmo que o
  // evento "pronto" do player dispare mais de uma vez (retomada, troca de faixa de áudio…).
  const timingCheckedSourcesRef = useRef<Set<string>>(new Set());
  // Veredito já confirmado por ID de legenda, válido pelo resto da SESSÃO (não por vídeo): o
  // conteúdo de uma legenda não muda se a pessoa trocar de fonte e voltar para a mesma depois.
  const timingVerdictsRef = useRef<Map<string, TimingVerdict>>(new Map());
  // Espelha `userSubtitleChoice` para o desfecho assíncrono da checagem (fetch de legenda pode
  // levar segundos): sem isto, uma escolha manual feita ENQUANTO os fetches ainda voam não seria
  // vista — o closure do `useCallback` só enxerga o valor de quando foi criado, não o atual.
  const userSubtitleChoiceRef = useRef<string | null>(null);
  const idiomaOriginalRef = useRef<string | null>(null);
  const timersFaixasNavegadorRef = useRef<number[]>([]);
  // `runSubtitleTimingCheck` só pode ser chamada de dentro do `nativo.on("ready", ...)` do efeito
  // que monta o player nativo — e aquele efeito NUNCA pode reexecutar por causa dela (mesma regra
  // de `handlePlaybackFailureRef` acima: entrar nas dependências dele destruiria/recriaria a
  // instância nativa em reprodução). O ref sempre aponta para a versão mais recente da função.
  const runSubtitleTimingCheckRef = useRef<
    (durationSeconds: number, platform: SubtitleTimingPlatform) => void
  >(() => {});
  const streamButtonRef = useRef<HTMLButtonElement>(null);
  const streamDialogRef = useRef<HTMLDivElement>(null);
  const playerSectionRef = useRef<HTMLElement>(null);
  const streamListOpenedFromQuery = useRef(false);
  const autoplayConsumed = useRef(false);
  const playbackCancelled = useRef(false);
  // "Última operação vence" para as duas cadeias assíncronas que decidem o que toca: a busca de
  // fontes (troca de episódio, "Consultar Orion", reabrir o popup) e a resolução de um torrent no
  // debrid (trocar de fonte enquanto outra ainda resolve). São duas instâncias porque são
  // independentes: cancelar uma resolução em andamento não pode calar a busca incremental de mais
  // fontes rodando ao fundo (Task 6), e vice-versa. Resposta tardia de qualquer uma das duas,
  // depois que `isCurrent()` vira falso, nunca chama `setState` de resultado. `useState` com
  // inicializador preguiçoso (nunca chamamos o setter) dá uma instância estável sem o ruído de
  // `.current` opcional que um `useRef` anulável exigiria em cada chamada.
  const [searchOperation] = useState(() => new LatestOperation());
  const [resolveOperation] = useState(() => new LatestOperation());
  useEffect(() => () => {
    searchOperation.cancel();
    resolveOperation.cancel();
  }, [searchOperation, resolveOperation]);
  const streamsVideoId = useRef("");
  const streamSearchIncomplete = useRef(false);

  const validQuery = requestedAddonId.length > 0 && mediaId.length > 0 && (type === "movie" || type === "series");

  useEffect(() => setDeviceCodecs(detectDeviceCodecs()), []);
  useEffect(() => setTauriRuntime(tauriPlayerDisponivel()), []);
  useEffect(() => {
    if (isLowEndDevice()) setLowEndDevice(true);
  }, []);

  // Quando o usuário oculta a UI para ver apenas o vídeo de fundo, qualquer movimento do mouse,
  // toque ou tecla restaura as descrições suavemente.
  useEffect(() => {
    if (!isUiHidden) return;
    const handleActivity = () => {
      setIsUiHidden(false);
    };
    window.addEventListener("mousemove", handleActivity, { passive: true });
    window.addEventListener("keydown", handleActivity, { passive: true });
    window.addEventListener("touchstart", handleActivity, { passive: true });
    return () => {
      window.removeEventListener("mousemove", handleActivity);
      window.removeEventListener("keydown", handleActivity);
      window.removeEventListener("touchstart", handleActivity);
    };
  }, [isUiHidden]);

  // Recado que não some vira parte do cenário e para de ser lido. Some sozinho em 8s; os que
  // exigem ação (sessão expirada, fonte ainda sendo preparada) usam outros canais.
  useEffect(() => {
    if (playerNotice === null) return;
    const timer = window.setTimeout(() => setPlayerNotice(null), 8_000);
    return () => window.clearTimeout(timer);
  }, [playerNotice]);
  useEffect(() => {
    if (!validQuery || type === null) {
      setViewState("error");
      return;
    }
    // Enquanto a nova obra carrega, nenhum estado da anterior pode permanecer acionável.
    setViewState("loading");
    setInitialEditorial(null);
    setMeta(null);
    editorialResolvedForRef.current = null;
    setVideoId("");
    setSelectedSeason(null);
    setStreams([]);
    streamsVideoId.current = "";
    setStreamState("idle");
    setIsSearchingMore(false);
    setSelectedStream(null);
    setUserSubtitleChoice(null);
    setPlayerNativo(null);
    setIsPlayerLoading(false);
    setPendingAutoplayVideoId(null);
    setSavedItems([]);
    setProgressLoaded(false);
    autoplayConsumed.current = false;
    streamListOpenedFromQuery.current = false;
    const controller = new AbortController();
    void (async () => {
      try {
        if (requestedAddonId === "editorial.tmdb") {
          const path = [type, mediaId].map(encodeURIComponent).join("/");
          const response = await apiFetch(`/v1/editorial/${path}`, {
            cache: "no-store", headers: { Accept: "application/json" }, signal: controller.signal
          });
          if (response.status === 401) { router.replace("/entrar"); return; }
          if (!response.ok) throw new Error("editorial unavailable");
          const details = await response.json() as unknown;
          if (!isEditorialTitle(details)) throw new Error("invalid editorial");
          setInitialEditorial(details);
          const placeholderId = details.imdbId ?? mediaId;
          setMeta({
            id: mediaId,
            type: details.type,
            name: details.title,
            poster: details.posterUrl,
            background: details.backdropUrl,
            logo: details.logoUrl,
            description: details.overview,
            releaseInfo: details.year ? String(details.year) : null,
            genres: details.genres,
            videos: details.type === "movie" ? [{
              id: placeholderId, title: details.title, season: null, episode: null,
              released: details.releaseDate, thumbnail: details.backdropUrl
            }] : []
          });
          setVideoId(placeholderId);
          setSelectedSeason(null);
          setViewState("ready");
          return;
        }
        const path = [requestedAddonId, type, mediaId].map(encodeURIComponent).join("/");
        const response = await apiFetch(`/v1/stremio/meta/${path}`, {
          cache: "no-store", headers: { Accept: "application/json" }, signal: controller.signal
        });
        if (response.status === 401) { router.replace("/entrar"); return; }
        if (!response.ok) throw new Error("meta unavailable");
        const body = await response.json() as unknown;
        if (!isMeta(body)) throw new Error("invalid meta");
        setMeta({ ...body, videos: orderedEpisodes(body.videos) });
        // Especiais usam temporada 0 e podem aparecer antes do episódio piloto no Cinemeta.
        // Sem um episódio explícito na URL, começa pela primeira temporada regular, como o
        // Stremio, em vez de selecionar automaticamente um especial futuro.
        const fallbackVideo = orderedEpisodes(body.videos).find((video) => video.season !== 0) ?? body.videos[0];
        const pedido = body.videos.find((video) => video.id === requestedVideoId);
        const requested = (pedido && requestedNext ? adjacentEpisode(body.videos, pedido.id, 1) : null) ?? pedido ?? fallbackVideo;
        setVideoId(requested?.id ?? body.id);
        setSelectedSeason(requested?.season ?? body.videos.find((video) => video.season !== null)?.season ?? null);
        setViewState("ready");
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setViewState("error");
          reportDiagnostic("META_LOAD_FAILED", error instanceof Error ? error.message : "erro desconhecido", {
            mediaId, type: type ?? "", addonId: requestedAddonId
          });
        }
      }
    })();
    return () => controller.abort();
  }, [mediaId, requestedAddonId, requestedNext, requestedVideoId, router, type, validQuery]);

  // O Stremio abre a página imediatamente. O enriquecimento vem em paralelo e nunca impede
  // reprodução: falha, ausência no TMDB ou indisponibilidade temporária mantêm os dados do addon.
  // O cache é o mesmo da home, então chegar aqui por um card já enriquecido não pede de novo.
  const editorialLookup = useMemo(() => meta ? {
    type: meta.type,
    mediaId: meta.id,
    title: meta.name,
    year: Number(meta.releaseInfo?.match(/\b(?:19|20)\d{2}\b/)?.[0]) || null
  } : null, [meta]);
  const enrichedEditorial = useEditorial(editorialLookup, true);
  // A rota editorial já devolve o objeto completo. Reutilizá-lo evita uma segunda fase visual
  // em que primeiro aparece o pôster e, só depois, logo/créditos/descrição.
  const editorial = initialEditorial ?? enrichedEditorial;
  const titleLogo = (!titleLogoError && (editorial?.logoUrl || meta?.logo)) || null;

  // Esta é a tela onde a pessoa parou para decidir, então o teaser é o principal e não um
  // enfeite de passagem: espera menos que na rail e ganha um controle de som de verdade.
  const webTrailers = useWebTrailers(tvLayout);
  const teaserId = webTrailers ? youtubeId(editorial?.trailerUrl) : null;
  // Nada de trailer por baixo do filme: com uma fonte escolhida, o player é o assunto. A lista
  // de fontes também cala o teaser — ela é um modal por cima desta mesma tela. Aparelho fraco
  // nunca entra no trailer: fica só o `heroBackdrop` (imagem), acima.
  const playTeaser = useDelayedFlag(
    teaserId !== null && selectedStream === null && !isStreamModalOpen && !lowEndDevice,
    900,
    teaserId ?? ""
  );

  const progressProfileRef = useRef(activeProfileId);
  progressProfileRef.current = activeProfileId;
  const progressTargetRef = useRef({ mediaId, mediaType: type ?? "movie", videoIds: [] as string[] });
  progressTargetRef.current = {
    mediaId, mediaType: type ?? "movie",
    videoIds: [...new Set([...(meta?.videos ?? []).map((video) => video.id), ...(videoId ? [videoId] : []),
      ...(type === "movie" && editorial?.imdbId ? [editorial.imdbId] : [])])]
  };
  const readTitleProgress = useCallback(() => fetchTitleProgress(progressTargetRef.current), []);

  // Carrega o progresso salvo do perfil. O módulo `../progress` é o único que fala com a API.
  useEffect(() => {
    if (!mediaId || type === null) return;
    let cancelled = false;
    setProgressLoaded(false);
    void readTitleProgress().then((items) => {
      if (cancelled) return;
      setSavedItems((current) => current.reduce((result, item) => mergeSavedProgress(result, item), items));
      setProgressLoaded(true);
    });
    return () => { cancelled = true; };
  }, [mediaId, type, meta, editorial?.imdbId, readTitleProgress]);

  // O que está salvo DESTA obra: os registros dela e os dos seus episódios que vieram por outro
  // caminho (mesmo `videoId`, `mediaId` diferente). Derivado — e não guardado no `loadProgress` —
  // porque a lista de episódios (`meta`) costuma chegar depois do progresso.
  const allSaved = useMemo(() => progressForTitle(savedItems, {
    mediaId,
    alternateMediaIds: new Set(type === "movie" && editorial?.imdbId ? [editorial.imdbId] : []),
    videoIds: new Set([...(meta?.videos ?? []).map((video) => video.id), ...(videoId ? [videoId] : []),
      ...(type === "movie" && editorial?.imdbId ? [editorial.imdbId] : [])])
  }), [mediaId, meta, savedItems, videoId, type, editorial?.imdbId]);

  // Progresso do vídeo/episódio selecionado atualmente. Num filme, o mesmo filme gravado por outro
  // caminho (título editorial: `tmdb:…` × `tt…`) também vale — a regra mora em `findSavedProgress`.
  const activeSaved = useMemo(() => type === null ? null : findSavedProgress(allSaved, {
    mediaType: type, mediaId, videoId,
    alternateIds: type === "movie" && editorial?.imdbId ? [editorial.imdbId] : []
  }), [allSaved, mediaId, type, videoId, editorial?.imdbId]);

  const deviceKeyRef = useRef<DeviceSourceKey | null>(null);
  deviceKeyRef.current = activeProfileId && type && videoId
    ? { profileId: activeProfileId, mediaType: type, mediaId, videoId } : null;
  const savedDeviceSource = readDeviceSource(deviceKeyRef.current);
  const deviceChoiceRef = useRef<PlaybackSource | null>(null);
  deviceChoiceRef.current = savedDeviceSource ? scenarioForStream(savedDeviceSource) : null;
  const deviceResumeAttemptRef = useRef<string | null>(null);
  const retryDeviceResumeRef = useRef<() => boolean>(() => false);

  const playerSourceOptions = useMemo(() => buildPlayerSourceOptions(streams.map((stream) => ({
    ...stream,
    addonName: playbackAddonLabel(stream)
  }))), [streams]);

  const hasProgress = Boolean(
    activeSaved && !activeSaved.completed && activeSaved.positionSeconds > 10
  );

  const seasons = useMemo(() => {
    if (!meta) return [];
    return [...new Set(meta.videos.flatMap((video) => video.season === null ? [] : [video.season]))].sort((a, b) => a - b);
  }, [meta]);

  const visibleEpisodes = useMemo(() => {
    if (!meta) return [];
    return orderedEpisodes(meta.videos).filter((video) => selectedSeason === null || video.season === selectedSeason);
  }, [meta, selectedSeason]);

  const displayNumber = useCallback((video: Video): number | null => {
    if (!meta) return video.episode;
    const genres = editorial?.genres ?? meta.genres ?? [];
    const isAnime = genres.some((genre) => /anime/i.test(genre)) ||
      (editorial?.originalLanguage === "ja" && genres.some((genre) => /animation|animação/i.test(genre)));
    return displayEpisodeNumber(video.id || meta.id, video.season, video.episode, meta.videos, isAnime);
  }, [meta, editorial]);

  // Add-on que busca por nome devolve outra série ("Normal People" para "Os Normais") ou outro
  // episódio do pacote. A escolha automática só considera fontes que não são declaradamente de
  // outro título/episódio (ver `source-match.ts`); a lista manual mostra o aviso.
  const matchTarget = useMemo((): SourceMatchTarget | null => {
    if (!meta || type === null) return null;
    const video = meta.videos.find((item) => item.id === videoId) ?? null;
    const genres = editorial?.genres ?? meta.genres ?? [];
    const isAnime = genres.some((genre) => /anime/i.test(genre)) ||
      (editorial?.originalLanguage === "ja" && genres.some((genre) => /animation|animação/i.test(genre)));
    return {
      type,
      titles: [meta.name, editorial?.title, editorial?.originalTitle],
      year: editorial?.year ?? (Number.parseInt(meta.releaseInfo ?? "", 10) || null),
      season: video?.season ?? null,
      episode: video?.episode ?? null,
      checkTitle: !isAnime,
      runtimeMinutes: editorial?.runtimeMinutes ?? null,
      homeReleaseDate: editorial?.homeReleaseDate ?? null
    };
  }, [editorial, meta, type, videoId]);
  const matchTargetRef = useRef(matchTarget);
  matchTargetRef.current = matchTarget;
  // Lê pelo ref: os efeitos de autoplay e de falha não podem reexecutar só porque o alvo mudou.
  const forThisVideo = useCallback((list: readonly Stream[]): readonly Stream[] => {
    const target = matchTargetRef.current;
    return target ? list.filter((stream) => sourceMatch(stream, target).verdict !== "mismatch") : list;
  }, []);
  const mismatchReason = (stream: Stream): string | null =>
    matchTarget ? sourceMatch(stream, matchTarget).reason ?? null : null;
  // A fonte lembrada no aparelho passa pela mesma conferência: uma lembrada antes dela existir
  // (ex.: um trailer) é esquecida, e a busca normal segue.
  const rememberedDeviceSource = useCallback(() => {
    const remembered = readDeviceSource(deviceKeyRef.current);
    if (remembered && forThisVideo([remembered]).length === 0) {
      forgetDeviceSource(deviceKeyRef.current);
      return null;
    }
    return remembered;
  }, [forThisVideo]);

  const selectEpisode = useCallback(async (id: string) => {
    // Troca de episódio invalida qualquer busca/resolução do episódio anterior ainda em voo: sem
    // isto, um lote tardio de `findStreams` do episódio antigo poderia publicar fontes erradas
    // sobre o estado do novo episódio.
    searchOperation.cancel();
    resolveOperation.cancel();
    const selectionVersion = ++episodeSelectionVersionRef.current;
    // Trocar de episódio DENTRO de uma sessão ativa (próximo/anterior, lista de episódios — no
    // player ou na grade da página) herda o lançamento, o idioma de áudio/legenda e os ajustes do
    // episódio que está sendo deixado — em qualquer direção. Sem player aberto (`selectedStream`
    // nulo: "Continuar" na Home, card clicado com o player fechado) não há episódio sendo
    // deixado, e o novo episódio usa só o próprio cenário salvo, como sempre.
    if (selectedStream && meta?.type === "series") {
      const sourcePlayer = playerNativo?.state().loaded
        ? playerNativo : player.current ? browserPlayer.current : null;
      let leavingSubtitle: EpisodeContinuitySeed["subtitle"] = null;
      let leavingAudio = scenarioRef.current?.audio?.language ?? null;
      if (sourcePlayer) {
        try {
          const [subtitleResult, audioResult] = await Promise.allSettled([
            sourcePlayer.subtitleTracks(), sourcePlayer.audioTracks()
          ]);
          if (selectionVersion !== episodeSelectionVersionRef.current) return;
          if (audioResult.status === "fulfilled") {
            leavingAudio = audioContinuityFromTracks(audioResult.value, sourcePlayer.state().audioTrackId,
              scenarioRef.current?.audio);
          }
          if (subtitleResult.status === "rejected") throw subtitleResult.reason;
          const tracks = subtitleResult.value;
          const selectedId = sourcePlayer.state().subtitleTrackId;
          leavingSubtitle = subtitleContinuityFromTracks(tracks, selectedId, scenarioRef.current?.subtitle,
            userSubtitleChoiceRef.current === "off" || scenarioRef.current?.subtitle === null);
          if (leavingSubtitle && leavingSubtitle !== "off") {
            const external = subtitlesRef.current.find((subtitle) =>
              subtitle.id === selectedId || `external:${subtitle.id}` === selectedId);
            leavingSubtitle = {
              ...leavingSubtitle,
              details: external?.details ?? null,
              origin: external ? "external" : "embedded"
            };
          }
        } catch { /* a escolha salva abaixo ainda pode servir como fallback */ }
      }
      if (leavingSubtitle === null && scenarioRef.current && "subtitle" in scenarioRef.current) {
        const saved = scenarioRef.current.subtitle;
        leavingSubtitle = saved ? (saved.language ? {
          language: saved.language,
          origin: subtitlesRef.current.some((subtitle) =>
            subtitle.id === saved.id || `external:${subtitle.id}` === saved.id) ? "external" : "embedded"
        } : null) : "off";
      }
      if (leavingSubtitle === null) {
        leavingSubtitle = activeContinuity(previousEpisodeContinuityRef.current, meta.id)?.subtitle ?? null;
      }
      if (leavingSubtitle === null && defaultSubtitleIdRef.current) {
        const automatic = subtitlesRef.current.find((subtitle) => subtitle.id === defaultSubtitleIdRef.current);
        if (automatic) leavingSubtitle = { language: automatic.language, details: automatic.details ?? null, origin: "external" };
      }
      if (selectionVersion !== episodeSelectionVersionRef.current) return;
      previousEpisodeContinuityRef.current = {
        seriesId: meta.id,
        source: scenarioForStream(selectedStream),
        audioLanguage: leavingAudio,
        subtitle: leavingSubtitle,
        subtitleSettings: scenarioRef.current?.subtitleSettings ?? null
      };
    }
    const next = meta?.videos.find((video) => video.id === id);
    if (next?.season !== null && next?.season !== undefined) setSelectedSeason(next.season);
    setVideoId(id);
    setStreams([]);
    streamsVideoId.current = "";
    setStreamState("idle");
    setIsSearchingMore(false);
    setSelectedStream(null);
    setUserSubtitleChoice(null);
    userSubtitleChoiceRef.current = null;
    setOrionConsulted(false);
    // Cada vídeo tem seu próprio cenário salvo; sem isto, o autoplay do próximo episódio
    // reaproveitaria a fonte/trilhas do episódio anterior em vez de semear as dele. A retomada
    // salva do episódio NOVO continua tendo prioridade sobre a continuidade quando a sessão foi
    // aberta do zero — só dentro de uma sessão ativa é que a continuidade vence (ver acima e
    // `chooseAutoplayStream`/`defaultSubtitleId`).
    scenarioRef.current = null;
  }, [meta, playerNativo, searchOperation, resolveOperation, selectedStream]);

  // Volta do segundo plano com o player fechado: relê o progresso (retomada e marcas de
  // assistido). Se OUTRO aparelho gravou esta obra depois da última leitura daqui, a página segue
  // para o episódio que a regra de sempre escolhe — senão um play aqui regravava o episódio antigo
  // por cima do mais novo. As gravações dos vídeos que esta página tocou são dela mesma e não
  // contam: sem gravação de fora, a escolha feita nesta tela fica como está.
  const playerBusyRef = useRef(false);
  playerBusyRef.current = selectedStream !== null || resolvingStreamId !== null;
  const playedHereRef = useRef(new Set<string>());
  useReturnToForeground(() => {
    if (playerBusyRef.current || !progressLoaded || !meta) return;
    const version = episodeSelectionVersionRef.current;
    const before = latestUpdate(allSaved);
    const videoIds = new Set(meta.videos.map((video) => video.id));
    const playedHere = new Set(playedHereRef.current);
    void readTitleProgress().then((items) => {
      // Lista vazia é como o módulo de progresso representa falha de leitura: mantém a tela.
      if (items.length === 0 || playerBusyRef.current || version !== episodeSelectionVersionRef.current) return;
      setSavedItems(items);
      for (const id of playedHere) playedHereRef.current.delete(id);
      if (meta.type !== "series") return;
      const fresh = progressForTitle(items, { mediaId, videoIds });
      if (!fresh.some((item) => updatedAtOf(item) > before && !playedHere.has(item.videoId))) return;
      const preferred = preferredPlaybackVideo(meta.videos, fresh);
      if (preferred && preferred.id !== videoId) void selectEpisode(preferred.id);
    });
  });

  const progressPercent = useMemo(() => {
    if (!activeSaved || !activeSaved.durationSeconds || activeSaved.durationSeconds <= 0) return 0;
    return Math.min(100, Math.max(1, Math.round((activeSaved.positionSeconds / activeSaved.durationSeconds) * 100)));
  }, [activeSaved]);

  useEffect(() => {
    if (!videoId || type === null) {
      setSubtitleState("idle");
      return;
    }
    setSubtitles([]);
    setSubtitleState("loading");
    const controller = new AbortController();
    const path = [type, videoId].map(encodeURIComponent).join("/");
    void apiFetch(`/v1/stremio/subtitles/${path}`, {
      cache: "no-store", headers: { Accept: "application/json" }, signal: controller.signal
    }).then(async (response) => {
      if (!response.ok) return;
      const body = await response.json() as { subtitles?: unknown };
      const parsed = parseSubtitleList(body.subtitles);
      if (!controller.signal.aborted) setSubtitles(orderSubtitleCandidates(parsed));
    }).catch(() => undefined).finally(() => {
      if (!controller.signal.aborted) setSubtitleState("ready");
    });
    return () => controller.abort();
  }, [type, videoId]);

  useEffect(() => { typeRef.current = type; }, [type]);

  // Player do navegador em uso (Vidstack) — condição única do ramo de render e das legendas
  // embutidas abaixo. `tvLayout` limita as embutidas à TV, onde o Vidstack não enxerga as faixas
  // do MKV; PC/celular/Android/Tauri têm player próprio que já as lê.
  const avplayEmUso = tizenPlayerDisponivel() && !(selectedStream !== null && avplayRecusou === selectedStream.id);
  const browserPlayerAtivo = !playerNativo && !tauriRuntime && !nativePlayerDisponivel() && !avplayEmUso;
  const embeddedSubtitlesUrl = browserPlayerAtivo && tvLayout && !selectedStream?.localSessionId ? selectedStream?.url ?? null : null;

  // Legendas embutidas no MKV (só TV com player do navegador): a API abre o arquivo remoto, lista
  // as faixas e já começa a extrair as PT em segundo plano. Ao trocar de fonte as da fonte antiga
  // saem NA HORA (antes da resposta nova), senão a lista mostraria faixas de outro arquivo.
  useEffect(() => {
    setSubtitles((current) => current.some((subtitle) => subtitle.id.startsWith("embedded:"))
      ? current.filter((subtitle) => !subtitle.id.startsWith("embedded:"))
      : current);
    if (embeddedSubtitlesUrl === null) return;
    const controller = new AbortController();
    void apiFetch("/v1/stremio/subtitles/embedded", {
      method: "POST", cache: "no-store", signal: controller.signal,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ url: embeddedSubtitlesUrl })
    }).then(async (response) => {
      if (!response.ok) return;
      const body = await response.json() as { subtitles?: unknown };
      const incoming = normalizeEmbeddedSubtitles(parseSubtitleList(body.subtitles));
      if (incoming.length === 0 || controller.signal.aborted) return;
      setSubtitles((current) => orderSubtitleCandidates([
        ...current.filter((subtitle) => !subtitle.id.startsWith("embedded:")), ...incoming
      ]));
    }).catch(() => undefined);
    return () => controller.abort();
  }, [embeddedSubtitlesUrl]);

  // Refinamento por ARQUIVO: com a fonte concreta escolhida (nome/tamanho/hash devolvidos pela
  // resolução do Real-Debrid, ou behaviorHints de uma fonte direta), refaz a busca de legenda
  // com esses dados — só assim o OpenSubtitles casa pelo HASH do arquivo e a SubDL pelo nome do
  // release. É ESPERADO antes de abrir o player (com teto): chegando depois, a legenda exata não
  // entrava no PC (sem legenda tardia) e, nos demais, só valia se nenhuma estivesse ligada.
  // O resultado é MESCLADO (mesmo id = addon+url substitui a entrada com o dado novo).
  const refineSubtitlesForFile = useCallback(async (
    target: { videoId: string; hash?: string; size?: number; filename?: string },
    isCurrent: () => boolean
  ): Promise<void> => {
    const currentType = typeRef.current;
    if (currentType === null || (!target.hash && !target.size && !target.filename)) return;
    const query = new URLSearchParams();
    if (target.hash) query.set("videoHash", target.hash);
    if (target.size) query.set("videoSize", String(target.size));
    if (target.filename) query.set("filename", target.filename);
    const path = [currentType, target.videoId].map(encodeURIComponent).join("/");
    const refine = apiFetch(`/v1/stremio/subtitles/${path}?${query}`, {
      cache: "no-store", headers: { Accept: "application/json" }
    }).then(async (response) => {
      if (!response.ok) return;
      const body = await response.json() as { subtitles?: unknown };
      const incoming = parseSubtitleList(body.subtitles);
      if (incoming.length === 0 || playbackCancelled.current || !isCurrent() || diagnosticIdsRef.current.videoId !== target.videoId) return;
      const byId = new Map(subtitlesRef.current.map((subtitle) => [subtitle.id, subtitle] as const));
      for (const subtitle of incoming) byId.set(subtitle.id, subtitle);
      const merged = orderSubtitleCandidates([...byId.values()]);
      // A preparação nativa pode terminar antes do próximo render. Publica o snapshot usado
      // pelo load junto da lista, para não abrir com a legenda anterior por uma corrida do React.
      subtitlesRef.current = merged;
      defaultSubtitleIdRef.current = legendaNaAbertura(merged, {
        continuidade: activeContinuity(previousEpisodeContinuityRef.current, metaIdRef.current),
        salvo: activeSavedRef.current?.playbackScenario ?? null
      }, target.filename ?? null);
      setSubtitles(merged);
    }).catch(() => undefined);
    await Promise.race([refine, new Promise<void>((resolve) => window.setTimeout(resolve, SUBTITLE_REFINE_WAIT_MS))]);
  }, []);

  // Nome do release usado para RANQUEAR legendas (pontuação por token/grupo): o nome REAL do
  // arquivo quando ele existe (behaviorHints do add-on, ou o que o Real-Debrid devolveu ao
  // resolver) — só cai para o `label` (texto livre do add-on) quando nenhum dos dois está
  // disponível ainda.
  const releaseLabel = selectedStream?.filename ?? selectedStream?.label ?? null;

  // Ordem de prioridade da legenda automática: (1) dentro de uma sessão ativa, a do episódio que
  // está sendo deixado — desligada de propósito continua desligada, e com idioma tenta a mesma
  // fonte/release (`details`) antes de cair na melhor por idioma; (2) a legenda salva deste
  // vídeo — inclusive "nenhuma", quando o cenário guarda `subtitle: null` explicitamente; (3) a
  // escolha automática de sempre, tentando bater com o release da fonte selecionada.
  const defaultSubtitleId = useMemo(() => {
    const continuity = activeContinuity(previousEpisodeContinuityRef.current, metaIdRef.current);
    return legendaNaAbertura(subtitles, { continuidade: continuity, salvo: activeSaved?.playbackScenario ?? null }, releaseLabel);
  }, [activeSaved, subtitles, releaseLabel, videoId]);

  // Mantém os refs acima em dia sem entrar nas dependências do efeito que monta o player — só
  // isto roda quando a busca de legenda termina, nunca um `destroy`/`load`.
  useEffect(() => { subtitlesRef.current = subtitles; }, [subtitles]);
  useEffect(() => { defaultSubtitleIdRef.current = defaultSubtitleId; }, [defaultSubtitleId]);
  useEffect(() => { metaIdRef.current = meta?.id; }, [meta]);
  // Fonte trocada ou player fechado: cancela as novas tentativas de faixas do navegador.
  useEffect(() => () => {
    timersFaixasNavegadorRef.current.splice(0).forEach((timer) => window.clearTimeout(timer));
    refreshBrowserTracksRef.current = null;
  }, [selectedStream?.id, videoId]);
  useEffect(() => { idiomaOriginalRef.current = editorial?.originalLanguage ?? null; }, [editorial?.originalLanguage]);
  useEffect(() => { progressTitleRef.current = { meta, addonId }; }, [meta, addonId]);
  useEffect(() => { activeSavedRef.current = activeSaved; }, [activeSaved]);
  useEffect(() => { diagnosticIdsRef.current = { mediaId, videoId }; }, [mediaId, videoId]);
  useEffect(() => { userSubtitleChoiceRef.current = userSubtitleChoice; }, [userSubtitleChoice]);

  // Trocar de TÍTULO (não só de episódio) nunca herda nada do título anterior — mesmo que a
  // mesma instância desta página seja reaproveitada (só a query `id` muda, sem remontar). A
  // guarda por `seriesId` em `activeContinuity` já impede o vazamento entre títulos; isto some
  // com a semente de vez, para uma reabertura não carregar um ref obsoleto desnecessariamente.
  useEffect(() => {
    episodeSelectionVersionRef.current += 1;
    previousEpisodeContinuityRef.current = null;
  }, [mediaId]);

  // Legendas podem chegar depois do vídeo. O Android registra essas opções no player em curso,
  // sem perder a posição; adaptadores sem essa capacidade ainda pedem para reabrir.
  useEffect(() => {
    if (playerNativo === null) return;
    const gate = subtitleGateRef.current;
    if (!gate?.hasLateSubtitles(subtitles)) return;
    if (!playerNativo.addExternalSubtitles) {
      setPlayerNotice("Novas legendas ficaram disponíveis. Feche e abra o vídeo de novo para usá-las.");
      return;
    }
    void playerNativo.addExternalSubtitles(rankSubtitleCandidates(subtitles, releaseLabel).map((subtitle) => ({
      id: subtitle.id,
      label: `${subtitle.label}${subtitle.details ? ` · ${subtitle.details}` : ""} · ${subtitle.addonName}`,
      language: subtitle.language,
      url: subtitle.url
    })), defaultSubtitleId).then(() => gate.markLoaded(subtitles)).catch(() => {
      setPlayerNotice("Não foi possível carregar a legenda. Tente selecioná-la no menu de áudio e legendas.");
    });
  }, [defaultSubtitleId, playerNativo, releaseLabel, subtitles]);

  // Ajustes de legenda (cor, tamanho, offset…): dentro de uma sessão ativa, os do episódio que
  // está sendo deixado têm prioridade (a pessoa acabou de ajustar de propósito); senão os do
  // cenário salvo deste vídeo; sem nenhum dos dois, sincronia 0 e a aparência guardada no aparelho.
  useEffect(() => {
    if (!progressLoaded) return;
    const continuity = activeContinuity(previousEpisodeContinuityRef.current, metaIdRef.current);
    // Sincronia é do vídeo (continuidade ou cenário); sem nenhum, 0. Aparência/altura: do aparelho.
    setSubtitleSettings(ajustesIniciais({
      continuidade: continuity?.subtitleSettings ?? null,
      salvo: activeSaved?.playbackScenario?.subtitleSettings ?? null,
      aparelho: ajustesDoAparelho()
    }));
  }, [activeSaved, progressLoaded, videoId]);

  const testNextSubtitle = useCallback(() => {
    const instance = player.current;
    if (!instance) return;
    const activeId = instance.textTracks.selected?.id ?? null;
    const nextId = nextSubtitleId(subtitles, activeId, releaseLabel);
    if (nextId === null) return;
    const next = nextId === null ? null : instance.textTracks.getById(nextId);
    if (!next) return;
    for (const track of instance.textTracks) track.setMode(track.id === next.id ? "showing" : "disabled");
    setSubtitleSettings((prev) => ({ ...prev, offset: 0 }));
    setPlayerNotice(`Testando ${next.label}. Se não combinar com esta fonte, teste a próxima.`);
  }, [subtitles, releaseLabel]);

  // Entrada única da regra de faixas (`regras/faixas.ts`): só lê refs, então o efeito do player
  // pode chamá-la a qualquer momento sem entrar nas dependências.
  const entradaDasFaixas = useCallback((): EntradaFaixas => {
    const continuidade = activeContinuity(previousEpisodeContinuityRef.current, metaIdRef.current);
    return {
      escolhaDaPessoa: userSubtitleChoiceRef.current,
      continuidade: continuidade ? { audioLanguage: continuidade.audioLanguage, subtitle: continuidade.subtitle } : null,
      // O cenário DA SESSÃO (inclui o que a pessoa escolheu agora), não só o salvo no load: uma
      // reabertura do motor (PC: GStreamer -> mpv dá um novo `ready`) não volta ao que estava salvo antes.
      salvo: scenarioRef.current ?? activeSavedRef.current?.playbackScenario ?? null,
      idiomaOriginal: idiomaOriginalRef.current,
      idsExternos: new Set(subtitlesRef.current.flatMap((s) => [s.id, `external:${s.id}`])),
      legendaPreferidaExterna: defaultSubtitleIdRef.current
    };
  }, []);

  /**
   * Camada 3 da sincronia de legenda: depois que o player informa a duração REAL do vídeo,
   * confere se a legenda escolhida automaticamente (nunca uma manual nem herdada por continuidade
   * — ver as guardas abaixo) realmente cobre o arquivo, e não só se ela "parece" a certa pelo
   * nome/hash (isso já é feito por `subtitle-selection.ts`, antes de qualquer uma tocar).
   *
   * Roda uma vez só por (vídeo, fonte) — nunca reavalia a mesma dupla, mesmo que "pronto" dispare
   * de novo — e nunca troca nada se a pessoa mexeu na legenda ou se o player já mudou de estado
   * enquanto os fetches (até 5, em paralelo, 4 s cada) ainda estavam voando.
   */
  const runSubtitleTimingCheck = useCallback((
    durationSeconds: number,
    platform: SubtitleTimingPlatform
  ): void => {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return;
    const stream = selectedStream;
    if (!stream || userSubtitleChoiceRef.current !== null) return;
    const sourceKey = `${videoId}\u0000${stream.id}`;
    if (timingCheckedSourcesRef.current.has(sourceKey)) return;
    // Nunca mexe numa legenda herdada da continuidade entre episódios nem numa salva no cenário
    // deste vídeo (escolha anterior, própria ou de uma checagem passada) — só a automática "pura".
    const continuity = activeContinuity(previousEpisodeContinuityRef.current, metaIdRef.current);
    if (continuity?.subtitle) return;
    const scenario = activeSaved?.playbackScenario;
    if (scenario && "subtitle" in scenario) return;
    const activeId = platform.getActiveId();
    if (activeId === null || activeId !== defaultSubtitleIdRef.current) return;
    const currentSubtitles = subtitlesRef.current;
    const active = currentSubtitles.find((subtitle) => subtitle.id === activeId);
    // Hash já é sincronia confirmada pelo OpenSubtitles — nada a verificar de novo pelo conteúdo.
    if (!active || active.hashMatch === true) return;

    timingCheckedSourcesRef.current.add(sourceKey);

    // "Mesmo idioma" aqui é a família PT-BR/PT tratada como uma só pelo resto do arquivo (ver
    // `nextSubtitleId`): a pessoa não perde a chance de uma PT bater só porque a automática era
    // PT-BR, e vice-versa. `rankSubtitleCandidates` rankeia PT-BR e PT SEPARADAMENTE e concatena
    // na mesma ordem — dá exatamente o ciclo de "testar próxima", sem duplicar a lógica aqui.
    const family = currentSubtitles.filter((subtitle) => {
      const language = normalizedTrackLanguage({ language: subtitle.language, label: subtitle.label });
      return language === "pt-BR" || language === "pt";
    });
    const rankedFamily = rankSubtitleCandidates(family, releaseLabel, timingVerdictsRef.current);
    const activeIndex = rankedFamily.findIndex((subtitle) => subtitle.id === activeId);
    const toCheck = activeIndex >= 0
      ? [rankedFamily[activeIndex]!, ...rankedFamily.slice(activeIndex + 1, activeIndex + 5)]
      : [active];

    void (async () => {
      const outcomes = await Promise.all(toCheck.map(async (subtitle) => {
        const cached = timingVerdictsRef.current.get(subtitle.id);
        if (cached !== undefined) return { subtitle, verdict: cached as TimingVerdict | null, score: 0 };
        const text = await fetchSubtitleText(subtitle.url);
        if (text === null) return { subtitle, verdict: null as TimingVerdict | null, score: 0 };
        const fit = timingFit(vttCueTimes(text), durationSeconds);
        timingVerdictsRef.current.set(subtitle.id, fit.verdict);
        return { subtitle, verdict: fit.verdict as TimingVerdict | null, score: fit.score };
      }));

      // Aborta a APLICAÇÃO (o veredito já apurado continua salvo em cache) se a pessoa trocou de
      // legenda manualmente ou se o player já não está mais na mesma legenda de quando começamos
      // — troca de fonte, "testar próxima" pelo teclado etc. — enquanto os fetches voavam.
      if (userSubtitleChoiceRef.current !== null || platform.getActiveId() !== activeId) return;

      const activeOutcome = outcomes.find((outcome) => outcome.subtitle.id === activeId);
      if (activeOutcome?.verdict === "ok") return;

      const okCandidates = outcomes.filter((outcome) => outcome.subtitle.id !== activeId && outcome.verdict === "ok");
      if (okCandidates.length === 0) {
        reportDiagnostic("SUBTITLE_TIMING_UNSURE", "nenhuma candidata confirmou sincronia com o arquivo", {
          ...diagnosticIdsRef.current, from: activeId, verdict: activeOutcome?.verdict ?? "sem-resposta"
        });
        return;
      }
      // Menor `score` (mais perto do fim plausível) vence; `sort` é estável, então um empate cai
      // de volta na ordem de rank (hash > release > chegada) que `toCheck` já trazia.
      okCandidates.sort((left, right) => left.score - right.score);
      const winner = okCandidates[0]!.subtitle;
      platform.apply(winner.id);
      setPlayerNotice("Legenda trocada por uma que bate com este arquivo.");
      reportDiagnostic("SUBTITLE_TIMING_SWITCH", `${activeId} não bateu com a duração do arquivo`, {
        ...diagnosticIdsRef.current, from: activeId, to: winner.id, verdict: activeOutcome?.verdict ?? "sem-resposta"
      });
    })();
  }, [activeSaved, releaseLabel, selectedStream, videoId]);

  // O efeito que monta o player nativo (abaixo) NUNCA pode reexecutar por causa desta função —
  // mesma regra de `handlePlaybackFailureRef` — então ele lê sempre a versão mais recente daqui.
  useEffect(() => { runSubtitleTimingCheckRef.current = runSubtitleTimingCheck; }, [runSubtitleTimingCheck]);

  // Embutida PT chegando DEPOIS de uma externa já ligada automaticamente: troca para ela (é do
  // próprio arquivo, sincronia certa). `activateDefaultSubtitle` só liga quando nada está
  // selecionado, então este é o único caminho para a troca. Só vale para a legenda automática
  // "pura": nunca mexe em escolha da pessoa, cenário salvo nem continuidade de episódio.
  const autoSubtitleHistoryRef = useRef<{ current: string | null; previous: string | null }>({ current: null, previous: null });
  useEffect(() => {
    const history = autoSubtitleHistoryRef.current;
    if (history.current !== defaultSubtitleId) {
      history.previous = history.current;
      history.current = defaultSubtitleId;
    }
    const target = defaultSubtitleId;
    if (!embeddedSubtitlesUrl || !target?.startsWith("embedded:") || history.previous === null) return;
    if (userSubtitleChoice !== null) return;
    // Continuidade de episódio NÃO bloqueia: `defaultSubtitleId` nesse caso só escolhe dentro do
    // idioma herdado, então a troca mantém o idioma e só ganha a faixa do próprio arquivo.
    if (activeSaved?.playbackScenario && "subtitle" in activeSaved.playbackScenario) return;
    const tracks = player.current?.textTracks;
    if (!tracks) return;
    // As faixas do Vidstack podem aparecer depois do estado: tenta agora e a cada "add".
    const trySwap = () => {
      const selected = tracks.selected;
      if (!selected || selected.id === target || selected.id !== history.previous) return;
      const next = Array.from(tracks).find((track) => track?.id === target);
      if (!next) return;
      selected.setMode("disabled");
      next.setMode("showing");
      history.previous = null;
    };
    trySwap();
    return watchBrowserSubtitleChanges(tracks, trySwap);
  }, [activeSaved, defaultSubtitleId, embeddedSubtitlesUrl, meta?.id, userSubtitleChoice]);

  const selectedVideo = useMemo(() => {
    if (!meta) return null;
    // Filme sem lista de vídeos (Cinemeta): o vídeo é o `videoId` em uso (no título editorial, o
    // `tt…` do IMDb), nunca o `tmdb:…` da obra — senão o progresso era gravado com um ID e
    // procurado com outro, e a retomada (posição, fonte, áudio, legenda) nunca era achada. A
    // regra de qual ID vale é do módulo de progresso, a mesma que ele usa para gravar e ler.
    return meta.videos.find((v) => v.id === videoId) ?? meta.videos[0] ?? {
      id: progressVideoId({ mediaType: meta.type, mediaId: meta.id, videoId }),
      title: meta.name, season: null, episode: null, released: null
    };
  }, [meta, videoId]);

  const previousEpisode = useMemo(() => {
    if (!meta || meta.type !== "series" || !selectedVideo) return null;
    return adjacentEpisode(meta.videos, selectedVideo.id, -1);
  }, [meta, selectedVideo]);

  const nextEpisode = useMemo(() => {
    if (!meta || meta.type !== "series" || !selectedVideo) return null;
    return adjacentEpisode(meta.videos, selectedVideo.id, 1);
  }, [meta, selectedVideo]);

  // Envia também quando o catálogo já usa numeração absoluta (ex.: One Piece 1082).
  // Igualdade com video.episode não significa que o ARM tenha uma temporada: sem `absolute`,
  // o mapeamento único do One Piece devolve vazio. Mapeamentos por temporada ignoram o parâmetro.
  const skipTimesAbsoluteEpisode = useMemo(() => {
    if (!selectedVideo) return null;
    return displayNumber(selectedVideo);
  }, [displayNumber, selectedVideo]);

  const tracksPrepared = tracksPreparedFor(preparedTracks, videoId, selectedStream?.id ?? null,
    playerNativo ?? browserPlayer.current);
  const skipBlocks = useBlocosDePulo({
    tipo: type, videoId, ehSerie: meta?.type === "series", episodioAbsoluto: skipTimesAbsoluteEpisode, playerNativo: playerNativo ?? browserPlayer.current, fonteId: selectedStream?.id ?? null,
    faixasProntas: tracksPrepared,
    legendasExternas: () => subtitlesRef.current, buscarTextoDaLegenda: fetchSubtitleText, idsDoDiagnostico: () => diagnosticIdsRef.current
  });

  const findStreams = useCallback(async (includeOrion = false) => {
    if (!videoId || type === null) return;
    const operation = searchOperation.start();
    streamSearchIncomplete.current = true;
    setStreamState("loading");
    setIsSearchingMore(true);
    setSourceNotice(null);
    if (includeOrion) setOrionConsulted(true);
    try {
      let targetVideoId = videoId;
      if (addonId === "editorial.tmdb" && editorialResolvedForRef.current !== mediaId) {
        if (!editorial) throw new Error("editorial unavailable");
        // A busca em todos os add-ons é a parte lenta de abrir um título editorial. O casamento
        // TMDB → add-on não muda, então fica lembrado neste aparelho e as próximas aberturas
        // vão direto ao meta. Se o meta lembrado falhar, esquece e volta a buscar da próxima vez.
        const matchKey = `cebola.editorialMatch.${type}.${mediaId}`;
        const lembrado = readEditorialMatch(matchKey, type);
        const match = lembrado ?? await (async () => {
          const responses = await Promise.allSettled(editorialSearchQueries(editorial).map(async (query) => {
            const response = await apiFetch(`/v1/stremio/search?q=${encodeURIComponent(query)}`, {
              cache: "no-store", headers: { Accept: "application/json" },
              signal: AbortSignal.any([operation.signal, AbortSignal.timeout(10_000)])
            });
            if (!response.ok) throw new Error("search unavailable");
            return response.json() as Promise<{ items?: unknown }>;
          }));
          const candidates = settledEditorialCandidates(responses).filter((item) => item.type === type);
          return matchEditorialCandidate(candidates, editorial);
        })();
        if (!operation.isCurrent()) return;
        if (!match) {
          setSourceNotice("Não encontramos uma correspondência exata nas suas fontes. Tente pesquisar este título.");
          setStreamState("empty");
          return;
        }
        const metaPath = [match.addonId, type, match.id].map(encodeURIComponent).join("/");
        const metaResponse = await apiFetch(`/v1/stremio/meta/${metaPath}`, {
          cache: "no-store", headers: { Accept: "application/json" },
          signal: AbortSignal.any([operation.signal, AbortSignal.timeout(10_000)])
        });
        if (!metaResponse.ok) {
          if (lembrado) forgetEditorialMatch(matchKey);
          throw new Error("meta unavailable");
        }
        const resolvedMeta = await metaResponse.json() as unknown;
        if (!isMeta(resolvedMeta)) throw new Error("invalid meta");
        if (!operation.isCurrent()) return;
        if (!lembrado) rememberEditorialMatch(matchKey, match);
        editorialResolvedForRef.current = mediaId;
        const preferredVideo = preferredPlaybackVideo(resolvedMeta.videos, allSaved, requestedVideoId, requestedNext);
        targetVideoId = preferredVideo?.id ?? resolvedMeta.id;
        // `mediaId` da URL continua sendo a identidade canônica do progresso e da biblioteca;
        // os metadados resolvidos só acrescentam episódios e identificadores de reprodução.
        // A apresentação editorial (arte, logo, texto) já está na tela e continua: trocar pela do
        // add-on fazia a página "piscar" para outra imagem no meio do carregamento.
        setMeta((current) => ({
          ...resolvedMeta,
          id: mediaId,
          videos: orderedEpisodes(resolvedMeta.videos),
          name: current?.name || resolvedMeta.name,
          poster: current?.poster ?? resolvedMeta.poster,
          background: current?.background ?? resolvedMeta.background,
          logo: current?.logo ?? resolvedMeta.logo,
          description: current?.description || resolvedMeta.description
        }));
        setVideoId(targetVideoId);
        // "Assistir" apertado antes do casamento pediu o id provisório; sem seguir para o episódio
        // resolvido, o autoplay esperava um id que não volta mais e só o prazo de 45 s encerrava,
        // com "A busca demorou demais" no lugar da resposta real da busca.
        setPendingAutoplayVideoId((pending) => pending === videoId ? targetVideoId : pending);
        setSelectedSeason(preferredVideo?.season ?? null);
      }
      const path = [type, targetVideoId].map(encodeURIComponent).join("/");
      // Fontes independentes: o servidor e a descoberta de alvos do navegador rodam em paralelo e
      // cada uma publica seu lote assim que fica pronta (ver `discoverStreams`). Um add-on lento
      // no navegador nunca segura o resultado do servidor, que normalmente já chegou.
      const serverStreams = (async (): Promise<readonly Stream[]> => {
        const response = await apiFetch(`/v1/stremio/streams/${path}`, {
          cache: "no-store", headers: { Accept: "application/json" },
          signal: AbortSignal.any([operation.signal, AbortSignal.timeout(15_000)])
        });
        if (!response.ok) throw new Error("streams unavailable");
        const body = await response.json() as { streams?: unknown };
        if (!Array.isArray(body.streams) || !body.streams.every(isStream)) throw new Error("invalid streams");
        return body.streams;
      })();
      // Orion e TPB+ normalmente já chegam pelo servidor. Consultá-los outra vez no navegador
      // duplicava tráfego e gastava uma importação por add-on. O Torrentio RD é a exceção
      // obrigatória; outras fontes só usam o navegador como fallback quando faltaram no servidor.
      const serverAddonIds = serverStreams.then(
        (items) => new Set(items.map((stream) => stream.addonId)),
        () => new Set<string>()
      );
      const browserTargets = (async (): Promise<readonly BrowserStreamTarget[]> => {
        const targetsResponse = await apiFetch(`/v1/stremio/browser-stream-targets/${path}`, {
          cache: "no-store", headers: { Accept: "application/json" },
          signal: AbortSignal.any([operation.signal, AbortSignal.timeout(15_000)])
        });
        if (!targetsResponse.ok) throw new Error("browser targets unavailable");
        const targetsBody = await targetsResponse.json() as { targets?: unknown };
        if (!Array.isArray(targetsBody.targets) || !targetsBody.targets.every(isBrowserStreamTarget)) {
          throw new Error("invalid browser targets");
        }
        // Orion cobra a cota ao consultar links, não ao apertar play. Ele fica totalmente fora
        // da busca normal e do autoplay; só o botão explícito no popup passa includeOrion=true.
        return targetsBody.targets.filter((target) => target.addonId !== "org.community.orion" || includeOrion);
      })();
      // Nomes que falharam ou vieram vazios, só para o aviso específico do Orion abaixo. Cada
      // consulta dá uma nova chance a todos os add-ons; uma falha transitória não bane
      // silenciosamente o TPB+ (ou qualquer outro) pelo restante da sessão, porque
      // `discoverStreams` isola cada alvo e não descarta lotes já publicados por outros.
      const failedAddonNames: string[] = [];
      const importTarget = async (target: BrowserStreamTarget): Promise<readonly Stream[]> => {
        // O Torrentio sai na hora. Antes todo alvo esperava a resposta do servidor, e a fonte
        // principal (inclusive dos torrents do motor local) ficava parada pelos 8 s de um add-on
        // lento do servidor. Só os alvos de fallback esperam para saber se o servidor já os trouxe.
        if (target.addonId !== "com.stremio.torrentio.addon" && (await serverAddonIds).has(target.addonId)) return [];
        try {
          let addonResponse: Response;
          for (let attempt = 0; ; attempt += 1) {
            try {
              addonResponse = await fetch(target.url, {
                cache: "no-store",
                headers: { Accept: "application/json" },
                referrerPolicy: "no-referrer",
                signal: AbortSignal.any([operation.signal, AbortSignal.timeout(8_000)])
              });
            } catch (error) {
              // Uma falha transitória do navegador não deve apagar o Torrentio inteiro. Só há
              // uma repetição, para não multiplicar consumo quando o serviço estiver realmente fora.
              if (attempt === 0) continue;
              throw error;
            }
            if (addonResponse.ok || addonResponse.status < 500 || attempt > 0) break;
          }
          if (!addonResponse.ok) {
            throw new Error("browser addon unavailable");
          }
          const payload = await addonResponse.json() as unknown;
          const importedResponse = await apiFetch(`/v1/stremio/browser-streams/import`, {
            method: "POST",
            cache: "no-store",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ addonId: target.addonId, payload }),
            signal: AbortSignal.any([operation.signal, AbortSignal.timeout(10_000)])
          });
          if (!importedResponse.ok) throw new Error("browser streams rejected");
          const importedBody = await importedResponse.json() as { streams?: unknown };
          if (!Array.isArray(importedBody.streams) || !importedBody.streams.every(isStream)) {
            throw new Error("invalid browser streams");
          }
          if (importedBody.streams.length === 0) throw new Error("empty browser streams");
          return importedBody.streams;
        } catch (error) {
          failedAddonNames.push(target.addonName);
          // "Nenhum resultado" é resposta normal de add-on (ThePirateBay+ em anime), não falha:
          // registrar isso enterrava os erros de verdade no registro.
          const semResultado = error instanceof Error && error.message === "empty browser streams";
          if (!semResultado && !(error instanceof DOMException && error.name === "AbortError")) reportDiagnostic("STREAMS_LOAD_FAILED", error instanceof Error ? error.message : "erro desconhecido", {
            mediaId, videoId: targetVideoId, addon: target.addonName, addonId: target.addonId
          });
          throw error;
        }
      };
      let sawBatch = false;
      await discoverStreams<Stream, BrowserStreamTarget>({
        server: () => serverStreams,
        browserTargets: () => browserTargets,
        importTarget,
        signal: operation.signal,
        onBatch: (batch) => {
          // Resposta tardia de uma busca já superada (outro episódio, outra fonte, popup
          // reaberto) nunca aplica lote: `isCurrent()` cai para falso assim que uma operação mais
          // nova começa ou o player fecha, mesmo que este `fetch` específico já estivesse em voo.
          if (!operation.isCurrent()) return;
          sawBatch = true;
          const availableSources = localStreamingAvailable() ? sourcesForLocalEngine(batch) : attachReadyDirectFallbacks(batch);
          setStreams(availableSources);
          if (localStreamingAvailable()) {
            setSourceNotice(availableSources.length === 0 && batch.some(isRealDebridSource)
              ? "As respostas recebidas até agora só contêm links Real-Debrid. Nenhum torrent disponível para o motor local nesta consulta."
              : null);
          }
          streamsVideoId.current = targetVideoId;
          // O primeiro lote já deixa a lista pronta para uso (retomada automática, seleção
          // manual); os próximos só acrescentam opções sem tirar o que já apareceu.
          setStreamState(availableSources.length > 0 ? "ready" : "empty");
        }
      });
      if (!operation.isCurrent()) return;
      setIsSearchingMore(false);
      if (includeOrion && failedAddonNames.some((name) => /orion/i.test(name))) {
        setSourceNotice(
          "O Orion não trouxe opções nesta consulta. O limite diário conta consultas de links, " +
          "mesmo sem iniciar o vídeo; " +
          (localStreamingAvailable() ? "As outras fontes torrent continuam disponíveis quando retornadas pelos addons." : "TPB+ e Torrentio RD continuam disponíveis.")
        );
      }
      if (!sawBatch) {
        const [serverResult, browserResult] = await Promise.allSettled([serverStreams, browserTargets]);
        if (serverResult.status === "rejected" && browserResult.status === "rejected") {
          throw new Error("all stream sources unavailable");
        }
        if (!operation.isCurrent()) return;
        setStreams([]);
        streamsVideoId.current = "";
        setStreamState("empty");
      }
      streamSearchIncomplete.current = false;
      operation.finish();
    } catch (error) {
      if (!operation.isCurrent()) return;
      streamSearchIncomplete.current = false;
      setIsSearchingMore(false);
      setStreams([]);
      streamsVideoId.current = "";
      setStreamState("error");
      reportDiagnostic("STREAMS_LOAD_FAILED", error instanceof Error ? error.message : "nenhuma fonte respondeu", {
        mediaId, videoId
      });
    }
  }, [addonId, allSaved, editorial, mediaId, requestedNext, requestedVideoId, searchOperation, type, videoId]);

  const openStreamModal = useCallback((fromBeginning = false) => {
    playbackCancelled.current = false;
    startFromBeginningRef.current = fromBeginning;
    setIsStreamModalOpen(true);
    if (streamsVideoId.current !== videoId || streams.length === 0 ||
      (streamSearchIncomplete.current && !isSearchingMore)) void findStreams();
  }, [findStreams, isSearchingMore, streams.length, videoId]);

  const closeStreamModal = useCallback(() => {
    playbackCancelled.current = true;
    resolveOperation.cancel();
    setResolvingStreamId(null);
    setIsStreamModalOpen(false);
    // Devolve o foco pro botão que abriu o popup, depois que o React remove o modal do DOM.
    requestAnimationFrame(() => streamButtonRef.current?.focus());
  }, [resolveOperation]);

  // A tela de detalhes já começa a preparar o episódio e as fontes. Antes, esta cadeia inteira
  // só começava depois de "Assistir", deixando séries sem episódios e o botão aparentemente
  // inerte. O Orion continua exclusivamente manual para não consumir sua cota por navegação.
  useEffect(() => {
    if (viewState !== "ready" || !deviceProfileLoaded || !progressLoaded || !videoId || selectedStream || streamState !== "idle") return;
    if (addonId === "editorial.tmdb" && editorial === null) return;
    if (localStreamingAvailable() && rememberedDeviceSource()) return;
    void findStreams();
  }, [deviceProfileLoaded, activeProfileId, addonId, editorial, findStreams, progressLoaded, rememberedDeviceSource, selectedStream, streamState, videoId, viewState]);

  const selectStream = useCallback(async (stream: Stream, origin: "manual" | "requested" | "automatic" | "debrid-retry" = "automatic") => {
    playbackCancelled.current = false;
    if (origin === "manual") deviceResumeAttemptRef.current = null;
    // Qualquer seleção consome a intenção da URL antes de começar a preparação.
    // Lotes posteriores não podem abrir uma segunda resolução durante a primeira.
    autoplayConsumed.current = true;
    setPendingAutoplayVideoId(null);
    if (origin !== "debrid-retry") selectionOriginRef.current = origin;
    // Escolher uma fonte nova sempre supera a resolução em andamento (se houver): clicar em duas
    // opções em sequência não pode deixar dois pollings do debrid disputando quem termina por
    // último — só o handle desta chamada continua `isCurrent()` daqui em diante.
    const operation = resolveOperation.start();
    const preparationKey = playbackPreparationKey(diagnosticIdsRef.current.videoId, stream.id);
    const startup = new PlaybackStartupTiming();
    startupTimingRef.current = { key: preparationKey, timing: startup };
    preparedProgressRef.current.clear();
    preparedSubtitlesRef.current.clear();
    const usesNativePlayer = tauriPlayerDisponivel() || nativePlayerDisponivel() || tizenPlayerDisponivel();
    const prepareNativeProgress = () => {
      if (usesNativePlayer) {
        preparedProgressRef.current.start(preparationKey, readTitleProgress);
      }
    };
    const prepareSubtitles = async (target: Parameters<typeof refineSubtitlesForFile>[0]) => {
      const refinement = refineSubtitlesForFile(target, operation.isCurrent).then(() => {
        startup.mark("subtitlesReadyMs");
      });
      if (usesNativePlayer) {
        // Monta motor/controles enquanto a legenda é refinada. O load aguarda esta mesma
        // promessa: Windows continua recebendo as legendas na abertura, sem perder faixas.
        preparedSubtitlesRef.current.start(preparationKey, () => refinement);
      } else {
        await refinement;
      }
    };
    if (origin !== "debrid-retry") setDownloadNotice(null);
    setPlayerNotice(playbackWarning(stream, deviceCodecs));
    if (localStreamingAvailable() && isRealDebridSource(stream)) {
      setSelectedStream(null);
      setResolvingStreamId(null);
      setPlayerNotice("Esta fonte depende do Real-Debrid. Escolha uma fonte torrent dos seus addons.");
      operation.finish();
      return;
    }
    if (stream.kind === "direct") {
      startup.mark("urlReadyMs");
      prepareNativeProgress();
      setIsPlayerLoading(true);
      await prepareSubtitles({
        videoId: diagnosticIdsRef.current.videoId, filename: stream.filename, size: stream.videoSize
      });
      if (playbackCancelled.current || !operation.isCurrent()) { operation.finish(); return; }
      setResolvingStreamId(null);
      setSelectedStream(stream);
      operation.finish();
      setIsStreamModalOpen(false);
      requestAnimationFrame(() => {
        playerSectionRef.current?.scrollIntoView({ behavior: "smooth" });
      });
      return;
    }
    setResolvingStreamId(stream.id);
    setSelectedStream(null);
    setIsStreamModalOpen(false);
    setResolutionNotice(null);
    let body: {
      status?: unknown;
      url?: unknown;
      progress?: unknown;
      mayNotPlay?: unknown;
      file?: { name?: unknown; size?: unknown; hash?: unknown };
      error?: { code?: unknown; message?: unknown };
    } = {};
    // Fora do `try`, de propósito: o `catch` precisa deles para o relato de diagnóstico, e
    // `response` ali dentro é reatribuído a cada tentativa do laço de polling.
    let responseStatus: number | undefined;
    try {
      if (localStreamingAvailable()) {
        const session = await prepareLocalTorrent({
          infoHash: stream.infoHash, fileIdx: stream.fileIdx,
          filename: stream.filename, trackers: stream.trackers ?? []
        }, operation.signal);
        if (playbackCancelled.current || !operation.isCurrent()) {
          await releaseLocalTorrent(session.id);
          return;
        }
        try {
          startup.mark("urlReadyMs");
          prepareNativeProgress();
          await prepareSubtitles({ videoId: diagnosticIdsRef.current.videoId,
            filename: session.filename ?? stream.filename, size: session.size ?? stream.videoSize });
          if (playbackCancelled.current || !operation.isCurrent()) {
            await releaseLocalTorrent(session.id);
            return;
          }
          setDownloadNotice(null);
          setIsPlayerLoading(true);
          setSelectedStream({ ...stream, kind: "direct", url: session.url,
            localSessionId: session.id, fileIdx: session.fileIdx });
          setIsStreamModalOpen(false);
          return;
        } catch (error) {
          await releaseLocalTorrent(session.id);
          throw error;
        }
      }
      let response: Response | null = null;
      response = await pollDebrid({
        signal: operation.signal,
        read: async () => {
          const result = await apiFetch(`/v1/stremio/streams/resolve`, {
            method: "POST", cache: "no-store",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ infoHash: stream.infoHash, fileIdx: stream.fileIdx }),
            signal: operation.signal
          });
          responseStatus = result.status;
          body = await result.json() as typeof body;
          return result;
        },
        pending: (result) => result.status === 202 && body.status === "pending",
        onPending: () => {
          setDownloadNotice(typeRef.current === "movie" ? "O filme está baixando…" : "O episódio está baixando…");
        }
      });
      if (playbackCancelled.current || !operation.isCurrent()) return;
      setDownloadNotice(null);
      if (!response?.ok || body.status !== "ready" || typeof body.url !== "string" || !body.url.startsWith("https://")) {
        throw new Error(typeof body.error?.message === "string" ? body.error.message : "Não foi possível preparar esta opção.");
      }
      setIsPlayerLoading(true);
      // Nome/tamanho/hash do arquivo que o Real-Debrid devolveu — nunca a URL, que já vira o
      // link de reprodução acima. `file` é opcional (o cálculo do hash tem teto próprio no
      // servidor): ausência dele não impede a reprodução, só deixa de refinar a legenda.
      const resolvedFile = typeof body.file === "object" && body.file !== null ? body.file : null;
      const resolvedFileName = typeof resolvedFile?.name === "string" ? resolvedFile.name : undefined;
      const resolvedFileSize = typeof resolvedFile?.size === "number" ? resolvedFile.size : undefined;
      const resolvedFileHash = typeof resolvedFile?.hash === "string" ? resolvedFile.hash : undefined;
      const readyUrl = body.url;
      startup.mark("urlReadyMs");
      prepareNativeProgress();
      await prepareSubtitles({
        videoId: diagnosticIdsRef.current.videoId, hash: resolvedFileHash,
        size: resolvedFileSize ?? stream.videoSize,
        filename: resolvedFileName ?? stream.filename
      });
      if (playbackCancelled.current || !operation.isCurrent()) return;
      setSelectedStream({
        ...stream, kind: "direct", url: readyUrl, mayNotPlay: body.mayNotPlay === true,
        filename: resolvedFileName ?? stream.filename, videoSize: resolvedFileSize ?? stream.videoSize
      });
      // O nome do arquivo que o Real-Debrid devolveu às vezes revela o codec que o título do
      // add-on escondia. Só vira aviso se este aparelho tiver mesmo a limitação.
      if (body.mayNotPlay === true && !(deviceCodecs.hevc && deviceCodecs.dolbyAudio)) {
        setPlayerNotice("Esta fonte pode não tocar por completo neste aparelho. Se faltar imagem ou som, escolha outra na lista.");
      }
      // A escolha teve sucesso: fechar o modal aqui não pode cancelar a própria resolução.
      // O finally ainda precisa reconhecer a operação para limpar "Preparando reprodução".
      setIsStreamModalOpen(false);
      requestAnimationFrame(() => {
        playerSectionRef.current?.scrollIntoView({ behavior: "smooth" });
      });
    } catch (error) {
      // Resposta tardia de uma resolução já superada (outra fonte escolhida, popup fechado,
      // player encerrado) nunca aplica erro nem reabre o popup — inclusive quando o próprio
      // `AbortError` do fetch cancelado é o que cai aqui.
      if (!operation.isCurrent()) return;
      if (deviceResumeAttemptRef.current === stream.id && retryDeviceResumeRef.current()) return;
      const message = error instanceof Error ? error.message : "Não foi possível preparar esta opção.";
      reportDiagnostic("RESOLVE_FAILED", message, {
        ...diagnosticIdsRef.current, addon: stream.addonName,
        ...(stream.kind === "torrent" ? { infoHash: stream.infoHash.slice(0, 8) } : {}),
        ...(responseStatus !== undefined ? { status: String(responseStatus) } : {}),
        ...(typeof body.error?.code === "string" ? { apiErrorCode: body.error.code } : {})
      });
      // Torrent no motor local que falhou (sem peers, lento, sem vídeo, falso) é fonte recusada: o
      // automático tenta a próxima. Antes só os erros do RD trocavam de fonte e a pessoa ficava
      // presa em "Não foi possível preparar esta opção".
      const sourceRejected = body.error?.code === "REAL_DEBRID_FILE_BLOCKED" || body.error?.code === "SOURCE_NOT_PLAYABLE" ||
        (stream.kind === "torrent" && localStreamingAvailable());
      // Escolha manual continua devolvendo a decisão para a pessoa: ela pediu ESTA fonte.
      if (sourceRejected && origin !== "manual" && skipRejectedSourceRef.current(stream, message)) return;
      setDownloadNotice(null);
      setPlayerNotice(null);
      setResolutionNotice(message);
      setIsStreamModalOpen(true);
    } finally {
      operation.finish();
      // Só limpa o indicador de "preparando" se esta ainda for a resolução atual: senão apagaria
      // o `resolvingStreamId` que uma seleção mais nova acabou de definir.
      if (operation.isCurrent()) setResolvingStreamId(null);
    }
  }, [deviceCodecs, refineSubtitlesForFile, resolveOperation]);

  retryDeviceResumeRef.current = () => {
    if (deviceResumeAttemptRef.current === null) return false;
    const rejected = deviceResumeAttemptRef.current;
    deviceResumeAttemptRef.current = null;
    forgetDeviceSource(deviceKeyRef.current);
    deviceChoiceRef.current = null;
    failedStreamsRef.current = { videoId, ids: new Set([rejected]) };
    setSelectedStream(null);
    setResolvingStreamId(null);
    setPendingAutoplayVideoId(videoId);
    void findStreams();
    return true;
  };

  const retryDebridPlaceholder = useCallback((stream: DirectStream) => {
    const operation = resolveOperation.start();
    setDownloadNotice(typeRef.current === "movie" ? "O filme está baixando…" : "O episódio está baixando…");
    setIsPlayerLoading(true);
    setIsStreamModalOpen(false);
    setResolvingStreamId(stream.id);
    setSelectedStream(null);
    void waitForDebrid(operation.signal).then(() => {
      if (operation.isCurrent() && !playbackCancelled.current) {
        void selectStream({ ...stream }, "debrid-retry");
      }
    }).catch(() => { /* espera cancelada pela pessoa ou por outra seleção */ });
  }, [resolveOperation, selectStream]);
  const retryDebridPlaceholderRef = useRef(retryDebridPlaceholder);
  retryDebridPlaceholderRef.current = retryDebridPlaceholder;

  useEffect(() => {
    if (!shouldOpenStreamList || streamListOpenedFromQuery.current || autoplayConsumed.current ||
        !progressLoaded || viewState !== "ready" || !videoId) return;
    streamListOpenedFromQuery.current = true;
    startFromBeginningRef.current = false;
    setPendingAutoplayVideoId(videoId);
  }, [progressLoaded, shouldOpenStreamList, videoId, viewState]);

  useEffect(() => {
    if (!meta) return;
    let disposed = false;
    void apiFetch("/v1/auth/session", { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) }).then(async (response) => {
      if (!response.ok || disposed) { if (!disposed) setDeviceProfileLoaded(true); return; }
      const session = await response.json() as { activeProfileId?: unknown };
      if (disposed) return;
      setDeviceProfileLoaded(true);
      if (typeof session.activeProfileId !== "string") return;
      setActiveProfileId(session.activeProfileId);
      try {
        // A conta é a fonte oficial da biblioteca; a tela de título consulta a mesma API que a
        // home, em vez de manter uma segunda verdade local em `localStorage`.
        const libraryResponse = await apiFetch("/v1/library", { headers: { Accept: "application/json" } });
        if (!libraryResponse.ok || disposed) return;
        const body = await libraryResponse.json() as unknown;
        const parsed = libraryResponseSchema.safeParse(body);
        if (!parsed.success || disposed) return;
        const match = parsed.data.items.find((item) => item.mediaId === meta.id && item.mediaType === meta.type) ?? null;
        setLibraryEntry(match);
      } catch { setLibraryEntry(null); }
    }).catch(() => { if (!disposed) setDeviceProfileLoaded(true); });
    return () => { disposed = true; };
  }, [meta]);

  /**
   * PUT adiciona, DELETE remove — sempre otimista, sempre com reversão em falha
   * (`applyLibraryChange`, compartilhado com a home). Só o item atual é mantido localmente:
   * o resto da biblioteca nunca precisa existir nesta tela.
   */
  const toggleLibrary = useCallback(() => {
    if (!meta || !activeProfileId) return;
    setLibraryNotice(null);
    const current = libraryEntry ? [libraryEntry] : [];
    const wasSaved = libraryEntry !== null;
    void applyLibraryChange({
      current,
      item: meta,
      addonId,
      request: apiFetch,
      onOptimistic: (next) => setLibraryEntry(next[0] ?? null)
    }).then((result) => {
      setLibraryEntry(result.items[0] ?? null);
      if (!result.ok) {
        setLibraryNotice({
          message: wasSaved
            ? `Não foi possível remover "${meta.name}" da biblioteca. Tente novamente.`
            : `Não foi possível adicionar "${meta.name}" à biblioteca. Tente novamente.`,
          retry: () => toggleLibrary()
        });
      }
    });
  }, [activeProfileId, addonId, libraryEntry, meta]);

  // Carrega e sincroniza avaliações locais dos usuários para esta obra
  useEffect(() => {
    if (!mediaId) return;
    try {
      const stored = window.localStorage.getItem(`cebola:reviews:${mediaId}`);
      if (stored) {
        const parsed = JSON.parse(stored) as UserReview[];
        if (Array.isArray(parsed)) {
          setUserReviews(parsed);
          const myReview = parsed.find((r) => r.profileId === (activeProfileId ?? "default"));
          if (myReview) {
            setSelectedStars(myReview.ratingStars);
            setReviewComment(myReview.comment || "");
          }
        }
      }
    } catch {
      // armazenamento indisponível
    }
  }, [mediaId, activeProfileId]);

  const handleSaveReview = useCallback(() => {
    if (!mediaId || selectedStars === 0) return;
    const newReview: UserReview = {
      id: `rev_${Date.now()}`,
      mediaId,
      profileId: activeProfileId || "default",
      profileName: "Você",
      ratingStars: selectedStars,
      ratingScore: selectedStars * 2,
      comment: reviewComment.trim(),
      createdAt: new Date().toISOString()
    };

    try {
      const current = userReviews.filter((r) => r.profileId !== (activeProfileId || "default"));
      const updated = [newReview, ...current];
      window.localStorage.setItem(`cebola:reviews:${mediaId}`, JSON.stringify(updated));
      setUserReviews(updated);
      setIsReviewModalOpen(false);
    } catch {
      // erro no localStorage
    }
  }, [activeProfileId, mediaId, reviewComment, selectedStars, userReviews]);

  const returnToManualChoice = useCallback((notice: string) => {
    player.current?.pause();
    setSelectedStream(null);
    setPlayerNotice(null);
    setResolutionNotice(notice);
    setIsStreamModalOpen(true);
  }, []);

  /**
   * Fonte que falhou de verdade (evento `error` do motor nativo ou do `<video>`): nunca mais
   * escolhida automaticamente NESTE vídeo — nem a automática, nem a salva, que senão o autoplay
   * reabriria a mesma fonte quebrada. Tenta a PRÓXIMA da lista automaticamente, uma única vez;
   * se essa também falhar (ou não houver nenhuma), devolve a escolha para a pessoa.
   */
  const handlePlaybackFailure = useCallback((notice: string, options: PlaybackFailureOptions = {}) => {
    if (!selectedStream) { returnToManualChoice(notice); return; }
    if (deviceResumeAttemptRef.current === selectedStream.id && retryDeviceResumeRef.current()) return;
    const bucket = failedStreamsRef.current.videoId === videoId
      ? failedStreamsRef.current
      : { videoId, ids: new Set<string>() };
    const ids = new Set(bucket.ids);
    ids.add(selectedStream.id);
    failedStreamsRef.current = { videoId, ids };

    const retries = autoRetriesRef.current.videoId === videoId ? autoRetriesRef.current.count : 0;
    // Arquivo que o motor não consegue ler pela estrutura (MKV com bloco gigante de fontes
    // anexadas) costuma vir igual em todo release do MESMO grupo: pula o grupo quando há outro.
    const failedGroup = options.avoidSameGroup ? releaseGroupOf(selectedStream.filename ?? selectedStream.label) : null;
    const next = retrySourceAfterFailure(streams, ids, selectionOriginRef.current,
      retries >= MAX_AUTOMATIC_SOURCE_RETRIES,
      (allRemaining) => {
        const remaining = forThisVideo(allRemaining);
        const otherGroups = failedGroup ? remaining.filter((stream) => releaseGroupOf(stream.filename ?? stream.label) !== failedGroup) : remaining;
        const pool = otherGroups.length > 0 ? otherGroups : remaining;
        // 4K que falhou (torrent fraco ou arquivo que o aparelho recusa) cai para a melhor opção
        // abaixo, em vez de gastar as tentativas em outro 4K.
        const below4k = selectedStream.quality === "4K" ? pool.filter((stream) => stream.quality !== "4K") : pool;
        return chooseAutoplayStream(below4k.length > 0 ? below4k : pool, deviceCodecs, deviceChoiceRef.current,
          rankingLanguages(editorial?.originalLanguage, scenarioRef.current),
          activeContinuity(previousEpisodeContinuityRef.current, metaIdRef.current)?.source ?? null);
      });
    if (next) {
      autoRetriesRef.current = { videoId, count: retries + 1 };
      setPlayerNotice(notice);
      reportDiagnostic("SOURCE_FALLBACK", notice, {
        mediaId, videoId,
        fromAddon: selectedStream.addonName,
        toAddon: next.addonName,
        ...(next.kind === "torrent" ? { toInfoHash: next.infoHash.slice(0, 8) } : {})
      });
      void selectStream(next);
      return;
    }
    returnToManualChoice(notice);
  }, [activeSaved, deviceCodecs, editorial?.originalLanguage, returnToManualChoice, selectStream, selectedStream, streams, videoId]);
  // `handlePlaybackFailure` muda de identidade sempre que `streams` cresce (busca em segundo
  // plano) ou `deviceCodecs`/`editorial` mudam — e o efeito que monta o player nativo NUNCA pode
  // reexecutar por causa disso (reexecutar destrói e recria a instância nativa no meio da
  // reprodução). Os listeners leem sempre a versão mais recente através deste ref.
  useEffect(() => { handlePlaybackFailureRef.current = handlePlaybackFailure; }, [handlePlaybackFailure]);

  const skipRejectedSource = useCallback((rejected: Stream, notice: string): boolean => {
    const bucket = failedStreamsRef.current.videoId === videoId
      ? failedStreamsRef.current
      : { videoId, ids: new Set<string>() };
    const ids = new Set(bucket.ids);
    ids.add(rejected.id);
    failedStreamsRef.current = { videoId, ids };
    const skips = rejectedSkipsRef.current.videoId === videoId ? rejectedSkipsRef.current.count : 0;
    if (skips >= MAX_REJECTED_SOURCE_SKIPS) return false;
    const next = chooseAutoplayStream(forThisVideo(streams.filter((stream) => !ids.has(stream.id))), deviceCodecs, deviceChoiceRef.current,
      rankingLanguages(editorial?.originalLanguage, scenarioRef.current), activeContinuity(previousEpisodeContinuityRef.current, metaIdRef.current)?.source ?? null);
    if (!next) return false;
    rejectedSkipsRef.current = { videoId, count: skips + 1 };
    setPlayerNotice(`${notice} Tentando a próxima opção…`);
    reportDiagnostic("SOURCE_FALLBACK", notice, {
      mediaId, videoId, fromAddon: rejected.addonName, toAddon: next.addonName,
      ...(next.kind === "torrent" ? { toInfoHash: next.infoHash.slice(0, 8) } : {})
    });
    void selectStream(next, selectionOriginRef.current === "requested" ? "requested" : "automatic");
    return true;
  }, [activeSaved, deviceCodecs, editorial?.originalLanguage, mediaId, selectStream, streams, videoId]);
  useEffect(() => { skipRejectedSourceRef.current = skipRejectedSource; }, [skipRejectedSource]);

  // Vigia a reprodução em busca da assinatura de fonte muda. Só conta tempo enquanto o vídeo
  // está realmente decodificando: pausado, carregando ou parado não contam.
  useEffect(() => {
    if (!selectedStream || tauriRuntime || nativePlayerDisponivel() ||
      (tizenPlayerDisponivel() && avplayRecusou !== selectedStream.id)) return;
    let segundosMudos = 0;
    const timer = window.setInterval(() => {
      // O <video> é procurado a cada volta, e não uma vez só: o player cria o elemento depois
      // que este efeito monta, e prendê-lo numa variável pegaria null para sempre.
      const video = playerSectionRef.current?.querySelector("video") as VideoComContadores | null;
      if (!video) return;
      const audioBytes = video.webkitAudioDecodedByteCount;
      const videoBytes = video.webkitVideoDecodedByteCount;
      // Navegador sem os contadores (Firefox, Safari): não dá para afirmar nada, então não age.
      if (typeof audioBytes !== "number" || typeof videoBytes !== "number") {
        window.clearInterval(timer);
        return;
      }
      if (audioBytes > 0) { window.clearInterval(timer); return; }
      if (video.paused || videoBytes === 0) return;
      segundosMudos += 1;
      if (segundosMudos < SEGUNDOS_ATE_DECLARAR_MUDA) return;
      window.clearInterval(timer);
      returnToManualChoice(
        "Esta fonte abriu sem som neste aparelho. Escolha outra opção; prefira AAC/estéreo e evite AC3, EAC3 ou DTS."
      );
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [avplayRecusou, returnToManualChoice, selectedStream, tauriRuntime]);

  // Aplica o deslocamento nas legendas já carregadas e nas que ainda vão carregar. O Vidstack
  // calcula a legenda ativa a partir de startTime/endTime de cada trecho, então mexer neles é o
  // suficiente — e continua valendo se um dia o player mudar, porque VTTCue é padrão da web.
  useEffect(() => {
    const instance = player.current;
    if (!instance) return;
    const aplicar = () => {
      for (const track of instance.textTracks) {
        if (track.kind !== "subtitles" && track.kind !== "captions") continue;
        for (const cue of track.cues) {
          const chave = cue as unknown as object;
          let original = cueOriginalTimes.current.get(chave);
          if (original === undefined) {
            original = { start: cue.startTime, end: cue.endTime };
            cueOriginalTimes.current.set(chave, original);
          }
          // Um trecho não pode começar antes do zero nem terminar antes de começar.
          cue.startTime = Math.max(0, original.start + subtitleSettings.offset);
          cue.endTime = Math.max(cue.startTime + 0.1, original.end + subtitleSettings.offset + subtitleSettings.extraDuration);
        }
      }
    };
    aplicar();
    // Trocar de legenda traz uma faixa nova, ainda sem trechos: reaplica quando ela terminar de
    // carregar, senão o ajuste vale só para a primeira legenda escolhida.
    const aoCarregar = () => aplicar();
    const observadas = new Set<string>();
    const observar = () => {
      for (const track of instance.textTracks) {
        if (observadas.has(track.id)) continue;
        observadas.add(track.id);
        track.addEventListener("load", aoCarregar);
      }
    };
    observar();
    instance.textTracks.addEventListener("add", observar);
    return () => {
      instance.textTracks.removeEventListener("add", observar);
      // Remover um ouvinte que não foi registrado não faz nada, então varrer a lista inteira é
      // mais simples e igualmente correto do que guardar referência a cada faixa.
      for (const track of instance.textTracks) track.removeEventListener("load", aoCarregar);
    };
  }, [subtitleSettings.extraDuration, subtitleSettings.offset, subtitles]);

  // Foco entra no popup assim que ele abre (o conteúdo pode estar em "carregando…" ainda).
  useEffect(() => {
    if (isStreamModalOpen) streamDialogRef.current?.focus();
  }, [isStreamModalOpen]);

  // Idem para o modal de avaliação, só na TV — sem isto, o popup abria sem foco (Tab/controle começavam
  // fora dele) e Escape/Voltar não tinham como fechá-lo.
  useEffect(() => {
    if (tvLayout && isReviewModalOpen) reviewDialogRef.current?.focus();
  }, [isReviewModalOpen, tvLayout]);

  const handleModalKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeStreamModal();
      return;
    }
    if (event.key !== "Tab") return;
    // Focus trap: Tab/Shift+Tab não escapam do popup enquanto ele estiver aberto.
    const dialog = streamDialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, [closeStreamModal]);

  // Mesmo padrão do popup de fontes (Escape fecha, Tab preso lá dentro), agora pro de avaliação
  // — ele nunca teve isso, então nem PC/celular fechavam com Escape antes desta task.
  const handleReviewModalKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setIsReviewModalOpen(false);
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = reviewDialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  // Setas cima/baixo movem entre as opções, no mesmo espírito do grid de perfis: navegação
  // direta por teclado e controle remoto de TV, sem depender só da ordem de Tab.
  const handleOptionsNavigation = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const options = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-stream-option]")
    );
    const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement);
    if (currentIndex < 0) return;
    const next = options[event.key === "ArrowDown" ? currentIndex + 1 : currentIndex - 1];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  }, []);

  // Abre a sessão de salvamento do vídeo que vai tocar (uma por vídeo + fonte). A identidade do
  // vídeo e o cenário salvo de reserva são CAPTURADOS agora: quando a pessoa deixa um episódio, a
  // tela já trocou de vídeo antes de a gravação final sair, e ela precisa sair com a identidade
  // DELE. Lê só refs e setters estáveis — por isso não entra como mudança em quem a usa.
  const startProgressSession = useCallback((
    video: Pick<Video, "id" | "title" | "season" | "episode">,
    stream: DirectStream,
    savedScenario: PlaybackScenario | null
  ): ProgressTracker | null => {
    const { meta: titleMeta, addonId: urlAddonId } = progressTitleRef.current;
    if (titleMeta === null) return null;
    playedHereRef.current.add(video.id);
    const identity = {
      // addonId identifica a origem do metadado/deep link (o da URL; sem ele, o da fonte); a fonte
      // reproduzida é guardada separadamente para não perder a retomada ao voltar pela home.
      addonId: urlAddonId.trim() !== "" ? urlAddonId : stream.addonId,
      playbackAddonId: stream.addonId,
      mediaId: titleMeta.id,
      videoId: video.id,
      mediaType: titleMeta.type,
      title: titleMeta.name,
      episodeTitle: titleMeta.type === "series" ? video.title : null,
      season: video.season,
      episode: video.episode,
      posterUrl: titleMeta.poster
    };
    let rejectionReported = false;
    // A fonte desta sessão sempre vai no cenário. Antes ela só entrava quando a pessoa trocava de
    // fonte pelo menu: escolher na lista e assistir gravava sem fonte, e o "Continuar" escolhia
    // outro torrent. A fonte resolvida no debrid vira `direct`, mas mantém id, add-on, rótulo e o
    // hash do torrent de origem.
    const origin = stream as { readonly infoHash?: unknown; readonly fileIdx?: unknown };
    const sessionSource: PlaybackSource = {
      ...scenarioForStream(stream),
      ...(typeof origin.infoHash === "string"
        ? { infoHash: origin.infoHash, fileIdx: typeof origin.fileIdx === "number" ? origin.fileIdx : null }
        : {})
    };
    // O cenário da tela é zerado ao trocar de episódio, antes do cleanup que grava a saída: sem
    // esta memória, a última gravação do episódio deixado sairia sem fonte/áudio/legenda. Sem
    // escolha nenhuma nesta sessão, vale o cenário já salvo deste vídeo (o upsert substitui o
    // cenário inteiro: gravar sem ele apagaria o áudio e a legenda guardados).
    const sessionProfileId = progressProfileRef.current;
    let lastScenario: PlaybackScenario | null = savedScenario;
    let lastBody = "";
    return createProgressTracker({
      save: (reading, completed) => {
        if (sessionExpired.current) return;
        const scenario = mergeScenario(scenarioRef.current ?? lastScenario, { source: sessionSource });
        lastScenario = scenario;
        const built = buildProgressBody({
          ...identity,
          positionSeconds: reading.positionSeconds,
          durationSeconds: reading.durationSeconds,
          completed,
          scenario,
          fallbackScenario: savedScenario
        });
        if (!built.ok) {
          if (!rejectionReported) {
            rejectionReported = true;
            reportDiagnostic("PROGRESS_BODY_REJECTED", built.reason, {
              mediaId: identity.mediaId, videoId: identity.videoId
            });
          }
          return;
        }
        // Fechar o player grava por mais de um caminho (botão, pausa, saída do efeito): o mesmo
        // corpo, já aceito pela API, não precisa ir duas vezes.
        if (built.body === lastBody) return;
        lastBody = built.body;
        void sendProgress(built.body, {
          profileId: sessionProfileId ?? progressProfileRef.current ?? undefined,
          onSaved: (saved) => {
            const target = progressTargetRef.current;
            if (saved.mediaId === target.mediaId || target.videoIds.includes(saved.videoId)) {
              setSavedItems((items) => mergeSavedProgress(items, saved));
            }
          },
          onUnauthorized: () => {
            sessionExpired.current = true;
            setPlayerNotice("Sua sessão expirou. O vídeo continua funcionando, mas o progresso não será salvo até você entrar novamente.");
          }
        }).then((saved) => {
          if (!saved && lastBody === built.body) {
            lastBody = "";
            if (!sessionExpired.current) setPlayerNotice("Não foi possível confirmar o progresso. Tentaremos salvar novamente quando houver conexão.");
          }
        });
      }
    });
  }, []);

  useEffect(() => {
    const flush = () => progressTrackerRef.current?.flush();
    const onVisibility = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    if (!activeProfileId) return;
    const retry = () => { void retryPendingProgress(activeProfileId, {
      onSaved: (saved) => {
        const target = progressTargetRef.current;
        if (saved.mediaId === target.mediaId || target.videoIds.includes(saved.videoId)) {
          setSavedItems((items) => mergeSavedProgress(items, saved));
        }
      }
    }); };
    retry();
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [activeProfileId]);

  // Posição e duração do que está tocando agora (player nativo ou Vidstack), ou `undefined` se
  // ainda não há leitura confiável — o tracker então usa a última válida que ele mesmo viu.
  const currentPlaybackReading = useCallback((): ProgressReading | undefined => {
    const nativeState = playerNativo?.state();
    if (nativeState && nativeState.durationSeconds > 0) {
      return { positionSeconds: nativeState.positionSeconds, durationSeconds: nativeState.durationSeconds };
    }
    const browserElement = player.current;
    if (browserElement && Number.isFinite(browserElement.duration) && browserElement.duration > 0) {
      return { positionSeconds: browserElement.currentTime, durationSeconds: browserElement.duration };
    }
    return undefined;
  }, [playerNativo]);

  // Áudio, legenda e ajustes só chegam aqui depois de confirmados pelo player (ver
  // `PlayerControls.onScenarioChange`). Atualiza o ref antes de gravar para que sair logo após uma
  // escolha não perca o cenário. No segundo zero o tracker não tem leitura válida e a escolha
  // fica só em memória — gravar posição zero apagaria uma retomada anterior.
  const handleScenarioChange = useCallback((patch: PlaybackScenarioPatch) => {
    if ("subtitle" in patch) {
      userSubtitleChoiceRef.current = patch.subtitle?.id ?? "off";
      setUserSubtitleChoice(userSubtitleChoiceRef.current);
    }
    scenarioRef.current = mergeScenario(scenarioRef.current, patch);
    progressTrackerRef.current?.flush(currentPlaybackReading());
  }, [currentPlaybackReading]);

  const switchPlayerSource = useCallback(async (streamId: string) => {
    const next = streams.find((stream) => stream.id === streamId);
    if (!next || next.id === selectedStream?.id) return;
    // Escolha manual: registra a identidade da fonte (nunca a `url`, que é temporária) para a
    // próxima gravação de progresso já sair com a fonte certa, mesmo antes do próximo `ready`.
    scenarioRef.current = mergeScenario(scenarioRef.current, { source: scenarioForStream(next) });
    const reading = currentPlaybackReading();
    if (reading && reading.positionSeconds > 0) {
      sourceSwitchPositionRef.current = reading.positionSeconds;
      progressTrackerRef.current?.flush(reading);
    }
    await selectStream(next, "manual");
  }, [currentPlaybackReading, selectStream, selectedStream, streams]);

  // Dentro de um app, a fonte escolhida vai ao motor nativo da plataforma; no navegador, segue
  // para o Vidstack. A interface, o fluxo de fontes e o progresso permanecem os mesmos.
  // A CRIAÇÃO nunca espera a legenda (`canLoadPlayerSource` só olha a fonte) — `subtitles` e
  // `defaultSubtitleId` são lidos dos refs acima, não das dependências, então uma legenda que
  // chega depois não reexecuta este efeito nem remonta o player.
  useEffect(() => {
    if (selectedStream === null || !canLoadPlayerSource(selectedStream.id)) return;
    setIsPlayerLoading(true);
    // Na TV Samsung dentro da casca o AVPlay mora na janela da casca (`TizenBridgePlayer`, por
    // mensagens); no WGT antigo, sem iframe, ele está nesta janela (`TizenPlayer`). Uma fonte que o
    // AVPlay já recusou cai direto no player do navegador (ver `recusarAvplay`).
    const nativo: NativePlayer | null = tauriRuntime
      ? (tauriVideoSurface.current ? new TauriPlayer(tauriVideoSurface.current) : null)
      : tizenPlayerDisponivel() && avplayRecusou !== selectedStream.id
        ? (dentroDaCasca() ? new TizenBridgePlayer() : new TizenPlayer())
        : nativePlayerDisponivel() ? new CapacitorPlayer() : null;
    if (nativo === null) return;
    const preparationKey = playbackPreparationKey(diagnosticIdsRef.current.videoId, selectedStream.id);
    const startup = startupTimingRef.current?.key === preparationKey ? startupTimingRef.current.timing : null;
    const startupIds = { ...diagnosticIdsRef.current };
    const successfulDeviceKey = deviceKeyRef.current;
    let deviceChoiceRecorded = false;
    const viaCasca = nativo instanceof TizenBridgePlayer;
    setPlayerNativo(nativo);
    startup?.mark("playerCreatedMs");
    const gate = new LateSubtitleGate();
    subtitleGateRef.current = gate;
    if (!tauriRuntime) document.documentElement.classList.add("reproduzindo-nativo");

    // Sessão de salvamento deste vídeo + fonte: nasce com a identidade de AGORA e só morre no
    // cleanup deste efeito, que grava a saída. Nenhuma outra dependência entra aqui por causa dela.
    const sessao = selectedVideo
      ? startProgressSession(selectedVideo, selectedStream, activeSavedRef.current?.playbackScenario ?? null)
      : null;
    const tracker = sessao ? criarGuardaDoPontoSalvo(sessao) : null;
    progressTrackerRef.current = tracker;
    let cancelado = false;
    let resumeTarget = 0;
    // Só para o `error` abaixo (retomada que quebra o motor). Quem protege o ponto salvo de uma
    // leitura baixa do seek inicial é o próprio tracker (`resumeFrom`).
    const resumeProtectionUntil = Date.now() + 30_000;
    // No PC, o GStreamer às vezes quebra no seek de retomada de um MKV por HTTP ("reading large
    // block … file might be corrupt") — e a fonte seguinte quebrava igual, porque retomava no mesmo
    // ponto. Antes de dar a fonte por perdida, reabre UMA vez do início.
    let cargaAtual: Parameters<typeof nativo.load>[0] | null = null;
    let retomadaDescartada = false;
    // A tela de carregamento só sai com o vídeo andando no ponto certo. O `ready` sozinho não
    // basta: o GStreamer dá `ready` (0:00/0:00) e só então falha no MKV, e o mpv dá `ready` no 0:00
    // antes do seek da retomada — a pessoa via quadro quebrado, erro vermelho e a abertura parada.
    let aguardandoInicio = false;
    let revelarTimer: number | undefined;
    const cobrir = () => {
      playerReady = false;
      geracaoFaixas++;
      setPreparedTracks(null);
      aguardandoInicio = false;
      window.clearTimeout(revelarTimer);
      setIsPlayerLoading(true);
    };
    const revelar = () => {
      aguardandoInicio = false;
      window.clearTimeout(revelarTimer);
      if (!cancelado) {
        setIsPlayerLoading(false);
        const timings = startup?.finish();
        if (timings) reportDiagnostic("PLAYBACK_STARTUP", "Tempo até exibir o player (ms desde a escolha da fonte)", {
          ...startupIds, addon: selectedStream.addonName, engine: nativo.engine?.() ?? "nativo", ...timings
        });
      }
    };

    // Volta automática do AVPlay (só via casca): se ele falhar ANTES do primeiro `position`, a fonte
    // não está perdida — passa para o player do navegador, retomando do mesmo ponto. Depois de
    // começar a tocar, um erro segue o fluxo normal de falha de fonte.
    let tocou = false;
    let avplayJaRecusado = false;
    const recusarAvplay = (motivo: string) => {
      if (cancelado || avplayJaRecusado) return;
      avplayJaRecusado = true;
      reportDiagnostic("AVPLAY_FALLBACK_BROWSER", motivo, {
        ...diagnosticIdsRef.current, addon: selectedStream.addonName
      });
      // O efeito acima já consumiu o ponto de uma troca manual de fonte; devolve para o navegador.
      sourceSwitchPositionRef.current = resumeTarget > 0 ? resumeTarget : null;
      // Mesma sessão trocando de motor: se o início era 0, "do começo" (já zerado) precisa valer de novo
      // no navegador, senão ele retomaria do ponto salvo.
      if (resumeTarget <= 0) startFromBeginningRef.current = true;
      setAvplayRecusou(selectedStream.id);
    };

    // O libVLC pode publicar a faixa embutida só depois de `ready`. Serializa as tentativas para
    // que uma resposta antiga não reverta a seleção da tentativa mais recente.
    let filaDeFaixas = Promise.resolve();
    // O áudio é decidido UMA vez por abertura, assim que o motor publicar faixas, e nunca depois:
    // repetir desfaria uma troca manual de áudio da pessoa. Zera a cada `ready` (nova abertura).
    let audioResolvido = false;
    let geracaoFaixas = 0;
    const timersDasFaixas: number[] = [];
    let waitingForDownload = false;
    let playerReady = false;
    // Uma fila só: `aplicarFaixas` decide e seleciona áudio e legenda; a resposta antiga nunca
    // reverte a mais nova. Devolve a promessa para o `ready` encadear a checagem de sincronia.
    const aplicarAsFaixas = () => {
      const geracao = geracaoFaixas;
      filaDeFaixas = filaDeFaixas.then(async () => {
        const entrada = entradaDasFaixas();
        const isCurrent = () => !cancelado && playerReady && geracao === geracaoFaixas &&
          entrada.escolhaDaPessoa === userSubtitleChoiceRef.current;
        if (!isCurrent()) return;
        const resultado = await aplicarFaixas(nativo, entrada, { audio: !audioResolvido, isCurrent });
        if (!isCurrent()) return;
        if (resultado.audioAvaliado && !resultado.audioFalhou) audioResolvido = true;
        if (audioResolvido && !resultado.audioFalhou && !resultado.legendaFalhou) {
          setPreparedTracks((current) => current?.player === nativo && current.key === preparationKey
            ? current : { key: preparationKey, player: nativo });
        }
        if (resultado.audioFalhou) setPlayerNotice("Não foi possível restaurar a trilha de áudio salva. Escolha outra no menu.");
        if (resultado.legendaFalhou) setPlayerNotice("Não foi possível restaurar a legenda. Escolha outra no menu.");
      }).catch(() => {
        if (!cancelado) setPlayerNotice("Não foi possível restaurar a legenda. Escolha outra no menu.");
      });
      return filaDeFaixas;
    };
    nativo.on("tracksChanged", () => { void aplicarAsFaixas(); });
    const vigiarFaixas = window.setInterval(() => { void aplicarAsFaixas(); }, 5_000);

    // Só na escolha automática: a fonte escolhida à mão a pessoa já viu na lista.
    let duracaoConferida = false;
    const duracaoErrada = (duracao: number): boolean => {
      if (duracaoConferida || duracao <= 0) return false;
      duracaoConferida = true;
      if (selectionOriginRef.current === "manual" || !durationMismatch(matchTargetRef.current, duracao)) return false;
      setIsPlayerLoading(false);
      handlePlaybackFailureRef.current(wrongDurationNotice(duracao, matchTargetRef.current?.runtimeMinutes));
      return true;
    };

    nativo.on("position", (segundos) => {
      if (cancelado || waitingForDownload || nativo.state().durationSeconds <= 90) return;
      if (duracaoErrada(nativo.state().durationSeconds)) return;
      tocou = true;
      if (!deviceChoiceRecorded && segundos > 0 && nativo.state().playing && selectedStream.localSessionId) {
        rememberDeviceSource(successfulDeviceKey, selectedStream);
        deviceChoiceRecorded = true;
        deviceResumeAttemptRef.current = null;
      }
      if (aguardandoInicio && segundos > 0 && (resumeTarget <= 0 || segundos >= resumeTarget - 5)) revelar();
      tracker?.position(segundos, nativo.state().durationSeconds);
    });
    nativo.on("ready", (estado) => {
      if (cancelado) return;
      startup?.mark("playerReadyMs");
      setPreparedTracks(null);
      geracaoFaixas++;
      playerReady = true;
      // Alguns serviços de debrid entregam um clipe verde de 30 s enquanto o torrent ainda
      // está sendo preparado. Ele é um vídeo válido para o motor nativo, mas não é a obra.
      if (estado.durationSeconds > 0 && estado.durationSeconds <= 90) {
        if (!selectedStream.localSessionId && isDebridPlaceholder(selectedStream, estado.durationSeconds)) {
          waitingForDownload = true;
          void nativo.pause();
          retryDebridPlaceholderRef.current(selectedStream);
          return;
        }
        setIsPlayerLoading(false);
        // Conta como falha da fonte: marca para não ser escolhida de novo e tenta a próxima.
        handlePlaybackFailureRef.current("Esta fonte ainda está sendo preparada pelo debrid. Escolha outra opção pronta ou tente novamente depois.");
        return;
      }
      if (duracaoErrada(estado.durationSeconds)) return;
      setDownloadNotice(null);
      // Revela no primeiro `position` no ponto certo; se ele não vier (pausado, motor lento), não
      // prende a pessoa numa tela preta.
      aguardandoInicio = true;
      window.clearTimeout(revelarTimer);
      revelarTimer = window.setTimeout(revelar, 8_000);
      // Trilhas embutidas só existem depois do `ready`; a regra única escolhe áudio e legenda e,
      // só DEPOIS dela, a camada 3 (sincronia por conteúdo) confere a legenda que ficou ativa — a
      // própria função já sai cedo se ela vier de cenário salvo/continuidade.
      audioResolvido = false;
      timersDasFaixas.splice(0).forEach((timer) => window.clearTimeout(timer));
      // Motores que publicam faixas tarde (libVLC) ou sem `tracksChanged`: mesma sondagem que os
      // controles faziam. É idempotente; o áudio só é decidido na primeira que achar faixas.
      for (const atraso of [1_000, 2_500, 5_000, 10_000]) {
        timersDasFaixas.push(window.setTimeout(() => { void aplicarAsFaixas(); }, atraso));
      }
      void aplicarAsFaixas().then(() => {
        if (cancelado) return;
        runSubtitleTimingCheckRef.current(estado.durationSeconds, {
          getActiveId: () => nativo.state().subtitleTrackId,
          apply: (id) => { void nativo.selectSubtitleTrack(id).catch(() => {}); }
        });
      });
    });
    // Uma falha do GStreamer chega em DOIS eventos (demuxer e "streaming stopped" do HTTP). O
    // segundo chegava depois da troca de fonte e, lido pelo ref, marcava a fonte NOVA como falha
    // sem ela ter sido tentada. Só o primeiro erro de cada abertura conta, e nunca de um player
    // já descartado (`cancelado`).
    let erroTratado = false;
    nativo.on("error", (message) => {
      if (waitingForDownload || cancelado || erroTratado) return;
      erroTratado = true;
      // Fonte do motor local (http://127.0.0.1 na TV) não abre no player do navegador: o site é
      // https e o navegador bloqueia; a TV ficava presa em "Abrindo vídeo…". Segue a falha normal,
      // que troca de fonte.
      if (viaCasca && !tocou && !selectedStream.localSessionId) {
        recusarAvplay(typeof message === "string" ? message : "erro do AVPlay");
        return;
      }
      const estrutural = typeof message === "string" && /reading large block|matroska/i.test(message);
      // PC: o GStreamer não lê este arquivo (MKV com fontes anexadas), mas o mpv lê. Reabre a
      // MESMA fonte nele, no mesmo ponto, antes de trocar de fonte — trocar perdia a única versão
      // com português.
      if (estrutural && tauriRuntime && cargaAtual && !cargaAtual.alternativeEngine) {
        const posicao = nativo.state().positionSeconds;
        const retomar = posicao > 1 ? posicao : resumeTarget;
        reportDiagnostic("ENGINE_FALLBACK_MPV", "GStreamer não leu o arquivo; reabrindo no mpv", {
          ...diagnosticIdsRef.current, startAt: String(Math.round(retomar))
        });
        cobrir();
        cargaAtual = { ...cargaAtual, startAtSeconds: retomar, alternativeEngine: true };
        erroTratado = false;
        void nativo.load(cargaAtual).catch(() => {
          if (!cancelado) handlePlaybackFailureRef.current("Não foi possível reproduzir esta fonte neste aparelho.");
        });
        return;
      }
      if (!estrutural && !tocou && tauriRuntime && cargaAtual && !retomadaDescartada && resumeTarget > 0 && Date.now() < resumeProtectionUntil) {
        retomadaDescartada = true;
        const alvo = Math.round(resumeTarget);
        reportDiagnostic("RESUME_SEEK_FAILED", "o motor quebrou ao retomar; reabrindo do início", {
          ...diagnosticIdsRef.current, startAt: String(alvo)
        });
        setPlayerNotice(`Este arquivo não abriu em ${Math.floor(alvo / 60)} min. Começando do início.`);
        // Recomeçar do 0 não pode apagar, no servidor, o ponto onde a pessoa parou.
        tracker?.recomecoForcado(resumeTarget);
        const carga = { ...cargaAtual, startAtSeconds: 0 };
        cobrir();
        erroTratado = false;
        void nativo.load(carga).catch(() => {
          if (!cancelado) handlePlaybackFailureRef.current("Não foi possível reproduzir esta fonte neste aparelho.");
        });
        return;
      }
      // A cortina continua: se houver outra fonte, ela entra por baixo dela; se a escolha voltar
      // para a pessoa, a lista abre e o player (e a cortina junto) sai de cena.
      window.clearTimeout(revelarTimer);
      // GStreamer (Linux/Tauri) e o motor do Android reportam aqui — sem isto, o vídeo ficava
      // preto/parado para sempre: o `isPlayerLoading` parava, mas nada mais acontecia. Lê pelo
      // ref (não por `handlePlaybackFailure` direto): este efeito monta a instância nativa e NÃO
      // pode reexecutar (destruir/recriar o player em reprodução) só porque `streams` cresceu
      // numa busca em segundo plano — o que aconteceria se a função entrasse nas dependências.
      handlePlaybackFailureRef.current(
        estrutural
          ? "Este arquivo não abre no player do PC. Tentando outra versão…"
          : "Não foi possível reproduzir esta fonte neste aparelho.",
        { avoidSameGroup: estrutural }
      );
    });
    nativo.on("ended", () => {
      const state = nativo.state();
      if (cancelado || waitingForDownload || (!selectedStream.localSessionId && state.durationSeconds <= 90)) return;
      if (!canAdvanceOnEnded(state.positionSeconds, state.durationSeconds)) {
        reportDiagnostic("PREMATURE_ENDED", "Evento de fim antes do final do vídeo", {
          ...startupIds, position: String(state.positionSeconds), duration: String(state.durationSeconds)
        });
        return;
      }
      tracker?.ended(state.durationSeconds);
      if (selectedStream.localSessionId) setSelectedStream(null);
    });

    void (async () => {
      // A leitura começa junto do refinamento de legenda. Só reaproveita a mesma fonte/vídeo
      // e resposta recente; se expirou, mantém a consulta normal de retomada.
      const prepared = preparedProgressRef.current.take(preparationKey);
      const subtitlePreparation = preparedSubtitlesRef.current.take(preparationKey);
      // Consome a leitura antecipada ANTES de aguardar legendas. Antes ela podia vencer
      // durante os 2 s de refinamento e causar outra viagem ao servidor na abertura.
      const progressPreparation = (prepared
        ? prepared.then((items) => items.length > 0 ? items : readTitleProgress()).catch(() => readTitleProgress())
        : readTitleProgress()).then((items) => {
          startup?.mark("progressReadyMs");
          return items;
        });
      const [items] = await Promise.all([progressPreparation, subtitlePreparation]);
      if (cancelado) return;
      try {
        const mediaType = typeRef.current;
        const obra = metaIdRef.current;
        const salvo = mediaType !== null && obra
          ? findSavedProgress(items, { mediaType, mediaId: obra, videoId: selectedVideo?.id ?? "", alternateIds: progressTargetRef.current.videoIds })
          : null;
        resumeTarget = decidirInicio({
          videoId: selectedVideo?.id,
          posicaoDaTroca: sourceSwitchPositionRef.current,
          doComeco: startFromBeginningRef.current,
          salvo,
          pularAbertura: pularAberturaLigado()
        }).segundos;
        sourceSwitchPositionRef.current = null;
        startFromBeginningRef.current = false;
        tracker?.resumeFrom(resumeTarget);
        // Legendas disponíveis NESTE instante — pode ser a lista cheia ou ainda vazia, se a
        // busca em `/v1/stremio/subtitles` não tiver terminado. `gate` registra exatamente estas
        // para o efeito de aviso identificar o que chegou depois.
        const subtitlesForLoad = rankSubtitleCandidates(
          subtitlesRef.current, selectedStream.filename ?? selectedStream.label
        ).map((subtitle) => ({
          id: subtitle.id,
          label: `${subtitle.label}${subtitle.details ? ` · ${subtitle.details}` : ""} · ${subtitle.addonName}`,
          language: subtitle.language,
          url: subtitle.url
        }));
        gate.markLoaded(subtitlesForLoad);
        cargaAtual = {
          url: selectedStream.url,
          startAtSeconds: resumeTarget,
          subtitles: subtitlesForLoad,
          defaultSubtitleId: defaultSubtitleIdRef.current
        };
        startup?.mark("loadStartedMs");
        await nativo.load(cargaAtual);
      } catch (erro) {
        if (!cancelado) {
          if (deviceResumeAttemptRef.current === selectedStream.id && retryDeviceResumeRef.current()) return;
          if (viaCasca && !tocou && selectedStream.localSessionId) {
            handlePlaybackFailureRef.current("O player da TV não abriu este arquivo. Tentando outra fonte.");
            return;
          }
          if (viaCasca && !tocou) {
            recusarAvplay(erro instanceof Error ? erro.message : "o AVPlay não abriu a fonte");
            return;
          }
          setIsPlayerLoading(false);
          returnToManualChoice("Não foi possível preparar esta fonte. Escolha outra opção na lista.");
        }
      }
    })();

    return () => {
      cancelado = true;
      window.clearInterval(vigiarFaixas);
      window.clearTimeout(revelarTimer);
      timersDasFaixas.forEach((timer) => window.clearTimeout(timer));
      // Gravar na saída, e não só de quinze em quinze: fechar o player é justamente quando a
      // pessoa para de assistir, e perder esse ponto é perder o que ela mais quer de volta.
      // Durante uma remontagem/fechamento, o GStreamer pode já ter voltado sua posição interna
      // para zero enquanto ainda conserva a duração: o tracker descarta essa leitura (zero, ou
      // abaixo do ponto de retomada ainda protegido) e grava a última válida que ele viu.
      const estadoFinal = nativo.state();
      tracker?.flush(!waitingForDownload && estadoFinal.durationSeconds > 90
        ? { positionSeconds: estadoFinal.positionSeconds, durationSeconds: estadoFinal.durationSeconds }
        : undefined);
      if (progressTrackerRef.current === tracker) progressTrackerRef.current = null;
      if (!tauriRuntime) document.documentElement.classList.remove("reproduzindo-nativo");
      void (async () => {
        try { await nativo.destroy(); }
        finally {
          if (selectedStream.localSessionId) await releaseLocalTorrent(selectedStream.localSessionId);
        }
      })().catch(() => {
        setPlayerNotice("Não foi possível encerrar a reprodução corretamente.");
      });
      setPlayerNativo(null);
      if (subtitleGateRef.current === gate) subtitleGateRef.current = null;
    };
  }, [avplayRecusou, returnToManualChoice, selectedStream, selectedVideo, startProgressSession, tauriRuntime]);

  // O ajuste de sincronia da legenda (atraso e duração extra) só chega sozinho ao player do
  // navegador; um player nativo que desenha a legenda por conta própria o recebe por aqui. O
  // `setSubtitleTiming` guarda os valores, então vale também para a legenda escolhida depois.
  useEffect(() => {
    void Promise.resolve(playerNativo?.setSubtitleTiming?.(subtitleSettings.offset, subtitleSettings.extraDuration))
      .catch(() => setPlayerNotice("Não foi possível ajustar esta legenda. Verifique se o aplicativo está atualizado."));
  }, [playerNativo, subtitleSettings.extraDuration, subtitleSettings.offset]);

  // Player do navegador (Vidstack): a sessão de salvamento nasce e fecha aqui — o efeito acima só
  // cobre os motores nativos (celular, PC/Tauri, Tizen). Fechar grava a última leitura recebida,
  // inclusive quando a fonte ou o episódio saem de cena sem passar pelo botão de fechar.
  useEffect(() => {
    if (selectedStream === null || tauriRuntime || nativePlayerDisponivel() ||
      (tizenPlayerDisponivel() && avplayRecusou !== selectedStream.id)) return;
    const sessao = selectedVideo
      ? startProgressSession(selectedVideo, selectedStream, activeSavedRef.current?.playbackScenario ?? null)
      : null;
    if (sessao === null) return;
    const tracker = criarGuardaDoPontoSalvo(sessao);
    progressTrackerRef.current = tracker;
    return () => {
      tracker.flush();
      if (progressTrackerRef.current === tracker) progressTrackerRef.current = null;
    };
  }, [avplayRecusou, selectedStream, selectedVideo, startProgressSession, tauriRuntime]);

  const closePlayer = useCallback(() => {
    episodeSelectionVersionRef.current += 1;
    const detailsUrl = consumedAutoplayUrl(window.location.href);
    if (detailsUrl !== null) window.history.replaceState(window.history.state, "", detailsUrl);
    playbackCancelled.current = true;
    deviceResumeAttemptRef.current = null;
    autoplayConsumed.current = true;
    // Fechar o player encerra qualquer busca/resolução em voo: nenhuma resposta tardia pode
    // reabrir o popup ou trocar a fonte depois que a pessoa já saiu do player.
    resolveOperation.cancel();
    searchOperation.cancel();
    // Grava a saída agora; o cleanup do efeito do player grava de novo se algo mudou até lá.
    const finalReading = currentPlaybackReading();
    progressTrackerRef.current?.flush(finalReading && finalReading.durationSeconds > 90 ? finalReading : undefined);
    player.current?.pause();
    setCortinaInicial(false);
    setDownloadNotice(null);
    setSelectedStream(null);
    setPendingAutoplayVideoId(null);
    setResolvingStreamId(null);
    setIsSearchingMore(false);
    setIsPlayerLoading(false);
    setPlayerNotice(null);
    // Sair do player encerra a sessão ativa: uma abertura seguinte (Home, card com o player
    // fechado) é sempre uma abertura do zero, que deve usar só o cenário salvo do próprio
    // episódio — nunca o que ficou tocando antes de a pessoa sair.
    previousEpisodeContinuityRef.current = null;
  }, [currentPlaybackReading, resolveOperation, searchOperation]);

  useEffect(() => onLocalStreamingStopped(event => {
    if (event.reason === "BACKGROUND" || event.id === selectedStream?.localSessionId) {
      closePlayer();
      if (event.reason === "STORAGE_LIMIT") {
        setPlayerNotice("A reprodução foi encerrada para preservar o espaço do aparelho.");
      }
    }
  }), [closePlayer, selectedStream?.localSessionId]);

  useEffect(() => {
    if (!selectedStream && resolvingStreamId === null && pendingAutoplayVideoId === null) return;
    return interceptPlaybackBack(window, closePlayer);
  }, [closePlayer, selectedStream, resolvingStreamId, pendingAutoplayVideoId]);

  const playPreviousEpisode = useCallback(() => {
    if (!previousEpisode) return;
    setPendingAutoplayVideoId(previousEpisode.id);
    selectEpisode(previousEpisode.id);
  }, [previousEpisode, selectEpisode]);

  const playNextEpisode = useCallback(() => {
    if (!nextEpisode) return;
    setPendingAutoplayVideoId(nextEpisode.id);
    selectEpisode(nextEpisode.id);
  }, [nextEpisode, selectEpisode]);

  const playAutomatically = useCallback((targetVideoId: string, fromBeginning = false) => {
    startFromBeginningRef.current = fromBeginning;
    playbackCancelled.current = false;
    // A fonte pode responder antes de GET /progress, principalmente quando ela já está pronta
    // no debrid. Nesse caso, abrir o player agora congela o handler com progresso nulo e ele
    // inevitavelmente começa do zero. Deixa o efeito abaixo continuar o mesmo pedido assim que
    // a leitura do progresso terminar.
    if (!progressLoaded || !deviceProfileLoaded) {
      setPendingAutoplayVideoId(targetVideoId);
      return;
    }
    if (targetVideoId !== videoId) {
      setPendingAutoplayVideoId(targetVideoId);
      selectEpisode(targetVideoId);
      return;
    }
    // Usa o mesmo fluxo de autoplay mesmo quando as fontes já chegaram: se só houver
    // opções manuais, o efeito abaixo abre a lista em vez de deixar o clique sem resposta.
    setPendingAutoplayVideoId(targetVideoId);
    // Voltar/bloquear cancela a descoberta. Não tratar um lote parcial como lista definitiva.
    if (localStreamingAvailable() && rememberedDeviceSource()) return;
    if (streamState === "idle" || (streamSearchIncomplete.current && !isSearchingMore)) void findStreams();
  }, [deviceProfileLoaded, findStreams, isSearchingMore, progressLoaded, rememberedDeviceSource, selectEpisode, streamState, videoId]);

  useEffect(() => {
    if (!deviceProfileLoaded || !progressLoaded || pendingAutoplayVideoId === null || videoId !== pendingAutoplayVideoId) return;
    if (scenarioRef.current === null) scenarioRef.current = activeSaved?.playbackScenario ?? null;
    const remembered = localStreamingAvailable() ? rememberedDeviceSource() : null;
    if (remembered) {
      deviceResumeAttemptRef.current = remembered.id;
      setPendingAutoplayVideoId(null);
      void selectStream(remembered, "requested");
      return;
    }
    const candidates = forThisVideo(failedStreamsRef.current.videoId === videoId
      ? streams.filter(stream => !failedStreamsRef.current.ids.has(stream.id)) : streams);
    const chosen = streamState === "ready"
      ? chooseAutoplayStream(candidates, deviceCodecs, deviceChoiceRef.current,
        rankingLanguages(editorial?.originalLanguage, scenarioRef.current),
        activeContinuity(previousEpisodeContinuityRef.current, metaIdRef.current)?.source ?? null)
      : null;
    const decision = autoplayDecision(streamState, isSearchingMore, chosen !== null);
    if (decision === "wait") return;
    setPendingAutoplayVideoId(null);
    setCortinaInicial(false);
    autoplayConsumed.current = true;
    if (decision === "play" && chosen) {
      void selectStream(chosen, "requested");
      return;
    }
    setResolutionNotice(streamState === "error"
      ? "Não foi possível buscar uma fonte automaticamente."
      : "Nenhuma fonte automática para este episódio. Escolha uma opção na lista.");
    setIsStreamModalOpen(true);
  }, [deviceProfileLoaded, activeProfileId, activeSaved, deviceCodecs, editorial?.originalLanguage, isSearchingMore, pendingAutoplayVideoId, progressLoaded, rememberedDeviceSource, selectStream, streamState, streams, videoId]);

  // A fonte lembrada do aparelho abre sem busca, para começar rápido; sem a busca, o painel "Fontes"
  // do player ficava vazio e não havia como trocar. Busca depois que o vídeo já está aberto. Título
  // editorial ainda não casado fica de fora: a busca trocaria o `videoId` com o vídeo tocando.
  useEffect(() => {
    if (!selectedStream || !localStreamingAvailable() || streamState !== "idle" || streamsVideoId.current === videoId) return;
    if (addonId === "editorial.tmdb" && editorialResolvedForRef.current !== mediaId) return;
    void findStreams();
  }, [addonId, findStreams, mediaId, selectedStream, streamState, videoId]);

  // Um addon ou uma leitura de progresso travada não pode deixar o pedido sem saída.
  useEffect(() => {
    if (pendingAutoplayVideoId === null) return;
    const timer = window.setTimeout(() => {
      closePlayer();
      setResolutionNotice("A busca demorou demais. Escolha uma fonte disponível ou tente novamente.");
      setIsStreamModalOpen(true);
    }, 45_000);
    return () => window.clearTimeout(timer);
  }, [closePlayer, pendingAutoplayVideoId]);

  useEffect(() => {
    if (!selectedStream) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      // `defaultPrevented`: na TV o Voltar já foi tratado (fechar o painel aberto do player,
      // esconder os controles…) pelo `tv-navigation.tsx`; fechar o player aqui pulava tudo isso.
      if (event.key === "Escape" && !isStreamModalOpen && !event.defaultPrevented) closePlayer();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [closePlayer, isStreamModalOpen, selectedStream]);

  if (viewState === "loading") return <main className={styles.state}>Consultando seus addons…</main>;
  if (viewState === "error" || meta === null) return <main className={styles.state}><p>Não foi possível abrir este título.</p><a href="/">Voltar</a></main>;

  const stremioLink = `stremio:///detail/${encodeURIComponent(meta.type)}/${encodeURIComponent(meta.id)}/${encodeURIComponent(videoId || meta.id)}`;

  const currentUserReview = userReviews.find((r) => r.profileId === (activeProfileId ?? "default"));
  const userAverageScore = userReviews.length > 0
    ? userReviews.reduce((sum, r) => sum + r.ratingScore, 0) / userReviews.length
    : null;

  // TV: episódio atual primeiro na fileira, pra zona já focar nele ao entrar (descendo dos
  // botões) em vez do primeiro da lista. Mesmo dado de sempre (`visibleEpisodes`), só a ordem
  // de exibição muda — nenhuma consulta nova, nenhum estado novo.
  const tvCurrentIndex = tvLayout ? visibleEpisodes.findIndex((video) => video.id === videoId) : -1;
  const tvOrderedEpisodes = tvCurrentIndex > 0
    ? [visibleEpisodes[tvCurrentIndex], ...visibleEpisodes.slice(0, tvCurrentIndex), ...visibleEpisodes.slice(tvCurrentIndex + 1)]
    : visibleEpisodes;

  // Conteúdo de dentro do popup de fontes: o mesmo em PC/celular e TV (mesmos avisos de
  // dublado/codec/"ainda não está pronta", cota diária, "Buscando mais opções…"). Só o contêiner
  // muda (ver abaixo) — na TV ele vira lista de itens altos por CSS (`.streamGrid` em coluna),
  // sem precisar duplicar esta marcação.
  const streamModalInner = (
    <>
      <button type="button" className={styles.modalClose} onClick={closeStreamModal} aria-label="Fechar">×</button>
      <h2>Escolher opção de reprodução</h2>
      <p className={styles.manualChoiceHint}>Escolha a origem, a qualidade e depois o arquivo exato.</p>
      <a href={stremioLink} className={styles.modalStremioLink}>Abrir este título no app Stremio</a>

      <div className={styles.qualityChooser}>
        <strong>Fonte com cota diária</strong>
        <div className={styles.qualityOptions}>
          <button
            type="button"
            className={styles.qualityOption}
            disabled={orionConsulted || streamState === "loading" || resolvingStreamId !== null}
            onClick={() => void findStreams(true)}
          >
            <span>{orionConsulted ? "Orion já consultado" : "Consultar Orion"}</span>
            <small>
              Só este clique consulta o Orion. Abrir a lista e consultar as outras fontes não gastam a cota.
            </small>
          </button>
        </div>
      </div>

      {streamState === "loading" ? <p className={styles.modalLoading}>Consultando seus addons…</p> : null}
      {streamState === "ready" && isSearchingMore ? <p className={styles.modalLoading}>Buscando mais opções…</p> : null}
      {streamState === "empty" ? <p className={styles.notice}>Nenhuma opção de reprodução foi encontrada nos seus addons.</p> : null}
      {streamState === "error" ? <p className={styles.notice}>Um addon não respondeu de forma segura. Você ainda pode abrir o título no aplicativo Stremio.</p> : null}
      {sourceNotice ? <p className={styles.notice}>{sourceNotice}</p> : null}
      {resolutionNotice ? <p className={styles.notice}>{resolutionNotice}</p> : null}

      {streamState === "ready" ? (
        <div className={styles.modalGroups} onKeyDown={handleOptionsNavigation}>
          {groupStreamsForManualChoice(streams).map((group) => (
            <section className={styles.streamGroup} key={group.addonId}>
              <h3>{group.label}</h3>
              {group.qualities.map((quality) => (
                <div className={styles.streamQualityGroup} key={quality.label}>
                  <h4>{quality.label}</h4>
                  <div className={styles.streamGrid}>
                    {quality.streams.map((stream) => {
                      const metaLine = streamMetaLine(stream);
                      return (
                        <button
                          type="button"
                          className={styles.streamOption}
                          data-stream-option
                          key={stream.id}
                          onClick={() => selectStream(stream, "manual")}
                          disabled={resolvingStreamId !== null}
                        >
                          <strong>{resolvingStreamId === stream.id ? "Preparando no Real-Debrid…" : stream.label}</strong>
                          <span className={styles.streamAddon}>
                            {stream.quality ?? "Qualidade não informada"}
                            {stream.readyNow === true ? " · RD+ pronta" : ""}
                          </span>
                          {metaLine ? <span className={styles.streamMeta}>{metaLine}</span> : null}
                          {stream.kind === "torrent" ? <span className={styles.streamMeta}>{localStreamingAvailable() ? "Torrent baixado neste aparelho." : "Será resolvido pelo Real-Debrid."}</span> : null}
                          {stream.audioLanguages && stream.audioLanguages.length > 0 ? (
                            <span className={styles.streamMeta}>
                              Áudio: {stream.audioLanguages.map(languageName).join(", ")}
                            </span>
                          ) : null}
                          {stream.dubbed ? (
                            <span className={styles.streamWarning}>Dublado — o áudio padrão pode não ser o original.</span>
                          ) : null}
                          {playbackWarning(stream, deviceCodecs) !== null ? (
                            <span className={styles.streamWarning}>{playbackWarning(stream, deviceCodecs)}</span>
                          ) : null}
                          {stream.readyNow === false ? (
                            <span className={styles.streamWarning}>Ainda não está pronta — vai precisar baixar antes de tocar.</span>
                          ) : null}
                          {mismatchReason(stream) ? (
                            <span className={styles.streamWarning}>Parece ser de {mismatchReason(stream)} — não entra na escolha automática.</span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </section>
          ))}
        </div>
      ) : null}
    </>
  );

  // Conteúdo de dentro do modal de avaliação — igual em todo layout, só o contêiner externo
  // muda (ver abaixo, o mesmo truque do <details> do popup de fontes).
  const reviewModalInner = (
    <>
      <button
        type="button"
        className={styles.reviewModalClose}
        onClick={() => setIsReviewModalOpen(false)}
        aria-label="Fechar modal de avaliação"
      >
        ×
      </button>

      <div className={styles.reviewModalHeader}>
        <h2 className={styles.reviewModalTitle}>
          {(editorial?.title ?? meta.name).toLocaleUpperCase("pt-BR")}
        </h2>
        <p className={styles.reviewModalSubtitle}>
          {[
            editorial?.directors?.[0] ?? "",
            editorial?.year ?? meta.releaseInfo?.slice(0, 4) ?? ""
          ].filter(Boolean).join(" ")}
        </p>
      </div>

      <div className={styles.reviewRatingSection}>
        <span className={styles.reviewRatingLabel}>Avaliar</span>
        <div className={styles.reviewStarsPicker} role="radiogroup" aria-label="Nota de 1 a 5 estrelas">
          {[1, 2, 3, 4, 5].map((star) => {
            const isFilled = (hoverStars || selectedStars) >= star;
            return (
              <button
                type="button"
                key={star}
                className={`${styles.reviewStarBtn} ${isFilled ? styles.reviewStarFilled : ""}`}
                onMouseEnter={() => setHoverStars(star)}
                onMouseLeave={() => setHoverStars(0)}
                onClick={() => setSelectedStars(star)}
                aria-label={`${star} de 5 estrelas`}
                title={`${star * 2} de 10`}
              >
                <svg
                  width="32"
                  height="32"
                  viewBox="0 0 24 24"
                  fill={isFilled ? "#f59e0b" : "none"}
                  stroke={isFilled ? "#f59e0b" : "#9ca3af"}
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
              </button>
            );
          })}
        </div>
        {selectedStars > 0 ? (
          <span className={styles.reviewScoreIndicator}>
            <strong>{selectedStars * 2}</strong>/10
          </span>
        ) : null}
      </div>

      <div className={styles.reviewTextSection}>
        <textarea
          className={styles.reviewTextarea}
          placeholder="Adicionar uma crítica?"
          maxLength={600}
          value={reviewComment}
          onChange={(e) => setReviewComment(e.target.value)}
          rows={5}
        />
      </div>

      <div className={styles.reviewModalFooter}>
        <span className={styles.reviewCharCount}>
          {600 - reviewComment.length} caracteres restantes
        </span>
        <button
          type="button"
          className={styles.reviewSaveBtn}
          disabled={selectedStars === 0}
          onClick={handleSaveReview}
        >
          SALVAR
        </button>
      </div>
    </>
  );

  // "Avaliações dos usuários" ou "Nossa opinião": na TV mora na aba Detalhes (a Visão geral
  // fica só com o essencial); no PC/celular continua sendo a 3ª coluna do herói.
  const opinionContent = (
    <>
      {userReviews.length > 0 ? (
        <>
          <h3 className={styles.mubiColHeading}>AVALIAÇÕES DOS USUÁRIOS</h3>
          <div className={styles.mubiReviewCard}>
            <div className={styles.mubiReviewMeta}>
              <span className={styles.mubiReviewAuthor}>
                {userReviews[0].profileName}
              </span>
              <span className={styles.mubiReviewStars}>
                {"★".repeat(userReviews[0].ratingStars)}{"☆".repeat(5 - userReviews[0].ratingStars)}
                <strong className={styles.mubiReviewScore}> {userReviews[0].ratingScore.toFixed(1)}/10</strong>
              </span>
            </div>
            {userReviews[0].comment ? (
              <p className={styles.mubiReviewComment}>"{userReviews[0].comment}"</p>
            ) : (
              <p className={styles.mubiReviewCommentMuted}>Avaliado com {userReviews[0].ratingStars} de 5 estrelas.</p>
            )}
            {userReviews.length > 1 ? (
              <span className={styles.mubiReviewCountNote}>
                + {userReviews.length - 1} {userReviews.length - 1 === 1 ? "outra avaliação" : "outras avaliações"} de usuários
              </span>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <h3 className={styles.mubiColHeading}>NOSSA OPINIÃO</h3>
          <p className={styles.mubiOpinionText}>
            {editorial?.cast?.length ? (
              <>
                Com <strong>{editorial.cast.slice(0, 3).map((c) => c.name).join(", ")}</strong>.
                {editorial?.tagline ? ` ${editorial.tagline}.` : ""} Obra aclamada selecionada para a sua experiência cinematográfica.
              </>
            ) : editorial?.tagline ? (
              editorial.tagline
            ) : (
              "Excelente opção no catálogo, com alta fidelidade de imagem e som para a sua casa."
            )}
          </p>
        </>
      )}
    </>
  );

  return (
    <main className={styles.page} data-tv-tab={tvLayout ? tvTab : undefined} data-tv-fixed={tvLayout ? "" : undefined}>
      {meta.background || editorial?.backdropUrl ? (
        <div
          className={styles.heroBackdrop}
          aria-hidden="true"
          style={{
            // A primeira arte é parte da escolha visual do catálogo Stremio. O TMDB complementa
            // dados e só fornece imagem se o addon não tiver nenhuma — nunca troca a tela depois.
            backgroundImage: `linear-gradient(90deg, rgba(22,24,29,0.42) 0%, rgba(22,24,29,0.12) 72%, rgba(22,24,29,0.32) 100%), linear-gradient(0deg, #16181d 0%, rgba(22,24,29,0.9) 20%, rgba(22,24,29,0.18) 70%), url(${meta.background || editorial?.backdropUrl})`
          }}
        />
      ) : null}
      {playTeaser && teaserId ? (
        <div className={styles.heroTeaser}>
          <TeaserFrame
            videoId={teaserId}
            label={`Trailer de ${meta.name}`}
            sound={teaserSound}
            showControls={false}
          />
        </div>
      ) : null}
      <section
        className={`${styles.mubiHeroSection} ${isUiHidden ? styles.mubiHeroSectionHidden : ""}`}
        onClick={() => setIsUiHidden((v) => !v)}
        // TV: sem zona aqui — o Voltar, as ações e as abas (dentro desta seção) têm zona
        // própria cada um, na ordem da tela: ↑/↓ andam entre eles.
      >
        {/* Top Header - Apenas voltar e a Nota */}
        <header className={styles.mubiHeader} onClick={(e) => e.stopPropagation()} data-tv-zone={tvLayout ? "voltar" : undefined}>
          <div className={styles.mubiHeaderLeft}>
            <a href="/" className={styles.mubiBackBtn} aria-label="Voltar para a página inicial" title="Voltar ao início">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <line x1="19" y1="12" x2="5" y2="12" />
                <polyline points="12 19 5 12 12 5" />
              </svg>
            </a>
          </div>

          <div className={styles.mubiHeaderRight}>
            {editorial?.voteAverage !== null && editorial?.voteAverage !== undefined ? (
              <div className={styles.mubiRatingBadge}>
                <div className={styles.mubiRatingScore}>
                  <span className={styles.mubiStar}>★</span>
                  <strong>
                    {userAverageScore !== null
                      ? userAverageScore.toFixed(1)
                      : editorial.voteAverage.toFixed(1)}
                  </strong>
                  <span className={styles.mubiRatingMax}>/10</span>
                </div>
                <span className={styles.mubiRatingVotes}>
                  {userReviews.length > 0
                    ? `${userReviews.length.toLocaleString("pt-BR")} ${userReviews.length === 1 ? "Avaliação" : "Avaliações"}`
                    : editorial.voteCount
                      ? `${editorial.voteCount.toLocaleString("pt-BR")} Avaliações`
                      : "Avaliações"}
                </span>
              </div>
            ) : null}
          </div>
        </header>

        {/* Bottom Area: Title on top, 3-Column Info Row below (Aligned at same top baseline) */}
        <div className={styles.mubiHeroBottom} onClick={(e) => e.stopPropagation()}>
          {/* Pôster retrato: só aparece no layout mobile, onde o backdrop vira fundo desfocado. */}
          {meta.poster ? (
            <img
              className={styles.mubiPoster}
              src={meta.poster}
              alt=""
              loading="eager"
              decoding="async"
            />
          ) : null}
          {/* Title Area (Above Column 1) */}
          <div className={styles.mubiTitleArea}>
            <div className={styles.mubiEyebrow}>
              {editorial?.tagline ? editorial.tagline.toLocaleUpperCase("pt-BR") : `DESTAQUE CEBOLA · ${meta.type === "movie" ? "FILME" : "SÉRIE"}`}
            </div>

            {titleLogo && !tvLayout ? (
              <div className={styles.mubiTitleLogoWrapper}>
                <img
                  className={styles.mubiTitleLogo}
                  src={titleLogo}
                  alt={meta.name}
                  onError={() => setTitleLogoError(true)}
                />
                <h1 className="sr-only">{meta.name}</h1>
              </div>
            ) : (
              <h1 className={styles.mubiTitle}>{meta.name}</h1>
            )}

            {editorial?.originalTitle && editorial.originalTitle.toLowerCase() !== meta.name.toLowerCase() ? (
              <p className={styles.mubiOriginalTitle}>{editorial.originalTitle.toLocaleUpperCase("pt-BR")}</p>
            ) : null}

            {/* TV: linha única logo abaixo do nome, como a referência (★ nota · ano ·
                classificação · duração), com os selos de imagem/som no fim. */}
            {tvLayout ? (
              <p className={styles.tvMetaLine}>
                {editorial?.voteAverage !== null && editorial?.voteAverage !== undefined ? (
                  <span className={styles.tvMetaStar}>★ {(userAverageScore ?? editorial.voteAverage).toFixed(1)}</span>
                ) : null}
                {editorial?.year ?? meta.releaseInfo?.slice(0, 4) ? <span>{editorial?.year ?? meta.releaseInfo?.slice(0, 4)}</span> : null}
                <span className={styles.tvMetaBox}>14</span>
                {runtimeLabel(editorial?.runtimeMinutes ?? null) ? <span>{runtimeLabel(editorial?.runtimeMinutes ?? null)}</span> : null}
                <span className={styles.tvMetaBox}>4K</span>
                <span className={styles.tvMetaBox}>5.1</span>
              </p>
            ) : null}
          </div>

          {/* 3-Column Information Grid: Column 1, 2 and 3 all start at the exact same horizontal top line */}
          <div className={styles.mubiBottomGrid}>
            {/* Column 1: Credits, Badges, Audio/Subs, Actions */}
            <div className={styles.mubiColMain}>
              {/* TV: créditos no formato "Rótulo: valor" da referência — rótulo apagado, valor
                  em branco. Substitui (só por CSS) os créditos, o país/ano e o áudio/legenda. */}
              {tvLayout ? (
                <dl className={styles.tvCredits}>
                  {editorial?.directors.length ? (
                    <div><dt>Direção:</dt><dd>{editorial.directors.join(", ")}</dd></div>
                  ) : editorial?.creators.length ? (
                    <div><dt>Criação:</dt><dd>{editorial.creators.join(", ")}</dd></div>
                  ) : null}
                  {editorial?.cast.length ? (
                    <div><dt>Estrelando:</dt><dd>{editorial.cast.slice(0, 3).map((person) => person.name).join(", ")}</dd></div>
                  ) : null}
                  {(editorial?.genres ?? meta.genres ?? []).length > 0 ? (
                    <div><dt>Gêneros:</dt><dd>{(editorial?.genres ?? meta.genres ?? []).slice(0, 3).join(", ")}</dd></div>
                  ) : null}
                  {editorial?.countries.length ? (
                    <div><dt>País:</dt><dd>{editorial.countries.slice(0, 2).join(", ")}</dd></div>
                  ) : null}
                  <div>
                    {editorial?.originalLanguage ? <><dt>Áudio:</dt><dd>{languageName(editorial.originalLanguage)}</dd></> : null}
                    <dt>Legenda:</dt><dd>Português (SDH)</dd>
                  </div>
                </dl>
              ) : null}
              <div className={styles.mubiCreditsText}>
              {editorial?.directors.length ? (
                <p className={styles.mubiDirector}>
                  Dirigido por <strong>{editorial.directors.join(", ")}</strong>
                </p>
              ) : editorial?.creators.length ? (
                <p className={styles.mubiDirector}>
                  Criado por <strong>{editorial.creators.join(", ")}</strong>
                </p>
              ) : null}

              {type === "movie" && allSaved.some((item) => item.watched ?? item.completed) ? (
                <p className={styles.mubiOriginYear} aria-label="Assistido">✓ Assistido</p>
              ) : null}
              <p className={styles.mubiOriginYear}>
                {[
                  editorial?.countries.slice(0, 2).join(", "),
                  editorial?.year ?? meta.releaseInfo?.slice(0, 4)
                ].filter(Boolean).join(", ")}
              </p>

              {(editorial?.genres ?? meta.genres ?? []).length > 0 ? (
                <p className={styles.mubiGenres}>
                  {(editorial?.genres ?? meta.genres ?? []).slice(0, 3).join(", ")}
                </p>
              ) : null}
            </div>

            {/* Badges Monocromáticos */}
            <div className={styles.mubiTechBadges}>
              <span className={styles.mubiBadge}>4K</span>
              <span className={styles.mubiBadge}>5.1</span>
              {editorial?.runtimeMinutes ? (
                <span className={styles.mubiBadge}>{editorial.runtimeMinutes} min</span>
              ) : null}
              <span className={styles.mubiBadgeRating}>14</span>
            </div>

            {/* Audio & Subtitles (Monocromático e Limpo) */}
            <div className={styles.mubiAudioSubs}>
              {editorial?.originalLanguage ? (
                <span className={styles.mubiMetaItem}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  </svg>
                  {languageName(editorial.originalLanguage)}
                </span>
              ) : null}
              <span className={styles.mubiMetaItem}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                Português (SDH)
              </span>
            </div>

            {/* Play em destaque: só aparece no layout mobile, onde o pôster e as ações somem
                o herói de tela cheia — sem ele não haveria um "assistir" óbvio no card. */}
            <div className={styles.mubiMobilePrimaryActions}>
              <button
                type="button"
                className={`btn btn-primary ${styles.mubiPlayBtn}`}
                onClick={() => playAutomatically(videoId, false)}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
                <span>{streamState === "loading" ? "Preparando…" : hasProgress ? "Continuar" : "Assistir"}</span>
              </button>
              <button
                type="button"
                className={styles.mubiMobileLibraryBtn}
                onClick={toggleLibrary}
                aria-pressed={savedToLibrary}
              >
                <span aria-hidden="true">{savedToLibrary ? "✓" : "+"}</span>
                <span>{savedToLibrary ? "Na minha lista" : "Minha lista"}</span>
              </button>
            </div>

            {/* Action Buttons (Estilo MUBI Monocromático) */}
            <div className={styles.mubiActionButtons}>
              <button
                type="button"
                className={`${styles.mubiCircleBtn} ${currentUserReview ? styles.mubiCircleBtnRated : ""}`}
                onClick={() => setIsReviewModalOpen(true)}
                title={currentUserReview ? `Sua nota: ${currentUserReview.ratingStars}/5 estrelas (${currentUserReview.ratingScore}/10). Clique para editar.` : "Avaliar filme"}
                aria-label={currentUserReview ? "Editar avaliação" : "Avaliar filme"}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill={currentUserReview ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
                <span className={styles.mubiBtnLabel}>Avaliar</span>
              </button>

              <button
                type="button"
                ref={streamButtonRef}
                className={styles.mubiCircleBtn}
                onClick={() => openStreamModal(false)}
                title="Escolher fonte de transmissão"
                aria-label="Escolher fonte de transmissão"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="8" y1="6" x2="21" y2="6" />
                  <line x1="8" y1="12" x2="21" y2="12" />
                  <line x1="8" y1="18" x2="21" y2="18" />
                  <line x1="3" y1="6" x2="3.01" y2="6" />
                  <line x1="3" y1="12" x2="3.01" y2="12" />
                  <line x1="3" y1="18" x2="3.01" y2="18" />
                </svg>
                <span className={styles.mubiBtnLabel}>Fonte</span>
              </button>

              <button
                type="button"
                className={`${styles.mubiCircleBtn} ${styles.mubiDesktopLibraryBtn} ${savedToLibrary ? styles.mubiCircleBtnActive : ""}`}
                onClick={toggleLibrary}
                title={savedToLibrary ? "Remover da biblioteca" : "Salvar na biblioteca"}
                aria-label={savedToLibrary ? "Remover da biblioteca" : "Salvar na biblioteca"}
              >
                {savedToLibrary ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                )}
                <span className={styles.mubiBtnLabel}>{savedToLibrary ? "Na Lista" : "Minha Lista"}</span>
              </button>

              {teaserId ? (
                <button
                  type="button"
                  className={`${styles.mubiCircleBtn} ${teaserSound ? styles.mubiCircleBtnActive : ""}`}
                  onClick={() => setTeaserSound((s) => !s)}
                  title={teaserSound ? "Silenciar áudio do trailer de fundo" : "Ativar áudio do trailer de fundo"}
                  aria-label={teaserSound ? "Silenciar trailer" : "Ativar áudio do trailer"}
                >
                  {teaserSound ? (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                    </svg>
                  ) : (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                      <line x1="23" y1="9" x2="17" y2="15" />
                      <line x1="17" y1="9" x2="23" y2="15" />
                    </svg>
                  )}
                  <span className={styles.mubiBtnLabel}>{teaserSound ? "Som" : "Mudo"}</span>
                </button>
              ) : null}

              {meta.videos.length > 1 ? (
                <a
                  href="#episodios"
                  className={styles.mubiCircleBtn}
                  title="Ver lista de episódios"
                  aria-label="Ver episódios"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
                    <line x1="7" y1="2" x2="7" y2="22" />
                    <line x1="17" y1="2" x2="17" y2="22" />
                    <line x1="2" y1="12" x2="22" y2="12" />
                  </svg>
                  <span className={styles.mubiBtnLabel}>Episódios</span>
                </a>
              ) : null}
            </div>

            {/* TV: uma fileira só de botões grandes (pedido do plano de TV), substituindo os
                círculos pequenos acima (esses somem por CSS só quando `data-tv-layout`). Mesmos
                dados/handlers de sempre — só o tamanho e o agrupamento mudam pro controle remoto. */}
            {tvLayout ? (
              <div className={styles.tvActionsRow} data-tv-zone="acoes">
                <button
                  type="button"
                  onClick={() => playAutomatically(videoId, false)}
                  disabled={streamState === "loading"}
                  className={styles.tvBigButton}
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                  <span>
                    {streamState === "loading"
                      ? "Consultando…"
                      : hasProgress && activeSaved
                        ? `Continuar (${formatProgressTime(activeSaved.positionSeconds)})`
                        : "Assistir"}
                  </span>
                </button>

                {hasProgress ? (
                  <button
                    type="button"
                    onClick={() => playAutomatically(videoId, true)}
                    disabled={streamState === "loading"}
                    className={styles.tvBigButton}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="1 4 1 10 7 10" />
                      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                    </svg>
                    <span>Assistir do início</span>
                  </button>
                ) : null}

                {/* Na TV o botão "Fonte" do layout normal fica escondido; sem este, a única troca
                    de fonte era pelo player, e lá a aba some enquanto a lista está vazia. */}
                <button
                  type="button"
                  onClick={() => openStreamModal(false)}
                  className={styles.tvBigButton}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="8" y1="6" x2="21" y2="6" />
                    <line x1="8" y1="12" x2="21" y2="12" />
                    <line x1="8" y1="18" x2="21" y2="18" />
                    <line x1="3" y1="6" x2="3.01" y2="6" />
                    <line x1="3" y1="12" x2="3.01" y2="12" />
                    <line x1="3" y1="18" x2="3.01" y2="18" />
                  </svg>
                  <span>Fontes</span>
                </button>

                <button
                  type="button"
                  onClick={toggleLibrary}
                  disabled={activeProfileId === null}
                  className={styles.tvBigButton}
                  aria-pressed={savedToLibrary}
                >
                  <span aria-hidden="true">{savedToLibrary ? "✓" : "+"}</span>
                  <span>{savedToLibrary ? "Na minha lista" : "Minha lista"}</span>
                </button>

                <button
                  type="button"
                  onClick={() => setIsReviewModalOpen(true)}
                  className={styles.tvBigButton}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill={currentUserReview ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                  </svg>
                  <span>Avaliar</span>
                </button>

              </div>
            ) : null}

            {/* Mesmo "Progresso salvo" da parte de baixo, trazido pra Visão geral na TV (lá
                embaixo virou painel de aba e ele sumiria da tela principal). */}
            {tvLayout && hasProgress && activeSaved ? (
              <div className={`${styles.progressCard} ${styles.tvProgress}`}>
                <div className={styles.progressHeader}>
                  <span className={styles.progressTag}>Progresso Salvo</span>
                  <span className={styles.progressTime}>
                    Parou em {formatProgressTime(activeSaved.positionSeconds)}
                    {activeSaved.durationSeconds ? ` de ${formatProgressTime(activeSaved.durationSeconds)}` : ""}
                  </span>
                </div>
                <div className={styles.progressBarBg}>
                  <div className={styles.progressBarFill} style={{ width: `${progressPercent}%` }} />
                </div>
              </div>
            ) : null}

            {libraryNotice ? (
              <div className={styles.libraryNotice} role="alert">
                <p>{libraryNotice.message}</p>
                <div className={styles.libraryNoticeActions}>
                  <button type="button" onClick={() => {
                    const retry = libraryNotice.retry;
                    setLibraryNotice(null);
                    retry();
                  }}>
                    Tentar novamente
                  </button>
                  <button type="button" onClick={() => setLibraryNotice(null)}>Dispensar</button>
                </div>
              </div>
            ) : null}
          </div>

          {/* Column 2: Sinopse */}
          <div className={styles.mubiColSynopsis}>
            <h3 className={styles.mubiColHeading}>SINOPSE</h3>
            <p className={styles.mubiSynopsisText}>
              {editorial?.overview || meta.description || "Nenhuma sinopse fornecida para esta obra."}
            </p>
          </div>

          {/* Column 3: Curadoria / Avaliações dos Usuários */}
          <div className={styles.mubiColOpinion}>
            {opinionContent}
          </div>
        </div>
      </div>
    </section>

      <div id="detalhes-completos" className={styles.lowerContent}>
        <section className={styles.details}>
          <div className={styles.info}>

          {meta.videos.length > 1 ? (
            <div className={styles.episodeContainer} id={tvLayout ? "tv-episodios" : undefined}>
              <div className={styles.sectionHead}>
                <p className={styles.sectionKicker}>Episódios</p>
                <span className={styles.sectionCount}>
                  {selectedSeason !== null ? `Temporada ${selectedSeason} · ` : ""}
                  {visibleEpisodes.length} {visibleEpisodes.length === 1 ? "episódio" : "episódios"}
                </span>
              </div>
              {seasons.length > 1 ? (
                <div
                  className={styles.seasonTabs}
                  aria-label="Selecionar temporada"
                  // TV: fileira de pílulas própria (plano pede "temporadas (pílulas)" como zona
                  // separada da fileira de episódios, pra ↑/↓ não misturar as duas).
                  data-tv-zone={tvLayout ? "temporadas" : undefined}
                >
                  {seasons.map((season) => (
                    <button
                      type="button"
                      className={season === selectedSeason ? styles.seasonTabActive : styles.seasonTab}
                      onClick={() => setSelectedSeason(season)}
                      key={season}
                      aria-current={season === selectedSeason}
                    >Temporada {season}</button>
                  ))}
                </div>
              ) : null}
              <div
                className={styles.episodeGrid}
                role="list"
                aria-label="Episódios disponíveis"
                data-tv-zone={tvLayout ? "episodios" : undefined}
              >
                {/* TV: episódio atual primeiro (`tvOrderedEpisodes`), pra zona focar nele ao
                    entrar; PC/celular seguem a ordem de sempre (`visibleEpisodes`). */}
                {(tvLayout ? tvOrderedEpisodes : visibleEpisodes).map((video) => {
                  const itemProgress = allSaved.find((item) => item.videoId === video.id);
                  const watched = allSaved.some((item) => item.videoId === video.id && (item.watched ?? item.completed));
                  const partial = itemProgress !== undefined && !itemProgress.completed &&
                    itemProgress.positionSeconds > 10;
                  const percent = partial && itemProgress.durationSeconds
                    ? Math.min(100, (itemProgress.positionSeconds / itemProgress.durationSeconds) * 100)
                    : null;
                  const shownEpisode = displayNumber(video);
                  const number = shownEpisode !== null ? `E${shownEpisode}` : "▶";
                  const artworkSources = [...new Set([video.thumbnail, meta.background, meta.poster]
                    .filter((source): source is string => source !== null && source !== undefined))];
                  // Uma linha de texto só. "Disponível para assistir" repetido em cada cartão não
                  // informa nada: a ausência de marca já é o estado normal. Quando há progresso,
                  // essa linha vira a única coisa que interessa — onde a pessoa parou.
                  const legenda = partial
                    ? `Retomar em ${formatProgressTime(itemProgress.positionSeconds)}`
                    : shortDate(video.released);
                  return (
                    <button
                      type="button"
                      className={video.id === videoId ? styles.episodeCardActive : styles.episodeCard}
                      onClick={() => playAutomatically(video.id)}
                      key={video.id}
                      role="listitem"
                      aria-current={video.id === videoId}
                    >
                      <span className={styles.episodeFrame}>
                        {artworkSources[0] ? (
                          <img
                            src={artworkSources[0]}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            referrerPolicy="no-referrer"
                            data-artwork-index="0"
                            onError={(event) => {
                              const image = event.currentTarget;
                              const nextIndex = Number(image.dataset.artworkIndex ?? 0) + 1;
                              const next = artworkSources[nextIndex];
                              if (next) {
                                image.dataset.artworkIndex = String(nextIndex);
                                image.src = next;
                              } else image.style.display = "none";
                            }}
                          />
                        ) : null}
                        <span className={styles.episodeBadge}>{number}</span>
                        {watched ? <span className={styles.episodeWatched} aria-label="Assistido">✓</span> : null}
                        {percent !== null ? (
                          <span className={styles.episodeProgress} aria-hidden="true">
                            <i style={{ width: `${percent}%` }} />
                          </span>
                        ) : null}
                      </span>
                      <span className={styles.episodeCaption}>
                        <strong>{video.title}</strong>
                        {legenda ? <span>{legenda}</span> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : meta.type === "series" && streamState === "loading" ? (
            <div className={styles.episodeContainer} aria-label="Carregando episódios" aria-busy="true">
              <div className={styles.sectionHead}>
                <span className={`${styles.episodeSkeletonLine} ${styles.episodeSkeletonHeading}`} />
                <span className={styles.episodeSkeletonLine} />
              </div>
              <div className={styles.episodeGrid}>
                {[0, 1, 2].map((item) => (
                  <div className={styles.episodeSkeletonCard} key={item}>
                    <span className={styles.episodeSkeletonFrame} />
                    <span className={styles.episodeSkeletonLine} />
                    <span className={`${styles.episodeSkeletonLine} ${styles.episodeSkeletonShort}`} />
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* Visual Watch Progress Card */}
          {hasProgress && activeSaved ? (
            <div className={styles.progressCard}>
              <div className={styles.progressHeader}>
                <span className={styles.progressTag}>Progresso Salvo</span>
                <span className={styles.progressTime}>
                  Parou em {formatProgressTime(activeSaved.positionSeconds)}
                  {activeSaved.durationSeconds ? ` de ${formatProgressTime(activeSaved.durationSeconds)}` : ""}
                </span>
              </div>
              <div className={styles.progressBarBg}>
                <div
                  className={styles.progressBarFill}
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          ) : null}

          <div className={styles.actions}>
            {/* Assistir */}
            <button
              ref={streamButtonRef}
              onClick={() => playAutomatically(videoId, false)}
              disabled={streamState === "loading"}
              className={styles.primaryButton}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              <span>
                {streamState === "loading"
                  ? "Consultando…"
                  : hasProgress && activeSaved
                    ? `Continuar (${formatProgressTime(activeSaved.positionSeconds)})`
                    : "Assistir"}
              </span>
            </button>

            <button
              type="button"
              onClick={toggleLibrary}
              disabled={activeProfileId === null}
              className={styles.secondaryButton}
              aria-pressed={savedToLibrary}
            >
              <span aria-hidden="true">{savedToLibrary ? "✓" : "+"}</span>
              <span>{savedToLibrary ? "Na minha lista" : "Adicionar à lista"}</span>
            </button>

            {/* If has progress, allow watching from beginning */}
            {hasProgress ? (
              <button
                type="button"
                onClick={() => playAutomatically(videoId, true)}
                disabled={streamState === "loading"}
                className={styles.secondaryButton}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="1 4 1 10 7 10" />
                  <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                </svg>
                <span>Assistir do início</span>
              </button>
            ) : null}
          </div>
        </div>
      </section>

      {editorial ? (
        <section className={styles.editorialSections} aria-label="Informações editoriais">
          {tvLayout ? <div className={styles.tvOpinion}>{opinionContent}</div> : null}
          <div className={styles.factPanel}>
            <div className={styles.sectionHead}>
              <p className={styles.sectionKicker}>{editorial.type === "movie" ? "FICHA DO FILME" : "FICHA DA SÉRIE"}</p>
            </div>
            <div className={styles.factGrid}>
              <div><span>Título original</span><strong>{editorial.originalTitle ?? editorial.title}</strong></div>
              <div><span>Ano</span><strong>{editorial.year ?? "Não informado"}</strong></div>
              <div><span>Duração</span><strong>{runtimeLabel(editorial.runtimeMinutes) ?? "Não informada"}</strong></div>
              <div><span>País</span><strong>{editorial.countries.join(", ") || "Não informado"}</strong></div>
              <div><span>Idioma original</span><strong>{editorial.originalLanguage?.toUpperCase() ?? "Não informado"}</strong></div>
              <div><span>Avaliação TMDB</span><strong>{editorial.voteAverage !== null ? `${editorial.voteAverage.toFixed(1)} / 10` : "Sem avaliação"}</strong></div>
            </div>
          </div>

          {editorial.cast.length ? (
            <div className={styles.peopleSection} data-tv-zone={tvLayout ? "elenco" : undefined}>
              <div className={styles.sectionHead}>
                <p className={styles.sectionKicker}>ELENCO E EQUIPE</p>
                <span className={styles.sectionCount}>{editorial.cast.length} pessoas</span>
              </div>
              <div className={styles.peopleRail}>
                {editorial.cast.slice(0, 12).map((person) => (
                  // TV: sem link nenhum aqui (nunca teve, no PC também), mas precisa ser
                  // alcançável pelo controle pra fileira poder rolar — daí o tabIndex só na TV.
                  <article className={styles.personCard} key={person.id} tabIndex={tvLayout ? 0 : undefined}>
                    {person.profileUrl ? <img src={person.profileUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <div className={styles.personFallback} aria-hidden="true">{person.name[0]}</div>}
                    <span className={styles.personBody}>
                      <strong>{person.name}</strong>
                      {person.character ? <span>{person.character}</span> : null}
                    </span>
                  </article>
                ))}
              </div>
            </div>
          ) : null}

          {Object.values(editorial.availability).some((value) => Array.isArray(value) && value.length > 0) ? (
            <div className={styles.providerSection} data-tv-zone={tvLayout ? "onde-assistir" : undefined}>
              <div className={styles.sectionHead}>
                <p className={styles.sectionKicker}>ONDE ASSISTIR NO BRASIL</p>
                <span className={styles.sectionCount}>Fonte: JustWatch</span>
              </div>
              {([
                ["subscription", "Assinatura"], ["free", "Grátis"], ["ads", "Com anúncios"],
                ["rent", "Aluguel"], ["buy", "Compra"]
              ] as const).map(([key, label]) => editorial.availability[key].length ? (
                <div className={styles.providerRow} key={key}>
                  <strong>{label}</strong>
                  <div>
                    {editorial.availability[key].map((provider) => (
                      <span className={styles.provider} key={`${key}-${provider.id}`}>
                        {provider.logoUrl ? <img src={provider.logoUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : null}
                        {provider.name}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null)}
              <p className={styles.providerCredit}>
                Dados de disponibilidade fornecidos por JustWatch.
                {editorial.availability.link ? <a href={editorial.availability.link} target="_blank" rel="noreferrer"> Ver opções no TMDB</a> : null}
              </p>
            </div>
          ) : null}

          {editorial.recommendations.length ? (
            <div className={styles.recommendationSection} data-tv-zone={tvLayout ? "recomendados" : undefined}>
              <div className={styles.sectionHead}>
                <p className={styles.sectionKicker}>TÍTULOS SEMELHANTES</p>
                <span className={styles.sectionCount}>{editorial.recommendations.length} títulos</span>
              </div>
              <div className={styles.recommendationRail}>
                {editorial.recommendations.slice(0, 10).map((item) => (
                  <a
                    className={styles.recommendationCard}
                    href={`${appPagePath("titulo")}?${new URLSearchParams({
                      addon: "editorial.tmdb",
                      type: item.type,
                      id: `tmdb:${item.tmdbId}`
                    }).toString()}`}
                    key={item.tmdbId}
                  >
                    {item.backdropUrl || item.posterUrl ? <img src={item.backdropUrl || item.posterUrl || ""} alt="" loading="lazy" referrerPolicy="no-referrer" /> : null}
                    <span><strong>{item.title}</strong><small>{item.year ?? ""}{item.voteAverage !== null ? ` · ★ ${item.voteAverage.toFixed(1)}` : ""}</small></span>
                  </a>
                ))}
              </div>
            </div>
          ) : null}

          <footer className={styles.tmdbCredit} data-tv-zone={tvLayout ? "info" : undefined}>
            <a href={editorial.tmdbUrl} target="_blank" rel="noreferrer">Ver dados no TMDB</a>
            <span>{editorial.attribution.tmdbNotice}</span>
          </footer>
        </section>
      ) : null}
      </div>

      {/* TV: abas no lugar da rolagem (referência Netflix: Visão geral · Episódios ·
          Títulos semelhantes · Detalhes). Trocam ao receber foco, então ←/→ já mostram o
          conteúdo. Ficam no rodapé da tela, sempre no mesmo lugar; o conteúdo da aba aparece acima. */}
      {tvLayout ? (
        <nav className={styles.tvTabs} data-tv-zone="abas" aria-label="Seções do título">
          {([
            ["geral", "Visão geral"],
            ...(meta.videos.length > 1 ? [["episodios", "Episódios"] as const] : []),
            ...(editorial?.recommendations.length ? [["semelhantes", "Títulos semelhantes"] as const] : []),
            ...(editorial ? [["detalhes", "Detalhes"] as const] : [])
          ] as const).map(([tab, label]) => (
            <button
              type="button"
              key={tab}
              className={`${styles.tvTab} ${tvTab === tab ? styles.tvTabActive : ""}`}
              aria-pressed={tvTab === tab}
              // Voltar do controle, fora da Visão geral, volta pra ela em vez de sair da página.
              data-tv-back-action={tab === "geral" && tvTab !== "geral" ? "" : undefined}
              onFocus={() => setTvTab(tab)}
              onClick={(event) => { setTvTab(tab); event.currentTarget.focus(); }}
            >
              {label}
            </button>
          ))}
        </nav>
      ) : null}

      {/* Stream Selection Modal */}
      {isStreamModalOpen ? (
        // TV: embrulha o popup num <details open>. `tv-navigation.tsx` já trata ↑/↓ dentro de
        // um `details[open]` como navegação comum (não pula de zona) — o mesmo desvio usado pro
        // menu de perfil da home — então o popup fica navegável sem tocar naquele arquivo. No
        // PC/celular não muda nada (sem <details>, mesmo JSX de sempre).
        tvLayout ? (
          <details open className={styles.tvModalTrap}>
            <summary style={{ display: "none" }} />
            <div className={styles.modalBackdrop} role="presentation" onClick={closeStreamModal}>
              <div
                className={styles.modal}
                role="dialog"
                aria-modal="true"
                aria-label="Escolher opção de reprodução"
                tabIndex={-1}
                ref={streamDialogRef}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={handleModalKeyDown}
              >
                {streamModalInner}
              </div>
            </div>
          </details>
        ) : (
        <div className={styles.modalBackdrop} role="presentation" onClick={closeStreamModal}>
          <div
            className={styles.modal}
            role="dialog"
            aria-modal="true"
            aria-label="Escolher opção de reprodução"
            tabIndex={-1}
            ref={streamDialogRef}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={handleModalKeyDown}
          >
            {streamModalInner}
          </div>
        </div>
        )
      ) : null}

      {/* A mesma cortina acompanha descoberta, preparação e abertura do vídeo. */}
      {!isStreamModalOpen && typeof document !== "undefined" && (
        (selectedStream !== null && isPlayerLoading) ||
        (selectedStream === null && (pendingAutoplayVideoId !== null || resolvingStreamId !== null ||
          (shouldOpenStreamList && cortinaInicial && !autoplayConsumed.current &&
            streamState !== "empty" && streamState !== "error")))
      ) ? createPortal(
        <section
          className={styles.playerLoadingOverlay}
          role="status"
          aria-live="polite"
          data-cortina-player=""
          data-air-video-controls=""
        >
          <span className={styles.playerLoadingSpinner} aria-hidden="true" />
          <strong>{selectedStream !== null ? "Abrindo vídeo…" : resolvingStreamId !== null
            ? "Preparando reprodução…" : "Buscando uma fonte…"}</strong>
          <p>{downloadNotice ?? playerNotice ?? "Aguarde enquanto a reprodução é preparada."}</p>
          <button type="button" onClick={closePlayer}>Cancelar</button>
        </section>,
        document.body
      ) : null}

      {selectedStream && tauriRuntime ? (
        <section className={styles.tauriSurface} aria-label={`Reproduzindo ${meta.name}`}>
          <video ref={tauriVideoSurface} className={styles.tauriVideo} aria-label="Superfície nativa de vídeo" />
        </section>
      ) : null}

      {selectedStream && playerNativo && downloadNotice === null ? (
        <PlayerControls
          key={playbackPreparationKey(videoId, selectedStream.id)}
          onSeek={() => progressTrackerRef.current?.buscaDaPessoa()}
          player={playerNativo}
          title={meta.name}
          episodeLabel={selectedVideo && meta.type === "series"
            ? `${episodeDisplayLabel(selectedVideo.season, displayNumber(selectedVideo))} · ${selectedVideo.title}`
            : null}
          previousEpisodeLabel={previousEpisode?.title ?? null}
          nextEpisodeLabel={nextEpisode?.title ?? null}
          synopsis={selectedVideo?.title ? editorial?.overview || meta.description : meta.description}
          backdropUrl={meta.background || editorial?.backdropUrl || null}
          episodes={meta.type === "series" ? meta.videos.map((video) => ({ ...video, displayEpisode: displayNumber(video) })) : undefined}
          currentVideoId={videoId}
          onSelectEpisode={(id) => playAutomatically(id)}
          source={{
            addon: playbackAddonLabel(selectedStream),
            quality: selectedStream.quality ?? "Qualidade não informada",
            details: streamMetaLine(selectedStream),
            label: selectedStream.label,
            readyNow: selectedStream.readyNow === true
          }}
          sourceOptions={playerSourceOptions}
          originalLanguage={editorial?.originalLanguage}
          currentSourceId={selectedStream.id}
          onSelectSource={switchPlayerSource}
          onPreviousEpisode={previousEpisode ? playPreviousEpisode : undefined}
          onNextEpisode={nextEpisode ? playNextEpisode : undefined}
          onClose={closePlayer}
          subtitleSettings={subtitleSettings}
          onSubtitleSettingsChange={setSubtitleSettings}
          onScenarioChange={handleScenarioChange}
          skipBlocks={skipBlocks}
        />
      ) : null}

      {browserPlayerAtivo && selectedStream ? (
        <section className={styles.player} ref={playerSectionRef} aria-label={`Reproduzindo ${meta.name}`}>
          <TitleBrowserPlayer
            player={player}
            src={selectedStream.url}
            title={meta.name}
            subtitleSettings={subtitleSettings}
            tvCaptions={tvLayout}
            subtitles={subtitles}
            defaultSubtitleId={preferredBrowserSubtitleId(defaultSubtitleId, userSubtitleChoice)}
            autoSubtitleEnabled={userSubtitleChoice !== "off"}
            onTracksChanged={notifyBrowserTracksChanged}
            onLoadedMetadata={() => {
              const element = player.current;
              if (!element) return;
              setPreparedTracks(null);
              if (isDebridPlaceholder(selectedStream, element.duration)) {
                element.pause();
                retryDebridPlaceholder(selectedStream);
                return;
              }
              setDownloadNotice(null);
              setIsPlayerLoading(false);
              const startupKey = playbackPreparationKey(diagnosticIdsRef.current.videoId, selectedStream.id);
              const startup = startupTimingRef.current?.key === startupKey ? startupTimingRef.current.timing : null;
              startup?.mark("playerReadyMs");
              const timings = startup?.finish();
              if (timings) reportDiagnostic("PLAYBACK_STARTUP", "Tempo até carregar metadados no navegador (ms desde a escolha da fonte)", {
                ...diagnosticIdsRef.current, addon: selectedStream.addonName, engine: "browser", ...timings
              });
              // Serviços de debrid podem responder HTTP 200 com um clipe de erro de 30 s no
              // lugar do episódio. Ele é tecnicamente reproduzível, então onError não dispara.
              // A duração anormal denuncia o placeholder e devolve a escolha para a pessoa.
              if (Number.isFinite(element.duration) && element.duration > 0 && element.duration <= 90) {
                handlePlaybackFailure("Esta fonte foi removida ou expirou. Escolha outra opção na lista.");
                return;
              }
              if (selectionOriginRef.current !== "manual" && durationMismatch(matchTarget, element.duration)) {
                element.pause();
                handlePlaybackFailure(wrongDurationNotice(element.duration, matchTarget?.runtimeMinutes));
                return;
              }
              // `resumeFrom` avisa o tracker do ponto de retomada: as leituras baixas do seek
              // inicial não podem apagar, no servidor, o ponto em que a pessoa parou.
              const { segundos: startAtSeconds } = decidirInicio({
                videoId,
                posicaoDaTroca: sourceSwitchPositionRef.current,
                doComeco: startFromBeginningRef.current,
                salvo: activeSaved,
                pularAbertura: pularAberturaLigado()
              });
              sourceSwitchPositionRef.current = null;
              startFromBeginningRef.current = false;
              if (startAtSeconds > 0) {
                element.currentTime = startAtSeconds;
                progressTrackerRef.current?.resumeFrom(startAtSeconds);
              }
              browserPlayer.current?.notify("ready", browserPlayer.current.state());
              // Regra única de faixas (mesma do player nativo) e, só depois dela, a camada 3
              // (sincronia por conteúdo): aplicada às faixas de texto do Vidstack. A função só entra
              // em ação quando a legenda ativa agora é mesmo a automática — nunca manual nem herdada.
              const navegador = browserPlayer.current;
              const avisar = (resultado: { audioFalhou: boolean; legendaFalhou: boolean }) => {
                if (player.current !== element || diagnosticIdsRef.current.videoId !== videoId ||
                    startupTimingRef.current?.key !== startupKey || playbackCancelled.current) return;
                // Navegadores nem sempre expõem a faixa de áudio do arquivo. A rodada inicial
                // concluída vale também nesse caso, sem bloquear os pulos que já funcionavam.
                if (navegador && !resultado.audioFalhou && !resultado.legendaFalhou) {
                  setPreparedTracks((current) => current?.player === navegador && current.key === startupKey
                    ? current : { key: startupKey, player: navegador });
                }
                if (resultado.audioFalhou) setPlayerNotice("Não foi possível restaurar a trilha de áudio salva. Escolha outra no menu.");
                if (resultado.legendaFalhou) setPlayerNotice("Não foi possível restaurar a legenda. Escolha outra no menu.");
              };
              timersFaixasNavegadorRef.current.splice(0).forEach((timer) => window.clearTimeout(timer));
              const isCurrent = () => player.current === element && diagnosticIdsRef.current.videoId === videoId &&
                startupTimingRef.current?.key === startupKey && !playbackCancelled.current;
              let audioAvaliado = false;
              let queue = Promise.resolve();
              const refresh = () => {
                queue = queue.then(async () => {
                  if (!navegador || !isCurrent()) return;
                  const entrada = entradaDasFaixas();
                  const vigente = () => isCurrent() && entrada.escolhaDaPessoa === userSubtitleChoiceRef.current;
                  const resultado = await aplicarFaixas(navegador, entrada, { audio: !audioAvaliado, isCurrent: vigente });
                  if (!vigente()) return;
                  if (resultado.audioAvaliado && !resultado.audioFalhou) audioAvaliado = true;
                  avisar(resultado);
                }).catch(() => {});
                return queue;
              };
              refreshBrowserTracksRef.current = () => { void refresh(); };
              const faixasPromessa = refresh();
              timersFaixasNavegadorRef.current.push(window.setInterval(() => { void refresh(); }, 5_000));
              void faixasPromessa.then(() => {
                if (!isCurrent()) return;
                runSubtitleTimingCheck(element.duration, {
                  getActiveId: () => player.current?.textTracks.selected?.id ?? null,
                  apply: (id) => {
                    const instance = player.current;
                    if (!instance) return;
                    for (const track of instance.textTracks) track.setMode(track.id === id ? "showing" : "disabled");
                  }
                });
              });
            }}
            onTimeUpdate={() => {
              if ((player.current?.duration ?? 0) <= 90) return;
              const currentTime = player.current?.currentTime ?? 0;
              browserPlayer.current?.notify("position", currentTime);
              progressTrackerRef.current?.position(currentTime, player.current?.duration ?? Number.NaN);
            }}
            onPause={() => { if ((player.current?.duration ?? 0) > 90) progressTrackerRef.current?.flush(currentPlaybackReading()); }}
            onEnded={() => {
              if ((player.current?.duration ?? 0) <= 90) return;
              if (!canAdvanceOnEnded(player.current?.currentTime ?? 0, player.current?.duration ?? 0)) return;
              browserPlayer.current?.notify("ended", undefined);
              progressTrackerRef.current?.ended(player.current?.duration ?? Number.NaN);
            }}
            onError={(detail) => {
              setIsPlayerLoading(false);
              browserPlayer.current?.notify("error", "O navegador não conseguiu abrir esta fonte.");
              reportDiagnostic("BROWSER_MEDIA_ERROR", detail?.message || "O navegador não conseguiu abrir esta fonte.", {
                mediaId, videoId, addon: selectedStream.addonName,
                ...(detail?.code !== undefined ? { errorCode: String(detail.code) } : {})
              });
              handlePlaybackFailure("O navegador não conseguiu abrir esta fonte. Escolha outra opção na lista.");
            }}
          />
          {browserPlayer.current ? (
            <PlayerControls
          key={playbackPreparationKey(videoId, selectedStream.id)}
              onSeek={() => progressTrackerRef.current?.buscaDaPessoa()}
              player={browserPlayer.current}
              title={meta.name}
              episodeLabel={selectedVideo && meta.type === "series"
                ? `${episodeDisplayLabel(selectedVideo.season, displayNumber(selectedVideo))} · ${selectedVideo.title}`
                : null}
              previousEpisodeLabel={previousEpisode?.title ?? null}
              nextEpisodeLabel={nextEpisode?.title ?? null}
              synopsis={selectedVideo?.title ? editorial?.overview || meta.description : meta.description}
              backdropUrl={meta.background || editorial?.backdropUrl || null}
              episodes={meta.type === "series" ? meta.videos.map((video) => ({ ...video, displayEpisode: displayNumber(video) })) : undefined}
              currentVideoId={videoId}
              onSelectEpisode={(id) => playAutomatically(id)}
              source={{
                addon: playbackAddonLabel(selectedStream),
                quality: selectedStream.quality ?? "Qualidade não informada",
                details: streamMetaLine(selectedStream),
                label: selectedStream.label,
                readyNow: selectedStream.readyNow === true
              }}
              sourceOptions={playerSourceOptions}
              originalLanguage={editorial?.originalLanguage}
              currentSourceId={selectedStream.id}
              onSelectSource={switchPlayerSource}
              onPreviousEpisode={previousEpisode ? playPreviousEpisode : undefined}
              onNextEpisode={nextEpisode ? playNextEpisode : undefined}
              onClose={closePlayer}
              subtitleSettings={subtitleSettings}
              onSubtitleSettingsChange={setSubtitleSettings}
              onScenarioChange={handleScenarioChange}
              skipBlocks={skipBlocks}
            />
          ) : null}
          {playerNotice ? (
            <p className={styles.playerToast} role="status" aria-live="polite">{playerNotice}</p>
          ) : null}
        </section>
      ) : null}

      {/* Modal de Avaliação do Usuário (Nota 0 a 5 estrelas / Crítica) */}
      {isReviewModalOpen ? (
        // TV: mesmo truque do popup de fontes — <details open> pra ↑/↓ não vazar pra zona de
        // trás (ver o comentário completo lá em cima). PC/celular seguem sem o <details>.
        tvLayout ? (
          <details open className={styles.tvModalTrap}>
            <summary style={{ display: "none" }} />
            <div className={styles.reviewModalBackdrop} role="presentation" onClick={() => setIsReviewModalOpen(false)}>
              <div
                className={styles.reviewModal}
                role="dialog"
                aria-modal="true"
                aria-label="Avaliar obra"
                tabIndex={-1}
                ref={reviewDialogRef}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={handleReviewModalKeyDown}
              >
                {reviewModalInner}
              </div>
            </div>
          </details>
        ) : (
        <div
          className={styles.reviewModalBackdrop}
          role="presentation"
          onClick={() => setIsReviewModalOpen(false)}
        >
          <div
            className={styles.reviewModal}
            role="dialog"
            aria-modal="true"
            aria-label="Avaliar obra"
            tabIndex={-1}
            ref={reviewDialogRef}
            onClick={(event) => event.stopPropagation()}
          >
            {reviewModalInner}
          </div>
        </div>
        )
      ) : null}
    </main>
  );
}
