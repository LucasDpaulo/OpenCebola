import type { StreamingEngine, StreamingSession, StreamingStats, TorrentRequest } from "./streaming-engine";

export interface StreamingListenerHandle {
  remove(): Promise<void> | void;
}

export interface StreamingPlugin {
  addListener?(name: "stopped", listener: (event: { id?: string; reason: string }) => void):
    StreamingListenerHandle | Promise<StreamingListenerHandle>;
  capabilities(): ReturnType<StreamingEngine["capabilities"]>;
  prepare(request: TorrentRequest & { requestId: string }): Promise<StreamingSession>;
  cancel(request: { requestId: string }): Promise<void>;
  stop(request: { id: string }): Promise<void>;
  stats(request: { id: string }): Promise<StreamingStats>;
  cacheInfo(): ReturnType<StreamingEngine["cacheInfo"]>;
  clearCache(): Promise<void>;
  shutdown(): Promise<void>;
}

export function localStreamingPlugin(): StreamingPlugin | null {
  if (typeof window === "undefined") return null;
  const capacitor = (window as Window & { Capacitor?: {
    isNativePlatform?: () => boolean; Plugins?: { Streaming?: StreamingPlugin };
  } }).Capacitor;
  return capacitor?.isNativePlatform?.() === true ? capacitor.Plugins?.Streaming ?? null : null;
}

export class CapacitorStreamingEngine implements StreamingEngine {
  constructor(private readonly plugin: StreamingPlugin) {}
  capabilities() { return this.plugin.capabilities(); }

  async prepare(request: TorrentRequest, signal: AbortSignal): Promise<StreamingSession> {
    signal.throwIfAborted();
    const requestId = crypto.randomUUID();
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      cancellation ??= this.plugin.cancel({ requestId });
      // O erro é observado aqui e propagado após a resposta, sem rejeição não tratada.
      void cancellation.catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      // Invocar prepare antes de qualquer await garante a ordem na ponte.
      const session = await this.plugin.prepare({ ...request, requestId });
      if (signal.aborted) {
        await this.plugin.stop({ id: session.id });
        await cancellation;
        signal.throwIfAborted();
      }
      return session;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  subscribe(id: string, listener: (stats: StreamingStats) => void): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const stats = await this.plugin.stats({ id });
        if (!stopped) listener(stats);
      } catch { stopped = true; }
      if (!stopped) timer = setTimeout(() => { void poll(); }, 1_000);
    };
    void poll();
    return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
  }
  stop(id: string) { return this.plugin.stop({ id }); }
  cacheInfo() { return this.plugin.cacheInfo(); }
  clearCache() { return this.plugin.clearCache(); }
  shutdown() { return this.plugin.shutdown(); }
}
