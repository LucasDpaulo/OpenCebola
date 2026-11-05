import assert from "node:assert/strict";
import test from "node:test";
import { activateDefaultSubtitle, preferredBrowserSubtitleId, watchBrowserSubtitleChanges } from "../app/player/browser-subtitle-activation.js";

test("liga a legenda que chega depois do vídeo iniciar", () => {
  const track = { id: "pt-br", kind: "subtitles", mode: "disabled" };
  const tracks = { selected: null, values: [track] };
  assert.equal(activateDefaultSubtitle(tracks, "pt-br"), true);
  assert.equal(track.mode, "showing");
});

test("menu recebe aviso quando uma legenda aparece depois das sondagens iniciais", () => {
  const tracks = new EventTarget();
  let updates = 0;
  const stop = watchBrowserSubtitleChanges(tracks, () => { updates += 1; });
  tracks.dispatchEvent(new Event("add"));
  tracks.dispatchEvent(new Event("remove"));
  assert.equal(updates, 2);
  stop();
  tracks.dispatchEvent(new Event("add"));
  assert.equal(updates, 2);
});

test("não sobrescreve uma legenda que o usuário já selecionou", () => {
  const chosen = { id: "en", kind: "subtitles", mode: "showing" };
  const automatic = { id: "pt-br", kind: "subtitles", mode: "disabled" };
  const tracks = { selected: chosen, values: [chosen, automatic] };
  assert.equal(activateDefaultSubtitle(tracks, "pt-br"), false);
  assert.equal(automatic.mode, "disabled");
});

test("respeita Legendas desligadas quando a pessoa troca de fonte", () => {
  const automatic = { id: "pt-br", kind: "subtitles", mode: "disabled" };
  const tracks = { selected: null, values: [automatic] };
  assert.equal(activateDefaultSubtitle(tracks, "pt-br", false), false);
  assert.equal(automatic.mode, "disabled");
});

test("reabrir o mesmo episódio restaura a legenda explicitamente escolhida", () => {
  assert.equal(preferredBrowserSubtitleId("auto-br", "chosen-en"), "chosen-en");
  assert.equal(preferredBrowserSubtitleId("auto-br", "off"), null);
  assert.equal(preferredBrowserSubtitleId("auto-br", null), "auto-br");
});
