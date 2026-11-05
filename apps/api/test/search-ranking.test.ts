import assert from "node:assert/strict";
import test from "node:test";
import { rankSearchResults, titleMatchTier } from "../src/stremio/search-ranking.js";

function item(name: string, position: number, hits = 1) {
  return { name, position, hits };
}

test("série popular que começa com o termo vence filmes que só contêm a palavra", () => {
  const ranked = rankSearchResults([
    item("Silent Friend", 0), item("The Friend", 1), item("Friend", 12),
    item("Friend Request", 4), item("Friends", 0)
  ], "friend");
  assert.deepEqual(ranked.slice(0, 2).map((entry) => entry.name), ["Friends", "Friend Request"]);
  assert.ok(ranked.findIndex((entry) => entry.name === "Silent Friend") > ranked.findIndex((entry) => entry.name === "Friend"));
});

test("erro de digitação por palavra ainda casa: 'anne witch' encontra 'Anne with an E'", () => {
  assert.equal(titleMatchTier("Anne with an E", "anne witch"), 1);
  const ranked = rankSearchResults([
    item("Switching Channels", 0), item("Anne+", 1), item("Witch Hunt", 2), item("Anne with an E", 7)
  ], "anne witch");
  assert.equal(ranked[0]!.name, "Anne with an E");
});

test("acentos e pontuação não atrapalham o casamento", () => {
  assert.equal(titleMatchTier("Amélie", "amelie"), 3);
  assert.equal(titleMatchTier("Spider-Man: No Way Home", "spider man"), 3);
});

test("dentro do mesmo nível, posição somada às palavras a mais decide", () => {
  const ranked = rankSearchResults([item("Anne", 3), item("Anne of Green Gables", 1), item("Anne", 1)], "anne");
  assert.deepEqual(ranked.map((entry) => `${entry.name}@${entry.position}`),
    ["Anne@1", "Anne@3", "Anne of Green Gables@1"]);
});

test("'frien': Friends vence Friends with Benefits mesmo sendo o 2º das séries", () => {
  const ranked = rankSearchResults([item("Friends with Benefits", 0), item("Friends", 1)], "frien");
  assert.equal(ranked[0]!.name, "Friends");
});
