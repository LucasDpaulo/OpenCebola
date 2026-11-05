import assert from "node:assert/strict";
import test from "node:test";
import { BrowserPlayer } from "../app/player/browser-player.js";
import type { MediaPlayerInstance } from "@vidstack/react";

test("listener dos controles é removido ao fechar o player web", () => {
  const player = new BrowserPlayer(() => null);
  let updates = 0;
  const unsubscribe = player.on("tracksChanged", () => { updates += 1; });
  player.notify("tracksChanged", undefined);
  unsubscribe();
  player.notify("tracksChanged", undefined);
  assert.equal(updates, 1);
});

test("estado do player web não derruba a tela quando a instância do Vidstack já foi destruída", () => {
  const destroyed = {
    get duration(): number { throw new TypeError("Cannot read properties of null (reading 'duration')"); }
  } as unknown as MediaPlayerInstance;
  const player = new BrowserPlayer(() => destroyed);
  assert.deepEqual(player.state(), {
    loaded: false, playing: false, positionSeconds: 0, durationSeconds: 0, audioTrackId: null, subtitleTrackId: null
  });
});
