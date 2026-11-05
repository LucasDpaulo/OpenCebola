export interface WakeLockHandle {
  release(): Promise<void>;
}

type RequestWakeLock = () => Promise<WakeLockHandle>;

/** Mantém uma única trava de suspensão enquanto há reprodução ativa. */
export class PlaybackWakeLock {
  readonly #request: RequestWakeLock;
  #handle: WakeLockHandle | null = null;
  #acquiring: Promise<void> | null = null;
  #playing = false;

  constructor(request: RequestWakeLock) {
    this.#request = request;
  }

  async setPlaying(playing: boolean): Promise<void> {
    this.#playing = playing;
    if (playing) {
      await this.#acquire();
      return;
    }
    await this.#release();
  }

  markReleased(handle: WakeLockHandle): void {
    if (this.#handle === handle) this.#handle = null;
  }

  async resumeVisiblePlayback(): Promise<void> {
    if (this.#playing) await this.#acquire();
  }

  async dispose(): Promise<void> {
    this.#playing = false;
    await this.#release();
  }

  async #acquire(): Promise<void> {
    if (this.#handle) return;
    if (this.#acquiring) return this.#acquiring;
    const acquiring = (async () => {
      const handle = await this.#request();
      if (!this.#playing) {
        await handle.release();
        return;
      }
      this.#handle = handle;
    })();
    this.#acquiring = acquiring;
    try {
      await acquiring;
    } finally {
      if (this.#acquiring === acquiring) this.#acquiring = null;
    }
  }

  async #release(): Promise<void> {
    const handle = this.#handle;
    this.#handle = null;
    if (handle) await handle.release();
  }
}
