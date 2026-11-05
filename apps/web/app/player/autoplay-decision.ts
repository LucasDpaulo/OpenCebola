/** Um lote sem fontes utilizáveis ainda não é o resultado final da descoberta. */
export function autoplayDecision(
  state: "idle" | "loading" | "ready" | "empty" | "error",
  searchingMore: boolean,
  hasChoice: boolean
): "wait" | "play" | "choose" {
  if (state === "ready" && hasChoice) return "play";
  if (searchingMore || state === "idle" || state === "loading") return "wait";
  return "choose";
}
