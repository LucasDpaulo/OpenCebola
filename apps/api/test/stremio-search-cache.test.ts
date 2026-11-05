import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSearchQuery, SearchResultCache } from "../src/stremio/search-cache.js";

test("normalizeSearchQuery ignora caixa, espaços nas pontas e repetidos no meio", () => {
  assert.equal(normalizeSearchQuery("  Duna  "), "duna");
  assert.equal(normalizeSearchQuery("duna"), "duna");
  assert.equal(normalizeSearchQuery("Duna   Parte  Dois"), "duna parte dois");
  assert.notEqual(normalizeSearchQuery("duna"), normalizeSearchQuery("duna parte dois"));
});

test("SearchResultCache devolve a mesma entrada para consulta equivalente na mesma casa", () => {
  const cache = new SearchResultCache<string[]>();
  cache.set("casa-a", "Duna", ["item-1"]);
  assert.deepEqual(cache.get("casa-a", "  duna  "), ["item-1"]);
  assert.equal(cache.get("casa-a", "outra coisa"), undefined);
});

test("SearchResultCache não compartilha entre casas diferentes", () => {
  const cache = new SearchResultCache<string[]>();
  cache.set("casa-a", "duna", ["item-1"]);
  assert.equal(cache.get("casa-b", "duna"), undefined);
});

test("SearchResultCache expira depois do TTL configurado", () => {
  let now = 0;
  const cache = new SearchResultCache<string[]>({ ttlMs: 1_000, now: () => now });
  cache.set("casa-a", "duna", ["item-1"]);
  now = 999;
  assert.deepEqual(cache.get("casa-a", "duna"), ["item-1"]);
  now = 1_001;
  assert.equal(cache.get("casa-a", "duna"), undefined);
});

test("SearchResultCache despeja a entrada mais antiga ao estourar o teto", () => {
  const cache = new SearchResultCache<number>({ maxEntries: 2 });
  cache.set("casa-a", "um", 1);
  cache.set("casa-a", "dois", 2);
  cache.set("casa-a", "tres", 3);
  assert.equal(cache.get("casa-a", "um"), undefined);
  assert.equal(cache.get("casa-a", "dois"), 2);
  assert.equal(cache.get("casa-a", "tres"), 3);
  assert.equal(cache.size, 2);
});
