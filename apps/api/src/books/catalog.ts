import { classicDownloads as classics, classicDiscovery } from "./classics.js";
import { DevelopmentCatalog } from "./development.js";
import { z } from "zod";
import type { Book, BookCatalog, BookQuery } from "@cebola/contracts";
import { BookError, bookSourceUrl, fetchBookBytes, type BookFetch } from "./remote.js";

const gutenbergSchema = z.object({
  id: z.number().int().positive().max(9999999), title: z.string().max(500),
  authors: z.array(z.object({ name: z.string().max(200) })).max(20),
  languages: z.array(z.string().max(20)), summaries: z.array(z.string()).optional(),
  formats: z.record(z.string(), z.string()), copyright: z.boolean().nullable(),
  subjects: z.array(z.string()).default([]), media_type: z.string()
});
type Gutenberg = z.infer<typeof gutenbergSchema>;
export type DownloadBook = { book: Book; epubUrl: string };
const tech: DownloadBook = {
  book: {
    id: "eloquent-javascript", title: "Eloquent JavaScript", authors: ["Marijn Haverbeke"], language: "en",
    description: "Uma introdução moderna à programação e ao JavaScript, com exemplos, exercícios e projetos. Quarta edição em EPUB, disponibilizada pelo autor. Texto em inglês.",
    coverUrl: "https://eloquentjavascript.net/img/cover.jpg", source: "Site do autor",
    sourceUrl: "https://eloquentjavascript.net/", format: "EPUB"
  }, epubUrl: "https://eloquentjavascript.net/Eloquent_JavaScript.epub"
};
const technology: DownloadBook[] = [{
  epubUrl: "https://github.com/progit/progit2-pt-br/releases/download/2.1.50/progit.epub",
  book: { id: "progit-pt-br", title: "Pro Git", authors: ["Scott Chacon", "Ben Straub"], language: "pt",
    description: "Da criação do primeiro repositório a branches, colaboração e ferramentas avançadas. Segunda edição, tradução brasileira disponibilizada pelo projeto Pro Git.",
    coverUrl: "https://git-scm.com/images/progit2.png", source: "Projeto Pro Git", sourceUrl: "https://git-scm.com/book/pt-br/v2", format: "EPUB" }
}, tech];


function curated(query: BookQuery): Book[] {
  const normalizeText = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return (query.category === "all" ? [...classics, ...classicDiscovery.map((book) => ({ book })), ...technology] : query.category === "technology" ? technology : query.category === "brazil" || query.category === "romance" ? [...classics, ...classicDiscovery.map((book) => ({ book }))] : [])
    .filter(({ book }) => (query.language === "all" || query.language === book.language) &&
      normalizeText(`${book.title} ${book.authors.join(" ")}`).includes(normalizeText(query.search)))
    .map(({ book }) => book);
}
function safeSource(value: string | undefined): string | null {
  try { return value ? bookSourceUrl(value).href : null; } catch { return null; }
}
function normalize(raw: Gutenberg): DownloadBook | null {
  const epubUrl = safeSource(raw.formats["application/epub+zip"]);
  if (!epubUrl || raw.copyright !== false || raw.media_type !== "Text") return null;
  return { epubUrl, book: {
    id: `gutenberg-${raw.id}`, title: raw.title, authors: raw.authors.map((a) => a.name),
    language: raw.languages[0] ?? "", description: (raw.summaries?.[0] ?? "").replace(/<[^>]*>/g, " ").slice(0, 4000),
    coverUrl: safeSource(raw.formats["image/jpeg"] ?? raw.formats["image/png"]),
    source: "Project Gutenberg", sourceUrl: `https://www.gutenberg.org/ebooks/${raw.id}`, format: "EPUB", subjects: raw.subjects.slice(0, 30).map((s) => s.slice(0, 200))
  } };
}

