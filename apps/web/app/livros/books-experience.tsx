"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authSessionResponseSchema, bookTrendsSchema, bookCatalogSchema, type BookTrends, type Book, type BookQuery } from "@cebola/contracts";
import { apiFetch, appPagePath } from "../api-client";
import { BrandIcon } from "../brand-icon";
import { useMobileBooks } from "./use-mobile-books";
import { saveBook, sendBookToKindle, kindleNotice } from "./download";
import { readBooks, saveReading, updateReading, categoryForBook, type ReadingEntry, type ReadingStatus } from "./reading-list";
import { PdfImport } from "./pdf-import";
import styles from "./books.module.css";

const categories: [BookQuery["category"], string][] = [["all", "Todos"], ["technology", "Tecnologia"], ["philosophy", "Filosofia"], ["brazil", "Brasileiros"], ["romance", "Romance"], ["fiction", "Ficção"], ["fantasy", "Fantasia"], ["mystery", "Mistério"], ["history", "História"], ["science", "Ciência"], ["adventure", "Aventura"], ["poetry", "Poesia"], ["hot", "Hot"]];
const sections = [["", "Início"], ["movies", "Filmes"], ["series", "Séries"], ["documentaries", "Documentários"], ["anime", "Anime"], ["brazil", "Brasil"]];
const languageName = (language: string) => language === "pt" ? "Português" : language === "en" ? "Inglês" : language || "Edições na fonte";

function BookIcon({ kind = "book" }: { kind?: "book" | "search" | "download" | "close" | "arrow" | "filter" }) {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "book" && <><path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Z" /><path d="M12 5v15" /></>}
    {kind === "search" && <><circle cx="10.5" cy="10.5" r="7" /><path d="m16 16 5 5" /></>}
    {kind === "download" && <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /></>}
    {kind === "close" && <path d="m6 6 12 12M6 18 18 6" />}
    {kind === "filter" && <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="2" fill="currentColor" /><circle cx="15" cy="17" r="2" fill="currentColor" /></>}
    {kind === "arrow" && <path d="m9 5 7 7-7 7" />}
  </svg>;
}

function Cover({ book }: { book: Book }) {
  const [failed, setFailed] = useState(false);
  return <span className={styles.cover}>
    <span className={styles.coverFallback} aria-hidden="true"><BookIcon /><span>{book.title}</span><small>{book.authors[0]}</small></span>
    {book.coverUrl && !failed && <img src={book.coverUrl} alt={`Capa de ${book.title}`} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />}
  </span>;
}

async function responseError(response: Response): Promise<string> {
  if (response.status === 401) {
    window.location.assign(appPagePath("/entrar"));
    return "Sua sessão expirou. Entre novamente.";
  }
  if (response.status === 429) return "Muitos pedidos em sequência. Aguarde um minuto e tente novamente.";
  try {
    const body = await response.json() as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") return body.error.message;
  } catch { /* Resposta sem JSON: mensagem local. */ }
  return "Não foi possível concluir. Verifique a conexão e tente novamente.";
}

