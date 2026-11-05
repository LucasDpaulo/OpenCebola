import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { StreamingPlugin } from "./capacitor-streaming-engine";

export function tauriStreamingPlugin(): StreamingPlugin | null {
  if (typeof window === "undefined" ||
      (window as Window & { __CEBOLA_LOCAL_STREAMING__?: boolean }).__CEBOLA_LOCAL_STREAMING__ !== true) return null;
  const call = <T>(action: string, payload: unknown = {}) => invoke<T>("streaming", { action, payload });
  return {
    capabilities: () => call("capabilities"),
    prepare: request => call("prepare", request),
    cancel: request => call("cancel", request),
    stop: request => call("stop", request),
    stats: request => call("stats", request),
    cacheInfo: () => call("cacheInfo"),
    clearCache: () => call("clearCache"),
    shutdown: () => call("shutdown"),
    addListener: async (_name, listener) => {
      const unlisten = await listen<{ id?: string; reason: string }>("streaming-stopped", event => listener(event.payload));
      return { remove: async () => unlisten() };
    }
  };
}
