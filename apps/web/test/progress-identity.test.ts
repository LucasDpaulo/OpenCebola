import assert from "node:assert/strict";
import test from "node:test";
import { findSavedProgress, progressForTitle, progressVideoId } from "../app/progress/identity.js";

function saved(mediaId: string, videoId: string, updatedAt?: string) {
  return { mediaId, videoId, updatedAt, positionSeconds: 100, durationSeconds: 6000, completed: false };
}

test("filme editorial grava com o videoId do catálogo (tt…), e não com o id tmdb:", () => {
  assert.equal(progressVideoId({ mediaType: "movie", mediaId: "tmdb:240", videoId: "tt0071562" }), "tt0071562");
});

test("sem videoId próprio, o vídeo é o próprio mediaId", () => {
  assert.equal(progressVideoId({ mediaType: "movie", mediaId: "tt0071562", videoId: "" }), "tt0071562");
  assert.equal(progressVideoId({ mediaType: "movie", mediaId: "tt0071562", videoId: "   " }), "tt0071562");
  assert.equal(progressVideoId({ mediaType: "movie", mediaId: "tt0071562", videoId: null }), "tt0071562");
  assert.equal(progressVideoId({ mediaType: "movie", mediaId: "tt0071562", videoId: undefined }), "tt0071562");
});

test("videoId vem aparado", () => {
  assert.equal(progressVideoId({ mediaType: "series", mediaId: "tt1", videoId: "  tt1:1:2 " }), "tt1:1:2");
});

const movie = { mediaType: "movie" as const, mediaId: "tmdb:240", videoId: "tt0071562" };

test("filme acha o registro do próprio videoId", () => {
  const items = [saved("tt0071562", "tt0071562")];
  assert.equal(findSavedProgress(items, movie), items[0]);
});

test("filme acha o registro antigo gravado como videoId: tmdb:240", () => {
  const items = [saved("tmdb:240", "tmdb:240")];
  assert.equal(findSavedProgress(items, movie), items[0]);
});

test("filme acha o registro do catálogo pelo mediaId, mesmo com outro videoId", () => {
  const items = [saved("tt0071562", "algum-outro-video")];
  assert.equal(findSavedProgress(items, { mediaType: "movie", mediaId: "tt0071562", videoId: "tt0071562x" }), items[0]);
});

test("filme gravado com o mediaId no lugar do videoId também casa", () => {
  const items = [saved("tt9", "tmdb:240")];
  assert.equal(findSavedProgress(items, movie), items[0]);
});

test("filme: entre vários caminhos do mesmo filme, vale o mais recente", () => {
  const antigo = saved("tmdb:240", "tmdb:240", "2026-09-01T10:00:00.000Z");
  const recente = saved("tt0071562", "tt0071562", "2026-09-20T10:00:00.000Z");
  const meio = saved("tmdb:240", "tt0071562", "2026-09-10T10:00:00.000Z");
  assert.equal(findSavedProgress([antigo, recente, meio], movie), recente);
  assert.equal(findSavedProgress([recente, meio, antigo], movie), recente);
});

test("registro sem data perde para um com data", () => {
  const semData = saved("tmdb:240", "tmdb:240");
  const comData = saved("tt0071562", "tt0071562", "2026-09-01T10:00:00.000Z");
  assert.equal(findSavedProgress([semData, comData], movie), comData);
  assert.equal(findSavedProgress([comData, semData], movie), comData);
});

test("filme não casa com outro filme", () => {
  assert.equal(findSavedProgress([saved("tt1", "tt1")], movie), null);
  assert.equal(findSavedProgress([], movie), null);
});

test("série casa só pelo videoId do episódio, nunca pelo mediaId", () => {
  const target = { mediaType: "series" as const, mediaId: "tt1", videoId: "tt1:1:2" };
  const outroEpisodio = saved("tt1", "tt1:1:3");
  const dessaSerieComoFilme = saved("tt1", "tt1");
  assert.equal(findSavedProgress([outroEpisodio, dessaSerieComoFilme], target), null);
  const esteEpisodio = saved("tt1", "tt1:1:2");
  assert.equal(findSavedProgress([outroEpisodio, esteEpisodio], target), esteEpisodio);
});

test("série: episódio gravado por outro mediaId ainda é o mesmo videoId", () => {
  const target = { mediaType: "series" as const, mediaId: "tt1", videoId: "tt1:1:2" };
  const porOutroCaminho = saved("tmdb:99", "tt1:1:2");
  assert.equal(findSavedProgress([porOutroCaminho], target), porOutroCaminho);
});

test("videoId vazio no alvo não casa com nada", () => {
  assert.equal(findSavedProgress([saved("tt1", "")], { mediaType: "series", mediaId: "tt1", videoId: "" }), null);
});

test("progresso do título junta a obra e os episódios vindos por outro caminho", () => {
  const daObra = saved("tt1", "tt1:1:1");
  const doEpisodioPorOutroCaminho = saved("tmdb:9", "tt1:1:2");
  const deOutraSerie = saved("tt2", "tt2:1:1");
  const result = progressForTitle([daObra, doEpisodioPorOutroCaminho, deOutraSerie], {
    mediaId: "tt1",
    videoIds: new Set(["tt1:1:1", "tt1:1:2"])
  });
  assert.deepEqual(result, [daObra, doEpisodioPorOutroCaminho]);
});

test("filme usa alias confirmado de metadados e não confunde outro tipo de mídia", () => {
  const saved = { mediaId: "tt1234567", videoId: "source-specific", mediaType: "movie" as const, updatedAt: "2026-10-15T10:00:00Z" };
  const target = { mediaId: "tmdb:42", videoId: "tmdb:42", mediaType: "movie" as const, alternateIds: ["tt1234567"] };
  assert.equal(findSavedProgress([saved], target), saved);
  assert.equal(findSavedProgress([{ ...saved, mediaType: "series" as const }], target), null);
  assert.equal(findSavedProgress([saved], { ...target, alternateIds: [] }), null);
});
