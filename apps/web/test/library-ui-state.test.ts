import assert from "node:assert/strict";
import test from "node:test";
import type { LibraryItem } from "@cebola/contracts";
import { applyLibraryChange, type LibraryToggleTarget } from "../app/library-client.js";
import { buildRecommendationSignals } from "../app/home-experience.js";

function target(overrides: Partial<LibraryToggleTarget> = {}): LibraryToggleTarget {
  return {
    id: "tt0111161",
    type: "movie",
    name: "Um Sonho de Liberdade",
    poster: "https://images.example.com/poster.jpg",
    background: null,
    description: null,
    releaseInfo: "1994",
    ...overrides
  };
}

function accountItem(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    addonId: "com.stremio.addon",
    mediaId: "tt0111161",
    mediaType: "movie",
    name: "Um Sonho de Liberdade",
    posterUrl: "https://images.example.com/poster.jpg",
    backgroundUrl: null,
    description: null,
    releaseInfo: "1994",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function respostaJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("applyLibraryChange adiciona de forma otimista e confirma com o item devolvido pelo servidor", async () => {
  const item = target();
  const servidor = accountItem();
  const otimistas: (readonly LibraryItem[])[] = [];
  let pedido: { path: string; init?: RequestInit } | null = null;

  const resultado = await applyLibraryChange({
    current: [],
    item,
    addonId: "com.stremio.addon",
    onOptimistic: (next) => otimistas.push(next),
    request: async (path, init) => {
      pedido = { path, init };
      return respostaJson(200, servidor);
    }
  });

  // Otimista: a UI já reflete o item ANTES da rede responder, com um id provisório.
  assert.equal(otimistas.length, 1);
  assert.equal(otimistas[0]!.length, 1);
  assert.notEqual(otimistas[0]![0]!.id, servidor.id);
  assert.equal(otimistas[0]![0]!.mediaId, item.id);

  assert.equal(resultado.ok, true);
  assert.deepEqual(resultado.items, [servidor]);
  assert.equal(pedido!.path, "/v1/library");
  assert.equal(pedido!.init?.method, "PUT");
  const corpo = JSON.parse(pedido!.init!.body as string) as { mediaId: string; mediaType: string };
  assert.equal(corpo.mediaId, "tt0111161");
  assert.equal(corpo.mediaType, "movie");
});

test("applyLibraryChange remove de forma otimista e confirma quando o DELETE responde 204", async () => {
  const existente = accountItem();
  const item = target();
  const otimistas: (readonly LibraryItem[])[] = [];
  let pedido: { path: string; init?: RequestInit } | null = null;

  const resultado = await applyLibraryChange({
    current: [existente],
    item,
    addonId: "com.stremio.addon",
    onOptimistic: (next) => otimistas.push(next),
    request: async (path, init) => {
      pedido = { path, init };
      return new Response(null, { status: 204 });
    }
  });

  assert.deepEqual(otimistas[0], []);
  assert.equal(resultado.ok, true);
  assert.deepEqual(resultado.items, []);
  assert.match(pedido!.path, /\/v1\/library\/movie\/tt0111161$/);
  assert.equal(pedido!.init?.method, "DELETE");
});

test("applyLibraryChange reverte para o estado anterior quando o PUT falha", async () => {
  const anterior: readonly LibraryItem[] = [accountItem({ mediaId: "tt0468569", name: "Outra obra" })];
  const item = target();

  const resultado = await applyLibraryChange({
    current: anterior,
    item,
    addonId: "com.stremio.addon",
    onOptimistic: () => undefined,
    request: async () => respostaJson(500, { error: { code: "OOPS", message: "falhou" } })
  });

  assert.equal(resultado.ok, false);
  // Mesma referência: o chamador só precisa aplicar `result.items` de volta, sem lógica própria.
  assert.equal(resultado.items, anterior);
});

test("applyLibraryChange reverte para o estado anterior quando o DELETE falha", async () => {
  const existente = accountItem();
  const anterior: readonly LibraryItem[] = [existente];
  const item = target();

  const resultado = await applyLibraryChange({
    current: anterior,
    item,
    addonId: "com.stremio.addon",
    onOptimistic: () => undefined,
    request: async () => respostaJson(404, { error: { code: "LIBRARY_ITEM_NOT_FOUND", message: "sumiu" } })
  });

  assert.equal(resultado.ok, false);
  assert.equal(resultado.items, anterior);
});

test("applyLibraryChange reverte quando a rede lança uma exceção", async () => {
  const anterior: readonly LibraryItem[] = [];
  const item = target();

  const resultado = await applyLibraryChange({
    current: anterior,
    item,
    addonId: "com.stremio.addon",
    onOptimistic: () => undefined,
    request: async () => { throw new Error("offline"); }
  });

  assert.equal(resultado.ok, false);
  assert.equal(resultado.items, anterior);
});

test("applyLibraryChange reverte quando o corpo devolvido pelo PUT é inválido", async () => {
  const anterior: readonly LibraryItem[] = [];
  const item = target();

  const resultado = await applyLibraryChange({
    current: anterior,
    item,
    addonId: "com.stremio.addon",
    onOptimistic: () => undefined,
    request: async () => respostaJson(200, { lixo: true })
  });

  assert.equal(resultado.ok, false);
  assert.equal(resultado.items, anterior);
});

test("buildRecommendationSignals usa mediaId/mediaType/name da lista canônica da biblioteca", () => {
  const library: readonly LibraryItem[] = [accountItem({ mediaId: "tt0468569", mediaType: "series", name: "Batman", releaseInfo: "2004" })];

  const signals = buildRecommendationSignals(library, []);

  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.origin, "library");
  assert.equal(signals[0]!.lookup.mediaId, "tt0468569");
  assert.equal(signals[0]!.lookup.type, "series");
  assert.equal(signals[0]!.lookup.title, "Batman");
  assert.equal(signals[0]!.lookup.year, 2004);
  assert.equal(signals[0]!.weight, 2.5);
});

test("buildRecommendationSignals combina peso de biblioteca e progresso para a mesma obra", () => {
  const library: readonly LibraryItem[] = [accountItem({ mediaId: "tt0468569", mediaType: "series", name: "Batman" })];
  const progress = [{
    id: "p1", addonId: null, playbackAddonId: null, mediaId: "tt0468569", videoId: "tt0468569:1:1",
    mediaType: "series" as const, title: "Batman", episodeTitle: null, season: 1, episode: 1,
    posterUrl: null, positionSeconds: 500, durationSeconds: 1_000, completed: false,
    updatedAt: new Date().toISOString()
  }];

  const signals = buildRecommendationSignals(library, progress);

  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.origin, "watched");
  assert.ok(signals[0]!.weight > 2.5);
});

test("uma escrita de biblioteca rejeitada não influencia os sinais de recomendação", async () => {
  const anterior: readonly LibraryItem[] = [accountItem({ mediaId: "tt0468569", mediaType: "series", name: "Batman" })];
  const item = target({ id: "tt9999999", type: "movie", name: "Filme rejeitado" });

  const resultado = await applyLibraryChange({
    current: anterior,
    item,
    addonId: "com.stremio.addon",
    onOptimistic: () => undefined,
    request: async () => respostaJson(500, { error: { code: "OOPS", message: "falhou" } })
  });

  // O chamador aplica `result.items` (revertido) antes de recalcular recomendações.
  const signals = buildRecommendationSignals(resultado.items, []);

  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.lookup.mediaId, "tt0468569");
  assert.ok(!signals.some((signal) => signal.lookup.mediaId === "tt9999999"));
});
