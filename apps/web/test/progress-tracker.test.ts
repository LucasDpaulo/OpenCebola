import assert from "node:assert/strict";
import test from "node:test";
import { createProgressTracker, type ProgressReading } from "../app/progress/tracker.js";

interface Gravacao {
  readonly reading: ProgressReading;
  readonly completed: boolean;
}

function criar(intervalSeconds?: number) {
  const gravacoes: Gravacao[] = [];
  let relogio = 1_000_000;
  const tracker = createProgressTracker({
    save: (reading, completed) => { gravacoes.push({ reading, completed }); },
    intervalSeconds,
    now: () => relogio
  });
  return {
    tracker,
    gravacoes,
    posicoes: () => gravacoes.map((g) => g.reading.positionSeconds),
    avancar: (ms: number) => { relogio += ms; }
  };
}

test("posições de 1 a 100 gravam a cada 15 segundos, e não a cada tick", () => {
  const { tracker, posicoes, gravacoes } = criar();
  for (let segundo = 1; segundo <= 100; segundo += 1) tracker.position(segundo, 7200);
  assert.deepEqual(posicoes(), [15, 30, 45, 60, 75, 90]);
  assert.ok(gravacoes.every((g) => !g.completed && g.reading.durationSeconds === 7200));
});

test("o intervalo é configurável", () => {
  const { tracker, posicoes } = criar(10);
  for (let segundo = 1; segundo <= 35; segundo += 1) tracker.position(segundo, 7200);
  assert.deepEqual(posicoes(), [10, 20, 30]);
});

test("voltar no vídeo grava na hora, e a contagem segue dali", () => {
  const { tracker, posicoes } = criar();
  for (let segundo = 1; segundo <= 40; segundo += 1) tracker.position(segundo, 7200);
  assert.deepEqual(posicoes(), [15, 30]);
  tracker.position(5, 7200);
  assert.deepEqual(posicoes(), [15, 30, 5]);
  for (let segundo = 6; segundo <= 19; segundo += 1) tracker.position(segundo, 7200);
  assert.deepEqual(posicoes(), [15, 30, 5]);
  tracker.position(20, 7200);
  assert.deepEqual(posicoes(), [15, 30, 5, 20]);
});

test("retomada em 600: nos primeiros 30 s as leituras baixas do seek inicial não valem", () => {
  const { tracker, gravacoes, avancar } = criar();
  tracker.resumeFrom(600);
  tracker.position(2, 7200);
  tracker.position(100, 7200);
  tracker.position(594, 7200);
  assert.equal(gravacoes.length, 0);
  assert.equal(tracker.lastReading(), null);

  // Aterrissou perto do ponto pedido: passa a valer e grava.
  tracker.position(595, 7200);
  assert.deepEqual(gravacoes.map((g) => g.reading.positionSeconds), [595]);
  assert.deepEqual(tracker.lastReading(), { positionSeconds: 595, durationSeconds: 7200 });
});

test("retomada em 600: passados os 30 s, voltar a um ponto baixo é uma escolha da pessoa e grava", () => {
  const { tracker, posicoes, avancar } = criar();
  tracker.resumeFrom(600);
  tracker.position(595, 7200);
  avancar(29_999);
  tracker.position(100, 7200);
  assert.deepEqual(posicoes(), [595]);
  avancar(1);
  tracker.position(100, 7200);
  assert.deepEqual(posicoes(), [595, 100]);
});

test("resumeFrom(0) não protege nada", () => {
  const { tracker, posicoes } = criar();
  tracker.resumeFrom(0);
  tracker.position(20, 7200);
  assert.deepEqual(posicoes(), [20]);
});

test("flush grava a última leitura válida, mesmo no mesmo ponto já gravado", () => {
  const { tracker, gravacoes } = criar();
  tracker.position(10, 7200);
  assert.equal(gravacoes.length, 0);
  tracker.flush();
  assert.deepEqual(gravacoes.map((g) => [g.reading.positionSeconds, g.completed]), [[10, false]]);
  // Troca de cenário no mesmo segundo: grava de novo, para o cenário novo ir junto.
  tracker.flush();
  assert.equal(gravacoes.length, 2);
});

test("flush com leitura grava a leitura dada e a guarda", () => {
  const { tracker, gravacoes } = criar();
  tracker.position(10, 7200);
  tracker.flush({ positionSeconds: 12.5, durationSeconds: 7200 });
  assert.deepEqual(gravacoes[0]?.reading, { positionSeconds: 12.5, durationSeconds: 7200 });
  assert.deepEqual(tracker.lastReading(), { positionSeconds: 12.5, durationSeconds: 7200 });
});

