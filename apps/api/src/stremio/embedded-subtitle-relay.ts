import { randomBytes } from "node:crypto";
import { extractMkvSubtitleVtt, listMkvSubtitleTracks, type MkvSubtitleTrack } from "./mkv-subtitles.js";
import { openRemoteMedia } from "./mkv-remote.js";

// Extrair custa centenas de leituras de ~0,9 s cada (em paralelo): o total é maior que o da listagem.
const EXTRACT_TIMEOUT_MS = 60_000;

interface EmbeddedTicket {
  readonly url: string;
  readonly expiresAt: number;
}

export class EmbeddedSubtitleError extends Error {
  constructor() {
    super("Legenda embutida não encontrada.");
    this.name = "EmbeddedSubtitleError";
  }
}

/**
 * Mesmo desenho do SubtitleRelay: o motor de legenda do aparelho não carrega cookie, então o
 * ticket aleatório é a autorização temporária para UMA mídia, sem expor o link dela (que traz o
 * token do Real-Debrid/Torrentio). Guarda também o VTT já extraído (extrair custa dezenas de
 * Range na VM de 1 OCPU) e junta extrações simultâneas da mesma faixa numa única Promise.
 */
export class EmbeddedSubtitleRelay {
  readonly #tickets = new Map<string, EmbeddedTicket>();
  readonly #byUrl = new Map<string, string>();
  readonly #vtt = new Map<string, string>();
  readonly #pending = new Map<string, Promise<string>>();
  readonly #listTracks: (url: string) => Promise<readonly MkvSubtitleTrack[]>;
  readonly #extract: (url: string, track: number) => Promise<string>;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maximumTickets: number;
  readonly #maximumVtt: number;

  constructor(options: {
    listTracks?: (url: string) => Promise<readonly MkvSubtitleTrack[]>;
    extract?: (url: string, track: number) => Promise<string>;
    now?: () => number;
    ttlMs?: number;
    maximumTickets?: number;
    maximumVtt?: number;
  } = {}) {
    this.#listTracks = options.listTracks ?? (async (url) =>
      (await listMkvSubtitleTracks((await openRemoteMedia(url)).readRange)).tracks);
    this.#extract = options.extract ?? (async (url, track) =>
      extractMkvSubtitleVtt((await openRemoteMedia(url, { timeoutMs: EXTRACT_TIMEOUT_MS })).readRange, track));
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? 6 * 60 * 60 * 1_000;
    this.#maximumTickets = options.maximumTickets ?? 500;
    this.#maximumVtt = options.maximumVtt ?? 30;
  }

  /** Lista as faixas indexadas e devolve o ticket. Quem chama já validou a URL como pública. */
  async list(url: string): Promise<{ ticket: string; tracks: readonly MkvSubtitleTrack[] }> {
    const tracks = await this.#listTracks(url);
    return { ticket: this.#issue(url), tracks };
  }

  async open(ticket: string, track: number): Promise<string> {
    this.#prune();
    const record = this.#tickets.get(ticket);
    if (!record) throw new EmbeddedSubtitleError();
    const key = `${ticket}:${track}`;
    const cached = this.#vtt.get(key);
    if (cached !== undefined) return cached;
    let pending = this.#pending.get(key);
    if (!pending) {
      pending = this.#extract(record.url, track).then((vtt) => {
        while (this.#vtt.size >= this.#maximumVtt) {
          const oldest = this.#vtt.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.#vtt.delete(oldest);
        }
        this.#vtt.set(key, vtt);
        return vtt;
      }).finally(() => this.#pending.delete(key));
      this.#pending.set(key, pending);
    }
    return pending;
  }

  #issue(url: string): string {
    this.#prune();
    // Mesma mídia listada de novo reaproveita o ticket: evita encher o teto com repetições.
    const existing = this.#byUrl.get(url);
    if (existing !== undefined && this.#tickets.has(existing)) return existing;
    while (this.#tickets.size >= this.#maximumTickets) {
      const oldest = this.#tickets.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#drop(oldest);
    }
    const ticket = randomBytes(32).toString("base64url");
    this.#tickets.set(ticket, { url, expiresAt: this.#now() + this.#ttlMs });
    this.#byUrl.set(url, ticket);
    return ticket;
  }

  #drop(ticket: string): void {
    const record = this.#tickets.get(ticket);
    this.#tickets.delete(ticket);
    if (record && this.#byUrl.get(record.url) === ticket) this.#byUrl.delete(record.url);
    for (const key of [...this.#vtt.keys()]) if (key.startsWith(`${ticket}:`)) this.#vtt.delete(key);
  }

  #prune(): void {
    const now = this.#now();
    for (const [ticket, record] of this.#tickets) {
      if (record.expiresAt <= now) this.#drop(ticket);
    }
  }
}
