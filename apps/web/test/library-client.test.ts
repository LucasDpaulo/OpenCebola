import assert from "node:assert/strict";
import test from "node:test";
import type { LibraryItem } from "@cebola/contracts";
import { setCredential } from "../app/api-client.js";
import {
  importLegacyLibrary,
  libraryMigrationKey,
  mergeLibraryItems,
  readLegacyLibrary
} from "../app/library-client.js";

const PROFILE_ID = "profile-1";
const LEGACY_KEY = `cebola:library:${PROFILE_ID}`;

function memoriaLocal(): Storage {
  const dados = new Map<string, string>();
  return {
    get length() { return dados.size; },
    clear: () => dados.clear(),
    getItem: (chave: string) => dados.get(chave) ?? null,
    key: (indice: number) => [...dados.keys()][indice] ?? null,
    removeItem: (chave: string) => { dados.delete(chave); },
    setItem: (chave: string, valor: string) => { dados.set(chave, valor); }
  } satisfies Storage;
}

function preparar(respostas: readonly (() => Response)[]): { pedidos: string[]; corpos: string[] } {
  const pedidos: string[] = [];
  const corpos: string[] = [];
  let indice = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    pedidos.push(String(url));
    corpos.push(typeof init?.body === "string" ? init.body : "");
    const proxima = respostas[Math.min(indice, respostas.length - 1)];
    indice += 1;
    return proxima!();
  }) as typeof globalThis.fetch;
  return { pedidos, corpos };
}

