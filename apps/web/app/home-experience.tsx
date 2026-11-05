"use client";

import {
  Fragment,
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  RefObject,
  ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  startTransition
} from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { BrandIcon } from "./brand-icon";
import type { InstallPromptEvent } from "./pwa-client";
import { type EditorialLookup, useEditorial, youtubeId } from "./editorial";
import { cachedEditorialHome, loadEditorialCategory, loadEditorialHome } from "./editorial-home";
import { loadWithPool } from "./loading-pool";
import { contiguousReadyItems, nextCarouselIndex } from "./home-load-state";
import { useWebTrailers } from "./use-web-trailers";
import { TeaserFrame, useDelayedFlag } from "./teaser";
import { apiFetch, appPagePath, isNativeRuntime } from "./api-client";
import { reportDiagnostic } from "./diagnostics";
import { isLowEndDevice } from "./device-capability";
import { parseAvatarKey, getPresetById } from "./perfis/avatar-catalog";
import { AwardBadges } from "./award-badges";
import { catalogRailLabel } from "./catalog-rail-label";
import {
  cachedPersonalizedRecommendations,
  loadPersonalizedRecommendations,
  rememberPersonalizedRecommendations,
  type PersonalizedRecommendation,
  type RecommendationSignal
} from "./personalized-recommendations";
import { loadEmmyWinners, type EmmyWinnersData } from "./emmy-home";
import type { EmmyWinner, LibraryItem, PlaybackScenario } from "@cebola/contracts";
import { libraryResponseSchema } from "@cebola/contracts";
import { applyLibraryChange, importLegacyLibrary } from "./library-client";
import { fetchProgressItems, hideProgress, retryPendingProgress } from "./progress";
import { continueEntries, continueIdentity, metadataAddonForMedia } from "./continue-items";
import { useReturnToForeground } from "./foreground-refresh";
import { displayEpisodeNumber, episodeDisplayLabel } from "./episode-display";
import { MIN_SEARCH_QUERY_LENGTH, searchPageHref } from "./search-query";
import { useTvLayout } from "./tv/use-tv-layout";
import { useMobileBooks } from "./livros/use-mobile-books";
import { tvCardBackdropUrl, tvLogoUrl, tvPosterUrl } from "./tv/tv-layout";

// Pôster que não carrega é o erro mais barulhento da home: dezenas de cards por tela, cada um
// podendo falhar por conta própria. Reportar cada `onError` de `<img>` inundaria o registro de
// diagnóstico e escondia o resto. Em vez disso, um contador de módulo (zerado a cada montagem da
// home, ver `resetPosterFailureTracking` abaixo) só dispara UM evento quando o terceiro pôster
// falha — o suficiente para indicar "os pôsteres deste catálogo estão quebrados" sem virar ruído.
let posterFailureCount = 0;
let posterFailureReported = false;
let posterFailureSampleHost: string | null = null;

function resetPosterFailureTracking(): void {
  posterFailureCount = 0;
  posterFailureReported = false;
  posterFailureSampleHost = null;
}

function notePosterLoadFailure(src: string | null | undefined): void {
  posterFailureCount += 1;
  if (posterFailureSampleHost === null && src) {
    try { posterFailureSampleHost = new URL(src, window.location.href).host; } catch { /* URL relativa/inválida: sem host para amostrar. */ }
  }
  if (posterFailureReported || posterFailureCount < 3) return;
  posterFailureReported = true;
  reportDiagnostic("POSTERS_FAILED", `${posterFailureCount} pôsteres não carregaram nesta sessão da home`, {
    count: String(posterFailureCount),
    ...(posterFailureSampleHost ? { sampleHost: posterFailureSampleHost } : {})
  });
}

type Profile = {
  id: string;
  name: string;
  avatarUrl: string | null;
  hasPin: boolean;
};

export type ProgressItem = {
  id: string;
  addonId: string | null;
  playbackAddonId: string | null;
  mediaId: string;
  videoId: string;
  mediaType: "movie" | "series";
  title: string;
  episodeTitle: string | null;
  season: number | null;
  episode: number | null;
  posterUrl: string | null;
  positionSeconds: number;
  durationSeconds: number;
  completed: boolean;
  watched?: boolean;
  hiddenFromContinue?: boolean;
  updatedAt: string;
  // A API devolve o cenário (fonte, áudio, legenda); a home só o repassa ao concluir o item.
  playbackScenario?: PlaybackScenario | null;
};

type CatalogDescriptor = {
  addonId: string;
  catalogId: string;
  type: "movie" | "series";
  name: string;
};

export type CatalogItem = {
  id: string;
  type: "movie" | "series";
  name: string;
  poster: string | null;
  background: string | null;
  backgroundPreview?: string | null;
  logo?: string | null;
  description: string | null;
  releaseInfo: string | null;
  genres?: readonly string[];
};

type CatalogRail = CatalogDescriptor & { items: readonly CatalogItem[] };
type EditorialHomeItem = {
  tmdbId: number; type: "movie" | "series"; title: string; year: number | null;
  overview: string | null; posterUrl: string | null; backdropUrl: string | null; backdropPreviewUrl?: string | null; voteAverage: number | null;
};
type EditorialProvider = { id: number; name: string; logoUrl: string | null };
type EditorialHomeRail = { id: string; title: string; provider?: EditorialProvider | null; items: readonly EditorialHomeItem[] };
type SpotlightCandidate = { item: CatalogItem; rail: CatalogRail; provider: EditorialProvider | null };
type ViewState = "loading" | "ready" | "error";
type CatalogView = "home" | "movies" | "series" | "documentaries" | "anime" | "brazil";
export type HomeBootstrap = {
  activeProfile: Profile | null;
  progress: { items: readonly ProgressItem[] };
  library: { items: readonly LibraryItem[] };
  stremio: { linked: boolean };
};
/** Aviso de biblioteca acionável: falha ao sincronizar itens legados ou ao adicionar/remover. */
type LibraryNotice = { readonly message: string; readonly retry?: () => void };


/**
 * A fileira nasce com uma página de 20 e cresce de 20 em 20, até três cliques — decisão do
 * dono. O teto existe também no servidor (`MAX_PAGINAS_DA_HOME`), que é quem manda.
 */
const ITENS_POR_PAGINA = 20;
const MAX_PAGINAS_EDITORIAIS = 4;

export const TONES = ["tone-azure", "tone-plum", "tone-amber", "tone-forest", "tone-coral", "tone-violet"] as const;
const STREAMING_PROVIDER_IDS = new Set([8, 1899, 119, 337, 531, 350, 307, 283]);

function isProfile(value: unknown): value is Profile {
  if (typeof value !== "object" || value === null) return false;
  const profile = value as Partial<Profile>;
  return (
    typeof profile.id === "string" &&
    typeof profile.name === "string" &&
    (typeof profile.avatarUrl === "string" || profile.avatarUrl === null) &&
    typeof profile.hasPin === "boolean"
  );
}

export function isHomeBootstrap(value: unknown): value is HomeBootstrap {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Partial<HomeBootstrap>;
  return (body.activeProfile === null || isProfile(body.activeProfile)) &&
    typeof body.progress === "object" && body.progress !== null &&
    Array.isArray(body.progress.items) && body.progress.items.every(isProgressItem) &&
    libraryResponseSchema.safeParse(body.library).success &&
    typeof body.stremio === "object" && body.stremio !== null &&
    typeof body.stremio.linked === "boolean";
}

function isProgressItem(value: unknown): value is ProgressItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<ProgressItem>;
  return (
    typeof item.id === "string" &&
    (typeof item.addonId === "string" || item.addonId === null) &&
    (typeof item.playbackAddonId === "string" || item.playbackAddonId === null) &&
    typeof item.mediaId === "string" &&
    typeof item.videoId === "string" &&
    (item.mediaType === "movie" || item.mediaType === "series") &&
    typeof item.title === "string" &&
    typeof item.positionSeconds === "number" &&
    typeof item.durationSeconds === "number" &&
    typeof item.completed === "boolean" &&
    typeof item.updatedAt === "string"
  );
}

function isCatalogDescriptor(value: unknown): value is CatalogDescriptor {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<CatalogDescriptor>;
  return (
    typeof item.addonId === "string" &&
    typeof item.catalogId === "string" &&
    (item.type === "movie" || item.type === "series") &&
    typeof item.name === "string"
  );
}

export function isCatalogItem(value: unknown): value is CatalogItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<CatalogItem>;
  return (
    typeof item.id === "string" &&
    (item.type === "movie" || item.type === "series") &&
    typeof item.name === "string" &&
    (typeof item.poster === "string" || item.poster === null) &&
    (item.genres === undefined || (Array.isArray(item.genres) && item.genres.every((genre) => typeof genre === "string")))
  );
}

function compactRuntime(minutes: number | null): string | null {
  if (!minutes) return null;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours}h${rest ? `${rest}min` : ""}` : `${minutes}min`;
}

export function titleHref(
  addonId: string,
  type: "movie" | "series",
  mediaId: string,
  options?: { autoplay?: boolean; videoId?: string; next?: boolean }
): string {
  const query = new URLSearchParams({
    addon: addonId,
    type,
    id: mediaId
  });
  if (options?.autoplay) query.set("play", "1");
  if (options?.videoId) query.set("video", options.videoId);
  // Card de "próximo episódio": `video` é o episódio terminado e a página abre o seguinte a ele.
  if (options?.next) query.set("next", "1");
  // O servidor local do Capacitor não resolve diretórios do export estático do Next de forma
  // confiável. Apontar para o arquivo real mantém a navegação funcional também no Android.
  return `${appPagePath("titulo")}?${query.toString()}`;
}

function editorialTitleHref(item: Pick<EditorialHomeItem, "tmdbId" | "type">): string {
  const query = new URLSearchParams({
    addon: "editorial.tmdb",
    type: item.type,
    id: `tmdb:${item.tmdbId}`
  });
  return `${appPagePath("titulo")}?${query.toString()}`;
}

function progressMeta(item: ProgressItem, next = false): string {
  if (next) {
    const finished = episodeDisplayLabel(item.season,
      displayEpisodeNumber(item.videoId || item.mediaId, item.season, item.episode));
    return `Próximo episódio · depois de ${finished}`;
  }
  const remainingMinutes = Math.max(1, Math.ceil((item.durationSeconds - item.positionSeconds) / 60));
  if (item.mediaType === "series") {
    const episode = episodeDisplayLabel(item.season,
      displayEpisodeNumber(item.videoId || item.mediaId, item.season, item.episode));
    const sub = item.episodeTitle ? ` · ${item.episodeTitle}` : "";
    return `${episode}${sub} (${remainingMinutes}m restantes)`;
  }
  return `Filme · ${remainingMinutes}m restantes`;
}

function percentage(item: ProgressItem): number {
  return Math.min(100, Math.max(0, Math.round((item.positionSeconds / item.durationSeconds) * 100)));
}

function itemInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toLocaleUpperCase("pt-BR") || "?";
}

function releaseYear(item: { readonly releaseInfo: string | null }): number {
  const match = item.releaseInfo?.match(/\b(?:19|20)\d{2}\b/);
  return match ? Number(match[0]) : 0;
}

/**
 * A biblioteca da conta chega no formato do contrato (`mediaId`/`mediaType`/`posterUrl`…); os
 * cards de catálogo esperam `CatalogItem` (`id`/`type`/`poster`…). Esta é a única conversão
 * entre as duas formas — usada só para desenhar o trilho "Minha biblioteca".
 */
function libraryItemToCatalogItem(item: LibraryItem): CatalogItem & { addonId: string } {
  return {
    id: item.mediaId,
    type: item.mediaType,
    name: item.name,
    poster: item.posterUrl,
    background: item.backgroundUrl,
    description: item.description,
    releaseInfo: item.releaseInfo,
    addonId: item.addonId
  };
}

export function isSavedToLibrary(library: readonly LibraryItem[], mediaId: string, mediaType: "movie" | "series"): boolean {
  return library.some((entry) => entry.mediaId === mediaId && entry.mediaType === mediaType);
}

/**
 * Sinais de recomendação a partir da biblioteca canônica da conta e do progresso assistido.
 * Função pura — sem ela, testar a ponderação exigiria montar a home inteira. Uma escrita de
 * biblioteca rejeitada pelo servidor nunca chega aqui: o chamador só invoca esta função com o
 * `library` já revertido pelo rollback, então o peso nunca reflete uma mudança que a conta não
 * confirmou.
 */
export function buildRecommendationSignals(
  library: readonly LibraryItem[],
  progress: readonly ProgressItem[]
): readonly RecommendationSignal[] {
  const signals = new Map<string, RecommendationSignal>();
  const remember = (lookup: EditorialLookup, weight: number, origin: RecommendationSignal["origin"]) => {
    const key = `${lookup.type}:${lookup.title.trim().toLocaleLowerCase("pt-BR")}`;
    const current = signals.get(key);
    signals.set(key, {
      lookup,
      weight: Math.min(7, (current?.weight ?? 0) + weight),
      origin: current?.origin === "watched" || origin === "watched" ? "watched" : "library"
    });
  };

  for (const item of library) {
    remember({
      type: item.mediaType,
      mediaId: item.mediaId,
      title: item.name,
      year: releaseYear(item) || null
    }, 2.5, "library");
  }
  for (const item of progress) {
    const watched = item.positionSeconds / item.durationSeconds;
    const ageDays = Math.max(0, (Date.now() - Date.parse(item.updatedAt)) / 86_400_000);
    const recency = Math.max(0, 1 - ageDays / 90);
    const weight = (item.completed ? 3.5 : watched >= 0.5 ? 2.5 : 1.25) + recency;
    remember({
      type: item.mediaType,
      mediaId: item.mediaId,
      title: item.title,
      year: null
    }, weight, "watched");
  }

  return [...signals.values()];
}

function isAnimeCatalog(rail: CatalogRail): boolean {
  const label = `${rail.catalogId} ${rail.name}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR");
  return /(?:^|[^a-z])(anime|animes)(?:[^a-z]|$)/.test(label);
}

/**
 * Estes catálogos do add-on repetem seleções que a vitrine editorial já entrega com critério
 * claro: os dois calendários usam a mesma lista e Netflix já possui fileiras próprias de filmes
 * e séries. Mantê-los só multiplica as mesmas capas na tela.
 */
