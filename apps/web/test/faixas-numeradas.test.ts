import assert from "node:assert/strict";
import test from "node:test";
import { TauriPlayer } from "../app/player/tauri-player.js";

// MKV real (VisionQuest): 0 = vídeo, 1 = único áudio, 2… = legendas sem título. O número exibido é
// a posição entre as faixas do mesmo tipo; antes era o índice no arquivo e o áudio virava "Faixa 2".
test("TauriPlayer: faixas sem nome são numeradas dentro do próprio tipo", async () => {
  const tracks = [
    { id: "a", kind: "audio", selected: true, streamIndex: 1, label: "Track 2", language: "eng" },
    { id: "s1", kind: "subtitle", selected: false, streamIndex: 2, label: "Track 3", language: "" },
    { id: "s2", kind: "subtitle", selected: false, streamIndex: 3, label: "Track 4", language: "" }
  ];
  const controlador = {
    tracks,
    media: { durationSeconds: 1500, tracks },
    sessionId: "falso",
    on: () => () => undefined,
    async selectTrack() {},
    async play() {},
    pause() {},
    async seek() {},
    async setVolume() {},
    async destroy() {}
  };
  const original = { window: globalThis.window, document: globalThis.document };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => ({}) } });
  try {
    const elemento = { muted: false, volume: 1 } as unknown as HTMLVideoElement;
    const player = new TauriPlayer(elemento, { attach: async () => controlador } as never, async () => "");
    await player.load({ url: "https://media.example/ep.mkv", startAtSeconds: 0, subtitles: [], defaultSubtitleId: null });
    assert.deepEqual((await player.audioTracks()).map((faixa) => faixa.label), ["Inglês · Faixa 1"]);
    assert.deepEqual((await player.subtitleTracks()).map((faixa) => faixa.label),
      ["Idioma não informado · Faixa 1", "Idioma não informado · Faixa 2"]);
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: original.window });
    Object.defineProperty(globalThis, "document", { configurable: true, value: original.document });
  }
});
