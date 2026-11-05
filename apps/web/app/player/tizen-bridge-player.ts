import { apiFetch, apiUrl } from "../api-client";
import { aguardarCasca, aoEventoCasca, enviarCasca, iniciarCasca, type EventoCasca } from "../tv/tizen-casca";
import type {
  NativePlayer, PlayerCapabilities, PlayerEvents, PlayerListener, PlayerSource, PlayerState, PlayerTrack
} from "./native-player";
import { normalizedTrackLanguage } from "./subtitle-selection";
import { falasAtivasEm, limparTextoDeLegenda, parseVttCues } from "./subtitle-cues";
export { falasAtivasEm, limparTextoDeLegenda, parseVttCues } from "./subtitle-cues";

/**
 * Player da TV Samsung quando o site roda DENTRO da casca (apps/tizen/www): o AVPlay só existe na
 * janela da casca, então cada operação vira uma mensagem (`tizen-casca.ts`) e a casca a executa.
 * O contrato com o resto da interface é o mesmo do `TizenPlayer` local e do `CapacitorPlayer` —
 * inclusive os IDs de legenda externa (o próprio `id` da API, sem prefixo) e os de faixa do
 * arquivo (o índice do AVPlay em texto), que é o que a restauração do cenário salvo e a
 * continuidade entre episódios (title-experience.tsx) esperam.
 */

type FaixaCasca = { readonly index: number; readonly tipo: string; readonly info: Readonly<Record<string, unknown>> };

