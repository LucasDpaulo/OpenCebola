import assert from "node:assert/strict";
import test from "node:test";
import { tauriStreamingPlugin } from "../app/streaming/tauri-streaming-engine.js";

test("ponte Linux só ativa com capacidade nativa e encaminha fonte/cancelamento sem RD", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const calls: unknown[] = [];
  const bridge = { __CEBOLA_LOCAL_STREAMING__: false, __TAURI_INTERNALS__: {
    invoke: async (command: string, args: unknown) => { calls.push({ command, args }); return {}; }
  } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: bridge });
  try {
    assert.equal(tauriStreamingPlugin(), null);
    bridge.__CEBOLA_LOCAL_STREAMING__ = true;
    const plugin = tauriStreamingPlugin(); assert.ok(plugin);
    const source = { requestId: "request-1", infoHash: "a".repeat(40), fileIdx: 2, trackers: ["udp://tracker.example:80/a"] };
    await plugin.prepare(source);
    await plugin.cancel({ requestId: "request-1" });
    await plugin.stop({ id: "request-1" });
    assert.deepEqual(calls, [
      { command: "streaming", args: { action: "prepare", payload: source } },
      { command: "streaming", args: { action: "cancel", payload: { requestId: "request-1" } } },
      { command: "streaming", args: { action: "stop", payload: { id: "request-1" } } }
    ]);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
