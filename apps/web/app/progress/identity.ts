// MÓDULO PROTEGIDO — salvamento de progresso. Não alterar sem pedido explícito do Lucas (ver AGENTS.md).

/**
 * Qual `videoId` gravar. Filme não tem episódio: o vídeo é o próprio filme, então, sem `videoId`
 * próprio, vale o `mediaId`. A chave no banco é (perfil, mediaId, videoId): gravar com um
 * identificador diferente do que a leitura procura cria um segundo registro e a retomada "some".
 */
export function progressVideoId(input: {
  readonly mediaType?: string | null;
  readonly mediaId: string;
  readonly videoId?: string | null;
}): string {
  const video = (input.videoId ?? "").trim();
  return video !== "" ? video : input.mediaId.trim();
}

interface SavedIdentity {
  readonly mediaId: string;
  readonly videoId: string;
  readonly updatedAt?: string | null;
  readonly mediaType?: "movie" | "series";
}

function recency(item: SavedIdentity): number {
  const time = Date.parse(item.updatedAt ?? "");
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/** O mais recente da lista; em empate (ou sem data), o primeiro. */
function latest<T extends SavedIdentity>(items: readonly T[]): T | null {
  let best: T | null = null;
  for (const item of items) {
    if (best === null || recency(item) > recency(best)) best = item;
  }
  return best;
}

/**
 * Acha o registro salvo do vídeo que vai tocar. Série casa SÓ pelo `videoId` do episódio: o
 * `mediaId` é o mesmo em todos os episódios e devolveria o de outro. Filme tem um vídeo só, então
 * também vale o mesmo filme gravado por outro caminho — título editorial (`tmdb:…`) × catálogo
 * (`tt…`) — seja pelo `mediaId` ou por ter sido gravado com o `mediaId` como `videoId`.
 */
export function findSavedProgress<T extends SavedIdentity>(
  items: readonly T[],
  target: { readonly mediaType: "movie" | "series"; readonly mediaId: string; readonly videoId: string; readonly alternateIds?: readonly string[] }
): T | null {
  const videoId = target.videoId.trim();
  const mediaId = target.mediaId.trim();
  const movie = target.mediaType === "movie";
  return latest(items.filter((item) =>
    (item.mediaType === undefined || item.mediaType === target.mediaType) && (
      (videoId !== "" && item.videoId === videoId) ||
      (movie && mediaId !== "" && (item.mediaId === mediaId || item.videoId === mediaId)) ||
      (movie && (target.alternateIds?.includes(item.mediaId) || target.alternateIds?.includes(item.videoId)))
    )
  ));
}

/**
 * Tudo o que está salvo de um título: os registros da obra e os dos episódios da série que vieram
 * por outro caminho (mesmo `videoId`, `mediaId` diferente).
 */
export function progressForTitle<T extends SavedIdentity>(
  items: readonly T[],
  title: { readonly mediaId: string; readonly videoIds: ReadonlySet<string>; readonly alternateMediaIds?: ReadonlySet<string> }
): T[] {
  return items.filter((item) => item.mediaId === title.mediaId || title.videoIds.has(item.videoId) || title.alternateMediaIds?.has(item.mediaId) === true);
}
