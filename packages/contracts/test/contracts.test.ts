import assert from "node:assert/strict";
import test from "node:test";
import {
  importLibraryRequestSchema,
  libraryItemSchema,
  libraryResponseSchema,
  playbackScenarioSchema,
  updateWatchProgressRequestSchema,
  upsertLibraryItemRequestSchema,
  watchProgressItemSchema
} from "../src/index.js";

const completeItem = {
  id: "0f8fad5b-d9cb-469f-a165-70867728950e",
  addonId: "cinemeta",
  mediaId: "tt0111161",
  mediaType: "movie" as const,
  name: "The Shawshank Redemption",
  posterUrl: "https://images.example/poster.jpg",
  backgroundUrl: "https://images.example/background.jpg",
  description: "A story of hope and friendship.",
  releaseInfo: "1994",
  createdAt: "2026-09-18T12:00:00.000Z",
  updatedAt: "2026-09-18T12:00:00.000Z"
};

const upsertItem = {
  addonId: completeItem.addonId,
  mediaId: completeItem.mediaId,
  mediaType: completeItem.mediaType,
  name: completeItem.name,
  posterUrl: completeItem.posterUrl,
  backgroundUrl: completeItem.backgroundUrl,
  description: completeItem.description,
  releaseInfo: completeItem.releaseInfo
};

test("aceita item completo com id do banco e mediaId do catálogo", () => {
  assert.deepEqual(libraryItemSchema.parse(completeItem), completeItem);
  assert.deepEqual(libraryResponseSchema.parse({ items: [completeItem] }), { items: [completeItem] });
});

test("aceita inclusão sem IDs internos de escopo", () => {
  assert.deepEqual(upsertLibraryItemRequestSchema.parse(upsertItem), upsertItem);
  assert.deepEqual(importLibraryRequestSchema.parse({ items: [upsertItem] }), { items: [upsertItem] });
});

test("recusa profileId e householdId enviados pelo cliente", () => {
  assert.equal(
    upsertLibraryItemRequestSchema.safeParse({ ...upsertItem, profileId: completeItem.id }).success,
    false
  );
  assert.equal(
    importLibraryRequestSchema.safeParse({
      items: [{ ...upsertItem, householdId: completeItem.id }]
    }).success,
    false
  );
});

test("recusa URLs HTTP para a arte da biblioteca", () => {
  assert.equal(
    upsertLibraryItemRequestSchema.safeParse({ ...upsertItem, posterUrl: "http://images.example/poster.jpg" }).success,
    false
  );
  assert.equal(
    libraryItemSchema.safeParse({ ...completeItem, backgroundUrl: "http://images.example/background.jpg" }).success,
    false
  );
});

const validScenario = {
  source: {
    addonId: "torrentio",
    streamId: "torrentio:abc123",
    infoHash: "a".repeat(40),
    fileIdx: 2,
    releaseTitle: "Example.Release.1080p"
  },
  audio: { id: "audio-1", language: "pt", name: "Português" },
  subtitle: { id: "sub-1", language: "en", name: "English" },
  subtitleSettings: {
    offset: 1.5,
    extraDuration: 2,
    color: "#ffffff",
    size: 125,
    bg: "translucent" as const,
    font: "sans" as const
  }
};

test("aceita cenário com fonte por hash/índice e trilhas por id+idioma+nome", () => {
  assert.deepEqual(playbackScenarioSchema.parse(validScenario), validScenario);
});

test("aceita cenário ausente ou com partes nulas, compatível com progresso legado", () => {
  assert.deepEqual(playbackScenarioSchema.parse({}), {});
  assert.deepEqual(
    playbackScenarioSchema.parse({ source: null, audio: null, subtitle: null, subtitleSettings: null }),
    { source: null, audio: null, subtitle: null, subtitleSettings: null }
  );
});

test("recusa URL na fonte do cenário de reprodução", () => {
  assert.equal(
    playbackScenarioSchema.safeParse({
      source: { ...validScenario.source, url: "https://example.com/stream.mp4" }
    }).success,
    false
  );
});

test("recusa campos desconhecidos no cenário de reprodução", () => {
  assert.equal(playbackScenarioSchema.safeParse({ ...validScenario, unexpected: true }).success, false);
  assert.equal(
    playbackScenarioSchema.safeParse({ audio: { ...validScenario.audio, unexpected: true } }).success,
    false
  );
});

