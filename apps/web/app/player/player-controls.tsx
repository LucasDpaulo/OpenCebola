"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import type { NativePlayer, PlayerEvents, PlayerListener, PlayerTrack } from "./native-player";
import { nextSubtitleId, trackLanguage } from "./subtitle-selection";
import { applyAudioTrackSelection, applySubtitleTrackSelection } from "./player-controls-scenario";
import type { PlaybackScenarioPatch } from "./playback-scenario";
import { PlaybackWakeLock } from "./playback-wake-lock";
import { reducePlayerOverlay, type PlayerOverlayEvent } from "./player-overlay-state";
import { createTauriPlaybackWakeLock } from "./tauri-playback-inhibit";
import { filterSourceOptionsBySubtitle, type PlayerSourceOption } from "./player-source-options";
import { isTauriRuntime } from "../api-client";
import { isLowEndDevice } from "../device-capability";
import { shouldPublishPlayerPosition } from "./player-update-policy";
import { reportDiagnostic } from "../diagnostics";
import {
  ajustesIniciais, gravarAjustesDoAparelho, lerAjustesDoAparelho, paraOCenario, soDoAparelho,
  type SubtitleSettings
} from "./regras/ajustes-legenda";

/** `localStorage` do aparelho, ou null onde não existe/está bloqueado. */
function armazenamentoLocal(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}
import { resolveTvSubtitleStyle, tvSubtitleFontSize } from "./tv-subtitle-style";
import { BrandIcon } from "../brand-icon";
import { useTvLayout } from "../tv/use-tv-layout";
import { findAdjacentTvZoneIndex } from "../tv/tv-zone-navigation";
import { formatTvSeekOffset, tvHoldSeekStep } from "./tv-seek";
import { sourceReleaseTags } from "./source-tags";
import { splitSubtitleLabel } from "./subtitle-label";
import {
  activeSkipSegment,
  canAdvanceOnEnded,
  isManualEndingVisit,
  skipBlockLabel,
  nextEpisodeCountdownStart,
  nextEpisodePromptStart,
  nextEpisodePromptState,
  shouldAutoSkipOpening,
  shouldResetNextEpisodeCancel,
  skipButtonVisible,
  AUTO_SKIP_COUNTDOWN_SECONDS,
  NEXT_EPISODE_COUNTDOWN_SECONDS,
  type SkipBlock
} from "./pulos/skip-segments";
import { inicioDaVinheta } from "./regras/inicio";
import styles from "./player-controls.module.css";

function clock(seconds: number): string {
  const value = Math.max(0, Math.round(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remaining = value % 60;
  const twoDigits = (part: number) => String(part).padStart(2, "0");
  return hours > 0 ? `${hours}:${twoDigits(minutes)}:${twoDigits(remaining)}` : `${minutes}:${twoDigits(remaining)}`;
}

type OpenMenu = "languages" | "info" | "speed" | "episodes" | null;
type TapSide = "left" | "center" | "right";

// ---------------------------------------------------------------------------
// Navegação por controle remoto (TV, Task 4) — funções puras de DOM, sem estado React: dado o
// elemento focado agora, decidem para ONDE o foco vai a seguir. Cada "linha" (`[data-tv-row]`)
// ou "coluna" (`[data-tv-col]`) do overlay de TV é um contêiner com botões/inputs dentro; ↑/↓
// trocam de linha (ou de item dentro de uma coluna), ←/→ trocam de item dentro da linha (ou de
// coluna). Reaproveita `findAdjacentTvZoneIndex` (mesma conta da home) para pular contêineres
// vazios sem travar a navegação.
const TV_FOCUS_SELECTOR = 'button:not(:disabled), input[type="range"]:not(:disabled)';

function tvFocusablesIn(container: Element): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(TV_FOCUS_SELECTOR)];
}

function tvFirstFocusable(container: Element | null | undefined): HTMLElement | null {
  if (!container) return null;
  return container.querySelector<HTMLElement>(TV_FOCUS_SELECTOR);
}

/** Anda entre contêineres irmãos (linhas ou colunas), pulando os que não têm nada focável. */
function tvMoveAcrossContainers(containers: HTMLElement[], current: Element | null, direction: "up" | "down"): boolean {
  const hasFocusable = containers.map((container) => tvFirstFocusable(container) !== null);
  const currentContainer = current instanceof HTMLElement ? current.closest<HTMLElement>("[data-tv-row],[data-tv-col]") : null;
  const currentIndex = currentContainer ? containers.indexOf(currentContainer) : -1;
  const nextIndex = findAdjacentTvZoneIndex(hasFocusable, currentIndex, direction);
  if (nextIndex === null) return true;
  tvFocusVisible(tvFirstFocusable(containers[nextIndex]));
  return true;
}

/** Foca sem a rolagem suave do navegador e traz o item pra vista dentro da lista que rola. */
function tvFocusVisible(element: HTMLElement | null | undefined): void {
  if (!element) return;
  element.focus({ preventScroll: true });
  element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
}

/**
 * Legenda com marcação (`<i>…</i>`, `<b>`, `{\an8}` do ASS) chegava crua na tela. Itálico vira
 * itálico de verdade; o resto das tags some.
 */
function renderCueText(text: string): ReactNode {
  const clean = text.replace(/\{\\[^}]*\}/g, "").replace(/<(?!\/?i\b)[^>]*>/gi, "");
  let italic = false;
  return clean.split(/(<\/?i\b[^>]*>)/i).map((part, index) => {
    if (/^<i\b/i.test(part)) { italic = true; return null; }
    if (/^<\/i/i.test(part)) { italic = false; return null; }
    return part ? (italic ? <em key={index}>{part}</em> : <Fragment key={index}>{part}</Fragment>) : null;
  });
}

/** Anda entre os itens focáveis DENTRO do mesmo contêiner (linha ou coluna). */
function tvMoveWithinContainer(active: HTMLElement, containerSelector: string, delta: number): boolean {
  const container = active.closest<HTMLElement>(containerSelector);
  if (!container) return false;
  const items = tvFocusablesIn(container);
  const currentIndex = items.indexOf(active);
  if (currentIndex === -1) return false;
  const nextIndex = Math.max(0, Math.min(items.length - 1, currentIndex + delta));
  tvFocusVisible(items[nextIndex]);
  return true;
}

function visibleLanguage(track: PlayerTrack): string {
  const language = trackLanguage(track);
  if (language === "pt-BR") return "Português (Brasil)";
  if (language === "pt") return "Português";
  if (language === "en") return "Inglês";
  if (language === "es") return "Espanhol";
  if (language === "fr") return "Francês";
  if (language === "it") return "Italiano";
  if (language === "de") return "Alemão";
  if (language === "ja") return "Japonês";
  if (language === "ko") return "Coreano";
  return language?.toUpperCase() || "Idioma não informado";
}

export interface PlayerEpisode {
  readonly id: string;
  readonly title: string;
  readonly season: number | null;
  readonly episode: number | null;
  readonly displayEpisode?: number | null;
  readonly thumbnail: string | null;
}

export { DEFAULT_SUBTITLE_SETTINGS, type SubtitleSettings } from "./regras/ajustes-legenda";

export interface PlayerControlsProps {
  readonly player: NativePlayer;
  readonly title: string;
  readonly episodeLabel?: string | null;
  readonly previousEpisodeLabel?: string | null;
  readonly nextEpisodeLabel?: string | null;
  readonly synopsis?: string | null;
  readonly backdropUrl?: string | null;
  readonly source: { addon: string; quality: string; details: string; label: string; readyNow: boolean };
  readonly sourceOptions?: readonly PlayerSourceOption[];
  readonly originalLanguage?: string | null;
  readonly currentSourceId?: string;
  readonly onSelectSource?: (id: string) => Promise<void> | void;
  readonly onPreviousEpisode?: () => void;
  readonly onNextEpisode?: () => void;
  readonly onClose: () => void;
  readonly episodes?: readonly PlayerEpisode[];
  readonly currentVideoId?: string;
  readonly onSelectEpisode?: (id: string) => void;
  readonly subtitleSettings?: SubtitleSettings;
  readonly onSubtitleSettingsChange?: (settings: SubtitleSettings) => void;
  /** Emitido somente após a operação de áudio/legenda/ajustes ser bem-sucedida no player. */
  readonly onScenarioChange?: (patch: PlaybackScenarioPatch) => void;
  /** Blocos de abertura/recapitulação/encerramento já mesclados (ver `mergeOpeningSegments`). */
  readonly skipBlocks?: readonly SkipBlock[];
  /** A pessoa buscou um ponto de propósito (barra, ±10 s): libera a guarda do ponto salvo (ver regras/guarda-do-ponto-salvo). Pulos de abertura/encerramento não contam. */
  readonly onSeek?: () => void;
}

// ---------------------------------------------------------------------------
// SVG Icon Components
// ---------------------------------------------------------------------------

function IconNetflixPlay({ className }: { className?: string }) {
  return (
    <svg className={className} width="48" height="48" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <polygon points="6 3 20 12 6 21 6 3" />
    </svg>
  );
}

function IconNetflixPause({ className }: { className?: string }) {
  return (
    <svg className={className} width="48" height="48" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="5.5" y="3" width="4" height="18" rx="1.5" />
      <rect x="14.5" y="3" width="4" height="18" rx="1.5" />
    </svg>
  );
}

function IconNetflixReplay10({ className }: { className?: string }) {
  return (
    <svg className={className} width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" aria-hidden="true">
      <path
        d="M24 8 A 16 16 0 1 0 38 18"
        strokeWidth="2.8"
        strokeLinecap="round"
      />
      <path
        d="M26 4 L20 8 L26 12 M32 4 L26 8 L32 12"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text
        x="24"
        y="29.5"
        fontSize="13"
        fontWeight="800"
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontFamily="Inter, ui-sans-serif, system-ui, sans-serif"
      >
        10
      </text>
    </svg>
  );
}

function IconNetflixForward10({ className }: { className?: string }) {
  return (
    <svg className={className} width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" aria-hidden="true">
      <path
        d="M24 8 A 16 16 0 1 1 10 18"
        strokeWidth="2.8"
        strokeLinecap="round"
      />
      <path
        d="M22 4 L28 8 L22 12 M16 4 L22 8 L16 12"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text
        x="24"
        y="29.5"
        fontSize="13"
        fontWeight="800"
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontFamily="Inter, ui-sans-serif, system-ui, sans-serif"
      >
        10
      </text>
    </svg>
  );
}

