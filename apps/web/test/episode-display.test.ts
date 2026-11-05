import assert from "node:assert/strict";
import test from "node:test";
import { displayEpisodeNumber, episodeDisplayLabel } from "../app/episode-display.js";

const catalog = [
  { season: 1, episode: 1 }, { season: 1, episode: 2 },
  { season: 2, episode: 1 }, { season: 2, episode: 2 }
];

test("mantém a temporada mas mostra a numeração corrida em animes", () => {
  assert.equal(displayEpisodeNumber("tt1234567", 2, 2, catalog, true), 4);
  assert.equal(episodeDisplayLabel(2, 4), "T2 · E4");
});

test("não inventa numeração corrida quando faltam temporadas anteriores", () => {
  assert.equal(displayEpisodeNumber("tt1234567", 4, 2, catalog, true), 2);
  assert.equal(displayEpisodeNumber("tt1234567", 2, 2, catalog, false), 2);
});

test("One Piece usa a numeração absoluta correta mesmo sem catálogo completo", () => {
  assert.equal(displayEpisodeNumber("tt0388629:21:153", 21, 153), 1044);
  assert.equal(displayEpisodeNumber("tt0388629", 21, 1), 892);
  assert.equal(displayEpisodeNumber("tt0388629", 22, 1), 1086);
  assert.equal(displayEpisodeNumber("tt0388629", 21, 1044), 1044);
  assert.equal(displayEpisodeNumber("tt0388629", 0, 1), 1);
});

test("One Piece 1082 e 1083 mantêm a identidade nos catálogos relativo e absoluto", () => {
  assert.equal(displayEpisodeNumber("tt0388629:21:191", 21, 191), 1082);
  assert.equal(displayEpisodeNumber("tt0388629:21:1082", 21, 1082), 1082);
  assert.equal(displayEpisodeNumber("tt0388629:21:192", 21, 192), 1083);
  assert.equal(displayEpisodeNumber("tt0388629:21:1083", 21, 1083), 1083);
});
