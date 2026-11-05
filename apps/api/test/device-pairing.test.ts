import assert from "node:assert/strict";
import test from "node:test";
import { DevicePairingStore } from "../src/auth/device-pairing.js";

const t0 = new Date("2026-08-24T12:00:00.000Z");
const passados = (minutos: number) => new Date(t0.getTime() + minutos * 60_000);

test("código sem ambiguidade visual, porque alguém vai ler ele de longe na TV", () => {
  const loja = new DevicePairingStore();
  for (let i = 0; i < 200; i += 1) {
    const bilhete = loja.create(t0);
    assert.match(bilhete.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    assert.ok(bilhete.deviceId.length >= 32);
  }
});

test("fluxo completo: cria, aprova, reivindica", () => {
  const loja = new DevicePairingStore();
  const bilhete = loja.create(t0);

  assert.deepEqual(loja.claim(bilhete.code, bilhete.deviceId, t0), { status: "pending" });
  assert.equal(loja.approve(bilhete.code, "user-1", t0), true);
  const reivindicado = loja.claim(bilhete.code, bilhete.deviceId, t0);
  assert.equal(reivindicado.status, "approved");
  assert.equal(reivindicado.status === "approved" ? reivindicado.userId : null, "user-1");
});

// A emissão da sessão acontece depois do consumo, e pode falhar. Sem devolver o bilhete, um
// piscar do Supabase apagaria um código que a pessoa acabou de ver aprovar.
test("bilhete devolvido volta a valer, e continua aprovado", () => {
  const loja = new DevicePairingStore();
  const bilhete = loja.create(t0);
  loja.approve(bilhete.code, "user-1", t0);

  const primeira = loja.claim(bilhete.code, bilhete.deviceId, t0);
  assert.equal(primeira.status, "approved");
  if (primeira.status !== "approved") return;
  primeira.restore(t0);

  const segunda = loja.claim(bilhete.code, bilhete.deviceId, t0);
  assert.equal(segunda.status, "approved");
  assert.equal(segunda.status === "approved" ? segunda.userId : null, "user-1");
});

// Devolver não pode ressuscitar o que já venceu: os 10 minutos valem mesmo em caso de falha.
test("bilhete vencido não volta ao mapa", () => {
  const loja = new DevicePairingStore();
  const bilhete = loja.create(t0);
  loja.approve(bilhete.code, "user-1", t0);

  const primeira = loja.claim(bilhete.code, bilhete.deviceId, t0);
  if (primeira.status !== "approved") throw new Error("bilhete deveria estar aprovado");
  primeira.restore(passados(11));

  assert.deepEqual(loja.claim(bilhete.code, bilhete.deviceId, t0), { status: "unknown" });
});

// Quem lê o código na tela não pode roubar a sessão: o deviceId nunca sai da TV.
test("código certo com deviceId errado não reivindica nada", () => {
  const loja = new DevicePairingStore();
  const bilhete = loja.create(t0);
  loja.approve(bilhete.code, "user-1", t0);
  assert.deepEqual(loja.claim(bilhete.code, "deviceId-de-outro", t0), { status: "unknown" });
});

test("reivindicar consome: a segunda vez não devolve nada", () => {
  const loja = new DevicePairingStore();
  const bilhete = loja.create(t0);
  loja.approve(bilhete.code, "user-1", t0);
  loja.claim(bilhete.code, bilhete.deviceId, t0);
  assert.deepEqual(loja.claim(bilhete.code, bilhete.deviceId, t0), { status: "unknown" });
});

test("passados 10 minutos o código morre, aprovado ou não", () => {
  const loja = new DevicePairingStore();
  const bilhete = loja.create(t0);
  loja.approve(bilhete.code, "user-1", t0);
  assert.deepEqual(loja.claim(bilhete.code, bilhete.deviceId, passados(11)), { status: "unknown" });
  assert.equal(loja.approve(bilhete.code, "user-1", passados(11)), false);
});

test("aprovar código inexistente devolve false, sem lançar", () => {
  assert.equal(new DevicePairingStore().approve("ZZZZZZ", "user-1", t0), false);
});

// Sem teto, uma sequência de POSTs encheria a memória da VM com códigos que ninguém vai usar.
test("acima do teto de códigos pendentes, criar lança", () => {
  const loja = new DevicePairingStore({ maxPending: 3 });
  for (let i = 0; i < 3; i += 1) loja.create(t0);
  assert.throws(() => loja.create(t0), /pareamento/i);
  // Depois que os antigos expiram, volta a aceitar.
  assert.ok(loja.create(passados(11)).code);
});
