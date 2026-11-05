import assert from "node:assert/strict";
import test from "node:test";
import { subtitleMarkers, textCues, withSubtitleMarkers } from "../app/player/pulos/subtitle-markers.js";
import type { SkipSegment } from "../app/player/pulos/skip-segments.js";

// Trechos da legenda pt-BR (Netflix) do One Piece 1093, como o OpenSubtitles entrega.
const EP_1093 = [
  "1", "00:01:45,814 --> 00:01:47,315", "Lá vêm eles.", "",
  "2", "00:01:59,702 --> 00:02:04,457", "<i>\"O Vencedor Leva Tudo!</i>", "<i>Law contra Barba Negra!\"</i>", "",
  "3", "00:02:06,960 --> 00:02:09,212", "ALGUM LUGAR NO MAR, NOVO MUNDO", "",
  "4", "00:06:55,998 --> 00:06:58,000", "Por isso as recompensas continuam subindo.", "",
  "5", "00:20:10,667 --> 00:20:12,627", "CONTINUA…", "",
  "6", "00:21:47,264 --> 00:21:51,435", "<i>\"Conte aí, Robin!</i>", "<i>Momento do Chopper Curioso!\"</i>", ""
].join("\r\n");

// One Piece 1092: o título só aparece depois do resumo, bem depois do fim da música.
const EP_1092 = [
  "00:03:32.337 --> 00:03:37.000", "<i>\"O Lamento de Bonney!</i>", "<i>Trevas à Espreita na Ilha do Futuro.\"</i>", "",
  "00:04:56.379 --> 00:04:59.000", "Os \"gatos\" dele também", "são bem problemáticos.", "",
  "00:20:10.626 --> 00:20:12.000", "CONTINUA…", ""
].join("\n");

const ANISKIP_OP: SkipSegment = { kind: "intro", start: 10, end: 131, episodeLength: 1430 };

test("lê as falas com início e texto sem marcação", () => {
  const cues = textCues(EP_1093);
  assert.equal(cues.length, 6);
  assert.deepEqual(cues[1], { start: 119.702, text: "\"O Vencedor Leva Tudo! Law contra Barba Negra!\"" });
});

test("acha o título entre aspas no começo e o Continua na segunda metade", () => {
  assert.deepEqual(subtitleMarkers(EP_1093, 1431), { episodeStart: 118.702, storyEnd: 1210.667 });
  assert.deepEqual(subtitleMarkers(EP_1092, 1431), { episodeStart: 211.337, storyEnd: 1210.626 });
});

test("quadro entre aspas depois do começo e fala com 'continua' não viram marcas", () => {
  const markers = subtitleMarkers([
    "00:06:55.998 --> 00:06:58.000", "Por isso as recompensas continuam subindo.", "",
    "00:21:47.264 --> 00:21:51.000", "\"Conte aí, Robin!\"", ""
  ].join("\n"), 1431);
  assert.deepEqual(markers, { episodeStart: null, storyEnd: null });
});

test("abertura do AniSkip passa a terminar no título, antes ou depois do tempo copiado", () => {
  const cedo = withSubtitleMarkers([ANISKIP_OP], subtitleMarkers(EP_1093, 1431), 1431);
  assert.deepEqual(cedo[0], { kind: "intro", start: 10, end: 118.702, episodeLength: null });
  const comResumo = withSubtitleMarkers([ANISKIP_OP], subtitleMarkers(EP_1092, 1431), 1431);
  assert.deepEqual(comResumo[0], { kind: "intro", start: 10, end: 211.337, episodeLength: null });
});

test("Continua vira o começo do encerramento, no lugar do do AniSkip", () => {
  const segments = withSubtitleMarkers([
    ANISKIP_OP,
    { kind: "outro", start: 1215, end: 1306, episodeLength: 1430 }
  ], subtitleMarkers(EP_1092, 1431), 1431);
  assert.deepEqual(segments.at(-1), { kind: "outro", start: 1210.626, end: 1431, episodeLength: null });
  assert.equal(segments.filter((segment) => segment.kind === "outro").length, 1);
});

test("sem abertura da API o título sozinho não cria trecho de pulo", () => {
  const segments = withSubtitleMarkers([], subtitleMarkers(EP_1093, 1431), 1431);
  assert.deepEqual(segments, [{ kind: "outro", start: 1210.667, end: 1431, episodeLength: null }]);
});

test("sem marcas os trechos ficam como vieram", () => {
  assert.deepEqual(withSubtitleMarkers([ANISKIP_OP], null, 1431), [ANISKIP_OP]);
});
