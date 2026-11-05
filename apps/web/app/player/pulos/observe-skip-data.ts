import type { NativePlayer } from "../native-player";
import { segmentsFromChapters, type SkipSegment } from "./skip-segments";
import { subtitleMarkers, type SubtitleMarkers } from "./subtitle-markers";

interface Options {
  player: NativePlayer;
  subtitles: () => readonly { id: string; url: string }[];
  fetchText: (url: string) => Promise<string | null>;
  chapters: (segments: readonly SkipSegment[]) => void;
  markers: (value: { markers: SubtitleMarkers; duration: number } | null) => void;
  now?: () => number;
  schedule?: (tick: () => void) => () => void;
}

/** Observa dados tardios sem esperar por eles para tocar ou refazer o carregamento do vídeo. */
export function observeSkipData(options: Options): () => void {
  const { player } = options;
  let stopped = false;
  let playbackStarted = false;
  let generation = 0;
  let chapterBusy = false;
  let chapterDone = false;
  let chapterAttempts = 0;
  let nextChapterRead = 0;
  const now = options.now ?? Date.now;
  let activeKey = "";
  let subtitleDone = false;
  let subtitleAttempts = 0;
  let nextSubtitleRead = 0;
  const pending = new Set<string>();

  const tick = () => {
    if (stopped) return;
    const state = player.state();
    if (state.playing) playbackStarted = true;
    if (!playbackStarted) return;
    if (!state.loaded || !Number.isFinite(state.durationSeconds) || state.durationSeconds <= 0) return;
    const version = generation;
    if (player.chapters && !chapterDone && !chapterBusy && now() >= nextChapterRead) {
      chapterBusy = true;
      nextChapterRead = now() + Math.min(30, 2 ** Math.min(chapterAttempts, 5)) * 1_000;
      chapterAttempts++;
      void player.chapters().then((chapters) => {
        if (stopped || version !== generation) return;
        if (chapters.length === 0) return;
        const segments = segmentsFromChapters(chapters);
        if (segments.length === 0) return;
        chapterDone = true;
        options.chapters(segments);
      }).catch(() => {}).finally(() => { if (version === generation) chapterBusy = false; });
    }

    const id = state.subtitleTrackId?.replace(/^external:/, "");
    const subtitle = options.subtitles().find((candidate) => candidate.id === id);
    const key = JSON.stringify([state.subtitleTrackId, subtitle?.url, Math.round(state.durationSeconds)]);
    if (key !== activeKey) {
      activeKey = key;
      subtitleDone = false;
      subtitleAttempts = 0;
      nextSubtitleRead = 0;
      options.markers(null);
    }
    // Ainda não está na lista? Não marca como lida: a busca de legendas pode estar em voo.
    const requestKey = `${version}:${key}`;
    if (!subtitle || subtitleDone || pending.has(requestKey) || now() < nextSubtitleRead) return;
    subtitleAttempts++;
    nextSubtitleRead = now() + (subtitleAttempts >= 3 ? 30_000 : 1_000);
    pending.add(requestKey);
    void options.fetchText(subtitle.url).then((text) => {
      if (stopped || version !== generation || key !== activeKey ||
          player.state().subtitleTrackId !== state.subtitleTrackId || text === null || text.trim() === "") return;
      subtitleDone = true;
      options.markers({ markers: subtitleMarkers(text, state.durationSeconds), duration: state.durationSeconds });
    }).catch(() => {}).finally(() => { pending.delete(requestKey); });
  };
  const ready = () => {
    generation++;
    playbackStarted = false;
    chapterDone = false;
    chapterBusy = false;
    chapterAttempts = 0;
    nextChapterRead = 0;
    activeKey = "";
    options.chapters([]);
    options.markers(null);
    tick();
  };
  const offReady = player.on("ready", ready);
  const offTracks = player.on("tracksChanged", tick);
  // Consulta imediata cobre o ready disparado antes de o React instalar o efeito.
  tick();
  const cancelTimer = (options.schedule ?? ((callback) => {
    const timer = window.setInterval(callback, 1_000);
    return () => window.clearInterval(timer);
  }))(tick);
  return () => {
    stopped = true;
    cancelTimer();
    if (typeof offReady === "function") offReady();
    if (typeof offTracks === "function") offTracks();
  };
}