test("recusa textos excessivos nas trilhas do cenário", () => {
  assert.equal(
    playbackScenarioSchema.safeParse({
      audio: { id: null, language: null, name: "a".repeat(301) }
    }).success,
    false
  );
});

test("recusa ajuste de legenda fora do intervalo -10..10", () => {
  assert.equal(
    playbackScenarioSchema.safeParse({
      subtitleSettings: { ...validScenario.subtitleSettings, offset: 10.1 }
    }).success,
    false
  );
  assert.equal(
    playbackScenarioSchema.safeParse({
      subtitleSettings: { ...validScenario.subtitleSettings, offset: -10.1 }
    }).success,
    false
  );
});

test("recusa tamanho e duração extra de legenda fora dos intervalos da UI", () => {
  assert.equal(
    playbackScenarioSchema.safeParse({
      subtitleSettings: { ...validScenario.subtitleSettings, size: 49 }
    }).success,
    false
  );
  assert.equal(
    playbackScenarioSchema.safeParse({
      subtitleSettings: { ...validScenario.subtitleSettings, size: 201 }
    }).success,
    false
  );
  assert.equal(
    playbackScenarioSchema.safeParse({
      subtitleSettings: { ...validScenario.subtitleSettings, extraDuration: 10.1 }
    }).success,
    false
  );
  assert.equal(
    playbackScenarioSchema.safeParse({
      subtitleSettings: { ...validScenario.subtitleSettings, extraDuration: -0.1 }
    }).success,
    false
  );
});

test("recusa cor de legenda que não seja hexadecimal", () => {
  assert.equal(
    playbackScenarioSchema.safeParse({
      subtitleSettings: { ...validScenario.subtitleSettings, color: "white" }
    }).success,
    false
  );
});

test("anexa cenário opcional/nulo ao progresso sem quebrar payload legado", () => {
  const legacyRequest = {
    addonId: "cinemeta",
    mediaId: "tt0111161",
    videoId: "tt0111161",
    mediaType: "movie" as const,
    title: "The Shawshank Redemption",
    positionSeconds: 10,
    durationSeconds: 100
  };
  assert.deepEqual(updateWatchProgressRequestSchema.parse(legacyRequest), legacyRequest);
  assert.deepEqual(
    updateWatchProgressRequestSchema.parse({ ...legacyRequest, playbackScenario: validScenario })
      .playbackScenario,
    validScenario
  );
  assert.deepEqual(
    updateWatchProgressRequestSchema.parse({ ...legacyRequest, playbackScenario: null }).playbackScenario,
    null
  );
});

test("recusa cenário forjado com URL no progresso enviado pelo cliente", () => {
  assert.equal(
    updateWatchProgressRequestSchema.safeParse({
      addonId: "cinemeta",
      mediaId: "tt0111161",
      videoId: "tt0111161",
      mediaType: "movie" as const,
      title: "The Shawshank Redemption",
      positionSeconds: 10,
      durationSeconds: 100,
      playbackScenario: { source: { ...validScenario.source, url: "https://example.com" } }
    }).success,
    false
  );
});

test("item de progresso aceita cenário nulo para registros antigos", () => {
  const item = {
    id: "0f8fad5b-d9cb-469f-a165-70867728950e",
    addonId: "cinemeta",
    playbackAddonId: null,
    mediaId: "tt0111161",
    videoId: "tt0111161",
    mediaType: "movie" as const,
    title: "The Shawshank Redemption",
    episodeTitle: null,
    season: null,
    episode: null,
    posterUrl: null,
    positionSeconds: 10,
    durationSeconds: 100,
    completed: false,
    updatedAt: "2026-09-18T12:00:00.000Z",
    playbackScenario: null
  };
  assert.deepEqual(watchProgressItemSchema.parse(item), item);
});

test("recusa importação com mais de 200 itens", () => {
  assert.equal(
    importLibraryRequestSchema.safeParse({ items: Array.from({ length: 201 }, () => upsertItem) }).success,
    false
  );
});

test("recusa campos desconhecidos nos contratos públicos", () => {
  assert.equal(
    upsertLibraryItemRequestSchema.safeParse({ ...upsertItem, unexpected: true }).success,
    false
  );
  assert.equal(
    libraryItemSchema.safeParse({ ...completeItem, unexpected: true }).success,
    false
  );
});
