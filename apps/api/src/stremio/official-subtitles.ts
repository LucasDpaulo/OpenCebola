import { onePieceAbsoluteEpisode } from "@cebola/contracts";
import type { AddonDescriptor } from "./types.js";

/** Addon oficial e público do Stremio, usado como fonte básica em todas as contas. */
export const OPEN_SUBTITLES_V3: AddonDescriptor = {
  manifest: {
    id: "org.stremio.opensubtitlesv3",
    version: "1.0.0",
    name: "OpenSubtitles v3",
    resources: ["subtitles"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: []
  },
  transportUrl: "https://opensubtitles-v3.strem.io/manifest.json"
};

export function officialSubtitleIds(type: "movie" | "series", videoId: string): readonly string[] {
  if (type !== "series") return [videoId];
  const match = /^tt0388629:(\d+):(\d+)$/.exec(videoId);
  if (!match) return [videoId];
  const absolute = onePieceAbsoluteEpisode(Number(match[1]), Number(match[2]));
  if (absolute === null) return [videoId];
  // OpenSubtitles indexa esses episódios como S01 + número absoluto, enquanto Cinemeta usa S21+.
  return [...new Set([videoId, `tt0388629:1:${absolute}`])];
}

export async function resolveWithin<T>(operation: Promise<T>, milliseconds: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), milliseconds); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Retorna as respostas já concluídas no prazo, sem descartar uma por causa de outra lenta. */
export async function collectWithin<T>(operations: readonly Promise<readonly T[]>[], milliseconds: number): Promise<T[]> {
  const completed: (readonly T[] | null)[] = operations.map(() => null);
  const done = Promise.allSettled(operations.map((operation, index) => operation.then((items) => {
    completed[index] = items;
  })));
  await resolveWithin(done, milliseconds, []);
  return completed.flatMap((items) => items ?? []);
}
