"use client";

import { useEffect, useRef } from "react";

/** Alternar de janela várias vezes seguidas não pode virar uma rajada de leituras. */
const MIN_INTERVAL_MS = 30_000;

/**
 * Chama `onReturn` quando o app ou a aba volta para a frente (celular saindo do segundo plano,
 * aba reaberta, janela do PC focada de novo). No celular a tela fica de pé por horas: sem isto
 * ela mostrava o progresso de quando foi aberta, não o que outro aparelho gravou depois.
 */
export function useReturnToForeground(onReturn: () => void): void {
  const callback = useRef(onReturn);
  callback.current = onReturn;
  useEffect(() => {
    let last = Date.now();
    const handle = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - last < MIN_INTERVAL_MS) return;
      last = now;
      callback.current();
    };
    document.addEventListener("visibilitychange", handle);
    window.addEventListener("focus", handle);
    return () => {
      document.removeEventListener("visibilitychange", handle);
      window.removeEventListener("focus", handle);
    };
  }, []);
}
