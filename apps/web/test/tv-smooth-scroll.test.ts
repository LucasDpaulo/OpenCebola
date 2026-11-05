import assert from "node:assert/strict";
import test from "node:test";
import { approach } from "../app/tv/tv-smooth-scroll.js";

function run(from: number, to: number, frameMs: number, totalMs: number): number {
  let position = from;
  for (let elapsed = 0; elapsed < totalMs; elapsed += frameMs) position = approach(position, to, frameMs);
  return position;
}

test("rolagem da TV anda em direção ao alvo sem passar dele", () => {
  const step = approach(0, 1000, 16);
  assert.ok(step > 0 && step < 1000);
  assert.ok(approach(1000, 0, 16) < 1000);
});

test("rolagem da TV termina exatamente no alvo", () => {
  assert.equal(run(0, 1234, 16, 1000), 1234);
  assert.equal(approach(1233.7, 1234, 16), 1234);
});

test("rolagem da TV chega quase toda em ~350 ms, a 60 ou a 30 quadros", () => {
  for (const frame of [16, 33]) {
    const position = run(0, 1000, frame, 350);
    assert.ok(position > 900, `quadro de ${frame} ms parou em ${position}`);
  }
});

test("passo sem tempo decorrido não move", () => {
  assert.equal(approach(10, 500, 0), 10);
});
