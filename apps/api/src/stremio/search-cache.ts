/**
 * Normaliza a consulta de busca para fins de chave de cache: mesma casa e mesmo texto (a menos
 * de espaços redundantes e caixa) devolvem a mesma entrada. Não é a validação da rota (isso é o
 * schema Zod) — só a forma que decide se duas digitações "contam" como a mesma pesquisa.
 */
export function normalizeSearchQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-BR");
}

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

const DEFAULT_TTL_MS = 2 * 60_000;
const DEFAULT_MAX_ENTRIES = 300;

/**
 * Cache pequeno e efêmero por (casa, consulta normalizada). A busca em tempo real reenvia a
 * mesma pergunta várias vezes por sessão — apagar e retomar um prefixo já visto, digitar devagar
 * e corrigir. Sem isto cada uma dessas repetições reabriria todos os add-ons da casa de novo. Um
 * `Map` guarda ordem de inserção "de graça", então despejar o mais antigo ao estourar o teto é só
 * remover a primeira chave — não é um LRU de verdade, mas para um amortecedor de digitação com
 * TTL curto isso é suficiente e mais simples de auditar.
 */
export class SearchResultCache<T> {
  readonly #entries = new Map<string, CacheEntry<T>>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(options?: { readonly ttlMs?: number; readonly maxEntries?: number; readonly now?: () => number }) {
    this.#ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.#maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#now = options?.now ?? Date.now;
  }

  #key(householdId: string, query: string): string {
    return `${householdId}\u0000${normalizeSearchQuery(query)}`;
  }

  get(householdId: string, query: string): T | undefined {
    const key = this.#key(householdId, query);
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(householdId: string, query: string, value: T): void {
    const key = this.#key(householdId, query);
    // Reinserir move a chave para o fim da ordem de iteração, então uma releitura recente não é
    // a primeira candidata a sair quando o teto é atingido.
    this.#entries.delete(key);
    if (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    this.#entries.set(key, { value, expiresAt: this.#now() + this.#ttlMs });
  }

  /** Só para teste: quantas entradas estão guardadas agora (incluindo expiradas ainda não lidas). */
  get size(): number {
    return this.#entries.size;
  }
}
