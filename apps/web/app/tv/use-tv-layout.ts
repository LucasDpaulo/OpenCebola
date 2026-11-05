"use client";

import { useSyncExternalStore } from "react";

// Quem precisa desviar de JSX conforme o layout (não só de CSS) lê este hook em vez de checar
// `isTvRuntime()` de novo — a fonte da verdade é o atributo que `TvLayoutFlag` já resolveu e
// gravou no `<html>`, então o componente e o CSS nunca discordam sobre estar ou não em modo TV.

function isOn(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.tvLayout === "on";
}

function subscribe(callback: () => void): () => void {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-tv-layout"] });
  return () => observer.disconnect();
}

export function useTvLayout(): boolean {
  return useSyncExternalStore(subscribe, isOn, () => false);
}