/** Uma fala de legenda externa, em segundos do vídeo. */
export interface FalaLegenda {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

type CueDeTexto = { readonly id: string; readonly text: string };

/**
 * Tempo e temporizadores do bridge, injetáveis: a legenda externa depende de um relógio local, e
 * o teste precisa andar com ele sem esperar tempo de verdade.
 */
export interface RelogioBridge {
  /** Milissegundos monotônicos o bastante para medir poucos segundos. */
  agora(): number;
  repetir(acao: () => void, intervaloMs: number): () => void;
  depois(acao: () => void, esperaMs: number): () => void;
}

const relogioReal: RelogioBridge = {
  agora: () => Date.now(),
  repetir: (acao, intervaloMs) => {
    const id = window.setInterval(acao, intervaloMs);
    return () => window.clearInterval(id);
  },
  depois: (acao, esperaMs) => {
    const id = window.setTimeout(acao, esperaMs);
    return () => window.clearTimeout(id);
  }
};

export interface OpcoesTizenBridge {
  readonly relogio?: RelogioBridge;
  /** Baixa o texto de uma legenda externa (VTT da API). */
  readonly buscarTexto?: (url: string) => Promise<string>;
}

// Mesma regra de `fetchSubtitleText` em title-experience.tsx: URL da nossa API leva a credencial
// da sessão (`apiFetch`); qualquer outra é buscada direto, sem nada nosso.
const ORIGEM_DA_API = apiUrl("");
const LIMITE_BUSCA_LEGENDA_MS = 10_000;

async function buscarTextoDaLegenda(url: string): Promise<string> {
  const controle = new AbortController();
  const limite = window.setTimeout(() => controle.abort(), LIMITE_BUSCA_LEGENDA_MS);
  try {
    const resposta = url.startsWith(ORIGEM_DA_API)
      ? await apiFetch(url.slice(ORIGEM_DA_API.length), { signal: controle.signal, headers: { Accept: "text/vtt" } })
      : await fetch(url, { signal: controle.signal });
    if (!resposta.ok) throw new Error(`legenda respondeu ${resposta.status}`);
    return await resposta.text();
  } finally {
    window.clearTimeout(limite);
  }
}

// O ritmo da legenda externa: o AVPlay só informa a posição umas 4 vezes por segundo, e uma fala
// que entra ou sai com mais de ~100 ms de atraso já se nota. Só gira com legenda externa ativa.
const INTERVALO_LEGENDA_MS = 100;
// Fala interna sem duração informada pelo motor não pode ficar presa na tela.
const DURACAO_PADRAO_FALA_MS = 3_000;
const ESPERA_ABRIR_MS = 30_000;
const ESPERA_BUSCAR_MS = 8_000;


let nomesDeIdioma: Intl.DisplayNames | null | undefined;
function nomesDosIdiomas(): Intl.DisplayNames | null {
  if (nomesDeIdioma !== undefined) return nomesDeIdioma;
  try {
    nomesDeIdioma = typeof Intl !== "undefined" && typeof Intl.DisplayNames === "function"
      ? new Intl.DisplayNames(["pt-BR"], { type: "language" })
      : null;
  } catch {
    nomesDeIdioma = null;
  }
  return nomesDeIdioma;
}

/**
 * Nome do idioma em português a partir do código que o AVPlay informa (quase sempre ISO 639-2 de
 * três letras: "por", "eng"). `null` quando o arquivo não diz (ou diz "und"); se o navegador não
 * conhece o código, o próprio código serve.
 */
export function nomeDoIdioma(codigo: string | null): string | null {
  const limpo = codigo?.trim() ?? "";
  if (!limpo || /^(?:und|unk|zxx|mis|mul)$/i.test(limpo)) return null;
  // "por" → "pt": `Intl.DisplayNames` até aceita três letras, mas o código vira o idioma "de
  // verdade" pela mesma tabela que o resto do player usa para comparar faixas.
  const normalizado = normalizedTrackLanguage({ language: limpo, label: "" }) ?? limpo;
  try {
    const nome = nomesDosIdiomas()?.of(normalizado);
    if (nome && nome.toLowerCase() !== normalizado.toLowerCase()) {
      return nome.charAt(0).toLocaleUpperCase("pt-BR") + nome.slice(1);
    }
  } catch {
    // código que o navegador recusa: cai no próprio código.
  }
  return limpo;
}

const SUFIXO_DE_CANAIS: Readonly<Record<string, string>> = { "2": " 2.0", "6": " 5.1", "8": " 7.1" };

function idiomaDaFaixa(faixa: FaixaCasca): string | null {
  const valor = faixa.info.language ?? faixa.info.lang ?? faixa.info.track_lang;
  return typeof valor === "string" && valor.trim().length > 0 ? valor.trim() : null;
}

function lerFaixas(valor: unknown): FaixaCasca[] {
  if (!Array.isArray(valor)) return [];
  const faixas: FaixaCasca[] = [];
  for (const item of valor) {
    if (typeof item !== "object" || item === null) continue;
    const { index, tipo, info } = item as { index?: unknown; tipo?: unknown; info?: unknown };
    if (typeof index !== "number" || !Number.isInteger(index) || typeof tipo !== "string") continue;
    faixas.push({
      index,
      tipo: tipo.toUpperCase(),
      info: typeof info === "object" && info !== null ? info as Record<string, unknown> : {}
    });
  }
  return faixas;
}

function assinaturaDeFaixas(faixas: readonly FaixaCasca[]): string {
  return faixas.map((faixa) => `${faixa.tipo}${faixa.index}:${idiomaDaFaixa(faixa) ?? ""}`).join("|");
}

/** Mensagem curta e sem URL para a tela e o registro de erros (o token do debrid vai na URL). */
function erroCurto(contexto: string, causa: unknown): Error {
  const detalhe = causa instanceof Error ? causa.message : String(causa);
  return new Error(`${contexto}: ${detalhe}`.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]").slice(0, 160));
}

const estadoInicial = (): PlayerState => ({
  loaded: false, playing: false, positionSeconds: 0, durationSeconds: 0,
  audioTrackId: null, subtitleTrackId: null
});

export class TizenBridgePlayer implements NativePlayer {
  readonly #ouvintes = new Map<keyof PlayerEvents, Set<(dado: never) => void>>();
  readonly #relogio: RelogioBridge;
  readonly #buscarTexto: (url: string) => Promise<string>;
  #estado: PlayerState = estadoInicial();
  #faixas: FaixaCasca[] = [];
  #externas: PlayerSource["subtitles"] = [];
  readonly #falasPorLegenda = new Map<string, readonly FalaLegenda[]>();
  #destruido = false;
  #desinscrever: (() => void) | null = null;
  #audioEscolhido = false;

