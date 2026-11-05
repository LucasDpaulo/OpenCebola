import { ExternalSubtitleRenderer, readExternalSubtitle } from "./external-subtitle-renderer";
import { nativeTrackLabel } from "./subtitle-label";
import type { MediaTrack, VideoClient, VideoController } from "@get-air/video-tauri";
import type {
  NativePlayer, PlayerCapabilities, PlayerChapter, PlayerEvents, PlayerListener, PlayerSource, PlayerState, PlayerTrack
} from "./native-player.js";

function runtimeTauri(): boolean {
  if (typeof window === "undefined") return false;
  const bridge = window as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return bridge.__TAURI_INTERNALS__ !== undefined || bridge.__TAURI__ !== undefined;
}

// `numero` é a posição entre as faixas do MESMO tipo. O índice no arquivo contava o vídeo e as
// outras faixas: o único áudio de um MKV aparecia como "Faixa 2", parecendo faltar a 1.
function track(track: MediaTrack, numero: number): PlayerTrack {
  return {
    id: track.id,
    label: nativeTrackLabel(track.label, track.language, numero),
    language: track.language ?? null
  };
}

/**
 * O portal dos controles do player, assim que ele existir. Passado o limite, segue sem ele —
 * o vídeo abre do mesmo jeito, só sem a interface por cima. `setTimeout` e não
 * `requestAnimationFrame`: com a janela minimizada o rAF para e prenderia a abertura.
 */
async function nativeControlsElement(timeoutMs = 3_000): Promise<Element | null> {
  const started = Date.now();
  for (;;) {
    const element = document.querySelector("[data-player-nativo]");
    if (element !== null || Date.now() - started >= timeoutMs) return element;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
  }
}

