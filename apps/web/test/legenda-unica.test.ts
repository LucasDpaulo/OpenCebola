import assert from "node:assert/strict";
import test from "node:test";
import { CapacitorPlayer } from "../app/player/capacitor-player.js";
import { FakePlayer } from "../app/player/fake-player.js";
import type { NativePlayer, PlayerSource } from "../app/player/native-player.js";
import { TauriPlayer } from "../app/player/tauri-player.js";

// Contrato do NativePlayer: depois de selectSubtitleTrack só a faixa pedida fica ativa (ou nenhuma),
// embutida ou externa, mesmo quando o motor liga outra sozinho depois do play.

interface FaixaFalsa { id: string; kind: "audio" | "subtitle"; selected: boolean; streamIndex: number; label: string }

/** Controlador falso que imita a biblioteca: externa desliga as embutidas; `undefined` desliga todas. */
function criarControlador(externas: string[], embutidas: string[]) {
  const tracks: FaixaFalsa[] = [...embutidas, ...externas].map((id, index) => (
    { id, kind: "subtitle", selected: false, streamIndex: index, label: id }
  ));
  const ouvintes = new Map<string, ((evento: { detail: unknown }) => void)[]>();
  const chamadas: Array<string | undefined> = [];
  const controlador = {
    tracks,
    media: { durationSeconds: 1500, tracks },
    sessionId: "falso",
    chamadas,
    on(tipo: string, ouvinte: (evento: { detail: unknown }) => void) {
      ouvintes.set(tipo, [...(ouvintes.get(tipo) ?? []), ouvinte]);
      return () => ouvintes.set(tipo, (ouvintes.get(tipo) ?? []).filter((item) => item !== ouvinte));
    },
    emitir(tipo: string, detail: unknown) {
      for (const ouvinte of ouvintes.get(tipo) ?? []) ouvinte({ detail });
    },
    async selectTrack(kind: string, id?: string) {
      assert.equal(kind, "subtitle");
      chamadas.push(id);
      const ehExterna = id !== undefined && externas.includes(id);
      for (const faixa of tracks) {
        if (ehExterna && !externas.includes(faixa.id)) faixa.selected = false;
        else faixa.selected = faixa.id === id;
      }
    },
    async play() {
      // O motor liga a legenda padrão do MKV depois do play, sem avisar.
      const padrao = tracks.find((faixa) => embutidas.includes(faixa.id));
      if (padrao) padrao.selected = true;
      controlador.emitir("timeupdate", { currentTime: 1 });
    },
    pause() {},
    async seek() {},
    async setVolume() {},
    async destroy() {}
  };
  return controlador;
}

async function aguardar(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function abrir(escolha: string | null, extras: { externas?: string[]; embutidas?: string[] } = {}) {
  const externas = extras.externas ?? ["externa"];
  const controlador = criarControlador(externas, extras.embutidas ?? ["mkv-padrao", "mkv-outra"]);
  const original = { window: globalThis.window, document: globalThis.document };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => ({}) } });
  const elemento = { muted: false, volume: 1 } as unknown as HTMLVideoElement;
  const player = new TauriPlayer(elemento, { attach: async () => controlador } as never, async () => "WEBVTT\n\n00:00:01.000 --> 00:00:09.000\nFala externa\n");
  const fonte: PlayerSource = {
    url: "https://media.example/ep.mkv",
    startAtSeconds: 0,
    subtitles: externas.map((id) => ({ id, label: id, language: "pt-BR", url: `https://media.example/${id}.vtt` })),
    defaultSubtitleId: escolha
  };
  const restaurar = () => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: original.window });
    Object.defineProperty(globalThis, "document", { configurable: true, value: original.document });
  };
  try {
    await player.load(fonte);
    await aguardar();
  } catch (erro) {
    restaurar();
    throw erro;
  }
  return { player, controlador, restaurar };
}

const ativas = (controlador: ReturnType<typeof criarControlador>) =>
  controlador.tracks.filter((faixa) => faixa.selected).map((faixa) => faixa.id);

test("TauriPlayer: externa escolhida desliga a embutida que o motor ligou depois do play", async () => {
  const { player, controlador, restaurar } = await abrir("externa");
  try {
    assert.deepEqual(ativas(controlador), []);
  } finally {
    await player.destroy();
    restaurar();
  }
});

