import { getSafeJson } from "./safe-http.js";
import { onePieceAbsoluteEpisode } from "@cebola/contracts";

type MediaType = "movie" | "series";
type JsonRecord = Record<string, unknown>;

export type SkipSegmentKind = "intro" | "recap" | "outro";

export interface SkipSegment {
  readonly kind: SkipSegmentKind;
  readonly start: number;
  readonly end: number;
  readonly episodeLength: number | null;
}

interface VideoIdentity {
  readonly imdbId: string | null;
  readonly tmdbId: string | null;
  readonly season: number;
  readonly episode: number;
}

interface ArmEntry {
  readonly myanimelist: number | null;
  readonly tvdbSeason: number | null;
  readonly tmdbSeason: number | null;
}

const SIX_HOURS_SECONDS = 6 * 60 * 60;
const MAPPING_TTL_MS = 24 * 60 * 60_000;
const SEGMENTS_TTL_MS = 24 * 60 * 60_000;
const EMPTY_SEGMENTS_TTL_MS = 60 * 60_000;
const FAILURE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 500;

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord : null;
}

// Mesmo formato de videoId usado pelo resto do Stremio: "tt0388629:21:152" (IMDb) ou
// "tmdb:37854:21:152". O episódio aqui é o relativo à temporada, como o resto do app já usa;
// o número absoluto (quando o mapeamento não tem temporada) vem à parte, via query `absolute`.
function parseVideoId(videoId: string): VideoIdentity | null {
  const parts = videoId.split(":");
  const imdb = /^tt\d{5,12}$/.test(parts[0] ?? "") ? parts[0]! : null;
  const tmdb = parts[0] === "tmdb" && /^\d{1,12}$/.test(parts[1] ?? "") ? parts[1]! : null;
  if (!imdb && !tmdb) return null;
  const season = Number(parts[imdb ? 1 : 2]);
  const episode = Number(parts[imdb ? 2 : 3]);
  if (!Number.isInteger(season) || !Number.isInteger(episode) ||
    season < 0 || season > 100 || episode < 1 || episode > 10_000) return null;
  return { imdbId: imdb, tmdbId: tmdb, season, episode };
}

function armEntry(value: unknown): ArmEntry | null {
  const item = record(value);
  if (!item) return null;
  const myanimelist = typeof item.myanimelist === "number" ? item.myanimelist : null;
  const tvdbSeason = typeof item["thetvdb-season"] === "number" ? item["thetvdb-season"] : null;
  const tmdbSeason = typeof item["themoviedb-season"] === "number" ? item["themoviedb-season"] : null;
  return { myanimelist, tvdbSeason, tmdbSeason };
}

// Regra do plano: entrada com a temporada preenchida (tvdb, com fallback tmdb) usa o episódio
// relativo já presente no videoId. Só quando existe uma ÚNICA entrada sem nenhuma temporada
// (numeração absoluta, ex.: One Piece) é que o episódio vem do parâmetro `absolute` — sem ele,
// não há como saber o episódio absoluto, e o resultado fica vazio.
function resolveMalEpisode(
  entries: readonly ArmEntry[],
  season: number,
  seasonRelativeEpisode: number,
  absolute: number | undefined
): { malId: number; episode: number } | null {
  const bySeason = entries.find((entry) => entry.tvdbSeason === season) ??
    entries.find((entry) => entry.tvdbSeason === null && entry.tmdbSeason === season);
  if (bySeason && typeof bySeason.myanimelist === "number") {
    return { malId: bySeason.myanimelist, episode: seasonRelativeEpisode };
  }
  if (entries.length === 1 && entries[0]!.tvdbSeason === null && entries[0]!.tmdbSeason === null) {
    const single = entries[0]!;
    if (typeof single.myanimelist !== "number" || absolute === undefined) return null;
    return { malId: single.myanimelist, episode: absolute };
  }
  return null;
}

function toSegment(value: unknown): SkipSegment | null {
  const item = record(value);
  if (!item) return null;
  const kind: SkipSegmentKind | null =
    item.skipType === "op" ? "intro" :
    item.skipType === "recap" ? "recap" :
    item.skipType === "ed" ? "outro" : null;
  if (!kind) return null;
  const interval = record(item.interval);
  const start = typeof interval?.startTime === "number" ? interval.startTime : NaN;
  const end = typeof interval?.endTime === "number" ? interval.endTime : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) ||
    start < 0 || start >= end || end > SIX_HOURS_SECONDS) return null;
  const episodeLength = typeof item.episodeLength === "number" && Number.isFinite(item.episodeLength) &&
    item.episodeLength > 0 ? item.episodeLength : null;
  return { kind, start, end, episodeLength };
}

