import { ExternalSubtitleRenderer, readExternalSubtitle } from "./external-subtitle-renderer";
import { nativeTrackLabel } from "./subtitle-label";
import type {
  NativePlayer, PlayerCapabilities, PlayerChapter, PlayerEvents, PlayerListener, PlayerSource, PlayerState, PlayerTrack
} from "./native-player.js";

type FaixaNativa = { id: number; nome: string; idioma?: string };

function idiomaPeloNome(nome: string): string | null {
  const texto = nome.toLowerCase();
  if (/portugu[eê]s.*brasil|brazilian portuguese|pt[-_ ]br/.test(texto)) return "pt-BR";
  if (/portugu[eê]s|portuguese/.test(texto)) return "pt";
  if (/ingl[eê]s|english/.test(texto)) return "en";
  return null;
}

type StatusNativo = {
  tracks?: TracksNativo;
  evento: string; vout: number; tocando: boolean;
  duracaoMs: number; posicaoMs: number; faixaAudioAtual: number;
};

type TracksNativo = {
  audio: FaixaNativa[]; subtitle: FaixaNativa[];
  audioSelecionada: number; subtitleSelecionada: number;
};

type CapituloNativo = { name: string; startSeconds: number; endSeconds: number };

type PluginPlayer = {
  load(o: { url: string; startAtSeconds: number; subtitles: readonly { url: string }[]; hardware: boolean }): Promise<void>;
  setSubtitleDelay?(o: { seconds: number }): Promise<void>;
  resume(): Promise<void>;
  pause(): Promise<void>;
  seek(o: { seconds: number }): Promise<void>;
  stop(): Promise<void>;
  status(options?: { lightweight: boolean; includeTracks?: boolean }): Promise<StatusNativo>;
  tracks(): Promise<TracksNativo>;
  selectTrack(o: { type: "audio" | "subtitle"; id: number }): Promise<{ ok: boolean }>;
  chapters(): Promise<{ chapters: CapituloNativo[] }>;
  setBrightness(o: { level: number }): Promise<void>;
  toggleFullscreen(): Promise<void>;
  exitFullscreen(): Promise<void>;
};

function plugin(): PluginPlayer | null {
  if (typeof window === "undefined") return null;
  const ponte = (window as Window & {
    Capacitor?: { isNativePlatform?: () => boolean; Plugins?: { Player?: PluginPlayer } };
  }).Capacitor;
  if (ponte?.isNativePlatform?.() !== true) return null;
  return ponte.Plugins?.Player ?? null;
}

// O plugin Android é um singleton: stop() da sessão anterior precisa terminar antes de load().
let pendingNativeStop: Promise<void> = Promise.resolve();

export function nativePlayerDisponivel(): boolean {
  return plugin() !== null;
}

/**
 * Tradutor entre o contrato e o plugin. Duas conversões acontecem aqui e em nenhum outro lugar:
 * milissegundos do libVLC viram segundos, e os `id` inteiros das faixas viram texto — porque o
 * contrato é o mesmo em toda plataforma, e nem toda plataforma usa inteiro.
 */
