"use client";

import { useEffect, useState } from "react";
import type { DailyFeaturedResponse } from "@cebola/contracts";
import { BrandIcon } from "../brand-icon";
import { TeaserFrame } from "../teaser";
import { LoginForm } from "./login-form";
import { TvPairing } from "./tv-pairing";
import styles from "./page.module.css";
import { apiUrl, isNativeRuntime } from "../api-client";
import { isLowEndDevice } from "../device-capability";


/**
 * Único fundo que mora no repositório, e só existe para o caso de a API não responder. Os
 * teasers `.webm` que ficavam aqui somavam 120 MB versionados, eram servidos pela VM a cada
 * visita e nem chegavam a tocar: o `<source>` declarava `type="video/mp4"` para arquivo WebM,
 * então o navegador baixava dezenas de megabytes e falhava ao decodificar.
 *
 * O arquivo único que sobrou tinha 7000x4667 e 5,2 MB — 70% do export inteiro, versionado e
 * embutido no APK e no AppImage — para desenhar algo que nunca passa da largura da tela. Pior
 * que o download era a decodificação: 7000x4667 em memória são ~130 MB, o bastante para
 * engasgar a abertura em um Android modesto. Agora são três arquivos de 1920 px para baixo,
 * WebP à frente e JPEG atrás para quem não decodifica WebP (TVs antigas, principalmente).
 */
const STATIC_IMAGE_URL = "/background-custom-1920.jpg";
const STATIC_IMAGE_WEBP_URL = "/background-custom-1920.webp";
const STATIC_IMAGE_COMPACT_WEBP_URL = "/background-custom-1280.webp";

function isDailyFeatured(value: unknown): value is DailyFeaturedResponse {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<DailyFeaturedResponse>;
  return typeof item.title === "string" && typeof item.backdropUrl === "string";
}

