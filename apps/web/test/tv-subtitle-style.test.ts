import assert from "node:assert/strict";
import test from "node:test";
import { resolveTvSubtitleStyle, tvSubtitleFontSize } from "../app/player/tv-subtitle-style.js";

test("sem escolha, a TV usa o padrão Netflix (Inter 700, sombra projetada, sem traço)", () => {
  const style = resolveTvSubtitleStyle();
  assert.match(style.fontFamily, /^"Cebola Legenda Inter"/);
  assert.equal(style.fontWeight, 700);
  assert.equal(style.textStroke, "0 transparent");
  assert.match(style.textShadow, /^0\.04em 0\.07em/);
  assert.deepEqual(resolveTvSubtitleStyle("lixo", "lixo"), style);
});

test("fontes alternativas", () => {
  assert.match(resolveTvSubtitleStyle("arial").fontFamily, /^"Cebola Legenda Arimo", Arial/);
  assert.match(resolveTvSubtitleStyle("roboto").fontFamily, /Cebola Legenda Roboto"/);
  assert.match(resolveTvSubtitleStyle("serif").fontFamily, /Noto Serif/);
  assert.match(resolveTvSubtitleStyle("mono").fontFamily, /Roboto Mono/);
  const casual = resolveTvSubtitleStyle("casual");
  assert.match(casual.fontFamily, /Comic Neue/);
  assert.equal(casual.fontWeight, 700);
});

test("contornos", () => {
  assert.equal(resolveTvSubtitleStyle(undefined, "outline").textStroke, "0.06em #000");
  assert.equal(resolveTvSubtitleStyle(undefined, "shadow").textShadow, "0.06em 0.06em 0.18em rgba(0,0,0,0.95)");
  assert.equal(resolveTvSubtitleStyle(undefined, "shadow").textStroke, "0 transparent");
  assert.equal(resolveTvSubtitleStyle(undefined, "none").textShadow, "none");
});

test("tamanho escala a base de 4.6vh", () => {
  assert.equal(tvSubtitleFontSize(100), "4.600vh");
  assert.equal(tvSubtitleFontSize(150), "6.900vh");
});
