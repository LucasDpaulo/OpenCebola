import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

// ponte.js é um script clássico do navegador (sem export ESM): importá-lo registra
// CebolaPonte no escopo global, o mesmo que o <script src> faz em window.
const caminho = path.join(path.dirname(fileURLToPath(import.meta.url)), "../www/ponte.js");
await import(pathToFileURL(caminho).href);
const { criarPonte, ORIGEM_SITE } = globalThis.CebolaPonte;

const SEGREDO = "https://exemplo.test/video.mkv?token=SEGREDO123";

// avplay falso: grava cada chamada e deixa o teste programar retornos e falhas.
function criarAvplay(config = {}) {
  const chamadas = [];
  const registrar = (nome, ...args) => chamadas.push([nome, ...args]);
  const falhar = (nome) => { if (config.falhaEm === nome) throw config.erro ?? new Error(`${nome} falhou`); };
  const av = {
    chamadas,
    listener: null,
    open(url) { registrar("open", url); falhar("open"); },
    close() { registrar("close"); },
    stop() { registrar("stop"); },
    play() { registrar("play"); },
    pause() { registrar("pause"); },
    suspend() { registrar("suspend"); },
    restore() { registrar("restore"); },
    setDisplayRect(...args) { registrar("setDisplayRect", ...args); },
    setListener(listener) { registrar("setListener"); av.listener = listener; },
    prepareAsync(ok, falha) {
      registrar("prepareAsync");
      if (config.falhaEm === "prepareAsync") falha(config.erro ?? "PLAYER_ERROR_INVALID_URI"); else ok();
    },
    seekTo(ms, ok, falha) {
      registrar("seekTo", ms);
      if (config.seekSemCallback) return;
      if (config.falhaEm === "seekTo") falha("seek recusado"); else ok();
    },
    getDuration() { return 7200000; },
    getTotalTrackInfo() {
      return config.faixas ?? [
        { index: 0, type: "VIDEO", extra_info: "{\"fourCC\":\"H264\"}" },
        { index: 1, type: "AUDIO", extra_info: "{\"language\":\"por\",\"channels\":\"6\"}" },
        { index: 2, type: "AUDIO", extra_info: { language: "eng" } },
        { index: 3, type: "TEXT", extra_info: "isto não é json" }
      ];
    },
    getCurrentStreamInfo() { return [{ index: 2, type: "AUDIO", extra_info: "{\"language\":\"eng\"}" }]; },
    getState() { return "PLAYING"; },
    getCurrentTime() { return 61500; },
    setSelectTrack(tipo, index) { registrar("setSelectTrack", tipo, index); falhar("setSelectTrack"); },
    setSilentSubtitle(valor) { registrar("setSilentSubtitle", valor); }
  };
  return av;
}

function montar({ avplay = criarAvplay(), agora, esperaCallbackMs } = {}) {
  const enviadas = [];
  const janela = { janela: "do site" };
  const saidas = [];
  const ponte = criarPonte({
    avplay,
    enviar: (mensagem) => enviadas.push(mensagem),
    sair: () => saidas.push("sair"),
    janelaSite: () => janela,
    agora,
    esperaCallbackMs
  });
  const mensagem = (data, sobrescrever = {}) =>
    ponte.receber({ origin: ORIGEM_SITE, source: janela, data, ...sobrescrever });
  const nomes = () => avplay.chamadas.map((chamada) => chamada[0]);
  return { ponte, avplay, enviadas, saidas, mensagem, nomes, janela };
}

test("mensagem de origem ou janela errada é ignorada", async () => {
  const { mensagem, enviadas, avplay, saidas } = montar();

  await mensagem({ cebola: "ola" }, { origin: "https://outro.test" });
  await mensagem({ cebola: "ola" }, { source: { janela: "de outro iframe" } });
  await mensagem({ cebola: "ola" }, { source: undefined });
  await mensagem({ cebola: "avplay", id: 1, op: "tocar", args: {} }, { origin: "https://outro.test" });
  await mensagem({ cebola: "sair" }, { origin: "https://outro.test" });

  assert.deepEqual(enviadas, []);
  assert.deepEqual(avplay.chamadas, []);
  assert.deepEqual(saidas, []);
});

