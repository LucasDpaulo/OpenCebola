import { CapacitorStreamingEngine, localStreamingPlugin } from "./capacitor-streaming-engine";
import { StreamingSessionController, type TorrentRequest } from "./streaming-engine";

import { tauriStreamingPlugin } from "./tauri-streaming-engine";

import { tizenStreamingPlugin } from "./tizen-streaming-engine";

const nativePlugin = () => localStreamingPlugin() ?? tauriStreamingPlugin() ?? tizenStreamingPlugin();

let controller: StreamingSessionController | null = null;
export function localStreamingAvailable(): boolean { return nativePlugin() !== null; }

function sessions(): StreamingSessionController {
  if (controller) return controller;
  const plugin = nativePlugin();
  if (!plugin) throw new Error("Motor local indisponível neste aparelho.");
  controller = new StreamingSessionController(new CapacitorStreamingEngine(plugin));
  return controller;
}

export function prepareLocalTorrent(request: TorrentRequest, signal: AbortSignal) {
  return sessions().prepare(request, signal);
}

export async function releaseLocalTorrent(id: string): Promise<void> {
  await controller?.stopSession(id);
}

export function onLocalStreamingStopped(listener: (event: { id?: string; reason: string }) => void): () => void {
  let disposed = false;
  // A ponte injetada do Capacitor retorna o handle diretamente; Tauri retorna Promise.
  const handle = Promise.resolve(nativePlugin()?.addListener?.("stopped", event => {
    if (!disposed) listener(event);
  }));
  void handle.catch(() => {});
  return () => {
    disposed = true;
    void handle.then(subscription => subscription?.remove()).catch(() => {});
  };
}
