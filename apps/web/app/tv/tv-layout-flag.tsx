"use client";

import { useEffect } from "react";
import { isTvRuntime } from "../api-client";
import { resolveTvLayout, TV_LAYOUT_STORAGE_KEY, isTvPreviewBuild } from "./tv-layout";
import { iniciarCasca } from "./tizen-casca";

/**
 * Liga (ou não) `data-tv-layout` no `<html>` — o interruptor único do layout de TV sobre as
 * mesmas páginas (nenhuma rota paralela). No projetor/Tizen, `isTvRuntime()` já é true; no PC e
 * no celular, `?tv=1`/`?tv=0` permite testar sem depender do aparelho, e a escolha some da URL
 * mas persiste no aparelho até a query mandar o contrário.
 *
 * Também é daqui, por montar em todas as páginas e cedo, que a casca da TV Samsung é cumprimentada
 * (`iniciarCasca`): sem efeito fora dela, e dentro dela deixa a resposta pronta antes de um vídeo
 * ser aberto.
 *
 * `localStorage` pode estar bloqueado (aba anônima, política do aparelho) — nunca deixamos isso
 * derrubar o layout, só a persistência da preferência.
 */
export function TvLayoutFlag() {
  useEffect(() => {
    iniciarCasca();
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(TV_LAYOUT_STORAGE_KEY);
    } catch {
      // sem storage disponível: segue só com o que a query e o runtime dizem agora.
    }

    const queryValue = new URLSearchParams(window.location.search).get("tv");
    // Build de prévia (AppImage de teste no PC): sem `?tv=1` digitável, o layout liga sozinho.
    const { enabled, store } = resolveTvLayout({ isTv: isTvRuntime() || isTvPreviewBuild(), queryValue, stored });

    if (store) {
      try {
        window.localStorage.setItem(TV_LAYOUT_STORAGE_KEY, store);
      } catch {
        // preferência não gravada: a próxima visita volta a decidir só pelo runtime.
      }
    }

    if (enabled) {
      document.documentElement.dataset.tvLayout = "on";
    } else {
      delete document.documentElement.dataset.tvLayout;
    }

    return () => {
      delete document.documentElement.dataset.tvLayout;
    };
  }, []);

  return null;
}
