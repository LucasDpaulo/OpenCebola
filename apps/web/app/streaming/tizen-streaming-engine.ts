import { aoEventoCasca, enviarCasca, motorLocalCasca } from "../tv/tizen-casca";
import type { StreamingPlugin } from "./capacitor-streaming-engine";

export function tizenStreamingPlugin(): StreamingPlugin | null {
  if (!motorLocalCasca()) return null;
  const call = <T>(op: string, args: Record<string, unknown> = {}): Promise<T> =>
    enviarCasca(`streaming.${op}`, args, op === "prepare" ? 70_000 : 20_000) as Promise<T>;
  return {
    capabilities: () => call("capabilities"),
    prepare: args => call("prepare", { ...args }),
    cancel: args => call("cancel", args),
    stop: args => call("stop", args),
    stats: args => call("stats", args),
    cacheInfo: () => call("cacheInfo"),
    clearCache: () => call("clearCache"),
    shutdown: () => call("shutdown"),
    addListener: (_name, listener) => ({ remove: aoEventoCasca(event => {
      if (event.tipo !== "streaming-stopped" || !event.valor || typeof event.valor !== "object") return;
      const value = event.valor as { reason?: unknown; id?: unknown };
      if (typeof value.reason === "string") listener({ reason: value.reason,
        ...(typeof value.id === "string" ? { id: value.id } : {}) });
    }) })
  };
}
