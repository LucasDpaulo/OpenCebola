import assert from "node:assert/strict";
import test from "node:test";
import { formatTvSeekOffset, tvHoldSeekStep } from "../app/player/tv-seek";

test("passo ao segurar cresce por degraus até 5 min", () => {
  const casos: [number, number][] = [
    [0, 10], [1500, 10], [1501, 20], [3000, 20], [4500, 30], [6000, 60], [7500, 90],
    [9000, 120], [10500, 180], [12000, 240], [12001, 300], [60000, 300]
  ];
  for (const [ms, passo] of casos) assert.equal(tvHoldSeekStep(ms), passo, `${ms} ms`);
});

test("deslocamento acumulado é formatado em min e s", () => {
  assert.equal(formatTvSeekOffset(30), "+30 s");
  assert.equal(formatTvSeekOffset(90), "+1 min 30 s");
  assert.equal(formatTvSeekOffset(-300), "−5 min");
  assert.equal(formatTvSeekOffset(0), "0 s");
});
