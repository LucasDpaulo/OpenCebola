/** Contrato do motor local; não depende de React, servidor ou player específico. */
export interface TorrentRequest {
  readonly infoHash: string;
  readonly fileIdx: number | null;
  readonly filename?: string;
  readonly trackers: readonly string[];
}

export interface StreamingSession {
  readonly id: string;
  readonly url: string;
  readonly fileIdx: number;
  readonly filename?: string;
  readonly size?: number;
}

export interface StreamingStats {
  readonly phase: "metadata" | "buffering" | "streaming";
  readonly downloadBytesPerSecond: number;
  readonly uploadBytesPerSecond: number;
  readonly peers: number;
  readonly downloadedBytes: number;
}

export interface StreamingEngine {
  capabilities(): Promise<{ available: boolean; backend: string; reason?: string }>;
  /** Deve verificar DNS/destinos no aparelho e abortar a preparação quando solicitado. */
  prepare(request: TorrentRequest, signal: AbortSignal): Promise<StreamingSession>;
  subscribe(sessionId: string, listener: (stats: StreamingStats) => void): () => void;
  /** Idempotente: remover rota, leitores e atividade do torrent desta sessão. */
  stop(sessionId: string): Promise<void>;
  cacheInfo(): Promise<{ usedBytes: number; capacityBytes: number; protectedBytes: number }>;
  clearCache(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Aceitar apenas resposta da ponte nativa; nunca usar para validar fonte de addon. */
export function assertLocalSession(session: StreamingSession): void {
  const url = new URL(session.url);
  if (!session.id || session.id.length > 128 || session.url.length > 4_096 ||
      url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
      !url.port || Number(url.port) < 1 || url.username || url.password || url.hash ||
      !Number.isInteger(session.fileIdx) || session.fileIdx < 0) {
    throw new Error("O motor retornou uma sessão local inválida.");
  }
}

/** Serializa sessões e descarta preparação antiga mesmo se a ponte atrasar o cancelamento. */
export class StreamingSessionController {
  #generation = 0;
  #pending: AbortController | null = null;
  #active: StreamingSession | null = null;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly engine: StreamingEngine) {}

  #queue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result;
    return result;
  }

  async #release(): Promise<void> {
    const active = this.#active;
    if (!active) return;
    // Em caso de erro, manter a referência para tentar novamente antes de abrir outra.
    await this.engine.stop(active.id);
    this.#active = null;
  }

  prepare(request: TorrentRequest, signal?: AbortSignal): Promise<StreamingSession> {
    signal?.throwIfAborted();
    const generation = ++this.#generation;
    this.#pending?.abort();
    const pending = new AbortController();
    this.#pending = pending;
    const abort = () => pending.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const snapshot = { ...request, trackers: [...request.trackers] };
    return this.#queue(async () => {
      try {
        pending.signal.throwIfAborted();
        await this.#release();
        pending.signal.throwIfAborted();
        if (!(await this.engine.capabilities()).available) {
          throw new Error("Motor local indisponível neste aparelho.");
        }
        pending.signal.throwIfAborted();
        const session = await this.engine.prepare(snapshot, pending.signal);
        this.#active = session;
        try {
          pending.signal.throwIfAborted();
          if (generation !== this.#generation) throw new Error("Preparação substituída.");
          assertLocalSession(session);
          return session;
        } catch (error) {
          await this.#release();
          throw error;
        }
      } finally {
        signal?.removeEventListener("abort", abort);
        if (this.#pending === pending) this.#pending = null;
      }
    });
  }

  /** O chamador deve destruir o player antes de remover a rota da sessão ativa. */
  stop(): Promise<void> {
    ++this.#generation;
    this.#pending?.abort();
    return this.#queue(() => this.#release());
  }

  /** Cleanup de um player antigo nunca pode encerrar uma sessão mais nova. */
  stopSession(id: string): Promise<void> {
    return this.#queue(async () => {
      if (this.#active?.id === id) await this.#release();
    });
  }
}
