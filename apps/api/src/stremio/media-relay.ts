import { randomBytes } from "node:crypto";
import { pinnedMediaFetch, validatePublicMediaUrl } from "./safe-http.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

interface MediaTicket {
  readonly householdId: string;
  readonly url: string;
  readonly expiresAt: number;
}

export class MediaRelayError extends Error {
  readonly code: "NOT_FOUND" | "UPSTREAM_UNAVAILABLE";

  constructor(code: MediaRelayError["code"]) {
    super("Não foi possível transmitir esta opção.");
    this.name = "MediaRelayError";
    this.code = code;
  }
}

export class RealDebridMediaRelay {
  readonly #tickets = new Map<string, MediaTicket>();
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maximumTickets: number;

  constructor(options: {
    fetch?: typeof fetch;
    now?: () => number;
    ttlMs?: number;
    maximumTickets?: number;
  } = {}) {
    // Default pinado: validar a URL e depois usar o fetch global deixaria o DNS ser resolvido
    // de novo, reabrindo a janela de rebinding que o pinning existe para fechar. Os testes
    // continuam injetando o próprio duplo por este mesmo ponto.
    this.#fetch = options.fetch ?? pinnedMediaFetch;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? 6 * 60 * 60 * 1_000;
    // 2000: cada fonte direta emite um ticket por listagem, e com o teto de 200 fontes por
    // título o limite antigo era estourado em poucas listagens, despejando tickets ainda em uso.
    this.#maximumTickets = options.maximumTickets ?? 2_000;
  }

  issue(householdId: string, url: string): string {
    this.#prune();
    while (this.#tickets.size >= this.#maximumTickets) {
      const oldest = this.#tickets.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#tickets.delete(oldest);
    }
    const ticket = randomBytes(32).toString("base64url");
    this.#tickets.set(ticket, { householdId, url, expiresAt: this.#now() + this.#ttlMs });
    return ticket;
  }

  // Devolve o link real de um ticket (da mesma casa) para quem precisa LER a mídia no servidor,
  // como a extração de legenda embutida. Nunca vai para resposta nem log: carrega o token.
  resolveUrl(ticket: string, householdId: string): string {
    this.#prune();
    const record = this.#tickets.get(ticket);
    if (record === undefined || record.householdId !== householdId) {
      throw new MediaRelayError("NOT_FOUND");
    }
    return record.url;
  }

  async open(
    ticket: string,
    householdId: string,
    range: string | undefined,
    method: "GET" | "HEAD" = "GET"
  ): Promise<Response> {
    this.#prune();
    const record = this.#tickets.get(ticket);
    if (record === undefined || record.householdId !== householdId) {
      throw new MediaRelayError("NOT_FOUND");
    }
    if (range !== undefined && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) {
      throw new MediaRelayError("NOT_FOUND");
    }

    let response: Response | null = null;
    let currentUrl = record.url;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const validated = await validatePublicMediaUrl(currentUrl, { allowInsecure: false });
        response = await this.#fetch(validated.href, {
          method,
          headers: range === undefined ? undefined : { Range: range },
          redirect: "manual",
          signal: controller.signal
        });
        if (!REDIRECT_STATUSES.has(response.status)) break;
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || hop === MAX_REDIRECTS) throw new MediaRelayError("UPSTREAM_UNAVAILABLE");
        currentUrl = new URL(location, validated).href;
      }
    } catch {
      throw new MediaRelayError("UPSTREAM_UNAVAILABLE");
    } finally {
      clearTimeout(timeout);
    }
    if (response === null || (response.status !== 200 && response.status !== 206) ||
        (method === "GET" && response.body === null)) {
      await response?.body?.cancel();
      throw new MediaRelayError("UPSTREAM_UNAVAILABLE");
    }
    return response;
  }

  #prune(): void {
    const now = this.#now();
    for (const [ticket, record] of this.#tickets) {
      if (record.expiresAt <= now) this.#tickets.delete(ticket);
    }
  }
}
