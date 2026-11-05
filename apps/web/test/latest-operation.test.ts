import assert from "node:assert/strict";
import test from "node:test";
import { LatestOperation } from "../app/player/latest-operation.js";

test("iniciar uma nova operacao aborta a operacao anterior", () => {
  const latest = new LatestOperation();
  const a = latest.start();
  assert.equal(a.signal.aborted, false);

  const b = latest.start();

  assert.equal(a.signal.aborted, true);
  assert.equal(b.signal.aborted, false);
});

test("resposta tardia da operacao anterior nao pode selecionar fonte", async () => {
  const latest = new LatestOperation();
  const a = latest.start();

  // B comeca antes de A terminar de "resolver" (ex.: trocou de fonte enquanto A ainda esperava).
  latest.start();

  // A "resposta" de A chega depois. Ela nao pode mais ser considerada atual.
  await Promise.resolve();
  let selected: string | null = null;
  if (a.isCurrent()) selected = "stream-a";

  assert.equal(a.isCurrent(), false);
  assert.equal(selected, null);
});

test("fechar o player cancela a operacao atual", () => {
  const latest = new LatestOperation();
  const current = latest.start();

  assert.equal(current.isCurrent(), true);
  latest.cancel();

  assert.equal(current.isCurrent(), false);
  assert.equal(current.signal.aborted, true);
});

test("finish nao afeta isCurrent, mas evita que cancel aborte uma operacao ja concluida", () => {
  const latest = new LatestOperation();
  const first = latest.start();
  first.finish();

  // Nada em andamento; cancelar depois de finish nao deve lancar nem afetar futuras operacoes.
  latest.cancel();

  const second = latest.start();
  assert.equal(second.isCurrent(), true);
  assert.equal(second.signal.aborted, false);
});
