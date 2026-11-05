import assert from "node:assert/strict";
import test from "node:test";
import { onLocalStreamingStopped } from "../app/streaming/local-streaming.js";
import type { StreamingPlugin, StreamingListenerHandle } from "../app/streaming/capacitor-streaming-engine.js";

function install(addListener: StreamingPlugin["addListener"]) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    Capacitor: { isNativePlatform: () => true, Plugins: { Streaming: { addListener } } }
  } });
  return () => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  };
}

test("listener direto do Capacitor não derruba a página e é removido ao sair", async () => {
  let emit!: (event: { reason: string }) => void;
  let removed = 0;
  const restore = install((_name, callback) => { emit = callback; return { remove() { removed++; } }; });
  try {
    const events: string[] = [];
    const dispose = onLocalStreamingStopped(event => events.push(event.reason));
    emit({ reason: "BACKGROUND" });
    dispose();
    emit({ reason: "STORAGE_LIMIT" });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, ["BACKGROUND"]);
    assert.equal(removed, 1);
  } finally { restore(); }
});

test("listener assíncrono é removido mesmo se chegar após sair da página", async () => {
  let finish!: (handle: StreamingListenerHandle) => void;
  let removed = 0;
  const restore = install(() => new Promise(resolve => { finish = resolve; }));
  try {
    const dispose = onLocalStreamingStopped(() => assert.fail("evento após sair"));
    dispose();
    finish({ remove: async () => { removed++; } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(removed, 1);
  } finally { restore(); }
});

test("ponte sem listener e rejeição assíncrona não derrubam a página", async () => {
  for (const addListener of [undefined, () => Promise.reject(new Error("indisponível"))]) {
    const restore = install(addListener);
    try {
      onLocalStreamingStopped(() => {})();
      await new Promise(resolve => setImmediate(resolve));
    } finally { restore(); }
  }
});
