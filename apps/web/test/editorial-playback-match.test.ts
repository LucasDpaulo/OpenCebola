import assert from "node:assert/strict";
import test from "node:test";
import type { EditorialTitleResponse } from "@cebola/contracts";
import {
  editorialSearchQueries,
  matchEditorialCandidate,
  preferredPlaybackVideo,
  settledEditorialCandidates
} from "../app/titulo/editorial-playback-match.js";

const ruptura = {
  tmdbId: 95350,
  imdbId: "tt11280740",
  type: "series",
  title: "Ruptura",
  originalTitle: "Severance",
  year: 2022
} as EditorialTitleResponse;

test("busca pelo IMDb e pelos títulos localizado e original", () => {
  assert.deepEqual(editorialSearchQueries(ruptura), ["tt11280740", "Ruptura", "Severance"]);
});

test("IMDb identifica a série mesmo quando nome e ano do catálogo divergem", () => {
  const match = matchEditorialCandidate([{
    id: "tt11280740",
    type: "series",
    name: "Severance",
    addonId: "community.cinemeta",
    releaseInfo: "2022–"
  }], ruptura);

  assert.equal(match?.addonId, "community.cinemeta");
});

test("título original com ano continua sendo fallback quando não há IMDb", () => {
  const editorial = { ...ruptura, imdbId: null };
  const match = matchEditorialCandidate([{
    id: "catalog-id",
    type: "series",
    name: "Severance",
    addonId: "outro.catalogo",
    releaseInfo: "2022"
  }], editorial);

  assert.equal(match?.id, "catalog-id");
});

test("não aceita homônimo de outro ano sem IMDb", () => {
  const editorial = { ...ruptura, imdbId: null };
  assert.equal(matchEditorialCandidate([{
    id: "outro",
    type: "series",
    name: "Severance",
    addonId: "outro.catalogo",
    releaseInfo: "2010"
  }], editorial), null);
});

test("uma busca editorial que falha não apaga os candidatos das demais", () => {
  const candidates = settledEditorialCandidates([
    { status: "rejected", reason: new Error("addon lento") },
    { status: "fulfilled", value: { items: [{
      id: "tt11280740", type: "series", name: "Severance",
      addonId: "community.cinemeta", releaseInfo: "2022–"
    }] } }
  ]);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.id, "tt11280740");
});

test("série abre no episódio com progresso mais recente em vez do primeiro", () => {
  const videos = [
    { id: "ep-1", season: 1, episode: 1 },
    { id: "ep-2", season: 1, episode: 2 }
  ];
  const selected = preferredPlaybackVideo(videos, [
    { videoId: "ep-2", completed: false, positionSeconds: 900, updatedAt: "2026-09-20T20:00:00.000Z" }
  ]);

  assert.equal(selected?.id, "ep-2");
});

test("sem progresso a série começa no primeiro episódio regular, não no especial", () => {
  const videos = [
    { id: "special", season: 0, episode: 1 },
    { id: "pilot", season: 1, episode: 1 }
  ];

  assert.equal(preferredPlaybackVideo(videos, [])?.id, "pilot");
});

test("episódio terminado por último abre o seguinte, não um antigo pela metade", () => {
  const videos = [
    { id: "ep-1", season: 1, episode: 1 },
    { id: "ep-2", season: 1, episode: 2 },
    { id: "ep-3", season: 1, episode: 3 }
  ];
  const selected = preferredPlaybackVideo(videos, [
    { videoId: "ep-1", completed: false, positionSeconds: 900, updatedAt: "2026-10-11T20:00:00.000Z" },
    { videoId: "ep-2", completed: true, positionSeconds: 1300, updatedAt: "2026-10-12T20:00:00.000Z" }
  ]);

  assert.equal(selected?.id, "ep-3");
});

test("último episódio da série terminado mantém o último pela metade", () => {
  const videos = [
    { id: "ep-1", season: 1, episode: 1 },
    { id: "ep-2", season: 1, episode: 2 }
  ];
  const selected = preferredPlaybackVideo(videos, [
    { videoId: "ep-1", completed: false, positionSeconds: 900, updatedAt: "2026-10-11T20:00:00.000Z" },
    { videoId: "ep-2", completed: true, positionSeconds: 1300, updatedAt: "2026-10-12T20:00:00.000Z" }
  ]);

  assert.equal(selected?.id, "ep-1");
});

test("card de próximo episódio abre o seguinte ao pedido, inclusive na virada de temporada", () => {
  const videos = [
    { id: "s21e194", season: 21, episode: 194 },
    { id: "s22e1", season: 22, episode: 1 }
  ];

  assert.equal(preferredPlaybackVideo(videos, [], "s21e194", true)?.id, "s22e1");
  assert.equal(preferredPlaybackVideo(videos, [], "s22e1", true)?.id, "s22e1");
});
