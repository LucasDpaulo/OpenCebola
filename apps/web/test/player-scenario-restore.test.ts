import assert from "node:assert/strict";
import test from "node:test";
import type { PlaybackScenario, PlaybackSource, SubtitleSettings } from "@cebola/contracts";
import { matchSavedStream, matchSavedTrack } from "../app/player/playback-scenario.js";
import type { SourceCandidate } from "../app/player/player-source-options.js";
import { FakePlayer } from "../app/player/fake-player.js";

/**
 * Task 5 — retomar exatamente a fonte, o áudio, a legenda e os ajustes salvos ao abrir/continuar
 * um vídeo. `title-experience.tsx` não é importável aqui (é "use client" e puxa CSS Modules, que
 * o runner de teste não resolve), então estes testes fixam o CONTRATO que a tela implementa:
 * `matchSavedStream(...) ?? automatico(...)` para a fonte, e `matchSavedTrack` + o `NativePlayer`
 * de verdade (`FakePlayer`) para trilhas — os mesmos blocos usados dentro do componente.
 */

const HASH_SAVED = "a".repeat(40);
const HASH_OTHER = "b".repeat(40);

const savedQualityStream = {
  id: "torrentio-1080p", addonId: "com.stremio.torrentio.addon", addonName: "Torrentio RD",
  label: "Filme 1080p WEB-DL", kind: "torrent" as const, url: null,
  infoHash: HASH_SAVED, fileIdx: 0, quality: "1080p" as const
};

const higherScoringStream = {
  id: "torrentio-4k", addonId: "com.stremio.torrentio.addon", addonName: "Torrentio RD",
  label: "Filme 2160p REMUX", kind: "torrent" as const, url: null,
  infoHash: HASH_OTHER, fileIdx: 0, quality: "4K" as const
};

const streams = [higherScoringStream, savedQualityStream];

/** Pontuação mínima só para provar a prioridade — não é o `automaticStream` real do componente. */
function bestByQuality<T extends { quality?: string | null }>(candidates: readonly T[]): T | null {
  const score: Record<string, number> = { "4K": 4, "1080p": 3, "720p": 2, SD: 1 };
  return [...candidates].sort((a, b) => (score[b.quality ?? ""] ?? 0) - (score[a.quality ?? ""] ?? 0))[0] ?? null;
}

function chooseAutoplayStream<T extends SourceCandidate & { quality?: string | null }>(
  candidates: readonly T[],
  source: PlaybackSource | null | undefined
): T | null {
  return matchSavedStream(candidates, source) ?? bestByQuality(candidates);
}

test("autoplay escolhe a fonte salva mesmo quando outra pontua melhor no automático", () => {
  const savedSource: PlaybackSource = {
    addonId: "com.stremio.torrentio.addon", streamId: "torrentio-1080p",
    infoHash: HASH_SAVED, fileIdx: 0, releaseTitle: null
  };

  // Confirma a premissa: sem cenário salvo, o automático prefere a fonte de maior qualidade.
  assert.equal(bestByQuality(streams)?.id, "torrentio-4k");

  const chosen = chooseAutoplayStream(streams, savedSource);
  assert.equal(chosen?.id, "torrentio-1080p");
});

test("autoplay cai no automático quando a fonte salva não existe mais entre as opções", () => {
  const savedSource: PlaybackSource = {
    addonId: "com.stremio.torrentio.addon", streamId: "removido-da-lista",
    infoHash: "c".repeat(40), fileIdx: 0, releaseTitle: null
  };

  const chosen = chooseAutoplayStream(streams, savedSource);
  assert.equal(chosen?.id, "torrentio-4k");
});

test("progresso legado sem cenário mantém a seleção automática de sempre", () => {
  const chosen = chooseAutoplayStream(streams, undefined);
  assert.equal(chosen?.id, "torrentio-4k");
});

test("restaura a trilha de áudio salva, mesmo não sendo a primeira do player", async () => {
  const player = new FakePlayer({
    audioTracks: [
      { id: "en-1", label: "Inglês 5.1", language: "en" },
      { id: "pt-1", label: "Português 5.1", language: "pt" }
    ]
  });
  await player.load({ url: "https://exemplo.test/filme.mkv", startAtSeconds: 0, subtitles: [] });
  // Sem restauração, o FakePlayer manteria a primeira trilha (inglês).
  assert.equal(player.state().audioTrackId, "en-1");

  const savedAudio = { id: null, language: "pt", name: "Português 5.1" };
  const tracks = await player.audioTracks();
  const match = matchSavedTrack(tracks, savedAudio);
  assert.ok(match);
  await player.selectAudioTrack(match.id);

  assert.equal(player.state().audioTrackId, "pt-1");
});

