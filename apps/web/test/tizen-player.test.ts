import assert from "node:assert/strict";
import test from "node:test";
import { TizenPlayer } from "../app/player/tizen-player.js";

function bridge() {
  const calls: unknown[][] = [];
  return {
    calls,
    open: (url: string) => calls.push(["open", url]),
    close: () => calls.push(["close"]),
    prepareAsync: (success: () => void) => success(),
    play: () => calls.push(["play"]), pause: () => calls.push(["pause"]), stop: () => calls.push(["stop"]),
    seekTo: (milliseconds: number) => calls.push(["seekTo", milliseconds]),
    getDuration: () => 7_200_000, getState: () => "PLAYING",
    getTotalTrackInfo: () => [{ index: 2, type: "AUDIO" as const, extra_info: JSON.stringify({ language: "por" }) }],
    setSelectTrack: (type: "AUDIO" | "TEXT", index: number) => calls.push(["track", type, index]),
    setDisplayRect: (...args: number[]) => calls.push(["rect", ...args]),
    setListener: () => undefined
  };
}

test("TizenPlayer abre AVPlay em tela inteira, retoma e inicia reprodução", async () => {
  const fake = bridge();
  const player = new TizenPlayer(fake);
  await player.load({ url: "https://media.example/video.mkv", startAtSeconds: 42, subtitles: [] });
  assert.deepEqual(fake.calls.slice(0, 4), [
    ["open", "https://media.example/video.mkv"], ["rect", 0, 0, 1920, 1080],
    ["seekTo", 42_000], ["play"]
  ]);
  assert.equal(player.state().durationSeconds, 7_200);
});

test("TizenPlayer normaliza idioma vindo do JSON real do AVPlay", async () => {
  const player = new TizenPlayer(bridge());
  assert.deepEqual(await player.audioTracks(), [{ id: "2", label: "por", language: "por" }]);
});

test("Tizen remove observadores antigos antes da próxima abertura", async () => {
  const player = new TizenPlayer(bridge());
  let calls = 0;
  const off = player.on("ready", () => { calls++; });
  off(); off();
  await player.load({ url: "https://media.example/new.mkv", startAtSeconds: 0, subtitles: [] });
  assert.equal(calls, 0);
  player.on("ready", () => { calls++; });
  await player.load({ url: "https://media.example/third.mkv", startAtSeconds: 0, subtitles: [] });
  assert.equal(calls, 1);
  await player.destroy();
});
