import { onePieceAbsoluteEpisode } from "@cebola/contracts";

type EpisodeNumber = { readonly season: number | null; readonly episode: number | null };

export function displayEpisodeNumber(
  seriesId: string,
  season: number | null,
  episode: number | null,
  catalog?: readonly EpisodeNumber[],
  isAnime = false
): number | null {
  if (episode === null) return null;
  if (season === null || season === 0) return episode;

  if (/(?:^|:)tt0388629(?::|$)/.test(seriesId)) {
    const absolute = onePieceAbsoluteEpisode(season, episode);
    if (absolute !== null) return absolute;
  }

  if (!isAnime || !catalog) return episode;
  const maxBySeason = new Map<number, number>();
  const episodesBySeason = new Map<number, Set<number>>();
  for (const video of catalog) {
    if (video.season === null || video.season < 1 || video.episode === null) continue;
    maxBySeason.set(video.season, Math.max(maxBySeason.get(video.season) ?? 0, video.episode));
    const episodes = episodesBySeason.get(video.season) ?? new Set<number>();
    episodes.add(video.episode);
    episodesBySeason.set(video.season, episodes);
  }
  if (!episodesBySeason.get(season)?.has(1)) return episode;
  let offset = 0;
  for (let previous = 1; previous < season; previous += 1) {
    const max = maxBySeason.get(previous);
    if (max === undefined || episodesBySeason.get(previous)?.size !== max) return episode;
    offset += max;
  }
  return offset + episode;
}

export function episodeDisplayLabel(season: number | null, episode: number | null): string {
  if (season !== null && episode !== null) return `T${season} · E${episode}`;
  if (season !== null) return `T${season}`;
  if (episode !== null) return `E${episode}`;
  return "Série";
}
