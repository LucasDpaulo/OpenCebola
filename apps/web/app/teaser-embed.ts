const APP_IDENTITY_URL = (process.env.NEXT_PUBLIC_OPENCEBOLA_WEB_URL ?? "http://localhost:3000").replace(/\/$/, "");
const YOUTUBE_ORIGIN = "https://www.youtube-nocookie.com";

/**
 * O YouTube só aceita o embed quando o pedido leva um `Referer` http(s) (sem ele: erro 153,
 * "configuração do player de vídeo"). O app do PC roda em `tauri://localhost` (Linux) ou
 * `http(s)://tauri.localhost` (Windows), e nesses casos o trailer passa pela página-ponte do
 * nosso domínio (`public/yt-relay.html`). Celular (`https://localhost`) e site seguem direto.
 */
export function needsYoutubeRelay(location: Pick<Location, "protocol" | "hostname"> | null =
  typeof window === "undefined" ? null : window.location): boolean {
  if (!location) return false;
  return (location.protocol !== "https:" && location.protocol !== "http:") || location.hostname === "tauri.localhost";
}

/** Origem para onde os comandos da API do iframe (play, mudo, seek) devem ser enviados. */
export function youtubeFrameOrigin(relay = needsYoutubeRelay()): string {
  return relay ? APP_IDENTITY_URL : YOUTUBE_ORIGIN;
}

/** Monta o embed com a identidade exigida pelo YouTube em WebViews móveis e desktop. */
export function youtubeEmbedUrl(
  videoId: string,
  parameters: Readonly<Record<string, string>>,
  relay = needsYoutubeRelay()
): string {
  if (relay) {
    const query = new URLSearchParams({ v: videoId, ...parameters });
    return `${APP_IDENTITY_URL}/yt-relay.html?${query.toString()}`;
  }
  const query = new URLSearchParams({
    ...parameters,
    origin: APP_IDENTITY_URL,
    widget_referrer: APP_IDENTITY_URL
  });
  return `${YOUTUBE_ORIGIN}/embed/${encodeURIComponent(videoId)}?${query.toString()}`;
}
