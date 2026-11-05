"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTvLayout } from "./tv/use-tv-layout";
import { useWebTrailers } from "./use-web-trailers";
import { youtubeEmbedUrl, youtubeFrameOrigin } from "./teaser-embed";

interface TeaserFrameProps {
  readonly videoId: string;
  readonly label: string;
  /** Ligado, o quadro recebe o comando de tirar o mudo assim que o player estiver pronto. */
  readonly sound?: boolean;
  readonly className?: string;
  /** Segundo em que o trailer deve começar para pular vinhetas e cartões de estúdio (padrão: 3s). */
  readonly startSeconds?: number;
  /** Se deve exibir os botões de áudio e expansão sobre o teaser (padrão: true). */
  readonly showControls?: boolean;
  /** Notifica quando o modal expandido abre ou fecha para pausar carrosséis e timers externos. */
  readonly onModalChange?: (isOpen: boolean) => void;
}

/**
 * Trailer do TMDB tocando como pano de fundo com controle de som e modo expandido.
 */
export function TeaserFrame(props: TeaserFrameProps) {
  const tv = useTvLayout();
  const allowed = useWebTrailers(tv);
  return allowed ? <WebTeaserFrame {...props} /> : null;
}

function WebTeaserFrame({
  videoId,
  label,
  sound = false,
  className,
  startSeconds = 3,
  showControls = true,
  onModalChange
}: TeaserFrameProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState(false);
  const [isMuted, setIsMuted] = useState(!sound);
  const [isModalOpen, setIsModalOpen] = useState(false);

  useEffect(() => {
    setReady(false);
    setVisible(false);
  }, [videoId]);

  // Trocar apenas o áudio não pode reinicializar nem esconder o iframe. O clique do usuário
  // preserva o ponto atual do trailer e somente envia mute/unMute ao player já carregado.
  useEffect(() => setIsMuted(!sound), [sound]);

  // O player do YouTube entra tocando e aparece suavemente assim que carrega
  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => setVisible(true), 450);
    return () => window.clearTimeout(timer);
  }, [ready]);

  const sendCommand = (func: string, args: unknown[] = []) => {
    try {
      const alvo = frame.current?.contentWindow;
      alvo?.postMessage(
        JSON.stringify({ event: "command", func, args }),
        youtubeFrameOrigin()
      );
    } catch {
      // Ignora falhas de comunicação sem quebrar a página
    }
  };

  // Inicialização do vídeo no YouTube (seek e autoplay)
  useEffect(() => {
    if (!ready) return;
    const comandos = [
      JSON.stringify({ event: "command", func: isMuted ? "mute" : "unMute", args: [] }),
      JSON.stringify({ event: "command", func: "seekTo", args: [startSeconds, true] }),
      JSON.stringify({ event: "command", func: "playVideo", args: [] })
    ];
    const send = () => {
      try {
        const alvo = frame.current?.contentWindow;
        for (const comando of comandos) alvo?.postMessage(comando, youtubeFrameOrigin());
      } catch {
        // Sem quebrar a página
      }
    };
    send();
    const retries = [200, 700].map((delay) => window.setTimeout(send, delay));
    return () => retries.forEach((timer) => window.clearTimeout(timer));
  }, [ready, startSeconds, videoId]);

  // Apenas controle de volume/mudo sem reiniciar o vídeo
  useEffect(() => {
    if (!ready) return;
    sendCommand(isMuted ? "mute" : "unMute");
    if (!isMuted) sendCommand("setVolume", [100]);
  }, [ready, isMuted]);

  const toggleSound = (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    sendCommand(nextMuted ? "mute" : "unMute");
    if (!nextMuted) sendCommand("setVolume", [100]);
  };

  const openExpandedModal = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Muta o teaser de fundo enquanto o modal em tela grande estiver aberto
    sendCommand("mute");
    setIsModalOpen(true);
    onModalChange?.(true);
  };

  const closeExpandedModal = () => {
    setIsModalOpen(false);
    onModalChange?.(false);
    if (!isMuted) sendCommand("unMute");
  };

  useEffect(() => {
    if (!isModalOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeExpandedModal();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isModalOpen]);

  const parameters = {
    autoplay: "1",
    mute: "1",
    // Pula vinhetas de estúdio, marcas de introdução ou quadros pretos iniciais do YouTube
    start: String(startSeconds),
    controls: "0",
    loop: "1",
    playlist: videoId,
    playsinline: "1",
    rel: "0",
    modestbranding: "1",
    disablekb: "1",
    iv_load_policy: "3",
    cc_load_policy: "0",
    fs: "0",
    enablejsapi: "1"
  };

  return (
    <>
      <iframe
        ref={frame}
        className={className ?? "teaser-frame"}
        src={youtubeEmbedUrl(videoId, parameters)}
        title={label}
        allow="autoplay; encrypted-media"
        referrerPolicy="strict-origin-when-cross-origin"
        tabIndex={-1}
        aria-hidden="true"
        style={{ opacity: visible ? 1 : 0, transition: "opacity 0.45s ease" }}
        onLoad={() => setReady(true)}
      />

      {showControls && visible && (
        <div className={`teaser-controls${visible ? " is-visible" : ""}`} aria-label="Controles do teaser">
          <button
            type="button"
            className="teaser-control-btn"
            onClick={toggleSound}
            aria-label={isMuted ? "Ativar áudio do teaser" : "Desativar áudio do teaser"}
            title={isMuted ? "Ativar áudio" : "Silenciar"}
          >
            {isMuted ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="23" y1="9" x2="17" y2="15" />
                <line x1="17" y1="9" x2="23" y2="15" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
              </svg>
            )}
          </button>

          <button
            type="button"
            className="teaser-control-btn"
            onClick={openExpandedModal}
            aria-label="Assistir trailer ampliado em pop-up"
            title="Assistir trailer ampliado"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>
        </div>
      )}

      {isModalOpen && typeof document !== "undefined" && createPortal(
        <div
          className="teaser-modal-backdrop"
          onClick={closeExpandedModal}
          role="dialog"
          aria-modal="true"
          aria-label={label}
        >
          <div className="teaser-modal-container" onClick={(e) => e.stopPropagation()}>
            <div className="teaser-modal-header">
              <h3 className="teaser-modal-title">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
                {label}
              </h3>
              <button
                type="button"
                className="teaser-modal-close"
                onClick={closeExpandedModal}
                aria-label="Fechar trailer"
                title="Fechar (Esc)"
              >
                ✕
              </button>
            </div>
            <div className="teaser-modal-video">
              <iframe
                src={youtubeEmbedUrl(videoId, {
                  autoplay: "1", mute: "0", controls: "1", rel: "0", modestbranding: "1", playsinline: "1"
                })}
                title={label}
                allow="autoplay; encrypted-media; fullscreen"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
              />
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

/**
 * Espera antes de começar o teaser. Passar o ponteiro por cima de uma rail inteira não pode
 * disparar oito vídeos: só a parada deliberada em um card conta como interesse.
 */
export function useDelayedFlag(active: boolean, delayMs: number, resetKey?: string): boolean {
  const [reached, setReached] = useState(false);

  useEffect(() => {
    if (!active) {
      setReached(false);
      return;
    }
    // `resetKey` existe para o banner: ele troca de filme sozinho, e sem reiniciar a contagem
    // o trailer seguinte começaria no mesmo instante da troca, por cima da imagem entrando.
    setReached(false);
    const timer = window.setTimeout(() => setReached(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs, resetKey]);

  return reached;
}