/** A implementação desktop do mesmo contrato consumido pelo Android. */
export class TauriPlayer implements NativePlayer {
  // Injetável para teste. Sem cliente injetado, o padrão (`createTauriVideoClient()`) é criado na
  // primeira abertura; o pacote só tem condição `import`, então a importação é dinâmica.
  #client: Pick<VideoClient, "attach"> | null;
  readonly #listeners = new Map<keyof PlayerEvents, ((data: never) => void)[]>();
  readonly #element: HTMLVideoElement;
  #controller: VideoController | null = null;
  #muted = false;
  #engine: "mpv" | "gstreamer" = "gstreamer";
  // O que o APP escolheu, não o que o motor diz. O playbin3 liga sozinho a legenda padrão do MKV
  // quando descobre os fluxos (depois do play), e as falas dela apareciam com "Desligadas"
  // marcado — em anime, às vezes em mongol ou árabe.
  #wantedSubtitleId: string | null = null;
  #volume = 1;
  // Assinatura da lista de trilhas já anunciada à interface (ver o `timeupdate` em `load`).
  #tracksSignature = "";
  #state: PlayerState = {
    loaded: false, playing: false, positionSeconds: 0, durationSeconds: 0,
    audioTrackId: null, subtitleTrackId: null
  };

  // Ids das legendas externas passadas ao `load` (as que a tela desenha, não o motor).
  #externalSubtitleIds: ReadonlySet<string> = new Set();
  #correctingSubtitle = false;
  #externalSubtitles: PlayerSource["subtitles"] = [];
  #subtitleRevision = 0;
  #subtitleOffset = 0;
  readonly #subtitleRenderer = new ExternalSubtitleRenderer((cues) => this.#emit("subtitleCues", cues));

  constructor(element: HTMLVideoElement, client?: Pick<VideoClient, "attach">, private readonly readSubtitle = readExternalSubtitle) {
    this.#element = element;
    this.#client = client ?? null;
  }

  static available(): boolean {
    return runtimeTauri();
  }

  async load(source: PlayerSource): Promise<void> {
    await this.destroy();
    this.#engine = source.alternativeEngine ? "mpv" : "gstreamer";
    // O plugin recorta sobre o vídeo tudo que não foi registrado como controle, e só registra o
    // que existe agora. O portal dos controles monta em duas passadas do React (`mounted` em
    // PlayerControls): com o progresso já lido de antemão, a abertura chegava antes dele e a
    // interface ficava coberta pelo vídeo a sessão inteira. Espera o portal existir.
    const controls = await nativeControlsElement();
    // O plugin guarda o volume no próprio <video> ao fechar e o relê ao abrir. Como o mudo daqui
    // zera o volume, um mudo (ou volume em 0) deixava TODAS as aberturas seguintes sem som, com a
    // interface mostrando som ligado. O estado que vale é o deste player.
    this.#element.muted = false;
    this.#element.volume = this.#muted ? 0 : this.#volume;
    this.#client ??= (await import("@get-air/video-tauri")).createTauriVideoClient();
    this.#subtitleRenderer.update(Math.max(0, source.startAtSeconds));
    this.#externalSubtitles = source.subtitles;
    this.#externalSubtitleIds = new Set(source.subtitles.map((subtitle) => subtitle.id));
    this.#controller = await this.#client.attach(this.#element, {
      // No Linux, pedir a posição junto do `native_open` pode fazer o GStreamer tentar buscar
      // antes de a URL remota estar preparada e abortar toda a abertura. Primeiro abre a mídia;
      // o seek é aplicado abaixo, com o controlador já pronto.
      source: { uri: source.url },
      backend: "tauri",
      backendOptions: {
        tauri: {
          // GStreamer é o padrão: com o mpv abrindo direto, o vídeo tocava sem som (causa não
          // achada). O mpv é a reserva para os MKV que o GStreamer recusa (anime com fontes
          // anexadas) — por esse caminho o som funcionou.
          engine: this.#engine,
          linux: { buffer: { maxSeconds: 15, maxBytes: 64 * 1024 * 1024 } }
        }
      },
      subtitles: [],
      controlRegions: controls ?? undefined,
      autoplay: false,
      deviceProfile: "desktop"
    });
    this.#tracksSignature = "";
    this.#controller.on("timeupdate", ({ detail }) => {
      // O plugin não avisa quando descobre as trilhas do arquivo, e elas chegam depois do `ready`
      // (no mpv, e na reabertura GStreamer → mpv bem depois das leituras fixas da interface): as
      // legendas do próprio MKV nunca apareciam no menu. Anuncia sempre que a lista mudar.
      const tracks = this.#controller?.tracks ?? [];
      const ids = JSON.stringify(tracks.map(({ id, label, language }) => ({ id, label, language })));
      if (ids !== this.#tracksSignature) {
        this.#tracksSignature = ids;
        this.#emit("tracksChanged", undefined);
      }
      void this.#ensureChosenSubtitle();
      this.#updatePosition(detail.currentTime);
    });
    this.#controller.on("trackchange", ({ detail }) => {
      if (detail.kind === "audio") this.#state = { ...this.#state, audioTrackId: detail.trackId ?? null };
      if (detail.kind === "subtitle" && !this.#externalSubtitleIds.has(this.#wantedSubtitleId ?? "")) this.#state = { ...this.#state, subtitleTrackId: detail.trackId ?? null };
    });
    // Só o primeiro erro deste pipeline, e só enquanto ele ainda é o atual: o GStreamer manda a
    // mesma falha em mais de um evento, e os atrasados de um pipeline já trocado não são deste.
    const controller = this.#controller;
    let erroEmitido = false;
    controller.on("error", ({ detail }) => {
      if (erroEmitido || this.#controller !== controller) return;
      erroEmitido = true;
      this.#emit("error", detail.message);
    });
    const subtitleTrackId = source.defaultSubtitleId ?? null;
    this.#wantedSubtitleId = subtitleTrackId;
    await this.selectSubtitleTrack(subtitleTrackId);
    this.#state = {
      ...this.#state,
      loaded: true,
      playing: false,
      positionSeconds: Math.max(0, source.startAtSeconds),
      durationSeconds: this.#duration(),
      subtitleTrackId
    };
    const primeiroAvanco = new Promise<void>((resolve) => {
      let concluido = false;
      const finish = () => {
        if (concluido) return;
        concluido = true;
        unsubscribe();
        resolve();
      };
      const unsubscribe = this.#controller!.on("timeupdate", ({ detail }) => {
        if (detail.currentTime > 0) finish();
      });
      window.setTimeout(finish, 5_000);
    });
    await this.play();
    // Reaplica depois que o motor já escolheu as faixas; antes do play não tinha efeito.
    void primeiroAvanco.then(() => {
      if (this.#controller === controller) return this.#ensureChosenSubtitle();
    });
    if (source.startAtSeconds > 0) {
      // O backend Rust não aplica posição na abertura. Esperar o relógio avançar comprova que
      // o pipeline terminou o preroll antes de fazermos o único seek de retomada.
      await primeiroAvanco;
      // Um único seek depois do primeiro frame evita corromper o buffer pool do GStreamer.
      // O limite garante que um backend que não confirme a operação não prenda o spinner.
      await Promise.race([
        this.seek(source.startAtSeconds).catch(() => undefined),
        new Promise<void>((resolve) => window.setTimeout(resolve, 3_000))
      ]);
      // Depois do seek o AV1 por software leva alguns segundos para chegar ao ponto pedido, e a
      // superfície mostrava nesse meio-tempo sobra de memória da GPU (imagem de outro vídeo).
      // A cortina de carregamento só sai quando um quadro novo, já da retomada, chega à tela.
      await this.#nextPresentedFrame();
    }
    // A interface só sai do carregamento depois que a mídia abriu, começou a tocar e a retomada
    // teve suas tentativas. Emitir antes expunha todos os controles sobre um frame ainda parado.
    this.#emit("ready", this.#state);
  }

  async play(): Promise<void> {
    await this.#controller?.play();
    this.#state = { ...this.#state, playing: true };
  }

  async pause(): Promise<void> {
    this.#controller?.pause();
    this.#state = { ...this.#state, playing: false };
  }

  async seek(seconds: number): Promise<void> {
    const target = Math.max(0, seconds);
    await this.#controller?.seek(target);
    this.#updatePosition(target);
  }

  async audioTracks(): Promise<readonly PlayerTrack[]> {
    const selected = this.#controller?.tracks.find((candidate) => candidate.kind === "audio" && candidate.selected);
    if (selected) this.#state = { ...this.#state, audioTrackId: selected.id };
    return this.#tracks("audio");
  }

  async selectAudioTrack(id: string): Promise<void> {
    await this.#controller?.selectTrack("audio", id);
    this.#state = { ...this.#state, audioTrackId: id };
  }

  async subtitleTracks(): Promise<readonly PlayerTrack[]> {
    return [...this.#externalSubtitles.map(({ id, label, language }) => ({ id, label, language })), ...this.#tracks("subtitle")];
  }

  async selectSubtitleTrack(id: string | null): Promise<void> {
    const revision = ++this.#subtitleRevision;
    const controller = this.#controller;
    const external = this.#externalSubtitles.find((subtitle) => subtitle.id === id);
    const text = external ? await this.readSubtitle(external.url) : null;
    if (revision !== this.#subtitleRevision || controller !== this.#controller) return;
    await controller?.selectTrack("subtitle", external ? undefined : id ?? undefined);
    if (revision !== this.#subtitleRevision) return;
    this.#wantedSubtitleId = id;
    this.#state = { ...this.#state, subtitleTrackId: id };
    this.#subtitleRenderer.clear();
    if (text !== null) this.#subtitleRenderer.load(text);
    await this.#applyNativeSubtitleTiming();
  }

  async addExternalSubtitles(subtitles: PlayerSource["subtitles"], defaultSubtitleId?: string | null): Promise<void> {
    this.#externalSubtitles = subtitles;
    this.#externalSubtitleIds = new Set(subtitles.map(({ id }) => id));
    this.#emit("tracksChanged", undefined);
    if (defaultSubtitleId && this.#wantedSubtitleId === null) await this.selectSubtitleTrack(defaultSubtitleId);
  }

  subtitleSettingsSupport(): "all" | "timing" {
    return this.#wantedSubtitleId === null || this.#externalSubtitleIds.has(this.#wantedSubtitleId) ? "all" : "timing";
  }

  async setSubtitleTiming(offsetSeconds: number, extraDurationSeconds: number): Promise<void> {
    this.#subtitleOffset = Number.isFinite(offsetSeconds) ? offsetSeconds : 0;
    this.#subtitleRenderer.timing(offsetSeconds, extraDurationSeconds);
    await this.#applyNativeSubtitleTiming();
  }

  async #applyNativeSubtitleTiming(): Promise<void> {
    if (this.#wantedSubtitleId === null || this.#externalSubtitleIds.has(this.#wantedSubtitleId)) return;
    const sessionKey = this.#controller?.sessionId.split("native-surface-")[1];
    if (!sessionKey) return;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("plugin:video|native_control", { payload: {
      sessionKey, action: "subtitleDelay", value: this.#subtitleOffset
    } });
  }

  /**
   * Capítulos do arquivo. Só o motor mpv os informa (campo `chapters` que acrescentamos ao
   * snapshot do plugin, ver apps/pc/src-tauri/vendor); o JS do plugin não os repassa, então lemos
   * o snapshot direto. GStreamer, ou qualquer falha, devolve lista vazia.
   */
  async chapters(): Promise<readonly PlayerChapter[]> {
    const sessionKey = this.#controller?.sessionId.split("native-surface-")[1];
    if (!sessionKey) return [];
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const snapshot = await invoke<{ chapters?: { title?: string; startSeconds?: number }[] }>(
        "plugin:video|native_stats", { payload: { sessionKey } }
      );
      const duration = this.#duration();
      const starts = (snapshot.chapters ?? [])
        .filter((chapter) => typeof chapter.startSeconds === "number")
        .map((chapter) => ({ name: chapter.title ?? "", start: chapter.startSeconds! }));
      return starts.map((chapter, index) => ({
        ...chapter,
        end: starts[index + 1]?.start ?? duration
      }));
    } catch {
      return [];
    }
  }

  engine(): string {
    return this.#engine;
  }

  async toggleFullscreen(): Promise<void> {
    // O fullscreen do DOM remove a região usada pela superfície GStreamer e deixa o vídeo
    // preto. No desktop, é a janela Tauri inteira que deve entrar em tela cheia.
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const window = getCurrentWindow();
    await window.setFullscreen(!(await window.isFullscreen()));
  }

  async exitFullscreen(): Promise<void> {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setFullscreen(false);
  }

  async toggleMuted(): Promise<boolean> {
    this.#muted = !this.#muted;
    await this.#controller?.setVolume(this.#muted ? 0 : this.#volume);
    return this.#muted;
  }

  async changeVolume(delta: number): Promise<number> {
    this.#volume = Math.min(1, Math.max(0, this.#volume + delta));
    this.#muted = this.#volume === 0;
    await this.#controller?.setVolume(this.#volume);
    return this.#volume;
  }

  async capabilities(): Promise<PlayerCapabilities> {
    // O backend informa suporte de plataforma; a lista exata continua sendo responsabilidade
    // do GStreamer e dos codecs instalados no PC.
    return { hevc: true, ac3: true, eac3: true, dts: true, mkv: true };
  }

  state(): PlayerState {
    return this.#state;
  }

  on<E extends keyof PlayerEvents>(event: E, listener: PlayerListener<E>): () => void {
    const callback = listener as (data: never) => void;
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), callback]);
    return () => {
      this.#listeners.set(event, (this.#listeners.get(event) ?? []).filter((current) => current !== callback));
    };
  }

  async destroy(): Promise<void> {
    const controller = this.#controller;
    this.#controller = null;
    this.#subtitleRevision++;
    this.#subtitleRenderer.clear();
    if (controller) await controller.destroy();
    this.#state = { ...this.#state, loaded: false, playing: false };
  }

  /**
   * Deixa ativa só a legenda que o app escolheu. O motor (playbin3 e mpv) liga a legenda padrão do
   * MKV quando descobre os fluxos, depois do play. Com uma externa escolhida, a tela desenhava as
   * falas dela e o motor desenhava a embutida por cima: duas legendas. Com uma externa ativa,
   * mantemos todas as faixas nativas desligadas. A escolha é reaplicada quando o motor diverge.
   */
  async #ensureChosenSubtitle(): Promise<void> {
    const controller = this.#controller;
    if (!controller || this.#correctingSubtitle) return;
    const wanted = this.#wantedSubtitleId;
    const selected = controller.tracks.filter((candidate) => candidate.kind === "subtitle" && candidate.selected);
    let diverges: boolean;
    if (wanted === null) diverges = selected.length > 0;
    else if (this.#externalSubtitleIds.has(wanted)) diverges = selected.length > 0;
    else diverges = selected.length !== 1 || selected[0]!.id !== wanted;
    if (!diverges) return;
    this.#correctingSubtitle = true;
    try {
      await controller.selectTrack("subtitle", wanted === null || this.#externalSubtitleIds.has(wanted) ? undefined : wanted);
    } catch {
      // Sem a correção a legenda fica como o motor deixou; a próxima mudança de faixas tenta de novo.
    } finally {
      this.#correctingSubtitle = false;
    }
  }

  #tracks(kind: "audio" | "subtitle"): readonly PlayerTrack[] {
    return (this.#controller?.tracks ?? []).filter((candidate) => candidate.kind === kind)
      .map((candidate, posicao) => track(candidate, posicao + 1));
  }

  /** Quadros que o motor já desenhou (snapshot do plugin); null se não der para ler. */
  async #presentedFrames(): Promise<number | null> {
    const sessionKey = this.#controller?.sessionId.split("native-surface-")[1];
    if (!sessionKey) return null;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const snapshot = await invoke<{ presentedFrames?: number }>("plugin:video|native_stats", { payload: { sessionKey } });
      return typeof snapshot.presentedFrames === "number" ? snapshot.presentedFrames : null;
    } catch {
      return null;
    }
  }

  /** Espera o próximo quadro desenhado (até 6 s): sem contador, não segura a abertura. */
  async #nextPresentedFrame(): Promise<void> {
    const before = await this.#presentedFrames();
    if (before === null) return;
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
      const now = await this.#presentedFrames();
      if (now === null || now > before) return;
    }
  }

  #duration(): number {
    const value = this.#controller?.media.durationSeconds;
    return value !== undefined && Number.isFinite(value) ? value : 0;
  }

  #updatePosition(positionSeconds: number): void {
    this.#subtitleRenderer.update(positionSeconds);
    const durationSeconds = this.#duration();
    this.#state = { ...this.#state, positionSeconds, durationSeconds };
    if (durationSeconds > 0 && positionSeconds >= durationSeconds - 0.1) {
      this.#state = { ...this.#state, playing: false };
      this.#emit("ended", undefined);
      return;
    }
    this.#emit("position", positionSeconds);
  }

  #emit<E extends keyof PlayerEvents>(event: E, data: PlayerEvents[E]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      (listener as PlayerListener<E>)(data);
    }
  }
}

export function tauriPlayerDisponivel(): boolean {
  return TauriPlayer.available();
}