test("sem janela do site conhecida nada é aceito", async () => {
  const enviadas = [];
  const ponte = criarPonte({ avplay: criarAvplay(), enviar: (m) => enviadas.push(m), janelaSite: () => null });
  await ponte.receber({ origin: ORIGEM_SITE, source: null, data: { cebola: "ola" } });
  await ponte.receber({ origin: ORIGEM_SITE, source: undefined, data: { cebola: "ola" } });
  assert.deepEqual(enviadas, []);
});

test("dados que não são objeto com campo cebola em texto são ignorados", async () => {
  const { mensagem, enviadas } = montar();
  await mensagem("ola");
  await mensagem(null);
  await mensagem({ cebola: 1 });
  await mensagem({ outro: "ola" });
  await mensagem({ cebola: "desconhecida" });
  assert.deepEqual(enviadas, []);
});

test("ola responde casca com a versão e avplay disponível", async () => {
  const { mensagem, enviadas } = montar();
  await mensagem({ cebola: "ola" });
  assert.deepEqual(enviadas, [{ cebola: "casca", versao: 1, avplay: true, streaming: false }]);
});

test("ola informa avplay false quando a TV não tem webapis", async () => {
  const { mensagem, enviadas } = montar({ avplay: null });
  await mensagem({ cebola: "ola" });
  assert.deepEqual(enviadas, [{ cebola: "casca", versao: 1, avplay: false, streaming: false }]);
});

test("abrir chama open, setDisplayRect, setListener, prepareAsync e seekTo, e devolve duração e faixas", async () => {
  const { mensagem, enviadas, nomes, avplay } = montar();

  await mensagem({ cebola: "avplay", id: 7, op: "abrir", args: { url: SEGREDO, inicio: 600 } });

  assert.deepEqual(nomes(), ["open", "setDisplayRect", "setListener", "prepareAsync", "seekTo"]);
  assert.deepEqual(avplay.chamadas[0], ["open", SEGREDO]);
  assert.deepEqual(avplay.chamadas[1], ["setDisplayRect", 0, 0, 1920, 1080]);
  assert.deepEqual(avplay.chamadas[4], ["seekTo", 600000]);
  assert.equal(nomes().includes("play"), false, "abrir não dá play");
  assert.deepEqual(enviadas, [{
    cebola: "avplay:resposta", id: 7, ok: true,
    valor: {
      duracao: 7200000,
      faixas: [
        { index: 0, tipo: "VIDEO", info: { fourCC: "H264" } },
        { index: 1, tipo: "AUDIO", info: { language: "por", channels: "6" } },
        { index: 2, tipo: "AUDIO", info: { language: "eng" } },
        { index: 3, tipo: "TEXT", info: {} }
      ]
    }
  }]);
});

test("abrir sem início não chama seekTo", async () => {
  const { mensagem, nomes, enviadas } = montar();
  await mensagem({ cebola: "avplay", id: 1, op: "abrir", args: { url: SEGREDO, inicio: 0 } });
  assert.equal(nomes().includes("seekTo"), false);
  assert.equal(enviadas[0].ok, true);
});

test("abrir segue se o firmware nunca chama o callback do seekTo", async () => {
  const avplay = criarAvplay({ seekSemCallback: true });
  const { mensagem, enviadas } = montar({ avplay, esperaCallbackMs: 20 });
  await mensagem({ cebola: "avplay", id: 2, op: "abrir", args: { url: SEGREDO, inicio: 30 } });
  assert.equal(enviadas[0].ok, true);
  assert.equal(enviadas[0].valor.duracao, 7200000);
});

test("abrir de novo antes para e fecha o que estava aberto", async () => {
  const { mensagem, nomes } = montar();
  await mensagem({ cebola: "avplay", id: 1, op: "abrir", args: { url: SEGREDO, inicio: 0 } });
  await mensagem({ cebola: "avplay", id: 2, op: "abrir", args: { url: `${SEGREDO}2`, inicio: 0 } });
  assert.deepEqual(nomes(), [
    "open", "setDisplayRect", "setListener", "prepareAsync",
    "stop", "close", "open", "setDisplayRect", "setListener", "prepareAsync"
  ]);
});

