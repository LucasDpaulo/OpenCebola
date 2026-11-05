import assert from "node:assert/strict";
import test from "node:test";
import { interceptPlaybackBack } from "../app/player/playback-back.js";

test("Voltar fecha a reprodução antes de navegar; após sair, libera o histórico", () => {
  const target = new EventTarget();
  let closed = 0;
  const remove = interceptPlaybackBack(target, () => { closed++; });
  assert.equal(target.dispatchEvent(new Event("cebola:playback-back", { cancelable: true })), false);
  assert.equal(closed, 1);
  remove();
  assert.equal(target.dispatchEvent(new Event("cebola:playback-back", { cancelable: true })), true);
  assert.equal(closed, 1);
});
