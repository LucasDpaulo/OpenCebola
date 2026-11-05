import assert from "node:assert/strict";
import test from "node:test";
import { orderedEpisodes, adjacentEpisode } from "../app/titulo/episode-order.js";

const videos = [
  { id: "later", season: 21, episode: 159, released: "2024-02-01T00:00:00.000Z" },
  { id: "special", season: 0, episode: 1, released: null },
  { id: "earlier", season: 21, episode: 153, released: "2024-01-01T00:00:00.000Z" },
  { id: "middle", season: 21, episode: 154, released: "2024-01-08T00:00:00.000Z" }
];

test("episódios são ordenados pela temporada e número, mesmo se o catálogo vier fora de ordem", () => {
  assert.deepEqual(orderedEpisodes(videos).map((video) => video.id), ["special", "earlier", "middle", "later"]);
});

test("próximo episódio segue a ordem numérica e não entra nos especiais", () => {
  assert.equal(adjacentEpisode(videos, "earlier", 1)?.id, "middle");
  assert.equal(adjacentEpisode(videos, "earlier", -1), null);
});

test("não pula do episódio 154 para o 159 quando o catálogo tem lacuna", () => {
  assert.equal(adjacentEpisode(videos, "middle", 1), null);
  assert.equal(adjacentEpisode(videos, "later", -1), null);
});

test("catálogo com ID repetido não oferece o próprio episódio como próximo", () => {
  assert.equal(adjacentEpisode([
    { id: "same", season: 1, episode: 1 },
    { id: "same", season: 1, episode: 2 }
  ], "same", 1), null);
});