test("erro do avplay vira ok:false sem vazar a URL", async () => {
  for (const falhaEm of ["open", "prepareAsync", "seekTo"]) {
    const erro = new Error(`falha em ${SEGREDO} por causa de ${SEGREDO}`);
    erro.name = "InvalidStateError";
    const avplay = criarAvplay({ falhaEm, erro });
    const { mensagem, enviadas } = montar({ avplay });

    await mensagem({ cebola: "avplay", id: 3, op: "abrir", args: { url: SEGREDO, inicio: 10 } });

    assert.equal(enviadas.length, 1, falhaEm);
    assert.equal(enviadas[0].ok, false, falhaEm);
    assert.equal(enviadas[0].id, 3, falhaEm);
    assert.equal(typeof enviadas[0].erro, "string", falhaEm);
    assert.ok(enviadas[0].erro.length <= 120, falhaEm);
    const texto = JSON.stringify(enviadas);
    assert.equal(texto.includes("SEGREDO123"), false, `${falhaEm} vazou o token`);
    assert.equal(texto.includes("exemplo.test"), false, `${falhaEm} vazou o host`);
  }
});

test("falha depois do open fecha a sessão", async () => {
  const avplay = criarAvplay({ falhaEm: "prepareAsync", erro: "PLAYER_ERROR_INVALID_URI" });
  const { mensagem, nomes, enviadas } = montar({ avplay });
  await mensagem({ cebola: "avplay", id: 1, op: "abrir", args: { url: SEGREDO, inicio: 0 } });
  assert.deepEqual(nomes().slice(-2), ["stop", "close"]);
  assert.deepEqual(enviadas[0], { cebola: "avplay:resposta", id: 1, ok: false, erro: "PLAYER_ERROR_INVALID_URI" });
});

test("tocar, pausar e buscar chamam o avplay e respondem", async () => {
  const { mensagem, enviadas, avplay } = montar();
  await mensagem({ cebola: "avplay", id: 1, op: "tocar", args: {} });
  await mensagem({ cebola: "avplay", id: 2, op: "pausar", args: {} });
  await mensagem({ cebola: "avplay", id: 3, op: "buscar", args: { segundos: 12.5 } });
  assert.deepEqual(avplay.chamadas, [["play"], ["pause"], ["seekTo", 12500]]);
  assert.deepEqual(enviadas.map((r) => [r.id, r.ok]), [[1, true], [2, true], [3, true]]);
});

test("buscar responde mesmo sem callback do firmware", async () => {
  const avplay = criarAvplay({ seekSemCallback: true });
  const { mensagem, enviadas } = montar({ avplay, esperaCallbackMs: 20 });
  await mensagem({ cebola: "avplay", id: 4, op: "buscar", args: { segundos: 5 } });
  assert.deepEqual(enviadas, [{ cebola: "avplay:resposta", id: 4, ok: true, valor: null }]);
});

test("parar para e fecha, e nunca falha", async () => {
  const { mensagem, enviadas, nomes, avplay } = montar();
  await mensagem({ cebola: "avplay", id: 1, op: "abrir", args: { url: SEGREDO, inicio: 0 } });
  avplay.stop = () => { throw new Error("estado inválido"); };
  await mensagem({ cebola: "avplay", id: 2, op: "parar", args: {} });
  assert.equal(nomes().at(-1), "close");
  assert.equal(enviadas[1].ok, true);
  await mensagem({ cebola: "avplay", id: 3, op: "parar", args: {} });
  assert.equal(enviadas[2].ok, true);
});

test("audio troca a faixa de áudio", async () => {
  const { mensagem, enviadas, avplay } = montar();
  await mensagem({ cebola: "avplay", id: 1, op: "audio", args: { index: 2 } });
  assert.deepEqual(avplay.chamadas, [["setSelectTrack", "AUDIO", 2]]);
  assert.equal(enviadas[0].ok, true);
});

