import assert from "node:assert/strict";
import test from "node:test";
import {
  clampSearchQuery,
  isSearchableQuery,
  normalizeSearchQuery,
  parseSearchQueryParam,
  searchPageHref,
  SearchResultsCache
} from "../app/search-query.js";

test("normalizeSearchQuery ignora caixa, espaços nas pontas e repetidos no meio", () => {
  assert.equal(normalizeSearchQuery("  Duna  "), "duna");
  assert.equal(normalizeSearchQuery("Duna   Parte  Dois"), "duna parte dois");
  assert.equal(normalizeSearchQuery("duna"), normalizeSearchQuery("  DUNA  "));
});

test("clampSearchQuery apara espaços e corta em 100 caracteres", () => {
  assert.equal(clampSearchQuery("  Duna  "), "Duna");
  assert.equal(clampSearchQuery("a".repeat(150)).length, 100);
});

test("isSearchableQuery exige ao menos 2 caracteres úteis", () => {
  assert.equal(isSearchableQuery(""), false);
  assert.equal(isSearchableQuery(" a "), false);
  assert.equal(isSearchableQuery("ab"), true);
  assert.equal(isSearchableQuery("  ab  "), true);
});

test("parseSearchQueryParam lê ?q= e cai para ?search= por compatibilidade", () => {
  assert.equal(parseSearchQueryParam(new URLSearchParams("q=duna")), "duna");
  assert.equal(parseSearchQueryParam(new URLSearchParams("search=duna")), "duna");
  assert.equal(parseSearchQueryParam(new URLSearchParams("q=duna&search=outra")), "duna");
  assert.equal(parseSearchQueryParam(new URLSearchParams("")), "");
});

test("searchPageHref preserva a consulta e cai para a tela vazia sem consulta", () => {
  assert.match(searchPageHref("duna"), /^\/busca(\/index\.html)?\?q=duna$/);
  assert.match(searchPageHref(), /^\/busca(\/index\.html)?$/);
  assert.match(searchPageHref("  "), /^\/busca(\/index\.html)?$/);
});

test("SearchResultsCache guarda e recupera por consulta normalizada", () => {
  const cache = new SearchResultsCache<string[]>();
  assert.equal(cache.has("duna"), false);
  cache.set("Duna", ["tt1"]);
  assert.equal(cache.has("  duna  "), true);
  assert.deepEqual(cache.get("DUNA"), ["tt1"]);
  assert.equal(cache.get("outra coisa"), undefined);
});
