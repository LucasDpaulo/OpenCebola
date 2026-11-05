import type {
  NativePlayer, PlayerCapabilities, PlayerEvents, PlayerListener, PlayerSource, PlayerState, PlayerTrack
} from "./native-player.js";

/**
 * Player de mentira, em memória. Existe para a interface da fase 1b ser construída e testada
 * sem cabo, sem APK e sem Real-Debrid — o aparelho vira verificação final, não pré-requisito.
 *
 * O relógio é manual (`avancarRelogio`) de propósito: teste que depende de `setInterval` real é
 * lento e intermitente, e intermitência em teste é pior que teste nenhum.
 */
export class FakePlayer implements NativePlayer {
  readonly #audioTracks: readonly PlayerTrack[];
  readonly #subtitleTracks: readonly PlayerTrack[];
  readonly #duration: number;
  readonly #listeners = new Map<keyof PlayerEvents, ((data: never) => void)[]>();

  #loaded = false;
  #playing = false;
  #position = 0;
  #audioTrackId: string | null = null;
  #subtitleTrackId: string | null = null;
  #brightness = 1;

  constructor(options: {
    audioTracks?: readonly PlayerTrack[];
    subtitleTracks?: readonly PlayerTrack[];
    durationSeconds?: number;
  } = {}) {
    this.#audioTracks = options.audioTracks ?? [{ id: "1", label: "Original", language: null }];
    this.#subtitleTracks = options.subtitleTracks ?? [];
    this.#duration = options.durationSeconds ?? 7200;
  }

  async load(source: PlayerSource): Promise<void> {
    this.#loaded = true;
    this.#position = this.#limitar(source.startAtSeconds);
    this.#audioTrackId = this.#audioTracks[0]?.id ?? null;
    this.#subtitleTrackId = source.defaultSubtitleId ?? null;
    this.#emitir("ready", this.state());
  }

  async play(): Promise<void> { this.#playing = true; }
  async pause(): Promise<void> { this.#playing = false; }
  async seek(seconds: number): Promise<void> { this.#position = this.#limitar(seconds); }
  async audioTracks(): Promise<readonly PlayerTrack[]> { return this.#audioTracks; }

  // Um motor real recusa selecionar um ID que não existe mais (trilha removida entre sessões,
  // por exemplo). Sem essa validação aqui, nada neste fake reproduziria a falha isolada que a
  // restauração de cenário precisa tolerar sem travar o vídeo.
  async selectAudioTrack(id: string): Promise<void> {
    if (!this.#audioTracks.some((track) => track.id === id)) {
      throw new Error(`Faixa de áudio "${id}" não encontrada.`);
    }
    this.#audioTrackId = id;
  }

  async subtitleTracks(): Promise<readonly PlayerTrack[]> { return this.#subtitleTracks; }

  async selectSubtitleTrack(id: string | null): Promise<void> {
    if (id !== null && !this.#subtitleTracks.some((track) => track.id === id)) {
      throw new Error(`Legenda "${id}" não encontrada.`);
    }
    this.#subtitleTrackId = id;
  }
  async setBrightness(level: number): Promise<void> { this.#brightness = Math.max(0.05, Math.min(1, level)); }
  async changeVolume(delta: number): Promise<number> { return Math.min(1, Math.max(0, 1 + delta)); }
  async setVolume(level: number): Promise<number> { return Math.min(1, Math.max(0, level)); }
  async setPlaybackRate(_rate: number): Promise<void> {}

  brightness(): number { return this.#brightness; }

  async capabilities(): Promise<PlayerCapabilities> {
    return { hevc: true, ac3: true, eac3: true, dts: true, mkv: true };
  }

  state(): PlayerState {
    return {
      loaded: this.#loaded,
      playing: this.#playing,
      positionSeconds: this.#position,
      durationSeconds: this.#duration,
      audioTrackId: this.#audioTrackId,
      subtitleTrackId: this.#subtitleTrackId
    };
  }

  on<E extends keyof PlayerEvents>(event: E, listener: PlayerListener<E>): void {
    const atuais = this.#listeners.get(event) ?? [];
    this.#listeners.set(event, [...atuais, listener as (data: never) => void]);
  }

  async destroy(): Promise<void> {
    this.#loaded = false;
    this.#playing = false;
    this.#listeners.clear();
  }

  /** Só o teste chama. Avança N segundos emitindo `position` a cada um, como o player real. */
  avancarRelogio(segundos: number): void {
    for (let i = 0; i < segundos; i += 1) {
      if (!this.#playing) return;
      this.#position += 1;
      if (this.#position >= this.#duration) {
        this.#position = this.#duration;
        this.#playing = false;
        this.#emitir("ended", undefined);
        return;
      }
      this.#emitir("position", this.#position);
    }
  }

  #limitar(segundos: number): number {
    return Math.max(0, Math.min(this.#duration, Math.round(segundos)));
  }

  #emitir<E extends keyof PlayerEvents>(event: E, data: PlayerEvents[E]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      (listener as PlayerListener<E>)(data);
    }
  }
}
