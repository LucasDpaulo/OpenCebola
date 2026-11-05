// Ordem da busca. Os add-ons já devolvem cada catálogo por popularidade (o Cinemeta põe
// "Friends" em primeiro nas séries), mas a junção empilhava catálogo após catálogo: todos os
// filmes com "friend" no nome vinham antes da série mais conhecida. Aqui o nome decide o nível
// e, dentro dele, a melhor posição que o título teve em algum catálogo decide a ordem.

export interface RankCandidate {
  readonly name: string;
  /** Melhor (menor) posição do título em qualquer catálogo consultado. */
  readonly position: number;
  /** Em quantos catálogos o título apareceu: sinal fraco de relevância. */
  readonly hits: number;
}

export function normalizeTitle(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(value: string): string[] {
  return value.split(" ").filter(Boolean);
}

// Uma letra a mais, a menos ou trocada: "witch" ≈ "with". Só para palavras de 4+ letras, onde um
// erro de digitação não transforma a palavra em outra qualquer.
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else { i += 1; j += 1; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Nível de semelhança entre o nome e o que foi digitado (maior é melhor):
 * 3 exato ou começa com o termo (juntos de propósito: senão o obscuro "Friend" passava na
 *   frente de "Friends"; a popularidade decide e o exato só desempata)
 * 2 todas as palavras batem como prefixo
 * 1 todas batem com no máximo um erro de digitação por palavra, ou o nome contém o termo
 * 0 casamento parcial
 */
export function titleMatchTier(name: string, query: string): number {
  const title = normalizeTitle(name);
  const wanted = normalizeTitle(query);
  if (!wanted) return 0;
  if (title.startsWith(wanted)) return 3;
  const titleTokens = tokens(title);
  const wantedTokens = tokens(wanted);
  if (wantedTokens.every((word) => titleTokens.some((token) => token.startsWith(word)))) return 2;
  const fuzzy = wantedTokens.every((word) => titleTokens.some((token) =>
    token.startsWith(word) ||
    (word.length >= 4 && (withinOneEdit(word, token) || withinOneEdit(word, token.slice(0, word.length))))));
  if (fuzzy || title.includes(wanted)) return 1;
  return 0;
}

// Quantas palavras digitadas batem de verdade (prefixo) — separa, entre casamentos parciais,
// "Anne+" (bate "anne") de "Switch" (só lembra "witch").
function exactWordMatches(name: string, query: string): number {
  const titleTokens = tokens(normalizeTitle(name));
  return tokens(normalizeTitle(query)).filter((word) => titleTokens.some((token) => token.startsWith(word))).length;
}

// Posições de catálogos diferentes não são comparáveis entre si ("Friends with Benefits" é o 1º
// dos filmes, "Friends" o 2º das séries). Somar as palavras que o nome tem a mais que o digitado
// faz o nome mais próximo vencer esse empate sem ignorar a popularidade.
function closeness(item: RankCandidate, query: string): number {
  const extra = tokens(normalizeTitle(item.name)).length - tokens(normalizeTitle(query)).length;
  return item.position + Math.max(0, extra);
}

export function rankSearchResults<T extends RankCandidate>(items: readonly T[], query: string): T[] {
  return items
    .map((item, index) => ({
      item, index, tier: titleMatchTier(item.name, query),
      words: exactWordMatches(item.name, query),
      closeness: closeness(item, query),
      exact: normalizeTitle(item.name) === normalizeTitle(query) ? 0 : 1
    }))
    .sort((left, right) =>
      right.tier - left.tier ||
      right.words - left.words ||
      left.closeness - right.closeness ||
      left.exact - right.exact ||
      right.item.hits - left.item.hits ||
      left.index - right.index)
    .map(({ item }) => item);
}