function respostaOk(items: readonly unknown[]): () => Response {
  return () => new Response(JSON.stringify({ items }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function respostaErro(status = 500): () => Response {
  return () => new Response(JSON.stringify({ error: { code: "OOPS", message: "falhou" } }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function accountItem(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    addonId: "com.stremio.addon",
    mediaId: "tt0111161",
    mediaType: "movie",
    name: "Um Sonho de Liberdade (conta)",
    posterUrl: "https://images.example.com/conta.jpg",
    backgroundUrl: null,
    description: null,
    releaseInfo: "1994",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function legacyRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "tt0111161",
    type: "movie",
    name: "Um Sonho de Liberdade (aparelho)",
    poster: "https://images.example.com/aparelho.jpg",
    background: null,
    description: null,
    releaseInfo: "1994",
    addonId: "com.stremio.addon",
    ...overrides
  };
}

test.beforeEach(() => {
  setCredential({ kind: "cookie" });
  (globalThis as { window?: unknown }).window = undefined;
  (globalThis as { localStorage?: Storage }).localStorage = memoriaLocal();
});

test("libraryMigrationKey inclui o profileId e uma versão", () => {
  assert.equal(libraryMigrationKey("abc"), "cebola:library:migrated:abc:v1");
});

test("readLegacyLibrary ignora lixo total no storage, sem lançar", () => {
  globalThis.localStorage.setItem(LEGACY_KEY, "isto não é json");
  assert.deepEqual(readLegacyLibrary(PROFILE_ID), []);
});

test("readLegacyLibrary descarta entradas inválidas e mantém as válidas", () => {
  globalThis.localStorage.setItem(LEGACY_KEY, JSON.stringify([
    null,
    42,
    { id: "sem-tipo" },
    legacyRaw({ id: "tt0468569", name: "Batman", poster: 123 })
  ]));

  const itens = readLegacyLibrary(PROFILE_ID);

  assert.equal(itens.length, 1);
  assert.equal(itens[0]!.mediaId, "tt0468569");
  assert.equal(itens[0]!.name, "Batman");
  // Campo de identidade ausente/errado descarta o item inteiro; URL decorativa inválida
  // (número em vez de string) apenas vira null, sem derrubar o item.
  assert.equal(itens[0]!.posterUrl, null);
});

test("mergeLibraryItems une itens por tipo + ID quando não há conflito", () => {
  const conta = [accountItem()];
  const local = [{
    addonId: "com.stremio.addon",
    mediaId: "tt0468569",
    mediaType: "series" as const,
    name: "Outra obra",
    posterUrl: null,
    backgroundUrl: null,
    description: null,
    releaseInfo: null
  }];

  const unidos = mergeLibraryItems(conta, local);

  assert.equal(unidos.length, 2);
  assert.ok(unidos.some((item) => item.mediaId === "tt0111161"));
  const novo = unidos.find((item) => item.mediaId === "tt0468569");
  assert.ok(novo);
  assert.equal(novo!.mediaType, "series");
  assert.equal(novo!.name, "Outra obra");
  assert.notEqual(novo!.id, "");
});

test("mergeLibraryItems prefere o item da conta em conflito de tipo + ID", () => {
  const conta = [accountItem({ name: "Nome da conta" })];
  const local = [{
    addonId: "com.stremio.addon",
    mediaId: "tt0111161",
    mediaType: "movie" as const,
    name: "Nome do aparelho",
    posterUrl: "https://images.example.com/aparelho.jpg",
    backgroundUrl: null,
    description: null,
    releaseInfo: "1994"
  }];

  const unidos = mergeLibraryItems(conta, local);

  assert.equal(unidos.length, 1);
  assert.equal(unidos[0]!.name, "Nome da conta");
  assert.equal(unidos[0]!.id, conta[0]!.id);
});

test("importLegacyLibrary importa uma única vez após sucesso", async () => {
  globalThis.localStorage.setItem(LEGACY_KEY, JSON.stringify([legacyRaw()]));
  const itemImportado = accountItem({ id: "33333333-3333-3333-3333-333333333333" });
  const { pedidos, corpos } = preparar([respostaOk([itemImportado])]);

  const primeira = await importLegacyLibrary(PROFILE_ID, []);

  assert.equal(primeira.synced, true);
  assert.deepEqual(primeira.items, [itemImportado]);
  assert.equal(pedidos.length, 1);
  assert.match(pedidos[0]!, /\/v1\/library\/import$/);
  const corpoEnviado = JSON.parse(corpos[0]!) as { items: readonly unknown[] };
  assert.equal(corpoEnviado.items.length, 1);
  assert.equal(globalThis.localStorage.getItem(libraryMigrationKey(PROFILE_ID)), "1");

  const segunda = await importLegacyLibrary(PROFILE_ID, primeira.items);

  assert.equal(segunda.synced, true);
  assert.deepEqual(segunda.items, primeira.items);
  // Nenhum pedido novo: a marca de migração já impede a segunda tentativa.
  assert.equal(pedidos.length, 1);
});

test("importLegacyLibrary tenta de novo depois de uma falha", async () => {
  globalThis.localStorage.setItem(LEGACY_KEY, JSON.stringify([legacyRaw()]));
  const { pedidos } = preparar([respostaErro(500)]);

  const primeira = await importLegacyLibrary(PROFILE_ID, []);

  assert.equal(primeira.synced, false);
  assert.equal(primeira.items.length, 1);
  assert.equal(primeira.items[0]!.mediaId, "tt0111161");
  assert.equal(globalThis.localStorage.getItem(libraryMigrationKey(PROFILE_ID)), null);
  assert.equal(pedidos.length, 1);

  globalThis.fetch = (async (url: string | URL | Request) => {
    pedidos.push(String(url));
    return new Response(JSON.stringify({ items: [accountItem()] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof globalThis.fetch;

  const segunda = await importLegacyLibrary(PROFILE_ID, []);

  assert.equal(segunda.synced, true);
  assert.equal(pedidos.length, 2);
  assert.equal(globalThis.localStorage.getItem(libraryMigrationKey(PROFILE_ID)), "1");
});

test("importLegacyLibrary sem itens legados marca migrado sem chamar a rede", async () => {
  const { pedidos } = preparar([respostaOk([])]);
  const contaAtual = [accountItem()];

  const resultado = await importLegacyLibrary(PROFILE_ID, contaAtual);

  assert.equal(resultado.synced, true);
  assert.deepEqual(resultado.items, contaAtual);
  assert.equal(pedidos.length, 0);
  assert.equal(globalThis.localStorage.getItem(libraryMigrationKey(PROFILE_ID)), "1");
});
