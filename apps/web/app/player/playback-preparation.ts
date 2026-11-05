/** Uma leitura adiantada pertence somente à fonte/vídeo que a iniciou. */
export class PlaybackPreparation<T> {
  private entry: { key: string; promise: Promise<T>; settledAt: number | null; failed: boolean } | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  start(key: string, load: () => Promise<T>): void {
    const entry = { key, promise: Promise.resolve().then(load), settledAt: null as number | null, failed: false };
    this.entry = entry;
    void entry.promise.then(
      () => { entry.settledAt = this.now(); },
      () => { entry.failed = true; }
    );
  }

  take(key: string, maxAgeMs = 2_000): Promise<T> | null {
    const entry = this.entry;
    if (!entry || entry.key !== key) return null;
    this.entry = null;
    if (entry.failed || (entry.settledAt !== null && this.now() - entry.settledAt >= maxAgeMs)) return null;
    return entry.promise;
  }

  clear(): void { this.entry = null; }
}

export type StartupMilestone = "urlReadyMs" | "subtitlesReadyMs" | "progressReadyMs" |
  "playerCreatedMs" | "loadStartedMs" | "playerReadyMs" | "playerVisibleMs";

/** Tempos cumulativos desde a escolha da fonte, sem URLs, tokens ou conteúdo de legendas. */
export class PlaybackStartupTiming {
  private readonly started: number;
  private readonly milestones: Partial<Record<StartupMilestone, string>> = {};
  private reported = false;

  constructor(private readonly now: () => number = () => performance.now()) { this.started = now(); }

  mark(milestone: StartupMilestone): void {
    this.milestones[milestone] ??= String(Math.max(0, Math.round(this.now() - this.started)));
  }

  finish(): Partial<Record<StartupMilestone, string>> | null {
    if (this.reported) return null;
    this.reported = true;
    this.mark("playerVisibleMs");
    return { ...this.milestones };
  }
}

export function playbackPreparationKey(videoId: string, sourceId: string): string {
  return JSON.stringify([videoId, sourceId]);
}
