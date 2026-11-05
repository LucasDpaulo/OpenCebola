import { randomBytes } from "node:crypto";
import { getSafeText } from "./safe-http.js";

interface SubtitleTicket {
  readonly url: string;
  readonly expiresAt: number;
}

export class SubtitleRelayError extends Error {
  constructor() {
    super("Legenda temporária não encontrada.");
    this.name = "SubtitleRelayError";
  }
}

/**
 * O motor nativo não carrega cookie nem Bearer ao abrir uma legenda. O ticket aleatório é a
 * autorização mínima e temporária para aquele arquivo, sem expor a URL original do add-on.
 */
export class SubtitleRelay {
  readonly #tickets = new Map<string, SubtitleTicket>();
  readonly #fetchText: (url: string) => Promise<string>;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maximumTickets: number;

  constructor(options: {
    fetchText?: (url: string) => Promise<string>;
    now?: () => number;
    ttlMs?: number;
    maximumTickets?: number;
  } = {}) {
    this.#fetchText = options.fetchText ?? getSafeText;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? 6 * 60 * 60 * 1_000;
    this.#maximumTickets = options.maximumTickets ?? 2_000;
  }

  issue(url: string): string {
    this.#prune();
    while (this.#tickets.size >= this.#maximumTickets) {
      const oldest = this.#tickets.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#tickets.delete(oldest);
    }
    const ticket = randomBytes(32).toString("base64url");
    this.#tickets.set(ticket, { url, expiresAt: this.#now() + this.#ttlMs });
    return ticket;
  }

  async open(ticket: string): Promise<string> {
    this.#prune();
    const record = this.#tickets.get(ticket);
    if (!record) throw new SubtitleRelayError();
    // Não reter o texto: 2.000 arquivos no teto de 5 MiB consumiriam 10 GiB da VM. O cliente
    // usa cache HTTP por uma hora; aqui fica apenas o destino opaco e temporário.
    return this.#fetchText(record.url);
  }

  #prune(): void {
    const now = this.#now();
    for (const [ticket, record] of this.#tickets) {
      if (record.expiresAt <= now) this.#tickets.delete(ticket);
    }
  }
}