export class CapacitorPlayer implements NativePlayer {
  readonly #listeners = new Map<keyof PlayerEvents, ((data: never) => void)[]>();
  #estado: PlayerState = {
    loaded: false, playing: false, positionSeconds: 0, durationSeconds: 0,
    audioTrackId: null, subtitleTrackId: null
  };
  #relogio: number | null = null;
  #versaoRelogio = 0;
  #sondagemEmAndamento = false;
  #legendasExternas: PlayerSource["subtitles"] = [];
  #assinaturaFaixasNativas: string | null = null;
  #destroyed = false;
  #subtitleRevision = 0;
  #subtitleOffset = 0;
  #externalActive = false;
  readonly #subtitleRenderer = new ExternalSubtitleRenderer((cues) => this.#emitir("subtitleCues", cues));

  constructor(private readonly readSubtitle = readExternalSubtitle) {}

  subtitleSettingsSupport(): "all" | "timing" {
    return this.#estado.subtitleTrackId === null || this.#externalActive ? "all" : "timing";
  }

  async setSubtitleTiming(offset: number, extra: number): Promise<void> {
    this.#subtitleOffset = Number.isFinite(offset) ? offset : 0;
    this.#subtitleRenderer.timing(offset, extra);
    if (this.#estado.loaded && !this.#externalActive && this.#estado.subtitleTrackId !== null) {
      const p = plugin();
      if (!p?.setSubtitleDelay) throw new Error("Atualize o aplicativo para ajustar o atraso desta legenda.");
      await p.setSubtitleDelay({ seconds: this.#subtitleOffset });
    }
  }


  async load(source: PlayerSource): Promise<void> {
    await pendingNativeStop;
    if (this.#destroyed) return;
    const p = plugin();
    if (!p) throw new Error("O player nativo não existe fora do app.");
    this.#desligarRelogio();
    this.#subtitleRevision++;
    this.#externalActive = false;
    this.#subtitleRenderer.clear();
    this.#subtitleRenderer.update(Math.max(0, source.startAtSeconds));
    this.#legendasExternas = source.subtitles;
    this.#assinaturaFaixasNativas = null;
    await p.load({
      url: source.url,
      startAtSeconds: Math.max(0, Math.round(source.startAtSeconds)),
      // Externas são desenhadas pela interface para receber todos os ajustes.
      subtitles: [],
      hardware: true
    });
    if (this.#destroyed) return;
    this.#estado = {
      ...this.#estado,
      loaded: true,
      playing: true,
      positionSeconds: Math.max(0, Math.round(source.startAtSeconds))
    };
    this.#ligarRelogio();
    if (source.defaultSubtitleId) await this.selectSubtitleTrack(source.defaultSubtitleId);
    this.#emitir("ready", this.#estado);
  }

  async play(): Promise<void> {
    await plugin()?.resume();
    this.#estado = { ...this.#estado, playing: true };
  }

  async pause(): Promise<void> {
    await plugin()?.pause();
    this.#estado = { ...this.#estado, playing: false };
  }

  async seek(seconds: number): Promise<void> {
    const alvo = Math.max(0, Math.round(seconds));
    await plugin()?.seek({ seconds: alvo });
    this.#estado = { ...this.#estado, positionSeconds: alvo };
    this.#subtitleRenderer.update(alvo);
  }

  async audioTracks(): Promise<readonly PlayerTrack[]> {
    const t = await plugin()?.tracks();
    if (t && t.audioSelecionada >= 0) this.#estado = { ...this.#estado, audioTrackId: String(t.audioSelecionada) };
    return (t?.audio ?? []).map((f) => ({ id: String(f.id), label: nativeTrackLabel(f.nome, f.idioma, f.id), language: f.idioma || idiomaPeloNome(f.nome) }));
  }

  async selectAudioTrack(id: string): Promise<void> {
    await plugin()?.selectTrack({ type: "audio", id: Number(id) });
    this.#estado = { ...this.#estado, audioTrackId: id };
  }

  async subtitleTracks(): Promise<readonly PlayerTrack[]> {
    const t = await plugin()?.tracks();
    if (t && !this.#externalActive) {
      this.#estado = {
        ...this.#estado,
        subtitleTrackId: t.subtitleSelecionada < 0 ? null : String(t.subtitleSelecionada)
      };
    }
    return [
      ...this.#legendasExternas.map((legenda) => ({ id: legenda.id, label: legenda.label, language: legenda.language })),
      ...(t?.subtitle ?? [])
        .map((faixa) => ({ id: String(faixa.id), label: nativeTrackLabel(faixa.nome, faixa.idioma, faixa.id), language: faixa.idioma || idiomaPeloNome(faixa.nome) }))
    ];
  }

  async addExternalSubtitles(subtitles: PlayerSource["subtitles"], defaultSubtitleId?: string | null): Promise<void> {
    this.#legendasExternas = subtitles;
    if (!this.#estado.loaded) return;
    this.#emitir("tracksChanged", undefined);
    if (defaultSubtitleId && this.#estado.subtitleTrackId === null) {
      await this.selectSubtitleTrack(defaultSubtitleId);
    }
  }

  async selectSubtitleTrack(id: string | null): Promise<void> {
    // -1 é como o libVLC desliga a legenda.
    const p = plugin();
    if (!p) return;
    const revision = ++this.#subtitleRevision;
    const external = this.#legendasExternas.find((subtitle) => subtitle.id === id);
    const text = external ? await this.readSubtitle(external.url) : null;
    if (revision !== this.#subtitleRevision || this.#destroyed) return;
    const result = await p.selectTrack({ type: "subtitle", id: external || id === null ? -1 : Number(id) });
    if (!result.ok && id !== null && !external) throw new Error("Não foi possível selecionar esta legenda.");
    if (revision !== this.#subtitleRevision || this.#destroyed) return;
    const changedRenderer = this.#externalActive !== !!external;
    this.#externalActive = !!external;
    this.#estado = { ...this.#estado, subtitleTrackId: id };
    this.#subtitleRenderer.clear();
    if (text !== null) this.#subtitleRenderer.load(text);
    else if (id !== null) await p.setSubtitleDelay?.({ seconds: this.#subtitleOffset });
    if (changedRenderer) this.#ligarRelogio();
  }

  async capabilities(): Promise<PlayerCapabilities> {
    // Medido no Redmi Note 7 em 26/08/2026, e não suposto: os cinco itens abaixo tocaram, e o
    // HEVC Main 10 em 3840x2160 saiu por hardware. Se um aparelho futuro não tocar algum, é aqui
    // que a medição dele entra — nunca uma tabela por nome de modelo.
    return { hevc: true, ac3: true, eac3: true, dts: true, mkv: true };
  }

  /**
   * Capítulos do MKV lidos pelo libVLC (`MediaPlayer.getChapters`), quando o arquivo os tem. Uma
   * instalação mais antiga do app (sem este método no plugin) rejeita a chamada — devolvemos lista
   * vazia, porque isto é só um complemento e nunca deve derrubar o player.
   */
  async chapters(): Promise<readonly PlayerChapter[]> {
    try {
      const resposta = await plugin()?.chapters();
      return (resposta?.chapters ?? []).map((capitulo) => ({
        name: capitulo.name,
        start: capitulo.startSeconds,
        end: capitulo.endSeconds
      }));
    } catch {
      return [];
    }
  }

  async setBrightness(level: number): Promise<void> {
    await plugin()?.setBrightness({ level: Math.max(0.05, Math.min(1, level)) });
  }

  async toggleFullscreen(): Promise<void> {
    await plugin()?.toggleFullscreen();
  }

  async exitFullscreen(): Promise<void> {
    await plugin()?.exitFullscreen();
  }

  state(): PlayerState { return this.#estado; }

  on<E extends keyof PlayerEvents>(event: E, listener: PlayerListener<E>): () => void {
    const callback = listener as (data: never) => void;
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), callback]);
    return () => {
      this.#listeners.set(event, (this.#listeners.get(event) ?? []).filter((current) => current !== callback));
    };
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#subtitleRevision++;
    this.#subtitleRenderer.clear();
    this.#desligarRelogio();
    pendingNativeStop = (plugin()?.stop() ?? Promise.resolve()).catch(() => undefined);
    await pendingNativeStop;
    this.#listeners.clear();
    this.#estado = { ...this.#estado, loaded: false, playing: false };
  }

  /**
   * O libVLC emite `TimeChanged` muito mais de uma vez por segundo. Perguntar o status a cada
   * segundo basta para a barra. Com legenda externa ativa, lê a posição a cada 100 ms
   * sem arredondar; metadados continuam limitados a uma leitura por segundo.
   */
  #ligarRelogio(): void {
    this.#desligarRelogio();
    const versao = this.#versaoRelogio;
    let ultimaLeituraFaixas = 0;
    this.#relogio = window.setInterval(() => {
      if (this.#sondagemEmAndamento) return;
      this.#sondagemEmAndamento = true;
      void (async () => {
        const p = plugin();
        const lerFaixas = !this.#externalActive || Date.now() - ultimaLeituraFaixas >= 1_000;
        const s = await p?.status({ lightweight: true, includeTracks: lerFaixas });
        if (!s || this.#destroyed || versao !== this.#versaoRelogio) return;
        const segundos = s.posicaoMs / 1000;
        this.#subtitleRenderer.update(segundos);
        this.#estado = {
          ...this.#estado,
          playing: s.tocando,
          positionSeconds: segundos,
          durationSeconds: Math.round(s.duracaoMs / 1000)
        };
        if (s.evento === "fim") { this.#emitir("ended", undefined); this.#desligarRelogio(); return; }
        if (s.evento === "erro") { this.#emitir("error", "O player não conseguiu abrir esta fonte."); return; }
        this.#emitir("position", segundos);
        // O libVLC pode descobrir as trilhas embutidas do MKV depois das leituras iniciais do
        // menu. Reconsulta enquanto o vídeo toca e avisa apenas quando a lista mudar.
        // APKs antigos não incluem o snapshot no status; conservam a consulta separada.
        if (!lerFaixas) return;
        ultimaLeituraFaixas = Date.now();
        const faixas = s.tracks ?? await p?.tracks();
        if (!faixas || this.#destroyed || versao !== this.#versaoRelogio) return;
        const assinatura = JSON.stringify([
          faixas.audio, faixas.subtitle, faixas.audioSelecionada, faixas.subtitleSelecionada
        ]);
        if (assinatura !== this.#assinaturaFaixasNativas) {
          this.#assinaturaFaixasNativas = assinatura;
          this.#emitir("tracksChanged", undefined);
        }
      })().catch(() => undefined).finally(() => {
        if (versao === this.#versaoRelogio) this.#sondagemEmAndamento = false;
      });
    }, this.#externalActive ? 100 : 1_000);
  }

  #desligarRelogio(): void {
    this.#versaoRelogio += 1;
    this.#sondagemEmAndamento = false;
    if (this.#relogio !== null) window.clearInterval(this.#relogio);
    this.#relogio = null;
  }

  #emitir<E extends keyof PlayerEvents>(event: E, data: PlayerEvents[E]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      (listener as PlayerListener<E>)(data);
    }
  }
}