/**
 * Encontra os segmentos de abertura/recapitulação/encerramento de um episódio de anime, via
 * ARM (mapeamento IMDb/TMDB → MyAnimeList) e AniSkip (os próprios tempos). Nenhum dos dois
 * exige chave. Falha externa ou mapeamento ausente nunca vira exceção: o chamador recebe uma
 * lista vazia e decide o que mostrar (hoje, apenas o fallback de "próximo episódio").
 */
export class SkipTimesClient {
  readonly #fetchJson: (url: string) => Promise<unknown>;
  readonly #mappingCache = new Map<string, { expiresAt: number; entries: readonly ArmEntry[] }>();
  readonly #segmentsCache = new Map<string, { expiresAt: number; segments: readonly SkipSegment[] }>();

  constructor(options: { fetchJson?: (url: string) => Promise<unknown> } = {}) {
    this.#fetchJson = options.fetchJson ?? getSafeJson;
  }

  async skipTimes(type: MediaType, videoId: string, absolute?: number): Promise<readonly SkipSegment[]> {
    if (type !== "series") return [];
    const identity = parseVideoId(videoId);
    if (!identity) return [];
    const entries = await this.#armMapping(identity);
    // Clientes com catálogo absoluto (incluindo Roku) podem não enviar a query `absolute`.
    const onePiece = identity.imdbId === "tt0388629" || identity.tmdbId === "37854";
    const inferredAbsolute = onePiece ? onePieceAbsoluteEpisode(identity.season, identity.episode) : null;
    const resolved = resolveMalEpisode(entries, identity.season, identity.episode, absolute ?? inferredAbsolute ?? undefined);
    if (!resolved || !Number.isInteger(resolved.episode) || resolved.episode < 1) return [];
    return this.#skipSegments(resolved.malId, resolved.episode);
  }

  async #armMapping(identity: VideoIdentity): Promise<readonly ArmEntry[]> {
    const cacheKey = identity.imdbId ? `imdb:${identity.imdbId}` : `tmdb:${identity.tmdbId}`;
    const cached = this.#mappingCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.entries;
    const url = identity.imdbId
      ? `https://arm.haglund.dev/api/v2/imdb?id=${identity.imdbId}`
      : `https://arm.haglund.dev/api/v2/themoviedb?id=${identity.tmdbId}`;
    let entries: readonly ArmEntry[] = [];
    let failed = false;
    try {
      const raw = await this.#fetchJson(url);
      if (Array.isArray(raw)) {
        entries = raw.map(armEntry).filter((entry): entry is ArmEntry => entry !== null);
      }
    } catch {
      entries = [];
      failed = true;
    }
    if (this.#mappingCache.size >= MAX_CACHE_ENTRIES) {
      this.#mappingCache.delete(this.#mappingCache.keys().next().value!);
    }
    // Uma falha do ARM (fora do ar, lento) não pode esconder as aberturas do anime por um dia.
    const ttl = failed ? FAILURE_TTL_MS : MAPPING_TTL_MS;
    this.#mappingCache.set(cacheKey, { expiresAt: Date.now() + ttl, entries });
    return entries;
  }

  async #skipSegments(malId: number, episode: number): Promise<readonly SkipSegment[]> {
    const cacheKey = `${malId}:${episode}`;
    const cached = this.#segmentsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.segments;
    const url = `https://api.aniskip.com/v2/skip-times/${malId}/${episode}` +
      "?types[]=op&types[]=ed&types[]=recap&episodeLength=0";
    let segments: SkipSegment[] = [];
    try {
      const raw = await this.#fetchJson(url);
      const body = record(raw);
      if (body?.found === true && Array.isArray(body.results)) {
        for (const item of body.results.slice(0, 20)) {
          const segment = toSegment(item);
          if (segment) segments.push(segment);
        }
      }
    } catch {
      // A AniSkip responde 404 quando não tem o episódio, e getSafeJson não distingue isso de
      // uma falha real; as duas ficam no cache curto de resultado vazio.
      segments = [];
    }
    segments = segments.slice(0, 10);
    if (this.#segmentsCache.size >= MAX_CACHE_ENTRIES) {
      this.#segmentsCache.delete(this.#segmentsCache.keys().next().value!);
    }
    const ttl = segments.length > 0 ? SEGMENTS_TTL_MS : EMPTY_SEGMENTS_TTL_MS;
    this.#segmentsCache.set(cacheKey, { expiresAt: Date.now() + ttl, segments });
    return segments;
  }
}