test("TauriPlayer: escolha 'nenhuma' desliga a embutida que o motor ligou", async () => {
  const { player, controlador, restaurar } = await abrir(null);
  try {
    assert.deepEqual(ativas(controlador), []);
  } finally {
    await player.destroy();
    restaurar();
  }
});

test("TauriPlayer: embutida escolhida vence a que o motor ligou", async () => {
  const { player, controlador, restaurar } = await abrir("mkv-outra");
  try {
    assert.deepEqual(ativas(controlador), ["mkv-outra"]);
  } finally {
    await player.destroy();
    restaurar();
  }
});

test("TauriPlayer: o motor ligando uma embutida no meio do vídeo também é corrigido", async () => {
  const { player, controlador, restaurar } = await abrir("externa");
  try {
    controlador.tracks[0]!.selected = true;
    controlador.emitir("timeupdate", { currentTime: 30 });
    await aguardar();
    assert.deepEqual(ativas(controlador), []);
  } finally {
    await player.destroy();
    restaurar();
  }
});

test("TauriPlayer: sem divergência não chama selectTrack de novo", async () => {
  const { player, controlador, restaurar } = await abrir("externa");
  try {
    const antes = controlador.chamadas.length;
    controlador.emitir("timeupdate", { currentTime: 10 });
    controlador.emitir("timeupdate", { currentTime: 11 });
    await aguardar();
    assert.equal(controlador.chamadas.length, antes);
    await player.selectSubtitleTrack("mkv-padrao");
    await aguardar();
    assert.deepEqual(ativas(controlador), ["mkv-padrao"]);
    assert.equal(controlador.chamadas.length, antes + 1);
  } finally {
    await player.destroy();
    restaurar();
  }
});

async function verificarContrato(player: NativePlayer, a: string, b: string) {
  await player.selectSubtitleTrack(a);
  assert.equal(player.state().subtitleTrackId, a);
  await player.selectSubtitleTrack(b);
  assert.equal(player.state().subtitleTrackId, b);
  await player.selectSubtitleTrack(null);
  assert.equal(player.state().subtitleTrackId, null);
}

test("contrato: FakePlayer deixa só a última legenda escolhida, ou nenhuma", async () => {
  const player = new FakePlayer({ subtitleTracks: [
    { id: "a", label: "A", language: null }, { id: "b", label: "B", language: null }
  ] });
  await player.load({ url: "x", startAtSeconds: 0, subtitles: [] });
  await verificarContrato(player, "a", "b");
});

test("contrato: CapacitorPlayer deixa só a última legenda escolhida, ou nenhuma", async () => {
  const original = globalThis.window;
  let selecionada = -1;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setInterval: () => 1,
      clearInterval: () => undefined,
      Capacitor: { isNativePlatform: () => true, Plugins: { Player: {
        load: async () => undefined,
        stop: async () => undefined,
        tracks: async () => ({
          audio: [], subtitle: [{ id: 4, nome: "A" }, { id: 5, nome: "B" }],
          audioSelecionada: -1, subtitleSelecionada: selecionada
        }),
        selectTrack: async ({ id }: { id: number }) => { selecionada = id; return { ok: true }; }
      } } }
    }
  });
  try {
    const player = new CapacitorPlayer();
    await player.load({ url: "https://media.example/ep.mkv", startAtSeconds: 0, subtitles: [] });
    await verificarContrato(player, "4", "5");
    assert.equal(selecionada, -1);
    await player.selectSubtitleTrack("4");
    await player.selectSubtitleTrack("5");
    assert.equal(selecionada, 5);
    await player.destroy();
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: original });
  }
});

// ---- TizenBridgePlayer (TV Samsung pela casca): a TELA desenha as duas legendas -------------------

const UA_TIZEN_LU = "Mozilla/5.0 (SMART-TV; Linux; Tizen 8.0) AppleWebKit/537.36 Chrome/120.0.0.0 TV Safari/537.36";
const VTT_LU = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:09.000\nFala externa\n";
const FAIXAS_LU = [
  { index: 1, tipo: "AUDIO", info: { language: "por" } },
  { index: 3, tipo: "TEXT", info: { language: "por" } },
  { index: 4, tipo: "TEXT", info: { language: "eng" } }
];

