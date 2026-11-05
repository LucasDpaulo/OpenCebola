import type {
  NativePlayer, PlayerCapabilities, PlayerEvents, PlayerListener, PlayerSource, PlayerState, PlayerTrack
} from "./native-player";
import { dentroDaCasca, estadoCasca } from "../tv/tizen-casca";

type AvplayTrack = { index: number; type: "AUDIO" | "TEXT" | "VIDEO"; extra_info?: string | Record<string, unknown> };
type Avplay = {
  open(url: string): void;
  close?(): void;
  prepareAsync(success: () => void, failure: (error: unknown) => void): void;
  play(): void; pause(): void; stop(): void;
  seekTo(milliseconds: number): void;
  getDuration(): number; getState(): string;
  getTotalTrackInfo(): AvplayTrack[];
  setSelectTrack(type: "AUDIO" | "TEXT", index: number): void;
  setDisplayRect(x: number, y: number, width: number, height: number): void;
  setExternalSubtitlePath?(url: string): void;
  setSilentSubtitle?(silent: boolean): void;
  setListener(listener: {
    oncurrentplaytime(milliseconds: number): void;
    onstreamcompleted(): void;
    onerror(type: unknown, detail?: unknown): void;
  }): void;
};

function avplay(): Avplay | null {
  if (typeof window === "undefined") return null;
  return (window as Window & { webapis?: { avplay?: Avplay } }).webapis?.avplay ?? null;
}

/**
 * AVPlay real nesta janela (WGT antigo, sem iframe) OU, dentro da casca, o AVPlay da casca por
 * `postMessage` (tizen-bridge-player.ts). Enquanto a casca ainda não respondeu ao `ola`, vale
 * como disponível: se ela disser que não tem AVPlay, o `load` do bridge recusa e o título cai
 * no player do navegador pela volta automática.
 */
export function tizenPlayerDisponivel(): boolean {
  return avplay() !== null || (dentroDaCasca() && estadoCasca() !== "sem-avplay");
}

function language(track: AvplayTrack): string | null {
  try {
    const info = typeof track.extra_info === "string" ? JSON.parse(track.extra_info) as Record<string, unknown> : track.extra_info;
    const value = info?.language ?? info?.lang;
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch { return null; }
}

const INITIAL: PlayerState = {
  loaded: false, playing: false, positionSeconds: 0, durationSeconds: 0,
  audioTrackId: null, subtitleTrackId: null
};

export class TizenPlayer implements NativePlayer {
  readonly #avplay: Avplay;
  readonly #listeners = new Map<keyof PlayerEvents, ((data: never) => void)[]>();
  #state: PlayerState = { ...INITIAL };
  #externalSubtitles: PlayerSource["subtitles"] = [];

  constructor(bridge = avplay()) {
    if (!bridge) throw new Error("AVPlay não está disponível neste aparelho.");
    this.#avplay = bridge;
    bridge.setListener({
      oncurrentplaytime: (milliseconds) => {
        const positionSeconds = Math.max(0, Math.round(milliseconds / 1000));
        this.#state = { ...this.#state, positionSeconds };
        this.#emit("position", positionSeconds);
      },
      onstreamcompleted: () => { this.#state = { ...this.#state, playing: false }; this.#emit("ended", undefined); },
      onerror: (type, detail) => this.#emit("error", `AVPlay ${String(type)}${detail ? `: ${String(detail)}` : ""}`)
    });
  }

  async load(source: PlayerSource): Promise<void> {
    this.#externalSubtitles = source.subtitles;
    this.#avplay.open(source.url);
    this.#avplay.setDisplayRect(0, 0, 1920, 1080);
    await new Promise<void>((resolve, reject) => this.#avplay.prepareAsync(resolve, reject));
    const start = Math.max(0, Math.round(source.startAtSeconds));
    this.#state = { ...INITIAL, loaded: true, positionSeconds: start, durationSeconds: Math.max(0, Math.round(this.#avplay.getDuration() / 1000)) };
    if (start > 0) this.#avplay.seekTo(start * 1000);
    this.#emit("ready", this.state());
    await this.play();
    if (source.defaultSubtitleId) await this.selectSubtitleTrack(source.defaultSubtitleId);
  }

  async play(): Promise<void> { this.#avplay.play(); this.#state = { ...this.#state, playing: true }; }
  async pause(): Promise<void> { this.#avplay.pause(); this.#state = { ...this.#state, playing: false }; }
  async seek(seconds: number): Promise<void> {
    const target = Math.max(0, Math.round(seconds));
    this.#avplay.seekTo(Math.max(1, target) * 1000);
    this.#state = { ...this.#state, positionSeconds: target };
  }
  async audioTracks(): Promise<readonly PlayerTrack[]> { return this.#tracks("AUDIO"); }
  async selectAudioTrack(id: string): Promise<void> {
    this.#avplay.setSelectTrack("AUDIO", Number(id));
    this.#state = { ...this.#state, audioTrackId: id };
  }
  async subtitleTracks(): Promise<readonly PlayerTrack[]> {
    return [...this.#tracks("TEXT"), ...this.#externalSubtitles.map(({ id, label, language: lang }) => ({ id: `external:${id}`, label, language: lang }))];
  }
  async selectSubtitleTrack(id: string | null): Promise<void> {
    if (id === null) {
      this.#avplay.setSilentSubtitle?.(true);
    } else if (id.startsWith("external:")) {
      const external = this.#externalSubtitles.find((item) => item.id === id.slice("external:".length));
      if (!external || !this.#avplay.setExternalSubtitlePath) throw new Error("Legenda externa não suportada nesta TV.");
      this.#avplay.setExternalSubtitlePath(external.url);
      this.#avplay.setSilentSubtitle?.(false);
    } else {
      this.#avplay.setSelectTrack("TEXT", Number(id));
      this.#avplay.setSilentSubtitle?.(false);
    }
    this.#state = { ...this.#state, subtitleTrackId: id };
  }
  async capabilities(): Promise<PlayerCapabilities> { return { hevc: true, ac3: true, eac3: true, dts: false, mkv: true }; }
  state(): PlayerState { return { ...this.#state }; }
  on<E extends keyof PlayerEvents>(event: E, listener: PlayerListener<E>): () => void {
    const callback = listener as (data: never) => void;
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), callback]);
    return () => {
      this.#listeners.set(event, (this.#listeners.get(event) ?? []).filter((current) => current !== callback));
    };
  }

  async destroy(): Promise<void> {
    try { if (this.#state.loaded) this.#avplay.stop(); } catch { /* player já encerrado */ }
    try { this.#avplay.close?.(); } catch { /* firmware sem estado para close */ }
    this.#state = { ...INITIAL };
    this.#listeners.clear();
  }
  #tracks(type: "AUDIO" | "TEXT"): PlayerTrack[] {
    return this.#avplay.getTotalTrackInfo().filter((item) => item.type === type).map((item) => ({
      id: String(item.index), label: language(item) ?? `${type === "AUDIO" ? "Áudio" : "Legenda"} ${item.index}`, language: language(item)
    }));
  }
  #emit<E extends keyof PlayerEvents>(event: E, data: PlayerEvents[E]): void {
    for (const listener of this.#listeners.get(event) ?? []) (listener as PlayerListener<E>)(data);
  }
}