function EyeIcon() {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

export function LoginExperience() {
  const [featured, setFeatured] = useState<DailyFeaturedResponse | null>(null);
  const [featuredFailed, setFeaturedFailed] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isLoginActive, setIsLoginActive] = useState(false);
  // Dentro do WGT/app nativo, a entrada é parear com o celular (Bearer), não digitar no controle.
  const [native, setNative] = useState(false);
  const [useCredentials, setUseCredentials] = useState(false);

  useEffect(() => {
    if (isNativeRuntime()) {
      setNative(true);
      setIsLoginActive(true);
    }
  }, []);

  // O trailer é pesado (player do YouTube); a decisão de tocá-lo é sobre DESEMPENHO do aparelho,
  // não sobre largura de tela — largura continua decidindo qual imagem carregar (abaixo).
  useEffect(() => {
    if (isLowEndDevice()) setIsVideoEnabled(false);
  }, []);

  // A cena vem do filme em alta da SEMANA no TMDB. É a rota pública da API: sem sessão, sem
  // cookie, e com o resultado em cache por 6 h do lado do servidor.
  useEffect(() => {
    const controller = new AbortController();
    void fetch(apiUrl("/v1/editorial/daily-featured"), {
      headers: { Accept: "application/json" },
      signal: controller.signal
    }).then(async (response) => {
      if (!response.ok) {
        setFeaturedFailed(true);
        return;
      }
      const body = await response.json() as unknown;
      if (isDailyFeatured(body)) setFeatured(body);
      else setFeaturedFailed(true);
    }).catch(() => setFeaturedFailed(true));
    return () => controller.abort();
  }, []);

  // Transition from Welcome mode to Login mode on keydown, click or mouse move
  useEffect(() => {
    if (isLoginActive) {
      function handleEscape(e: KeyboardEvent) {
        if (e.key === "Escape") {
          setIsLoginActive(false);
        }
      }
      window.addEventListener("keydown", handleEscape);
      return () => window.removeEventListener("keydown", handleEscape);
    }

    function handleUserTrigger(e: Event) {
      if (e.target instanceof Element && e.target.closest(`.${styles.header}`)) {
        return;
      }
      setIsLoginActive(true);
    }

    window.addEventListener("keydown", handleUserTrigger);
    window.addEventListener("pointerdown", handleUserTrigger);

    let moveCounter = 0;
    function handleMouseMove(e: MouseEvent) {
      if (e.target instanceof Element && e.target.closest(`.${styles.header}`)) {
        return;
      }
      moveCounter++;
      if (moveCounter > 4) {
        setIsLoginActive(true);
      }
    }
    window.addEventListener("mousemove", handleMouseMove);

    return () => {
      window.removeEventListener("keydown", handleUserTrigger);
      window.removeEventListener("pointerdown", handleUserTrigger);
      window.removeEventListener("mousemove", handleMouseMove);
    };
  }, [isLoginActive]);

  const stillUrl = featured?.backdropUrl ?? STATIC_IMAGE_URL;
  const compactStillUrl = featured?.backdropPreviewUrl ?? stillUrl;
  // O WebP local só entra quando o fundo é o nosso: o backdrop do TMDB já vem dimensionado e
  // não tem variante WebP nossa para oferecer.
  const usingLocalBackground = !featured;
  const trailerKey = featured?.trailerKey ?? null;
  const showTrailer = isVideoEnabled && trailerKey !== null;

  return (
    <main className={styles.page}>
      {/* Background cinematic media with toggleable trailer / still frame */}
      <div className={styles.cinematicBackground} aria-hidden="true">
        {/* A cena parada fica SEMPRE embaixo, nunca no lugar do trailer. Trocar uma pela outra
            deixava a tela inteira preta sempre que o quadro do YouTube não subia — bloqueador
            de anúncio, rede ruim, vídeo removido — e o login virava um retângulo vazio. */}
        {featured || featuredFailed ? (
          <picture>
            {usingLocalBackground ? (
              <>
                <source media="(max-width: 1366px)" type="image/webp" srcSet={STATIC_IMAGE_COMPACT_WEBP_URL} />
                <source type="image/webp" srcSet={STATIC_IMAGE_WEBP_URL} />
              </>
            ) : (
              <source media="(max-width: 1366px)" srcSet={compactStillUrl} />
            )}
            <img src={stillUrl} alt="" className={styles.bgImage} />
          </picture>
        ) : null}
        {showTrailer ? (
          <TeaserFrame
            videoId={trailerKey}
            label={`Trailer de ${featured?.title ?? "destaque da semana"}`}
            className={styles.bgIframe}
          />
        ) : null}
        <div className={styles.videoOverlay} />
      </div>

      <header className={styles.header}>
        <a className={styles.brand} href="/" aria-label="Cebola">
          <BrandIcon size={38} className={styles.brandIcon} />
        </a>

        <div className={styles.headerActions}>
          <a
            className={styles.downloadButton}
            href="/download/index.html"
            aria-label="Baixar os aplicativos Cebola (celular, projetor/TV e PC)"
            title="Baixar aplicativos"
          >
            <span aria-hidden="true">↓</span>
          </a>
          {trailerKey ? (
            <button
              type="button"
              className={styles.glassIconButton}
              onClick={() => setIsVideoEnabled((enabled) => !enabled)}
              aria-pressed={isVideoEnabled}
              aria-label={isVideoEnabled ? "Pausar trailer e exibir imagem de fundo" : "Reproduzir trailer de fundo"}
              title={isVideoEnabled ? "Pausar trailer e ver imagem" : "Reproduzir trailer"}
            >
              {isVideoEnabled ? <EyeIcon /> : <EyeOffIcon />}
            </button>
          ) : null}
        </div>
      </header>

      {isLoginActive ? (
        <div className={styles.centeredLoginContainer}>
          <div className={styles.cardContainer}>
            {native && !useCredentials ? (
              <TvPairing onUseCredentials={() => setUseCredentials(true)} />
            ) : (
              <LoginForm />
            )}
            {native ? null : (
              <button
                type="button"
                className={styles.backButton}
                onClick={() => setIsLoginActive(false)}
              >
                ← Voltar à tela inicial
              </button>
            )}
          </div>
        </div>
      ) : featured ? (
        // Dizer que filme é esse: sem isso a tela busca a cena, mostra a cena e some com a
        // única informação que a consulta trouxe. Só aparece antes do login, para não competir
        // com o formulário.
        <div className={styles.featuredCaption}>
          <span className={styles.featuredKicker}>Em alta esta semana</span>
          <strong className={styles.featuredTitle}>{featured.title}</strong>
        </div>
      ) : null}
    </main>
  );
}
