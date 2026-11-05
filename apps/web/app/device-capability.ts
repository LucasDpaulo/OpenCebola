import { isTvRuntime } from "./api-client";

/**
 * Sinal de desempenho do aparelho, não de layout. Largura de tela não entra aqui: um celular
 * moderno e estreito pode ser mais potente que um monitor velho. As trocas de IMAGEM por largura
 * (`max-width`) continuam nos componentes, como sempre foram — isto orienta as preferências de desempenho e se o trailer do
 * YouTube (pesado em aparelhos fracos, referência 2018 / 2-4 GB RAM) deve tocar.
 */
export function isLowEndDevice(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;

  // TV/projetor renderiza numa WebView modesta: o trailer do YouTube e o vídeo de fundo pesam
  // demais. Tratamos como aparelho fraco por origem, sem depender de deviceMemory (que a WebView
  // de TV costuma reportar alto e enganado).
  if (isTvRuntime()) return true;

  const nav = navigator as Navigator & {
    deviceMemory?: number;
    hardwareConcurrency?: number;
    connection?: { saveData?: boolean };
  };

  if (typeof nav.deviceMemory === "number" && nav.deviceMemory <= 4) return true;
  if (typeof nav.hardwareConcurrency === "number" && nav.hardwareConcurrency <= 4) return true;
  if (nav.connection?.saveData === true) return true;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return true;

  return false;
}