  // Legenda: só UMA origem desenha por vez. `#internaAtiva` (faixa do arquivo, texto vem por
  // evento) ou `#falasExternas` (arquivo baixado, desenhado pelo relógio local).
  #internaAtiva = false;
  #falasExternas: readonly FalaLegenda[] | null = null;
  #deslocamento = 0;
  #duracaoExtra = 0;
  #versaoSelecao = 0;
  #sequenciaInterna = 0;
  #chaveDasCues = "";
  #cancelarFalaInterna: (() => void) | null = null;
  #cancelarRepeticao: (() => void) | null = null;

  // Relógio local da legenda externa: última posição do AVPlay + o tempo que passou desde ela,
  // enquanto o vídeo anda. A posição só chega ~4×/s; sem isto a fala entraria em saltos.
  #ancora = 0;
  #ancoraEm = 0;
  #andando = false;
  #carregando = false;

  constructor(opcoes: OpcoesTizenBridge = {}) {
    this.#relogio = opcoes.relogio ?? relogioReal;
    this.#buscarTexto = opcoes.buscarTexto ?? buscarTextoDaLegenda;
  }

  async load(source: PlayerSource): Promise<void> {
    iniciarCasca();
    if (await aguardarCasca() !== "com-avplay") {
      if (this.#destruido) return;
      throw new Error("A TV não tem AVPlay disponível.");
    }
    if (this.#destruido) return;
    this.#externas = source.subtitles;
    this.#falasPorLegenda.clear();
    this.#desligarLegenda();
    this.#audioEscolhido = false;
    this.#desinscrever?.();
    this.#desinscrever = aoEventoCasca((evento) => this.#aoEvento(evento));

    const inicio = Number.isFinite(source.startAtSeconds) ? Math.max(0, source.startAtSeconds) : 0;
    let aberto: { duracao?: unknown; faixas?: unknown } | null;
    try {
      aberto = await enviarCasca("abrir", { url: source.url, inicio }, ESPERA_ABRIR_MS) as typeof aberto;
    } catch (erro) {
      if (this.#destruido) return;
      throw erroCurto("O player da TV não abriu esta fonte", erro);
    }
    if (this.#destruido) return;

    this.#faixas = lerFaixas(aberto?.faixas);
    const duracaoMs = typeof aberto?.duracao === "number" && aberto.duracao > 0 ? aberto.duracao : 0;
    const primeiroAudio = this.#faixas.find((faixa) => faixa.tipo === "AUDIO");
    this.#estado = {
      ...estadoInicial(),
      loaded: true,
      playing: true,
      positionSeconds: inicio,
      durationSeconds: Math.round(duracaoMs / 1000),
      audioTrackId: primeiroAudio ? String(primeiroAudio.index) : null
    };
    this.#reancorar(inicio);
    this.#emitir("ready", this.state());
    try {
      await this.#tocar();
    } catch (erro) {
      if (this.#destruido) return;
      throw erroCurto("O player da TV não começou a tocar", erro);
    }
    // O AVPlay só diz qual áudio escolheu por conta própria depois que toca; sem isso a interface
    // não saberia qual faixa marcar nem se já está no idioma original.
    void this.#atualizarFaixas();
    if (source.defaultSubtitleId) {
      // Falha de legenda não é falha do vídeo: ele já toca, e derrubar o load mandaria a fonte
      // para o player do navegador à toa.
      try { await this.selectSubtitleTrack(source.defaultSubtitleId); } catch { /* segue sem legenda */ }
    }
  }

  async play(): Promise<void> {
    await this.#tocar();
  }

  async pause(): Promise<void> {
    await enviarCasca("pausar");
    this.#reancorar();
    this.#andando = false;
    this.#estado = { ...this.#estado, playing: false };
  }

  async seek(seconds: number): Promise<void> {
    const alvo = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    await enviarCasca("buscar", { segundos: alvo }, ESPERA_BUSCAR_MS);
    this.#reancorar(alvo);
    this.#estado = { ...this.#estado, positionSeconds: alvo };
    this.#atualizarFalasExternas();
  }

  async audioTracks(): Promise<readonly PlayerTrack[]> {
    const audios = this.#faixas.filter((faixa) => faixa.tipo === "AUDIO");
    return audios.map((faixa, posicao) => ({
      id: String(faixa.index),
      label: `${nomeDoIdioma(idiomaDaFaixa(faixa)) ?? `Áudio ${posicao + 1}`}${SUFIXO_DE_CANAIS[String(faixa.info.channels ?? "")] ?? ""}`,
      language: idiomaDaFaixa(faixa)
    }));
  }

  async selectAudioTrack(id: string): Promise<void> {
    const index = Number(id);
    if (!Number.isInteger(index)) throw new Error("Faixa de áudio inválida.");
    await enviarCasca("audio", { index });
    this.#audioEscolhido = true;
    this.#estado = { ...this.#estado, audioTrackId: id };
  }

  async subtitleTracks(): Promise<readonly PlayerTrack[]> {
    const doArquivo = this.#faixas.filter((faixa) => faixa.tipo === "TEXT").map((faixa, posicao) => ({
      id: String(faixa.index),
      label: `${nomeDoIdioma(idiomaDaFaixa(faixa)) ?? `Legenda ${posicao + 1}`} · do arquivo`,
      language: idiomaDaFaixa(faixa)
    }));
    const externas = this.#externas.map((legenda) => ({ id: legenda.id, label: legenda.label, language: legenda.language }));
    return [...doArquivo, ...externas];
  }

  async addExternalSubtitles(subtitles: PlayerSource["subtitles"], defaultSubtitleId?: string | null): Promise<void> {
    this.#externas = subtitles;
    if (!this.#estado.loaded) return;
    this.#emitir("tracksChanged", undefined);
    if (defaultSubtitleId && this.#estado.subtitleTrackId === null) await this.selectSubtitleTrack(defaultSubtitleId);
  }

  async selectSubtitleTrack(id: string | null): Promise<void> {
    // Duas escolhas seguidas (a segunda com o download da primeira ainda em curso): só a última vale.
    const versao = ++this.#versaoSelecao;
    if (id === null) {
      await enviarCasca("legenda", { index: null });
      if (versao !== this.#versaoSelecao) return;
      this.#desligarLegenda();
      this.#publicarCues([], true);
      this.#estado = { ...this.#estado, subtitleTrackId: null };
      return;
    }

    const externa = this.#externas.find((legenda) => legenda.id === id);
    if (externa) {
      const falas = await this.#falasDe(externa);
      if (versao !== this.#versaoSelecao || this.#destruido) return;
      // O AVPlay fica mudo: quem desenha esta legenda somos nós.
      await enviarCasca("legenda", { index: null });
      if (versao !== this.#versaoSelecao || this.#destruido) return;
      this.#desligarLegenda();
      this.#falasExternas = falas;
      this.#estado = { ...this.#estado, subtitleTrackId: id };
      this.#publicarCues([], true);
      this.#atualizarFalasExternas();
      this.#cancelarRepeticao = this.#relogio.repetir(() => this.#atualizarFalasExternas(), INTERVALO_LEGENDA_MS);
      return;
    }

    const index = Number(id);
    if (!Number.isInteger(index) || !this.#faixas.some((faixa) => faixa.tipo === "TEXT" && faixa.index === index)) {
      throw new Error("Legenda desconhecida neste arquivo.");
    }
    await enviarCasca("legenda", { index });
    if (versao !== this.#versaoSelecao || this.#destruido) return;
    this.#desligarLegenda();
    this.#internaAtiva = true;
    this.#publicarCues([], true);
    this.#estado = { ...this.#estado, subtitleTrackId: id };
  }

  setSubtitleTiming(offsetSeconds: number, extraDurationSeconds: number): void {
    this.#deslocamento = Number.isFinite(offsetSeconds) ? offsetSeconds : 0;
    this.#duracaoExtra = Number.isFinite(extraDurationSeconds) ? Math.max(0, extraDurationSeconds) : 0;
    this.#atualizarFalasExternas();
  }

  async capabilities(): Promise<PlayerCapabilities> {
    // Mesma medição do `TizenPlayer`: o decoder é o mesmo, só o caminho até ele muda.
    return { hevc: true, ac3: true, eac3: true, dts: false, mkv: true };
  }

  engine(): string { return "avplay"; }

  state(): PlayerState { return { ...this.#estado }; }

  on<E extends keyof PlayerEvents>(event: E, listener: PlayerListener<E>): () => void {
    const ouvintes = this.#ouvintes.get(event) ?? new Set();
    ouvintes.add(listener as (dado: never) => void);
    this.#ouvintes.set(event, ouvintes);
    return () => { ouvintes.delete(listener as (dado: never) => void); };
  }

  async destroy(): Promise<void> {
    if (this.#destruido) return;
    this.#destruido = true;
    // O `parar` sai antes de qualquer limpeza (a parte síncrona de uma função async roda já):
    // a mensagem do próximo `abrir` não pode passar à frente dele.
    const parada = enviarCasca("parar", {}, 3_000).catch(() => undefined);
    this.#desinscrever?.();
    this.#desinscrever = null;
    this.#desligarLegenda();
    this.#estado = estadoInicial();
    this.#andando = false;
    this.#ouvintes.clear();
    await parada;
  }

  async #tocar(): Promise<void> {
    await enviarCasca("tocar");
    this.#reancorar();
    this.#andando = true;
    this.#estado = { ...this.#estado, playing: true };
  }

  /** Posição estimada agora: a última do AVPlay mais o que passou, só enquanto o vídeo anda. */
  #posicaoLocal(): number {
    if (!this.#andando || this.#carregando) return this.#ancora;
    return this.#ancora + (this.#relogio.agora() - this.#ancoraEm) / 1000;
  }

  /** Fixa a âncora do relógio local (na posição estimada, ou numa informada) e reinicia a contagem. */
  #reancorar(segundos?: number): void {
    this.#ancora = segundos ?? this.#posicaoLocal();
    this.#ancoraEm = this.#relogio.agora();
  }

  #aoEvento(evento: EventoCasca): void {
    if (this.#destruido) return;
    switch (evento.tipo) {
      case "posicao": {
        if (typeof evento.valor !== "number" || !Number.isFinite(evento.valor)) return;
        const segundos = Math.max(0, evento.valor / 1000);
        this.#estado = { ...this.#estado, positionSeconds: segundos };
        this.#reancorar(segundos);
        this.#emitir("position", segundos);
        return;
      }
      case "fim":
        this.#reancorar();
        this.#andando = false;
        this.#estado = { ...this.#estado, playing: false };
        this.#emitir("ended", undefined);
        return;
      case "erro":
        this.#emitir("error", `O player da TV falhou: ${typeof evento.valor === "string" ? evento.valor : "erro desconhecido"}`);
        return;
      case "legenda":
        this.#aoLegendaInterna(evento.valor);
        return;
      case "buffer":
        // Vídeo parado esperando dados: o relógio da legenda externa para junto, senão ela correria
        // à frente da imagem.
        this.#reancorar();
        this.#carregando = evento.valor === "inicio";
        return;
      default:
    }
  }

  #aoLegendaInterna(valor: unknown): void {
    if (!this.#internaAtiva || typeof valor !== "object" || valor === null) return;
    const { texto, duracao } = valor as { texto?: unknown; duracao?: unknown };
    const fala = typeof texto === "string" ? limparTextoDeLegenda(texto) : "";
    this.#cancelarFalaInterna?.();
    this.#cancelarFalaInterna = null;
    if (!fala) {
      this.#publicarCues([]);
      return;
    }
    this.#publicarCues([{ id: `interna:${++this.#sequenciaInterna}`, text: fala }]);
    const duracaoMs = typeof duracao === "number" && duracao > 0 ? duracao : DURACAO_PADRAO_FALA_MS;
    this.#cancelarFalaInterna = this.#relogio.depois(() => {
      this.#cancelarFalaInterna = null;
      this.#publicarCues([]);
    }, duracaoMs);
  }

  async #falasDe(legenda: PlayerSource["subtitles"][number]): Promise<readonly FalaLegenda[]> {
    const guardadas = this.#falasPorLegenda.get(legenda.id);
    if (guardadas) return guardadas;
    let falas: readonly FalaLegenda[];
    try {
      falas = parseVttCues(await this.#buscarTexto(legenda.url));
    } catch {
      throw new Error("O player não conseguiu abrir esta legenda.");
    }
    if (falas.length === 0) throw new Error("Esta legenda veio vazia.");
    this.#falasPorLegenda.set(legenda.id, falas);
    return falas;
  }

  /** Recalcula as falas da legenda externa e só avisa a interface quando o conjunto muda. */
  #atualizarFalasExternas(): void {
    if (!this.#falasExternas || this.#destruido) return;
    this.#publicarCues(falasAtivasEm(this.#falasExternas, this.#posicaoLocal(), this.#deslocamento, this.#duracaoExtra));
  }

  /** Desliga qualquer legenda desenhada por aqui: relógio, fala interna na tela e estado. */
  #desligarLegenda(): void {
    this.#cancelarRepeticao?.();
    this.#cancelarRepeticao = null;
    this.#cancelarFalaInterna?.();
    this.#cancelarFalaInterna = null;
    this.#internaAtiva = false;
    this.#falasExternas = null;
  }

  #publicarCues(cues: readonly CueDeTexto[], forcar = false): void {
    const chave = cues.map((cue) => cue.id).join("|");
    if (!forcar && chave === this.#chaveDasCues) return;
    this.#chaveDasCues = chave;
    this.#emitir("subtitleCues", cues);
  }

  async #atualizarFaixas(): Promise<void> {
    try {
      const resposta = await enviarCasca("faixas") as { faixas?: unknown; atuais?: unknown } | null;
      if (this.#destruido || !resposta) return;
      const faixas = lerFaixas(resposta.faixas);
      const atual = lerFaixas(resposta.atuais).find((faixa) => faixa.tipo === "AUDIO");
      let mudou = false;
      if (faixas.length > 0 && assinaturaDeFaixas(faixas) !== assinaturaDeFaixas(this.#faixas)) {
        this.#faixas = faixas;
        mudou = true;
      }
      // Uma escolha da pessoa (ou do cenário salvo) feita enquanto isto voltava vale mais.
      if (atual && !this.#audioEscolhido && this.#estado.audioTrackId !== String(atual.index)) {
        this.#estado = { ...this.#estado, audioTrackId: String(atual.index) };
        mudou = true;
      }
      if (mudou) this.#emitir("tracksChanged", undefined);
    } catch {
      // Só complementa o que o `abrir` já trouxe: sem isto o vídeo continua tocando.
    }
  }

  #emitir<E extends keyof PlayerEvents>(evento: E, dado: PlayerEvents[E]): void {
    for (const ouvinte of [...(this.#ouvintes.get(evento) ?? [])]) (ouvinte as PlayerListener<E>)(dado);
  }
}
