import assert from "node:assert/strict";
import test from "node:test";
import { isDebridPlaceholder, pollDebrid, waitForDebrid } from "../app/player/debrid-wait.js";

test("continua aguardando além das seis consultas e entrega somente a fonte pronta", async () => {
  let reads = 0, notices = 0;
  const result = await pollDebrid({
    signal: new AbortController().signal,
    read: async () => ++reads > 20 ? "ready" : "pending",
    pending: value => value === "pending",
    onPending: () => { notices++; },
    wait: async () => {}
  });
  assert.equal(result, "ready");
  assert.equal(reads, 21);
  assert.equal(notices, 20);
});

test("cancelar durante consulta impede abrir a fonte e publicar outro aviso", async () => {
  const controller = new AbortController();
  await assert.rejects(pollDebrid({
    signal: controller.signal,
    read: async () => { controller.abort(); return "ready"; },
    pending: () => false,
    onPending: () => assert.fail("não deve atualizar a tela")
  }), { name: "AbortError" });
});

test("cancelar a espera interrompe imediatamente o temporizador", async () => {
  const controller = new AbortController();
  const pending = waitForDebrid(controller.signal, 60_000);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(waitForDebrid(controller.signal), { name: "AbortError" });
});

test("falha real não vira download pendente infinito", async () => {
  await assert.rejects(pollDebrid({
    signal: new AbortController().signal,
    read: async () => { throw new Error("autenticação"); },
    pending: () => true,
    onPending: () => assert.fail("não deve informar download")
  }), /autenticação/);
});

test("aviso curto do Torrentio aguarda, longa-metragem e outro provedor não", () => {
  const stream = { addonName: "Torrentio RD", readyNow: true };
  assert.equal(isDebridPlaceholder(stream, 30), true);
  assert.equal(isDebridPlaceholder(stream, 1400), false);
  assert.equal(isDebridPlaceholder(stream, NaN), false);
  assert.equal(isDebridPlaceholder({ addonName: "Outro", readyNow: null }, 30), false);
});