test("legenda null silencia e número seleciona a faixa de texto", async () => {
  const { mensagem, enviadas, avplay } = montar();
  await mensagem({ cebola: "avplay", id: 1, op: "legenda", args: { index: null } });
  await mensagem({ cebola: "avplay", id: 2, op: "legenda", args: { index: 3 } });
  assert.deepEqual(avplay.chamadas, [
    ["setSilentSubtitle", true],
    ["setSelectTrack", "TEXT", 3],
    ["setSilentSubtitle", false]
  ]);
  assert.deepEqual(enviadas.map((r) => r.ok), [true, true]);
});

test("argumentos inválidos de audio e legenda viram ok:false", async () => {
  const { mensagem, enviadas, avplay } = montar();
  await mensagem({ cebola: "avplay", id: 1, op: "audio", args: {} });
  await mensagem({ cebola: "avplay", id: 2, op: "legenda", args: { index: "1" } });
  await mensagem({ cebola: "avplay", id: 3, op: "buscar", args: { segundos: -1 } });
  assert.deepEqual(avplay.chamadas, []);
  assert.deepEqual(enviadas.map((r) => r.ok), [false, false, false]);
});

test("faixas e estado devolvem os valores normalizados", async () => {
  const { mensagem, enviadas } = montar();
  await mensagem({ cebola: "avplay", id: 1, op: "faixas", args: {} });
  await mensagem({ cebola: "avplay", id: 2, op: "estado", args: {} });
  assert.equal(enviadas[0].ok, true);
  assert.equal(enviadas[0].valor.faixas.length, 4);
  assert.deepEqual(enviadas[0].valor.atuais, [{ index: 2, tipo: "AUDIO", info: { language: "eng" } }]);
  assert.deepEqual(enviadas[1], {
    cebola: "avplay:resposta", id: 2, ok: true, valor: { estado: "PLAYING", posicao: 61500 }
  });
});

test("operação desconhecida ou sem avplay vira ok:false", async () => {
  const { mensagem, enviadas } = montar();
  await mensagem({ cebola: "avplay", id: 1, op: "constructor", args: {} });
  await mensagem({ cebola: "avplay", id: 2, op: "voar", args: {} });
  await mensagem({ cebola: "avplay", id: 3, args: {} });
  assert.deepEqual(enviadas.map((r) => [r.id, r.ok]), [[1, false], [2, false], [3, false]]);

  const semTv = montar({ avplay: null });
  await semTv.mensagem({ cebola: "avplay", id: 9, op: "tocar", args: {} });
  assert.deepEqual(semTv.enviadas, [{ cebola: "avplay:resposta", id: 9, ok: false, erro: "AVPlay indisponível" }]);
});

test("avplay sem id numérico não gera resposta", async () => {
  const { mensagem, enviadas, avplay } = montar();
  await mensagem({ cebola: "avplay", op: "tocar", args: {} });
  await mensagem({ cebola: "avplay", id: "1", op: "tocar", args: {} });
  assert.deepEqual(enviadas, []);
  assert.deepEqual(avplay.chamadas, []);
});

test("oncurrentplaytime chega ao site no máximo uma vez a cada 250 ms", async () => {
  let relogio = 1000;
  const { mensagem, enviadas, avplay } = montar({ agora: () => relogio });
  await mensagem({ cebola: "avplay", id: 1, op: "abrir", args: { url: SEGREDO, inicio: 0 } });
  enviadas.length = 0;

  avplay.listener.oncurrentplaytime(1000);
  relogio += 100;
  avplay.listener.oncurrentplaytime(1100);
  relogio += 149;
  avplay.listener.oncurrentplaytime(1249);
  relogio += 1;
  avplay.listener.oncurrentplaytime(1250);
  relogio += 250;
  avplay.listener.oncurrentplaytime(1500);

  assert.deepEqual(enviadas, [
    { cebola: "avplay:evento", tipo: "posicao", valor: 1000 },
    { cebola: "avplay:evento", tipo: "posicao", valor: 1250 },
    { cebola: "avplay:evento", tipo: "posicao", valor: 1500 }
  ]);
});

