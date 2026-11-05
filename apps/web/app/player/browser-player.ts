import type { MediaPlayerInstance } from "@vidstack/react";
import type {
  NativePlayer, PlayerCapabilities, PlayerEvents, PlayerListener, PlayerSource, PlayerState, PlayerTrack
} from "./native-player";

/** Adapta o Vidstack ao mesmo contrato usado pelos motores Android, PC e TV. */
export class BrowserPlayer implements NativePlayer {
  readonly #instance: () => MediaPlayerInstance | null;
  readonly #listeners = new Map<keyof PlayerEvents, Set<(data: never) => void>>();

  constructor(instance: () => MediaPlayerInstance | null) {
    this.#instance = instance;
  }

  async load(_source: PlayerSource): Promise<void> {}
  async play(): Promise<void> { await this.#instance()?.play(); }
  async pause(): Promise<void> { await this.#instance()?.pause(); }
  async seek(seconds: number): Promise<void> {
    const player = this.#instance();
    if (player) player.currentTime = seconds;
  }

  async audioTracks(): Promise<readonly PlayerTrack[]> {
    const result: PlayerTrack[] = [];
    for (const track of Array.from(this.#instance()?.audioTracks ?? [])) {
      if (track) result.push({ id: track.id, label: track.label || "Áudio", language: track.language || null });
    }
    return result;
  }

  async selectAudioTrack(id: string): Promise<void> {
    const player = this.#instance();
    if (!player) return;
    const index = Array.from(player.audioTracks).findIndex((track) => track?.id === id);
    if (index >= 0) player.remoteControl.changeAudioTrack(index);
  }

  async subtitleTracks(): Promise<readonly PlayerTrack[]> {
    const result: PlayerTrack[] = [];
    for (const track of Array.from(this.#instance()?.textTracks ?? [])) {
      if (track && (track.kind === "subtitles" || track.kind === "captions")) {
        result.push({ id: track.id, label: track.label || "Legenda", language: track.language || null });
      }
    }
    return result;
  }

  async selectSubtitleTrack(id: string | null): Promise<void> {
    const player = this.#instance();
    if (!player) return;
    for (const track of Array.from(player.textTracks)) {
      if (track && (track.kind === "subtitles" || track.kind === "captions")) {
        const targetMode = track.id === id ? "showing" : "disabled";
        if (typeof track.setMode === "function") {
          track.setMode(targetMode);
        } else {
          track.mode = targetMode;
        }
      }
    }
  }

  async toggleFullscreen(): Promise<void> {
    const player = this.#instance();
    if (!player) return;
    if (document.fullscreenElement) await player.exitFullscreen();
    else await player.enterFullscreen();
  }

  async exitFullscreen(): Promise<void> {
    if (document.fullscreenElement) await this.#instance()?.exitFullscreen();
  }

  async toggleMuted(): Promise<boolean> {
    const player = this.#instance();
    if (!player) return false;
    player.muted = !player.muted;
    return player.muted;
  }

  async changeVolume(delta: number): Promise<number> {
    const player = this.#instance();
    if (!player) return 1;
    player.volume = Math.min(1, Math.max(0, player.volume + delta));
    if (player.volume > 0) player.muted = false;
    return player.volume;
  }

  async setVolume(level: number): Promise<number> {
    const player = this.#instance();
    if (!player) return 1;
    player.volume = Math.min(1, Math.max(0, level));
    if (player.volume > 0) player.muted = false;
    return player.volume;
  }

  async setPlaybackRate(rate: number): Promise<void> {
    const player = this.#instance();
    if (player) player.playbackRate = rate;
  }

  async capabilities(): Promise<PlayerCapabilities> {
    return { hevc: false, ac3: false, eac3: false, dts: false, mkv: false };
  }

  state(): PlayerState {
    const player = this.#instance();
    // Na troca de fonte/episódio a ref ainda aponta para a instância antiga do Vidstack, já
    // destruída (`$state` nulo): ler `duration` dela lançava erro DURANTE a renderização dos
    // controles e derrubava a página inteira ("This page couldn't load", visto na TV Samsung).
    // Vale como "nada carregado"; o próximo evento do player novo atualiza a tela.
    try {
      return {
        loaded: Boolean(player && Number.isFinite(player.duration) && player.duration > 0),
        playing: Boolean(player && !player.paused),
        positionSeconds: player?.currentTime ?? 0,
        durationSeconds: player?.duration ?? 0,
        audioTrackId: player?.audioTracks.selected?.id ?? null,
        subtitleTrackId: player?.textTracks.selected?.id ?? null
      };
    } catch {
      return { loaded: false, playing: false, positionSeconds: 0, durationSeconds: 0, audioTrackId: null, subtitleTrackId: null };
    }
  }

  on<E extends keyof PlayerEvents>(event: E, listener: PlayerListener<E>): () => void {
    const listeners = this.#listeners.get(event) ?? new Set();
    listeners.add(listener as (data: never) => void);
    this.#listeners.set(event, listeners);
    return () => {
      listeners.delete(listener as (data: never) => void);
      if (listeners.size === 0 && this.#listeners.get(event) === listeners) this.#listeners.delete(event);
    };
  }

  notify<E extends keyof PlayerEvents>(event: E, data: PlayerEvents[E]): void {
    this.#listeners.get(event)?.forEach((listener) => listener(data as never));
  }

  async destroy(): Promise<void> { this.#listeners.clear(); }
}
