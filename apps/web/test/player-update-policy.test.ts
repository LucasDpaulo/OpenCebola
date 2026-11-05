import assert from "node:assert/strict";
import test from "node:test";
import { shouldPublishPlayerPosition } from "../app/player/player-update-policy.js";

const context = { lowPower: true, visible: false, playing: true, skipBlocks: [], hasNext: false, duration: 1200 };
test("um minuto com controles escondidos publica 12 posições, visíveis publicam todas", () => {
  for (const visible of [false, true]) {
    let previous = 0;
    let updates = 0;
    for (let second = 1; second <= 60; second++) {
      if (shouldPublishPlayerPosition(previous, second, { ...context, visible })) {
        previous = second;
        updates++;
      }
    }
    assert.equal(updates, visible ? 60 : 12);
  }
});
test("abertura, contagem de próximo episódio, pausa e retorno por seek continuam imediatos", () => {
  const skipBlocks = [{ kind: "opening" as const, start: 10, end: 90, episodeLength: null }];
  assert.equal(shouldPublishPlayerPosition(8, 9, { ...context, skipBlocks }), true);
  assert.equal(shouldPublishPlayerPosition(10, 11, { ...context, skipBlocks }), true);
  assert.equal(shouldPublishPlayerPosition(1155, 1156, { ...context, hasNext: true }), true);
  assert.equal(shouldPublishPlayerPosition(100, 101, { ...context, playing: false }), true);
  assert.equal(shouldPublishPlayerPosition(100, 90, context), true);
  assert.equal(shouldPublishPlayerPosition(100, 101, { ...context, lowPower: false }), true);
});
