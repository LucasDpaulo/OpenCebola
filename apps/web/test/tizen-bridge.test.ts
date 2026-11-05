import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  aguardarCasca, aoEventoCasca, dentroDaCasca, enviarCasca, estadoCasca, iniciarCasca, reiniciarCascaParaTeste
} from "../app/tv/tizen-casca.js";
import { tizenPlayerDisponivel } from "../app/player/tizen-player.js";
import {
  falasAtivasEm, limparTextoDeLegenda, nomeDoIdioma, parseVttCues, TizenBridgePlayer, type RelogioBridge
} from "../app/player/tizen-bridge-player.js";

// ---- Ambiente falso: a janela da casca (pai), a janela do site, relógio e armazenamento ----------

const UA_TIZEN = "Mozilla/5.0 (SMART-TV; Linux; Tizen 8.0) AppleWebKit/537.36 Chrome/120.0.0.0 TV Safari/537.36";
const UA_PC = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";

type Mensagem = Record<string, unknown>;

/** Relógio e temporizadores controlados à mão: nada nestes testes espera tempo de verdade. */
class RelogioFalso implements RelogioBridge {
  #agora = 1_000;
  #proximoId = 1;
  readonly #tarefas = new Map<number, { quando: number; passo: number | null; acao: () => void }>();

