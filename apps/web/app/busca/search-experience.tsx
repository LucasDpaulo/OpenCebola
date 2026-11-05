"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { LibraryItem } from "@cebola/contracts";
import { BrandIcon } from "../brand-icon";
import { apiFetch, appPagePath } from "../api-client";
import { applyLibraryChange } from "../library-client";
import {
  buildRecommendationSignals,
  EditorialCatalogCard,
  isCatalogItem,
  isHomeBootstrap,
  isSavedToLibrary,
  PersonalizedShowcaseCard,
  TONES,
  type CatalogItem
} from "../home-experience";
import { loadPersonalizedRecommendations, type PersonalizedRecommendation } from "../personalized-recommendations";
import {
  clampSearchQuery,
  isSearchableQuery,
  parseSearchQueryParam,
  SearchResultsCache
} from "../search-query";
import styles from "./search.module.css";

// Mesmo tempo de "pausa" usado em outras buscas ao vivo do produto (debounce ~350ms): rápido o
// bastante para parecer instantâneo, devagar o bastante para não gastar uma chamada por tecla.
const DEBOUNCE_MS = 350;

type SearchResultItem = CatalogItem & { addonId: string };
type SearchStatus = "idle" | "loading" | "ready" | "error";
/** Aviso de biblioteca acionável: mesma forma usada na home (ver `LibraryNotice` em home-experience.tsx). */
type LibraryNotice = { readonly message: string; readonly retry?: () => void };

/**
 * Sincroniza `?q=` na URL sem empilhar histórico (troca de letra em letra não deveria virar uma
 * pilha de "Voltar" inútil) e sem depender do router do Next: a tela de título usa `<a href>`
 * puro (export estático), então voltar dela para cá é uma navegação de página inteira — só a URL
 * sobrevive a isso, e é dela que a busca é restaurada ao montar de novo.
 */
function syncSearchQueryParam(query: string): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (query) url.searchParams.set("q", query);
  else url.searchParams.delete("q");
  url.searchParams.delete("search");
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    window.history.replaceState(null, "", next);
  }
}

