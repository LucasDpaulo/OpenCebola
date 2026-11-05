"use client";

import { useSyncExternalStore } from "react";
import { isTauriRuntime, isTvRuntime } from "../api-client";
import { useTvLayout } from "../tv/use-tv-layout";

const PHONE_QUERY = "(max-width: 767px) and (pointer: coarse)";
function snapshot(): boolean {
  if (typeof window === "undefined" || isTvRuntime() || isTauriRuntime()) return false;
  return /iPhone|iPod|Android.*Mobile/i.test(navigator.userAgent) || window.matchMedia(PHONE_QUERY).matches;
}
function subscribe(callback: () => void) {
  const media = window.matchMedia(PHONE_QUERY);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}
export function useMobileBooks(): boolean {
  const tv = useTvLayout();
  return useSyncExternalStore(subscribe, snapshot, () => false) && !tv;
}
