import assert from "node:assert/strict";
import test from "node:test";
import { decidirInicio, initialPlaybackPosition, inicioDaVinheta, type PedidoDeInicio } from "../app/player/regras/inicio.js";

const salvo = { positionSeconds: 1200, durationSeconds: 2400, completed: false };

function pedido(parcial: Partial<PedidoDeInicio> = {}): PedidoDeInicio {
  return { videoId: "tt1:1:1", posicaoDaTroca: null, doComeco: false, salvo: null, pularAbertura: false, ...parcial };
}

test("troca de fonte vence 'do começo' e o ponto salvo", () => {
  const r = decidirInicio(pedido({ posicaoDaTroca: 333, doComeco: true, salvo }));
  assert.deepEqual(r, { segundos: 333, motivo: "troca-de-fonte" });
});

test("posição de troca 0 ou NaN não conta como troca", () => {
  assert.equal(decidirInicio(pedido({ posicaoDaTroca: 0, salvo })).motivo, "retomada");
  assert.equal(decidirInicio(pedido({ posicaoDaTroca: Number.NaN, salvo })).motivo, "retomada");
});

test("'do começo' ignora o ponto salvo", () => {
  assert.deepEqual(decidirInicio(pedido({ doComeco: true, salvo })), { segundos: 0, motivo: "do-comeco" });
});

test("ponto salvo aplica o recuo de pontoDeRetomada", () => {
  assert.deepEqual(decidirInicio(pedido({ salvo })), { segundos: 1190, motivo: "retomada" });
});

test("salvo concluído, com menos de 30 s ou perto do fim começa do começo", () => {
  for (const s of [
    { ...salvo, completed: true },
    { positionSeconds: 20, durationSeconds: 2400, completed: false },
    { positionSeconds: 2390, durationSeconds: 2400, completed: false }
  ]) {
    assert.deepEqual(decidirInicio(pedido({ salvo: s })), { segundos: 0, motivo: "comeco" });
  }
});

test("vinheta do One Piece: com pularAbertura começa em 10, sem começa em 0", () => {
  for (const videoId of ["tt0388629:1:1", "tmdb:37854:1:1"]) {
    assert.equal(decidirInicio(pedido({ videoId, pularAbertura: true })).segundos, 10);
    assert.equal(decidirInicio(pedido({ videoId, pularAbertura: true, doComeco: true })).segundos, 10);
    assert.equal(decidirInicio(pedido({ videoId })).segundos, 0);
  }
});

test("vinheta inicial de One Piece: começa em 10s sem alterar retomada ou outros títulos", () => {
  assert.equal(initialPlaybackPosition("tt0388629:21:1082", 0, true), 10);
  assert.equal(initialPlaybackPosition("tmdb:37854:21:192", 0, true), 10);
  assert.equal(initialPlaybackPosition("tt0388629:21:1082", 500, true), 500);
  assert.equal(initialPlaybackPosition("tt0388629:21:1082", 0, false), 0);
  assert.equal(initialPlaybackPosition("tt1234567:1:1", 0, true), 0);
  assert.equal(inicioDaVinheta("tt0388629:21:1082", true), 10);
  assert.equal(inicioDaVinheta("tt0388629:21:1082", false), 0);
  assert.equal(inicioDaVinheta("tt1234567:1:1", true), 0);
});
