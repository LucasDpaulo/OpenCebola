import { appPagePath } from "./api-client";

// Mesmo mínimo que a API exige (`searchQuery` em apps/api/src/stremio/routes.ts) — pedir menos
// que isso na tela só gastaria uma chamada que o servidor rejeitaria de qualquer forma.
export const MIN_SEARCH_QUERY_LENGTH = 2;
const MAX_SEARCH_QUERY_LENGTH = 100;

/**
 * Forma canônica de uma consulta para fins de cache/comparação: duas digitações que só diferem
 * em espaços nas pontas, espaços repetidos no meio ou maiúsculas contam como a mesma pesquisa.
 * Não substitui validação alguma — só decide se um novo texto merece uma nova busca.
 */
export function normalizeSearchQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-BR");
}

/** Mesmo corte que a API aceita; aplicado cedo para nunca guardar mais do que o servidor usaria. */
export function clampSearchQuery(query: string): string {
  return query.trim().slice(0, MAX_SEARCH_QUERY_LENGTH);
}

export function isSearchableQuery(query: string): boolean {
  return query.trim().length >= MIN_SEARCH_QUERY_LENGTH;
}

/**
 * Lê `?q=` (ou, por compatibilidade com links antigos, `?search=`) de um objeto com `.get()` —
 * tanto `URLSearchParams` (testável de forma pura) quanto o `ReadonlyURLSearchParams` que
 * `useSearchParams()` do Next devolve em tempo de execução.
 */
export function parseSearchQueryParam(params: { get(name: string): string | null }): string {
  const raw = params.get("q") ?? params.get("search") ?? "";
  return clampSearchQuery(raw);
}

/**
 * Link para a tela dedicada de busca. Sem consulta, abre em branco (foco no campo); com
 * consulta, preserva o texto na URL para a pessoa poder voltar a ele (compartilhar, recarregar,
 * apertar "Voltar" a partir do título aberto).
 */
export function searchPageHref(query?: string): string {
  const trimmed = query ? clampSearchQuery(query) : "";
  const base = appPagePath("busca");
  return trimmed ? `${base}?q=${encodeURIComponent(trimmed)}` : base;
}

/**
 * Cache em memória por sessão da tela: voltar para um prefixo já digitado (ou reabrir a mesma
 * busca vinda da URL) é instantâneo, sem esperar debounce nem rede de novo. Vive só na instância
 * do componente — cada montagem da tela começa vazia, o que evita mostrar resultado de uma conta
 * ou sessão anterior.
 */
export class SearchResultsCache<T> {
  readonly #entries = new Map<string, T>();

  get(query: string): T | undefined {
    return this.#entries.get(normalizeSearchQuery(query));
  }

  set(query: string, value: T): void {
    this.#entries.set(normalizeSearchQuery(query), value);
  }

  has(query: string): boolean {
    return this.#entries.has(normalizeSearchQuery(query));
  }
}
