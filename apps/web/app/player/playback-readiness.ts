import { playbackPreparationKey } from "./playback-preparation";

export interface PreparedTracks<T> {
  readonly key: string;
  readonly player: T;
}

/** Uma preparação antiga nunca libera pulos de outro vídeo, fonte ou instância do motor. */
export function tracksPreparedFor<T>(
  prepared: PreparedTracks<T> | null,
  videoId: string,
  sourceId: string | null,
  player: T | null
): boolean {
  return sourceId !== null && player !== null && prepared !== null &&
    prepared.player === player && prepared.key === playbackPreparationKey(videoId, sourceId);
}