/** Ambiente mínimo: o pai (casca) responde às operações e guarda o que o AVPlay "ligaria". */
function ambienteBridge() {
  const ouvintes = new Set<(evento: { source: unknown; data: unknown }) => void>();
  const operacoes: Array<{ op: string; args: Record<string, unknown> }> = [];
  const pai = {
    postMessage(mensagem: Record<string, unknown>) {
      const respostas: Record<string, unknown>[] = [];
      if (mensagem.cebola === "ola") respostas.push({ cebola: "casca", versao: 1, avplay: true });
      if (mensagem.cebola === "avplay") {
        operacoes.push({ op: String(mensagem.op), args: (mensagem.args ?? {}) as Record<string, unknown> });
        const valor = mensagem.op === "abrir" ? { duracao: 7_200_000, faixas: FAIXAS_LU }
          : mensagem.op === "faixas" ? { faixas: FAIXAS_LU, atuais: [] } : null;
        respostas.push({ cebola: "avplay:resposta", id: mensagem.id, ok: true, valor });
      }
      for (const resposta of respostas) queueMicrotask(() => { for (const o of [...ouvintes]) o({ source: pai, data: resposta }); });
    }
  };
  const janela: Record<string, unknown> = {
    location: { search: "?casca=1" },
    sessionStorage: { getItem: () => null, setItem: () => undefined },
    addEventListener: (tipo: string, o: (evento: { source: unknown; data: unknown }) => void) => { if (tipo === "message") ouvintes.add(o); },
    removeEventListener: (tipo: string, o: (evento: { source: unknown; data: unknown }) => void) => { if (tipo === "message") ouvintes.delete(o); },
    setTimeout, clearTimeout
  };
  janela.parent = pai;
  const originais = {
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    document: Object.getOwnPropertyDescriptor(globalThis, "document")
  };
  Object.defineProperty(globalThis, "window", { value: janela, configurable: true, writable: true });
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: UA_TIZEN_LU }, configurable: true });
  Object.defineProperty(globalThis, "document", {
    value: { documentElement: { classList: { add: () => undefined } } }, configurable: true, writable: true
  });
  return {
    operacoes,
    legendaDaCasca: () => operacoes.filter((o) => o.op === "legenda").at(-1)?.args.index,
    eventoLegenda: (texto: string) => { for (const o of [...ouvintes]) o({ source: pai, data: { cebola: "avplay:evento", tipo: "legenda", valor: { texto, duracao: 60_000 } } }); },
    posicao: (ms: number) => { for (const o of [...ouvintes]) o({ source: pai, data: { cebola: "avplay:evento", tipo: "posicao", valor: ms } }); },
    restaurar() {
      for (const nome of ["window", "navigator", "document"] as const) {
        const original = originais[nome];
        if (original) Object.defineProperty(globalThis, nome, original); else delete (globalThis as Record<string, unknown>)[nome];
      }
    }
  };
}

async function abrirBridge() {
  const [{ TizenBridgePlayer }, { reiniciarCascaParaTeste }] = await Promise.all([
    import("../app/player/tizen-bridge-player.js"), import("../app/tv/tizen-casca.js")
  ]);
  const ambiente = ambienteBridge();
  reiniciarCascaParaTeste();
  // Relógio falso parado: quem anda é o `tique()`, que roda a repetição da legenda externa.
  const repeticoes = new Set<() => void>();
  const tique = () => { for (const acao of [...repeticoes]) acao(); };
  const player = new TizenBridgePlayer({
    relogio: {
      agora: () => 0,
      repetir: (acao) => { repeticoes.add(acao); return () => { repeticoes.delete(acao); }; },
      depois: () => () => undefined
    },
    buscarTexto: async () => VTT_LU
  });
  const cues: string[][] = [];
  player.on("subtitleCues", (lista) => cues.push(lista.map((c) => c.text)));
  await player.load({
    url: "https://media.example/ep.mkv", startAtSeconds: 0,
    subtitles: [{ id: "ext", label: "Externa", language: "pt-BR", url: "https://media.example/ext.vtt" }]
  });
  const sair = async () => { await player.destroy(); reiniciarCascaParaTeste(); ambiente.restaurar(); };
  return { player, ambiente, cues, tique, sair };
}

