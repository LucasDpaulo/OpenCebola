import assert from "node:assert/strict";
import test from "node:test";
import { contiguousReadyItems, nextCarouselIndex } from "../app/home-load-state.js";

test("não publica uma nova lista enquanto o prefixo visível não mudou", () => {
  const first = { id: "primeiro" };
  const hiddenLaterResult = { id: "terceiro" };
  const previous = [first];

  const next = contiguousReadyItems(previous, [first, null, hiddenLaterResult]);

  assert.equal(next, previous);
});

test("acrescenta somente o prefixo contínuo quando a lacuna é resolvida", () => {
  const first = { id: "primeiro" };
  const second = { id: "segundo" };
  const third = { id: "terceiro" };
  const previous = [first];

  const next = contiguousReadyItems(previous, [first, second, third]);

  assert.deepEqual(next, [first, second, third]);
  assert.notEqual(next, previous);
});

test("não republica quando só chegou um catálogo vazio", () => {
  const first = { id: "primeiro", items: ["obra"] };
  const empty = { id: "vazio", items: [] as string[] };
  const previous = [first];

  const next = contiguousReadyItems(previous, [first, empty], (rail) => rail.items.length > 0);

  assert.equal(next, previous);
});

test("mantém o destaque atual quando novos itens entram no carrossel", () => {
  assert.equal(nextCarouselIndex(4, 12), 4);
});

test("recoloca o índice apenas quando o destaque atual deixa de existir", () => {
  assert.equal(nextCarouselIndex(4, 3), 0);
});