test("flush sem nenhuma leitura válida não grava", () => {
  const { tracker, gravacoes } = criar();
  tracker.flush();
  tracker.flush({ positionSeconds: 0, durationSeconds: 7200 });
  tracker.flush({ positionSeconds: Number.NaN, durationSeconds: 7200 });
  assert.equal(gravacoes.length, 0);
});

test("flush com leitura inválida (player em desmontagem reportando zero) grava a última boa", () => {
  const { tracker, gravacoes } = criar();
  tracker.position(300, 7200);
  tracker.flush({ positionSeconds: 0, durationSeconds: 7200 });
  assert.deepEqual(gravacoes.map((g) => g.reading.positionSeconds), [300, 300]);
});

test("flush também respeita a proteção da retomada: o seek inicial não vira posição salva", () => {
  const { tracker, gravacoes } = criar();
  tracker.resumeFrom(600);
  tracker.flush({ positionSeconds: 3, durationSeconds: 7200 });
  assert.equal(gravacoes.length, 0);
  tracker.position(596, 7200);
  tracker.flush({ positionSeconds: 3, durationSeconds: 7200 });
  assert.deepEqual(gravacoes.map((g) => g.reading.positionSeconds), [596, 596]);
});

test("ended grava concluído, com a posição igual à duração", () => {
  const { tracker, gravacoes } = criar();
  tracker.position(7000, 7200);
  tracker.ended(7200);
  const ultima = gravacoes.at(-1);
  assert.deepEqual(ultima, { reading: { positionSeconds: 7200, durationSeconds: 7200 }, completed: true });
});

test("ended sem duração válida usa a da última leitura; sem leitura, não grava", () => {
  const sem = criar();
  sem.tracker.ended(Number.NaN);
  assert.equal(sem.gravacoes.length, 0);

  const com = criar();
  com.tracker.position(7000, 7200);
  com.tracker.ended(Number.NaN);
  assert.deepEqual(com.gravacoes.at(-1), { reading: { positionSeconds: 7200, durationSeconds: 7200 }, completed: true });
});

test("depois do fim, fechar o player não desfaz o concluído", () => {
  const { tracker, gravacoes } = criar();
  tracker.position(7000, 7200);
  tracker.ended(7200);
  tracker.position(7199, 7200); // leitura final do motor
  tracker.position(0, 7200); // motor volta ao zero: leitura inválida
  tracker.position(1.3, 7200); // e emite os primeiros ticks: também não é rever
  tracker.flush({ positionSeconds: 3, durationSeconds: 7200 }); // fechar com o player já reiniciado
  assert.ok(gravacoes.length >= 2);
  assert.ok(gravacoes.slice(1).every((g) => g.completed && g.reading.positionSeconds === 7200));
});

test("depois do fim, rever o episódio reabre a gravação normal", () => {
  const { tracker, gravacoes } = criar();
  tracker.ended(7200);
  tracker.position(60, 7200);
  assert.deepEqual(gravacoes.at(-1), { reading: { positionSeconds: 60, durationSeconds: 7200 }, completed: false });
});

test("leituras inválidas nunca são guardadas nem gravadas", () => {
  const { tracker, gravacoes } = criar();
  const invalidas: Array<[number, number]> = [
    [Number.NaN, 7200], [30, Number.NaN], [0, 7200], [-5, 7200], [30, 0], [30, 0.5],
    [Number.POSITIVE_INFINITY, 7200], [30, Number.POSITIVE_INFINITY]
  ];
  for (const [posicao, duracao] of invalidas) tracker.position(posicao, duracao);
  tracker.flush();
  assert.equal(gravacoes.length, 0);
  assert.equal(tracker.lastReading(), null);

  tracker.position(40, 7200);
  tracker.position(Number.NaN, 7200);
  tracker.position(0, 7200);
  assert.deepEqual(tracker.lastReading(), { positionSeconds: 40, durationSeconds: 7200 });
});

test("lastReading devolve uma cópia", () => {
  const { tracker } = criar();
  tracker.position(40, 7200);
  const leitura = tracker.lastReading() as { positionSeconds: number };
  (leitura as { positionSeconds: number }).positionSeconds = 1;
  assert.equal(tracker.lastReading()?.positionSeconds, 40);
});
