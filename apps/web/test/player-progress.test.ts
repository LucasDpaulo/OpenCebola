import assert from "node:assert/strict";
import test from "node:test";
import { deveGravar, pontoDeRetomada } from "../app/player/player-progress.js";

test("retoma alguns segundos antes, porque ninguém lembra o que acabou de ver", () => {
  assert.equal(pontoDeRetomada({ positionSeconds: 600, durationSeconds: 3600, completed: false }), 590);
});

test("não retoma no comecinho: abrir do zero é o esperado", () => {
  assert.equal(pontoDeRetomada({ positionSeconds: 12, durationSeconds: 3600, completed: false }), 0);
});

test("episódio terminado recomeça do zero, e não do fim", () => {
  assert.equal(pontoDeRetomada({ positionSeconds: 3550, durationSeconds: 3600, completed: true }), 0);
});

test("quase no fim conta como terminado mesmo sem a marca", () => {
  assert.equal(pontoDeRetomada({ positionSeconds: 3595, durationSeconds: 3600, completed: false }), 0);
});

test("sem nada salvo, começa do zero", () => {
  assert.equal(pontoDeRetomada(null), 0);
});

test("grava a cada quinze segundos, e não a cada segundo", () => {
  assert.equal(deveGravar(0, 14), false);
  assert.equal(deveGravar(0, 15), true);
  assert.equal(deveGravar(600, 614), false);
  assert.equal(deveGravar(600, 615), true);
});

test("gravar depois de voltar no vídeo também vale", () => {
  assert.equal(deveGravar(600, 100), true);
});