function IconClose({ className }: { className?: string }) {
  return (
    <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

// Seta de "Voltar" da TV (topo à esquerda) — distinta do "X" de fechar do PC/celular.
function IconTvBack({ className }: { className?: string }) {
  return (
    <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="11 6 5 12 11 18" />
    </svg>
  );
}

function IconVolumeHigh({ className }: { className?: string }) {
  return (
    <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  );
}

function IconVolumeMute({ className }: { className?: string }) {
  return (
    <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
      <line x1="23" y1="9" x2="17" y2="15" />
      <line x1="17" y1="9" x2="23" y2="15" />
    </svg>
  );
}

function IconSubtitles({ className }: { className?: string }) {
  return (
    <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="4" width="20" height="16" rx="3" />
      <path d="M7 10h4" />
      <path d="M7 14h2" />
      <path d="M15 10h2" />
      <path d="M13 14h4" />
    </svg>
  );
}

function IconPreviousEpisode({ className }: { className?: string }) {
  return (
    <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="4" y="4" width="3" height="16" rx="1" />
      <polygon points="19 4 9 12 19 20 19 4" />
    </svg>
  );
}

function IconNextEpisode({ className }: { className?: string }) {
  return (
    <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <polygon points="5 4 15 12 5 20 5 4" />
      <rect x="17" y="4" width="3" height="16" rx="1" />
    </svg>
  );
}

function IconFullscreen({ className }: { className?: string }) {
  return (
    <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <polyline points="21 15 21 21 15 21" />
      <polyline points="3 9 3 3 9 3" />
    </svg>
  );
}

function IconExitFullscreen({ className }: { className?: string }) {
  return (
    <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <polyline points="14 20 14 14 20 14" />
      <polyline points="10 4 10 10 4 10" />
    </svg>
  );
}

function IconLock({ className }: { className?: string }) {
  return (
    <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function IconSun({ className }: { className?: string }) {
  return (
    <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function IconInfo({ className }: { className?: string }) {
  return (
    <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

function IconEpisodes({ className }: { className?: string }) {
  return (
    <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="20" height="18" rx="2" />
      <line x1="8" y1="3" x2="8" y2="21" />
      <line x1="14" y1="3" x2="14" y2="21" />
    </svg>
  );
}

function IconSpeed({ className }: { className?: string }) {
  return (
    <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function IconCheck({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function IconGear({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
const SUBTITLE_COLORS = [
  { label: "Branco", value: "#ffffff" },
  { label: "Amarelo Ouro", value: "#facc15" },
  { label: "Verde Claro", value: "#86efac" },
  { label: "Ciano", value: "#67e8f9" },
  { label: "Âmbar", value: "#fbbf24" }
] as const;

/** Anda `delta` posições numa lista de opções, parando nas pontas (sem dar a volta). */
function stepOption<T>(options: readonly T[], current: T, delta: number): T {
  const index = Math.max(0, options.indexOf(current));
  return options[Math.max(0, Math.min(options.length - 1, index + delta))]!;
}

/**
 * Linha de Ajustes da TV: nome à esquerda, valor atual entre ‹ › à direita. ↑/↓ trocam de linha
 * (navegação por linhas do player); ←/→ mudam o valor (aqui); OK/clique avança uma opção.
 */
function TvSettingStepper({ label, value, onStep }: {
  readonly label: string;
  readonly value: ReactNode;
  readonly onStep: (delta: -1 | 1) => void;
}) {
  return (
    <div className={styles.tvSettingsSection} data-tv-row>
      <span className={styles.tvSettingsLabel}>{label}</span>
      <button
        type="button"
        className={styles.tvStepper}
        aria-label={label}
        onClick={() => onStep(1)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          onStep(event.key === "ArrowLeft" ? -1 : 1);
        }}
      >
        <span className={styles.tvStepperArrow} aria-hidden="true">‹</span>
        <span className={styles.tvStepperValue}>{value}</span>
        <span className={styles.tvStepperArrow} aria-hidden="true">›</span>
      </button>
    </div>
  );
}

/** Controles de alto padrão compartilhados por Android, PC e TV. */

const TV_SUBTITLE_FONTS = [
  ["netflix", "Padrão Netflix"], ["arial", "Arial"], ["roboto", "Roboto"], ["serif", "Serifada"], ["mono", "Monoespaçada"], ["casual", "Casual"]
] as const;
const TV_SUBTITLE_EDGES = [
  ["netflix", "Netflix"], ["outline", "Contorno forte"], ["shadow", "Sombra"], ["none", "Nenhum"]
] as const;
const TV_SUBTITLE_BACKGROUNDS = [
  ["transparent", "Nenhum"], ["translucent", "Translúcido"], ["solid", "Sólido"]
] as const;

/** Próximo valor de um filtro que a TV alterna com OK (volta ao primeiro depois do último). */
function cycleOption<T>(values: readonly T[], current: T): T {
  return values[(values.indexOf(current) + 1) % values.length]!;
}

export function PlayerControls({
  player,
  title,
  episodeLabel,
  previousEpisodeLabel,
  nextEpisodeLabel,
  synopsis,
  backdropUrl,
  source,
  sourceOptions = [],
  originalLanguage = null,
  currentSourceId,
  onSelectSource,
  onPreviousEpisode,
  onNextEpisode,
  onClose,
  episodes,
  currentVideoId,
  onSelectEpisode,
  subtitleSettings: initialSettings,
  onSubtitleSettingsChange,
  onScenarioChange,
  skipBlocks = [],
  onSeek
}: PlayerControlsProps) {
  // Layout de TV (Task 4, plano de 27/09): controles limpos + navegação por controle remoto.
  // PC e celular não leem esta flag em NENHUM ponto do JSX abaixo — ela só decide QUAL bloco
  // renderiza, nunca altera o bloco de sempre.
  const tv = useTvLayout();
  const [mounted, setMounted] = useState(false);
  const [lowPower, setLowPower] = useState(false);
  useEffect(() => { setLowPower(isLowEndDevice()); }, []);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(() => player.state().playing);
  const [audio, setAudio] = useState<readonly PlayerTrack[]>([]);
  const [subtitles, setSubtitles] = useState<readonly PlayerTrack[]>([]);
  const [audioTrack, setAudioTrack] = useState<string | null>(null);
  const [subtitleTrack, setSubtitleTrack] = useState<string | null>(null);
  const [activeCues, setActiveCues] = useState<readonly { id: string; text: string }[]>([]);
  const [menu, setMenu] = useState<OpenMenu>(null);
  // Na TV, só português aparece de início na aba Legendas; o resto abre com "Outros idiomas".
  const [tvShowOtherSubtitles, setTvShowOtherSubtitles] = useState(false);
  const [languageTab, setLanguageTab] = useState<"audio" | "subtitles" | "sources" | "settings">("audio");
  const [sourceLanguage, setSourceLanguage] = useState<"all" | "pt" | "en">("all");
  const [sourceSubtitleLanguage, setSourceSubtitleLanguage] = useState<"all" | "pt" | "en">("all");
  const [sourceQuality, setSourceQuality] = useState<"all" | "4K" | "1080p">("all");
  const [error, setError] = useState<string | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [locked, setLocked] = useState(false);
  const [lockVisible, setLockVisible] = useState(false);
  const [unlockProgress, setUnlockProgress] = useState(0);
  const [brightness, setBrightness] = useState(0.8);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showRemainingTime, setShowRemainingTime] = useState(false);
  const [quickSeekSide, setQuickSeekSide] = useState<"left" | "right" | null>(null);
  const [quickSeekSeconds, setQuickSeekSeconds] = useState(10);
  const [gestureHUD, setGestureHUD] = useState<{ type: "brightness" | "volume"; value: number } | null>(null);
  const [hoverTimeline, setHoverTimeline] = useState<{ seconds: number; percent: number } | null>(null);
  const [pauseIdleActive, setPauseIdleActive] = useState(false);
  const [hudNotice, setHudNotice] = useState<string | null>(null);
  const hudNoticeTimer = useRef<number | null>(null);

  const showHudNotice = useCallback((text: string) => {
    setHudNotice(text);
    if (hudNoticeTimer.current) window.clearTimeout(hudNoticeTimer.current);
    hudNoticeTimer.current = window.setTimeout(() => setHudNotice(null), 2_800);
  }, []);

  // Configurações personalizadas de legendas
  const [subtitleSettings, setSubtitleSettings] = useState<SubtitleSettings>(() => {
    const aparelho = lerAjustesDoAparelho(armazenamentoLocal());
    if (initialSettings) return { ...initialSettings, ...soDoAparelho(aparelho), position: initialSettings.position ?? aparelho.position ?? 0 };
    return ajustesIniciais({ continuidade: null, salvo: null, aparelho });
  });


  // Preferência "pular abertura automaticamente" (task 4). Por aparelho, nunca por conta — daí
  // `localStorage` e não `onScenarioChange` (que salvaria no servidor, atrelado ao perfil).
  const [autoSkipIntro, setAutoSkipIntroState] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      try {
        // Ligado por padrão: agora há 2 s de contagem com "Cancelar" antes de pular.
        return window.localStorage.getItem("cebola:player:auto_skip_intro") !== "0";
      } catch { /* ignore */ }
    }
    return false;
  });

  const setAutoSkipIntro = useCallback((value: boolean) => {
    setAutoSkipIntroState(value);
    try {
      window.localStorage.setItem("cebola:player:auto_skip_intro", value ? "1" : "0");
    } catch { /* ignore */ }
  }, []);

  const tvSubtitleStyle = resolveTvSubtitleStyle(subtitleSettings.fontFace, subtitleSettings.edge);

  const applySubtitleSettings = useCallback((newSettings: SubtitleSettings) => {
    setSubtitleSettings(newSettings);
    onSubtitleSettingsChange?.(newSettings);
    onScenarioChange?.({ subtitleSettings: paraOCenario(newSettings) });
    gravarAjustesDoAparelho(armazenamentoLocal(), newSettings);
  }, [onScenarioChange, onSubtitleSettingsChange]);

  const updateSubtitleOffset = useCallback((deltaOrExact: number, isExact = false) => {
    const nextOffset = isExact ? deltaOrExact : Math.round((subtitleSettings.offset + deltaOrExact) * 10) / 10;
    const clamped = Math.max(-10, Math.min(10, nextOffset));
    applySubtitleSettings({ ...subtitleSettings, offset: clamped });
  }, [applySubtitleSettings, subtitleSettings]);

  const chooseAudio = useCallback(async (id: string) => {
    const selected = audio.find((track) => track.id === id);
    if (!selected) return;
    try {
      const result = await applyAudioTrackSelection(player, selected, subtitles, subtitleTrack);
      setAudioTrack(result.audioTrackId);
      setSubtitleTrack(result.subtitleTrackId);
      onScenarioChange?.(result.patch);
    } catch {
      setError("Não foi possível trocar a trilha de áudio.");
    }
  }, [audio, onScenarioChange, player, subtitleTrack, subtitles]);

  const chooseSubtitle = useCallback(async (id: string | null) => {
    try {
      const result = await applySubtitleTrackSelection(player, subtitles, id);
      setSubtitleTrack(result.subtitleTrackId);
      if (id === null) setActiveCues([]);
      onScenarioChange?.(result.patch);
    } catch {
      setError("Não foi possível trocar a legenda.");
    }
  }, [onScenarioChange, player, subtitles]);

  const testNextSubtitle = useCallback(async () => {
    const nextId = nextSubtitleId(
      subtitles.map((track) => ({ id: track.id, language: track.language ?? "", label: track.label })),
      subtitleTrack
    );
    if (nextId === null) return;
    await chooseSubtitle(nextId);
    updateSubtitleOffset(0, true);
  }, [chooseSubtitle, subtitleTrack, subtitles, updateSubtitleOffset]);

  const resetSubtitleTiming = useCallback(() => {
    applySubtitleSettings({ ...subtitleSettings, offset: 0, extraDuration: 0 });
    showHudNotice("Atraso e duração extra zerados. Usando os tempos originais da legenda.");
  }, [applySubtitleSettings, showHudNotice, subtitleSettings]);

  const toggleSubtitlesShortcut = useCallback(async () => {
    if (subtitles.length === 0) {
      showHudNotice("Nenhuma legenda disponível");
      return;
    }
    if (subtitleTrack === null) {
      const best = subtitles.find((s) => {
        const lang = trackLanguage(s);
        return lang === "pt-BR" || lang === "pt" || s.label.toLowerCase().includes("portugu");
      }) ?? subtitles[0];
      if (best) {
        await chooseSubtitle(best.id);
        showHudNotice(`Legenda: ${best.label}`);
      }
    } else {
      await chooseSubtitle(null);
      showHudNotice("Legenda desativada");
    }
  }, [chooseSubtitle, showHudNotice, subtitleTrack, subtitles]);

  // Temporada ativa e controle de episódios
  const currentEpisode = useMemo(() => {
    return episodes?.find((ep) => ep.id === currentVideoId) ?? null;
  }, [currentVideoId, episodes]);

  const defaultSeason = useMemo(() => {
    if (currentEpisode?.season !== null && currentEpisode?.season !== undefined) {
      return currentEpisode.season;
    }
    const firstRegular = episodes?.find((ep) => ep.season !== null && ep.season !== 0);
    return firstRegular?.season ?? episodes?.[0]?.season ?? 1;
  }, [currentEpisode, episodes]);

  const [selectedSeason, setSelectedSeason] = useState<number>(defaultSeason);

  // Sincroniza a temporada quando o episódio atual ou a lista mudarem
  useEffect(() => {
    if (currentEpisode?.season !== null && currentEpisode?.season !== undefined) {
      setSelectedSeason(currentEpisode.season);
    }
  }, [currentEpisode]);

  const availableSeasons = useMemo(() => {
    if (!episodes) return [];
    const seasons = Array.from(new Set(episodes.map((ep) => ep.season).filter((s): s is number => s !== null && s !== undefined)));
    return seasons.sort((a, b) => {
      if (a === 0) return 1;
      if (b === 0) return -1;
      return a - b;
    });
  }, [episodes]);

  const filteredEpisodes = useMemo(() => {
    if (!episodes) return [];
    if (availableSeasons.length <= 1) return episodes;
    return episodes.filter((ep) => ep.season === selectedSeason);
  }, [availableSeasons.length, episodes, selectedSeason]);

  const filteredSources = useMemo(() => filterSourceOptionsBySubtitle(sourceOptions.filter((option) => {
    const languages = option.audioLanguages.map((language) => language.toLowerCase());
    const matchesLanguage = sourceLanguage === "all" || languages.some((language) => sourceLanguage === "pt"
      ? /^(?:pt|por|pob|pb)(?:[-_].*)?$/.test(language)
      : /^(?:en|eng)(?:[-_].*)?$/.test(language));
    return matchesLanguage && (sourceQuality === "all" || option.quality === sourceQuality);
  }), sourceSubtitleLanguage), [sourceLanguage, sourceOptions, sourceQuality, sourceSubtitleLanguage]);
  // O player do navegador (TV Samsung) não enxerga as faixas de áudio de dentro do MKV — toca só a
  // principal e a lista vem vazia. Para a aba não dizer "nenhuma trilha" com som saindo, mostra o
  // idioma anunciado na fonte atual ou, sem ele, o idioma original do título (anime → japonês).
  const mainAudioLabel = useMemo(() => {
    const announced = sourceOptions.find((option) => option.id === currentSourceId)?.audioLanguages ?? [];
    const languages = announced.length > 0 ? announced : originalLanguage ? [originalLanguage] : [];
    if (languages.length === 0) return "Áudio do vídeo";
    const names = languages.map((language) => visibleLanguage({ id: language, label: language, language })).join(", ");
    return announced.length > 0 ? names : `${names} (original)`;
  }, [currentSourceId, originalLanguage, sourceOptions]);

  const activeEpisodeRef = useRef<HTMLButtonElement>(null);

  // --- TV (Task 4): nome do ícone focado no topo ("OPTIONS" da referência) e foco inicial dos
  // controles centrais quando o OK/↑/↓ reexibe a barra escondida.
  const [tvFocusLabel, setTvFocusLabel] = useState<string | null>(null);
  const tvPlayPauseRef = useRef<HTMLButtonElement>(null);

  const frame = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | null>(null);
  const lockHideTimer = useRef<number | null>(null);
  const pauseIdleTimer = useRef<number | null>(null);
  const tapTimer = useRef<number | null>(null);
  const lastTap = useRef<{ side: TapSide; at: number } | null>(null);
  const unlockAnim = useRef<number | null>(null);
  const unlockStartTime = useRef<number | null>(null);
  const gestureHideTimer = useRef<number | null>(null);
  const quickSeekHideTimer = useRef<number | null>(null);
  const dragStart = useRef<{ x: number; y: number; side: "left" | "right"; initialBrightness: number; initialVolume: number; isDragging: boolean } | null>(null);
  const escapeArmedAt = useRef(0);
  const cHoldTimer = useRef<number | null>(null);
  const cLongPressed = useRef(false);
  const wakeLock = useRef<PlaybackWakeLock | null>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    type BrowserWakeLock = {
      request(type: "screen"): Promise<{ release(): Promise<void>; addEventListener(type: "release", listener: () => void): void }>;
    };
    let manager: PlaybackWakeLock;
    if (isTauriRuntime()) {
      manager = createTauriPlaybackWakeLock();
    } else {
      const browserWakeLock = (navigator as Navigator & { wakeLock?: BrowserWakeLock }).wakeLock;
      if (!browserWakeLock) return;
      manager = new PlaybackWakeLock(async () => {
        const handle = await browserWakeLock.request("screen");
        handle.addEventListener("release", () => manager.markReleased(handle));
        return handle;
      });
    }
    wakeLock.current = manager;
    const resume = () => {
      if (document.visibilityState === "visible") void manager.resumeVisiblePlayback().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", resume);
    return () => {
      document.removeEventListener("visibilitychange", resume);
      wakeLock.current = null;
      void manager.dispose().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    void wakeLock.current?.setPlaying(playing).catch(() => undefined);
  }, [playing]);

  const setSystemCursorVisible = useCallback((visible: boolean) => {
    if (typeof document !== "undefined") {
      document.documentElement.style.cursor = visible ? "" : "none";
      document.body.style.cursor = visible ? "" : "none";
    }
    if (!isTauriRuntime()) return;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setCursorVisible(visible))
      .catch(() => undefined);
  }, []);

  const resetPauseIdle = useCallback(() => {
    setPauseIdleActive(false);
    if (pauseIdleTimer.current) {
      window.clearTimeout(pauseIdleTimer.current);
      pauseIdleTimer.current = null;
    }
    if (!playing && !locked) {
      pauseIdleTimer.current = window.setTimeout(() => {
        setPauseIdleActive(true);
      }, 30_000);
    }
  }, [locked, playing]);

  const scheduleHide = useCallback(() => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    if (!playing || menu !== null || locked) return;
    hideTimer.current = window.setTimeout(() => {
      setControlsVisible(false);
      setSystemCursorVisible(false);
    }, 3_500);
  }, [locked, menu, playing, setSystemCursorVisible]);

  // Pausou: o sumiço já agendado (de quando estava tocando) não pode esconder os controles.
  useEffect(() => {
    if (!playing && hideTimer.current) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, [playing]);

  const reveal = useCallback(() => {
    resetPauseIdle();
    if (locked) return;
    setSystemCursorVisible(true);
    setControlsVisible(true);
    scheduleHide();
  }, [locked, resetPauseIdle, scheduleHide, setSystemCursorVisible]);

  const transitionOverlay = useCallback((event: PlayerOverlayEvent) => {
    const next = reducePlayerOverlay({ controlsVisible, locked, lockVisible }, event);
    setControlsVisible(next.controlsVisible);
    setLocked(next.locked);
    setLockVisible(next.lockVisible);
    return next;
  }, [controlsVisible, lockVisible, locked]);

  const scheduleLockHide = useCallback(() => {
    if (lockHideTimer.current) window.clearTimeout(lockHideTimer.current);
    lockHideTimer.current = window.setTimeout(() => {
      setLockVisible(false);
      lockHideTimer.current = null;
    }, 3_500);
  }, []);

  useEffect(() => {
    reveal();
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      if (pauseIdleTimer.current) window.clearTimeout(pauseIdleTimer.current);
      if (lockHideTimer.current) window.clearTimeout(lockHideTimer.current);
      setSystemCursorVisible(true);
    };
  }, [reveal, setSystemCursorVisible]);

  useEffect(() => {
    resetPauseIdle();
  }, [playing, resetPauseIdle]);

  useEffect(() => {
    if (menu === "episodes") {
      const timer = window.setTimeout(() => {
        activeEpisodeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 80);
      return () => window.clearTimeout(timer);
    }
  }, [menu, selectedSeason]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const updatePolicy = useRef({ lowPower, visible: true, skipBlocks, hasNext: !!onNextEpisode });
  updatePolicy.current = {
    lowPower, visible: controlsVisible || menu !== null || pauseIdleActive,
    skipBlocks, hasNext: !!onNextEpisode
  };
  useEffect(() => {
    if (controlsVisible) setPosition(player.state().positionSeconds);
  }, [controlsVisible, player]);

  useEffect(() => {
    let live = true;
    const subscriptions: (() => void)[] = [];
    const listen = <E extends keyof PlayerEvents>(event: E, listener: PlayerListener<E>) => {
      const unsubscribe = player.on(event, (data) => { if (live) listener(data); });
      if (unsubscribe) subscriptions.push(unsubscribe);
    };
    let publishedPosition = player.state().positionSeconds;
    listen("position", (seconds) => {
      const state = player.state();
      const policy = updatePolicy.current;
      if (shouldPublishPlayerPosition(publishedPosition, seconds, {
        ...policy, playing: state.playing, duration: state.durationSeconds
      })) {
        publishedPosition = seconds;
        setPosition(seconds);
      }
      setDuration(state.durationSeconds);
      setPlaying(state.playing);
    });
    listen("ended", () => {
      setPlaying(false);
      setControlsVisible(true);
      setSystemCursorVisible(true);
    });
    listen("error", (message) => {
      setError(message);
      setPlaying(false);
      setControlsVisible(true);
      setSystemCursorVisible(true);
      reportDiagnostic("PLAYER_ERROR", message, {
        title, addon: source.addon,
        ...(currentVideoId ? { videoId: currentVideoId } : {})
      });
    });
    listen("subtitleCues", (cues) => {
      setActiveCues(cues);
    });

    const requestTracks = () => {
      const session = controlsSession.current;
      // Aqui só se LÊ: a escolha automática de faixas é de `regras/faixas.ts` (`aplicarFaixas`).
      void Promise.all([player.audioTracks(), player.subtitleTracks()]).then(([newAudio, newSubtitles]) => {
        if (!live || session !== controlsSession.current) return;
        setAudio(newAudio);
        setSubtitles(newSubtitles);
        const state = player.state();
        setAudioTrack(state.audioTrackId);
        setSubtitleTrack(state.subtitleTrackId);
      }).catch(() => { if (live && session === controlsSession.current) setError("Não foi possível identificar as trilhas deste arquivo."); });
    };

    // Um erro do motor pode ser seguido de uma reabertura que dá certo (PC: GStreamer → mpv). O
    // aviso vermelho do erro antigo ficava na tela por cima do vídeo que já estava tocando.
    // Cada `ready` é uma abertura nova, com trilhas novas: na troca GStreamer → mpv os IDs mudam e
    // a legenda escolhida na primeira abertura não existe mais — sem refazer a identificação, o
    // português do próprio arquivo ficava "Desligadas".
    listen("ready", () => {
      controlsSession.current++;
      openingSeekPending.current = false;
      manualSeekInSession.current = false;
      manualSeekTargetRef.current = null;
      setManualSeekTarget(null);
      setAutoSkippedBlockStarts(new Set());
      setAutoSkipCountdown(null);
      setAutoSkipToast(null);
      nextEpisodeAutoplayFired.current = false;
      setNextEpisodeCancelled(false);
      setPosition(player.state().positionSeconds);
      posicaoNaAbertura.current = player.state().positionSeconds;
      setDuration(player.state().durationSeconds);
      setError(null);
      requestTracks();
    });
    listen("tracksChanged", requestTracks);
    const requests = [0, 1_000, 2_500, 5_000, 10_000].map((delay) => window.setTimeout(requestTracks, delay));
    return () => {
      live = false;
      requests.forEach((request) => window.clearTimeout(request));
      subscriptions.forEach((unsubscribe) => unsubscribe());
    };
  }, [player, setSystemCursorVisible]);

  const togglePlayback = useCallback(async () => {
    resetPauseIdle();
    if (player.state().playing) {
      await player.pause();
      setPlaying(false);
      setControlsVisible(true);
      setSystemCursorVisible(true);
    } else {
      await player.play();
      setPlaying(true);
      scheduleHide();
    }
  }, [player, resetPauseIdle, scheduleHide, setSystemCursorVisible]);

  // Um seek manual cancela a entrada tardia automática; dados descobertos depois continuam
  // úteis para o botão, mas não interrompem uma posição escolhida pela pessoa.
  const manualSeekInSession = useRef(false);
  const manualSeekTargetRef = useRef<number | null>(null);
  const [manualSeekTarget, setManualSeekTarget] = useState<number | null>(null);
  const controlsSession = useRef(0);
  useEffect(() => {
    manualSeekInSession.current = false;
    manualSeekTargetRef.current = null;
    setManualSeekTarget(null);
    controlsSession.current++;
    return () => { controlsSession.current++; };
  }, [player, currentVideoId, currentSourceId]);

  const seek = useCallback(async (seconds: number, daPessoa = true) => {
    resetPauseIdle();
    const target = Math.max(0, duration > 0 ? Math.min(duration, seconds) : seconds);
    // Pulo de abertura/encerramento não é busca da pessoa: não pode soltar a guarda do ponto salvo.
    if (daPessoa) {
      manualSeekInSession.current = true;
      manualSeekTargetRef.current = target;
      setManualSeekTarget(target);
      setNextEpisodeCancelled(false);
      setAutoSkipCountdown(null);
      const block = activeSkipSegment(skipBlocks, target, duration);
      if (block?.kind === "opening") setAutoSkippedBlockStarts((previous) => new Set(previous).add(block.start));
      onSeek?.();
    }
    const session = controlsSession.current;
    await player.seek(target);
    if (session === controlsSession.current) setPosition(target);
  }, [duration, onSeek, player, resetPauseIdle, skipBlocks]);

  const seekBy = useCallback((delta: number) => {
    resetPauseIdle();
    const state = player.state();
    void seek(state.positionSeconds + delta);
    const side = delta < 0 ? "left" : "right";
    setQuickSeekSide(side);
    setQuickSeekSeconds((prev) => (quickSeekSide === side ? prev + 10 : 10));

    if (quickSeekHideTimer.current) window.clearTimeout(quickSeekHideTimer.current);
    quickSeekHideTimer.current = window.setTimeout(() => {
      setQuickSeekSide(null);
      setQuickSeekSeconds(10);
    }, 750);
  }, [quickSeekSide, player, resetPauseIdle, seek]);

  // TV: ←/→ acumulam um deslocamento PENDENTE e a busca real só acontece depois de uma pausa
  // nas teclas — a TV Samsung rebufferiza a cada `seek`, então buscar a cada toque travava.
  // `base` é a posição de quando o acúmulo começou; a barra e o tempo mostram `base + offset`.
  const [tvPendingSeek, setTvPendingSeek] = useState<{ base: number; offset: number } | null>(null);
  const tvPendingRef = useRef<{ base: number; offset: number } | null>(null);
  const tvSeekTimer = useRef<number | null>(null);
  const tvHoldStart = useRef<number | null>(null);
  const tvLastStepAt = useRef(0);
  const tvHeldKey = useRef<string | null>(null);
  const seekRef = useRef(seek);
  seekRef.current = seek;
  useEffect(() => () => {
    if (tvSeekTimer.current) window.clearTimeout(tvSeekTimer.current);
  }, []);

  const tvSeekStep = useCallback((direction: -1 | 1, holding: boolean) => {
    const now = Date.now();
    let step = 10;
    if (holding) {
      // Controles que repetem rápido demais: no máximo um passo a cada 250 ms.
      if (now - tvLastStepAt.current < 250) return;
      if (tvHoldStart.current === null) tvHoldStart.current = now;
      step = tvHoldSeekStep(now - tvHoldStart.current);
    } else {
      tvHoldStart.current = now;
    }
    tvLastStepAt.current = now;

    const state = player.state();
    const total = state.durationSeconds;
    const current = tvPendingRef.current ?? { base: state.positionSeconds, offset: 0 };
    // Limita o alvo a [0, duração] já no acúmulo: ao inverter, o deslocamento anda a partir do
    // limite e não de um valor fantasma além do fim.
    const raw = current.base + current.offset + direction * step;
    const target = Math.max(0, total > 0 ? Math.min(total, raw) : raw);
    const next = { base: current.base, offset: target - current.base };
    tvPendingRef.current = next;
    setTvPendingSeek(next);

    if (tvSeekTimer.current) window.clearTimeout(tvSeekTimer.current);
    tvSeekTimer.current = window.setTimeout(() => {
      tvSeekTimer.current = null;
      const pending = tvPendingRef.current;
      if (!pending) return;
      void seekRef.current(pending.base + pending.offset).finally(() => {
        // Só limpa se nenhuma tecla nova chegou durante a busca.
        if (tvPendingRef.current === pending) {
          tvPendingRef.current = null;
          setTvPendingSeek(null);
        }
      });
    }, 700);
  }, [player]);

  // ---------------------------------------------------------------------------
  // Pular abertura / Próximo episódio (task "pular abertura e próximo episódio")
  // ---------------------------------------------------------------------------

  const activeSkipBlock = useMemo(
    () => activeSkipSegment(skipBlocks, position, duration),
    [duration, position, skipBlocks]
  );
  const skipButtonShown = skipButtonVisible(activeSkipBlock, position, controlsVisible, manualSeekTarget !== null);


  // "Pular abertura automaticamente" (task 4): dispara sozinho ao ENTRAR num bloco "opening" —
  // nunca no "outro", que tem seu próprio cartão de próximo episódio. `autoSkippedBlockStarts`
  // marca cada bloco já tratado neste episódio (pulado sozinho OU desfeito pelo "Voltar" do
  // aviso), então nem o auto-skip nem um reingresso manual disparam de novo para ele — ver
  // `shouldAutoSkipOpening`.
  const [autoSkippedBlockStarts, setAutoSkippedBlockStarts] = useState<ReadonlySet<number>>(() => new Set());
  useEffect(() => setAutoSkippedBlockStarts(new Set()), [currentVideoId, currentSourceId, player]);

  const [autoSkipToast, setAutoSkipToast] = useState<{ blockStart: number } | null>(null);
  const autoSkipToastTimer = useRef<number | null>(null);
  const openingSeekPending = useRef(false);
  // Posição em que o vídeo abriu. O pulo automático só conta depois que ela avança: em 0:00, com
  // a fonte ainda carregando, o seek falhava e cada nova tentativa reiniciava a leitura do arquivo.
  const posicaoNaAbertura = useRef<number | null>(null);
  const performOpeningSkip = useCallback(async (block: SkipBlock, automatic: boolean) => {
    if (openingSeekPending.current) return;
    openingSeekPending.current = true;
    const session = controlsSession.current;
    try {
      await seek(block.end, false);
      if (session !== controlsSession.current) return;
      // Só consome a oportunidade quando o motor aceitou o seek.
      setAutoSkippedBlockStarts((prev) => new Set(prev).add(block.start));
      if (automatic) {
        setAutoSkipToast({ blockStart: block.start });
        if (autoSkipToastTimer.current) window.clearTimeout(autoSkipToastTimer.current);
        autoSkipToastTimer.current = window.setTimeout(() => setAutoSkipToast(null), 5_000);
      }
    } catch {
      // O automático tenta uma vez só: repetir a cada 2 s reiniciava a leitura de uma fonte lenta
      // e o vídeo nunca saía do 0:00 (One Piece pelo fenixflix). O botão continua disponível.
      if (automatic && session === controlsSession.current) {
        setAutoSkippedBlockStarts((prev) => new Set(prev).add(block.start));
      }
    } finally {
      if (session === controlsSession.current) openingSeekPending.current = false;
    }
  }, [seek]);
  const skipOpening = useCallback(() => {
    if (!activeSkipBlock) return;
    void performOpeningSkip(activeSkipBlock, false);
    reveal();
  }, [activeSkipBlock, performOpeningSkip, reveal]);

  // Pulo automático com contagem: ao entrar na abertura, o botão conta 2 s e só então pula —
  // tempo de "Cancelar" para quem quer ver a abertura (ou quando o tempo do AniSkip está errado
  // para este release). Sair do bloco, pausar a contagem por seek ou cancelar desarma.
  const [autoSkipCountdown, setAutoSkipCountdown] = useState<{ blockStart: number; remaining: number } | null>(null);
  useEffect(() => {
    if (openingSeekPending.current) return;
    if (!autoSkipIntro || !activeSkipBlock || manualSeekInSession.current) { setAutoSkipCountdown(null); return; }
    if (autoSkipCountdown?.blockStart === activeSkipBlock.start) return;
    if (posicaoNaAbertura.current === null) posicaoNaAbertura.current = position;
    if (position <= posicaoNaAbertura.current) return;
    const enteredAfterBumper = inicioDaVinheta(currentVideoId, autoSkipIntro) === 10 && position >= 10 && position < 13 &&
      activeSkipBlock.kind === "opening" && activeSkipBlock.start <= 10 &&
      !autoSkippedBlockStarts.has(activeSkipBlock.start);
    if (!enteredAfterBumper && !shouldAutoSkipOpening(activeSkipBlock, position, autoSkippedBlockStarts, !manualSeekInSession.current)) return;
    setAutoSkipCountdown({ blockStart: activeSkipBlock.start, remaining: AUTO_SKIP_COUNTDOWN_SECONDS });
  }, [activeSkipBlock, autoSkipCountdown?.blockStart, autoSkipIntro, autoSkippedBlockStarts, currentVideoId, position]);

  useEffect(() => {
    if (!playing || !autoSkipIntro || !autoSkipCountdown || !activeSkipBlock || activeSkipBlock.start !== autoSkipCountdown.blockStart) return;
    const timer = window.setTimeout(() => {
      if (autoSkipCountdown.remaining > 1) {
        setAutoSkipCountdown({ ...autoSkipCountdown, remaining: autoSkipCountdown.remaining - 1 });
        return;
      }
      if (manualSeekInSession.current) return;
      const block = activeSkipBlock;
      setAutoSkipCountdown(null);
      void performOpeningSkip(block, true);
    }, 1_000);
    return () => window.clearTimeout(timer);
  }, [activeSkipBlock, autoSkipCountdown, autoSkipIntro, playing, performOpeningSkip]);

  useEffect(() => {
    openingSeekPending.current = false;
    posicaoNaAbertura.current = null;
    setAutoSkipCountdown(null);
    setAutoSkipToast(null);
    if (autoSkipToastTimer.current) window.clearTimeout(autoSkipToastTimer.current);
  }, [currentVideoId, currentSourceId, player]);

  const cancelAutoSkip = useCallback(() => {
    if (!autoSkipCountdown) return;
    const start = autoSkipCountdown.blockStart;
    setAutoSkipCountdown(null);
    setAutoSkippedBlockStarts((prev) => new Set(prev).add(start));
  }, [autoSkipCountdown]);

  useEffect(() => () => {
    if (autoSkipToastTimer.current) window.clearTimeout(autoSkipToastTimer.current);
  }, []);

  // "Voltar" desfaz o seek e marca o bloco como "não pular de novo" — ele já está marcado desde
  // o auto-skip, então basta voltar a posição.
  const undoAutoSkip = useCallback(() => {
    if (!autoSkipToast) return;
    void seek(autoSkipToast.blockStart);
    setAutoSkipToast(null);
    if (autoSkipToastTimer.current) window.clearTimeout(autoSkipToastTimer.current);
  }, [autoSkipToast, seek]);

  const nextEpisodePromptStartAt = useMemo(
    () => (onNextEpisode ? nextEpisodePromptStart(skipBlocks, duration) : null),
    [duration, onNextEpisode, skipBlocks]
  );

  // "Cancelar" vale só até a pessoa voltar antes do início do cartão — reaproximar do fim de novo
  // deixa o cartão aparecer outra vez. Também reseta ao trocar de episódio (task de continuidade).
  const [nextEpisodeCancelled, setNextEpisodeCancelled] = useState(false);
  useEffect(() => setNextEpisodeCancelled(false), [currentVideoId]);
  useEffect(() => {
    if (shouldResetNextEpisodeCancel(nextEpisodePromptStartAt, position)) setNextEpisodeCancelled(false);
  }, [nextEpisodePromptStartAt, position]);

  const manualEndingVisit = isManualEndingVisit(nextEpisodePromptStartAt, position, manualSeekTarget);
  const nextEpisodePrompt = useMemo(
    () => nextEpisodePromptState(nextEpisodePromptStartAt, position, duration, nextEpisodeCancelled,
      nextEpisodeCountdownStart(skipBlocks, duration), manualEndingVisit),
    [duration, nextEpisodeCancelled, nextEpisodePromptStartAt, position, skipBlocks, manualEndingVisit]
  );

  // A contagem é derivada da posição (ver `nextEpisodePromptState`), então o disparo também
  // acompanha a posição — a trava por ref evita chamar `onNextEpisode` mais de uma vez por episódio
  // enquanto a posição segue em 0 no cartão (ex.: vídeo pausado bem no instante do zero).
  const nextEpisodeAutoplayFired = useRef(false);
  useEffect(() => { nextEpisodeAutoplayFired.current = false; }, [currentVideoId]);
  useEffect(() => {
    if (!nextEpisodePrompt.triggerAutoplay || nextEpisodeAutoplayFired.current || !onNextEpisode) return;
    if (isManualEndingVisit(nextEpisodePromptStartAt, player.state().positionSeconds, manualSeekTargetRef.current)) return;
    nextEpisodeAutoplayFired.current = true;
    onNextEpisode();
  }, [nextEpisodePrompt.triggerAutoplay, onNextEpisode, nextEpisodePromptStartAt, player]);

  useEffect(() => {
    const unsubscribe = player.on("ended", () => {
      if (!onNextEpisode || nextEpisodeCancelled || nextEpisodeAutoplayFired.current) return;
      const state = player.state();
      if (!canAdvanceOnEnded(state.positionSeconds, state.durationSeconds)) return;
      if (isManualEndingVisit(nextEpisodePromptStart(skipBlocks, state.durationSeconds), state.positionSeconds, manualSeekTargetRef.current)) return;
      nextEpisodeAutoplayFired.current = true;
      onNextEpisode();
    });
    return () => { unsubscribe?.(); };
  }, [player, onNextEpisode, nextEpisodeCancelled, skipBlocks]);

  // Foco automático para o controle remoto (TV): o botão/cartão precisa já nascer focado para o
  // OK ativá-lo — sem isto, a pessoa teria que navegar até ele às cegas (a navegação LRUD da TV
  // fica desligada com o player aberto, ver `tv-navigation.tsx`). Nunca rouba o foco de um menu
  // aberto (áudio/legendas, episódios…) que a pessoa já esteja usando.
  const skipButtonRef = useRef<HTMLButtonElement>(null);
  const skipButtonWasShown = useRef(false);
  useEffect(() => {
    if (skipButtonShown && !skipButtonWasShown.current && menu === null) {
      skipButtonRef.current?.focus({ preventScroll: true });
    }
    skipButtonWasShown.current = skipButtonShown;
  }, [menu, skipButtonShown]);

  const nextEpisodeWatchRef = useRef<HTMLButtonElement>(null);
  const nextEpisodePromptWasVisible = useRef(false);
  useEffect(() => {
    if (nextEpisodePrompt.visible && !nextEpisodePromptWasVisible.current && menu === null) {
      nextEpisodeWatchRef.current?.focus({ preventScroll: true });
    }
    nextEpisodePromptWasVisible.current = nextEpisodePrompt.visible;
  }, [menu, nextEpisodePrompt.visible]);

  // TV: com os controles na tela e o foco fora do player (ao abrir o vídeo, ou depois de os
  // controles sumirem e voltarem), o seletor nasce no play/pausa.
  useEffect(() => {
    if (!tv || !controlsVisible || menu !== null) return;
    const timer = window.setTimeout(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && frame.current?.contains(active) && active.tabIndex >= 0) return;
      tvPlayPauseRef.current?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [controlsVisible, menu, tv]);

  // TV: painéis laterais ancorados logo ACIMA da linha do tempo (play · tempo · barra), com metade
  // da tela de altura. A posição dessa linha depende do tamanho da tela e das pílulas embaixo
  // dela, então é medida ao abrir, em vez de chutada no CSS.
  const [tvPanelBottom, setTvPanelBottom] = useState<number | null>(null);
  useEffect(() => {
    if (!tv || menu === null) return;
    const row = frame.current?.querySelector<HTMLElement>('[data-tv-row="middle"]');
    if (!row) return;
    setTvPanelBottom(Math.round(window.innerHeight - row.getBoundingClientRect().top + 16));
  }, [menu, tv]);

  // TV: ao abrir um painel (áudio/legendas/fontes, ajustes ou episódios) pelo controle remoto, o
  // foco precisa já nascer dentro dele — sem isto a pessoa navegaria "às cegas" até chegar lá.
  useEffect(() => {
    if (!tv || menu === null) return;
    const timer = window.setTimeout(() => {
      const panel = frame.current?.querySelector<HTMLElement>("[data-tv-columns],[data-tv-rows][data-tv-panel]");
      // Na lista, o foco nasce no item escolhido hoje (a trilha/legenda em uso), não no primeiro.
      const selected = panel?.querySelector<HTMLElement>("[data-tv-selected]:not(:disabled)");
      tvFocusVisible(selected ?? (panel ? tvFirstFocusable(panel) : null));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [menu, languageTab, tv]);

  // "Outros idiomas" recolhe de novo ao fechar o painel; ao expandir, o botão some e o foco iria
  // para o body — leva para o primeiro item novo da lista.
  useEffect(() => {
    if (menu === null) setTvShowOtherSubtitles(false);
  }, [menu]);
  useEffect(() => {
    if (!tv || !tvShowOtherSubtitles) return;
    const timer = window.setTimeout(() => {
      tvFocusVisible(frame.current?.querySelector<HTMLElement>("[data-tv-first-other]"));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [tv, tvShowOtherSubtitles]);

  const toggleFullscreen = useCallback(async () => {
    if (player.toggleFullscreen) {
      await player.toggleFullscreen();
      setIsFullscreen((prev) => !prev);
      return;
    }
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      setIsFullscreen(false);
    } else {
      await frame.current?.requestFullscreen();
      setIsFullscreen(true);
    }
  }, [player]);

  const handleTap = useCallback((side: TapSide) => {
    if (locked) {
      const next = transitionOverlay({ type: "backgroundTap" });
      if (next.lockVisible) scheduleLockHide();
      else if (lockHideTimer.current) window.clearTimeout(lockHideTimer.current);
      return;
    }
    const now = Date.now();
    const previous = lastTap.current;
    if (previous?.side === side && now - previous.at <= 330) {
      if (tapTimer.current) window.clearTimeout(tapTimer.current);
      lastTap.current = null;
      if (side === "left") seekBy(-10);
      else if (side === "right") seekBy(10);
      else void toggleFullscreen();
      reveal();
      return;
    }
    lastTap.current = { side, at: now };
    tapTimer.current = window.setTimeout(() => {
      lastTap.current = null;
      setControlsVisible((visible) => !visible);
    }, 330);
  }, [locked, reveal, scheduleLockHide, seekBy, toggleFullscreen, transitionOverlay]);

  // Gestos verticais de swipe na lateral (Brilho na esquerda, Volume na direita)
  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    resetPauseIdle();
    if (locked) return;
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const side = x < rect.width * 0.45 ? "left" : x > rect.width * 0.55 ? "right" : "left";
    dragStart.current = {
      x: event.clientX,
      y: event.clientY,
      side,
      initialBrightness: brightness,
      initialVolume: volume,
      isDragging: false
    };
  };

  const showGestureHUD = useCallback((type: "brightness" | "volume", value: number) => {
    setGestureHUD({ type, value });
    if (gestureHideTimer.current) window.clearTimeout(gestureHideTimer.current);
    gestureHideTimer.current = window.setTimeout(() => setGestureHUD(null), 1_200);
  }, []);

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragStart.current) return;
    const deltaY = dragStart.current.y - event.clientY;
    const deltaX = Math.abs(event.clientX - dragStart.current.x);

    if (!dragStart.current.isDragging && Math.abs(deltaY) > 12 && Math.abs(deltaY) > deltaX) {
      dragStart.current.isDragging = true;
    }

    if (!dragStart.current.isDragging) return;

    const screenHeight = window.innerHeight || 400;
    const normalizedDelta = deltaY / (screenHeight * 0.6);

    if (dragStart.current.side === "left" && player.setBrightness) {
      const nextBrightness = Math.min(1, Math.max(0.05, dragStart.current.initialBrightness + normalizedDelta));
      setBrightness(nextBrightness);
      void player.setBrightness(nextBrightness);
      showGestureHUD("brightness", nextBrightness);
    } else if (dragStart.current.side === "right" && player.changeVolume) {
      const nextVolume = Math.min(1, Math.max(0, dragStart.current.initialVolume + normalizedDelta));
      setVolume(nextVolume);
      setMuted(nextVolume === 0);
      void player.changeVolume(nextVolume - volume);
      showGestureHUD("volume", nextVolume);
    }
  };

  const handlePointerUp = () => {
    dragStart.current = null;
  };

  const toggleMuted = useCallback(async () => {
    if (!player.toggleMuted) return;
    setMuted(await player.toggleMuted());
  }, [player]);

  const handleVolumeChange = useCallback(async (newVol: number) => {
    if (!player.changeVolume) return;
    const delta = newVol - volume;
    const next = await player.changeVolume(delta);
    setVolume(next);
    setMuted(next === 0);
  }, [player, volume]);

  const changePlaybackRate = useCallback((rate: number) => {
    setPlaybackRate(rate);
    void player.setPlaybackRate?.(rate);
    setMenu(null);
  }, [player]);

  // Bloqueio de tela com animação de segurar para desbloquear
  const cancelUnlock = useCallback(() => {
    if (unlockAnim.current) cancelAnimationFrame(unlockAnim.current);
    unlockAnim.current = null;
    unlockStartTime.current = null;
    setUnlockProgress(0);
  }, []);

  const beginUnlockHold = useCallback(() => {
    if (!locked) return;
    unlockStartTime.current = performance.now();
    const durationMs = 800;

    const tick = (now: number) => {
      if (!unlockStartTime.current) return;
      const elapsed = now - unlockStartTime.current;
      const progress = Math.min(1, elapsed / durationMs);
      setUnlockProgress(progress);

      if (progress >= 1) {
        transitionOverlay({ type: "unlock" });
        setUnlockProgress(0);
        unlockStartTime.current = null;
        if (lockHideTimer.current) window.clearTimeout(lockHideTimer.current);
      } else {
        unlockAnim.current = requestAnimationFrame(tick);
      }
    };

    unlockAnim.current = requestAnimationFrame(tick);
  }, [locked, transitionOverlay]);

  const toggleLock = useCallback(() => {
    if (!locked) {
      transitionOverlay({ type: "lock" });
      setMenu(null);
      scheduleLockHide();
    }
  }, [locked, scheduleLockHide, transitionOverlay]);

  // "Voltar" da TV (botão físico do controle, via `tv-navigation.tsx`, que só clica no elemento
  // `[aria-label='Voltar']` — a lógica de "fecha painel → esconde controles → sai" mora aqui, não
  // lá, porque só este componente sabe se há um menu aberto ou se os controles estão visíveis.
  const handleTvBack = useCallback(() => {
    if (menu !== null) { setMenu(null); return; }
    if (controlsVisible) {
      transitionOverlay({ type: "backgroundTap" });
      setSystemCursorVisible(false);
      return;
    }
    onClose();
  }, [controlsVisible, menu, onClose, setSystemCursorVisible, transitionOverlay]);

  // Teclado
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      // No modo TV, quem cuida do teclado é o efeito dedicado abaixo (navegação por linhas e
      // colunas do controle remoto) — este aqui é só o dos atalhos de PC/celular.
      if (tv) return;
      resetPauseIdle();
      const targetTag = (event.target as HTMLElement)?.tagName?.toLowerCase();
      if (targetTag === "input" || targetTag === "textarea" || targetTag === "select") return;

      if (event.key === " " || event.code === "Space") void togglePlayback();
      else if (event.key === "ArrowLeft") seekBy(-10);
      else if (event.key === "ArrowRight") seekBy(10);
      else if (event.key === "ArrowUp") void player.changeVolume?.(0.05);
      else if (event.key === "ArrowDown") void player.changeVolume?.(-0.05);
      else if (event.key.toLowerCase() === "f") void toggleFullscreen();
      else if (event.key.toLowerCase() === "m") void toggleMuted();
      else if (event.key.toLowerCase() === "c") {
        if (!event.repeat) {
          cLongPressed.current = false;
          if (cHoldTimer.current) window.clearTimeout(cHoldTimer.current);
          cHoldTimer.current = window.setTimeout(() => {
            cLongPressed.current = true;
            resetSubtitleTiming();
          }, 450);
        }
      } else if (event.key === "Escape") {
        const now = Date.now();
        if (now - escapeArmedAt.current <= 2_000) {
          escapeArmedAt.current = 0;
          onClose();
        } else {
          escapeArmedAt.current = now;
          setMenu(null);
          if (player.exitFullscreen) void player.exitFullscreen();
          else if (document.fullscreenElement) void document.exitFullscreen();
        }
      } else return;
      event.preventDefault();
      event.stopImmediatePropagation();
      reveal();
    };

    const keyup = (event: KeyboardEvent) => {
      if (tv) return;
      const targetTag = (event.target as HTMLElement)?.tagName?.toLowerCase();
      if (targetTag === "input" || targetTag === "textarea" || targetTag === "select") return;

      if (event.key.toLowerCase() === "c") {
        if (cHoldTimer.current) {
          window.clearTimeout(cHoldTimer.current);
          cHoldTimer.current = null;
        }
        if (!cLongPressed.current) {
          void toggleSubtitlesShortcut();
        }
        cLongPressed.current = false;
        event.preventDefault();
        event.stopImmediatePropagation();
        reveal();
      }
    };

    window.addEventListener("keydown", keydown, true);
    window.addEventListener("keyup", keyup, true);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("keyup", keyup, true);
      if (cHoldTimer.current) window.clearTimeout(cHoldTimer.current);
    };
  }, [resetSubtitleTiming, onClose, player, resetPauseIdle, reveal, seekBy, toggleFullscreen, toggleMuted, togglePlayback, toggleSubtitlesShortcut, tv]);

  // Teclado do controle remoto (TV, Task 4) — efeito próprio para não competir com os atalhos de
  // PC/celular acima. `useTvLayout()` também cobre a prévia do PC (`?tv=1`); some controles Tizen
  // antigos mandam código de tecla dedicado para rebobinar/avançar/play/pause (diferente do
  // D-pad), então o mapeamento de sempre continua valendo aqui dentro.
  useEffect(() => {
    if (!tv) return;
    // "Segurando": `repeat` nativo ou keydown repetido da mesma seta sem keyup no meio (alguns
    // controles Tizen não marcam `repeat`).
    // Em ref (e não variável do efeito): o primeiro toque com os controles escondidos chama
    // `reveal()`, o efeito é recriado e uma variável local zeraria no meio da tecla segurada.
    const tvIsHolding = (event: KeyboardEvent) => {
      const holding = event.repeat || tvHeldKey.current === event.key;
      tvHeldKey.current = event.key;
      return holding;
    };
    const keyup = () => { tvHeldKey.current = null; };
    const tvSwitchTab = (panel: HTMLElement, delta: number) => {
      const tabs = (panel.dataset.tvTabs ?? "").split(",").filter(Boolean) as ("audio" | "subtitles" | "sources" | "settings")[];
      const current = tabs.indexOf(panel.dataset.tvCurrent as "audio" | "subtitles" | "sources" | "settings");
      const next = tabs[Math.max(0, Math.min(tabs.length - 1, current + delta))];
      if (next && next !== panel.dataset.tvCurrent) setLanguageTab(next);
    };
    const keydown = (event: KeyboardEvent) => {
      resetPauseIdle();

      const codes = { rewind: 412, play: 415, pause: 19, forward: 417, playPause: 10252 };
      if (event.keyCode === codes.play || event.keyCode === codes.playPause) {
        void togglePlayback();
        event.preventDefault();
        return;
      }
      if (event.keyCode === codes.pause) {
        void player.pause().then(() => setPlaying(false));
        event.preventDefault();
        return;
      }
      if (event.keyCode === codes.rewind) { seekBy(-10); event.preventDefault(); return; }
      if (event.keyCode === codes.forward) { seekBy(10); event.preventDefault(); return; }

      // A tela bloqueada tem interação própria (segurar o botão flutuante) — sem teclas aqui.
      if (locked) return;

      const hidden = !controlsVisible && menu === null && !pauseIdleActive;
      if (hidden) {
        // OK ou ↑/↓ reexibem os controles com o foco já no play/pausa — nunca pausam o vídeo.
        if (event.key === "Enter" || event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          reveal();
          window.setTimeout(() => tvPlayPauseRef.current?.focus({ preventScroll: true }), 0);
          return;
        }
        // ←/→ avançam/retrocedem direto, sem exigir OK antes — a barra some sozinha de novo.
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          tvSeekStep(event.key === "ArrowLeft" ? -1 : 1, tvIsHolding(event));
          reveal();
          return;
        }
        // Voltar (Escape/Backspace/tecla física): resolvido pelo clique em "Voltar" que o
        // `tv-navigation.tsx` já dispara sozinho — não precisa de tratamento aqui.
        return;
      }

      const active = document.activeElement;
      // Foco perdido (os controles somem, o item focado deixa de ser focável e o foco cai no
      // `body`): a tecla só reencontra o seletor — no painel aberto, se houver, senão no play —
      // em vez de não fazer nada e deixar a pessoa procurando onde ele está.
      if (!(active instanceof HTMLElement) || !frame.current?.contains(active) || active.tabIndex < 0) {
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter"].includes(event.key)) {
          event.preventDefault();
          const panel = frame.current?.querySelector<HTMLElement>("[data-tv-columns],[data-tv-rows][data-tv-panel]");
          tvFocusVisible(panel ? tvFirstFocusable(panel) : tvPlayPauseRef.current);
        }
        return;
      }

      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const delta = event.key === "ArrowLeft" ? -1 : 1;
        // Barra de progresso focada: ←/→ avançam/retrocedem 10s em vez de trocar de foco.
        if (active.hasAttribute("data-tv-progress")) {
          event.preventDefault();
          tvSeekStep(delta, tvIsHolding(event));
          return;
        }
        // Âncora do cabeçalho de abas dos Ajustes: ←/→ trocam de aba como no painel de colunas.
        const anchor = active.hasAttribute("data-tv-tab-anchor") ? active.closest<HTMLElement>("[data-tv-tabs]") : null;
        if (anchor) {
          event.preventDefault();
          tvSwitchTab(anchor, delta);
          return;
        }
        // Painel de colunas (Áudio | Legendas | Fontes): ←/→ trocam de coluna.
        const panel = active.closest<HTMLElement>("[data-tv-columns]");
        if (panel) {
          event.preventDefault();
          // Painel lateral em abas: ←/→ trocam de aba (o foco entra na lista nova pelo efeito
          // de abertura de painel, que roda a cada troca de `languageTab`).
          tvSwitchTab(panel, delta);
          return;
        }
        // Linha comum (topo, meio, pílulas, seções de ajustes): ←/→ andam entre os itens dela.
        if (tvMoveWithinContainer(active, "[data-tv-row]", delta)) event.preventDefault();
        return;
      }

      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        const direction = event.key === "ArrowUp" ? "up" : "down";
        // Coluna do painel: ↑/↓ andam nos itens da própria coluna.
        const column = active.closest("[data-tv-col]");
        if (column) {
          event.preventDefault();
          tvMoveWithinContainer(active, "[data-tv-col]", direction === "up" ? -1 : 1);
          return;
        }
        // Linhas empilhadas (overlay principal, ajustes ou episódios): ↑/↓ trocam de linha.
        const scope = active.closest("[data-tv-rows]");
        if (scope) {
          const rows = [...scope.querySelectorAll<HTMLElement>("[data-tv-row]")];
          event.preventDefault();
          tvMoveAcrossContainers(rows, active, direction);
        }
        return;
      }
      // Enter/OK: clique nativo do botão focado (comportamento padrão do navegador). Voltar:
      // botão "Voltar" (`handleTvBack`), clicado pelo `tv-navigation.tsx`.
    };

    window.addEventListener("keydown", keydown, true);
    window.addEventListener("keyup", keyup, true);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("keyup", keyup, true);
    };
  }, [controlsVisible, locked, menu, pauseIdleActive, player, resetPauseIdle, reveal, seekBy, tvSeekStep, togglePlayback, tv]);

  // Cálculo da timeline no hover
  const handleTimelineMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineRef.current || duration <= 0) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHoverTimeline({
      seconds: percent * duration,
      percent: percent * 100
    });
  };

  const handleTimelineMouseLeave = () => {
    setHoverTimeline(null);
  };

  // Na TV, com deslocamento pendente a barra e o tempo mostram o ALVO (os `timeupdate` não mexem nisso).
  const tvShownPosition = tv && tvPendingSeek ? tvPendingSeek.base + tvPendingSeek.offset : position;
  const progressPercent = duration > 0 ? (Math.min(tvShownPosition, duration) / duration) * 100 : 0;
  const tvSettingsTabs = ([["audio", "Áudio"], ["subtitles", "Legendas"], ...(sourceOptions.length > 0 ? [["sources", "Fontes"]] : []), ["settings", "Ajustes"]] as const);
  const isCursorHidden = !controlsVisible && playing && !locked && menu === null && !pauseIdleActive;

  // Os controles e as legendas do navegador vivem em portais diferentes. Compartilhar a
  // medida no documento mantém ambos acima do rodapé, inclusive após resize/rotação.
  useLayoutEffect(() => {
    if (!mounted) return;
    const root = document.documentElement;
    const property = "--player-controls-subtitle-bottom";
    const footer = frame.current?.querySelector<HTMLElement>("[data-player-footer]");
    if (!controlsVisible || locked || pauseIdleActive || !footer) {
      root.style.setProperty(property, "0px");
      return () => root.style.removeProperty(property);
    }
    const measure = () => {
      const bounds = frame.current?.getBoundingClientRect();
      if (!bounds) return;
      const clearance = Math.max(0, bounds.bottom - footer.getBoundingClientRect().top) + 12;
      root.style.setProperty(property, `${Math.ceil(clearance)}px`);
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(footer);
    if (frame.current) observer?.observe(frame.current);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      root.style.removeProperty(property);
    };
  }, [mounted, controlsVisible, locked, pauseIdleActive, tv]);

  if (!mounted) return null;

  return createPortal(
    <div
      className={`${styles.frame} ${isCursorHidden ? styles.cursorHidden : ""}`}
      data-player-nativo
      data-low-power={lowPower ? "true" : undefined}
      ref={frame}
      onPointerMove={reveal}
      onPointerDown={handlePointerDown}
      onPointerMoveCapture={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {/* Zonas de toque para detecção de gestos */}
      <div className={styles.tapZones} aria-hidden="true">
        <div onPointerUp={() => handleTap("left")} />
        <div onPointerUp={() => handleTap("center")} />
        <div onPointerUp={() => handleTap("right")} />
      </div>

      {/* Ripple de Avanço / Retrocesso Rápido */}
      {tv && tvPendingSeek ? (
        <div className={`${styles.quickSeekOverlay} ${tvPendingSeek.offset < 0 ? styles.quickSeekLeft : styles.quickSeekRight}`} aria-live="polite">
          <div className={styles.quickSeekRipple}>
            {tvPendingSeek.offset < 0 ? <IconNetflixReplay10 className={styles.quickSeekIcon} /> : <IconNetflixForward10 className={styles.quickSeekIcon} />}
            <span className={styles.quickSeekText}>{formatTvSeekOffset(tvPendingSeek.offset)}</span>
          </div>
        </div>
      ) : null}
      {quickSeekSide && !(tv && tvPendingSeek) ? (
        <div className={`${styles.quickSeekOverlay} ${quickSeekSide === "left" ? styles.quickSeekLeft : styles.quickSeekRight}`} aria-live="polite">
          <div className={styles.quickSeekRipple}>
            {quickSeekSide === "left" ? <IconNetflixReplay10 className={styles.quickSeekIcon} /> : <IconNetflixForward10 className={styles.quickSeekIcon} />}
            <span className={styles.quickSeekText}>{quickSeekSide === "left" ? `−${quickSeekSeconds}s` : `+${quickSeekSeconds}s`}</span>
          </div>
        </div>
      ) : null}

      {/* HUD de Gestos (Brilho / Volume no Swipe) */}
      {gestureHUD ? (
        <div className={styles.gestureHUD} role="status" aria-live="polite">
          <div className={styles.gestureHUDIcon}>
            {gestureHUD.type === "brightness" ? <IconSun /> : gestureHUD.value === 0 ? <IconVolumeMute /> : <IconVolumeHigh />}
          </div>
          <div className={styles.gestureHUDBigBar}>
            <div className={styles.gestureHUDProgress} style={{ height: `${Math.round(gestureHUD.value * 100)}%` }} />
          </div>
          <span className={styles.gestureHUDLabel}>{Math.round(gestureHUD.value * 100)}%</span>
        </div>
      ) : null}

      {/* Subtitle Cue Overlay (para renderização nativa de legendas no Desktop Tauri ou fallback direto) */}
      {/* Na TV, com um painel central aberto (áudio/legendas, episódios), a legenda sai da frente
          — ela ficava por cima da lista. Nos Ajustes (painel lateral) ela fica, pra ver na hora
          o tamanho/altura/cor/sincronia que está mudando. */}
      {activeCues.length > 0 && subtitleTrack !== null && !(tv && menu !== null && !(menu === "languages" && languageTab === "settings")) ? (
        <div
          className={styles.subtitleOverlay}
          aria-live="off"
          aria-atomic="true"
          style={{ bottom: `max(calc(5.5rem + ${subtitleSettings.position ?? 0}vh), var(--player-controls-subtitle-bottom, 0px))` }}
        >
          {activeCues.map((cue) => (
            <div
              key={cue.id}
              className={`${styles.subtitleCueBox} ${styles[`subtitleBg_${subtitleSettings.bg}`]} ${tv ? "" : styles[`subtitleFont_${subtitleSettings.font}`]}`}
              style={tv ? {
                // Estilo Netflix só na TV (fonte embutida: a Samsung só tem uma de sistema).
                color: subtitleSettings.color,
                fontSize: tvSubtitleFontSize(subtitleSettings.size),
                fontFamily: tvSubtitleStyle.fontFamily,
                fontWeight: tvSubtitleStyle.fontWeight,
                lineHeight: 1.3,
                maxWidth: "80%",
                textShadow: tvSubtitleStyle.textShadow,
                WebkitTextStroke: tvSubtitleStyle.textStroke
              } : {
                color: subtitleSettings.color,
                fontSize: `clamp(1.1rem, ${2.4 * (subtitleSettings.size / 100)}vw, ${3 * (subtitleSettings.size / 100)}rem)`
              }}
            >
              {renderCueText(cue.text)}
            </div>
          ))}
        </div>
      ) : null}

      {/* Feedback HUD Flutuante (Atalhos de teclado e ajustes de legenda) */}
      {hudNotice ? (
        <div className={styles.hudToast} role="status" aria-live="polite">
          {hudNotice}
        </div>
      ) : null}

      {/* Aviso do "Pular abertura automaticamente" — some sozinho em ~5s. O botão "Voltar" nunca
          recebe foco automático (nem na TV): roubaria o foco de um menu que a pessoa já esteja
          usando, e este aviso é só um extra opcional, não uma ação que precise de atenção. */}
      {!locked && autoSkipToast ? (
        <div className={styles.autoSkipToast} role="status" aria-live="polite">
          <span>Abertura pulada</span>
          <button type="button" className={styles.autoSkipToastUndoBtn} onClick={undoAutoSkip}>
            Voltar
          </button>
        </div>
      ) : null}

      {/* Tela de Pausa Inteligente (Aparece após 30s de pausa sem interação) */}
      {pauseIdleActive ? (
        <aside className={styles.pauseIdleOverlay} onClick={resetPauseIdle} aria-label="Vídeo pausado">
          {backdropUrl ? (
            <div
              className={styles.pauseIdleBackdrop}
              style={{ backgroundImage: `url(${backdropUrl})` }}
              aria-hidden="true"
            />
          ) : null}
          <div className={styles.pauseIdleContent}>
            <div className={styles.pauseIdleBrand}>
              <BrandIcon size={26} />
              <span>PAUSADO</span>
            </div>
            <h2 className={styles.pauseIdleTitle}>{title}</h2>
            {episodeLabel ? <p className={styles.pauseIdleEpisode}>{episodeLabel}</p> : null}
            {synopsis ? <p className={styles.pauseIdleSynopsis}>{synopsis}</p> : null}
            <button
              type="button"
              className={styles.pauseIdleResumeBtn}
              onClick={(e) => {
                e.stopPropagation();
                void togglePlayback();
              }}
            >
              <IconNetflixPlay className={styles.resumeIcon} />
              <span>Continuar assistindo</span>
            </button>
            <span className={styles.pauseIdleHint}>Mova o mouse ou pressione qualquer tecla para voltar</span>
          </div>
        </aside>
      ) : null}

      {/* Botão Flutuante de Bloqueio (Quando a tela estiver bloqueada) */}
      {locked && lockVisible ? (
        <div className={styles.lockedContainer}>
          <button
            type="button"
            className={styles.lockedFloatingBtn}
            onPointerDown={beginUnlockHold}
            onPointerUp={cancelUnlock}
            onPointerCancel={cancelUnlock}
            aria-label="Mantenha pressionado para desbloquear controles"
          >
            <svg className={styles.lockProgressRing} viewBox="0 0 54 54">
              <circle cx="27" cy="27" r="24" className={styles.lockRingTrack} />
              <circle
                cx="27"
                cy="27"
                r="24"
                className={styles.lockRingFill}
                style={{
                  strokeDasharray: 150.8,
                  strokeDashoffset: 150.8 * (1 - unlockProgress)
                }}
              />
            </svg>
            <IconLock className={styles.lockedIcon} />
          </button>
          <span className={styles.lockedTip}>Mantenha pressionado para desbloquear</span>
        </div>
      ) : null}

      {/* Desbloqueio da TV: o controle remoto não tem gesto de "segurar" (OK só dispara um
          clique seco), então o botão flutuante de cima nunca completaria os 800ms sozinho — sem
          isto a pessoa ficava trancada na tela bloqueada. Só existe no modo TV. */}
      {tv && locked && lockVisible ? (
        <button
          type="button"
          className={styles.tvUnlockBtn}
          onClick={() => transitionOverlay({ type: "unlock" })}
        >
          Desbloquear
        </button>
      ) : null}

      {/* Botão flutuante "Pular abertura" — some com os controles, exceto nos primeiros 10s do
          bloco (ver `skipButtonVisible`). Recebe foco sozinho para o OK do controle remoto. */}
      {!locked && activeSkipBlock && skipButtonShown && !(activeSkipBlock.kind === "outro" && nextEpisodePrompt.visible) ? (
        <div className={styles.skipButtonWrap}>
          {autoSkipCountdown ? (
            <button type="button" className={styles.skipCancelButton} onClick={cancelAutoSkip}>
              Cancelar
            </button>
          ) : null}
          <button
            ref={skipButtonRef}
            type="button"
            className={styles.skipButton}
            onClick={skipOpening}
          >
            {autoSkipCountdown ? `${skipBlockLabel(activeSkipBlock)} · ${autoSkipCountdown.remaining}` : skipBlockLabel(activeSkipBlock)}
          </button>
        </div>
      ) : null}

      {/* Cartão "Próximo episódio" com contagem regressiva — igual ao encerramento do Crunchyroll. */}
      {!locked && onNextEpisode && nextEpisodePrompt.visible ? (
        <div className={styles.nextEpisodeCard} role="dialog" aria-label="Próximo episódio">
          <div className={styles.nextEpisodeHeader}>
            <div className={styles.nextEpisodeHeading}>
              <span className={styles.nextEpisodeKicker}>Próximo episódio</span>
              {nextEpisodeLabel ? <strong className={styles.nextEpisodeTitle}>{nextEpisodeLabel}</strong> : null}
            </div>
            {!manualEndingVisit && nextEpisodeCountdownStart(skipBlocks, duration) !== null ? <svg className={styles.nextEpisodeRing} viewBox="0 0 40 40" aria-hidden="true">
              <circle cx="20" cy="20" r="17" className={styles.nextEpisodeRingTrack} />
              <circle
                cx="20"
                cy="20"
                r="17"
                className={styles.nextEpisodeRingFill}
                style={{
                  strokeDasharray: 106.8,
                  strokeDashoffset: 106.8 * (1 - nextEpisodePrompt.countdownSeconds / NEXT_EPISODE_COUNTDOWN_SECONDS)
                }}
              />
              <text x="20" y="24" textAnchor="middle" className={styles.nextEpisodeRingText}>
                {nextEpisodePrompt.countdownSeconds}
              </text>
            </svg> : null}
          </div>
          <div className={styles.nextEpisodeActions}>
            <button
              type="button"
              className={styles.nextEpisodeCancelBtn}
              onClick={() => setNextEpisodeCancelled(true)}
            >
              Cancelar
            </button>
            <button
              ref={nextEpisodeWatchRef}
              type="button"
              className={styles.nextEpisodeWatchBtn}
              onClick={onNextEpisode}
            >
              Assistir agora
            </button>
          </div>
        </div>
      ) : null}

      {/* Interface Principal do Player — PC e celular seguem exatamente como sempre (ramo de
          baixo, sem nenhuma linha tocada); a TV (Task 4) ganha sua marcação própria aqui,
          reaproveitando os MESMOS estados e handlers acima (nenhuma lógica de reprodução nova). */}
      {tv ? (
      <div className={`${styles.tvInterface} ${controlsVisible && !locked && !pauseIdleActive ? styles.tvVisible : ""}`} data-tv-rows>
        <button
          type="button"
          className={styles.dismissControls}
          onClick={() => {
            transitionOverlay({ type: "backgroundTap" });
            setSystemCursorVisible(false);
          }}
          aria-label="Ocultar controles"
          tabIndex={-1}
        />

        {/* Topo: Voltar + atalhos grandes (Episódios/Anterior/Próximo) à esquerda, com o nome do
            ícone focado embaixo (como "OPTIONS" na referência); título e T:E à direita. */}
        <header className={styles.tvTop}>
          <div className={styles.tvTopLeft} data-tv-row="top">
            <button
              type="button"
              className={styles.tvIconBtn}
              aria-label="Voltar"
              onClick={handleTvBack}
              onFocus={() => setTvFocusLabel("Voltar")}
              onBlur={() => setTvFocusLabel((prev) => (prev === "Voltar" ? null : prev))}
            >
              <IconTvBack />
            </button>
            {episodes && episodes.length > 1 && onSelectEpisode ? (
              <button
                type="button"
                className={styles.tvIconBtn}
                aria-label="Episódios"
                onClick={() => setMenu(menu === "episodes" ? null : "episodes")}
                onFocus={() => setTvFocusLabel("Episódios")}
                onBlur={() => setTvFocusLabel((prev) => (prev === "Episódios" ? null : prev))}
              >
                <IconEpisodes />
              </button>
            ) : null}
            {previousEpisodeLabel && onPreviousEpisode ? (
              <button
                type="button"
                className={styles.tvIconBtn}
                aria-label="Episódio anterior"
                onClick={onPreviousEpisode}
                onFocus={() => setTvFocusLabel("Anterior")}
                onBlur={() => setTvFocusLabel((prev) => (prev === "Anterior" ? null : prev))}
              >
                <IconPreviousEpisode />
              </button>
            ) : null}
            {nextEpisodeLabel && onNextEpisode ? (
              <button
                type="button"
                className={styles.tvIconBtn}
                aria-label="Próximo episódio"
                onClick={onNextEpisode}
                onFocus={() => setTvFocusLabel("Próximo")}
                onBlur={() => setTvFocusLabel((prev) => (prev === "Próximo" ? null : prev))}
              >
                <IconNextEpisode />
              </button>
            ) : null}
            {tvFocusLabel ? <span className={styles.tvIconCaption}>{tvFocusLabel}</span> : null}
          </div>

          <div className={styles.tvTopRight}>
            <strong className={styles.tvTitle}>{title}</strong>
            {episodeLabel ? <span className={styles.tvEpisodeLabel}>{episodeLabel}</span> : null}
            <span className={styles.tvSourcePill}>{source.quality || "HD"}{source.readyNow ? " · RD+" : ""}</span>
          </div>
        </header>

        {error ? <p className={styles.warning} role="alert">{error}</p> : null}

        {/* Rodapé: play/pausa, tempo, barra fina e duração; embaixo, as pílulas de áudio/legenda. */}
        <footer className={styles.tvBottom} data-player-footer>
          <div className={styles.tvMiddleRow} data-tv-row="middle">
            <button
              ref={tvPlayPauseRef}
              type="button"
              className={styles.tvPlayPauseBtn}
              onClick={() => void togglePlayback()}
              aria-label={playing ? "Pausar" : "Reproduzir"}
            >
              {playing ? <IconNetflixPause className={styles.tvPlayIcon} /> : <IconNetflixPlay className={styles.tvPlayIcon} />}
            </button>

            <span className={styles.tvTime}>{clock(tvShownPosition)}</span>

            <div className={styles.tvProgressWrap}>
              <div className={styles.tvProgressTrack}>
                <div className={styles.tvProgressFill} style={{ width: `${progressPercent}%` }} />
              </div>
              <input
                type="range"
                min={0}
                max={Math.max(1, duration)}
                value={Math.min(tvShownPosition, duration > 0 ? duration : tvShownPosition)}
                onChange={(event) => void seek(Number(event.target.value))}
                aria-label="Posição do vídeo"
                className={styles.tvProgressInput}
                data-tv-progress
              />
            </div>

            <span className={styles.tvTime}>{clock(duration)}</span>
          </div>

          <div className={styles.tvPillsRow} data-tv-row="pills">
            <button
              type="button"
              className={styles.tvGearPill}
              aria-label="Áudio, legendas, fontes e ajustes"
              onClick={() => { setLanguageTab("audio"); setMenu("languages"); }}
            >
              <IconGear />
            </button>
            <button
              type="button"
              className={styles.tvPill}
              onClick={() => { setLanguageTab("subtitles"); setMenu("languages"); }}
            >
              {subtitleTrack !== null ? <IconCheck className={styles.tvPillCheck} /> : null}
              <span>{subtitleTrack === null ? "Legenda desligada" : subtitles.find((track) => track.id === subtitleTrack)?.label ?? "Legenda"}</span>
            </button>
          </div>
        </footer>

        {/* Painel de Áudio, Legendas e Fontes — três colunas, mesmos dados e funções de sempre
            (chooseAudio/chooseSubtitle/onSelectSource); só a marcação muda para a TV. */}
        {menu === "languages" && languageTab !== "settings" ? (() => {
          // Painel lateral (mesma posição/transparência dos Ajustes): Áudio · Legendas · Fontes · Ajustes
          // viram abas no topo — ←/→ trocam de aba, ↑/↓ andam pela lista da aba atual.
          const tabs = tvSettingsTabs;
          return (
          <div className={`${styles.tvPanelBackdrop} ${styles.tvPanelBackdropSide}`} style={tvPanelBottom ? { paddingBottom: tvPanelBottom } : undefined} onClick={() => setMenu(null)}>
            <div
              className={`${styles.tvPanel} ${styles.tvSidePanel}`}
              data-tv-columns
              data-tv-tabs={tabs.map(([id]) => id).join(",")}
              data-tv-current={languageTab}
              onClick={(event) => event.stopPropagation()}
              role="dialog"
              aria-label="Áudio, legendas e fontes"
            >
              <div className={styles.tvSideTabs} aria-hidden="true">
                {tabs.map(([id, label]) => (
                  <span key={id} className={`${styles.tvSideTab} ${languageTab === id ? styles.tvSideTabActive : ""}`}>{label}</span>
                ))}
              </div>

              {languageTab === "audio" ? (
              <div className={styles.tvPanelColumn} data-tv-col>
                {audio.length === 0 ? (
                  // Botão (e não div): sem nenhum item focável o foco não entra no painel e o
                  // controle remoto fica preso — ←/→ nem voltam para Legendas.
                  <button
                    type="button"
                    className={`${styles.tvPanelItem} ${styles.tvPanelItemSelected}`}
                    data-tv-selected=""
                    onClick={() => setMenu(null)}
                  >
                    <span>
                      {mainAudioLabel}
                      {/* O player do navegador da Samsung toca só a faixa padrão do MKV e não deixa
                          trocar (a conversão do Real-Debrid com outro áudio não responde no meio do
                          arquivo — medido em 04/10/2026). Dizer isso evita parecer defeito. */}
                      <span className={styles.tvSourceMeta}>Toca a faixa principal do arquivo · trocar o áudio não é possível nesta TV</span>
                    </span>
                    <IconCheck className={styles.checkIcon} />
                  </button>
                ) : audio.map((track) => (
                  <button
                    key={track.id}
                    type="button"
                    className={`${styles.tvPanelItem} ${audioTrack === track.id ? styles.tvPanelItemSelected : ""}`}
                    data-tv-selected={audioTrack === track.id ? "" : undefined}
                    onClick={() => void chooseAudio(track.id)}
                  >
                    <span>{track.label}</span>
                    {audioTrack === track.id ? <IconCheck className={styles.checkIcon} /> : null}
                  </button>
                ))}
              </div>
              ) : null}

              {languageTab === "subtitles" ? (
              <div className={styles.tvPanelColumn} data-tv-col>
                <button
                  type="button"
                  className={`${styles.tvPanelItem} ${subtitleTrack === null ? styles.tvPanelItemSelected : ""}`}
                  data-tv-selected={subtitleTrack === null ? "" : undefined}
                  onClick={() => void chooseSubtitle(null)}
                >
                  <span>Desligadas</span>
                  {subtitleTrack === null ? <IconCheck className={styles.checkIcon} /> : null}
                </button>
                {(() => {
                  // Listas de 90+ legendas são inviáveis no controle: português (e a legenda em
                  // uso, de qualquer idioma) fica à vista; o resto espera atrás de um botão.
                  const isPortuguese = (track: PlayerTrack) => {
                    const language = trackLanguage(track);
                    return language === "pt-BR" || language === "pt";
                  };
                  const hasPortuguese = subtitles.some(isPortuguese);
                  const visible = !hasPortuguese || tvShowOtherSubtitles
                    ? subtitles
                    : subtitles.filter((track) => isPortuguese(track) || track.id === subtitleTrack);
                  const hidden = subtitles.length - visible.length;
                  // Com tudo expandido a ordem original vale; recolhida, a legenda em uso de outro
                  // idioma já vem logo após "Desligadas" (os PT seguem a ordem de qualidade).
                  const ordered = hasPortuguese && !tvShowOtherSubtitles
                    ? [...visible.filter((track) => track.id === subtitleTrack), ...visible.filter((track) => track.id !== subtitleTrack)]
                    : visible;
                  const renderTrack = (track: PlayerTrack, firstOther: boolean) => (
                    <button
                      key={track.id}
                      type="button"
                      className={`${styles.tvPanelItem} ${subtitleTrack === track.id ? styles.tvPanelItemSelected : ""}`}
                      data-tv-selected={subtitleTrack === track.id ? "" : undefined}
                      data-tv-first-other={firstOther ? "" : undefined}
                      onClick={() => void chooseSubtitle(track.id)}
                    >
                      {(() => {
                        // Idioma em destaque; release · fonte, discreto embaixo.
                        const { language, details } = splitSubtitleLabel(track.label);
                        return (
                          <span className={styles.tvItemText}>
                            <span>{language || track.label}</span>
                            {details ? <span className={styles.tvSourceMeta}>{details}</span> : null}
                          </span>
                        );
                      })()}
                      {subtitleTrack === track.id ? <IconCheck className={styles.checkIcon} /> : null}
                    </button>
                  );
                  if (!hasPortuguese || !tvShowOtherSubtitles) {
                    return (
                      <>
                        {ordered.map((track) => renderTrack(track, false))}
                        {hidden > 0 ? (
                          <button type="button" className={styles.tvPanelItem} onClick={() => setTvShowOtherSubtitles(true)}>
                            <span>Outros idiomas ({hidden})</span>
                          </button>
                        ) : null}
                      </>
                    );
                  }
                  // Expandido: o botão some; o foco vai para o primeiro item "outro" (efeito acima).
                  const firstOtherId = subtitles.find((track) => !isPortuguese(track) && track.id !== subtitleTrack)?.id;
                  return <>{ordered.map((track) => renderTrack(track, track.id === firstOtherId))}</>;
                })()}
              </div>
              ) : null}

              {languageTab === "sources" && sourceOptions.length > 0 ? (
                <div className={styles.tvPanelColumn} data-tv-col>
                  {/* Os mesmos filtros do PC (mesmo estado e mesma `filteredSources`). Na TV cada um
                      vira uma linha e o OK alterna o valor: aqui ←/→ já trocam de aba. */}
                  <p className={styles.tvSettingsGroup}>Filtros</p>
                  <button type="button" className={styles.tvPanelItem} onClick={() => setSourceLanguage(cycleOption(["all", "pt", "en"] as const, sourceLanguage))}>
                    <span>Áudio</span>
                    <span>{sourceLanguage === "all" ? "Todos os áudios" : sourceLanguage === "pt" ? "Português (Brasil)" : "Inglês"}</span>
                  </button>
                  <button type="button" className={styles.tvPanelItem} onClick={() => setSourceQuality(cycleOption(["all", "1080p", "4K"] as const, sourceQuality))}>
                    <span>Qualidade</span>
                    <span>{sourceQuality === "all" ? "Todas as qualidades" : sourceQuality === "1080p" ? "Full HD" : "4K"}</span>
                  </button>
                  <button type="button" className={styles.tvPanelItem} onClick={() => setSourceSubtitleLanguage(cycleOption(["all", "pt", "en"] as const, sourceSubtitleLanguage))}>
                    <span>Legenda</span>
                    <span>{sourceSubtitleLanguage === "all" ? "Legendas anunciadas" : sourceSubtitleLanguage === "pt" ? "PT anunciada" : "EN anunciada"}</span>
                  </button>

                  <p className={styles.tvSettingsGroup}>Fontes ({filteredSources.length})</p>
                  {filteredSources.length === 0 ? (
                    <p className={styles.tvSourceMeta}>Nenhuma fonte disponível com esses filtros.</p>
                  ) : filteredSources.map((option) => {
                    // Qualidade em destaque; etiquetas do nome do release e, embaixo, tamanho · seeders · site.
                    const tags = sourceReleaseTags(option.label);
                    if (option.readyNow) tags.push("Pronta");
                    return (
                      <button
                        key={option.id}
                        type="button"
                        className={`${styles.tvPanelItem} ${option.id === currentSourceId ? styles.tvPanelItemSelected : ""}`}
                        onClick={() => { void Promise.resolve(onSelectSource?.(option.id)).then(() => setMenu(null)); }}
                        disabled={!onSelectSource || option.id === currentSourceId}
                      >
                        <span className={styles.tvItemText}>
                          <span className={styles.tvSourceHead}>
                            <span>{option.quality}</span>
                            {tags.map((tag) => <span key={tag} className={styles.tvSourceTag}>{tag}</span>)}
                          </span>
                          {option.details ? <span className={styles.tvSourceMeta}>{option.details}</span> : null}
                        </span>
                        {option.id === currentSourceId ? <IconCheck className={styles.checkIcon} /> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </div>
          );
        })() : null}

        {/* Ajustes (engrenagem): tudo que não coube na tela principal — velocidade, volume,
            bloqueio, sincronização/aparência de legenda, pular abertura automaticamente e
            informações da fonte. Mesmas funções do PC, sem nada novo. */}
        {menu === "languages" && languageTab === "settings" ? (
          <div className={`${styles.tvPanelBackdrop} ${styles.tvPanelBackdropSide}`} style={tvPanelBottom ? { paddingBottom: tvPanelBottom } : undefined} onClick={() => setMenu(null)}>
            <div
              className={styles.tvSettingsPanel}
              data-tv-rows
              data-tv-panel
              data-tv-tabs={tvSettingsTabs.map(([id]) => id).join(",")}
              data-tv-current="settings"
              onClick={(event) => event.stopPropagation()}
              role="dialog"
              aria-label="Ajustes"
            >
              {/* Mesmo cabeçalho de abas do painel de colunas; só a aba ativa é focável (o âncora),
                  porque ←/→ nas linhas de baixo mudam VALORES. ←/→ no âncora trocam de aba. */}
              <div className={styles.tvSideTabs} data-tv-row>
                {tvSettingsTabs.map(([id, label]) => id === "settings" ? (
                  <button key={id} type="button" data-tv-tab-anchor className={`${styles.tvSideTab} ${styles.tvSideTabActive} ${styles.tvSideTabAnchor}`}>{label}</button>
                ) : (
                  <span key={id} className={styles.tvSideTab} aria-hidden="true">{label}</span>
                ))}
              </div>

              {/* Lista estilo TV: dois grupos, uma opção por linha com o valor atual entre ‹ ›.
                  ↑/↓ escolhem a linha, ←/→ mudam o valor. Ações avulsas ficam no fim do grupo. */}
              <p className={styles.tvSettingsGroup}>Reprodução</p>
              <TvSettingStepper
                label="Velocidade"
                value={`${playbackRate}x`}
                onStep={(delta) => changePlaybackRate(stepOption(PLAYBACK_RATES, playbackRate as (typeof PLAYBACK_RATES)[number], delta))}
              />
              {player.changeVolume ? (
                <TvSettingStepper
                  label="Volume"
                  value={muted || volume <= 0 ? "Mudo" : `${Math.round(volume * 100)}%`}
                  onStep={(delta) => {
                    if (muted) {
                      void toggleMuted();
                      if (delta < 0) return;
                    }
                    void handleVolumeChange(Math.max(0, Math.min(1, Math.round((muted ? 0 : volume) * 10 + delta) / 10)));
                  }}
                />
              ) : null}
              <TvSettingStepper
                label="Pular abertura"
                value={autoSkipIntro ? "Automático" : "Desligado"}
                onStep={() => setAutoSkipIntro(!autoSkipIntro)}
              />

              <p className={styles.tvSettingsGroup}>Legenda</p>
              <TvSettingStepper
                label="Fonte"
                value={TV_SUBTITLE_FONTS.find(([id]) => id === (subtitleSettings.fontFace ?? "netflix"))?.[1]}
                onStep={(delta) => applySubtitleSettings({ ...subtitleSettings, fontFace: stepOption(TV_SUBTITLE_FONTS.map(([id]) => id), subtitleSettings.fontFace ?? "netflix", delta) })}
              />
              <TvSettingStepper
                label="Contorno"
                value={TV_SUBTITLE_EDGES.find(([id]) => id === (subtitleSettings.edge ?? "netflix"))?.[1]}
                onStep={(delta) => applySubtitleSettings({ ...subtitleSettings, edge: stepOption(TV_SUBTITLE_EDGES.map(([id]) => id), subtitleSettings.edge ?? "netflix", delta) })}
              />
              <TvSettingStepper
                label="Fundo"
                value={TV_SUBTITLE_BACKGROUNDS.find(([id]) => id === subtitleSettings.bg)?.[1]}
                onStep={(delta) => applySubtitleSettings({ ...subtitleSettings, bg: stepOption(TV_SUBTITLE_BACKGROUNDS.map(([id]) => id), subtitleSettings.bg, delta) })}
              />
              <TvSettingStepper
                label="Tamanho"
                value={({ 80: "Pequeno", 100: "Médio", 125: "Grande", 150: "Muito grande" } as Record<number, string>)[subtitleSettings.size] ?? `${subtitleSettings.size}%`}
                onStep={(delta) => applySubtitleSettings({ ...subtitleSettings, size: stepOption([80, 100, 125, 150], subtitleSettings.size, delta) })}
              />
              <TvSettingStepper
                label="Altura"
                value={({ 0: "Padrão", 8: "Um pouco acima", 16: "Acima", 24: "Bem acima" } as Record<number, string>)[subtitleSettings.position ?? 0] ?? "Padrão"}
                onStep={(delta) => applySubtitleSettings({ ...subtitleSettings, position: stepOption([0, 8, 16, 24], subtitleSettings.position ?? 0, delta) })}
              />
              <TvSettingStepper
                label="Cor"
                value={(() => {
                  const current = SUBTITLE_COLORS.find((color) => color.value.toLowerCase() === subtitleSettings.color.toLowerCase());
                  return (
                    <>
                      <span className={styles.tvStepperSwatch} style={{ backgroundColor: subtitleSettings.color }} aria-hidden="true" />
                      {current?.label ?? "Personalizada"}
                    </>
                  );
                })()}
                onStep={(delta) => {
                  const values = SUBTITLE_COLORS.map((color) => color.value.toLowerCase());
                  applySubtitleSettings({ ...subtitleSettings, color: stepOption(values, subtitleSettings.color.toLowerCase(), delta) });
                }}
              />
              <TvSettingStepper
                label="Sincronia"
                value={`${subtitleSettings.offset > 0 ? "+" : ""}${subtitleSettings.offset.toFixed(1).replace(".", ",")} s`}
                onStep={(delta) => updateSubtitleOffset(delta * 0.5)}
              />
              <div className={styles.tvSettingsSection} data-tv-row>
                <span className={styles.tvSettingsLabel} />
                <div className={styles.tvSettingsActions}>
                  <button type="button" className={styles.tvSettingsAction} onClick={resetSubtitleTiming}>
                    Restaurar tempo original
                  </button>
                  <button type="button" className={styles.tvSettingsAction} onClick={() => updateSubtitleOffset(0, true)}>Zerar</button>
                  <button
                    type="button"
                    className={styles.tvSettingsAction}
                    // Volta só a aparência; Sincronia e Altura (ajustes do aparelho/vídeo) ficam.
                              disabled={player.subtitleSettingsSupport?.() === "timing"}
                    onClick={() => applySubtitleSettings({ ...subtitleSettings, fontFace: "netflix", edge: "netflix", color: "#ffffff", size: 100, bg: "transparent" })}
                  >
                    Padrão Netflix
                  </button>
                  {subtitles.length > 1 ? (
                    <button type="button" className={styles.tvSettingsAction} onClick={() => void testNextSubtitle()}>Testar próxima legenda</button>
                  ) : null}
                </div>
              </div>

              <p className={styles.tvSettingsInfo}>
                Fonte: {source.addon} · {source.quality || "HD"}{source.readyNow ? " · RD+" : ""}
              </p>
            </div>
          </div>
        ) : null}

        {/* Lista de episódios — mesmos dados/handler (onSelectEpisode) do PC, em linhas grandes. */}
        {menu === "episodes" && episodes ? (
          <div className={`${styles.tvPanelBackdrop} ${styles.tvPanelBackdropSide}`} style={tvPanelBottom ? { paddingBottom: tvPanelBottom } : undefined} onClick={() => setMenu(null)}>
            <div className={styles.tvEpisodesPanel} data-tv-rows data-tv-panel onClick={(event) => event.stopPropagation()} role="dialog" aria-label="Lista de episódios">
              <strong className={styles.tvPanelColumnTitle}>Episódios</strong>
              {availableSeasons.length > 1 ? (
                <div className={styles.tvSettingsSection} data-tv-row>
                  {availableSeasons.map((season) => (
                    <button
                      key={season}
                      type="button"
                      className={`${styles.seasonTabBtn} ${selectedSeason === season ? styles.activeSeasonTabBtn : ""}`}
                      onClick={() => setSelectedSeason(season)}
                    >
                      {season === 0 ? "Especiais" : `Temporada ${season}`}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className={styles.tvEpisodesList}>
                {filteredEpisodes.map((ep) => {
                  const isCurrent = ep.id === currentVideoId;
                  return (
                    <div key={ep.id} className={styles.tvEpisodeRow} data-tv-row>
                      <button
                        ref={isCurrent ? activeEpisodeRef : null}
                        type="button"
                        className={`${styles.episodeItem} ${isCurrent ? styles.episodeItemActive : ""}`}
                        onClick={() => { onSelectEpisode?.(ep.id); setMenu(null); }}
                      >
                        {ep.thumbnail ? (
                          <div className={styles.episodeThumb}>
                            <img src={ep.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />
                            <span className={styles.episodeBadge}>E{ep.displayEpisode ?? ep.episode ?? "▶"}</span>
                          </div>
                        ) : null}
                        <div className={styles.episodeInfo}>
                          <strong className={styles.episodeTitle}>
                            {ep.episode !== null ? `${ep.displayEpisode ?? ep.episode}. ` : ""}{ep.title}
                          </strong>
                          {ep.season !== null ? (
                            <span className={styles.episodeSeason}>{ep.season === 0 ? "Especial" : `Temporada ${ep.season}`}</span>
                          ) : null}
                        </div>
                        {isCurrent ? <span className={styles.currentEpisodeTag}>Tocando agora</span> : null}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : null}
      </div>
      ) : (
      <div className={`${styles.interface} ${controlsVisible && !locked && !pauseIdleActive ? styles.visible : ""}`}>
        <button
          type="button"
          className={styles.dismissControls}
          onClick={() => {
            transitionOverlay({ type: "backgroundTap" });
            setSystemCursorVisible(false);
          }}
          aria-label="Ocultar controles"
        />
        {/* Header Superior (Sem seta de volta, apenas título e botão X para fechar) */}
        <header className={styles.top}>
          <div className={styles.heading}>
            <strong className={styles.mainTitle}>{title}</strong>
            {episodeLabel ? <span className={styles.episodeSubtitle}>{episodeLabel}</span> : null}
          </div>

          <div className={styles.topRightActions}>
            <span className={styles.sourcePill} title={source.label}>
              {source.quality || "HD"}
              {source.readyNow ? " · RD+" : ""}
            </span>
            <button type="button" className={styles.iconButton} onClick={toggleLock} aria-label="Bloquear tela" title="Bloquear tela para evitar toques acidentais">
              <IconLock />
            </button>
            <button type="button" className={styles.iconButton} onClick={onClose} aria-label="Fechar player" title="Fechar (Esc)">
              <IconClose />
            </button>
          </div>
        </header>

        {error ? <p className={styles.warning} role="alert">{error}</p> : null}

        {/* Controles Centrais Estilo Netflix com ícone "||" para pausa e espaçamento amplo */}
        <div className={styles.centerControls}>
          <button type="button" className={styles.netflixCenterBtn} onClick={() => seekBy(-10)} aria-label="Voltar 10 segundos" title="Voltar 10s (←)">
            <IconNetflixReplay10 className={styles.netflixSeekIcon} />
          </button>

          <button type="button" className={styles.netflixPlayHeroBtn} onClick={() => void togglePlayback()} aria-label={playing ? "Pausar vídeo" : "Reproduzir vídeo"} title={playing ? "Pausar (Espaço)" : "Reproduzir (Espaço)"}>
            {playing ? <IconNetflixPause className={styles.netflixPauseIcon} /> : <IconNetflixPlay className={styles.netflixPlayIcon} />}
          </button>

          <button type="button" className={styles.netflixCenterBtn} onClick={() => seekBy(10)} aria-label="Avançar 10 segundos" title="Avançar 10s (→)">
            <IconNetflixForward10 className={styles.netflixSeekIcon} />
          </button>
        </div>

        {/* Rodapé do Player */}
        <footer className={styles.bottom} data-player-footer>
          {/* Timeline Interativa */}
          <div
            className={styles.timelineWrapper}
            ref={timelineRef}
            onMouseMove={handleTimelineMouseMove}
            onMouseLeave={handleTimelineMouseLeave}
          >
            {hoverTimeline ? (
              <div
                className={styles.timelineTooltip}
                style={{ left: `${hoverTimeline.percent}%` }}
              >
                {clock(hoverTimeline.seconds)}
              </div>
            ) : null}

            <div className={styles.timelineTrack}>
              <div className={styles.timelineProgress} style={{ width: `${progressPercent}%` }} />
              <div className={styles.timelineThumb} style={{ left: `${progressPercent}%` }} />
            </div>

            <input
              type="range"
              min={0}
              max={Math.max(1, duration)}
              value={Math.min(position, duration > 0 ? duration : position)}
              onChange={(event) => void seek(Number(event.target.value))}
              aria-label="Posição do vídeo"
              className={styles.timelineInput}
            />
          </div>

          {/* Barra de Ações & Controles Inferiores */}
          <div className={styles.controlsRow}>
            <div className={styles.leftControls}>
              <div className={styles.brandBadge} aria-hidden="true" title="Cebola Streaming">
                <BrandIcon size={20} />
              </div>

              {/* Controle de Volume */}
              {player.changeVolume ? (
                <div className={styles.volumeGroup}>
                  <button
                    type="button"
                    className={styles.bottomBtn}
                    onClick={() => void toggleMuted()}
                    aria-label={muted ? "Ativar som (M)" : "Mutar som (M)"}
                    title={muted ? "Ativar som (M)" : "Mutar (M)"}
                  >
                    {muted || volume === 0 ? <IconVolumeMute /> : <IconVolumeHigh />}
                  </button>
                  <div className={styles.volumeSliderWrapper}>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.02}
                      value={muted ? 0 : volume}
                      onChange={(e) => void handleVolumeChange(Number(e.target.value))}
                      className={styles.volumeSlider}
                      aria-label="Controle de volume"
                    />
                  </div>
                </div>
              ) : null}

              {/* Tempo decorrido / restante */}
              <button
                type="button"
                className={styles.timeBadge}
                onClick={() => setShowRemainingTime((r) => !r)}
                title="Clique para alternar entre tempo total e tempo restante"
              >
                <span>{clock(position)}</span>
                <span className={styles.timeDivider}>/</span>
                <span className={styles.timeTotal}>
                  {showRemainingTime ? `-${clock(Math.max(0, duration - position))}` : clock(duration)}
                </span>
              </button>
            </div>

            {/* Ações da Direita */}
            <nav className={styles.rightControls} aria-label="Opções de reprodução">
              {episodes && episodes.length > 1 && onSelectEpisode ? (
                <button
                  type="button"
                  className={`${styles.bottomBtn} ${menu === "episodes" ? styles.activeBtn : ""}`}
                  onClick={() => setMenu(menu === "episodes" ? null : "episodes")}
                  aria-expanded={menu === "episodes"}
                  title="Lista de episódios"
                >
                  <IconEpisodes />
                  <span className={styles.btnLabel}>Episódios</span>
                </button>
              ) : null}

              {previousEpisodeLabel && onPreviousEpisode ? (
                <button
                  type="button"
                  className={styles.bottomBtn}
                  onClick={onPreviousEpisode}
                  title={`Anterior: ${previousEpisodeLabel}`}
                >
                  <IconPreviousEpisode />
                  <span className={styles.btnLabel}>Anterior</span>
                </button>
              ) : null}

              {nextEpisodeLabel && onNextEpisode ? (
                <button
                  type="button"
                  className={styles.bottomBtn}
                  onClick={onNextEpisode}
                  title={`Próximo: ${nextEpisodeLabel}`}
                >
                  <IconNextEpisode />
                  <span className={styles.btnLabel}>Próximo</span>
                </button>
              ) : null}

              <button
                type="button"
                className={`${styles.bottomBtn} ${menu === "languages" ? styles.activeBtn : ""}`}
                onClick={() => setMenu(menu === "languages" ? null : "languages")}
                aria-expanded={menu === "languages"}
                title="Áudio e legendas"
              >
                <IconSubtitles />
                <span className={styles.btnLabel}>Áudio & Legendas</span>
              </button>

              <button
                type="button"
                className={`${styles.bottomBtn} ${menu === "speed" ? styles.activeBtn : ""}`}
                onClick={() => setMenu(menu === "speed" ? null : "speed")}
                aria-expanded={menu === "speed"}
                title="Velocidade de reprodução"
              >
                <IconSpeed />
                <span className={styles.btnLabel}>{playbackRate}x</span>
              </button>

              <button
                type="button"
                className={`${styles.bottomBtn} ${menu === "info" ? styles.activeBtn : ""}`}
                onClick={() => setMenu(menu === "info" ? null : "info")}
                aria-expanded={menu === "info"}
                title="Informações da fonte"
              >
                <IconInfo />
              </button>

              <button
                type="button"
                className={styles.bottomBtn}
                onClick={() => void toggleFullscreen()}
                aria-label={isFullscreen ? "Sair da tela cheia (F)" : "Tela cheia (F)"}
                title={isFullscreen ? "Sair da tela cheia (F)" : "Tela cheia (F)"}
              >
                {isFullscreen ? <IconExitFullscreen /> : <IconFullscreen />}
              </button>
            </nav>
          </div>
        </footer>

        {/* Modal / Gaveta de Áudio, Legendas e Configurações */}
        {menu === "languages" ? (
          <div className={styles.drawerBackdrop} onClick={() => setMenu(null)}>
            <div className={styles.languagesDrawer} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Áudio e legendas">
              <header className={styles.drawerHeader}>
                <div className={styles.drawerTabs}>
                  <button
                    type="button"
                    className={`${styles.drawerTab} ${languageTab === "audio" ? styles.activeDrawerTab : ""}`}
                    onClick={() => setLanguageTab("audio")}
                  >
                    Áudio ({audio.length})
                  </button>
                  <button
                    type="button"
                    className={`${styles.drawerTab} ${languageTab === "subtitles" ? styles.activeDrawerTab : ""}`}
                    onClick={() => setLanguageTab("subtitles")}
                  >
                    Legendas ({subtitles.length})
                  </button>
                  <button
                    type="button"
                    className={`${styles.drawerTab} ${languageTab === "sources" ? styles.activeDrawerTab : ""}`}
                    onClick={() => setLanguageTab("sources")}
                  >
                    Fontes ({sourceOptions.length})
                  </button>
                  <button
                    type="button"
                    className={`${styles.drawerTab} ${languageTab === "settings" ? styles.activeDrawerTab : ""}`}
                    onClick={() => setLanguageTab("settings")}
                    aria-label="Ajustes"
                    title="Ajustes"
                    style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0.42rem 0.75rem" }}
                  >
                    <IconGear />
                  </button>
                </div>
                <button type="button" className={styles.drawerCloseBtn} onClick={() => setMenu(null)} aria-label="Fechar menu">
                  <IconClose />
                </button>
              </header>

              <div className={styles.drawerContent}>
                {languageTab === "audio" ? (
                  <div className={styles.trackList}>
                    {audio.length === 0 ? (
                      <p className={styles.emptyTrackNote}>{mainAudioLabel} · faixa principal do arquivo</p>
                    ) : (
                      audio.map((track) => {
                        const isSelected = audioTrack === track.id;
                        return (
                          <button
                            key={track.id}
                            type="button"
                            className={`${styles.trackItem} ${isSelected ? styles.trackItemSelected : ""}`}
                            onClick={() => void chooseAudio(track.id)}
                          >
                            <div className={styles.trackMeta}>
                              <strong className={styles.trackName}>{track.label}</strong>
                              <span className={styles.trackLang}>{visibleLanguage(track)}</span>
                            </div>
                            {isSelected ? <IconCheck className={styles.checkIcon} /> : null}
                          </button>
                        );
                      })
                    )}
                  </div>
                ) : languageTab === "subtitles" ? (
                  <div className={styles.trackList}>
                    <button
                      type="button"
                      className={`${styles.trackItem} ${subtitleTrack === null ? styles.trackItemSelected : ""}`}
                      onClick={() => void chooseSubtitle(null)}
                    >
                      <div className={styles.trackMeta}>
                        <strong className={styles.trackName}>Desligadas</strong>
                        <span className={styles.trackLang}>Sem legendas</span>
                      </div>
                      {subtitleTrack === null ? <IconCheck className={styles.checkIcon} /> : null}
                    </button>

                    {subtitles.map((track) => {
                      const isSelected = subtitleTrack === track.id;
                      return (
                        <button
                          key={track.id}
                          type="button"
                          className={`${styles.trackItem} ${isSelected ? styles.trackItemSelected : ""}`}
                          onClick={() => void chooseSubtitle(track.id)}
                        >
                          <div className={styles.trackMeta}>
                            <strong className={styles.trackName}>{track.label}</strong>
                            <span className={styles.trackLang}>{visibleLanguage(track)}</span>
                          </div>
                          {isSelected ? <IconCheck className={styles.checkIcon} /> : null}
                        </button>
                      );
                    })}

                    <div className={styles.subtitleTools}>
                      <button
                        type="button"
                        className={styles.subtitleTestBtn}
                        onClick={() => setLanguageTab("settings")}
                      >
                        ⚙️ Configurações de legendas
                      </button>

                      {subtitles.length > 1 ? (
                        <button
                          type="button"
                          className={styles.subtitleTestBtn}
                          onClick={() => void testNextSubtitle()}
                        >
                          🔄 Testar outra sincronização
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : languageTab === "sources" ? (
                  <div className={styles.sourceSelectionView}>
                    <section className={styles.sourceFilters} aria-label="Filtros de fontes">
                      <div className={styles.pillsGroup}>
                        {(["all", "pt", "en"] as const).map((value) => (
                          <button
                            key={value}
                            type="button"
                            className={`${styles.pillBtn} ${sourceLanguage === value ? styles.pillBtnActive : ""}`}
                            onClick={() => setSourceLanguage(value)}
                          >
                            {value === "all" ? "Todos os áudios" : value === "pt" ? "Português (Brasil)" : "Inglês"}
                          </button>
                        ))}
                      </div>
                      <div className={styles.pillsGroup}>
                        {(["all", "1080p", "4K"] as const).map((value) => (
                          <button
                            key={value}
                            type="button"
                            className={`${styles.pillBtn} ${sourceQuality === value ? styles.pillBtnActive : ""}`}
                            onClick={() => setSourceQuality(value)}
                          >
                            {value === "all" ? "Todas as qualidades" : value === "1080p" ? "Full HD" : "4K"}
                          </button>
                        ))}
                      </div>
                      <div className={styles.pillsGroup} aria-label="Idioma da legenda anunciada">
                        {(["all", "pt", "en"] as const).map((value) => (
                          <button
                            key={value}
                            type="button"
                            className={`${styles.pillBtn} ${sourceSubtitleLanguage === value ? styles.pillBtnActive : ""}`}
                            onClick={() => setSourceSubtitleLanguage(value)}
                          >
                            {value === "all" ? "Legendas anunciadas" : value === "pt" ? "PT anunciada" : "EN anunciada"}
                          </button>
                        ))}
                      </div>
                    </section>
                    <div className={styles.trackList}>
                      {filteredSources.length === 0 ? (
                        <p className={styles.emptyTrackNote}>Nenhuma fonte disponível com esses filtros.</p>
                      ) : filteredSources.map((option) => {
                        const selected = option.id === currentSourceId;
                        const languages = option.audioLanguages.length > 0
                          ? option.audioLanguages.map((language) => visibleLanguage({ id: language, label: language, language })).join(", ")
                          : "Áudio não informado";
                        const subtitleLanguages = option.subtitleLanguages.length > 0
                          ? option.subtitleLanguages.map((language) => visibleLanguage({ id: language, label: language, language })).join(", ")
                          : "não informada";
                        return (
                          <button
                            key={option.id}
                            type="button"
                            className={`${styles.trackItem} ${selected ? styles.trackItemSelected : ""}`}
                            onClick={() => {
                              void Promise.resolve(onSelectSource?.(option.id)).then(() => setMenu(null));
                            }}
                            disabled={!onSelectSource || selected}
                          >
                            <div className={styles.trackMeta}>
                              <strong className={styles.trackName}>{option.addon} · {option.quality}</strong>
                              <span className={styles.trackLang}>{languages}{option.readyNow ? " · Pronta agora" : ""}</span>
                              <span className={styles.trackLang}>{option.subtitleLanguages.length > 0 ? `Legenda anunciada: ${subtitleLanguages}` : "Idioma da legenda não informado"}</span>
                              <span className={styles.sourceDetails}>{option.details || option.label}</span>
                            </div>
                            {selected ? <IconCheck className={styles.checkIcon} /> : null}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  /* Aba de Configurações, Sincronia e Estilo da Legenda */
                  <div className={styles.subtitleSettingsView}>
                    {player.subtitleSettingsSupport?.() === "timing" ? (
                      <p role="status">Nesta faixa embutida, somente o atraso pode ser ajustado. Para mudar cor, posição, fonte ou duração, selecione uma legenda externa.</p>
                    ) : null}
                    {/* 1. Restaurar os tempos originais da legenda */}
                    <section className={styles.subtitleSettingGroup}>
                      <button
                        type="button"
                        className={styles.subtitleAutoSyncBtn}
                        onClick={resetSubtitleTiming}
                      >
                        <IconSubtitles />
                        <span>Restaurar tempo original</span>
                      </button>

                      {subtitles.length > 1 ? (
                        <button
                          type="button"
                          className={styles.syncAdjustBtn}
                          style={{ width: "100%", padding: "0.6rem", textAlign: "center" }}
                          onClick={() => void testNextSubtitle()}
                        >
                          Testar próxima sincronização
                        </button>
                      ) : null}
                    </section>

                    {/* 2. Ajuste manual */}
                    <section className={styles.subtitleSettingGroup}>
                      <div className={styles.syncDelayRow}>
                        <strong style={{ color: "#ffffff", fontSize: "0.94rem" }}>Ajuste manual</strong>
                        <div className={styles.syncDelayBadge}>
                          {subtitleSettings.offset === 0 ? "0.0s" : `${subtitleSettings.offset > 0 ? `+${subtitleSettings.offset}` : subtitleSettings.offset}s`}
                        </div>
                      </div>

                      <div className={styles.syncAdjustBtns}>
                        <button type="button" className={styles.syncAdjustBtn} onClick={() => updateSubtitleOffset(-0.5)}>−0.5s</button>
                        <button type="button" className={styles.syncAdjustBtn} onClick={() => updateSubtitleOffset(-0.1)}>−0.1s</button>
                        <button type="button" className={styles.syncAdjustBtn} onClick={() => updateSubtitleOffset(0, true)}>0.0s</button>
                        <button type="button" className={styles.syncAdjustBtn} onClick={() => updateSubtitleOffset(0.1)}>+0.1s</button>
                        <button type="button" className={styles.syncAdjustBtn} onClick={() => updateSubtitleOffset(0.5)}>+0.5s</button>
                      </div>

                      <input
                        type="range"
                        min={-5}
                        max={5}
                        step={0.1}
                        value={subtitleSettings.offset}
                        onChange={(e) => updateSubtitleOffset(Number(e.target.value), true)}
                        className={styles.syncSlider}
                        aria-label="Ajuste de atraso de legenda em segundos"
                      />
                    </section>

                    {/* 3. Duração na tela */}
                    <section className={styles.subtitleSettingGroup}>
                      <strong style={{ color: "#ffffff", fontSize: "0.94rem" }}>Duração na tela</strong>

                      <div className={styles.pillsGroup}>
                        {[
                          { label: "Padrão", value: 0 },
                          { label: "+0.5s", value: 0.5 },
                          { label: "+1.0s", value: 1.0 },
                          { label: "+1.5s", value: 1.5 }
                        ].map((opt) => (
                          <button
                            key={opt.value}
                            type="button"
                            className={`${styles.pillBtn} ${subtitleSettings.extraDuration === opt.value ? styles.pillBtnActive : ""}`}
                              disabled={player.subtitleSettingsSupport?.() === "timing"}
                            onClick={() => applySubtitleSettings({ ...subtitleSettings, extraDuration: opt.value })}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </section>

                    {/* 4. Aparência */}
                    <section className={styles.subtitleSettingGroup}>
                      <strong style={{ color: "#ffffff", fontSize: "0.94rem" }}>Aparência</strong>

                      <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
                        <span style={{ fontSize: "0.8rem", fontWeight: 700, color: "#9ca3af" }}>Cor:</span>
                        <div className={styles.colorSwatches}>
                          {SUBTITLE_COLORS.map((c) => (
                            <button
                              key={c.value}
                              type="button"
                              className={`${styles.colorSwatch} ${subtitleSettings.color.toLowerCase() === c.value.toLowerCase() ? styles.colorSwatchActive : ""}`}
                              style={{ backgroundColor: c.value }}
                              disabled={player.subtitleSettingsSupport?.() === "timing"}
                              onClick={() => applySubtitleSettings({ ...subtitleSettings, color: c.value })}
                              title={c.label}
                              aria-label={c.label}
                            />
                          ))}
                        </div>
                      </div>

                      <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
                        <span style={{ fontSize: "0.8rem", fontWeight: 700, color: "#9ca3af" }}>Tamanho:</span>
                        <div className={styles.pillsGroup}>
                          {[
                            { label: "P (80%)", value: 80 },
                            { label: "M (100%)", value: 100 },
                            { label: "G (125%)", value: 125 },
                            { label: "GG (150%)", value: 150 }
                          ].map((s) => (
                            <button
                              key={s.value}
                              type="button"
                              className={`${styles.pillBtn} ${subtitleSettings.size === s.value ? styles.pillBtnActive : ""}`}
                              disabled={player.subtitleSettingsSupport?.() === "timing"}
                              onClick={() => applySubtitleSettings({ ...subtitleSettings, size: s.value })}
                            >
                              {s.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
                        <span style={{ fontSize: "0.8rem", fontWeight: 700, color: "#9ca3af" }}>Fundo:</span>
                        <div className={styles.pillsGroup}>
                          {[
                            { label: "Transparente", value: "transparent" as const },
                            { label: "Translúcido", value: "translucent" as const },
                            { label: "Sólido", value: "solid" as const }
                          ].map((bg) => (
                            <button
                              key={bg.value}
                              type="button"
                              className={`${styles.pillBtn} ${subtitleSettings.bg === bg.value ? styles.pillBtnActive : ""}`}
                              disabled={player.subtitleSettingsSupport?.() === "timing"}
                              onClick={() => applySubtitleSettings({ ...subtitleSettings, bg: bg.value })}
                            >
                              {bg.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
                        <span style={{ fontSize: "0.8rem", fontWeight: 700, color: "#9ca3af" }}>Fonte:</span>
                        <div className={styles.pillsGroup}>
                          {[
                            { label: "Sans", value: "sans" as const },
                            { label: "Serif", value: "serif" as const },
                            { label: "Mono", value: "mono" as const }
                          ].map((f) => (
                            <button
                              key={f.value}
                              type="button"
                              className={`${styles.pillBtn} ${subtitleSettings.font === f.value ? styles.pillBtnActive : ""}`}
                              disabled={player.subtitleSettingsSupport?.() === "timing"}
                              onClick={() => applySubtitleSettings({ ...subtitleSettings, font: f.value })}
                            >
                              {f.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
                        <span style={{ fontSize: "0.8rem", fontWeight: 700, color: "#9ca3af" }}>Posição:</span>
                        <div className={styles.pillsGroup}>
                          {[[0, "Padrão"], [8, "Mais alta"], [16, "Alta"], [24, "Centro"]].map(([value, label]) => (
                            <button
                              key={value}
                              type="button"
                              className={`${styles.pillBtn} ${(subtitleSettings.position ?? 0) === value ? styles.pillBtnActive : ""}`}
                              disabled={player.subtitleSettingsSupport?.() === "timing"}
                              onClick={() => applySubtitleSettings({ ...subtitleSettings, position: Number(value) })}
                            >{label}</button>
                          ))}
                        </div>
                      </div>

                      {/* Pré-visualização da legenda em tempo real */}
                      <div className={styles.subtitlePreviewWrapper}>
                        <span>Pré-visualização:</span>
                        <div className={styles.subtitlePreviewBox}>
                          <div
                            className={`${styles.subtitlePreviewCue} ${styles[`subtitleBg_${subtitleSettings.bg}`]} ${styles[`subtitleFont_${subtitleSettings.font}`]}`}
                            style={{
                              color: subtitleSettings.color,
                              fontSize: `clamp(0.95rem, ${1.1 * (subtitleSettings.size / 100)}rem, 1.8rem)`
                            }}
                          >
                            Exemplo de legenda no Cebola
                          </div>
                        </div>
                      </div>
                    </section>

                    {/* 5. Pular abertura automaticamente (task 4) */}
                    <section className={styles.subtitleSettingGroup}>
                      <strong style={{ color: "#ffffff", fontSize: "0.94rem" }}>Pular abertura automaticamente</strong>
                      <div className={styles.pillsGroup}>
                        <button
                          type="button"
                          className={`${styles.pillBtn} ${!autoSkipIntro ? styles.pillBtnActive : ""}`}
                          onClick={() => setAutoSkipIntro(false)}
                        >
                          Desligado
                        </button>
                        <button
                          type="button"
                          className={`${styles.pillBtn} ${autoSkipIntro ? styles.pillBtnActive : ""}`}
                          onClick={() => setAutoSkipIntro(true)}
                        >
                          Ligado
                        </button>
                      </div>
                    </section>
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : null}

        {/* Modal / Menu de Velocidade */}
        {menu === "speed" ? (
          <div className={styles.drawerBackdrop} onClick={() => setMenu(null)}>
            <div className={styles.speedMenu} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Velocidade de reprodução">
              <div className={styles.menuHeader}>
                <strong>Velocidade</strong>
                <button type="button" className={styles.drawerCloseBtn} onClick={() => setMenu(null)} aria-label="Fechar">
                  <IconClose />
                </button>
              </div>
              <div className={styles.speedList}>
                {PLAYBACK_RATES.map((rate) => (
                  <button
                    key={rate}
                    type="button"
                    className={`${styles.speedItem} ${playbackRate === rate ? styles.speedItemSelected : ""}`}
                    onClick={() => changePlaybackRate(rate)}
                  >
                    <span>{rate === 1 ? "1.0x (Normal)" : `${rate}x`}</span>
                    {playbackRate === rate ? <IconCheck className={styles.checkIcon} /> : null}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {/* Gaveta de Episódios com seletor de temporadas e foco na temporada atual */}
        {menu === "episodes" && episodes ? (
          <div className={styles.drawerBackdrop} onClick={() => setMenu(null)}>
            <div className={styles.episodesDrawer} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Lista de episódios">
              <div className={styles.drawerHeader}>
                <strong>Episódios</strong>
                <button type="button" className={styles.drawerCloseBtn} onClick={() => setMenu(null)} aria-label="Fechar">
                  <IconClose />
                </button>
              </div>

              {availableSeasons.length > 1 ? (
                <div className={styles.seasonTabsWrapper}>
                  {availableSeasons.map((season) => (
                    <button
                      key={season}
                      type="button"
                      className={`${styles.seasonTabBtn} ${selectedSeason === season ? styles.activeSeasonTabBtn : ""}`}
                      onClick={() => setSelectedSeason(season)}
                    >
                      {season === 0 ? "Especiais" : `Temporada ${season}`}
                    </button>
                  ))}
                </div>
              ) : null}

              <div className={styles.episodesList}>
                {filteredEpisodes.map((ep) => {
                  const isCurrent = ep.id === currentVideoId;
                  return (
                    <button
                      key={ep.id}
                      ref={isCurrent ? activeEpisodeRef : null}
                      type="button"
                      className={`${styles.episodeItem} ${isCurrent ? styles.episodeItemActive : ""}`}
                      onClick={() => {
                        onSelectEpisode?.(ep.id);
                        setMenu(null);
                      }}
                    >
                      {ep.thumbnail ? (
                        <div className={styles.episodeThumb}>
                          <img src={ep.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />
                          <span className={styles.episodeBadge}>E{ep.displayEpisode ?? ep.episode ?? "▶"}</span>
                        </div>
                      ) : null}
                      <div className={styles.episodeInfo}>
                        <strong className={styles.episodeTitle}>
                          {ep.episode !== null ? `${ep.displayEpisode ?? ep.episode}. ` : ""}{ep.title}
                        </strong>
                        {ep.season !== null ? (
                          <span className={styles.episodeSeason}>
                            {ep.season === 0 ? "Especial" : `Temporada ${ep.season}`}
                          </span>
                        ) : null}
                      </div>
                      {isCurrent ? <span className={styles.currentEpisodeTag}>Tocando agora</span> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ) : null}

        {/* Painel de Informações da Fonte */}
        {menu === "info" ? (
          <div className={styles.drawerBackdrop} onClick={() => setMenu(null)}>
            <aside className={styles.infoModal} onClick={(e) => e.stopPropagation()} aria-label="Informações da fonte selecionada">
              <div className={styles.infoModalHeader}>
                <strong>Informações da Fonte</strong>
                <button type="button" className={styles.drawerCloseBtn} onClick={() => setMenu(null)} aria-label="Fechar">
                  <IconClose />
                </button>
              </div>
              <div className={styles.infoGrid}>
                <div className={styles.infoRow}>
                  <span>Add-on</span>
                  <strong>{source.addon}</strong>
                </div>
                <div className={styles.infoRow}>
                  <span>Qualidade</span>
                  <strong>{source.quality || "HD"}{source.readyNow ? " · RD+ Cache" : ""}</strong>
                </div>
                {source.details ? (
                  <div className={styles.infoRow}>
                    <span>Detalhes</span>
                    <strong>{source.details}</strong>
                  </div>
                ) : null}
                <div className={styles.infoRow}>
                  <span>Arquivo</span>
                  <small>{source.label}</small>
                </div>
              </div>
            </aside>
          </div>
        ) : null}
      </div>
      )}
    </div>,
    document.body
  );
}
