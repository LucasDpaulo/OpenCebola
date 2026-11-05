import { classicSections } from "./classics.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { bookTrendsSchema, type Book, type BookTrends } from "@cebola/contracts";
import { fetchBookBytes, type BookFetch } from "./remote.js";

type Section = BookTrends["sections"][number];
export const BRAZIL_RANKING = "https://veja.abril.com.br/vitrine-livros-mais-vendidos/";
export const WORLD_RANKING = "https://openlibrary.org/search.json?q=trending_z_score%3A%7B0%20TO%20*%5D&sort=trending&limit=20&fields=key,title,author_name,cover_i,subject";
const description = {
  brazil: { id: "brazil", title: "Em alta no Brasil", source: "VEJA / BookInfo · Ficção", sourceUrl: BRAZIL_RANKING },
  world: { id: "world", title: "Em alta no mundo", source: "Open Library · Interesse dos leitores", sourceUrl: "https://openlibrary.org/search?q=trending_z_score%3A%7B0+TO+*%5D&sort=trending" }
} as const;
function plain(text: string): string {
  return text.replace(/<[^>]*>/g, " ").replace(/&#(x[0-9a-f]+|\d+);/gi, (_all, code: string) => {
    const point = code[0]?.toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
  }).replace(/&(amp|quot|apos|lt|gt|nbsp);/g, (_all, name: string) => ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " }[name]!)).replace(/\s+/g, " ").trim();
}
export function parseBrazilRanking(html: string): { items: Book[]; period: string } {
  const section = html.split('<section class="vitrine-livros">')[1]?.split('</section>')[0];
  const date = section?.match(/Brasil\s*(?:&nbsp;|\u00a0)?\s*até\s*(\d{2}\/\d{2}\/\d{4})/i)?.[1];
  if (!section || !date) throw new Error("Ranking structure or date unavailable");
  const items: Book[] = [];
  for (const card of section.split('<div class="card">').slice(1)) {
    const rank = Number(card.match(/class="classificacao">\s*(\d+)\s*</)?.[1]);
    if (!rank || rank > 10) continue;
    const title = plain(card.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? "");
    const author = plain(card.match(/class="autor">([\s\S]*?)<\/div>/)?.[1] ?? "");
    const sourceUrl = card.match(/<a href="(https:\/\/veja\.abril\.com\.br\/vitrine-livros-mais-vendidos\/[^"?#]+)"/)?.[1];
    const cover = card.match(/<img\b[^>]*\bsrc="(https:[^"]+)"/)?.[1];
    if (!title || !author || !sourceUrl) continue;
    const coverUrl = cover && /^https:\/\/(?:veja|abril)\.abril\.com\.br\//.test(cover) ? plain(cover) : null;
    items.push({ id: `trend-${createHash("sha256").update(sourceUrl).digest("hex").slice(0, 16)}`, title, authors: [author],
      language: "pt", description: `${rank}º na lista brasileira de ficção da VEJA / BookInfo. Referência: ${date}.`, coverUrl,
      source: "VEJA / BookInfo", sourceUrl, format: "SOURCE", subjects: ["fiction"] });
  }
  const unique = [...new Map(items.map((book) => [book.id, book])).values()];
  if (unique.length < 3) throw new Error("Incomplete ranking");
  return { items: unique.slice(0, 10), period: date };
}
export function parseWorldRanking(data: unknown): Book[] {
  const response = z.object({ docs: z.array(z.object({
    key: z.string().regex(/^\/works\/OL[1-9]\d*W$/), title: z.string().min(1).max(500),
    author_name: z.array(z.string().max(200)).max(20).optional(), cover_i: z.number().int().positive().optional(),
    subject: z.array(z.string()).optional()
  })).max(20) }).parse(data);
  if (!response.docs.length) throw new Error("Empty trending response");
  return response.docs.map((book) => ({ id: `ol-${book.key.split("/").at(-1)}`, title: book.title, authors: book.author_name ?? [],
    language: "", description: "Em destaque por crescimento de interesse na Open Library. Consulte na fonte as edições e os idiomas disponíveis.",
    coverUrl: book.cover_i ? `https://covers.openlibrary.org/b/id/${book.cover_i}-M.jpg` : null,
    source: "Open Library", sourceUrl: `https://openlibrary.org${book.key}`, format: "SOURCE", subjects: book.subject?.slice(0, 30).map((s) => s.slice(0, 200)) }));
}
export class BookTrendingService {
  private cache = new Map<Section["id"], { until: number; section: Section }>();
  private pending = new Map<Section["id"], Promise<Section>>();
  constructor(private readonly fetchBytes: BookFetch = fetchBookBytes, private readonly now = () => Date.now()) {}
  private section(id: "brazil" | "world"): Promise<Section> {
    const cached = this.cache.get(id);
    if (cached && cached.until > this.now()) return Promise.resolve(cached.section);
    const existing = this.pending.get(id);
    if (existing) return existing;
    const work = (async (): Promise<Section> => {
      try {
        const data = await this.fetchBytes(id === "brazil" ? BRAZIL_RANKING : WORLD_RANKING, 2_097_152, id === "brazil" ? "text/html" : "application/json");
        const parsed = id === "brazil" ? parseBrazilRanking(data.toString("utf8")) : { items: parseWorldRanking(JSON.parse(data.toString("utf8"))), period: null };
        const section: Section = { ...description[id], ...parsed, fetchedAt: new Date(this.now()).toISOString(), stale: false, notice: null };
        bookTrendsSchema.parse({ sections: [section] });
        this.cache.set(id, { until: this.now() + 3_600_000, section });
        return section;
      } catch {
        const fetchedAt = cached?.section.fetchedAt;
        if (cached && fetchedAt && this.now() - Date.parse(fetchedAt) < 86_400_000) {
          const section = { ...cached.section, stale: true, notice: "A fonte não respondeu. Exibindo a última consulta, com a data indicada." };
          this.cache.set(id, { until: this.now() + 60_000, section });
          return section;
        }
        const section: Section = { ...description[id], period: null, fetchedAt: null, stale: false, notice: "Esta lista está temporariamente indisponível. Consulte a fonte ou tente novamente em instantes.", items: [] };
        this.cache.set(id, { until: this.now() + 60_000, section });
        return section;
      } finally { this.pending.delete(id); }
    })();
    this.pending.set(id, work);
    return work;
  }
  async list(): Promise<BookTrends> {
    return bookTrendsSchema.parse({ sections: [...await Promise.all([this.section("brazil"), this.section("world")]), ...classicSections()] });
  }
}
