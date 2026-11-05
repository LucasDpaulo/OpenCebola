/**
 * Mantém a home estável enquanto os catálogos chegam fora de ordem. Um resultado atrás de uma
 * lacuna ainda não é visível; republicá-lo só força uma nova renderização do hero e das rails.
 */
export function contiguousReadyItems<T>(
  previous: readonly T[],
  loaded: readonly (T | null)[],
  shouldRender: (item: T) => boolean = () => true
): readonly T[] {
  const next: T[] = [];
  for (const item of loaded) {
    if (item === null) break;
    if (shouldRender(item)) next.push(item);
  }

  if (next.length === previous.length && next.every((item, index) => item === previous[index])) {
    return previous;
  }
  return next;
}

/** Não reinicia o destaque ativo quando a lista cresce; só corrige índices que saíram da faixa. */
export function nextCarouselIndex(current: number, candidateCount: number): number {
  return candidateCount === 0 || current >= candidateCount ? 0 : current;
}
