/** O Android consulta este evento antes de navegar no histórico da WebView. */
export function interceptPlaybackBack(target: EventTarget, close: () => void): () => void {
  const onBack = (event: Event) => {
    event.preventDefault();
    close();
  };
  target.addEventListener("cebola:playback-back", onBack);
  return () => target.removeEventListener("cebola:playback-back", onBack);
}