export class BookCatalogService {
  // Só consultas públicas idênticas em andamento são compartilhadas; nenhum histórico é salvo.
  private pending = new Map<string, Promise<BookCatalog>>();
  private readonly development: DevelopmentCatalog;
  constructor(private readonly fetchBytes: BookFetch = fetchBookBytes) { this.development = new DevelopmentCatalog(fetchBytes); }
  list(query: BookQuery): Promise<BookCatalog> {
    const key = JSON.stringify(query);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const work = this.load(query).finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    return work;
  }
  private async load(query: BookQuery): Promise<BookCatalog> {
    if (query.category === "hot") return {
      items: [], nextPage: null,
      notice: "Ainda não temos romances hot com EPUB gratuito autorizado nas fontes integradas. Explore os romances clássicos disponíveis."
    };
    if (query.category === "technology") {
      let remote: Book[] = [];
      let available = true;
      try { remote = await this.development.list(query); } catch { available = false; }
      const all = [...new Map([...curated(query), ...remote].map((book) => [book.id, book])).values()];
      const start = (query.page - 1) * 32;
      return { items: all.slice(start, start + 32), nextPage: start + 32 < all.length && query.page < 100 ? query.page + 1 : null,
        notice: available ? "Livros e guias da comunidade Free Programming Books. Alguns títulos são lidos ou baixados no site da fonte." : "A fonte ampliada está indisponível. Exibindo a seleção de EPUBs." };
    }
    const url = new URL("https://gutendex.com/books/");
    url.searchParams.set("mime_type", "application/epub+zip");
    url.searchParams.set("copyright", "false");
    url.searchParams.set("languages", query.language === "all" ? "pt,en" : query.language);
    url.searchParams.set("page", String(query.page));
    if (query.search) url.searchParams.set("search", query.search);
    const topic = { all: "", philosophy: "philosophy", brazil: "Brazilian", romance: "love", fiction: "fiction", fantasy: "fantasy", mystery: "detective", history: "history", science: "science", adventure: "adventure", poetry: "poetry" }[query.category];
    if (topic) url.searchParams.set("topic", topic);
    try {
      const response = z.object({ results: z.array(gutenbergSchema).max(32), next: z.string().nullable() })
        .parse(JSON.parse((await this.fetchBytes(url.href, 2_097_152, "application/json")).toString("utf8")));
      const remote = response.results.flatMap((raw) => { const result = normalize(raw); return result ? [result.book] : []; });
      const items = [...new Map([...(query.page === 1 ? curated(query) : []), ...remote].map((book) => [book.id, book])).values()];
      return { items: items.slice(0, 40), nextPage: response.next && query.page < 100 ? query.page + 1 : null,
        notice: "Seleção de clássicos e outros livros gratuitos. Resultados do Gutenberg ordenados pelos downloads na fonte." };
    } catch (error) {
      const items = curated(query);
      if (query.page !== 1 || !items.length) throw error;
      return { items, nextPage: null, notice: "O catálogo ampliado está indisponível no momento. Você ainda pode baixar os livros desta seleção." };
    }
  }
  async resolve(id: string): Promise<DownloadBook> {
    const technical = technology.find(({ book }) => book.id === id);
    if (technical) return technical;
    const selected = classics.find(({ book }) => book.id === id);
    if (selected) return selected;
    const match = /^gutenberg-([1-9]\d{0,6})$/.exec(id);
    if (!match) throw new BookError("BOOK_NOT_FOUND", 404, "Livro não encontrado.");
    const raw = gutenbergSchema.parse(JSON.parse((await this.fetchBytes(`https://gutendex.com/books/${match[1]}/`, 262_144, "application/json")).toString("utf8")));
    if (raw.id !== Number(match[1])) throw new BookError("BOOK_FILE_INVALID", 502, "A fonte retornou outro livro.");
    const result = normalize(raw);
    if (!result) throw new BookError("BOOK_NOT_AVAILABLE", 404, "Este livro não tem um EPUB gratuito disponível.");
    return result;
  }
}
