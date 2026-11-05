import assert from "node:assert/strict";
import test from "node:test";
import { discoverStreams } from "../app/player/stream-discovery.js";

interface FakeStream {
  readonly id: string;
  readonly label?: string;
}

interface FakeTarget {
  readonly name: string;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Dá uma volta completa pelo event loop, suficiente para qualquer cadeia de microtasks pendente. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("publica o lote do servidor antes do navegador lento responder", async () => {
  const batches: Array<readonly FakeStream[]> = [];
  const browserDeferred = createDeferred<readonly FakeStream[]>();

  const donePromise = discoverStreams<FakeStream, FakeTarget>({
    server: () => Promise.resolve([{ id: "server-1" }]),
    browserTargets: () => Promise.resolve([{ name: "addon-lento" }]),
    importTarget: () => browserDeferred.promise,
    onBatch: (streams) => batches.push(streams)
  });

  await flush();
  assert.deepEqual(batches, [[{ id: "server-1" }]]);

  browserDeferred.resolve([{ id: "browser-1" }]);
  await donePromise;

  assert.deepEqual(batches, [
    [{ id: "server-1" }],
    [{ id: "server-1" }, { id: "browser-1" }]
  ]);
});

test("falha isolada de um alvo do navegador nao apaga lotes ja publicados", async () => {
  const batches: Array<readonly FakeStream[]> = [];

  await discoverStreams<FakeStream, FakeTarget>({
    server: () => Promise.resolve([{ id: "server-1" }]),
    browserTargets: () => Promise.resolve([{ name: "ok" }, { name: "quebrado" }]),
    importTarget: (target) => target.name === "quebrado"
      ? Promise.reject(new Error("addon indisponivel"))
      : Promise.resolve([{ id: "browser-ok" }]),
    onBatch: (streams) => batches.push(streams)
  });

  assert.ok(batches.length > 0);
  const last = batches[batches.length - 1] ?? [];
  const ids = [...last].map((stream) => stream.id).sort();
  assert.deepEqual(ids, ["browser-ok", "server-1"]);
});

test("falha do servidor nao impede o lote do navegador", async () => {
  const batches: Array<readonly FakeStream[]> = [];

  await discoverStreams<FakeStream, FakeTarget>({
    server: () => Promise.reject(new Error("servidor fora do ar")),
    browserTargets: () => Promise.resolve([{ name: "addon" }]),
    importTarget: () => Promise.resolve([{ id: "browser-1" }]),
    onBatch: (streams) => batches.push(streams)
  });

  assert.deepEqual(batches, [[{ id: "browser-1" }]]);
});

test("sinal abortado impede publicacao tardia", async () => {
  const batches: Array<readonly FakeStream[]> = [];
  const controller = new AbortController();
  const serverDeferred = createDeferred<readonly FakeStream[]>();

  const donePromise = discoverStreams<FakeStream, FakeTarget>({
    server: () => serverDeferred.promise,
    browserTargets: () => Promise.resolve([]),
    importTarget: () => Promise.resolve([]),
    signal: controller.signal,
    onBatch: (streams) => batches.push(streams)
  });

  controller.abort();
  serverDeferred.resolve([{ id: "tardio" }]);
  await donePromise;

  assert.deepEqual(batches, []);
});

test("deduplica lotes por stream.id mantendo a lista cumulativa", async () => {
  const batches: Array<readonly FakeStream[]> = [];

  await discoverStreams<FakeStream, FakeTarget>({
    server: () => Promise.resolve([{ id: "compartilhado", label: "do servidor" }]),
    browserTargets: () => Promise.resolve([{ name: "addon" }]),
    importTarget: () => Promise.resolve([
      { id: "compartilhado", label: "do navegador" },
      { id: "novo", label: "extra" }
    ]),
    onBatch: (streams) => batches.push(streams)
  });

  const last = batches[batches.length - 1] ?? [];
  assert.equal(last.length, 2);
  assert.ok(last.some((stream) => stream.id === "novo"));
});
