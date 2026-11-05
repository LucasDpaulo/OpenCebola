import assert from "node:assert/strict";
import test from "node:test";
import { findAdjacentTvZoneIndex } from "../app/tv/tv-zone-navigation.js";

test("desce para a próxima zona com focável", () => {
  const result = findAdjacentTvZoneIndex([true, true, true], 0, "down");
  assert.equal(result, 1);
});

test("sobe para a zona anterior com focável", () => {
  const result = findAdjacentTvZoneIndex([true, true, true], 2, "up");
  assert.equal(result, 1);
});

test("pula zona vazia no meio do caminho", () => {
  const result = findAdjacentTvZoneIndex([true, false, true], 0, "down");
  assert.equal(result, 2);
});

test("sem zona seguinte (já é a última), devolve null — não faz nada", () => {
  const result = findAdjacentTvZoneIndex([true, true, true], 2, "down");
  assert.equal(result, null);
});

test("sem zona anterior (já é a primeira), devolve null — não faz nada", () => {
  const result = findAdjacentTvZoneIndex([true, true, true], 0, "up");
  assert.equal(result, null);
});

test("só zonas vazias na direção: devolve null mesmo existindo mais zonas", () => {
  const result = findAdjacentTvZoneIndex([true, false, false], 0, "down");
  assert.equal(result, null);
});

test("foco fora de qualquer zona (-1): desce a partir do início", () => {
  const result = findAdjacentTvZoneIndex([false, true, true], -1, "down");
  assert.equal(result, 1);
});

test("foco fora de qualquer zona (índice = length): sobe a partir do fim", () => {
  const result = findAdjacentTvZoneIndex([true, true, false], 3, "up");
  assert.equal(result, 1);
});

test("lista vazia de zonas: devolve null em qualquer direção", () => {
  assert.equal(findAdjacentTvZoneIndex([], 0, "down"), null);
  assert.equal(findAdjacentTvZoneIndex([], 0, "up"), null);
});
