"use client";

import { useEffect } from "react";
import { isTizenRuntime } from "../api-client";

// A TV suspende o app em vez de fechar, então um deploy novo não chega sozinho. Este componente
// compara a versão que o app carregou (NEXT_PUBLIC_BUILD_ID, gravada no build) com o /version.txt
// servido agora; quando difere, recarrega — dando "auto-update" sem reinstalar o pacote. Só age na
// TV (não força reload no navegador de PC).
const CHECK_INTERVAL_MS = 3 * 60 * 1000;

export function TvAutoReload() {
  useEffect(() => {
    if (!isTizenRuntime()) return;
    const current = process.env.NEXT_PUBLIC_BUILD_ID;
    if (!current) return;
    let reloading = false;

    const check = async () => {
      if (reloading || document.visibilityState !== "visible") return;
      // Não interrompe um filme em andamento: adia o reload para a próxima verificação.
      const playing = [...document.querySelectorAll("video")].some((video) => !video.paused && !video.ended);
      if (playing) return;
      try {
        const response = await fetch(`/version.txt?t=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) return;
        const latest = (await response.text()).trim();
        if (latest && latest !== current) {
          reloading = true;
          window.location.reload();
        }
      } catch {
        // offline ou erro de rede: ignora e tenta na próxima verificação.
      }
    };

    const interval = setInterval(() => void check(), CHECK_INTERVAL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    void check();

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  return null;
}
