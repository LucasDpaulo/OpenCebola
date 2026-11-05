import { createHash } from "node:crypto";
import type {
  AuthProvider,
  AuthResult,
  AuthSession,
  PasswordCredentials
} from "./types.js";

/**
 * Por que existe.
 *
 * `verifySession` custa duas idas ao Supabase em série — a sessão pela hash do token e o
 * usuário pelo id — e toda rota autenticada começa por ela. Abrir a home dispara bootstrap,
 * editorial e um punhado de catálogos ao mesmo tempo; passear pelo catálogo dispara uma
 * consulta por card que recebe o ponteiro. Cada uma dessas pagava as duas viagens de novo,
 * para receber exatamente a mesma resposta.
 *
 * O que este invólucro NÃO faz: prolongar sessão morta. O TTL é de segundos, e as duas ações
 * que mudam uma sessão em uso — revogar e trocar de perfil — passam por aqui e apagam a
 * entrada. O que sobra de janela é uma sessão revogada em OUTRO processo continuar valendo por
 * até `ttlMs`. É o preço aceito, e é por isso que o TTL é curto: ele existe para colapsar a
 * rajada de uma tela, não para guardar sessão.
 */
export interface CachingAuthProviderOptions {
  readonly inner: AuthProvider;
  /** Curto de propósito. Ver o comentário acima antes de aumentar. */
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly maxEntries?: number;
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly session: AuthSession;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 5_000;

/** O token nunca fica em memória em claro: a chave é a hash, como no banco. */
function cacheKey(sessionToken: string): string {
  return createHash("sha256").update(sessionToken).digest("hex");
}

export class CachingAuthProvider implements AuthProvider {
  readonly #inner: AuthProvider;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #maxEntries: number;
  readonly #cache = new Map<string, CacheEntry>();
  /**
   * Rajada de requisições simultâneas com o mesmo token é o caso comum, não a exceção: a home
   * abre várias chamadas de uma vez. Sem isto, todas chegariam antes da primeira responder e
   * cada uma pagaria a viagem inteira.
   *
   * Serve também de trava de identidade. Uma verificação que já partiu só pode gravar seu
   * resultado se AINDA for o pedido corrente desta chave: revogar e trocar de perfil apagam a
   * entrada daqui, e com isso a resposta antiga chega e é descartada. Sem essa trava, o
   * `.then` de uma verificação em voo regravava no cache a sessão que acabara de ser revogada
   * — ou o perfil que acabara de ser trocado — e a garantia do comentário acima era falsa
   * exatamente quando mais importa, no meio de uma tela carregando.
   */
  readonly #pending = new Map<string, Promise<AuthSession>>();

  constructor(options: CachingAuthProviderOptions) {
    this.#inner = options.inner;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  async signInWithPassword(credentials: PasswordCredentials): Promise<AuthResult> {
    return this.#inner.signInWithPassword(credentials);
  }

  async issueSessionForUser(userId: string): Promise<AuthResult> {
    return this.#inner.issueSessionForUser(userId);
  }

  async verifySession(sessionToken: string): Promise<AuthSession> {
    const key = cacheKey(sessionToken);
    const cached = this.#cache.get(key);
    if (cached && this.#stillValid(cached)) return cached.session;
    this.#cache.delete(key);

    const alreadyAsked = this.#pending.get(key);
    if (alreadyAsked) return alreadyAsked;

    // Falha não entra no cache: token inválido precisa continuar sendo rejeitado pelo
    // provedor de verdade, e uma queda momentânea do Supabase não pode virar 401 grudado.
    const request: Promise<AuthSession> = this.#inner.verifySession(sessionToken).then((session) => {
      if (this.#pending.get(key) === request) this.#remember(key, session);
      return session;
    }).finally(() => {
      if (this.#pending.get(key) === request) this.#pending.delete(key);
    });

    this.#pending.set(key, request);
    return request;
  }

  async setActiveProfile(sessionToken: string, profileId: string | null): Promise<AuthSession> {
    const key = cacheKey(sessionToken);
    const session = await this.#inner.setActiveProfile(sessionToken, profileId);
    // Descartar o que estava em voo ANTES de guardar: uma verificação que começou antes da
    // troca traz o perfil velho, e sem isto ela sobrescreveria o novo. O usuário voltaria para
    // a tela de perfis e ficaria preso lá até o TTL vencer.
    this.#pending.delete(key);
    this.#remember(key, session);
    return session;
  }

  async revokeSession(sessionToken: string): Promise<void> {
    const key = cacheKey(sessionToken);
    // Apagar ANTES: se o provedor falhar no meio, o cache não pode ficar com a sessão morta.
    this.#forget(key);
    try {
      await this.#inner.revokeSession(sessionToken);
    } finally {
      this.#forget(key);
    }
  }

  /**
   * O TTL do cache não pode passar por cima do fim da sessão de verdade. Sem esta segunda
   * condição, uma sessão que expirava em 5 s continuava sendo aceita pelos 30 s do cache.
   */
  #stillValid(entry: CacheEntry): boolean {
    const now = this.#now();
    return entry.expiresAt > now && entry.session.expiresAt.getTime() > now;
  }

  #forget(key: string): void {
    this.#cache.delete(key);
    this.#pending.delete(key);
  }

  #remember(key: string, session: AuthSession): void {
    const entry: CacheEntry = { expiresAt: this.#now() + this.#ttlMs, session };
    if (!this.#stillValid(entry)) return;
    if (!this.#cache.has(key) && this.#cache.size >= this.#maxEntries) this.#evictOne();
    this.#cache.set(key, entry);
  }

  /**
   * Vencidas primeiro. A ordem do Map é de inserção, não de uso: despejar cegamente a primeira
   * joga fora uma entrada quente enquanto as vencidas continuam ocupando lugar.
   */
  #evictOne(): void {
    for (const [key, entry] of this.#cache) {
      if (!this.#stillValid(entry)) {
        this.#cache.delete(key);
        return;
      }
    }
    const oldest = this.#cache.keys().next().value;
    if (oldest !== undefined) this.#cache.delete(oldest);
  }
}