test("demais eventos do listener viram avplay:evento", async () => {
  const { mensagem, enviadas, avplay } = montar();
  await mensagem({ cebola: "avplay", id: 1, op: "abrir", args: { url: SEGREDO, inicio: 0 } });
  enviadas.length = 0;

  avplay.listener.onstreamcompleted();
  avplay.listener.onerror("PLAYER_ERROR_CONNECTION_FAILED");
  avplay.listener.onerrormsg("PLAYER_ERROR_UNKNOWN", `falha em ${SEGREDO}`);
  avplay.listener.onsubtitlechange(3000, "Olá, mundo");
  avplay.listener.onbufferingstart();
  avplay.listener.onbufferingcomplete();

  assert.deepEqual(enviadas.slice(0, 2), [
    { cebola: "avplay:evento", tipo: "fim", valor: null },
    { cebola: "avplay:evento", tipo: "erro", valor: "PLAYER_ERROR_CONNECTION_FAILED" }
  ]);
  assert.equal(enviadas[2].tipo, "erro");
  assert.equal(JSON.stringify(enviadas[2]).includes("SEGREDO123"), false);
  assert.deepEqual(enviadas.slice(3), [
    { cebola: "avplay:evento", tipo: "legenda", valor: { texto: "Olá, mundo", duracao: 3000 } },
    { cebola: "avplay:evento", tipo: "buffer", valor: "inicio" },
    { cebola: "avplay:evento", tipo: "buffer", valor: "fim" }
  ]);
});

test("evento atrasado de uma sessão já encerrada não chega ao site", async () => {
  const { mensagem, enviadas, avplay } = montar();
  await mensagem({ cebola: "avplay", id: 1, op: "abrir", args: { url: SEGREDO, inicio: 0 } });
  const antigo = avplay.listener;
  await mensagem({ cebola: "avplay", id: 2, op: "parar", args: {} });
  enviadas.length = 0;
  antigo.onstreamcompleted();
  antigo.oncurrentplaytime(5000);
  assert.deepEqual(enviadas, []);
});

test("sair chama a função de saída", async () => {
  const { mensagem, saidas } = montar();
  await mensagem({ cebola: "sair" });
  assert.deepEqual(saidas, ["sair"]);
});

test("parar da ponte (recarga do iframe) fecha só quando há sessão aberta", async () => {
  const { ponte, mensagem, nomes } = montar();
  ponte.parar();
  assert.deepEqual(nomes(), []);
  await mensagem({ cebola: "avplay", id: 1, op: "abrir", args: { url: SEGREDO, inicio: 0 } });
  ponte.parar();
  assert.deepEqual(nomes().slice(-2), ["stop", "close"]);
});

test("suspender e restaurar repassam ao avplay sem lançar", () => {
  const { ponte, avplay } = montar();
  ponte.suspender();
  ponte.restaurar();
  assert.deepEqual(avplay.chamadas, [["suspend"], ["restore"]]);

  avplay.suspend = () => { throw new Error("nada aberto"); };
  assert.doesNotThrow(() => ponte.suspender());
  const semTv = montar({ avplay: null });
  assert.doesNotThrow(() => { semTv.ponte.suspender(); semTv.ponte.restaurar(); });
});

test("streaming usa a mesma validação de origem da ponte AVPlay", async () => {
  const source = {}, sent = [], calls = [];
  const bridge = criarPonte({ janelaSite: () => source, enviar: message => sent.push(message),
    streaming: { call: async (op, args) => { calls.push([op, args]); return { available: true }; } } });
  const data = { cebola: "avplay", id: 80, op: "streaming.capabilities", args: {} };
  await bridge.receber({ origin: "https://evil.test", source, data });
  assert.equal(calls.length, 0);
  await bridge.receber({ origin: ORIGEM_SITE, source, data });
  assert.deepEqual(calls, [["capabilities", {}]]);
  assert.equal(sent[0].valor.available, true);
});
