export interface BrowserSubtitleTrack {
  readonly id: string;
  readonly kind: string;
  mode: string;
  setMode?(mode: "showing" | "disabled"): void;
}

export interface BrowserSubtitleTracks {
  readonly selected: BrowserSubtitleTrack | null;
  readonly values: readonly BrowserSubtitleTrack[];
}

export function activateDefaultSubtitle(
  tracks: BrowserSubtitleTracks, id: string | null, autoEnabled = true
): boolean {
  if (!autoEnabled || !id || tracks.selected) return false;
  const target = tracks.values.find((track) =>
    track.id === id && (track.kind === "subtitles" || track.kind === "captions"));
  if (!target) return false;
  if (target.setMode) target.setMode("showing");
  else target.mode = "showing";
  return true;
}

export function preferredBrowserSubtitleId(automaticId: string | null, choice: string | null): string | null {
  return choice === "off" ? null : choice ?? automaticId;
}

export function watchBrowserSubtitleChanges(tracks: EventTarget, onChange: () => void): () => void {
  tracks.addEventListener("add", onChange);
  tracks.addEventListener("remove", onChange);
  return () => {
    tracks.removeEventListener("add", onChange);
    tracks.removeEventListener("remove", onChange);
  };
}