  agora(): number { return this.#agora; }
  get ativos(): number { return this.#tarefas.size; }

  setTimeout = (acao: () => void, espera: number): number => {
    const id = this.#proximoId++;
    this.#tarefas.set(id, { quando: this.#agora + espera, passo: null, acao });
    return id;
  };
  clearTimeout = (id: number): void => { this.#tarefas.delete(id); };
  repetir(acao: () => void, intervaloMs: number): () => void {
    const id = this.#proximoId++;
    this.#tarefas.set(id, { quando: this.#agora + intervaloMs, passo: intervaloMs, acao });
    return () => { this.#tarefas.delete(id); };
  }
  depois(acao: () => void, esperaMs: number): () => void {
    const id = this.setTimeout(acao, esperaMs);
    return () => this.clearTimeout(id);
  }

  /** Anda o relógio disparando, em ordem, tudo que vence no caminho. */
  avancar(ms: number): void {
    const alvo = this.#agora + ms;
    for (;;) {
      let proximo: [number, { quando: number; passo: number | null; acao: () => void }] | null = null;
      for (const entrada of this.#tarefas) {
        if (entrada[1].quando <= alvo && (proximo === null || entrada[1].quando < proximo[1].quando)) proximo = entrada;
      }
      if (proximo === null) break;
      const [id, tarefa] = proximo;
      this.#agora = tarefa.quando;
      if (tarefa.passo === null) this.#tarefas.delete(id); else tarefa.quando += tarefa.passo;
      tarefa.acao();
    }
    this.#agora = alvo;
  }
}

interface Ambiente {
  readonly enviadas: { mensagem: Mensagem; alvo: unknown }[];
  readonly relogio: RelogioFalso;
  readonly classes: string[];
  readonly sessao: Map<string, string>;
  /** Entrega ao site uma mensagem vinda do pai (a casca). */
  deCasca(dados: unknown): void;
  /** Entrega uma mensagem de uma janela que NÃO é o pai. */
  deOutraJanela(dados: unknown): void;
  /** Espera as respostas assíncronas (microtarefas) do pai falso. */
  esvaziar(): Promise<void>;
}

interface OpcoesAmbiente {
  readonly iframe?: boolean;
  readonly ua?: string;
  readonly busca?: string;
  readonly sessao?: Record<string, string>;
  readonly sessaoQuebrada?: boolean;
  /** Como o pai falso responde a cada mensagem do site. */
  readonly pai?: (mensagem: Mensagem) => readonly Mensagem[] | undefined;
}

const originais = {
  window: Object.getOwnPropertyDescriptor(globalThis, "window"),
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  document: Object.getOwnPropertyDescriptor(globalThis, "document")
};

function restaurar(nome: keyof typeof originais): void {
  const original = originais[nome];
  if (original) Object.defineProperty(globalThis, nome, original); else delete (globalThis as Record<string, unknown>)[nome];
}

function instalar(opcoes: OpcoesAmbiente = {}): Ambiente {
  const enviadas: Ambiente["enviadas"] = [];
  const relogio = new RelogioFalso();
  const classes: string[] = [];
  const sessao = new Map(Object.entries(opcoes.sessao ?? {}));
  const ouvintes = new Set<(evento: { source: unknown; data: unknown }) => void>();
  let pendentes = 0;

  const pai = {
    postMessage(mensagem: Mensagem, alvo: unknown) {
      enviadas.push({ mensagem, alvo });
      const respostas = opcoes.pai?.(mensagem) ?? [];
      for (const resposta of respostas) {
        pendentes += 1;
        queueMicrotask(() => { pendentes -= 1; entregar(pai, resposta); });
      }
    }
  };
  function entregar(origem: unknown, dados: unknown) {
    for (const ouvinte of [...ouvintes]) ouvinte({ source: origem, data: dados });
  }

  const janela: Record<string, unknown> = {
    location: { search: opcoes.busca ?? "" },
    sessionStorage: {
      getItem: (chave: string) => {
        if (opcoes.sessaoQuebrada) throw new Error("storage bloqueado");
        return sessao.get(chave) ?? null;
      },
      setItem: (chave: string, valor: string) => {
        if (opcoes.sessaoQuebrada) throw new Error("storage bloqueado");
        sessao.set(chave, valor);
      }
    },
    addEventListener: (tipo: string, ouvinte: (evento: { source: unknown; data: unknown }) => void) => {
      if (tipo === "message") ouvintes.add(ouvinte);
    },
    removeEventListener: (tipo: string, ouvinte: (evento: { source: unknown; data: unknown }) => void) => {
      if (tipo === "message") ouvintes.delete(ouvinte);
    },
    setTimeout: relogio.setTimeout,
    clearTimeout: relogio.clearTimeout
  };
  janela.parent = opcoes.iframe === false ? janela : pai;

  Object.defineProperty(globalThis, "window", { value: janela, configurable: true, writable: true });
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: opcoes.ua ?? UA_TIZEN }, configurable: true });
  Object.defineProperty(globalThis, "document", {
    value: { documentElement: { classList: { add: (nome: string) => classes.push(nome) } } },
    configurable: true, writable: true
  });
  reiniciarCascaParaTeste();

  return {
    enviadas, relogio, classes, sessao,
    deCasca: (dados) => entregar(pai, dados),
    deOutraJanela: (dados) => entregar({ outra: true }, dados),
    esvaziar: async () => {
      for (let i = 0; i < 20 && pendentes > 0; i += 1) await Promise.resolve();
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    }
  };
}

afterEach(() => {
  reiniciarCascaParaTeste();
  restaurar("window");
  restaurar("navigator");
  restaurar("document");
});

// ---- Casca falsa: responde como a ponte.js responderia -------------------------------------------

const FAIXAS = [
  { index: 0, tipo: "VIDEO", info: { fourCC: "HEVC" } },
  { index: 1, tipo: "AUDIO", info: { language: "por", channels: "6" } },
  { index: 2, tipo: "AUDIO", info: { language: "eng", channels: "2" } },
  { index: 3, tipo: "TEXT", info: { language: "por" } },
  { index: 4, tipo: "TEXT", info: { language: "eng" } }
];

function resposta(id: unknown, valor: unknown = null): Mensagem {
  return { cebola: "avplay:resposta", id, ok: true, valor };
}

interface ConfigCasca {
  readonly avplay?: boolean;
  /** Substitui a resposta de uma operação (devolve a lista de mensagens, ou undefined para o padrão). */
  readonly sobrescrever?: (op: string, mensagem: Mensagem) => readonly Mensagem[] | undefined;
}

function cascaFalsa(config: ConfigCasca = {}): (mensagem: Mensagem) => readonly Mensagem[] {
  return (mensagem) => {
    if (mensagem.cebola === "ola") return [{ cebola: "casca", versao: 1, avplay: config.avplay ?? true }];
    if (mensagem.cebola !== "avplay") return [];
    const op = String(mensagem.op);
    const personalizada = config.sobrescrever?.(op, mensagem);
    if (personalizada) return personalizada;
    if (op === "abrir") return [resposta(mensagem.id, { duracao: 7_200_000, faixas: FAIXAS })];
    if (op === "faixas") {
      return [resposta(mensagem.id, { faixas: FAIXAS, atuais: [FAIXAS[0], FAIXAS[1], FAIXAS[3]] })];
    }
    return [resposta(mensagem.id)];
  };
}

const operacoes = (ambiente: Ambiente): string[] =>
  ambiente.enviadas.filter((e) => e.mensagem.cebola === "avplay").map((e) => String(e.mensagem.op));

const ultima = (ambiente: Ambiente, op: string): Mensagem | undefined =>
  [...ambiente.enviadas].reverse().find((e) => e.mensagem.op === op)?.mensagem;

const VTT = `WEBVTT

1
00:00:01.000 --> 00:00:03.000 align:middle line:90%
Primeira fala

2
00:00:05.000 --> 00:00:07.500
<i>Segunda</i> fala
com duas linhas

NOTE comentario
00:00:99.000 --> 00:00:99.500

3
00:00:20.000 --> 00:00:22.000
{\\an8}Terceira`;

// ---- dentroDaCasca -------------------------------------------------------------------------------

test("dentroDaCasca: só dentro de iframe, com Tizen e com a marca (URL ou sessão)", () => {
  instalar({ busca: "?casca=1" });
  assert.equal(dentroDaCasca(), true);

  const comSessao = instalar({ sessao: { "cebola.casca": "1" } });
  assert.equal(dentroDaCasca(), true, "a navegação do Next tira o parâmetro, mas a sessão lembra");
  assert.equal(comSessao.sessao.get("cebola.casca"), "1");

  instalar({});
  assert.equal(dentroDaCasca(), false, "iframe do Tizen sem a marca não é a casca");

  instalar({ busca: "?casca=0" });
  assert.equal(dentroDaCasca(), false);
});

test("dentroDaCasca: a marca da URL é gravada na sessão para as páginas seguintes", () => {
  const ambiente = instalar({ busca: "?casca=1" });
  assert.equal(dentroDaCasca(), true);
  assert.equal(ambiente.sessao.get("cebola.casca"), "1");
});

test("dentroDaCasca: falso fora de iframe, sem Tizen ou sem janela", () => {
  instalar({ busca: "?casca=1", iframe: false });
  assert.equal(dentroDaCasca(), false, "janela de topo");

  instalar({ busca: "?casca=1", ua: UA_PC });
  assert.equal(dentroDaCasca(), false, "navegador comum dentro de um iframe");

  instalar({ sessao: { "cebola.casca": "1" }, ua: UA_PC });
  assert.equal(dentroDaCasca(), false, "a sessão sozinha não basta sem Tizen");

  restaurar("window");
  assert.equal(dentroDaCasca(), false, "sem window (render no servidor)");
});

test("dentroDaCasca: armazenamento bloqueado ainda vale pela URL", () => {
  instalar({ busca: "?casca=1", sessaoQuebrada: true });
  assert.equal(dentroDaCasca(), true);
  instalar({ sessaoQuebrada: true });
  assert.equal(dentroDaCasca(), false);
});

// ---- iniciarCasca e estado -----------------------------------------------------------------------

test("iniciarCasca: manda um só `ola`, marca o <html> e guarda o AVPlay da casca", async () => {
  const ambiente = instalar({ busca: "?casca=1", pai: cascaFalsa() });
  assert.equal(estadoCasca(), "pendente");
  iniciarCasca();
  iniciarCasca();
  assert.deepEqual(ambiente.enviadas.map((e) => e.mensagem), [{ cebola: "ola" }]);
  assert.equal(ambiente.enviadas[0]?.alvo, "*");
  assert.deepEqual(ambiente.classes, ["casca-tizen"]);
  await ambiente.esvaziar();
  assert.equal(estadoCasca(), "com-avplay");
  assert.equal(await aguardarCasca(), "com-avplay");
});

test("iniciarCasca: casca sem AVPlay e casca muda (3 s) viram `sem-avplay`", async () => {
  const semAvplay = instalar({ busca: "?casca=1", pai: cascaFalsa({ avplay: false }) });
  iniciarCasca();
  await semAvplay.esvaziar();
  assert.equal(estadoCasca(), "sem-avplay");

  const muda = instalar({ busca: "?casca=1", pai: () => [] });
  iniciarCasca();
  const espera = aguardarCasca();
  muda.relogio.avancar(2_999);
  assert.equal(estadoCasca(), "pendente");
  muda.relogio.avancar(1);
  assert.equal(estadoCasca(), "sem-avplay");
  assert.equal(await espera, "sem-avplay");

  // Uma resposta tardia ainda corrige o estado.
  muda.deCasca({ cebola: "casca", versao: 1, avplay: true });
  assert.equal(estadoCasca(), "com-avplay");
});

test("iniciarCasca: fora da casca não manda nada, não ouve nada e não marca o <html>", async () => {
  const ambiente = instalar({ busca: "?casca=1", ua: UA_PC, pai: cascaFalsa() });
  iniciarCasca();
  assert.deepEqual(ambiente.enviadas, []);
  assert.deepEqual(ambiente.classes, []);
  assert.equal(await aguardarCasca(), "sem-avplay");
  await assert.rejects(enviarCasca("tocar"), /Fora da casca/);
});

test("mensagens que não vêm do pai, ou sem `cebola` textual, são ignoradas", async () => {
  const ambiente = instalar({ busca: "?casca=1", pai: () => [] });
  iniciarCasca();
  ambiente.deOutraJanela({ cebola: "casca", versao: 1, avplay: true });
  ambiente.deCasca({ casca: true, avplay: true });
  ambiente.deCasca({ cebola: 1, avplay: true });
  ambiente.deCasca("texto solto");
  ambiente.deCasca(null);
  assert.equal(estadoCasca(), "pendente");
});

test("tizenPlayerDisponivel: dentro da casca vale até ela dizer que não tem AVPlay", async () => {
  const ambiente = instalar({ busca: "?casca=1", pai: () => [] });
  assert.equal(tizenPlayerDisponivel(), true, "pendente conta como disponível");
  iniciarCasca();
  ambiente.deCasca({ cebola: "casca", versao: 1, avplay: true });
  assert.equal(tizenPlayerDisponivel(), true);
  ambiente.deCasca({ cebola: "casca", versao: 1, avplay: false });
  assert.equal(tizenPlayerDisponivel(), false);

  instalar({ busca: "?casca=1", ua: UA_PC });
  assert.equal(tizenPlayerDisponivel(), false, "navegador comum nunca");
  instalar({ iframe: false });
  assert.equal(tizenPlayerDisponivel(), false, "janela de topo sem webapis");
});

// ---- RPC -----------------------------------------------------------------------------------------

test("enviarCasca: ids crescentes, resposta ok devolve o valor e ok:false rejeita com o texto", async () => {
  const ambiente = instalar({
    busca: "?casca=1",
    pai: cascaFalsa({
      sobrescrever: (op, m) => op === "quebrar"
        ? [{ cebola: "avplay:resposta", id: m.id, ok: false, erro: "InvalidStateError" }]
        : op === "valor" ? [resposta(m.id, { duracao: 5 })] : undefined
    })
  });
  const primeira = enviarCasca("valor", { a: 1 });
  const segunda = enviarCasca("quebrar");
  const [valor, falha] = await Promise.all([primeira, segunda.then(() => null, (erro: Error) => erro)]);
  assert.deepEqual(valor, { duracao: 5 });
  assert.equal(falha?.message, "InvalidStateError");

  const chamadas = ambiente.enviadas.map((e) => e.mensagem).filter((m) => m.cebola === "avplay");
  assert.deepEqual(chamadas, [
    { cebola: "avplay", id: 1, op: "valor", args: { a: 1 } },
    { cebola: "avplay", id: 2, op: "quebrar", args: {} }
  ]);
});

test("enviarCasca: sem resposta no prazo rejeita, e a resposta atrasada não quebra nada", async () => {
  const ambiente = instalar({ busca: "?casca=1", pai: () => [] });
  const pedido = enviarCasca("tocar", {}, 1_000).then(() => "ok", (erro: Error) => erro.message);
  ambiente.relogio.avancar(999);
  ambiente.relogio.avancar(1);
  assert.match(await pedido, /não respondeu \(tocar\)/);
  ambiente.deCasca(resposta(1));
  ambiente.deCasca({ cebola: "avplay:resposta", id: 99, ok: true });
});

test("aoEventoCasca: entrega os eventos e para depois de desinscrever", () => {
  const ambiente = instalar({ busca: "?casca=1", pai: () => [] });
  iniciarCasca();
  const vistos: unknown[] = [];
  const parar = aoEventoCasca((evento) => vistos.push(evento));
  ambiente.deCasca({ cebola: "avplay:evento", tipo: "posicao", valor: 1500 });
  ambiente.deCasca({ cebola: "avplay:evento", valor: 1 });
  parar();
  ambiente.deCasca({ cebola: "avplay:evento", tipo: "fim", valor: null });
  assert.deepEqual(vistos, [{ tipo: "posicao", valor: 1500 }]);
});

// ---- parseVttCues e falas ativas -----------------------------------------------------------------

test("parseVttCues: VTT com configurações, itálico, NOTE e marca ASS", () => {
  assert.deepEqual(parseVttCues(VTT), [
    { start: 1, end: 3, text: "Primeira fala" },
    { start: 5, end: 7.5, text: "<i>Segunda</i> fala\ncom duas linhas" },
    { start: 20, end: 22, text: "Terceira" }
  ]);
});

test("parseVttCues: SRT simples com vírgula, CRLF, BOM e fora de ordem", () => {
  const srt = "﻿2\r\n00:01:02,500 --> 00:01:04,000\r\nDepois\r\n\r\n1\r\n00:00:01,000 --> 00:00:02,250\r\nAntes &amp; agora\r\n\r\n3\r\n00:00:09,000 --> 00:00:08,000\r\nInvertida\r\n";
  assert.deepEqual(parseVttCues(srt), [
    { start: 1, end: 2.25, text: "Antes & agora" },
    { start: 62.5, end: 64, text: "Depois" }
  ]);
  assert.deepEqual(parseVttCues("WEBVTT\n\nsó lixo\n"), []);
});

test("limparTextoDeLegenda: tira marcas ASS e vira \\N em quebra de linha", () => {
  assert.equal(limparTextoDeLegenda("{\\an8}{\\i1}Olá{\\i0}\\Nmundo"), "Olá\nmundo");
  assert.equal(limparTextoDeLegenda("  {y:i}Oi\\hamigo  "), "Oi amigo");
});

test("falasAtivasEm: janela [início, fim), deslocamento e duração extra", () => {
  const falas = parseVttCues(VTT);
  const textos = (segundos: number, deslocamento = 0, extra = 0) =>
    falasAtivasEm(falas, segundos, deslocamento, extra).map((f) => f.text);
  assert.deepEqual(textos(0.9), []);
  assert.deepEqual(textos(1), ["Primeira fala"]);
  assert.deepEqual(textos(2.99), ["Primeira fala"]);
  assert.deepEqual(textos(3), []);
  // Atraso de 2 s: a primeira fala passa a valer de 3 s a 5 s.
  assert.deepEqual(textos(2.5, 2), []);
  assert.deepEqual(textos(3, 2), ["Primeira fala"]);
  // Duração extra de 1,5 s: a primeira fala fica na tela até 4,5 s.
  assert.deepEqual(textos(4.4, 0, 1.5), ["Primeira fala"]);
  assert.deepEqual(textos(4.5, 0, 1.5), []);
  // Deslocamento negativo nunca começa antes do zero, nem termina antes de começar: a primeira
  // fala (já "vencida" com -5 s) ainda aparece por 0,1 s no zero, e a segunda entra em 0.
  assert.deepEqual(textos(0, -5), ["Primeira fala", "<i>Segunda</i> fala\ncom duas linhas"]);
  assert.deepEqual(textos(0.2, -5), ["<i>Segunda</i> fala\ncom duas linhas"]);
});

test("nomeDoIdioma: código de 3 letras vira nome em português; desconhecido cai no código", () => {
  assert.equal(nomeDoIdioma("por"), "Português");
  assert.equal(nomeDoIdioma("eng"), "Inglês");
  assert.equal(nomeDoIdioma("jpn"), "Japonês");
  assert.equal(nomeDoIdioma("und"), null);
  assert.equal(nomeDoIdioma(null), null);
  assert.equal(nomeDoIdioma("xyz"), "xyz");
});

// ---- TizenBridgePlayer ---------------------------------------------------------------------------

function fonte(sobre: Partial<Parameters<TizenBridgePlayer["load"]>[0]> = {}): Parameters<TizenBridgePlayer["load"]>[0] {
  return { url: "https://debrid.example/video.mkv?token=segredo", startAtSeconds: 42, subtitles: [], ...sobre };
}

function criar(ambiente: Ambiente, textos: Record<string, string> = {}) {
  const buscas: string[] = [];
  const player = new TizenBridgePlayer({
    relogio: ambiente.relogio,
    buscarTexto: async (url) => {
      buscas.push(url);
      const texto = textos[url];
      if (texto === undefined) throw new Error("404");
      return texto;
    }
  });
  const cues: (readonly { id: string; text: string }[])[] = [];
  player.on("subtitleCues", (lista) => cues.push(lista));
  return { player, cues, buscas };
}

test("load: espera o `ola`, abre com a posição de retomada, emite ready e só então toca", async () => {
  const ambiente = instalar({ busca: "?casca=1", pai: cascaFalsa() });
  const { player } = criar(ambiente);
  const ordem: string[] = [];
  player.on("ready", (estado) => ordem.push(`ready:${estado.durationSeconds}`));
  const original = ambiente.enviadas.push.bind(ambiente.enviadas);
  ambiente.enviadas.push = (...itens) => {
    for (const item of itens) if (item.mensagem.cebola === "avplay") ordem.push(`op:${String(item.mensagem.op)}`);
    return original(...itens);
  };

  await player.load(fonte());
  await ambiente.esvaziar();

  assert.deepEqual(ordem.slice(0, 3), ["op:abrir", "ready:7200", "op:tocar"]);
  const abrir = ambiente.enviadas.find((e) => e.mensagem.op === "abrir")?.mensagem;
  assert.deepEqual(abrir?.args, { url: "https://debrid.example/video.mkv?token=segredo", inicio: 42 });
  assert.equal(ambiente.enviadas[0]?.mensagem.cebola, "ola", "o primeiro contato é o `ola`");

  const estado = player.state();
  assert.equal(estado.loaded, true);
  assert.equal(estado.playing, true);
  assert.equal(estado.positionSeconds, 42);
  assert.equal(estado.durationSeconds, 7200);
  assert.equal(estado.audioTrackId, "1", "o AVPlay começa pelo primeiro áudio, e `faixas` confirma");
  assert.equal(player.engine(), "avplay");
  assert.deepEqual(await player.capabilities(), { hevc: true, ac3: true, eac3: true, dts: false, mkv: true });
  assert.equal(typeof (player as { setPlaybackRate?: unknown }).setPlaybackRate, "undefined");
});

test("audioTracks: rótulo em português com o canal, e selectAudioTrack manda o índice", async () => {
  const ambiente = instalar({ busca: "?casca=1", pai: cascaFalsa() });
  const { player } = criar(ambiente);
  await player.load(fonte());
  assert.deepEqual(await player.audioTracks(), [
    { id: "1", label: "Português 5.1", language: "por" },
    { id: "2", label: "Inglês 2.0", language: "eng" }
  ]);
  await player.selectAudioTrack("2");
  assert.deepEqual(ultima(ambiente, "audio")?.args, { index: 2 });
  assert.equal(player.state().audioTrackId, "2");
  await assert.rejects(player.selectAudioTrack("abc"), /inválida/);
});

test("faixas: o áudio que o AVPlay escolheu por conta própria vira o atual e avisa a interface", async () => {
  const ambiente = instalar({
    busca: "?casca=1",
    pai: cascaFalsa({
      sobrescrever: (op, m) => op === "faixas"
        ? [resposta(m.id, { faixas: FAIXAS, atuais: [FAIXAS[2]] })]
        : undefined
    })
  });
  const { player } = criar(ambiente);
  let avisos = 0;
  player.on("tracksChanged", () => { avisos += 1; });
  await player.load(fonte());
  await ambiente.esvaziar();
  assert.equal(player.state().audioTrackId, "2");
  assert.equal(avisos, 1);
});

test("load: falha do AVPlay rejeita com mensagem curta e sem URL; sem AVPlay também rejeita", async () => {
  const falha = instalar({
    busca: "?casca=1",
    pai: cascaFalsa({
      sobrescrever: (op, m) => op === "abrir"
        ? [{ cebola: "avplay:resposta", id: m.id, ok: false, erro: "PLAYER_ERROR_NOT_SUPPORTED_FILE https://debrid.example/video.mkv?token=segredo" }]
        : undefined
    })
  });
  const { player } = criar(falha);
  await assert.rejects(player.load(fonte()), (erro: Error) => {
    assert.match(erro.message, /NOT_SUPPORTED_FILE/);
    assert.ok(!erro.message.includes("https://"), erro.message);
    assert.ok(!erro.message.includes("segredo"), erro.message);
    assert.ok(erro.message.length <= 160);
    return true;
  });
  assert.equal(player.state().loaded, false);

  const semAvplay = instalar({ busca: "?casca=1", pai: cascaFalsa({ avplay: false }) });
  await assert.rejects(criar(semAvplay).player.load(fonte()), /AVPlay/);

  const muda = instalar({ busca: "?casca=1", pai: () => [] });
  const pedido = criar(muda).player.load(fonte()).then(() => "ok", (erro: Error) => erro.message);
  muda.relogio.avancar(3_000);
  assert.match(await pedido, /AVPlay/);
});

test("load: `tocar` recusado também rejeita (a volta automática trata como falha antes de tocar)", async () => {
  const ambiente = instalar({
    busca: "?casca=1",
    pai: cascaFalsa({
      sobrescrever: (op, m) => op === "tocar"
        ? [{ cebola: "avplay:resposta", id: m.id, ok: false, erro: "InvalidStateError" }]
        : undefined
    })
  });
  await assert.rejects(criar(ambiente).player.load(fonte()), /não começou a tocar.*InvalidStateError/);
});

test("eventos: posicao vira segundos com fração, fim vira ended e erro vira error", async () => {
  const ambiente = instalar({ busca: "?casca=1", pai: cascaFalsa() });
  const { player } = criar(ambiente);
  const posicoes: number[] = [];
  const fins: number[] = [];
  const erros: string[] = [];
  player.on("position", (s) => posicoes.push(s));
  player.on("ended", () => fins.push(1));
  player.on("error", (m) => erros.push(m));
  await player.load(fonte());

  ambiente.deCasca({ cebola: "avplay:evento", tipo: "posicao", valor: 43_250 });
  ambiente.deCasca({ cebola: "avplay:evento", tipo: "posicao", valor: "lixo" });
  assert.deepEqual(posicoes, [43.25]);
  assert.equal(player.state().positionSeconds, 43.25);

  ambiente.deCasca({ cebola: "avplay:evento", tipo: "erro", valor: "PLAYER_ERROR_CONNECTION_FAILED" });
  assert.equal(erros.length, 1);
  assert.match(erros[0]!, /PLAYER_ERROR_CONNECTION_FAILED/);

  ambiente.deCasca({ cebola: "avplay:evento", tipo: "fim", valor: null });
  assert.deepEqual(fins, [1]);
  assert.equal(player.state().playing, false);
});

test("pause, play e seek vão para a casca (buscar usa `segundos`)", async () => {
  const ambiente = instalar({ busca: "?casca=1", pai: cascaFalsa() });
  const { player } = criar(ambiente);
  await player.load(fonte());
  await player.pause();
  assert.equal(player.state().playing, false);
  await player.seek(90.5);
  assert.deepEqual(ultima(ambiente, "buscar")?.args, { segundos: 90.5 });
  assert.equal(player.state().positionSeconds, 90.5);
  await player.play();
  assert.equal(player.state().playing, true);
  assert.deepEqual(operacoes(ambiente).slice(-3), ["pausar", "buscar", "tocar"]);
});

test("legenda interna: texto chega por evento, some depois da duração e é trocada pela seguinte", async () => {
  const ambiente = instalar({ busca: "?casca=1", pai: cascaFalsa() });
  const { player, cues } = criar(ambiente);
  await player.load(fonte());

  assert.deepEqual(await player.subtitleTracks(), [
    { id: "3", label: "Português · do arquivo", language: "por" },
    { id: "4", label: "Inglês · do arquivo", language: "eng" }
  ]);

  // Antes de escolher, falas que chegarem não aparecem.
  ambiente.deCasca({ cebola: "avplay:evento", tipo: "legenda", valor: { texto: "solta", duracao: 1000 } });
  assert.equal(cues.length, 0);

  await player.selectSubtitleTrack("3");
  assert.deepEqual(ultima(ambiente, "legenda")?.args, { index: 3 });
  assert.equal(player.state().subtitleTrackId, "3");
  assert.deepEqual(cues.at(-1), [], "escolher limpa a tela");

  ambiente.deCasca({ cebola: "avplay:evento", tipo: "legenda", valor: { texto: "{\\an8}Olá\\Nmundo", duracao: 2000 } });
  assert.equal(cues.at(-1)?.length, 1);
  assert.equal(cues.at(-1)?.[0]?.text, "Olá\nmundo");
  const primeiroId = cues.at(-1)![0]!.id;

  ambiente.relogio.avancar(1_999);
  assert.equal(cues.at(-1)?.[0]?.text, "Olá\nmundo");
  ambiente.relogio.avancar(1);
  assert.deepEqual(cues.at(-1), []);

  ambiente.deCasca({ cebola: "avplay:evento", tipo: "legenda", valor: { texto: "Uma", duracao: 5000 } });
  ambiente.deCasca({ cebola: "avplay:evento", tipo: "legenda", valor: { texto: "Outra", duracao: 1000 } });
  assert.equal(cues.at(-1)?.[0]?.text, "Outra");
  assert.notEqual(cues.at(-1)?.[0]?.id, primeiroId, "cada fala tem id próprio (chave do React)");
  ambiente.relogio.avancar(1_000);
  assert.deepEqual(cues.at(-1), [], "a duração da fala anterior não apaga a nova antes da hora");
  ambiente.relogio.avancar(10_000);
  assert.deepEqual(cues.at(-1), []);

  ambiente.deCasca({ cebola: "avplay:evento", tipo: "legenda", valor: { texto: "", duracao: 1000 } });
  assert.deepEqual(cues.at(-1), []);
  await assert.rejects(player.selectSubtitleTrack("99"), /desconhecida/);
});

const EXTERNA = { id: "os:123", label: "Português (Brasil) · OpenSubtitles", language: "pt-BR", url: "https://api.example/legenda.vtt" };

test("legenda externa: baixa o VTT, silencia o AVPlay e mostra as falas conforme o relógio local", async () => {
  const ambiente = instalar({ busca: "?casca=1", pai: cascaFalsa() });
  const { player, cues, buscas } = criar(ambiente, { [EXTERNA.url]: VTT });
  await player.load(fonte({ startAtSeconds: 0, subtitles: [EXTERNA] }));

  // IDs de legenda externa: o `id` da API, sem prefixo (mesma convenção do CapacitorPlayer).
  assert.deepEqual((await player.subtitleTracks()).map((t) => t.id), ["3", "4", "os:123"]);

  await player.selectSubtitleTrack("os:123");
  assert.deepEqual(buscas, [EXTERNA.url]);
  assert.deepEqual(ultima(ambiente, "legenda")?.args, { index: null }, "o AVPlay não desenha esta legenda");
  assert.equal(player.state().subtitleTrackId, "os:123");
  assert.equal(ambiente.relogio.ativos > 0, true, "o relógio gira com a legenda externa ativa");

  const textos = () => cues.at(-1)?.map((c) => c.text) ?? [];
  const emitidos = () => cues.length;

  // O AVPlay avisa a posição 0,5 s; o relógio local anda em cima dela enquanto toca.
  ambiente.deCasca({ cebola: "avplay:evento", tipo: "posicao", valor: 500 });
  assert.deepEqual(textos(), []);
  ambiente.relogio.avancar(400);
  assert.deepEqual(textos(), []);
  ambiente.relogio.avancar(100);
  assert.deepEqual(textos(), ["Primeira fala"]);
  const aposEntrar = emitidos();
  ambiente.relogio.avancar(1_000);
  assert.equal(emitidos(), aposEntrar, "o conjunto não mudou: nada é emitido de novo");
  ambiente.relogio.avancar(1_000);
  assert.deepEqual(textos(), []);
  ambiente.relogio.avancar(2_000);
  assert.deepEqual(textos(), ["<i>Segunda</i> fala\ncom duas linhas"]);

  // Pausar congela o relógio: a fala não sai sozinha.
  await player.pause();
  const aposPausar = emitidos();
  ambiente.relogio.avancar(60_000);
  assert.equal(emitidos(), aposPausar);
  assert.deepEqual(textos(), ["<i>Segunda</i> fala\ncom duas linhas"]);

  // Buscar muda o ponto; tocar de novo retoma de lá.
  await player.seek(20.5);
  assert.deepEqual(textos(), ["Terceira"]);
  await player.play();
  ambiente.relogio.avancar(1_600);
  assert.deepEqual(textos(), []);

  // Buffering para o relógio junto com a imagem.
  ambiente.deCasca({ cebola: "avplay:evento", tipo: "buffer", valor: "inicio" });
  ambiente.relogio.avancar(60_000);
  ambiente.deCasca({ cebola: "avplay:evento", tipo: "buffer", valor: "fim" });
  assert.deepEqual(textos(), []);
  await player.seek(1.5);
  assert.deepEqual(textos(), ["Primeira fala"]);

  // Desligar: avisa `[]`, silencia o AVPlay e para o relógio.
  await player.selectSubtitleTrack(null);
  assert.deepEqual(cues.at(-1), []);
  assert.deepEqual(ultima(ambiente, "legenda")?.args, { index: null });
  assert.equal(player.state().subtitleTrackId, null);
  assert.equal(ambiente.relogio.ativos, 0);
});

test("legenda externa que falha ao baixar (ou vem vazia) rejeita e deixa a anterior como está", async () => {
  const ambiente = instalar({ busca: "?casca=1", pai: cascaFalsa() });
  const vazia = { ...EXTERNA, id: "os:vazia", url: "https://api.example/vazia.vtt" };
  const quebrada = { ...EXTERNA, id: "os:fora", url: "https://api.example/fora.vtt" };
  const { player } = criar(ambiente, { [EXTERNA.url]: VTT, [vazia.url]: "WEBVTT\n" });
  await player.load(fonte({ subtitles: [EXTERNA, vazia, quebrada] }));
  await player.selectSubtitleTrack("os:123");
  await assert.rejects(player.selectSubtitleTrack("os:vazia"), /vazia/);
  await assert.rejects(player.selectSubtitleTrack("os:fora"), /não conseguiu abrir esta legenda/);
  assert.equal(player.state().subtitleTrackId, "os:123");
});

test("defaultSubtitleId externo é aplicado depois de tocar; se falhar, o vídeo segue sem legenda", async () => {
  const ambiente = instalar({ busca: "?casca=1", pai: cascaFalsa() });
  const { player, cues } = criar(ambiente, { [EXTERNA.url]: VTT });
  await player.load(fonte({ startAtSeconds: 1, subtitles: [EXTERNA], defaultSubtitleId: EXTERNA.id }));
  assert.equal(player.state().subtitleTrackId, "os:123");
  assert.deepEqual(cues.at(-1)?.map((c) => c.text), ["Primeira fala"]);
  assert.ok(operacoes(ambiente).indexOf("tocar") < operacoes(ambiente).lastIndexOf("legenda"));

  const sem = instalar({ busca: "?casca=1", pai: cascaFalsa() });
  const outro = criar(sem, {});
  await outro.player.load(fonte({ subtitles: [EXTERNA], defaultSubtitleId: EXTERNA.id }));
  assert.equal(outro.player.state().loaded, true);
  assert.equal(outro.player.state().subtitleTrackId, null);
});

test("addExternalSubtitles: aceita legenda tardia, avisa a interface e aplica a padrão se nada está ligado", async () => {
  const ambiente = instalar({ busca: "?casca=1", pai: cascaFalsa() });
  const { player } = criar(ambiente, { [EXTERNA.url]: VTT });
  let avisos = 0;
  player.on("tracksChanged", () => { avisos += 1; });
  await player.load(fonte());
  await ambiente.esvaziar();
  const antes = avisos;
  await player.addExternalSubtitles([EXTERNA], EXTERNA.id);
  assert.equal(avisos, antes + 1);
  assert.equal(player.state().subtitleTrackId, "os:123");
  assert.ok((await player.subtitleTracks()).some((t) => t.id === "os:123"));
});

test("setSubtitleTiming: atraso e duração extra mudam as falas da legenda externa na hora", async () => {
  const ambiente = instalar({ busca: "?casca=1", pai: cascaFalsa() });
  const { player, cues } = criar(ambiente, { [EXTERNA.url]: VTT });
  await player.load(fonte({ startAtSeconds: 0, subtitles: [EXTERNA] }));
  await player.selectSubtitleTrack("os:123");
  await player.seek(1.5);
  const textos = () => cues.at(-1)?.map((c) => c.text) ?? [];
  assert.deepEqual(textos(), ["Primeira fala"]);

  player.setSubtitleTiming(2, 0);
  assert.deepEqual(textos(), [], "com 2 s de atraso a primeira fala só entra em 3 s");
  ambiente.deCasca({ cebola: "avplay:evento", tipo: "posicao", valor: 3_000 });
  ambiente.relogio.avancar(100);
  assert.deepEqual(textos(), ["Primeira fala"]);

  player.setSubtitleTiming(0, 2);
  await player.seek(4);
  assert.deepEqual(textos(), ["Primeira fala"], "a duração extra a mantém até 5 s");
  await player.seek(5);
  assert.deepEqual(textos(), ["<i>Segunda</i> fala\ncom duas linhas"]);

  player.setSubtitleTiming(Number.NaN, -3);
  await player.seek(1.5);
  assert.deepEqual(textos(), ["Primeira fala"], "valores inválidos viram zero");
});

test("destroy: manda `parar` antes de qualquer limpeza, para os timers e ignora eventos tardios", async () => {
  const ambiente = instalar({ busca: "?casca=1", pai: cascaFalsa() });
  const { player, cues } = criar(ambiente, { [EXTERNA.url]: VTT });
  const posicoes: number[] = [];
  player.on("position", (s) => posicoes.push(s));
  await player.load(fonte({ startAtSeconds: 0, subtitles: [EXTERNA] }));
  await player.selectSubtitleTrack("os:123");
  assert.equal(ambiente.relogio.ativos > 0, true);

  const destruicao = player.destroy();
  assert.equal(operacoes(ambiente).at(-1), "parar", "a mensagem sai de forma síncrona");
  await destruicao;
  assert.equal(ambiente.relogio.ativos, 0);
  assert.equal(player.state().loaded, false);

  const emitidos = cues.length;
  ambiente.deCasca({ cebola: "avplay:evento", tipo: "posicao", valor: 9_000 });
  ambiente.deCasca({ cebola: "avplay:evento", tipo: "legenda", valor: { texto: "tarde", duracao: 100 } });
  ambiente.relogio.avancar(5_000);
  assert.deepEqual(posicoes, []);
  assert.equal(cues.length, emitidos);
  await player.destroy();
});

test("destroy durante o load: o load termina em silêncio, sem rejeitar", async () => {
  const ambiente = instalar({
    busca: "?casca=1",
    pai: cascaFalsa({ sobrescrever: (op) => op === "abrir" ? [] : undefined })
  });
  const { player } = criar(ambiente);
  let rejeitou = false;
  const carga = player.load(fonte()).catch(() => { rejeitou = true; });
  await ambiente.esvaziar();
  await player.destroy();
  ambiente.relogio.avancar(31_000);
  await carga;
  assert.equal(rejeitou, false);
});