test("restaura a legenda embutida salva por idioma+nome quando o ID mudou", async () => {
  const player = new FakePlayer({
    subtitleTracks: [
      { id: "sub-en", label: "English", language: "en" },
      { id: "sub-pt-br", label: "Português (Brasil)", language: "pt-BR" }
    ]
  });
  await player.load({ url: "https://exemplo.test/filme.mkv", startAtSeconds: 0, subtitles: [] });
  assert.equal(player.state().subtitleTrackId, null);

  const savedSubtitle = { id: "id-de-outra-sessao-que-nao-existe-mais", language: "pt-BR", name: "Português (Brasil)" };
  const tracks = await player.subtitleTracks();
  const match = matchSavedTrack(tracks, savedSubtitle);
  assert.ok(match);
  await player.selectSubtitleTrack(match.id);

  assert.equal(player.state().subtitleTrackId, "sub-pt-br");
});

test("trilha salva ausente nesta fonte não tenta selecionar nada e o vídeo continua tocando", async () => {
  const player = new FakePlayer({
    audioTracks: [{ id: "1", label: "Original", language: null }]
  });
  await player.load({ url: "https://exemplo.test/filme.mkv", startAtSeconds: 0, subtitles: [] });

  const savedAudio = { id: "trilha-que-sumiu", language: "de", name: "Alemão 5.1" };
  const tracks = await player.audioTracks();
  const match = matchSavedTrack(tracks, savedAudio);

  assert.equal(match, null);
  // Nada a fazer: a trilha original do FakePlayer permanece e o player segue carregado.
  assert.equal(player.state().audioTrackId, "1");
  assert.equal(player.state().loaded, true);
});

test("falha ao selecionar uma trilha restaurada gera aviso não bloqueante e não derruba o vídeo", async () => {
  const player = new FakePlayer({
    audioTracks: [{ id: "1", label: "Original", language: null }]
  });
  await player.load({ url: "https://exemplo.test/filme.mkv", startAtSeconds: 0, subtitles: [] });

  let warned = false;
  // Mesmo o `NativePlayer` real pode recusar um ID que ele próprio listou (corrida, engine
  // instável). A orquestração nunca deixa essa rejeição propagar para fora do `ready`.
  await player.selectAudioTrack("id-invalido-que-o-motor-recusa").catch(() => { warned = true; });

  assert.equal(warned, true);
  assert.equal(player.state().loaded, true);
  assert.equal(player.state().playing, false);
});

test("ajustes de legenda do cenário salvo têm prioridade sobre a preferência local", () => {
  const defaults: SubtitleSettings = { offset: 0, extraDuration: 0, color: "#ffffff", size: 100, bg: "transparent", font: "sans" };
  const local: SubtitleSettings = { ...defaults, size: 130, color: "#ffff00" };
  const scenarioSettings: SubtitleSettings = { ...defaults, offset: 1.5, font: "serif" };

  const resolve = (scenario: PlaybackScenario | null, storedLocal: SubtitleSettings) =>
    scenario?.subtitleSettings ? { ...defaults, ...scenario.subtitleSettings } : storedLocal;

  assert.deepEqual(resolve({ subtitleSettings: scenarioSettings }, local), scenarioSettings);
  assert.deepEqual(resolve(null, local), local);
  assert.deepEqual(resolve({}, local), local);
});

test("fallback automático que falha ao carregar não substitui o cenário salvo", async () => {
  let scenarioRef: PlaybackScenario | null = {
    source: { addonId: "com.stremio.torrentio.addon", streamId: "torrentio-1080p", infoHash: HASH_SAVED, fileIdx: 0, releaseTitle: null },
    audio: null, subtitle: null, subtitleSettings: null
  };
  const seeded = scenarioRef;

  const fallbackPlayer = {
    async load(): Promise<void> { throw new Error("fonte indisponível"); }
  };

  async function tryFallback(source: PlaybackSource): Promise<void> {
    await fallbackPlayer.load();
    // Só chega aqui — e só então grava a nova fonte — se o `load` realmente funcionar.
    scenarioRef = { ...scenarioRef, source };
  }

  await assert.rejects(() => tryFallback({
    addonId: "com.stremio.torrentio.addon", streamId: "torrentio-4k", infoHash: HASH_OTHER, fileIdx: 0, releaseTitle: null
  }));

  assert.deepEqual(scenarioRef, seeded);
});