function BookDetails({ book, onClose, status, onStatus }: { book: Book; onClose: () => void; status?: ReadingStatus; onStatus: (status: ReadingStatus | null) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const node = dialog.current!;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    node.showModal();
    return () => { request.current?.abort(); node.close(); document.body.style.overflow = previousOverflow; };
  }, []);

  async function download(kindle = true) {
    if (busy) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setNotice(null); setError(null);
    try {
      const response = await apiFetch(`/v1/books/${book.id}/epub`, { signal: controller.signal });
      if (!response.ok) throw new Error(await responseError(response));
      if (!response.headers.get("content-type")?.startsWith("application/epub+zip")) throw new Error("O arquivo recebido não é um EPUB. Tente novamente.");
      const blob = await response.blob();
      if (blob.size === 0 || blob.size > 25 * 1024 * 1024) throw new Error("O arquivo ultrapassa o limite de 25 MB ou está vazio.");
      const result = kindle ? await sendBookToKindle(blob, book.title) : await saveBook(blob, book.title);
      if (!controller.signal.aborted) setNotice(kindle ? kindleNotice(result) : "EPUB salvo ou download iniciado. Confira o local escolhido.");
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Não foi possível baixar o livro.");
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="book-detail-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={styles.sheet}>
      <div className={styles.sheetTop}><span className={styles.handle} /><button type="button" className={styles.iconButton} onClick={onClose} aria-label="Fechar detalhes"><BookIcon kind="close" /></button></div>
      <div className={styles.detailHeader}>
        <Cover book={book} />
        <div><span className={styles.badge}>{book.format === "EPUB" ? "EPUB" : "Na fonte"}</span><h2 id="book-detail-title">{book.title}</h2><p>{book.authors.join(", ") || "Autoria não informada"}</p><small>{languageName(book.language)}</small></div>
      </div>
      {book.description && <p className={styles.description}>{book.description}</p>}
      <a className={styles.source} href={book.sourceUrl} target="_blank" rel="noopener noreferrer">Ver na fonte · {book.source} ↗</a>
      <div className={styles.categories} role="group" aria-label="Sua leitura">
        {([["wanted", "Quero ler"], ["reading", "Lendo"], ["finished", "Lido"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={status === value} onClick={() => onStatus(status === value ? null : value)}>{label}</button>)}
      </div>
      {book.format === "EPUB" ? <>
      <div className={styles.format}><BookIcon /><span><strong>EPUB com capa</strong><small>Texto ajustável para uma leitura confortável</small></span><span aria-hidden="true">✓</span></div>
      <button type="button" className={styles.download} onClick={() => void download()} disabled={busy} aria-busy={busy}>
        {busy ? <span className={styles.spinner} /> : <BookIcon />}{busy ? "Preparando EPUB…" : "Ler no Kindle"}
      </button>
      <p className={styles.downloadHint}>Confirme o envio no Kindle para adicionar o livro à sua biblioteca.</p>
      <button type="button" className={styles.back} disabled={busy} onClick={() => void download(false)}>Salvar EPUB no celular</button>
      {notice && <p className={styles.success} role="status">{notice}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      <details className={styles.kindle}>
        <summary><BookIcon /><span>Como ler no Kindle</span><span aria-hidden="true">+</span></summary>
        <ol><li>No Android, toque em Ler no Kindle e confirme no aplicativo da Amazon.</li><li>Abra <a href="https://www.amazon.com/sendtokindle" target="_blank" rel="noopener noreferrer">Enviar para Kindle</a> e entre na conta do seu Kindle.</li><li>Escolha o arquivo baixado e envie. Conecte o Kindle ao Wi-Fi para recebê-lo.</li></ol>
        <p>O serviço da Amazon converte o EPUB. A miniatura da capa na biblioteca depende também do aparelho e desse processamento.</p>
      </details>
      </> : <p className={styles.notice}>Este registro é para descoberta. Não há EPUB disponível pelo Cebola para este título. Use “Ver na fonte” para consultar as edições e opções de acesso.</p>}
      <button type="button" className={styles.back} onClick={onClose}>Voltar para a biblioteca</button>
    </div>
  </dialog>;
}

function TrendingBooks({ onSelect }: { onSelect: (book: Book) => void }) {
  const [data, setData] = useState<BookTrends | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    void (async () => {
      try {
        const response = await apiFetch("/v1/books/trending", { signal: controller.signal });
        if (!response.ok) throw new Error("trends unavailable");
        const result = bookTrendsSchema.parse(await response.json());
        if (!controller.signal.aborted) setData(result);
      } catch { if (!controller.signal.aborted) setError(true); }
    })();
    return () => controller.abort();
  }, [revision]);
  if (error) return <div className={styles.notice} role="status">Não foi possível consultar os livros em alta. <button type="button" className={styles.back} onClick={() => setRevision((value) => value + 1)}>Tentar novamente</button></div>;
  if (!data) return <p className={styles.notice} role="status">Buscando livros em alta no Brasil e no mundo…</p>;
  return <div>{data.sections.map((section) => <section key={section.id} className={styles.trendSection} aria-label={section.title}>
    <div className={styles.listHeading}><h2>{section.title}</h2></div>
    {section.notice && <p className={styles.notice} role="status">{section.notice}</p>}
    {!!section.items.length && <ul className={styles.trendRail}>{section.items.map((book) => <li key={book.id}><button type="button" onClick={() => onSelect(book)} aria-label={`Ver detalhes de ${book.title}`}>
      <Cover book={book} /><span className={styles.bookTitle}>{book.title}</span><span className={styles.author}>{book.authors.join(", ")}</span>
    </button></li>)}</ul>}
  </section>)}</div>;
}

export function BooksExperience() {
  const mobile = useMobileBooks();
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [category, setCategory] = useState<BookQuery["category"]>("all");
  const [language, setLanguage] = useState<BookQuery["language"]>("pt");
  const [items, setItems] = useState<Book[]>([]);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<Book | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [reading, setReading] = useState<ReadingEntry[]>([]);
  const [shelf, setShelf] = useState<ReadingStatus | null>(null);
  const showTrending = !shelf && category === "all" && !search.trim() && language === "pt";
  const [storageError, setStorageError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const activeNav = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (!mobile) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await apiFetch("/v1/auth/session", { signal: controller.signal });
        if (!response.ok) throw new Error(await responseError(response));
        const session = authSessionResponseSchema.parse(await response.json());
        if (controller.signal.aborted) return;
        setProfileId(session.activeProfileId);
        if (session.activeProfileId) setReading(readBooks(session.activeProfileId, localStorage));
      } catch { if (!controller.signal.aborted) setStorageError("Não foi possível carregar seu perfil de leitura. Reabra a página para tentar novamente."); }
    })();
    return () => controller.abort();
  }, [mobile]);
  function mark(book: Book, status: ReadingStatus | null) {
    if (!profileId) { setStorageError("Selecione um perfil para salvar sua lista de leitura."); return; }
    const next = updateReading(reading, book, status, categoryForBook(book, category));
    try { saveReading(profileId, next, localStorage); setReading(next); setStorageError(null); }
    catch { setStorageError("Não foi possível salvar neste celular. Verifique o armazenamento do navegador."); }
  }

  useEffect(() => { if (mobile) activeNav.current?.scrollIntoView({ block: "nearest", inline: "end" }); }, [mobile]);
  useEffect(() => { const close = () => setSelected(null); window.addEventListener("popstate", close); return () => window.removeEventListener("popstate", close); }, []);
  const closeDetails = useCallback(() => {
    setSelected(null);
    if (window.location.hash.startsWith("#livro-")) window.history.back();
  }, []);
  function openDetails(book: Book) {
    window.history.pushState(null, "", `#livro-${book.id}`);
    setSelected(book);
  }

  const load = useCallback(async (page: number, signal: AbortSignal) => {
    try {
      const query = new URLSearchParams({ search: search.trim(), category, language, page: String(page) });
      const response = await apiFetch(`/v1/books?${query}`, { signal });
      if (!response.ok) throw new Error(await responseError(response));
      const result = bookCatalogSchema.parse(await response.json());
      if (signal.aborted) return;
      setItems((previous) => page === 1 ? result.items : [...new Map([...previous, ...result.items].map((book) => [book.id, book])).values()]);
      setNextPage(result.nextPage); setNotice(result.notice); setError(null);
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error && cause.name !== "ZodError" ? cause.message : "Não foi possível carregar os livros. Tente novamente.");
    } finally { if (!signal.aborted) { setLoading(false); setLoadingMore(false); } }
  }, [category, language, search]);

  useEffect(() => {
    request.current?.abort();
    if (!mobile || shelf || showTrending) { setLoading(false); setLoadingMore(false); setItems([]); setError(null); setNextPage(null); return; }
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setLoadingMore(false); setItems([]); setError(null); setNotice(null); setNextPage(null);
    const timer = window.setTimeout(() => void load(1, controller.signal), search ? 350 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [mobile, load, revision, search, shelf, showTrending]);

  function more() {
    if (!nextPage || loadingMore) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoadingMore(true); setError(null); void load(nextPage, controller.signal);
  }

  if (!mobile) return <main className={styles.unavailable}><BookIcon /><h1>Livros no celular</h1><p>Abra o Cebola no celular para explorar a biblioteca e baixar seus EPUBs.</p><a href="/">Voltar ao início</a></main>;

  return <main className={styles.page}>
    <header className={styles.header}>
      <div className={styles.brandRow}><a href="/" aria-label="Início do Cebola"><BrandIcon size={30} /></a><span>Biblioteca</span><BookIcon /></div>
      <nav className={styles.nav} aria-label="Navegação principal">
        {sections.map(([id, title]) => <a key={title} href={id ? `/?catalog=${id}` : "/"}>{title}</a>)}
        <a href={appPagePath("/livros")} ref={activeNav} aria-current="page">Livro</a>
      </nav>
    </header>
    <div className={styles.content}>
      <div className={styles.bookToolbar}>
        <h1>{shelf === "reading" ? "Lendo" : shelf === "wanted" ? "Quero ler" : shelf === "finished" ? "Lidos" : "Explorar"}</h1>
        <div className={styles.toolbarActions}>
          <button type="button" className={styles.toolbarIcon} aria-label={searchOpen ? "Fechar busca" : "Buscar livros"} aria-expanded={searchOpen} aria-controls="books-search-panel" onClick={() => { setSearchOpen(!searchOpen); if (searchOpen) setSearch(""); }}><BookIcon kind={searchOpen ? "close" : "search"} /></button>
          <button type="button" className={styles.filterToggle} aria-expanded={filtersOpen} aria-controls="books-filter-panel" onClick={() => setFiltersOpen(!filtersOpen)}><BookIcon kind="filter" /><span>Filtros{category !== "all" || language !== "pt" || shelf ? " •" : ""}</span></button>
        </div>
      </div>
      {searchOpen && <form id="books-search-panel" className={styles.search} role="search" onSubmit={(event) => event.preventDefault()}>
        <BookIcon kind="search" /><label className={styles.srOnly} htmlFor="book-search">Buscar por título ou autor</label>
        <input autoFocus id="book-search" type="search" value={search} maxLength={120} placeholder="Buscar por título ou autor" onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setSearch(""); setSearchOpen(false); } }} />
      </form>}
      {filtersOpen && <section id="books-filter-panel" className={styles.filterPanel} aria-label="Filtros da biblioteca">
        <label>Estante<select aria-label="Estante" value={shelf ?? "all"} onChange={(event) => setShelf(event.target.value === "all" ? null : event.target.value as ReadingStatus)}><option value="all">Explorar todos</option><option value="reading">Lendo</option><option value="wanted">Quero ler</option><option value="finished">Lidos</option></select></label>
        {!shelf && <>
          <label>Categoria<select aria-label="Categoria" value={category} onChange={(event) => setCategory(event.target.value as BookQuery["category"])}>{categories.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label>
          <label>Idioma<select aria-label="Idioma" value={language} onChange={(event) => setLanguage(event.target.value as BookQuery["language"])}><option value="pt">Português</option><option value="all">Todos os idiomas</option><option value="en">Inglês</option></select></label>
        </>}
        <div className={styles.filterActions}><button type="button" className={styles.back} onClick={() => { setShelf(null); setCategory("all"); setLanguage("pt"); }}>Limpar filtros</button><button type="button" className={styles.more} onClick={() => setFiltersOpen(false)}>Ver livros</button></div>
        <PdfImport />
      </section>}
      {storageError && <p role="alert" className={styles.error}>{storageError}</p>}
      {showTrending && <TrendingBooks onSelect={openDetails} />}
      {shelf ? <section aria-label="Livros da sua estante">
        <ul className={styles.books}>{reading.filter((entry) => entry.status === shelf && `${entry.book.title} ${entry.book.authors.join(" ")}`.toLowerCase().includes(search.toLowerCase())).map(({ book }) => <li key={book.id}><button type="button" className={styles.book} onClick={() => openDetails(book)}><Cover book={book} /><span className={styles.bookCopy}><span className={styles.bookTitle}>{book.title}</span><span className={styles.author}>{book.authors.join(", ")}</span></span></button></li>)}</ul>
        {!reading.some((entry) => entry.status === shelf) && <p className={styles.notice}>Abra um livro e marque sua leitura para montar esta estante.</p>}
      </section> : !showTrending && <>
      {loading ? <div role="status" aria-label="Carregando livros" className={styles.skeletons}>{[1, 2, 3].map((id) => <div key={id} className={styles.skeleton} aria-hidden="true"><span /><div><i /><i /><i /></div></div>)}</div> : <>
        {notice?.includes("indisponível") && <p className={styles.notice} role="status">{notice}</p>}
        {!!items.length && <ul className={styles.books}>{items.map((book) => <li key={book.id}>
          <button type="button" className={styles.book} onClick={() => openDetails(book)} aria-label={`Ver detalhes de ${book.title}`}>
            <Cover book={book} /><span className={styles.bookCopy}><span className={styles.badge}>{book.format === "EPUB" ? "EPUB" : "Na fonte"} · {languageName(book.language)}</span><span className={styles.bookTitle}>{book.title}</span><span className={styles.author}>{book.authors.join(", ")}</span>{book.description && <span className={styles.teaser}>{book.description}</span>}<span className={styles.bookAction}>Ver livro <BookIcon kind="arrow" /></span></span>
          </button>
        </li>)}</ul>}
        {!items.length && !error && <div className={styles.empty}><BookIcon /><h3>{category === "hot" ? "Ainda sem títulos disponíveis" : "Nenhum livro encontrado"}</h3><p>{category === "hot" ? "Você pode explorar os romances clássicos nas outras estantes." : "Experimente outro título, autor ou idioma."}</p>{language === "pt" && category !== "hot" && <button type="button" onClick={() => setLanguage("all")}>Ver todos os idiomas</button>}</div>}
        {error && <div className={styles.error} role="alert"><p>{error}</p><button type="button" onClick={() => items.length && nextPage ? more() : setRevision((value) => value + 1)}>Tentar novamente</button></div>}
        {nextPage && !error && <button type="button" className={styles.more} onClick={more} disabled={loadingMore}>{loadingMore ? "Carregando…" : "Explorar mais livros"}</button>}
      </>}
      </>}
    </div>
    {selected && <BookDetails key={selected.id} book={selected} onClose={closeDetails} status={reading.find((entry) => entry.book.id === selected.id)?.status} onStatus={(status) => mark(selected, status)} />}
  </main>;
}
