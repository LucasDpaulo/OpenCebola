import assert from "node:assert/strict";
import test from "node:test";
import { autoplayDecision } from "../app/player/autoplay-decision.js";

test("lote RD filtrado não encerra autoplay antes de chegar o torrent", () => {
  assert.equal(autoplayDecision("empty", true, false), "wait");
  assert.equal(autoplayDecision("ready", true, true), "play");
});

test("abre assim que há fonte sem aguardar addons lentos", () => {
  assert.equal(autoplayDecision("ready", true, true), "play");
});

test("somente fontes manuais aguardam descoberta e depois devolvem escolha", () => {
  assert.equal(autoplayDecision("ready", true, false), "wait");
  assert.equal(autoplayDecision("ready", false, false), "choose");
});

test("busca vazia ou falha encerrada não deixa carregamento preso", () => {
  assert.equal(autoplayDecision("empty", false, false), "choose");
  assert.equal(autoplayDecision("error", false, false), "choose");
});
