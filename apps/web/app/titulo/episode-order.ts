export interface NumberedEpisode {
  readonly id: string;
  readonly season: number | null;
  readonly episode: number | null;
  readonly released?: string | null;
}

/** A ordem do add-on não é uma garantia de sequência de reprodução. */
export function orderedEpisodes<T extends NumberedEpisode>(videos: readonly T[]): T[] {
  return [...videos].sort((left, right) => {
    const season = (left.season ?? Number.MAX_SAFE_INTEGER) - (right.season ?? Number.MAX_SAFE_INTEGER);
    if (season !== 0) return season;
    const episode = (left.episode ?? Number.MAX_SAFE_INTEGER) - (right.episode ?? Number.MAX_SAFE_INTEGER);
    if (episode !== 0) return episode;
    return (left.released ?? "").localeCompare(right.released ?? "");
  });
}

export function adjacentEpisode<T extends NumberedEpisode>(videos: readonly T[], id: string, direction: -1 | 1): T | null {
  const ordered = orderedEpisodes(videos).filter((video) => video.season !== 0);
  const index = ordered.findIndex((video) => video.id === id);
  if (index < 0) return null;
  const current = ordered[index];
  const adjacent = ordered[index + direction];
  if (!current || !adjacent || current.id === adjacent.id) return null;
  if (current.season === adjacent.season && current.episode !== null && adjacent.episode !== null &&
      adjacent.episode - current.episode !== direction) return null;
  return adjacent;
}
