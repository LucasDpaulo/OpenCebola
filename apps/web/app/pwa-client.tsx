"use client";

import { useEffect } from "react";

export type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

declare global {
  interface Window {
    cebolaInstallPrompt?: InstallPromptEvent;
  }
}

export function PwaClient() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
    }
    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      window.cebolaInstallPrompt = event as InstallPromptEvent;
      window.dispatchEvent(new Event("cebola:install-ready"));
    };
    const onInstalled = () => {
      delete window.cebolaInstallPrompt;
      window.dispatchEvent(new Event("cebola:install-ready"));
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  return null;
}