function isRedundantCatalogRail(rail: CatalogRail): boolean {
  const label = `${rail.catalogId} ${rail.name}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR");
  return /\b(featured|last videos?|calendar videos?|netflix)\b/.test(label);
}

interface RailScrollContainerProps {
  children: ReactNode;
  label: string;
  /** Top 10 é uma faixa contínua de ranking, sem setas ou bordas de navegação. */
  topTen?: boolean;
}

interface EditorialCatalogCardProps {
  readonly addonId: string;
  readonly item: CatalogItem;
  readonly saved: boolean;
  readonly tone: (typeof TONES)[number];
  readonly onToggleLibrary: (item: CatalogItem, addonId: string) => void;
  /**
   * Identifica a fileira de origem (ex.: "biblioteca" ou `addonId:catalogId`). Só é usado para
   * montar o `id` do card na TV: o `@bbc/tv-lrud-spatial` só lembra em qual card você estava
   * dentro de uma fileira (memória ao trocar de fileira com ↑/↓) se cada card tiver um `id`
   * único na página — e o mesmo título pode aparecer em mais de uma fileira.
   */
  readonly railId?: string;
}

/**
 * O catálogo deixa de ser apenas uma parede de capas: cada imagem funciona como uma pequena
 * ficha editorial. Mouse e teclado revelam a sinopse; no toque, as ações ficam sempre visíveis.
 */
interface PanelAnchor {
  readonly top: number;
  readonly left: number;
  readonly width: number;
}

/**
 * Ficha que aparece ABAIXO do card quando ele ganha foco na TV (referência Netflix TV: card
 * focado cresce e mostra gênero • ano • duração/temporadas • classificação e a sinopse embaixo).
 * Some dado que o card já não tenha calculado hoje (mesmo `facts`/sinopse do preview de
 * hover — nenhuma chamada nova). Fica sempre no DOM, escondida por CSS (`html[data-tv-layout]
 * .tv-card-details`) e revelada com `:focus-within` no card — diferente do preview antigo, que
 * media posição com JS e portal, isto nunca recalcula nada: só o CSS decide quando aparece,
 * o que importa no projetor fraco (regra da Task 2 do plano de TV).
 */
function TvCardDetails({ eyebrow, title, facts, overview, children }: {
  readonly eyebrow?: string | null;
  readonly title: string;
  readonly facts: readonly string[];
  readonly overview: string | null;
  /** Extra da ficha que não é fato nem sinopse (ex.: a barra de progresso de "Continuar"). */
  readonly children?: ReactNode;
}) {
  return (
    <div className="tv-card-details">
      {eyebrow ? <p className="tv-card-details-eyebrow">{eyebrow}</p> : null}
      <p className="tv-card-details-title">{title}</p>
      {/* Uma linha só, texto normal (não CAIXA ALTA) separado por " • ", como a referência —
          reticências se não couber (`.tv-card-details-facts` corta em CSS). */}
      {facts.length > 0 ? <p className="tv-card-details-facts">{facts.join(" • ")}</p> : null}
      {overview ? <p className="tv-card-details-overview">{overview}</p> : null}
      {children}
    </div>
  );
}

/**
 * Card de fileira da TV (pôster/backdrop + ficha embaixo quando focado) — mesmo desenho do
 * `EditorialDiscoveryCard`, reaproveitado por "Recomendado para você" e "Vencedores do Emmy" no
 * modo TV: o Lucas pediu que essas duas vitrines sigam o padrão de "Recém-chegados" (card normal
 * na fileira, cresce e mostra a ficha só quando focado) em vez do card gigante sempre aberto de
 * hoje, que não mostrava foco nenhum.
 */
function TvRailCard({ id, href, ariaLabel, posterUrl, backdropUrl, title, eyebrow, facts, overview }: {
  readonly id: string;
  readonly href: string;
  readonly ariaLabel: string;
  readonly posterUrl: string | null;
  readonly backdropUrl: string | null;
  readonly title: string;
  readonly eyebrow?: string | null;
  readonly facts: readonly string[];
  readonly overview: string | null;
}) {
  const posterArtwork = posterUrl ?? backdropUrl;
  const tvBackdrop = backdropUrl && backdropUrl !== posterArtwork ? backdropUrl : null;
  return (
    <article className="editorial-card" data-tv-has-backdrop={tvBackdrop ? "" : undefined}>
      <div className="editorial-card-media">
        {posterArtwork ? (
          <img src={tvPosterUrl(posterArtwork)} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
        ) : (
          <div className="poster-media-fallback tone-azure">
            <span className="fallback-initials">{itemInitials(title)}</span>
          </div>
        )}
        {tvBackdrop ? (
          <img className="tv-card-backdrop" src={tvCardBackdropUrl(tvBackdrop)} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
        ) : null}
        <a className="editorial-card-open" id={id} href={href} aria-label={ariaLabel} />
      </div>
      <TvCardDetails eyebrow={eyebrow} title={title} facts={facts} overview={overview} />
    </article>
  );
}

/**
 * Card de "Continuar assistindo". Extraído num componente próprio (em vez de montado inline
 * dentro do `.map()`) porque a TV passou a chamar `useEditorial` aqui — e Hooks só podem ser
 * chamados no topo de um componente, nunca dentro de um callback de `.map()` no meio do render
 * de outro. `ProgressItem` não tem backdrop próprio (a API de progresso não guarda isso); na TV,
 * este é o MESMO mecanismo que os cards editoriais já usam pra enriquecer com o TMDB — a mesma
 * rota `/v1/editorial` de sempre, só que agora também chamada por esta fileira (nenhuma API
 * nova). Enquanto não chega, ou se o título não tiver backdrop, o pôster continua cobrindo a
 * moldura 16:9 sozinho.
 */
function ContinueWatchingCard({ item, next, href, pct, onRemove }: {
  readonly item: ProgressItem;
  readonly next: boolean;
  readonly href: string;
  readonly pct: number;
  readonly onRemove: (item: ProgressItem, e: ReactMouseEvent) => void;
}) {
  const tvLayout = useTvLayout();
  const lookup: EditorialLookup = useMemo(() => ({
    type: item.mediaType,
    mediaId: item.mediaId,
    title: item.title,
    year: null
  }), [item.mediaType, item.mediaId, item.title]);
  // `enabled: tvLayout` — só busca na TV; PC/celular continuam exatamente como hoje (sem esta
  // consulta), já que lá o card nunca mostrou backdrop.
  const editorial = useEditorial(lookup, tvLayout);
  const tvBackdrop = tvLayout ? editorial?.backdropUrl ?? null : null;

  return (
    <a
      className="progress-card"
      id={tvLayout ? `tv-card-continuar-${item.id}` : undefined}
      data-tv-has-backdrop={tvBackdrop ? "" : undefined}
      href={href}
      aria-label={next ? `${item.title}, ${progressMeta(item, true)}` : `${item.title}, ${progressMeta(item)}, ${pct}% assistido`}
    >
      <div className="progress-media">
        {item.posterUrl ? (
          <img src={tvLayout ? tvPosterUrl(item.posterUrl) : item.posterUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => notePosterLoadFailure(item.posterUrl)} />
        ) : (
          <div className="poster-media-fallback tone-azure">
            <span className="fallback-initials">{itemInitials(item.title)}</span>
          </div>
        )}
        {tvBackdrop ? (
          <img className="tv-card-backdrop" src={tvCardBackdropUrl(tvBackdrop)} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
        ) : null}

        <button
          type="button"
          className="progress-remove-btn"
          onClick={(e) => onRemove(item, e)}
          aria-label={`Remover ${item.title} de Continuar assistindo`}
          title="Remover de Continuar"
          // Na TV o foco caía direto neste X em vez do card. A mesma ação passa a
          // viver dentro da ficha (botão "Remover de Continuar", mesmo handler);
          // este aqui sai do caminho das setas.
          tabIndex={tvLayout ? -1 : undefined}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        <div className="progress-card-info">
          <strong className="progress-card-title">{item.title}</strong>
          <span className="progress-card-subtitle">{progressMeta(item, next)}</span>
        </div>

        <div className="progress-bar-track" aria-hidden="true">
          <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
      {tvLayout ? (
        // Mesma barra de progresso, só que dentro da ficha (o `.progress-bar-track`
        // fino embaixo do pôster continua — nenhum dos dois é escondido). Sem botão
        // de remover aqui: decisão do Lucas nesta rodada (o X de sempre continua
        // fora do foco, só não ganhou substituto na ficha desta vez).
        <TvCardDetails title={item.title} facts={[progressMeta(item, next)]} overview={null}>
          <div className="tv-card-details-progress" aria-hidden="true">
            <div className="tv-card-details-progress-fill" style={{ width: `${pct}%` }} />
          </div>
        </TvCardDetails>
      ) : null}
    </a>
  );
}

/** Consulta a disponibilidade somente quando o card se aproxima da tela. */
function useCardVisible(ref: RefObject<Element | null>): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || visible || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setVisible(true);
      observer.disconnect();
    }, { rootMargin: "240px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, visible]);
  return visible;
}

function CardProviderBadge({ provider }: { readonly provider: EditorialProvider | null }) {
  const tvLayout = useTvLayout();
  if (!provider?.logoUrl) return null;
  return <span className="editorial-card-provider" title={`Disponível na ${provider.name}`} aria-label={`Disponível na ${provider.name}`}>
    <img src={tvLayout ? tvLogoUrl(provider.logoUrl) : provider.logoUrl} alt={provider.name} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
  </span>;
}

/**
 * O catálogo deixa de ser uma parede de capas: parar num card revela uma ficha logo abaixo dele,
 * com a arte (ou o trailer) inteira e visível em cima. O desenho antigo cobria o card com uma
 * placa preta quase opaca — que escondia a arte, brigava com o tema claro e, desde que o teaser
 * entrou, tapava o próprio vídeo que estava tocando atrás dela.
 */
export function EditorialCatalogCard({ addonId, item, saved, tone, onToggleLibrary, railId }: EditorialCatalogCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const cardVisible = useCardVisible(cardRef);
  const tvLayout = useTvLayout();
  const [, setPointerOnCard] = useState(false);
  const [, setPointerOnPanel] = useState(false);
  const [, setFocusInside] = useState(false);
  const [anchor, setAnchor] = useState<PanelAnchor | null>(null);
  // A prévia flutuante após alguns segundos escondia o catálogo e disparava trailers sem uma
  // ação explícita. Os detalhes ficam disponíveis somente ao abrir o título.
  const open = false;

  const href = titleHref(addonId, item.type, item.id);
  const lookup: EditorialLookup = useMemo(() => ({
    type: item.type,
    mediaId: item.id,
    title: item.name,
    year: releaseYear(item) || null
  }), [item]);
  const editorial = useEditorial(lookup, cardVisible);
  const provider = editorial?.availability.subscription.find((item) => STREAMING_PROVIDER_IDS.has(item.id)) ?? null;
  const webTrailers = useWebTrailers(tvLayout);
  const teaserId = webTrailers ? youtubeId(editorial?.trailerUrl) : null;
  // Ao atingir os 3 segundos de abertura, o teaser inicia imediatamente sem espera adicional
  const playTeaser = open && teaserId !== null && !isNativeRuntime();

  const place = useCallback(() => {
    const card = cardRef.current;
    if (!card) return;
    const box = card.getBoundingClientRect();
    // Largura horizontal confortável para teaser em 16:9 widescreen
    const width = Math.min(Math.max(box.width * 1.5, 300), window.innerWidth - 32);
    const left = Math.min(
      Math.max(16, box.left - (width - box.width) / 2),
      window.innerWidth - width - 16
    );
    const top = Math.max(16, box.top - 16);
    setAnchor({ top, left, width });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    place();

    let ticking = false;
    const onScroll = () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          place();
          ticking = false;
        });
        ticking = true;
      }
    };

    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onScroll);
    };
  }, [open, place]);

  useLayoutEffect(() => {
    if (open) place();
  }, [editorial, open, place]);

  const posterArtwork = item.poster || editorial?.posterUrl || item.background || editorial?.backdropUrl;
  const backdropArtwork = editorial?.backdropUrl || item.background || posterArtwork;
  const year = editorial?.year ? String(editorial.year) : item.releaseInfo ? item.releaseInfo.slice(0, 4) : null;
  const runtime = compactRuntime(editorial?.runtimeMinutes ?? null);
  const vote = (editorial?.voteAverage ?? null) ? `★ ${editorial!.voteAverage!.toFixed(1)}` : null;
  const genres = (editorial?.genres.slice(0, 2) ?? item.genres?.slice(0, 2) ?? []);

  const facts = [
    year,
    // Texto normal (não CAIXA ALTA): a ficha da TV usa esta mesma string e não deve gritar; o
    // preview de hover do desktop (morto, `open` é sempre `false`) também usava esta constante
    // sem transformar o texto — nunca chegou a ser visto em maiúsculo por ninguém.
    item.type === "movie" ? "Filme" : "Série",
    runtime,
    vote,
    ...genres
  ].filter(Boolean) as string[];

  const authors = editorial?.directors.length
    ? `Direção: ${editorial.directors.slice(0, 2).join(", ")}`
    : editorial?.creators.length ? `Criação: ${editorial.creators.slice(0, 2).join(", ")}` : null;
  // Na TV o card focado troca o pôster por uma arte horizontal (referência Netflix TV); só faz
  // sentido quando existe um backdrop de verdade — sem ele, o card focado continua no pôster.
  const tvBackdrop = backdropArtwork && backdropArtwork !== posterArtwork ? backdropArtwork : null;
  // Ver comentário em `EditorialCatalogCardProps.railId`: sem `id` único o LRUD não lembra em
  // qual card da fileira você estava ao voltar com ↑/↓.
  const tvCardId = tvLayout ? `tv-card-${railId ?? "catalogo"}-${item.type}-${item.id}` : undefined;

  return (
    <article
      ref={cardRef}
      className={`editorial-card${open ? " is-open" : ""}`}
      data-tv-has-backdrop={tvLayout && tvBackdrop ? "" : undefined}
      onMouseEnter={() => setPointerOnCard(true)}
      onMouseLeave={() => setPointerOnCard(false)}
      onFocusCapture={() => setFocusInside(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusInside(false);
      }}
    >
      <div className="editorial-card-media">
        {posterArtwork ? (
          <img src={tvLayout ? tvPosterUrl(posterArtwork) : posterArtwork} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => notePosterLoadFailure(posterArtwork)} />
        ) : (
          <div className={`poster-media-fallback ${tone}`}>
            <span className="fallback-initials">{itemInitials(item.name)}</span>
          </div>
        )}
        {tvLayout && tvBackdrop ? (
          <img className="tv-card-backdrop" src={tvCardBackdropUrl(tvBackdrop)} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
        ) : null}
        <CardProviderBadge provider={provider} />
        <a className="editorial-card-open" id={tvCardId} href={href} aria-label={`Ver detalhes de ${item.name}`} />
        <button
          type="button"
          className="editorial-card-touch-save"
          onClick={() => onToggleLibrary(item, addonId)}
          aria-label={saved ? `Remover ${item.name} da biblioteca` : `Adicionar ${item.name} à biblioteca`}
          // `(hover: none)` também é verdade na TV de verdade (sem ponteiro) — este botão some
          // pro toque em celular, mas ficava visível E focável em cima do pôster na TV,
          // competindo com o link do card. Decisão do Lucas: na TV a ficha não ganha um botão
          // equivalente (fica só fora do foco mesmo).
          tabIndex={tvLayout ? -1 : undefined}
        >{saved ? "✓" : "+"}</button>
      </div>
      {tvLayout ? <TvCardDetails title={item.name} facts={facts} overview={editorial?.overview || item.description || null} /> : null}

      {open && anchor && typeof document !== "undefined" ? createPortal(
        <div
          className="editorial-preview-card"
          style={{ top: anchor.top, left: anchor.left, width: anchor.width }}
          onMouseEnter={() => setPointerOnPanel(true)}
          onMouseLeave={() => setPointerOnPanel(false)}
        >
          {/* Topo 16:9 Widescreen com Vídeo Teaser ou Backdrop */}
          <div className="editorial-preview-media">
            {backdropArtwork ? (
              <img src={backdropArtwork} alt="" loading="eager" decoding="async" referrerPolicy="no-referrer" />
            ) : null}
            {playTeaser && teaserId ? (
              <TeaserFrame videoId={teaserId} label={`Trailer de ${item.name}`} />
            ) : null}
            <a className="editorial-card-open" href={href} aria-label={`Ver detalhes de ${item.name}`} />
          </div>

          {/* Corpo Unificado: Detalhes, Metadados e Sinopse */}
          <div className="editorial-preview-body">
            <div className="editorial-card-header-row">
              <a className="editorial-card-panel-title" href={href} aria-label={`Ver detalhes de ${item.name}`}>
                {item.name}
              </a>
              <button
                type="button"
                className="editorial-card-save"
                onClick={() => onToggleLibrary(item, addonId)}
                aria-label={saved ? `Remover ${item.name} da biblioteca` : `Adicionar ${item.name} à biblioteca`}
                title={saved ? "Remover da biblioteca" : "Salvar na biblioteca"}
              >{saved ? "✓" : "+"}</button>
            </div>
            {facts.length > 0 ? (
              <p className="editorial-card-facts">
                {facts.map((fact) => <span key={fact}>{fact}</span>)}
              </p>
            ) : null}
            <p className="editorial-card-description">
              {editorial?.overview || item.description || "Abra os detalhes para conhecer mais sobre este título."}
            </p>
            {authors ? <p className="editorial-card-credit">{authors}</p> : null}
          </div>
        </div>,
        document.body
      ) : null}
    </article>
  );
}

interface EditorialDiscoveryCardProps {
  readonly item: EditorialHomeItem;
  readonly saved?: boolean;
  readonly onToggleLibrary?: () => void;
  /** Ranking visual exclusivo das fileiras Top 10. */
  readonly rank?: number;
  /** Ver comentário em `EditorialCatalogCardProps.railId`. */
  readonly railId?: string;
}

function EditorialDiscoveryCard({ item, saved = false, onToggleLibrary, rank, railId }: EditorialDiscoveryCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const cardVisible = useCardVisible(cardRef);
  const tvLayout = useTvLayout();
  const [, setPointerOnCard] = useState(false);
  const [, setPointerOnPanel] = useState(false);
  const [, setFocusInside] = useState(false);
  const [anchor, setAnchor] = useState<PanelAnchor | null>(null);
  // Mesma regra dos cards de catálogo: sem painel que abre automaticamente ao permanecer nele.
  const open = false;

  const lookup: EditorialLookup = useMemo(() => ({
    type: item.type,
    mediaId: `tmdb:${item.tmdbId}`,
    title: item.title,
    year: item.year
  }), [item.type, item.tmdbId, item.title, item.year]);
  const editorial = useEditorial(lookup, cardVisible);
  const provider = editorial?.availability.subscription.find((item) => STREAMING_PROVIDER_IDS.has(item.id)) ?? null;
  const webTrailers = useWebTrailers(tvLayout);
  const teaserId = webTrailers ? youtubeId(editorial?.trailerUrl) : null;
  const playTeaser = open && teaserId !== null && !isNativeRuntime();

  const place = useCallback(() => {
    const card = cardRef.current;
    if (!card) return;
    const box = card.getBoundingClientRect();
    const width = Math.min(Math.max(box.width * 1.5, 300), window.innerWidth - 32);
    const left = Math.min(
      Math.max(16, box.left - (width - box.width) / 2),
      window.innerWidth - width - 16
    );
    const top = Math.max(16, box.top - 16);
    setAnchor({ top, left, width });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    place();

    let ticking = false;
    const onScroll = () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          place();
          ticking = false;
        });
        ticking = true;
      }
    };

    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onScroll);
    };
  }, [open, place]);

  useLayoutEffect(() => {
    if (open) place();
  }, [editorial, open, place]);

  const posterArtwork = item.posterUrl ?? editorial?.posterUrl ?? item.backdropUrl ?? editorial?.backdropUrl;
  const backdropArtwork = editorial?.backdropUrl ?? item.backdropUrl ?? posterArtwork;
  const year = editorial?.year ? String(editorial.year) : item.year ? String(item.year) : null;
  const runtime = compactRuntime(editorial?.runtimeMinutes ?? null);
  const vote = (editorial?.voteAverage ?? item.voteAverage) ? `★ ${(editorial?.voteAverage ?? item.voteAverage)!.toFixed(1)}` : null;
  const genres = (editorial?.genres.slice(0, 2) ?? []);

  const facts = [
    year,
    // Texto normal (não CAIXA ALTA): a ficha da TV usa esta mesma string e não deve gritar; o
    // preview de hover do desktop (morto, `open` é sempre `false`) também usava esta constante
    // sem transformar o texto — nunca chegou a ser visto em maiúsculo por ninguém.
    item.type === "movie" ? "Filme" : "Série",
    runtime,
    vote,
    ...genres
  ].filter(Boolean) as string[];

  const authors = editorial?.directors.length
    ? `Direção: ${editorial.directors.slice(0, 2).join(", ")}`
    : editorial?.creators.length ? `Criação: ${editorial.creators.slice(0, 2).join(", ")}` : null;

  const href = editorialTitleHref(item);
  // Ver comentário em `EditorialCatalogCardProps.railId`.
  const tvCardId = tvLayout ? `tv-card-${railId ?? "editorial"}-${item.type}-${item.tmdbId}` : undefined;
  // Ver comentário em `EditorialCatalogCard` — só troca para a arte horizontal quando existe
  // backdrop de verdade; senão o card focado continua no pôster.
  const tvBackdrop = backdropArtwork && backdropArtwork !== posterArtwork ? backdropArtwork : null;

  if (rank !== undefined) {
    return (
      <article className="top-ten-card" data-tv-has-backdrop={tvLayout && tvBackdrop ? "" : undefined}>
        <span className="top-ten-rank" aria-hidden="true">{rank}</span>
        <div className="top-ten-poster" ref={cardRef}>
          {posterArtwork ? (
            <img src={tvLayout ? tvPosterUrl(posterArtwork) : posterArtwork} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => notePosterLoadFailure(posterArtwork)} />
          ) : (
            <span className="fallback-initials">{itemInitials(item.title)}</span>
          )}
          {tvLayout && tvBackdrop ? (
            <img className="tv-card-backdrop" src={tvCardBackdropUrl(tvBackdrop)} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
          ) : null}
          <CardProviderBadge provider={provider} />
          <a className="editorial-card-open" id={tvCardId} href={href} aria-label={`Ver detalhes de ${item.title}, posição ${rank} em alta`} />
        </div>
        {tvLayout ? <TvCardDetails title={item.title} facts={facts} overview={editorial?.overview || item.overview || null} /> : null}
      </article>
    );
  }

  return (
    <article
      ref={cardRef}
      className={`editorial-card${open ? " is-open" : ""}`}
      data-tv-has-backdrop={tvLayout && tvBackdrop ? "" : undefined}
      onMouseEnter={() => setPointerOnCard(true)}
      onMouseLeave={() => setPointerOnCard(false)}
      onFocusCapture={() => setFocusInside(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusInside(false);
      }}
    >
      <AwardBadges tmdbId={item.tmdbId} />
      <div className="editorial-card-media">
        {posterArtwork ? (
          <img src={tvLayout ? tvPosterUrl(posterArtwork) : posterArtwork} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => notePosterLoadFailure(posterArtwork)} />
        ) : (
          <div className="poster-media-fallback toneBlue">
            <span className="fallback-initials">{itemInitials(item.title)}</span>
          </div>
        )}
        {tvLayout && tvBackdrop ? (
          <img className="tv-card-backdrop" src={tvCardBackdropUrl(tvBackdrop)} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
        ) : null}
        <CardProviderBadge provider={provider} />
        <a className="editorial-card-open" id={tvCardId} href={href} aria-label={`Ver detalhes de ${item.title}`} />
        {onToggleLibrary && (
          <button
            type="button"
            className="editorial-card-touch-save"
            onClick={onToggleLibrary}
            aria-label={saved ? `Remover ${item.title} da biblioteca` : `Adicionar ${item.title} à biblioteca`}
            tabIndex={tvLayout ? -1 : undefined}
          >{saved ? "✓" : "+"}</button>
        )}
      </div>
      {tvLayout ? <TvCardDetails title={item.title} facts={facts} overview={editorial?.overview || item.overview || null} /> : null}

      {open && anchor && typeof document !== "undefined" ? createPortal(
        <div
          className="editorial-preview-card"
          style={{ top: anchor.top, left: anchor.left, width: anchor.width }}
          onMouseEnter={() => setPointerOnPanel(true)}
          onMouseLeave={() => setPointerOnPanel(false)}
        >
          {/* Topo 16:9 Widescreen com Vídeo Teaser ou Backdrop */}
          <div className="editorial-preview-media">
            <AwardBadges tmdbId={item.tmdbId} />
            {backdropArtwork ? (
              <img src={backdropArtwork} alt="" loading="eager" decoding="async" referrerPolicy="no-referrer" />
            ) : null}
            {playTeaser && teaserId ? (
              <TeaserFrame videoId={teaserId} label={`Trailer de ${item.title}`} />
            ) : null}
            <a className="editorial-card-open" href={href} aria-label={`Ver detalhes de ${item.title}`} />
          </div>

          {/* Corpo Unificado: Detalhes, Metadados e Sinopse */}
          <div className="editorial-preview-body">
            <div className="editorial-card-header-row">
              <a
                className="editorial-card-panel-title"
                href={href}
                aria-label={`Ver detalhes de ${item.title}`}
              >
                {item.title}
              </a>
              {onToggleLibrary && (
                <button
                  type="button"
                  className="editorial-card-save"
                  onClick={onToggleLibrary}
                  aria-label={saved ? `Remover ${item.title} da biblioteca` : `Adicionar ${item.title} à biblioteca`}
                  title={saved ? "Remover da biblioteca" : "Salvar na biblioteca"}
                >{saved ? "✓" : "+"}</button>
              )}
            </div>
            {facts.length > 0 ? (
              <p className="editorial-card-facts">
                {facts.map((fact) => <span key={fact}>{fact}</span>)}
              </p>
            ) : null}
            <p className="editorial-card-description">
              {editorial?.overview || item.overview || "Abra os detalhes para conhecer mais sobre este título."}
            </p>
            {authors ? <p className="editorial-card-credit">{authors}</p> : null}
          </div>
        </div>,
        document.body
      ) : null}
    </article>
  );
}

export function PersonalizedShowcaseCard({ item }: { readonly item: PersonalizedRecommendation }) {
  const cardRef = useRef<HTMLElement>(null);
  const tvLayout = useTvLayout();
  const artwork = item.backdropUrl ?? item.backdropPreviewUrl ?? item.posterUrl;
  const facts = [
    item.year ? String(item.year) : null,
    // Texto normal (não CAIXA ALTA): a ficha da TV usa esta mesma string e não deve gritar; o
    // preview de hover do desktop (morto, `open` é sempre `false`) também usava esta constante
    // sem transformar o texto — nunca chegou a ser visto em maiúsculo por ninguém.
    item.type === "movie" ? "Filme" : "Série",
    item.voteAverage !== null ? `★ ${item.voteAverage.toFixed(1)}` : null,
    ...item.genres.slice(0, 2)
  ].filter(Boolean) as string[];

  // Na TV esta vitrine segue o mesmo padrão de "Recém-chegados" (card normal na fileira, cresce
  // e mostra a ficha só quando focado) — o card gigante de sempre não mostrava qual estava
  // selecionado. A frase "Baseado em..." vira a linha de destaque (eyebrow) da ficha, pra não
  // perder essa informação.
  if (tvLayout) {
    return (
      <TvRailCard
        id={`tv-card-recomendado-${item.type}-${item.tmdbId}`}
        href={editorialTitleHref(item)}
        ariaLabel={`Ver detalhes de ${item.title}. ${item.reason}`}
        posterUrl={item.posterUrl}
        backdropUrl={item.backdropUrl}
        title={item.title}
        eyebrow={item.reason}
        facts={facts}
        overview={item.overview}
      />
    );
  }

  return (
    <article
      className="personalized-showcase-card"
      ref={cardRef}
      // Na TV quem rola até o card é `tv-navigation.tsx` (sem `smooth`, para não brigar com o
      // scroll que ele já faz a cada foco). PC/celular mantêm o comportamento de sempre.
      onFocus={() => { if (!tvLayout) cardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" }); }}
    >
      {artwork ? <img className="personalized-showcase-art" src={artwork} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : null}
      <div className="personalized-showcase-shade" aria-hidden="true" />
      <AwardBadges tmdbId={item.tmdbId} />
      <div className="personalized-showcase-content">
        <p className="personalized-showcase-reason">{item.reason}</p>
        <h3>{item.title}</h3>
        {facts.length ? <p className="personalized-showcase-facts">{facts.map((fact) => <span key={fact}>{fact}</span>)}</p> : null}
        {item.people.length ? <p className="personalized-showcase-people">De {item.people.join(", ")}</p> : null}
        <p className="personalized-showcase-overview">{item.overview ?? "Uma escolha relacionada ao seu histórico e à sua biblioteca."}</p>
      </div>
      {item.provider?.logoUrl ? (
        <span className="personalized-showcase-provider" title={`Disponível na ${item.provider.name}`}>
          <img src={tvLayout ? tvLogoUrl(item.provider.logoUrl) : item.provider.logoUrl} alt={item.provider.name} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
        </span>
      ) : null}
      <a
        className="personalized-showcase-open"
        id={tvLayout ? `tv-card-recomendado-${item.type}-${item.tmdbId}` : undefined}
        href={editorialTitleHref(item)}
        aria-label={`Ver detalhes de ${item.title}. ${item.reason}`}
      />
    </article>
  );
}

/**
 * Vencedor do Emmy no mesmo desenho do "Recomendado para você", trocando a sinopse pela lista de
 * categorias que a obra venceu — que é o que a fileira existe para mostrar.
 */
function EmmyShowcaseCard({ item, ceremonyName }: { readonly item: EmmyWinner; readonly ceremonyName: string }) {
  const tvLayout = useTvLayout();
  const artwork = item.backdropUrl ?? item.backdropPreviewUrl ?? item.posterUrl;
  const facts = [
    item.year ? String(item.year) : null,
    // Texto normal (não CAIXA ALTA): a ficha da TV usa esta mesma string e não deve gritar; o
    // preview de hover do desktop (morto, `open` é sempre `false`) também usava esta constante
    // sem transformar o texto — nunca chegou a ser visto em maiúsculo por ninguém.
    item.type === "movie" ? "Filme" : "Série",
    item.voteAverage !== null ? `★ ${item.voteAverage.toFixed(1)}` : null
  ].filter(Boolean) as string[];

  // Mesmo padrão de "Recém-chegados" na TV; as categorias vencidas entram como fatos da ficha
  // (senão essa informação, que é o motivo da fileira existir, sumiria do card focado).
  if (tvLayout) {
    return (
      <TvRailCard
        id={`tv-card-emmy-${item.type}-${item.tmdbId}`}
        href={editorialTitleHref(item)}
        ariaLabel={`Ver detalhes de ${item.title}. Vencedor do ${ceremonyName}`}
        posterUrl={item.posterUrl}
        backdropUrl={item.backdropUrl}
        title={item.title}
        eyebrow={`🏆 Vencedor do ${ceremonyName}`}
        facts={[...facts, ...item.categories]}
        overview={item.overview}
      />
    );
  }

  return (
    <article className="personalized-showcase-card emmy-showcase-card">
      {artwork ? <img className="personalized-showcase-art" src={artwork} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : null}
      <div className="personalized-showcase-shade" aria-hidden="true" />
      <div className="personalized-showcase-content">
        <p className="personalized-showcase-reason emmy-showcase-reason">
          <span className="emmy-badge" aria-hidden="true">🏆</span> Vencedor do {ceremonyName}
        </p>
        <h3>{item.title}</h3>
        {facts.length ? <p className="personalized-showcase-facts">{facts.map((fact) => <span key={fact}>{fact}</span>)}</p> : null}
        <p className="emmy-showcase-categories" aria-label="Categorias vencidas">
          {item.categories.map((category) => <span key={category} className="emmy-category-chip">{category}</span>)}
        </p>
      </div>
      <a
        className="personalized-showcase-open"
        id={tvLayout ? `tv-card-emmy-${item.type}-${item.tmdbId}` : undefined}
        href={editorialTitleHref(item)}
        aria-label={`Ver detalhes de ${item.title}. Vencedor do ${ceremonyName}`}
      />
    </article>
  );
}

function RailScrollContainer({ children, label, topTen = false }: RailScrollContainerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const tvLayout = useTvLayout();
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);

  const checkScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 24);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 24);
  }, []);

  const scroll = (direction: "left" | "right") => {
    const el = scrollRef.current;
    if (!el) return;
    const amount = el.clientWidth;
    el.scrollBy({
      left: direction === "left" ? -amount : amount,
      behavior: "smooth"
    });
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    checkScroll();
    el.addEventListener("scroll", checkScroll, { passive: true });
    window.addEventListener("resize", checkScroll);
    return () => {
      el.removeEventListener("scroll", checkScroll);
      window.removeEventListener("resize", checkScroll);
    };
  }, [checkScroll]);

  return (
    // As bordas esfumadas só existem para dizer "tem mais coisa para esse lado". Ligadas o
    // tempo todo, elas escureciam o primeiro e o último card de toda rail sem nada escondido
    // atrás — e com as rails de ponta a ponta isso ficou impossível de ignorar.
    <div
      className={`rail-wrapper${topTen ? " top-ten-wrapper" : ""}${canScrollLeft ? " can-scroll-left" : ""}${canScrollRight ? " can-scroll-right" : ""}`}
    >
      {/* Na TV as setas não existem: são de mouse (rolam com clique) e, sendo `<button>`, o
          controle conseguia focá-las — travando ← quando elas ficavam "mais perto" que o
          próprio card. ←/→ do controle já rolam a fileira (LRUD + `scrollFocusIntoView`). */}
      {canScrollLeft && !tvLayout && (
        <button
          type="button"
          className="rail-nav-btn rail-nav-prev"
          onClick={() => scroll("left")}
          aria-label={`Rolar ${label} para a esquerda`}
        >
          ‹
        </button>
      )}
      <div
        className={`rail-scroll${topTen ? " top-ten-scroll" : ""}`}
        ref={scrollRef}
        // No PC/celular isto deixa a fileira alcançável por Tab + setas do teclado. Na TV é
        // exatamente o problema: o próprio `<div>` da fileira vira um alvo de foco válido para o
        // LRUD (`[tabindex]` conta como focável) e, cobrindo a fileira inteira, quase sempre
        // "ganha" a distância de qualquer card individual — o foco caía na fileira toda (borda
        // branca em volta dela) em vez do primeiro card.
        tabIndex={tvLayout ? -1 : 0}
        aria-label={label}
      >
        {children}
      </div>
      {canScrollRight && !tvLayout && (
        <button
          type="button"
          className="rail-nav-btn rail-nav-next"
          onClick={() => scroll("right")}
          aria-label={`Rolar ${label} para a direita`}
        >
          ›
        </button>
      )}
    </div>
  );
}

/**
 * TV: último item da barra focado enquanto a home carregava. A barra do esqueleto é outra
 * árvore (sem perfil ainda), então quando a home real entra o foco some; guardamos o rótulo
 * pra devolver o foco ao MESMO item da barra nova (ver efeito "foco da barra" na home).
 */
let tvSkeletonNavFocus: string | null = null;

function navItemLabel(element: Element): string {
  return (element.getAttribute("aria-label") || element.textContent || "").trim();
}

/**
 * Barra de TV durante o carregamento: sempre visível (pedido do Lucas) — trocar de seção no app
 * recarrega a home, e o esqueleto antigo só tinha o logo. Mesmos links da barra real; o avatar
 * e o tema entram como marcadores até o perfil chegar.
 */
function TvSkeletonNavbar() {
  const query = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  const libraryOnly = query.get("view") === "library";
  const catalog = query.get("catalog") ?? "home";
  const sections = [
    ["/", "home", "Início"], ["/?catalog=movies", "movies", "Filmes"], ["/?catalog=series", "series", "Séries"],
    ["/?catalog=documentaries", "documentaries", "Documentários"], ["/?catalog=anime", "anime", "Anime"],
    ["/?catalog=brazil", "brazil", "Brasil"]
  ] as const;
  // Já dá pra andar pela barra enquanto carrega: o foco começa na seção atual.
  useEffect(() => {
    if (document.activeElement && document.activeElement !== document.body) return;
    document.querySelector<HTMLElement>("header.navbar .navbar-center a.active")?.focus({ preventScroll: true });
  }, []);
  return (
    <header className="navbar lrud-container" data-tv-zone="menu" onFocus={(event) => { tvSkeletonNavFocus = navItemLabel(event.target); }}>
      <div className="navbar-brand-section">
        <span className="brand"><BrandIcon size={34} className="brand-icon-wrapper" /></span>
      </div>
      <nav className="navbar-center" aria-label="Navegação principal">
        <a href={searchPageHref()} className="tv-search-pill" aria-label="Abrir busca">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </a>
        {sections.map(([href, id, label]) => (
          <Link key={id} href={href} className={!libraryOnly && catalog === id ? "active" : undefined}>{label}</Link>
        ))}
        <Link href="/?view=library" className={`tv-search-pill${libraryOnly ? " active" : ""}`} aria-label="Minha biblioteca">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
        </Link>
      </nav>
      <div className="profile-menu" aria-hidden="true">
        <span className="profile-chip"><span className="profile-avatar-circle skeleton" /></span>
      </div>
    </header>
  );
}

function HomeSkeleton() {
  const tvLayout = useTvLayout();
  return (
    <div className="app-shell" aria-busy="true" aria-label="Carregando catálogo">
      {tvLayout ? <TvSkeletonNavbar /> : (
        <header className="navbar">
          <span className="brand">
            <BrandIcon size={34} className="brand-icon-wrapper" />
          </span>
        </header>
      )}

      <section className="skeleton-hero">
        <div className="skeleton-hero-content">
          <div className="skeleton skeleton-badge" />
          <div className="skeleton skeleton-title" />
          <div className="skeleton skeleton-text" />
          <div className="skeleton skeleton-text-short" />
          <div className="skeleton-btn-row">
            <div className="skeleton skeleton-btn" />
            <div className="skeleton skeleton-btn" />
          </div>
        </div>
      </section>

      <div className="rails">
        <div className="skeleton-rail">
          <div className="skeleton skeleton-rail-title" />
          <div className="skeleton-cards-row">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="skeleton skeleton-card-wide" />
            ))}
          </div>
        </div>
        <div className="skeleton-rail">
          <div className="skeleton skeleton-rail-title" />
          <div className="skeleton-cards-row">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="skeleton skeleton-card-vertical" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function HomeExperience() {
  const mobileBooks = useMobileBooks();
  const router = useRouter();
  const query = useSearchParams();
  // Só CSS/atributos condicionais mudam com isto (ver `<header className="navbar">` abaixo); a
  // marcação em si é a mesma para PC, celular e TV.
  const tvLayout = useTvLayout();
  // A biblioteca saiu da navegação principal e agora é uma área pessoal aberta pelo perfil.
  const libraryOnly = query.get("view") === "library";
  const requestedCatalog = query.get("catalog");
  const catalogView: CatalogView = requestedCatalog === "movies" || requestedCatalog === "series" || requestedCatalog === "documentaries" || requestedCatalog === "anime" || requestedCatalog === "brazil"
    ? requestedCatalog
    : "home";
  const [viewState, setViewState] = useState<ViewState>("loading");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [progress, setProgress] = useState<readonly ProgressItem[]>([]);
  const [stremioLinked, setStremioLinked] = useState(false);
  const [catalogRails, setCatalogRails] = useState<readonly CatalogRail[]>([]);
  const [editorialRails, setEditorialRails] = useState<readonly EditorialHomeRail[]>([]);
  const [library, setLibrary] = useState<readonly LibraryItem[]>([]);
  const [libraryNotice, setLibraryNotice] = useState<LibraryNotice | null>(null);
  const [personalizedItems, setPersonalizedItems] = useState<readonly PersonalizedRecommendation[]>([]);
  const [emmyWinners, setEmmyWinners] = useState<EmmyWinnersData | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [nativeRuntime, setNativeRuntime] = useState(false);
  // Aparelho fraco não recebe o trailer do banner (player do YouTube é pesado); a imagem de fundo
  // do hero (`--hero-background`, sempre presente) continua igual. Só roda no cliente: no
  // servidor/export estático o valor começa `false` e nunca aparece renderizado por lá.
  const [lowEndDevice, setLowEndDevice] = useState(false);
  /**
   * Quantos itens cada fileira mostra. Era um booleano — dobrava de 10 para 20 e acabava ali,
   * com o card "+ Ver mais" sumindo do fim da trilha. Sumir era também o que fazia a trilha
   * pular para o começo: `.rail-scroll` usa `scroll-snap-type: x proximity`, e ao perder o
   * último filho (que ainda estava com o foco) o navegador reencaixava no primeiro card.
   */
  const [expandedRails, setExpandedRails] = useState<Readonly<Record<string, number>>>({});
  /** Última página editorial já trazida para a seção atual. Ver ITENS_POR_PAGINA. */
  const [editorialPage, setEditorialPage] = useState(1);
  const [railLoading, setRailLoading] = useState<string | null>(null);
  /**
   * TV: ao apertar "+ Ver mais", o foco tem de continuar no mesmo canto da fileira — no primeiro
   * título novo, que entra no lugar do "+", com os seguintes ao lado. Guarda a trilha e a posição
   * até a fileira crescer (efeito logo abaixo de `verMais`).
   */
  const verMaisFocoRef = useRef<{ trilha: HTMLElement; posicao: number } | null>(null);
  /** Só existe abaixo de 768px: ver `.navbar-menu-btn` no CSS. */
  const [menuAberto, setMenuAberto] = useState(false);
  const profileMenuRef = useRef<HTMLDetailsElement>(null);

  // Fecha o dropdown do perfil ao clicar fora
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (profileMenuRef.current?.open && !profileMenuRef.current.contains(event.target as Node)) {
        profileMenuRef.current.open = false;
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Quem aplica o tema é o script de layout.tsx, antes da primeira pintura e em toda página.
  // Aqui só se lê o que ele já decidiu, para os botões mostrarem o estado certo.
  useEffect(() => {
    const applied = document.documentElement.getAttribute("data-theme");
    if (applied === "light" || applied === "dark") setTheme(applied);
  }, []);

  useEffect(() => {
    if (isLowEndDevice()) setLowEndDevice(true);
  }, []);

  const changeTheme = (newTheme: "dark" | "light") => {
    setTheme(newTheme);
    document.documentElement.setAttribute("data-theme", newTheme);
    try {
      localStorage.setItem("cebola_theme", newTheme);
    } catch {
      // Tema não persistido é aceitável; travar a troca por causa disso, não.
    }
  };

  // A busca virou uma tela própria (`/busca`, estilo HBO Max); um link antigo com `?search=`
  // ainda precisa funcionar, só que agora redireciona para lá em vez de abrir um trilho aqui.
  useEffect(() => {
    const requestedSearch = query.get("search")?.trim();
    if (!requestedSearch || requestedSearch.length < MIN_SEARCH_QUERY_LENGTH) return;
    router.replace(searchPageHref(requestedSearch));
  }, [query, router]);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setViewState("loading");
      resetPosterFailureTracking();
      let shellReady = false;
      try {
        const bootstrapResponse = await apiFetch(`/v1/home/bootstrap`, {
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal
        });
        if (bootstrapResponse.status === 401) {
          router.replace("/entrar");
          return;
        }
        if (!bootstrapResponse.ok) throw new Error("home unavailable");
        const bootstrap = await bootstrapResponse.json() as unknown;
        if (!isHomeBootstrap(bootstrap)) throw new Error("invalid response");
        if (bootstrap.activeProfile === null) {
          router.replace("/perfis/index.html");
          return;
        }
        setProfile(bootstrap.activeProfile);
        setProgress(bootstrap.progress.items);
        setLibrary(bootstrap.library.items);
        setStremioLinked(bootstrap.stremio.linked);
        // Perfil e progresso bastam para desenhar a home. Editorial e addons são incrementais:
        // uma integração externa lenta nunca deve manter a aplicação inteira no skeleton.
        shellReady = true;
        setViewState("ready");

        const linked = bootstrap.stremio.linked;
        if (linked) {
          const catalogsResponse = await apiFetch(`/v1/stremio/catalogs`, {
            cache: "no-store",
            headers: { Accept: "application/json" },
            signal
          });
          if (!catalogsResponse.ok) return;
          const catalogsBody = (await catalogsResponse.json()) as { catalogs?: unknown };
          if (
            !Array.isArray(catalogsBody.catalogs) ||
            !catalogsBody.catalogs.every(isCatalogDescriptor)
          ) {
            return;
          }
          const selected = [...new Map(
            catalogsBody.catalogs
              .map((catalog) => [`${catalog.addonId}:${catalog.type}:${catalog.catalogId}`, catalog])
          ).values()].slice(0, 10);
          // A falha de UM catálogo é engolida pelo pool logo abaixo (uma fonte fora do ar não
          // pode travar as outras nove), e é exatamente por isso que precisa ser reportada aqui:
          // sem isto, o dono nunca saberia que um addon específico parou de responder.
          const loadCatalog = async (catalog: CatalogDescriptor): Promise<CatalogRail> => {
            const path = [catalog.addonId, catalog.type, catalog.catalogId].map(encodeURIComponent).join("/");
            let status: number | undefined;
            try {
              const response = await apiFetch(`/v1/stremio/catalog/${path}`, {
                headers: { Accept: "application/json" },
                signal
              });
              status = response.status;
              if (!response.ok) throw new Error("catalog unavailable");
              const body = (await response.json()) as { items?: unknown };
              if (!Array.isArray(body.items) || !body.items.every(isCatalogItem)) throw new Error("invalid catalog");
              return { ...catalog, items: body.items.slice(0, 30) } satisfies CatalogRail;
            } catch (error) {
              if (!(error instanceof DOMException && error.name === "AbortError")) {
                reportDiagnostic("CATALOG_LOAD_FAILED", error instanceof Error ? error.message : "erro desconhecido", {
                  addonId: catalog.addonId, catalogId: catalog.catalogId, type: catalog.type,
                  ...(status !== undefined ? { status: String(status) } : {})
                });
              }
              throw error;
            }
          };
          // Quatro de cada vez, mas sem lotes: quem termina libera a vaga na hora. Antes eram
          // quatro rodadas em série para dez catálogos, cada rodada durando o tempo da fonte
          // mais lenta dela.
          await loadWithPool({
            items: selected,
            limit: 4,
            load: loadCatalog,
            shouldStop: () => signal?.aborted === true,
            onProgress: (loaded) => {
              // Uma carga que já estava em voo quando o abort chegou não pode desenhar por cima
              // da tela seguinte: `shouldStop` impede novos itens, não os que já partiram.
              if (signal?.aborted) return;
              // Só o trecho contínuo já resolvido. Publicar a lista filtrada inteira fazia uma
              // fileira já desenhada DESCER quando um buraco anterior era preenchido depois —
              // com dez catálogos e quatro em paralelo, a lista se remexia várias vezes durante
              // o carregamento, movendo cards debaixo do dedo. O código em lotes que isto
              // substituiu nunca movia nada: ele só acrescentava ao fim.
              // A renderização de dezenas de cards não pode disputar o frame com um toque ou
              // com o hero. A transição deixa esse trabalho interrompível no celular; o helper
              // também ignora conclusões atrás de uma lacuna, que ainda não alteram a tela.
              startTransition(() => {
                setCatalogRails((current) => contiguousReadyItems(
                  current,
                  loaded,
                  (rail) => rail.items.length > 0
                ));
              });
            }
          });
        } else {
          setCatalogRails([]);
        }
      } catch (error) {
        if (!shellReady && !(error instanceof DOMException && error.name === "AbortError")) setViewState("error");
      }
    },
    [router]
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // Foco da barra (TV): quando a home real substitui o esqueleto — ao abrir o app ou ao trocar
  // de seção —, o foco ficava em lugar nenhum. Volta pro item em que estava no esqueleto ou,
  // sem isso, pra seção atual ("Início" ao abrir). Não mexe se algo já tem foco de verdade.
  useEffect(() => {
    if (!tvLayout || viewState !== "ready") return;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body && document.body.contains(active)) return;
      const bar = document.querySelector<HTMLElement>("header.navbar");
      if (!bar) return;
      const same = tvSkeletonNavFocus
        ? [...bar.querySelectorAll<HTMLElement>("a[href], summary, button")].find((item) => navItemLabel(item) === tvSkeletonNavFocus)
        : undefined;
      tvSkeletonNavFocus = null;
      (same ?? bar.querySelector<HTMLElement>(".navbar-center a.active"))?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [tvLayout, viewState]);

  /**
   * NÃO depende de `profile`. Dependia, e era isso que punha as fileiras editoriais atrás do
   * `/v1/home/bootstrap` inteiro: duas viagens em série antes de aparecer conteúdo, sendo que
   * a seleção editorial não precisa de nada que o bootstrap traga. Agora as duas partem juntas
   * na montagem, e quem chegar primeiro desenha primeiro. O 401 continua tratado — quem trata
   * agora é o carregador compartilhado, que devolve o estado em vez de um `Response` cru.
   */
  useEffect(() => {
    setEditorialPage(1);
    setExpandedRails({});
    const ready = cachedEditorialHome(catalogView);
    if (ready) {
      setEditorialRails(ready);
      return;
    }

    setEditorialRails([]);
    let current = true;
    void loadEditorialCategory(catalogView, (rails) => {
      if (current) setEditorialRails(rails);
    }).then((result) => {
      if (!current) return;
      if (result.status === "unauthorized") {
        router.replace("/entrar");
        return;
      }
      setEditorialRails(result.status === "ok" ? result.rails : []);
    });
    return () => {
      current = false;
    };
  }, [catalogView, router]);

  /**
   * A API já entrega a biblioteca canônica no bootstrap (`setLibrary` acima). O que falta é a
   * migração única dos itens que só existiam no aparelho antes da conta existir — feita uma vez
   * por perfil (ver `library-client.ts`). Falha na importação nunca esconde o que a pessoa já
   * tinha: a lista continua com o que o bootstrap trouxe, e a próxima abertura tenta de novo.
   */
  useEffect(() => {
    if (!profile) return;
    let alive = true;
    void importLegacyLibrary(profile.id, library).then((result) => {
      if (!alive) return;
      setLibrary(result.items);
      if (!result.synced) {
        setLibraryNotice({
          message: "Não foi possível sincronizar os itens salvos neste aparelho agora. Vamos tentar de novo na próxima abertura."
        });
      }
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    if (!profile || catalogView !== "home" || libraryOnly) {
      setPersonalizedItems([]);
      return;
    }

    const signals = buildRecommendationSignals(library, progress);
    if (signals.length === 0) {
      // Histórico ainda carregando (ou vazio): a última lista do perfil já ocupa o lugar.
      setPersonalizedItems(cachedPersonalizedRecommendations(profile.id));
      return;
    }
    let current = true;
    const profileId = profile.id;
    setPersonalizedItems((items) => items.length > 0 ? items : cachedPersonalizedRecommendations(profileId));
    void loadPersonalizedRecommendations(signals).then((items) => {
      if (!current) return;
      setPersonalizedItems(items);
      rememberPersonalizedRecommendations(profileId, items);
    });
    return () => { current = false; };
  }, [catalogView, library, libraryOnly, profile, progress]);

  // Vencedores do Emmy: fileira fixa da home (abaixo de "Recém-chegados"). Curadoria vem da API.
  useEffect(() => {
    if (libraryOnly || catalogView !== "home") {
      setEmmyWinners(null);
      return;
    }
    let alive = true;
    void loadEmmyWinners().then((data) => {
      if (alive) setEmmyWinners(data && data.winners.length > 0 ? data : null);
    });
    return () => { alive = false; };
  }, [catalogView, libraryOnly]);

  useEffect(() => {
    setNativeRuntime(isNativeRuntime());
  }, []);

  useEffect(() => {
    const updateInstallPrompt = () => setInstallPrompt(window.cebolaInstallPrompt ?? null);
    updateInstallPrompt();
    window.addEventListener("cebola:install-ready", updateInstallPrompt);
    return () => window.removeEventListener("cebola:install-ready", updateInstallPrompt);
  }, []);

  /**
   * PUT adiciona, DELETE remove — sempre otimista, sempre com reversão em falha (ver
   * `applyLibraryChange`). O aviso guarda a própria retentativa: clicar em "Tentar novamente"
   * chama `toggleLibrary` de novo com o mesmo item, e como o estado já foi revertido a chamada
   * repete exatamente a mesma ação que falhou.
   */
  const toggleLibrary = useCallback((item: CatalogItem, addonId: string) => {
    if (!profile) return;
    setLibraryNotice(null);
    const current = library;
    const isRemoving = isSavedToLibrary(current, item.id, item.type);
    void applyLibraryChange({
      current,
      item,
      addonId,
      request: apiFetch,
      onOptimistic: setLibrary
    }).then((result) => {
      setLibrary(result.items);
      if (!result.ok) {
        setLibraryNotice({
          message: isRemoving
            ? `Não foi possível remover "${item.name}" da biblioteca. Tente novamente.`
            : `Não foi possível adicionar "${item.name}" à biblioteca. Tente novamente.`,
          retry: () => toggleLibrary(item, addonId)
        });
      }
    });
  }, [library, profile]);

  // Atalho de teclado para busca (/ ou Ctrl+K): a busca agora é uma tela própria, então o atalho
  // só precisa navegar até ela — exceto enquanto a pessoa já digita em outro campo da página.
  useEffect(() => {
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      const target = event.target;
      const typing = target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if ((event.key === "/" || (event.ctrlKey && event.key === "k")) && !typing) {
        event.preventDefault();
        router.push(searchPageHref());
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [router]);

  const visibleCatalogRails = useMemo(() => {
    // Catálogo do Stremio não é brasileiro nem documental: nessas abas só entra a curadoria delas.
    if (catalogView === "documentaries" || catalogView === "brazil") return [];
    if (catalogView === "anime") return catalogRails.filter((rail) => isAnimeCatalog(rail) && !isRedundantCatalogRail(rail));
    return catalogRails.filter((rail) => !isAnimeCatalog(rail) && !isRedundantCatalogRail(rail)
      // Catálogo do Stremio é de um tipo só: em Filmes/Séries, só entra o do tipo da aba.
      && (catalogView !== "movies" || rail.type === "movie")
      && (catalogView !== "series" || rail.type === "series"));
  }, [catalogRails, catalogView]);

  const spotlightCandidates = useMemo(() => {
    const providerRails = editorialRails.filter((rail) => {
      if (!rail.provider) return false;
      if (catalogView === "movies") return rail.id.startsWith("provider-movie-");
      if (catalogView === "series") return rail.id.startsWith("provider-series-");
      if (catalogView === "documentaries") return false;
      if (catalogView === "anime") return rail.id.startsWith("provider-anime-");
      if (catalogView === "brazil") return false;
      return rail.id.startsWith("provider-") && !rail.id.startsWith("provider-anime-");
    });
    const pool: SpotlightCandidate[] = [];
    const seenInPool = new Set<string>();
    // Uma passagem por posição distribui os serviços antes de consumir toda a fileira de um só.
    for (let itemIndex = 0; itemIndex < 10; itemIndex += 1) {
      for (const editorialRail of providerRails) {
        const editorialItem = editorialRail.items[itemIndex];
        if (!editorialItem || (!editorialItem.backdropUrl && !editorialItem.posterUrl)) continue;
        const key = `${editorialItem.type}:${editorialItem.tmdbId}`;
        if (seenInPool.has(key)) continue;
        seenInPool.add(key);
        pool.push({
          item: {
            id: `tmdb:${editorialItem.tmdbId}`,
            type: editorialItem.type,
            name: editorialItem.title,
            poster: editorialItem.posterUrl,
            background: editorialItem.backdropUrl,
            backgroundPreview: editorialItem.backdropPreviewUrl,
            description: editorialItem.overview,
            releaseInfo: editorialItem.year ? String(editorialItem.year) : null
          },
          rail: {
            addonId: "editorial.tmdb",
            catalogId: editorialRail.id,
            type: editorialItem.type,
            name: editorialRail.title,
            items: []
          },
          provider: editorialRail.provider ?? null
        });
      }
    }

    // Escolha gulosa: primeiro evita repetir serviço e, na Início, também alterna o tipo.
    const balanced: SpotlightCandidate[] = [];
    const remaining = [...pool];
    while (balanced.length < 12 && remaining.length > 0) {
      const previous = balanced.at(-1);
      let index = remaining.findIndex((candidate) =>
        candidate.provider?.id !== previous?.provider?.id &&
        (catalogView !== "home" || candidate.item.type !== previous?.item.type)
      );
      if (index < 0) index = remaining.findIndex((candidate) => candidate.provider?.id !== previous?.provider?.id);
      if (index < 0) index = 0;
      balanced.push(remaining.splice(index, 1)[0]!);
    }
    if (balanced.length > 0) return balanced;

    // Fallback editorial quando nenhum provedor do Brasil respondeu.
    const unique = new Map<string, SpotlightCandidate>();
    const fallbackRails = editorialRails.filter((rail) => {
      if (catalogView === "movies") return rail.items.some((item) => item.type === "movie");
      if (catalogView === "series") return rail.id.startsWith("series-");
      if (catalogView === "documentaries") return rail.id.startsWith("documentaries-");
      if (catalogView === "anime") return rail.id.startsWith("anime-");
      if (catalogView === "brazil") return rail.id.startsWith("brazil-");
      return !rail.id.startsWith("anime-") && !rail.id.startsWith("provider-anime-");
    });
    for (const editorialRail of fallbackRails) {
      for (const editorialItem of editorialRail.items) {
        if (!editorialItem.backdropUrl && !editorialItem.posterUrl) continue;
        const key = `${editorialItem.type}:${editorialItem.tmdbId}`;
        if (unique.has(key)) continue;
        unique.set(key, {
          item: {
            id: `tmdb:${editorialItem.tmdbId}`,
            type: editorialItem.type,
            name: editorialItem.title,
            poster: editorialItem.posterUrl,
            background: editorialItem.backdropUrl,
            backgroundPreview: editorialItem.backdropPreviewUrl,
            description: editorialItem.overview,
            releaseInfo: editorialItem.year ? String(editorialItem.year) : null
          },
          rail: {
            addonId: "editorial.tmdb",
            catalogId: editorialRail.id,
            type: editorialItem.type,
            name: editorialRail.title,
            items: []
          },
          provider: null
        });
      }
    }
    const editorialEntries = [...unique.values()];
    if (editorialEntries.length > 0) {
      const utcDay = Math.floor(Date.now() / 86_400_000);
      const start = (utcDay * 12) % editorialEntries.length;
      return Array.from(
        { length: Math.min(12, editorialEntries.length) },
        (_, index) => editorialEntries[(start + index) % editorialEntries.length]!
      );
    }

    // Se o TMDB estiver temporariamente fora, a home continua utilizável com os catálogos da
    // conta Stremio. Este fallback não interfere na navegação nem na reprodução.
    return visibleCatalogRails
      .flatMap((rail) => rail.items.map((item) => ({ item, rail, provider: null })))
      .filter(({ item }) => Boolean(item.background || item.poster))
      .slice(0, 12);
  }, [catalogView, editorialRails, visibleCatalogRails]);
  const [spotlightIndex, setSpotlightIndex] = useState(0);
  const [isHeroHovered, setIsHeroHovered] = useState(false);
  const [isHeroTeaserModalOpen, setIsHeroTeaserModalOpen] = useState(false);
  const [isHeroDragging, setIsHeroDragging] = useState(false);
  // Só existe (e só importa) na TV: no controle remoto não há "mouse em cima" para pausar o
  // autoplay do carrossel — o equivalente é o foco do controle estar em algum botão/indicador
  // do banner. Ficar fora do `tvLayout` deixaria PC/celular reagindo a foco por Tab, mudando
  // um comportamento que hoje não existe para eles — por isso todo uso abaixo checa `tvLayout`.
  const [isHeroFocused, setIsHeroFocused] = useState(false);
  const [logoErrors, setLogoErrors] = useState<Record<string, boolean>>({});
  const [providerLogoErrors, setProviderLogoErrors] = useState<Record<string, boolean>>({});
  const heroDragStartX = useRef<number | null>(null);
  const heroDragDistance = useRef(0);
  const heroPausedByFocus = tvLayout && isHeroFocused;

  useEffect(() => {
    setSpotlightIndex((current) => nextCarouselIndex(current, spotlightCandidates.length));
  }, [spotlightCandidates.length]);

  useEffect(() => {
    if (spotlightCandidates.length < 2 || isHeroHovered || isHeroDragging || isHeroTeaserModalOpen || heroPausedByFocus) return;
    const timer = window.setTimeout(
      () => setSpotlightIndex((index) => (index + 1) % spotlightCandidates.length),
      10_000
    );
    return () => window.clearTimeout(timer);
  }, [spotlightCandidates.length, spotlightIndex, isHeroHovered, isHeroDragging, isHeroTeaserModalOpen, heroPausedByFocus]);

  useEffect(() => {
    // Sem os pontos indicadores na TV, ←/→ nos botões das pontas do banner viram "anterior" e
    // "próximo" (ver `data-tv-edge-prev/-next` nos botões e `tv-navigation.tsx`, que despacha
    // este evento). O foco continua no mesmo botão: a posição dele no DOM não muda, só o
    // conteúdo é atualizado pelo novo `spotlightIndex`.
    if (!tvLayout) return;
    const handleHeroStep = (event: Event) => {
      const direction = (event as CustomEvent<string>).detail;
      setSpotlightIndex((index) => {
        const total = spotlightCandidates.length;
        if (total === 0) return index;
        return direction === "prev" ? (index - 1 + total) % total : (index + 1) % total;
      });
    };
    window.addEventListener("cebola:tv-hero-step", handleHeroStep);
    return () => window.removeEventListener("cebola:tv-hero-step", handleHeroStep);
  }, [tvLayout, spotlightCandidates.length]);

  const featuredSpotlight = spotlightCandidates[spotlightIndex] ?? null;
  // O banner é o único lugar da home que consulta o TMDB sem esperar interação: ele já está na
  // tela, e é dele que sai o teaser. Uma consulta por destaque exibido, servida do mesmo cache
  // dos cards — abrir o título depois não pede de novo.
  const spotlightLookup = useMemo(() => featuredSpotlight ? {
    type: featuredSpotlight.item.type,
    mediaId: featuredSpotlight.item.id,
    title: featuredSpotlight.item.name,
    year: releaseYear(featuredSpotlight.item) || null
  } : null, [featuredSpotlight]);
  const spotlightEditorial = useEditorial(spotlightLookup, true);
  const webTrailers = useWebTrailers(tvLayout);
  const spotlightTeaserId = webTrailers ? youtubeId(spotlightEditorial?.trailerUrl) : null;
  // A imagem aparece primeiro; adiar o iframe reduz CPU, memória e rede no início da home. Em
  // aparelho fraco o trailer nem entra na jogada: `--hero-background` (CSS, sempre presente)
  // segue como fundo do banner.
  const playSpotlightTeaser = useDelayedFlag(
    // Na TV o trailer nunca entra: os controles do YouTube (som, tela cheia, "Assistir no
    // YouTube") ficavam por cima do banner e não dá pra fechá-los pelo controle remoto — fica
    // só a imagem de fundo (`--hero-background`), que já é o que o projetor fraco usa hoje.
    spotlightTeaserId !== null && !lowEndDevice && !tvLayout,
    3_000,
    spotlightTeaserId ?? ""
  );

  const spotlightLogo = (!logoErrors[featuredSpotlight?.item.id ?? ""] && (spotlightEditorial?.logoUrl || featuredSpotlight?.item.logo)) || null;
  const spotlightProvider = featuredSpotlight?.provider ??
    spotlightEditorial?.availability.subscription.find((provider) => STREAMING_PROVIDER_IDS.has(provider.id)) ?? null;
  const spotlightProviderLogoKey = `${featuredSpotlight?.item.id ?? ""}:${spotlightProvider?.id ?? ""}`;
  const spotlightProviderLogo = spotlightProvider && !providerLogoErrors[spotlightProviderLogoKey]
    ? spotlightEditorial?.availability.subscription.find((provider) => provider.id === spotlightProvider.id)?.logoUrl ?? spotlightProvider.logoUrl
    : null;
  const spotlightYear = spotlightEditorial?.year ? String(spotlightEditorial.year) : featuredSpotlight?.item.releaseInfo ? featuredSpotlight.item.releaseInfo.slice(0, 4) : null;
  const spotlightRuntime = compactRuntime(spotlightEditorial?.runtimeMinutes ?? null);
  const spotlightVote = (spotlightEditorial?.voteAverage ?? null) ? `★ ${spotlightEditorial!.voteAverage!.toFixed(1)}` : null;
  const spotlightGenres = (spotlightEditorial?.genres.slice(0, 3) ?? featuredSpotlight?.item.genres?.slice(0, 3) ?? []);
  const spotlightAuthors = spotlightEditorial?.directors.length
    ? `Direção: ${spotlightEditorial.directors.slice(0, 2).join(", ")}`
    : spotlightEditorial?.creators.length ? `Criação: ${spotlightEditorial.creators.slice(0, 2).join(", ")}` : null;
  const spotlightDescription = spotlightEditorial?.overview || featuredSpotlight?.item.description || null;

  const handleHeroTouchStart = (e: React.TouchEvent) => {
    heroDragStartX.current = e.touches[0]?.clientX ?? null;
    heroDragDistance.current = 0;
  };

  const handleHeroTouchMove = (e: React.TouchEvent) => {
    if (heroDragStartX.current === null || !e.touches[0]) return;
    heroDragDistance.current = e.touches[0].clientX - heroDragStartX.current;
  };

  const handleHeroTouchEnd = () => {
    if (heroDragStartX.current === null) return;
    if (heroDragDistance.current > 40) {
      setSpotlightIndex((index) => (index - 1 + spotlightCandidates.length) % spotlightCandidates.length);
    } else if (heroDragDistance.current < -40) {
      setSpotlightIndex((index) => (index + 1) % spotlightCandidates.length);
    }
    heroDragStartX.current = null;
    heroDragDistance.current = 0;
  };

  const handleHeroMouseDown = (e: React.MouseEvent) => {
    if (e.target instanceof Element && e.target.closest("a, button, input, form, select")) return;
    heroDragStartX.current = e.clientX;
    heroDragDistance.current = 0;
    setIsHeroDragging(true);
  };

  const handleHeroMouseMove = (e: React.MouseEvent) => {
    if (!isHeroDragging || heroDragStartX.current === null) return;
    heroDragDistance.current = e.clientX - heroDragStartX.current;
  };

  const handleHeroMouseUp = () => {
    if (isHeroDragging && heroDragStartX.current !== null) {
      if (heroDragDistance.current > 45) {
        setSpotlightIndex((index) => (index - 1 + spotlightCandidates.length) % spotlightCandidates.length);
      } else if (heroDragDistance.current < -45) {
        setSpotlightIndex((index) => (index + 1) % spotlightCandidates.length);
      }
    }
    setIsHeroDragging(false);
    heroDragStartX.current = null;
    heroDragDistance.current = 0;
  };

  const heroWheelLock = useRef(false);
  const handleHeroWheel = (e: React.WheelEvent) => {
    if (Math.abs(e.deltaX) > 20 && !heroWheelLock.current) {
      heroWheelLock.current = true;
      if (e.deltaX > 20) {
        setSpotlightIndex((index) => (index + 1) % spotlightCandidates.length);
      } else if (e.deltaX < -20) {
        setSpotlightIndex((index) => (index - 1 + spotlightCandidates.length) % spotlightCandidates.length);
      }
      window.setTimeout(() => {
        heroWheelLock.current = false;
      }, 400);
    }
  };

  const visibleEditorialRails = useMemo(() => {
    if (catalogView === "home") {
      const compact = editorialRails.filter((rail) => rail.id === "home-new" || rail.id === "home-trending" || rail.id === "home-classics");
      if (compact.length > 0) return compact;
      // Compatibilidade durante atualização sem interrupção: uma API antiga ainda devolve as
      // fontes separadas, e o cliente sabe combiná-las até todos os containers serem renovados.
      const combine = (id: string, title: string, sourceIds: readonly string[]): EditorialHomeRail => {
        const sources = sourceIds.flatMap((sourceId) => editorialRails.filter((rail) => rail.id === sourceId));
        const seen = new Set<string>();
        const items: EditorialHomeItem[] = [];
        // Alternar as fontes impede que uma categoria inteira seja dominada por filmes ou séries.
        for (let index = 0; index < 20 && items.length < 20; index += 1) {
          for (const source of sources) {
            const item = source.items[index];
            const key = item ? `${item.type}:${item.tmdbId}` : "";
            if (!item || seen.has(key)) continue;
            seen.add(key);
            items.push(item);
            if (items.length === 20) break;
          }
        }
        return { id, title, items };
      };
      return [
        combine("home-new", "Recém-chegados para descobrir", ["movies-new", "series-new", "brazil-new-movies", "brazil-new-series"]),
        combine("home-trending", "O que está em alta agora", ["movies-trending", "series-trending", "brazil-top10-movies", "brazil-top10-series"]),
        combine("home-classics", "Clássicos que você não pode perder", ["movies-classics", "series-classics", "brazil-classics-movies", "brazil-classics-series"])
      ].filter((rail) => rail.items.length > 0);
    }
    if (catalogView === "brazil") return editorialRails.filter((rail) => rail.id.startsWith("brazil-"));
    return editorialRails.filter((rail) => rail.id.startsWith(`${catalogView}-`));
  }, [catalogView, editorialRails]);
  /**
   * Traz mais sugestões para uma fileira. Enquanto houver item já carregado, só revela; quando
   * acabam, busca a página seguinte da seção e junta o que veio. A busca é sob demanda de
   * propósito: quem nunca clica não paga a viagem, e a home continua abrindo com uma página só.
   */
  const verMais = useCallback(async (railId: string, carregados: number) => {
    const mostrando = expandedRails[railId] ?? ITENS_POR_PAGINA;
    const desejado = mostrando + ITENS_POR_PAGINA;

    if (desejado > carregados && editorialPage < MAX_PAGINAS_EDITORIAIS) {
      const proxima = editorialPage + 1;
      setRailLoading(railId);
      try {
        const resultado = await loadEditorialHome(catalogView, proxima);
        if (resultado.status === "unauthorized") {
          router.replace("/entrar");
          return;
        }
        if (resultado.status === "ok") {
          setEditorialPage(proxima);
          // Junta pelo id da fileira, sem repetir título que já está na tela.
          setEditorialRails((atuais) => atuais.map((rail) => {
            const chegou = resultado.rails.find((novo) => novo.id === rail.id);
            if (!chegou) return rail;
            const jaTem = new Set(rail.items.map((item) => `${item.type}:${item.tmdbId}`));
            const novos = chegou.items.filter((item) => !jaTem.has(`${item.type}:${item.tmdbId}`));
            return novos.length === 0 ? rail : { ...rail, items: [...rail.items, ...novos] };
          }));
        }
      } finally {
        setRailLoading(null);
      }
    }

    setExpandedRails((current) => ({ ...current, [railId]: desejado }));
  }, [catalogView, editorialPage, expandedRails, router]);

  /**
   * TV: trocar de seção só muda a query da MESMA página (`history.pushState`, que o App Router
   * acompanha no `useSearchParams`). O link comum, no app empacotado, recarregava a home inteira —
   * tela vazia, esqueleto, home — e a barra piscava. Assim a barra e o foco ficam onde estão e só o
   * conteúdo de baixo troca. Fora da TV o link segue normal.
   */
  const trocarSecao = useCallback((event: ReactMouseEvent<HTMLAnchorElement>, secao: string) => {
    if (!tvLayout) return;
    event.preventDefault();
    const destino = secao ? `${window.location.pathname}?${secao}` : window.location.pathname;
    if (`${window.location.pathname}${window.location.search}` !== destino) {
      setEditorialPage(1);
      setExpandedRails({});
      window.history.pushState(null, "", destino);
    }
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [tvLayout]);

  useEffect(() => {
    const pendente = verMaisFocoRef.current;
    if (!pendente || railLoading) return;
    verMaisFocoRef.current = null;
    const card = pendente.trilha.children[pendente.posicao];
    if (!(card instanceof HTMLElement)) return;
    const alvo = card.matches("a[href], button") ? card : card.querySelector<HTMLElement>("a[href], button");
    alvo?.focus({ preventScroll: true });
    card.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "instant" });
  }, [expandedRails, editorialRails, railLoading]);

  useEffect(() => {
    if (!menuAberto) return;
    // `globalThis.` porque o React também exporta um `KeyboardEvent`, que sombreia o do DOM.
    const aoTeclar = (evento: globalThis.KeyboardEvent) => {
      if (evento.key === "Escape") setMenuAberto(false);
    };
    window.addEventListener("keydown", aoTeclar);
    return () => window.removeEventListener("keydown", aoTeclar);
  }, [menuAberto]);

  // Trocar de seção fecha o menu: sem isto ele fica aberto por cima do conteúdo novo.
  useEffect(() => {
    setMenuAberto(false);
  }, [catalogView, libraryOnly]);

  useEffect(() => {
    if (!profile) return;
    let disposed = false;
    const retry = () => { void retryPendingProgress(profile.id).then(async () => {
      const items = await fetchProgressItems();
      if (!disposed && items.length > 0) setProgress((items as readonly unknown[]).filter(isProgressItem).slice(0, 30));
    }); };
    retry();
    window.addEventListener("online", retry);
    return () => { disposed = true; window.removeEventListener("online", retry); };
  }, [profile?.id]);

  const continueItems = useMemo(() => continueEntries(progress), [progress]);

  // Volta do segundo plano: relê o progresso para o "Continuar" mostrar o que outro aparelho
  // gravou nesse meio-tempo. Mesmo recorte do bootstrap: as 30 gravações mais recentes.
  useReturnToForeground(() => {
    if (viewState !== "ready") return;
    void fetchProgressItems().then((items) => {
      const fresh = (items as readonly unknown[]).filter(isProgressItem);
      // O módulo de progresso devolve lista vazia quando a leitura falha: mantém a tela como está.
      if (fresh.length === 0) return;
      setProgress(fresh.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)).slice(0, 30));
    });
  });
  const defaultAddonId = catalogRails[0]?.addonId ?? "community.cinemeta";

  const handleRemoveProgress = useCallback(async (item: ProgressItem, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const identity = continueIdentity(item);
    const removed = progress.filter((entry) => continueIdentity(entry) === identity);
    setProgress((current) => current.filter((entry) => continueIdentity(entry) !== identity));
    const saved = await hideProgress({ mediaId: item.mediaId, videoId: item.videoId, mediaType: item.mediaType });
    if (!saved) {
      setLibraryNotice({ message: "Não foi possível remover de Continuar assistindo. Tente novamente quando houver conexão." });
      setProgress((current) => [...current, ...removed.filter((entry) => !current.some((value) => value.id === entry.id))]);
    }
  }, [progress]);

  if (viewState === "loading") {
    return <HomeSkeleton />;
  }

  if (viewState === "error" || profile === null) {
    return (
      <main className="home-state" role="alert">
        <strong>Não foi possível carregar sua página.</strong>
        <p style={{ color: "var(--text-muted)", margin: "0.25rem 0 1rem" }}>
          Verifique a conexão com a API Cebola e tente novamente.
        </p>
        <button className="btn btn-primary" type="button" onClick={() => void load()}>
          Tentar novamente
        </button>
      </main>
    );
  }

  return (
    <main className="app-shell">
      {/* Barra de navegação com Glassmorphism centralizada estilo HBO Max */}
      {/* TV: `lrud-container` faz da barra inteira um grupo do LRUD. Sem isto, sair do tema/
          avatar pra dentro do menu central caía sempre no 1º item dele (a lupa), não no vizinho. */}
      <header className={`navbar${tvLayout ? " lrud-container" : ""}`} data-tv-zone={tvLayout ? "menu" : undefined}>
        <div className="navbar-brand-section">
          {/* No celular a navegação de seções era simplesmente escondida, sem nada no lugar:
              não havia como chegar em Filmes, Séries, Documentários, Anime ou Brasil. Este botão ocupa a
              posição da marca abaixo de 768px e abre as mesmas opções. */}
          <button
            type="button"
            className="navbar-menu-btn"
            aria-label={menuAberto ? "Fechar menu de seções" : "Abrir menu de seções"}
            aria-expanded={menuAberto}
            aria-controls="menu-secoes"
            onClick={() => setMenuAberto((aberto) => !aberto)}
          >
            <span aria-hidden="true" />
            <span aria-hidden="true" />
            <span aria-hidden="true" />
          </button>
          {tvLayout ? (
            // Na TV a marca é só decoração, na ponta direita (ver styles.css): "Início" já é uma
            // pílula do menu central, e um `<a href>` aqui roubaria o primeiro foco da página —
            // `tv-navigation.tsx` foca o primeiro `a[href]` do DOM ao entrar na tela.
            <span className="brand" aria-hidden="true">
              <BrandIcon size={34} className="brand-icon-wrapper" />
            </span>
          ) : (
            <a className="brand" href="#inicio" aria-label="Início">
              <BrandIcon size={34} className="brand-icon-wrapper" />
            </a>
          )}
        </div>

        <nav
          id="menu-secoes"
          className={`navbar-center${menuAberto ? " is-open" : ""}`}
          aria-label="Navegação principal"
          // Sem `data-block-exit`: ele travava ←/→ nas pontas e deixava o avatar do perfil e o
          // botão de tema inalcançáveis. Quem impede o foco de sair da barra é a zona "menu"
          // (`tv-navigation.tsx` nunca deixa ←/→ trocar de zona).
        >
          {tvLayout && stremioLinked && (
            // Mesmo link de busca de hoje — na TV vira a lupa do menu central em vez do ícone
            // avulso de `.navbar-right` (esse fica escondido, ver styles.css).
            <a
              href={searchPageHref()}
              className="tv-search-pill"
              title="Buscar filmes e séries (pressione /)"
              aria-label="Abrir busca"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </a>
          )}
          <Link href="/" onClick={(event) => trocarSecao(event, "")} className={!libraryOnly && catalogView === "home" ? "active" : undefined}>Início</Link>
          <Link href="/?catalog=movies" onClick={(event) => trocarSecao(event, "catalog=movies")} className={!libraryOnly && catalogView === "movies" ? "active" : undefined}>Filmes</Link>
          <Link href="/?catalog=series" onClick={(event) => trocarSecao(event, "catalog=series")} className={!libraryOnly && catalogView === "series" ? "active" : undefined}>Séries</Link>
          <Link href="/?catalog=documentaries" onClick={(event) => trocarSecao(event, "catalog=documentaries")} className={!libraryOnly && catalogView === "documentaries" ? "active" : undefined}>Documentários</Link>
          <Link href="/?catalog=anime" onClick={(event) => trocarSecao(event, "catalog=anime")} className={!libraryOnly && catalogView === "anime" ? "active" : undefined}>Anime</Link>
          <Link href="/?catalog=brazil" onClick={(event) => trocarSecao(event, "catalog=brazil")} className={!libraryOnly && catalogView === "brazil" ? "active" : undefined}>Brasil</Link>
          {mobileBooks && <a href={appPagePath("/livros")}>Livro</a>}
          {tvLayout && (
            // Mesmo link de "Minha Biblioteca" de hoje — na TV também vira pílula do menu
            // central, em vez do ícone avulso de `.navbar-right`.
            // Só o ícone (o mesmo do PC): o texto quebrava em duas linhas na barra.
            <Link
              href="/?view=library"
              onClick={(event) => trocarSecao(event, "view=library")}
              className={`tv-search-pill${libraryOnly ? " active" : ""}`}
              title="Minha biblioteca"
              aria-label="Minha biblioteca"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
              </svg>
            </Link>
          )}
        </nav>

        <div className="navbar-right">
          {stremioLinked && (
            <a
              href={searchPageHref()}
              className="navbar-icon-btn"
              title="Buscar filmes e séries (pressione /)"
              aria-label="Abrir busca"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </a>
          )}

          <button
            type="button"
            className="navbar-icon-btn theme-toggle-btn"
            onClick={() => changeTheme(theme === "dark" ? "light" : "dark")}
            title={theme === "dark" ? "Alternar para tema claro" : "Alternar para tema escuro"}
            aria-label={theme === "dark" ? "Alternar para tema claro" : "Alternar para tema escuro"}
          >
            {theme === "dark" ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
            )}
          </button>

          <a
            href="/?view=library"
            className="navbar-icon-btn"
            title="Minha Biblioteca"
            aria-label="Minha Biblioteca"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
          </a>

          <details className="profile-menu" ref={profileMenuRef}>
            <summary
              className="profile-chip"
              aria-label={`Perfil atual: ${profile.name}. Abrir menu do perfil.`}
              // `<summary>` é focável no navegador por padrão, mas sem `tabindex` explícito o LRUD
              // da TV não o enxerga (`tv-navigation.tsx`/lib procuram `[tabindex], a, input,
              // button`). Só entra na TV: no PC/celular seguem clicando/tocando, como sempre.
              tabIndex={tvLayout ? 0 : undefined}
            >
              <span className="profile-avatar-circle" aria-hidden="true">
                {(() => {
                  const { isPreset, presetId } = parseAvatarKey(profile.avatarUrl);
                  const preset = isPreset ? getPresetById(presetId) : null;
                  return preset ? preset.renderIcon({ size: 16 }) : profile.name.charAt(0).toLocaleUpperCase("pt-BR");
                })()}
              </span>
              <span className="profile-chip-name">{profile.name}</span>
              <svg className="profile-chip-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </summary>

            <div className="profile-menu-panel">
              <div className="profile-menu-header">
                <span className="profile-menu-avatar" aria-hidden="true">
                  {(() => {
                    const { isPreset, presetId } = parseAvatarKey(profile.avatarUrl);
                    const preset = isPreset ? getPresetById(presetId) : null;
                    return preset ? preset.renderIcon({ size: 24 }) : profile.name.charAt(0).toLocaleUpperCase("pt-BR");
                  })()}
                </span>
                <div className="profile-menu-user-info">
                  <strong className="profile-menu-user-name">{profile.name}</strong>
                  <span className="profile-menu-user-status">Perfil ativo</span>
                </div>
                <a
                  href={`/perfis/index.html?edit=${encodeURIComponent(profile.id)}`}
                  className="profile-menu-edit-btn"
                  title="Editar este perfil"
                  aria-label="Editar este perfil"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                  </svg>
                  <span>Editar</span>
                </a>
              </div>

              <div className="profile-menu-divider" />

              <div className="profile-menu-nav">
                <a href="/perfis/index.html" className="profile-menu-item">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                  <span>Trocar ou gerenciar perfis</span>
                </a>

                <a href="/?view=library" className="profile-menu-item">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                  </svg>
                  <span>Minha biblioteca</span>
                </a>

                <a href="/configuracoes/tv" className="profile-menu-item">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="2" y="4" width="20" height="14" rx="2" />
                    <path d="M8 22h8M12 18v4" />
                  </svg>
                  <span>Instalar em uma TV</span>
                </a>

                <a href={appPagePath("/configuracoes/stremio")} className="profile-menu-item">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.6v-.1A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3V9.6h.1A1.7 1.7 0 0 0 4.6 8.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.1A1.7 1.7 0 0 0 15.5 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.12.37.33.7.6 1 .3.28.68.42 1.1.4h.1v4h-.1A1.7 1.7 0 0 0 19.4 15Z" />
                  </svg>
                  <span>Configurar Stremio</span>
                </a>
              </div>

              <div className="profile-menu-divider" />

              <div className="profile-menu-nav">
                {nativeRuntime && (
                  <button
                    type="button"
                    className="profile-menu-item"
                    onClick={() => {
                      profileMenuRef.current?.removeAttribute("open");
                      window.dispatchEvent(new Event("cebola:check-update"));
                    }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="23 4 23 10 17 10" />
                      <polyline points="1 20 1 14 7 14" />
                      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                    </svg>
                    <span>Verificar atualizações</span>
                  </button>
                )}
                {installPrompt && (
                  <button
                    type="button"
                    className="profile-menu-item"
                    onClick={() => void (async () => {
                      await installPrompt.prompt();
                      await installPrompt.userChoice;
                      setInstallPrompt(null);
                    })()}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    <span>Instalar Aplicativo Web</span>
                  </button>
                )}

                <a href="/download/index.html" className="profile-menu-item">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                    <line x1="8" y1="21" x2="16" y2="21" />
                    <line x1="12" y1="17" x2="12" y2="21" />
                  </svg>
                  <span>Baixar Apps (Android / PC)</span>
                </a>

                <a href="/entrar" className="profile-menu-item profile-menu-item-danger">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                    <polyline points="16 17 21 12 16 7" />
                    <line x1="21" y1="12" x2="9" y2="12" />
                  </svg>
                  <span>Sair da conta</span>
                </a>
              </div>
            </div>
          </details>
        </div>
      </header>

      {libraryNotice ? (
        <div className="library-notice" role="alert">
          <span>{libraryNotice.message}</span>
          <div className="library-notice-actions">
            {libraryNotice.retry ? (
              <button type="button" onClick={() => {
                const retry = libraryNotice.retry;
                setLibraryNotice(null);
                retry?.();
              }}>
                Tentar novamente
              </button>
            ) : null}
            <button type="button" onClick={() => setLibraryNotice(null)}>Dispensar</button>
          </div>
        </div>
      ) : null}

      {/* Hero Spotlight Cinematográfico */}
      {featuredSpotlight && !libraryOnly ? (
        <section
          className={`hero${isHeroDragging ? " dragging" : ""}${isHeroHovered || isHeroTeaserModalOpen || heroPausedByFocus ? " is-paused" : ""}`}
          id="inicio"
          aria-labelledby="hero-title"
          data-tv-zone={tvLayout ? "hero" : undefined}
          onTouchStart={handleHeroTouchStart}
          onTouchMove={handleHeroTouchMove}
          onTouchEnd={handleHeroTouchEnd}
          onMouseDown={handleHeroMouseDown}
          onMouseMove={handleHeroMouseMove}
          onMouseUp={handleHeroMouseUp}
          onMouseLeave={() => {
            setIsHeroHovered(false);
            handleHeroMouseUp();
          }}
          onMouseEnter={() => setIsHeroHovered(true)}
          onWheel={handleHeroWheel}
          // Só liga na TV: o controle remoto não tem "hover", então o foco dentro do banner é o
          // sinal equivalente para pausar o autoplay enquanto a pessoa navega pelos botões/pontos.
          onFocusCapture={tvLayout ? () => setIsHeroFocused(true) : undefined}
          onBlurCapture={tvLayout ? (event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsHeroFocused(false);
          } : undefined}
          style={{
            "--hero-background": `url(${JSON.stringify(featuredSpotlight.item.background || featuredSpotlight.item.poster)})`,
            "--hero-background-compact": `url(${JSON.stringify(featuredSpotlight.item.backgroundPreview || featuredSpotlight.item.background || featuredSpotlight.item.poster)})`
          } as React.CSSProperties}
        >
          {playSpotlightTeaser && spotlightTeaserId ? (
            <div className="hero-teaser" aria-hidden="true">
              <TeaserFrame
                videoId={spotlightTeaserId}
                label={`Trailer de ${featuredSpotlight.item.name}`}
                onModalChange={setIsHeroTeaserModalOpen}
              />
            </div>
          ) : null}
          <div className="hero-vignette" aria-hidden="true" />

          {spotlightCandidates.length > 1 && (
            <>
              <button
                type="button"
                className="hero-side-arrow hero-side-arrow-prev"
                onClick={() => setSpotlightIndex((spotlightIndex - 1 + spotlightCandidates.length) % spotlightCandidates.length)}
                aria-label="Destaque anterior"
                // Na TV elas ficavam em cima do texto e roubavam foco do controle (o LRUD mede
                // geometria pura: sem isto, ficavam "mais perto" da mão pra direita/esquerda do
                // que os próprios botões de ação). Os pontos abaixo já trocam o destaque; a
                // seta some (CSS) e sai do caminho do foco.
                tabIndex={tvLayout ? -1 : undefined}
              >
                ‹
              </button>
              <button
                type="button"
                className="hero-side-arrow hero-side-arrow-next"
                onClick={() => setSpotlightIndex((spotlightIndex + 1) % spotlightCandidates.length)}
                aria-label="Próximo destaque"
                tabIndex={tvLayout ? -1 : undefined}
              >
                ›
              </button>
            </>
          )}

          <div className="hero-content">
            <a
              className="hero-title-link hero-poster-link"
              href={titleHref(
                featuredSpotlight.rail.addonId,
                featuredSpotlight.item.type,
                featuredSpotlight.item.id
              )}
              aria-hidden="true"
              tabIndex={-1}
            >
              <img
                className="hero-poster"
                src={featuredSpotlight.item.poster || featuredSpotlight.item.background || undefined}
                alt=""
                loading="eager"
                decoding="async"
              />
            </a>
            <div className="hero-meta-row">
              {spotlightProvider ? (
                <span className={`badge-tag provider-badge${spotlightProviderLogo ? " has-logo" : ""}`} aria-label={`Disponível na ${spotlightProvider.name}`} title={`Disponível na ${spotlightProvider.name}`}>
                  {spotlightProviderLogo ? (
                    <img
                      src={spotlightProviderLogo}
                      alt={spotlightProvider.name}
                      referrerPolicy="no-referrer"
                      onError={() => setProviderLogoErrors((current) => ({ ...current, [spotlightProviderLogoKey]: true }))}
                    />
                  ) : spotlightProvider.name}
                </span>
              ) : null}
              <div className="hero-meta-text">
                {spotlightYear && <span className="hero-meta-part">{spotlightYear}</span>}
                <span className="hero-meta-bullet">·</span>
                <span className="hero-meta-part">{featuredSpotlight.item.type === "movie" ? "Filme" : "Série"}</span>
                {spotlightRuntime && (
                  <>
                    <span className="hero-meta-bullet">·</span>
                    <span className="hero-meta-part">{spotlightRuntime}</span>
                  </>
                )}
                {spotlightVote && (
                  <>
                    <span className="hero-meta-bullet">·</span>
                    <span className="hero-meta-part hero-meta-vote">{spotlightVote}</span>
                  </>
                )}
                {spotlightGenres.length > 0 && (
                  <>
                    <span className="hero-meta-bullet">·</span>
                    <span className="hero-meta-part hero-meta-genres">{spotlightGenres.join(" · ")}</span>
                  </>
                )}
              </div>
            </div>
            <a
              className={`hero-title-link${spotlightLogo ? " hero-title-logo-link" : ""}`}
              href={titleHref(
                featuredSpotlight.rail.addonId,
                featuredSpotlight.item.type,
                featuredSpotlight.item.id
              )}
              // Na TV só "Assistir agora", "Minha Lista", "Mais informações" e os indicadores
              // recebem foco dentro do banner — o logo/título não é um botão de ação e não deve
              // ficar no caminho das setas (o foco caía nele e mostrava um quadro em volta).
              tabIndex={tvLayout ? -1 : undefined}
            >
              {spotlightLogo ? (
                <>
                  <img
                    className="hero-logo-img"
                    src={spotlightLogo}
                    alt={featuredSpotlight.item.name}
                    loading="eager"
                    decoding="async"
                    onError={() => {
                      if (featuredSpotlight) {
                        setLogoErrors((cur) => ({ ...cur, [featuredSpotlight.item.id]: true }));
                      }
                    }}
                  />
                  <h1 className="sr-only" id="hero-title">
                    {featuredSpotlight.item.name}
                  </h1>
                </>
              ) : (
                <h1 className="hero-title" id="hero-title">
                  {featuredSpotlight.item.name}
                </h1>
              )}
            </a>
            {spotlightEditorial?.directors.length ? (
              <p className="hero-credits">
                Dirigido por <strong>{spotlightEditorial.directors.slice(0, 2).join(", ")}</strong>
              </p>
            ) : spotlightEditorial?.creators.length ? (
              <p className="hero-credits">
                Criado por <strong>{spotlightEditorial.creators.slice(0, 2).join(", ")}</strong>
              </p>
            ) : spotlightAuthors ? (
              <p className="hero-credits">{spotlightAuthors}</p>
            ) : null}
            {spotlightDescription && (
              <p className="hero-description">{spotlightDescription}</p>
            )}
            <div className="hero-actions">
              <a
                className="btn btn-primary hero-watch-btn"
                id={tvLayout ? "tv-hero-watch" : undefined}
                href={titleHref(
                  featuredSpotlight.rail.addonId,
                  featuredSpotlight.item.type,
                  featuredSpotlight.item.id,
                  { autoplay: true }
                )}
                // Sem os pontos indicadores (saíram do banner na TV), o botão da esquerda vira o
                // "anterior" do carrossel: ← nele, sem mais nada à esquerda dentro do banner,
                // troca de destaque em vez de não fazer nada (ver `tv-navigation.tsx`).
                data-tv-edge-prev={tvLayout ? "" : undefined}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
                {/* "Assistir" sozinho na TV (referência) — no PC/celular continua "Assistir agora". */}
                <span>{tvLayout ? "Assistir" : "Assistir agora"}</span>
              </a>
              {!tvLayout && (
                <button
                  className="btn hero-circle-btn hero-list-btn"
                  type="button"
                  onClick={() => toggleLibrary(featuredSpotlight.item, featuredSpotlight.rail.addonId)}
                  title={isSavedToLibrary(library, featuredSpotlight.item.id, featuredSpotlight.item.type)
                    ? "Remover da minha lista"
                    : "Adicionar à minha lista"}
                  aria-label={isSavedToLibrary(library, featuredSpotlight.item.id, featuredSpotlight.item.type)
                    ? "Remover da minha lista"
                    : "Adicionar à minha lista"}
                >
                  {isSavedToLibrary(library, featuredSpotlight.item.id, featuredSpotlight.item.type) ? "✓" : "+"}
                  <span className="hero-btn-label">Minha Lista</span>
                </button>
              )}
              <a
                className="btn hero-circle-btn hero-info-btn"
                id={tvLayout ? "tv-hero-info" : undefined}
                href={titleHref(
                  featuredSpotlight.rail.addonId,
                  featuredSpotlight.item.type,
                  featuredSpotlight.item.id
                )}
                // Na TV o tooltip só atrapalha (fica em cima do conteúdo, sem mouse pra "passar
                // por cima" antes de clicar); some só ali, mesmo link/destino de sempre.
                title={tvLayout ? undefined : "Mais detalhes sobre a obra"}
                aria-label="Ver mais detalhes"
                // Botão da direita = "próximo" do carrossel pelo mesmo motivo do de cima.
                data-tv-edge-next={tvLayout ? "" : undefined}
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
                {/* Na TV o botão vira uma pílula com texto (referência Netflix); no PC/celular
                    continua só o ícone circular de hoje — mesmo link, mesmo destino. */}
                {tvLayout ? <span className="hero-btn-label">Mais informações</span> : null}
              </a>
            </div>
          </div>
          {/* Decisão do Lucas (rodada de navegação por zonas): os pontos somem no modo TV — o
              autoplay do carrossel continua trocando os destaques sozinho, e sem eles sobram só
              os 3 botões de ação como focáveis dentro do banner (mais simples de navegar). */}
          {spotlightCandidates.length > 1 && !tvLayout && (
            <div className="hero-carousel-controls" aria-label="Destaques em exibição">
              <div className="hero-dots">
                {spotlightCandidates.map(({ item }, index) => {
                  const isActive = index === spotlightIndex;
                  return (
                    <button
                      type="button"
                      className={`hero-dot-circle${isActive ? " active" : ""}`}
                      id={tvLayout ? `tv-hero-dot-${item.type}-${item.id}` : undefined}
                      onClick={() => setSpotlightIndex(index)}
                      aria-label={`Exibir ${item.name}`}
                      aria-current={isActive ? "true" : undefined}
                      key={`${item.type}:${item.id}`}
                    >
                      {isActive ? (
                        <svg className="hero-dot-ring" width="20" height="20" viewBox="0 0 22 22">
                          <circle
                            cx="11"
                            cy="11"
                            r="8"
                            fill="none"
                            stroke="rgba(255, 255, 255, 0.25)"
                            strokeWidth="2"
                          />
                          <circle
                            className="hero-dot-progress"
                            cx="11"
                            cy="11"
                            r="8"
                            fill="none"
                            stroke="#ffffff"
                            strokeWidth="2"
                            strokeDasharray="50.26"
                            strokeDashoffset="50.26"
                          />
                          <circle cx="11" cy="11" r="3" fill="#ffffff" />
                        </svg>
                      ) : (
                        <span className="hero-dot-bullet" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      ) : (
        <section className={`hero hero-default-bg${libraryOnly ? " hero-compact" : ""}`} id="inicio" aria-labelledby="hero-title" data-tv-zone={tvLayout ? "hero" : undefined}>
          <div className="hero-vignette" aria-hidden="true" />
          <div className="hero-content">
            <div className="hero-badge-row">
              <span className="badge-tag">Perfil Ativo</span>
            </div>
            <h1 className="hero-title" id="hero-title">
              {libraryOnly ? "Minha biblioteca" : `Olá, ${profile.name}`}
            </h1>
            <p className="hero-description">
              {libraryOnly
                ? "Os títulos que você guardou para analisar ou assistir depois."
                : "Descubra filmes com contexto, sinopse e recomendações separadas para este perfil."}
            </p>
            {!stremioLinked && (
              <div className="hero-actions">
                <a className="btn btn-primary" href={appPagePath("/configuracoes/stremio")}>
                  Vincular conta Stremio
                </a>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Trilhos e Conteúdo */}
      <div className="rails">
        {!libraryOnly && catalogView === "home" && personalizedItems.length > 0 ? (
          <section className="personalized-showcase" id="recomendado-para-voce" aria-labelledby="personalized-title" data-tv-zone={tvLayout ? "rail" : undefined}>
            <div className="rail-header">
              <div><h2 className="rail-title" id="personalized-title">Recomendado para você</h2></div>
            </div>
            <div className="personalized-showcase-scroll" aria-label="Recomendado para você">
              {personalizedItems.map((item) => (
                <PersonalizedShowcaseCard item={item} key={`personalized:${item.type}:${item.tmdbId}`} />
              ))}
            </div>
          </section>
        ) : null}

        {/* Trilho: Continuar Assistindo (Widescreen 16:9) */}
        {!libraryOnly ? <section className="rail" id="continuar-assistindo" aria-labelledby="continue-title" data-tv-zone={tvLayout ? "rail" : undefined}>
          <div className="rail-header">
            <div>
              <h2 className="rail-title" id="continue-title">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent-gold)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                Continuar
              </h2>
            </div>
          </div>

          {continueItems.length === 0 ? (
            <p className="rail-empty">Quando você iniciar um filme ou episódio, ele aparecerá aqui para retomar de onde parou.</p>
          ) : (
            <RailScrollContainer label="Continuar assistindo">
              {continueItems.map(({ item, next }) => {
                const href = titleHref(metadataAddonForMedia(item.addonId ?? defaultAddonId, item.mediaId), item.mediaType, item.mediaId, {
                  autoplay: true,
                  videoId: item.videoId,
                  next
                });
                return (
                  <ContinueWatchingCard
                    item={item}
                    next={next}
                    href={href}
                    pct={next ? 0 : percentage(item)}
                    onRemove={handleRemoveProgress}
                    key={item.id}
                  />
                );
              })}
            </RailScrollContainer>
          )}
        </section> : null}

        {libraryOnly ? <section className="rail" id="biblioteca" aria-labelledby="library-title" data-tv-zone={tvLayout ? "rail" : undefined}>
          <div className="rail-header"><div><h2 className="rail-title" id="library-title">Minha biblioteca</h2></div></div>
          {library.length === 0 ? (
            <p className="rail-empty">Use o botão + nos destaques para guardar filmes e séries neste perfil.</p>
          ) : (
            <RailScrollContainer label="Minha biblioteca">
              {library.map((item, index) => {
                const catalogItem = libraryItemToCatalogItem(item);
                return (
                  <EditorialCatalogCard
                    addonId={catalogItem.addonId}
                    item={catalogItem}
                    saved
                    tone={TONES[index % TONES.length]}
                    onToggleLibrary={toggleLibrary}
                    railId="biblioteca"
                    key={item.id}
                  />
                );
              })}
            </RailScrollContainer>
          )}
        </section> : null}

        {!libraryOnly && visibleEditorialRails.map((rail) => {
          const isTopTen = /(?:^|-)top10(?:-|$)/.test(rail.id);
          return (
          <Fragment key={`editorial:${rail.id}`}>
          <section className={`rail${isTopTen ? " top-ten-rail" : ""}`} aria-labelledby={`editorial-${rail.id}`} data-tv-zone={tvLayout ? "rail" : undefined}>
            <div className="rail-header"><div><h2 className="rail-title" id={`editorial-${rail.id}`}>{rail.title}</h2></div></div>
            <RailScrollContainer label={rail.title} topTen={isTopTen}>
              {rail.items.slice(0, expandedRails[rail.id] ?? ITENS_POR_PAGINA).map((item, index) => (
                <EditorialDiscoveryCard
                  item={item}
                  rank={isTopTen ? index + 1 : undefined}
                  railId={rail.id}
                  saved={library.some((entry) => (entry.mediaId === `tmdb:${item.tmdbId}` || entry.name.toLowerCase() === item.title.toLowerCase()) && entry.mediaType === item.type)}
                  onToggleLibrary={() => {
                    toggleLibrary({
                      id: `tmdb:${item.tmdbId}`,
                      type: item.type,
                      name: item.title,
                      poster: item.posterUrl,
                      background: item.backdropUrl,
                      releaseInfo: item.year ? String(item.year) : null,
                      description: item.overview
                    }, "tmdb");
                  }}
                  key={`${item.type}:${item.tmdbId}`}
                />
              ))}
              {/* O card fica SEMPRE no fim da trilha enquanto houver o que trazer. Removê-lo
                  era o que fazia a trilha pular para o começo: `.rail-scroll` usa
                  `scroll-snap-type: x proximity` e, ao perder o último filho — ainda com o
                  foco do clique —, o navegador reencaixava no primeiro card. */}
              {(expandedRails[rail.id] ?? ITENS_POR_PAGINA) < rail.items.length ||
               editorialPage < MAX_PAGINAS_EDITORIAIS ? (
                <button
                  className="rail-more-card"
                  type="button"
                  // Na TV o botão não pode ficar `disabled` enquanto busca: o navegador tira o
                  // foco de um botão desativado e o seletor sumia da fileira.
                  disabled={!tvLayout && railLoading === rail.id}
                  aria-disabled={railLoading === rail.id}
                  onClick={(event) => {
                    if (railLoading === rail.id) return;
                    const trilha = event.currentTarget.parentElement;
                    if (tvLayout && trilha) verMaisFocoRef.current = { trilha, posicao: expandedRails[rail.id] ?? ITENS_POR_PAGINA };
                    void verMais(rail.id, rail.items.length);
                  }}
                  aria-label={`Carregar mais títulos de ${rail.title}`}
                >
                  <span aria-hidden="true">{railLoading === rail.id ? "…" : "+"}</span>
                  <small>{railLoading === rail.id ? "Buscando" : "Ver mais"}</small>
                </button>
              ) : null}
            </RailScrollContainer>
          </section>
          {/* Vencedores do Emmy logo abaixo de "Recém-chegados", no desenho do showcase. */}
          {rail.id === "home-new" && emmyWinners ? (
            <section className="personalized-showcase emmy-showcase" id="vencedores-emmy" aria-labelledby="emmy-title" data-tv-zone={tvLayout ? "rail" : undefined}>
              <div className="rail-header">
                <div><h2 className="rail-title" id="emmy-title">Vencedores do {emmyWinners.ceremonyName}</h2></div>
              </div>
              <div className="personalized-showcase-scroll" aria-label={`Vencedores do ${emmyWinners.ceremonyName}`}>
                {emmyWinners.winners.map((winner) => (
                  <EmmyShowcaseCard item={winner} ceremonyName={emmyWinners.ceremonyName} key={`emmy:${winner.type}:${winner.tmdbId}`} />
                ))}
              </div>
            </section>
          ) : null}
          </Fragment>
          );
        })}

        {/* Mensagem se não houver catálogos */}
        {!libraryOnly && stremioLinked && catalogRails.length === 0 && (
          <p className="rail-empty">
            Nenhum catálogo HTTPS compatível respondeu. Você pode consultar novamente sua coleção Stremio nas configurações.
          </p>
        )}

        {/* Trilhos de Catálogos (Posters 2:3) */}
        {!libraryOnly && visibleCatalogRails.map((rail, railIndex) => {
          const label = catalogRailLabel(rail);
          return (
          <section
            className="rail"
            id={`rail-${railIndex}`}
            key={`${rail.addonId}:${rail.catalogId}`}
            aria-labelledby={`catalog-title-${railIndex}`}
            data-tv-zone={tvLayout ? "rail" : undefined}
          >
            <div className="rail-header">
              <div>
                <h2 className="rail-title" id={`catalog-title-${railIndex}`}>
                  {label}
                </h2>
              </div>
            </div>

            <RailScrollContainer label={label}>
              {rail.items.slice(0, 24).map((item, itemIndex) => {
                const tone = TONES[itemIndex % TONES.length];
                const saved = isSavedToLibrary(library, item.id, item.type);
                return (
                  <EditorialCatalogCard
                    addonId={rail.addonId}
                    item={item}
                    saved={saved}
                    tone={tone}
                    onToggleLibrary={toggleLibrary}
                    railId={`${rail.addonId}:${rail.catalogId}`}
                    key={item.id}
                  />
                );
              })}
            </RailScrollContainer>
          </section>
          );
        })}
      </div>
    </main>
  );
}
