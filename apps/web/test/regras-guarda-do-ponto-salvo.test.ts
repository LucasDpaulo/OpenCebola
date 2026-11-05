import assert from "node:assert/strict";
import test from "node:test";
import { criarGuardaDoPontoSalvo } from "../app/player/regras/guarda-do-ponto-salvo.js";
import { createProgressTracker, type ProgressReading } from "../app/progress/index.js";

function criar() {
  const gravacoes: { reading: ProgressReading; completed: boolean }[] = [];
  let relogio = 1_000_000;
  const tracker = createProgressTracker({
    save: (reading, completed) => { gravacoes.push({ reading, completed }); },
    now: () => relogio
  });
  return {
    tracker,
    guarda: criarGuardaDoPontoSalvo(tracker),
    gravacoes,
    posicoes: () => gravacoes.map((g) => g.reading.positionSeconds),
    avancar: (ms: number) => { relogio += ms; }
  };
}

test("bug: sem a guarda, depois de 30 s o tracker grava a leitura baixa do motor recomeçado", () => {
  const { tracker, posicoes, avancar } = criar();
  tracker.resumeFrom(1200);
  avancar(31_000);
  tracker.position(40, 2400);
  assert.deepEqual(posicoes(), [40]);
});

test("com a guarda, nada abaixo do ponto salvo - 5 é gravado, nem por flush", () => {
  const { guarda, gravacoes, avancar } = criar();
  guarda.resumeFrom(1200);
  guarda.recomecoForcado(1200);
  avancar(31_000);
  guarda.position(40, 2400);
  guarda.position(1000, 2400);
  guarda.flush({ positionSeconds: 100, durationSeconds: 2400 });
  assert.equal(gravacoes.length, 0);
});

test("passar do ponto volta a gravar normalmente", () => {
  const { guarda, posicoes, avancar } = criar();
  guarda.resumeFrom(1200);
  guarda.recomecoForcado(1200);
  avancar(31_000);
  guarda.position(40, 2400);
  guarda.position(1196, 2400);
  guarda.position(1197, 2400);
  guarda.position(1215, 2400);
  assert.deepEqual(posicoes(), [1196, 1215]);
});

test("flush abaixo do piso grava a última leitura boa que o tracker já tinha", () => {
  const { guarda, posicoes } = criar();
  guarda.position(500, 2400);
  guarda.recomecoForcado(1200);
  guarda.flush({ positionSeconds: 100, durationSeconds: 2400 });
  // A primeira leitura já gravou 500; o flush repete a mesma, nunca a baixa.
  assert.deepEqual(posicoes(), [500, 500]);
});

test("buscaDaPessoa libera a guarda: o ponto escolhido vale", () => {
  const { guarda, posicoes, avancar } = criar();
  guarda.resumeFrom(1200);
  guarda.recomecoForcado(1200);
  avancar(31_000);
  guarda.buscaDaPessoa();
  guarda.position(180, 2400);
  assert.deepEqual(posicoes(), [180]);
});

test("ended grava concluído mesmo com piso ativo", () => {
  const { guarda, gravacoes } = criar();
  guarda.recomecoForcado(1200);
  guarda.ended(2400);
  assert.equal(gravacoes.length, 1);
  assert.equal(gravacoes[0]?.completed, true);
});

test("sem recomecoForcado a guarda é transparente", () => {
  const a = criar();
  const b = criar();
  for (let s = 1; s <= 50; s += 1) {
    a.guarda.position(s, 2400);
    b.tracker.position(s, 2400);
  }
  a.guarda.position(5, 2400);
  b.tracker.position(5, 2400);
  a.guarda.flush({ positionSeconds: 9, durationSeconds: 2400 });
  b.tracker.flush({ positionSeconds: 9, durationSeconds: 2400 });
  assert.deepEqual(a.gravacoes, b.gravacoes);
});

test("recomecoForcado com valor inválido é ignorado", () => {
  const { guarda, posicoes } = criar();
  guarda.recomecoForcado(Number.NaN);
  guarda.recomecoForcado(0);
  guarda.position(40, 2400);
  guarda.flush();
  // 40 gravou no primeiro tick e o flush repete a mesma leitura: nada foi bloqueado.
  assert.deepEqual(posicoes(), [40, 40]);
});