export function SearchExperience() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Só a consulta que já estava na URL ao abrir a tela importa aqui — o campo passa a mandar
  // nele mesmo a partir da primeira letra digitada pela pessoa. `useState`/`useRef` abaixo usam
  // este valor só na primeira renderização; recalculá-lo depois (barato, função pura) não afeta
  // nada disso.
  const initialQuery = parseSearchQueryParam(searchParams);
  const [inputValue, setInputValue] = useState(initialQuery);
  const [status, setStatus] = useState<SearchStatus>(isSearchableQuery(initialQuery) ? "loading" : "idle");
  const [items, setItems] = useState<readonly SearchResultItem[]>([]);
  const [library, setLibrary] = useState<readonly LibraryItem[]>([]);
  const [libraryNotice, setLibraryNotice] = useState<LibraryNotice | null>(null);
  const [stremioLinked, setStremioLinked] = useState(false);
  const [bootstrapReady, setBootstrapReady] = useState(false);
  const [personalizedItems, setPersonalizedItems] = useState<readonly PersonalizedRecommendation[]>([]);
  const cacheRef = useRef(new SearchResultsCache<readonly SearchResultItem[]>());
  const controllerRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // A consulta vinda da URL já é uma pesquisa "pronta" (a pessoa voltou de um título, recarregou
  // a página…) — ela não deve esperar o debounce de digitação como se fosse letra nova.
  const skipNextDebounceRef = useRef(isSearchableQuery(initialQuery));

  // Foco automático ao abrir a tela (estilo HBO Max). Em TV isto só move o foco do controle
  // remoto para o campo — o teclado na tela só aparece quando a pessoa confirma o campo, o
  // navegador/WebView decide isso sozinho; nada aqui força esse teclado a aparecer.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => () => controllerRef.current?.abort(), []);

  /**
   * Adiciona/remove da biblioteca a partir de um card da grade — mesma lógica otimista com
   * reversão da home (ver `toggleLibrary` em home-experience.tsx); duplicada aqui porque cada
   * tela guarda seu próprio estado de biblioteca (não há um único componente pai comum).
   */
  const toggleLibrary = useCallback((item: CatalogItem, addonId: string) => {
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
  }, [library]);

  // Estado da conta (biblioteca, vínculo Stremio) para os cards da grade e, com a busca vazia,
  // para montar "Recomendados para você" com os mesmos sinais que a home usa.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const response = await apiFetch(`/v1/home/bootstrap`, {
          cache: "no-store",
          headers: { Accept: "application/json" }
        });
        if (response.status === 401) {
          router.replace("/entrar");
          return;
        }
        if (!response.ok) throw new Error("bootstrap unavailable");
        const body = (await response.json()) as unknown;
        if (!alive || !isHomeBootstrap(body)) return;
        setLibrary(body.library.items);
        setStremioLinked(body.stremio.linked);
        if (!isSearchableQuery(initialQuery)) {
          const signals = buildRecommendationSignals(body.library.items, body.progress.items);
          const recommendations = await loadPersonalizedRecommendations(signals);
          if (alive) setPersonalizedItems(recommendations);
        }
      } catch {
        // Sem recomendações ou sem saber se a conta está vinculada, a busca em si continua
        // funcionando — só a fileira de "vazio" fica mais pobre.
      } finally {
        if (alive) setBootstrapReady(true);
      }
    })();
    return () => { alive = false; };
    // Roda só uma vez: `initialQuery` é fixa na montagem, e trocar a busca depois não deveria
    // refazer todo o bootstrap da conta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  const runSearch = useCallback(async (query: string) => {
    const cached = cacheRef.current.get(query);
    if (cached) {
      setItems(cached);
      setStatus("ready");
      return;
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setStatus("loading");
    try {
      const response = await apiFetch(`/v1/stremio/search?q=${encodeURIComponent(query)}`, {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
      if (response.status === 401) {
        router.replace("/entrar");
        return;
      }
      if (!response.ok) throw new Error("search unavailable");
      const body = (await response.json()) as { items?: unknown };
      if (!Array.isArray(body.items)) throw new Error("invalid search");
      const parsed = body.items.flatMap((value): SearchResultItem[] =>
        isCatalogItem(value) && typeof (value as Partial<SearchResultItem>).addonId === "string"
          ? [value as SearchResultItem]
          : []
      );
      cacheRef.current.set(query, parsed);
      setItems(parsed);
      setStatus("ready");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setStatus("error");
    }
  }, [router]);

  // Debounce + sincronização da URL num único efeito: a cada letra a URL já reflete o campo (não
  // empilha histórico, ver `syncSearchQueryParam`), e só a busca de verdade espera o debounce —
  // exceto a consulta que já veio pronta da URL ao montar, disparada na hora.
  useEffect(() => {
    const normalized = clampSearchQuery(inputValue);
    syncSearchQueryParam(normalized);
    if (!isSearchableQuery(normalized)) {
      controllerRef.current?.abort();
      setStatus("idle");
      setItems([]);
      return;
    }
    if (skipNextDebounceRef.current) {
      skipNextDebounceRef.current = false;
      void runSearch(normalized);
      return;
    }
    const timer = window.setTimeout(() => void runSearch(normalized), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [inputValue, runSearch]);

  const clear = useCallback(() => {
    setInputValue("");
    inputRef.current?.focus();
  }, []);

  const normalizedQuery = clampSearchQuery(inputValue);
  const searching = isSearchableQuery(normalizedQuery);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <a className={styles.brand} href="/" aria-label="Início">
          <BrandIcon size={30} className={styles.brandIcon} />
        </a>
        <form className={styles.searchForm} role="search" onSubmit={(event) => event.preventDefault()}>
          <span className={styles.searchIcon} aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </span>
          <input
            ref={inputRef}
            type="search"
            inputMode="search"
            value={inputValue}
            onChange={(event) => setInputValue(event.target.value)}
            placeholder="Encontre filmes e séries"
            aria-label="Buscar filmes e séries"
            maxLength={100}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {inputValue ? (
            <button type="button" className={styles.clearButton} onClick={clear} aria-label="Limpar busca">
              ✕
            </button>
          ) : null}
        </form>
      </header>

      <div className={styles.content}>
        {bootstrapReady && !stremioLinked ? (
          <p className={styles.linkNotice}>
            Vincule sua conta Stremio para buscar no seu catálogo.
            <a className="btn btn-primary" href={appPagePath("configuracoes/stremio")}>Vincular conta</a>
          </p>
        ) : null}

        {searching ? (
          <section aria-labelledby="busca-resultados-title">
            <div className="rail-header">
              <h1 id="busca-resultados-title" className="rail-title">Resultados da busca</h1>
              {status === "loading" ? (
                <span className={styles.loadingHint} role="status" aria-live="polite">Buscando…</span>
              ) : null}
            </div>

            {status === "error" ? (
              <div className={styles.stateBanner} role="alert">
                <p>Não foi possível pesquisar agora.</p>
                <button type="button" className="btn btn-primary" onClick={() => void runSearch(normalizedQuery)}>
                  Tentar novamente
                </button>
              </div>
            ) : status === "ready" && items.length === 0 ? (
              <p className={styles.stateBanner}>Nenhum filme ou série encontrado para “{normalizedQuery}”.</p>
            ) : items.length > 0 ? (
              <div className={styles.grid}>
                {items.map((item, index) => (
                  <div className={styles.card} key={`${item.type}:${item.id}`}>
                    <EditorialCatalogCard
                      addonId={item.addonId}
                      item={item}
                      saved={isSavedToLibrary(library, item.id, item.type)}
                      tone={TONES[index % TONES.length]}
                      onToggleLibrary={toggleLibrary}
                    />
                    <p className={styles.cardCaption}>
                      <span className={styles.cardTitle}>{item.name}</span>
                      <span className={styles.cardMeta}>
                        {item.releaseInfo ?? (item.type === "movie" ? "Filme" : "Série")}
                      </span>
                    </p>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        ) : personalizedItems.length > 0 ? (
          <section className="personalized-showcase" aria-labelledby="busca-recomendados-title">
            <div className="rail-header">
              <h1 id="busca-recomendados-title" className="rail-title">Recomendados para você</h1>
            </div>
            <div className="personalized-showcase-scroll" aria-label="Recomendados para você">
              {personalizedItems.map((item) => (
                <PersonalizedShowcaseCard item={item} key={`personalized:${item.type}:${item.tmdbId}`} />
              ))}
            </div>
          </section>
        ) : bootstrapReady ? (
          <p className={styles.emptyHint}>Digite ao menos 2 letras para buscar filmes e séries.</p>
        ) : null}
      </div>

      {libraryNotice ? (
        <div className={styles.notice} role="alert">
          <span>{libraryNotice.message}</span>
          {libraryNotice.retry ? (
            <button type="button" onClick={libraryNotice.retry}>Tentar novamente</button>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}
