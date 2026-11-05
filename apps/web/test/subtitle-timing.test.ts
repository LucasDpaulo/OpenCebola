import assert from "node:assert/strict";
import test from "node:test";
import { timingFit, vttCueTimes } from "../app/player/subtitle-timing.js";

const SRT = `1
00:00:01,000 --> 00:00:04,500
Primeira fala.

2
00:01:02,250 --> 00:01:05,000
Segunda fala.
`;

const VTT = `WEBVTT

00:00:01.000 --> 00:00:04.500 align:middle line:90%
Primeira fala.

00:01:02.250 --> 00:01:05.000
Segunda fala.
`;

test("vttCueTimes lê timestamps do SRT (vírgula) e devolve start/end em segundos", () => {
  assert.deepEqual(vttCueTimes(SRT), [
    { start: 1, end: 4.5 },
    { start: 62.25, end: 65 }
  ]);
});

test("vttCueTimes lê o mesmo conteúdo em WebVTT (ponto, cabeçalho e configurações de cue)", () => {
  assert.deepEqual(vttCueTimes(VTT), [
    { start: 1, end: 4.5 },
    { start: 62.25, end: 65 }
  ]);
});

test("vttCueTimes ignora linhas malformadas sem travar", () => {
  const sujo = `1
não é um timestamp --> também não
2
00:00:01.000 --> isso aqui não fecha
3
00:00:02.000 --> 00:00:03.000
Fala válida.
`;
  assert.deepEqual(vttCueTimes(sujo), [{ start: 2, end: 3 }]);
});

test("vttCueTimes ignora cue com fim antes (ou igual) do início", () => {
  const invertida = `00:00:05.000 --> 00:00:02.000
Fim antes do início, ignorada.

00:00:02.000 --> 00:00:02.000
Duração zero, ignorada.
`;
  assert.deepEqual(vttCueTimes(invertida), []);
});

test("vttCueTimes aceita timestamp com hora de dois dígitos e filme de mais de 9h59", () => {
  const longo = `10:00:00,000 --> 10:00:02,000
Cue perto do fim de um filme (hipotético) de mais de dez horas.
`;
  assert.deepEqual(vttCueTimes(longo), [{ start: 36_000, end: 36_002 }]);
});

test("timingFit: sem cue nenhuma é sempre too-short", () => {
  assert.equal(timingFit([], 3600).verdict, "too-short");
  assert.equal(timingFit([], 3600).lastEnd, 0);
});

test("timingFit: última cue perto do fim do vídeo é ok", () => {
  const resultado = timingFit([{ start: 0, end: 10 }, { start: 3540, end: 3550 }], 3600);
  assert.equal(resultado.verdict, "ok");
  assert.equal(resultado.lastEnd, 3550);
});

test("timingFit: última cue bem depois do fim do vídeo, sem explicação por fps, é too-long", () => {
  // 4000/3600 ≈ 1.111 — longe demais de 25/23.976 (≈1.0427) para passar pela tolerância de 1.5%.
  const resultado = timingFit([{ start: 0, end: 4000 }], 3600);
  assert.equal(resultado.verdict, "too-long");
});

test("timingFit: última cue bem antes do fim do vídeo, sem explicação por fps, é too-short", () => {
  // 2000/3600 ≈ 0.556 — longe demais de 23.976/25 (≈0.959) para passar pela tolerância de 1.5%.
  const resultado = timingFit([{ start: 0, end: 2000 }], 3600);
  assert.equal(resultado.verdict, "too-short");
});

test("timingFit: desvio de fps na direção 'esticada' (PAL aplicado a filme) vira fps-drift", () => {
  // 3600 * (25/23.976) ≈ 3753.7 — mesmo desvio que um remux 25↔23.976 fps produz de verdade.
  const duracaoReal = 3600;
  const lastEnd = duracaoReal * (25 / 23.976);
  const resultado = timingFit([{ start: 0, end: lastEnd }], duracaoReal);
  assert.equal(resultado.verdict, "fps-drift");
  assert.equal(resultado.lastEnd, lastEnd);
});

test("timingFit: desvio de fps na direção 'encolhida' fica pequeno demais para cruzar o limiar de 80%, então continua ok", () => {
  // 23.976/25 ≈ 0.959 é MAIOR que o limiar de 0.80 que abre o ramo "too-short" — ou seja, esse
  // desvio de fps específico nunca é grande o bastante para nem chegar a ser avaliado como
  // possível fps-drift; a legenda continua dentro da faixa plausível e sai como "ok". Documenta o
  // limite matemático do par de fps usado (ver nota em subtitle-timing.ts).
  const duracaoReal = 3600;
  const lastEnd = duracaoReal * (23.976 / 25);
  const resultado = timingFit([{ start: 0, end: lastEnd }], duracaoReal);
  assert.equal(resultado.verdict, "ok");
});

test("timingFit: fronteira de +30s exatos ainda é ok, um segundo a mais já entra no ramo de too-long/fps-drift", () => {
  assert.equal(timingFit([{ start: 0, end: 3630 }], 3600).verdict, "ok");
  assert.equal(timingFit([{ start: 0, end: 3631 }], 3600).verdict, "too-long");
});

test("timingFit: score mede a distância de lastEnd até a duração, para desempate entre 'ok'", () => {
  const perto = timingFit([{ start: 0, end: 3595 }], 3600);
  const longe = timingFit([{ start: 0, end: 3500 }], 3600);
  assert.ok(perto.score < longe.score);
});

test("timingFit: duração desconhecida/zero não gera divisão por zero nem exceção", () => {
  const resultado = timingFit([{ start: 0, end: 10 }], 0);
  assert.equal(resultado.verdict, "too-short");
  assert.equal(Number.isFinite(resultado.score), false);
});
