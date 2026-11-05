import assert from "node:assert/strict";
import test from "node:test";
import { ExternalSubtitleRenderer } from "../app/player/external-subtitle-renderer";
import { nativeTrackLabel } from "../app/player/subtitle-label";

const vtt = "WEBVTT\n\n00:00:02.000 --> 00:00:03.000\nOlá\n\n00:00:04.000 --> 00:00:05.000\nOutra fala";

test("ajustes imediatos, sem acumular atraso, inclusive pausado e ao buscar para trás", () => {
  let visible: readonly { text: string }[] = [];
  const renderer = new ExternalSubtitleRenderer((cues) => { visible = cues; });
  renderer.load(vtt);
  renderer.update(2.1);
  assert.equal(visible[0]?.text, "Olá");
  renderer.timing(0.5, 0);
  assert.equal(visible.length, 0);
  renderer.update(2.5);
  assert.equal(visible[0]?.text, "Olá");
  renderer.timing(0.5, 0);
  assert.equal(visible[0]?.text, "Olá");
  renderer.update(3.6);
  assert.equal(visible.length, 0);
  renderer.timing(0.5, 1);
  assert.equal(visible[0]?.text, "Olá");
  renderer.timing(-1, 0);
  assert.equal(visible[0]?.text, "Outra fala");
  renderer.update(1.1);
  assert.equal(visible[0]?.text, "Olá");
  renderer.clear();
  renderer.update(2);
  assert.equal(visible.length, 0);
});

test("trocar a legenda mantém os ajustes e limpa o texto anterior", () => {
  let visible: readonly { text: string }[] = [];
  const renderer = new ExternalSubtitleRenderer((cues) => { visible = cues; });
  renderer.timing(1, 0);
  renderer.update(3.1);
  renderer.load(vtt);
  assert.equal(visible[0]?.text, "Olá");
  renderer.load(vtt.replace("Olá", "Nova"));
  assert.equal(visible[0]?.text, "Nova");
  assert.throws(() => renderer.load("erro de servidor"), /vazia/);
});

test("rótulos genéricos mostram idioma real, sem adivinhar português quando ausente", () => {
  assert.match(nativeTrackLabel("Track 1", "por", 1), /^Português · Faixa 1$/);
  assert.match(nativeTrackLabel("Track 2", "pt-BR", 2), /^Português.*Brasil.*Faixa 2$/);
  assert.equal(nativeTrackLabel("Track 2", "und", 2), "Idioma não informado · Faixa 2");
  assert.equal(nativeTrackLabel("Track 1", "", 1), "Idioma não informado · Faixa 1");
  assert.match(nativeTrackLabel("English SDH", "eng", 3), /^Inglês · English SDH$/);
});
