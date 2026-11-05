import { apiFetch, isAndroidTvRuntime, isNativeRuntime, isTauriRuntime, isTizenRuntime } from "./api-client";

// Painel "Registro de erros" das configurações do Stremio: o dono só descobre boa parte destes
// erros olhando a TV/projetor, onde não há como copiar nada. Cada aparelho manda o que viu para
// a API (ver apps/api/src/stremio/routes.ts, POST /v1/stremio/diagnostics), e o dono lê pelo PC.
//
// Cada chamada tem que ser barata e nunca travar a tela por causa de um problema secundário —
// por isso o disparo é "fire-and-forget": nenhum retorno é aguardado, e todo erro é engolido.

/**
 * Rótulo curto do aparelho. A ordem importa: `isNativeRuntime` também é verdadeiro para Tauri e
 * Tizen (ver api-client.ts), então os casos mais específicos precisam vir primeiro, ou tudo
 * viraria "app".
 */
function deviceLabel(): string {
  if (typeof navigator === "undefined") return "desconhecido";
  const runtime = isTizenRuntime()
    ? "tizen"
    : isAndroidTvRuntime()
      ? "android-tv"
      : isTauriRuntime()
        ? "pc"
        : isNativeRuntime()
          ? "app"
          : "navegador";
  const userAgent = navigator.userAgent.slice(0, 80);
  return `${runtime} ${userAgent}`;
}

// Dedupe simples: um erro que se repete a cada frame (ex.: onError de vídeo disparando em
// loop) não pode virar uma chamada de rede por ocorrência. A janela é só memória da aba —
// reabrir a página, ou o mesmo erro em outro título, reporta de novo.
const DEDUPE_WINDOW_MS = 5_000;
const recentReports = new Map<string, number>();

function shouldSkip(code: string, message: string): boolean {
  const key = `${code}\u0000${message}`;
  const now = Date.now();
  const last = recentReports.get(key);
  if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return true;
  recentReports.set(key, now);
  // Limpeza oportunista, só quando o mapa cresce: sessões longas não podem reter uma entrada
  // por código de erro para sempre.
  if (recentReports.size > 200) {
    for (const [existingKey, at] of recentReports) {
      if (now - at >= DEDUPE_WINDOW_MS) recentReports.delete(existingKey);
    }
  }
  return false;
}

/**
 * Reporta um erro de reprodução/addon para o "Registro de erros" da casa. Nunca lança: falha de
 * rede aqui não pode competir com o problema real que está sendo reportado.
 */
export function reportDiagnostic(
  code: string,
  message: string,
  context?: Record<string, string>
): void {
  try {
    if (shouldSkip(code, message)) return;
    const body: Record<string, unknown> = {
      code: code.slice(0, 64),
      message: message.slice(0, 300),
      device: deviceLabel()
    };
    // Os limites do servidor (10 chaves, chave 40, valor 200): acima deles o relato INTEIRO era
    // recusado em silêncio — a lista de capítulos passava de 200 e nunca chegava ao registro.
    const entries = Object.entries(context ?? {}).slice(0, 10)
      .map(([key, value]) => [key.slice(0, 40), String(value).slice(0, 200)] as const);
    if (entries.length > 0) body.context = Object.fromEntries(entries);
    void apiFetch("/v1/stremio/diagnostics", {
      method: "POST",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }).catch(() => {});
  } catch {
    // Nunca deixa o relato de diagnóstico virar um novo erro.
  }
}
