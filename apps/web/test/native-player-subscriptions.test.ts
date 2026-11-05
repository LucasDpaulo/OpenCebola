import assert from "node:assert/strict";
import test from "node:test";
import { TauriPlayer } from "../app/player/tauri-player";
import { CapacitorPlayer } from "../app/player/capacitor-player";

test("PC remove observadores de posição das sessões anteriores", async () => {
  const player = new TauriPlayer({} as HTMLVideoElement);
  let calls = 0;
  const off = player.on("position", () => { calls++; });
  await player.seek(10);
  assert.equal(calls, 1);
  off(); off();
  await player.seek(20);
  assert.equal(calls, 1);
  player.on("position", () => { calls++; });
  await player.seek(30);
  assert.equal(calls, 2);
});

test("Android remove observadores antigos ao preparar novas faixas", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    Capacitor: { isNativePlatform: () => true, Plugins: { Player: { load: async () => {}, stop: async () => {} } } },
    setInterval: () => 1, clearInterval: () => {}
  } });
  const player = new CapacitorPlayer();
  try {
    let calls = 0;
    const off = player.on("ready", () => { calls++; });
    off(); off();
    player.on("ready", () => { calls++; });
    await player.load({ url: "https://media.example/episode.mkv", startAtSeconds: 0, subtitles: [] });
    assert.equal(calls, 1);
  } finally {
    await player.destroy();
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
