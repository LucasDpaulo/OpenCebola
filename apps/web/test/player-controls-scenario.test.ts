import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAudioTrackSelection,
  applySubtitleTrackSelection,
  type AudioSelectionPlayer,
  type SubtitleSelectionPlayer
} from "../app/player/player-controls-scenario.js";
import { scenarioForStream } from "../app/player/playback-scenario.js";

const audioTracks = [
  { id: "en-1", label: "Inglês 5.1", language: "en" },
  { id: "pt-1", label: "Português 5.1", language: "pt" }
];

const subtitleTracks = [
  { id: "sub-pt", label: "Português (Brasil)", language: "pt-BR" },
  { id: "sub-en", label: "English", language: "en" }
];

test("trocar áudio só atualiza o cenário depois que o player confirma a troca", async () => {
  const player: AudioSelectionPlayer = {
    selectAudioTrack: async () => undefined,
    selectSubtitleTrack: async () => undefined
  };

  const result = await applyAudioTrackSelection(player, audioTracks[1], subtitleTracks, null);

  assert.equal(result.audioTrackId, "pt-1");
  assert.deepEqual(result.patch.audio, { id: "pt-1", language: "pt", name: "Português 5.1" });
});

test("falha ao trocar áudio não produz patch nem troca a legenda", async () => {
  let subtitleCalled = false;
  const player: AudioSelectionPlayer = {
    selectAudioTrack: async () => { throw new Error("falhou"); },
    selectSubtitleTrack: async () => { subtitleCalled = true; }
  };

  await assert.rejects(() => applyAudioTrackSelection(player, audioTracks[0], subtitleTracks, null));
  assert.equal(subtitleCalled, false);
});

test("trocar para áudio em inglês liga a legenda em português automaticamente e emite o patch dela também", async () => {
  const calls: (string | null)[] = [];
  const player: AudioSelectionPlayer = {
    selectAudioTrack: async () => undefined,
    selectSubtitleTrack: async (id) => { calls.push(id); }
  };

  const result = await applyAudioTrackSelection(player, audioTracks[0], subtitleTracks, null);

  assert.deepEqual(calls, ["sub-pt"]);
  assert.equal(result.subtitleTrackId, "sub-pt");
  assert.deepEqual(result.patch.subtitle, { id: "sub-pt", language: "pt-BR", name: "Português (Brasil)" });
});

test("trocar legenda só atualiza o cenário depois que o player confirma a troca", async () => {
  const player: SubtitleSelectionPlayer = { selectSubtitleTrack: async () => undefined };

  const result = await applySubtitleTrackSelection(player, subtitleTracks, "sub-en");

  assert.equal(result.subtitleTrackId, "sub-en");
  assert.deepEqual(result.patch, { subtitle: { id: "sub-en", language: "en", name: "English" } });
});

test("desligar a legenda persiste null explicitamente", async () => {
  const player: SubtitleSelectionPlayer = { selectSubtitleTrack: async () => undefined };

  const result = await applySubtitleTrackSelection(player, subtitleTracks, null);

  assert.equal(result.subtitleTrackId, null);
  assert.deepEqual(result.patch, { subtitle: null });
});

test("falha ao trocar legenda rejeita sem devolver patch", async () => {
  const player: SubtitleSelectionPlayer = {
    selectSubtitleTrack: async () => { throw new Error("falhou"); }
  };

  await assert.rejects(() => applySubtitleTrackSelection(player, subtitleTracks, "sub-en"));
});

test("troca manual de fonte registra a fonte pela identidade, nunca pela url", () => {
  const stream = {
    id: "stream-1",
    addonId: "com.stremio.torrentio.addon",
    addonName: "Torrentio",
    label: "Filme.2024.1080p.mkv",
    kind: "torrent" as const,
    infoHash: "a".repeat(40),
    fileIdx: 0
  };

  const source = scenarioForStream(stream);

  assert.equal(source.addonId, "com.stremio.torrentio.addon");
  assert.equal(source.infoHash, "a".repeat(40));
  assert.equal(source.fileIdx, 0);
  assert.equal("url" in source, false);
});