test("contrato: TizenBridgePlayer troca embutida e externa sem as duas aparecerem juntas", async () => {
  const { player, ambiente, cues, tique, sair } = await abrirBridge();
  try {
    // Embutida: o AVPlay manda o texto e a tela mostra.
    await player.selectSubtitleTrack("3");
    assert.equal(ambiente.legendaDaCasca(), 3);
    ambiente.eventoLegenda("Fala embutida");
    assert.deepEqual(cues.at(-1), ["Fala embutida"]);

    // Externa depois de embutida: o AVPlay fica mudo e a embutida some da tela.
    await player.selectSubtitleTrack("ext");
    assert.equal(ambiente.legendaDaCasca(), null);
    assert.equal(player.state().subtitleTrackId, "ext");
    assert.deepEqual(cues.at(-1), [], "a fala embutida sai da tela ao escolher a externa");

    // O AVPlay ainda emite texto da embutida: nada disso chega à tela.
    const antes = cues.length;
    ambiente.eventoLegenda("Embutida teimosa");
    assert.equal(cues.length, antes);
    ambiente.posicao(2_000);
    tique();
    assert.ok(cues.flat().every((texto) => texto !== "Embutida teimosa"));
    assert.deepEqual(cues.at(-1), ["Fala externa"]);

    // Embutida depois de externa: a externa para de ser desenhada.
    await player.selectSubtitleTrack("4");
    assert.equal(ambiente.legendaDaCasca(), 4);
    assert.deepEqual(cues.at(-1), []);
    ambiente.posicao(3_000);
    tique();
    assert.deepEqual(cues.at(-1), [], "a externa não volta sozinha");
    ambiente.eventoLegenda("Outra embutida");
    assert.deepEqual(cues.at(-1), ["Outra embutida"]);

    // null: nada desenhado, nem vindo do motor.
    await player.selectSubtitleTrack(null);
    assert.equal(player.state().subtitleTrackId, null);
    assert.deepEqual(cues.at(-1), []);
    ambiente.eventoLegenda("Depois do null");
    ambiente.posicao(4_000);
    tique();
    assert.deepEqual(cues.at(-1), []);
  } finally {
    await sair();
  }
});

// ---- TizenPlayer (WGT antigo): AVPlay na mesma janela --------------------------------------------

test("contrato: TizenPlayer deixa só a última legenda (embutida ou externa), ou nenhuma", async () => {
  const { TizenPlayer } = await import("../app/player/tizen-player.js");
  // Modelo do AVPlay: uma só legenda por vez; a última escolha (embutida ou arquivo externo) vale.
  let ativa: string | null = null;
  let muda = false;
  const avplay = {
    open: () => undefined, prepareAsync: (ok: () => void) => ok(), play: () => undefined, pause: () => undefined,
    stop: () => undefined, seekTo: () => undefined, getDuration: () => 1_000_000, getState: () => "PLAYING",
    getTotalTrackInfo: () => [{ index: 3, type: "TEXT" as const }, { index: 4, type: "TEXT" as const }],
    setSelectTrack: (_tipo: "AUDIO" | "TEXT", index: number) => { ativa = `embutida:${index}`; },
    setDisplayRect: () => undefined,
    setExternalSubtitlePath: (url: string) => { ativa = `externa:${url}`; },
    setSilentSubtitle: (silencio: boolean) => { muda = silencio; },
    setListener: () => undefined
  };
  const visivel = () => (muda ? null : ativa);
  const player = new TizenPlayer(avplay);
  await player.load({
    url: "https://media.example/ep.mkv", startAtSeconds: 0,
    subtitles: [{ id: "ext", label: "Externa", language: "pt-BR", url: "https://media.example/ext.vtt" }]
  });
  await player.selectSubtitleTrack("3");
  assert.equal(visivel(), "embutida:3");
  await player.selectSubtitleTrack("external:ext");
  assert.equal(visivel(), "externa:https://media.example/ext.vtt");
  assert.equal(player.state().subtitleTrackId, "external:ext");
  await player.selectSubtitleTrack("4");
  assert.equal(visivel(), "embutida:4");
  assert.equal(player.state().subtitleTrackId, "4");
  await player.selectSubtitleTrack(null);
  assert.equal(visivel(), null);
  assert.equal(player.state().subtitleTrackId, null);
});

// ---- BrowserPlayer (Vidstack) ---------------------------------------------------------------------

