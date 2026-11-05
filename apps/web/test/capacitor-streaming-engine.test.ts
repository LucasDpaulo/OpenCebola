import assert from "node:assert/strict";
import test from "node:test";
import { CapacitorStreamingEngine, type StreamingPlugin } from "../app/streaming/capacitor-streaming-engine.js";
import type { StreamingSession } from "../app/streaming/streaming-engine.js";

const request = { infoHash: "a".repeat(40), fileIdx: 4, trackers: ["udp://tracker.example.org:6969/a"] };
function plugin(overrides: Partial<StreamingPlugin>): StreamingPlugin {
  return { capabilities: async () => ({ available: true, backend: "test" }),
    prepare: async () => ({ id: "one", url: "http://127.0.0.1:9000/one", fileIdx: 4 }),
    cancel: async () => {}, stop: async () => {}, stats: async () => ({ phase: "streaming",
      downloadBytesPerSecond: 1, uploadBytesPerSecond: 0, peers: 1, downloadedBytes: 2 }),
    cacheInfo: async () => ({ usedBytes: 0, capacityBytes: 10, protectedBytes: 0 }),
    clearCache: async () => {}, shutdown: async () => {}, ...overrides };
}

test("ponte preserva hash, índice e trackers sem chamada à API", async () => {
  const engine = new CapacitorStreamingEngine(plugin({ prepare: async value => {
    assert.deepEqual({ ...value, requestId: undefined }, { ...request, requestId: undefined });
    assert.ok(value.requestId.length > 0);
    return { id: "one", url: "http://127.0.0.1:9000/one", fileIdx: 4 };
  } }));
  assert.equal((await engine.prepare(request, new AbortController().signal)).fileIdx, 4);
});

test("abortar envia cancelamento nativo e remove sessão que chegar depois", async () => {
  let finish!: (session: StreamingSession) => void;
  const calls: string[] = [];
  let id = "";
  const engine = new CapacitorStreamingEngine(plugin({
    prepare: value => { id = value.requestId; return new Promise(resolve => { finish = resolve; }); },
    cancel: async value => { assert.equal(value.requestId, id); calls.push("cancel"); },
    stop: async value => { calls.push(`stop:${value.id}`); }
  }));
  const abort = new AbortController();
  const preparing = engine.prepare(request, abort.signal);
  const rejected = assert.rejects(preparing);
  abort.abort();
  finish({ id: "late", url: "http://127.0.0.1:9000/late", fileIdx: 4 });
  await rejected;
  assert.deepEqual(calls, ["cancel", "stop:late"]);
});
