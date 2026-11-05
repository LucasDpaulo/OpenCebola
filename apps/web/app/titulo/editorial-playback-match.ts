import type { EditorialTitleResponse, MediaType } from "@cebola/contracts";
import { adjacentEpisode } from "./episode-order";

export interface StremioSearchCandidate {
  readonly id: string;
  readonly type: MediaType;
  readonly name: string;
  readonly addonId: string;
  readonly releaseInfo?: string | null;
}

interface SearchResponse {
  readonly items?: unknown;
}

interface PlaybackVideo {
  readonly id: string;
  readonly season: number | null;
  readonly episode: number | null;
}

interface SavedPlaybackVideo {
  readonly videoId: string;
  readonly completed: boolean;
  readonly positionSeconds: number;
  readonly updatedAt?: string;
}

function normalizedTitle(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").trim();
}

/**
 * O TMDB costuma devolver o nome localizado enquanto os catálogos Stremio indexam o original.
 * O IMDb id é a identidade estável; os nomes servem apenas quando ele não está disponível.
 */
export function editorialSearchQueries(editorial: EditorialTitleResponse): readonly string[] {
  return [...new Set([editorial.imdbId, editorial.title, editorial.originalTitle]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
}

export function matchEditorialCandidate(
  candidates: readonly StremioSearchCandidate[],
  editorial: EditorialTitleResponse
): StremioSearchCandidate | null {
  const compatible = candidates.filter((candidate) => candidate.type === editorial.type);
  if (editorial.imdbId) {
    const byImdb = compatible.find((candidate) => candidate.id === editorial.imdbId);
    if (byImdb) return byImdb;
  }

  const titles = new Set([editorial.title, editorial.originalTitle]
    .filter((value): value is string => typeof value === "string")
    .map(normalizedTitle));
  return compatible.find((candidate) => {
    if (!titles.has(normalizedTitle(candidate.name))) return false;
    return editorial.year === null ||
      candidate.releaseInfo?.includes(String(editorial.year)) === true;
  }) ?? null;
}

/** Mantém respostas válidas quando uma das buscas paralelas por IMDb/título falha. */
export function settledEditorialCandidates(
  results: readonly PromiseSettledResult<SearchResponse>[]
): readonly StremioSearchCandidate[] {
  return results.flatMap((result): StremioSearchCandidate[] => {
    if (result.status !== "fulfilled" || !Array.isArray(result.value.items)) return [];
    return result.value.items.flatMap((value): StremioSearchCandidate[] => {
      if (typeof value !== "object" || value === null) return [];
      const item = value as Partial<StremioSearchCandidate>;
      if ((item.type !== "movie" && item.type !== "series") || typeof item.id !== "string" ||
        typeof item.name !== "string" || typeof item.addonId !== "string") return [];
      return [{
        id: item.id,
        type: item.type,
        name: item.name,
        addonId: item.addonId,
        releaseInfo: typeof item.releaseInfo === "string" ? item.releaseInfo : null
      }];
    });
  });
}

/**
 * URL explícita vence (ou o episódio seguinte a ela, no card de "próximo episódio"). Sem URL,
 * decide a gravação mais recente: pela metade, retoma; terminada, segue para o próximo. Sem
 * próximo, vale o último episódio pela metade; sem histórico, começa no episódio 1.
 */
export function preferredPlaybackVideo<T extends PlaybackVideo>(
  videos: readonly T[],
  saved: readonly SavedPlaybackVideo[],
  requestedVideoId?: string | null,
  afterRequested = false
): T | null {
  if (requestedVideoId) {
    const requested = videos.find((video) => video.id === requestedVideoId);
    if (requested) return afterRequested ? adjacentEpisode(videos, requested.id, 1) ?? requested : requested;
  }
  const recent = saved
    .filter((item) => (item.completed || item.positionSeconds > 10) && videos.some((video) => video.id === item.videoId))
    .sort((left, right) => Date.parse(right.updatedAt ?? "") - Date.parse(left.updatedAt ?? ""));
  const latest = recent[0];
  if (latest?.completed) {
    const next = adjacentEpisode(videos, latest.videoId, 1);
    if (next) return next;
  }
  const resumable = recent.find((item) => !item.completed);
  if (resumable) return videos.find((video) => video.id === resumable.videoId) ?? null;
  return videos.find((video) => video.season !== 0) ?? videos[0] ?? null;
}