test("contrato: BrowserPlayer deixa só a faixa pedida em 'showing', ou todas 'disabled'", async () => {
  const { BrowserPlayer } = await import("../app/player/browser-player.js");
  const faixa = (id: string) => ({
    id, kind: "subtitles", mode: "disabled",
    setMode(modo: string) { this.mode = modo; }
  });
  const faixas = [faixa("a"), faixa("b"), faixa("c")];
  const instancia = { textTracks: faixas } as never;
  const player = new BrowserPlayer(() => instancia);
  const modos = () => faixas.map((f) => f.mode);

  await player.selectSubtitleTrack("a");
  assert.deepEqual(modos(), ["showing", "disabled", "disabled"]);
  await player.selectSubtitleTrack("b");
  assert.deepEqual(modos(), ["disabled", "showing", "disabled"]);
  await player.selectSubtitleTrack(null);
  assert.deepEqual(modos(), ["disabled", "disabled", "disabled"]);
});

test("PC: sincronia externa muda imediatamente e metadados tardios atualizam o menu", async () => {
  const { player, controlador, restaurar } = await abrir("externa");
  try {
    let cues: readonly { text: string }[] = [];
    player.on("subtitleCues", (value) => { cues = value; });
    controlador.emitir("timeupdate", { currentTime: 0.5 });
    await player.setSubtitleTiming(-0.5, 0);
    assert.equal(cues[0]?.text, "Fala externa");
    await player.setSubtitleTiming(1, 0);
    assert.equal(cues.length, 0);
    controlador.emitir("timeupdate", { currentTime: 2.1 });
    assert.equal(cues[0]?.text, "Fala externa");
    assert.equal(player.subtitleSettingsSupport(), "all");
    await player.selectSubtitleTrack("mkv-outra");
    assert.equal(cues.length, 0);
    assert.equal(player.subtitleSettingsSupport(), "timing");
    let changes = 0;
    player.on("tracksChanged", () => { changes++; });
    controlador.tracks[0]!.label = "Português (Brasil)";
    controlador.emitir("timeupdate", { currentTime: 3 });
    assert.equal(changes, 1);
  } finally { await player.destroy(); restaurar(); }
});

test("Android: legenda externa recebe ajustes e conserva o ID quando o VLC está sem legenda", async () => {
  const original = globalThis.window;
  let tick: (() => void) | undefined;
  let position = 2_100;
  let selected = -1;
  const delays: number[] = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setInterval: (callback: () => void) => { tick = callback; return 1; }, clearInterval: () => {},
    Capacitor: { isNativePlatform: () => true, Plugins: { Player: {
      load: async () => {}, stop: async () => {},
      setSubtitleDelay: async ({ seconds }: { seconds: number }) => { delays.push(seconds); },
      selectTrack: async ({ id }: { id: number }) => { selected = id; return { ok: true }; },
      tracks: async () => ({ audio: [], subtitle: [{ id: 3, nome: "Track 1", idioma: "por" }], subtitleSelecionada: selected, audioSelecionada: -1 }),
      status: async () => ({ posicaoMs: position, duracaoMs: 100_000, tocando: true })
    } } }
  } });
  const player = new CapacitorPlayer(async () => "WEBVTT\n\n00:00:02.000 --> 00:00:03.000\nOlá");
  try {
    let cues: readonly { text: string }[] = [];
    player.on("subtitleCues", (value) => { cues = value; });
    await player.load({ url: "video", startAtSeconds: 0, subtitles: [{ id: "ext", label: "Português", language: "pt", url: "legenda" }], defaultSubtitleId: "ext" });
    tick?.(); await aguardar();
    assert.equal(cues[0]?.text, "Olá");
    await player.setSubtitleTiming(0.5, 0);
    assert.equal(cues.length, 0);
    position = 2_600; tick?.(); await aguardar();
    assert.equal(cues[0]?.text, "Olá");
    const tracks = await player.subtitleTracks();
    assert.equal(player.state().subtitleTrackId, "ext");
    assert.equal(tracks[1]?.language, "por");
    assert.match(tracks[1]!.label, /^Português/);
    assert.equal(selected, -1);
    await player.selectSubtitleTrack("3");
    assert.equal(cues.length, 0);
    assert.equal(delays.at(-1), 0.5);
    await player.setSubtitleTiming(-0.1, 0);
    assert.equal(delays.at(-1), -0.1);
  } finally { await player.destroy(); Object.defineProperty(globalThis, "window", { configurable: true, value: original }); }
});
