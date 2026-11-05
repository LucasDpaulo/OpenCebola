export interface ContinueItem {
  readonly mediaType: "movie" | "series";
  readonly mediaId: string;
  readonly videoId: string;
  readonly updatedAt: string;
}

/** O ID TMDB do progresso pertence à rota editorial, mesmo se uma busca salvou outro addon. */
export function metadataAddonForMedia(addonId: string, mediaId: string): string {
  return /^tmdb:\d+$/.test(mediaId) ? "editorial.tmdb" : addonId;
}

/** Agrupa a mesma obra mesmo quando um acesso veio do TMDB e outro do IMDb. */
export function continueIdentity(item: ContinueItem): string {
  if (item.mediaType === "movie") return `movie:${item.videoId}`;
  const imdb = /^tt\d{7,10}(?=:)/.exec(item.videoId)?.[0];
  return `series:${imdb ?? item.mediaId}`;
}

export interface ContinueEntry<T> {
  readonly item: T;
  /** O último episódio gravado terminou: o card leva ao episódio seguinte a `item`. */
  readonly next: boolean;
}

/**
 * Um card por obra, decidido pela gravação MAIS RECENTE dela, de qualquer aparelho. Antes valia
 * o último episódio pela metade: terminar um episódio fazia o card voltar para um antigo
 * abandonado no meio. Pela metade, retoma; série terminada segue para o próximo — mas só se
 * ainda houver episódio pela metade, porque "Remover de Continuar" conclui todos, e uma série
 * removida (ou vista inteira) não pode voltar como "próximo episódio". Filme terminado sai.
 */
export function continueEntries<T extends ContinueItem & { readonly completed: boolean; readonly hiddenFromContinue?: boolean }>(
  items: readonly T[]
): readonly ContinueEntry<T>[] {
  const groups = new Map<string, { latest: T; hasUnfinished: boolean }>();
  for (const item of items) {
    if (item.hiddenFromContinue) continue;
    const key = continueIdentity(item);
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { latest: item, hasUnfinished: !item.completed });
      continue;
    }
    if (Date.parse(item.updatedAt) > Date.parse(group.latest.updatedAt)) group.latest = item;
    if (!item.completed) group.hasUnfinished = true;
  }
  return [...groups.values()]
    .flatMap(({ latest, hasUnfinished }): ContinueEntry<T>[] => {
      if (!latest.completed) return [{ item: latest, next: false }];
      return latest.mediaType === "series" && hasUnfinished ? [{ item: latest, next: true }] : [];
    })
    .sort((left, right) => Date.parse(right.item.updatedAt) - Date.parse(left.item.updatedAt));
}
