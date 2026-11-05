import { createHash } from "node:crypto";
import type { Book, BookQuery } from "@cebola/contracts";
import type { BookFetch } from "./remote.js";

const fold = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
export function programmingBooks(markdown: string, language: string): Book[] {
  let subject = "Programação";
  const books = new Map<string, Book>();
  for (const line of markdown.split("\n")) {
    const heading = /^#{3,4} (.+)$/.exec(line);
    if (heading) subject = heading[1]!;
    const link = /^\* \[([^\]]+)\]\((https:\/\/[^\s)]+)\)(.*)$/.exec(line);
    if (!link) continue;
    let url: URL;
    try { url = new URL(link[2]!); } catch { continue; }
    if (url.username || url.password || url.port) continue;
    const id = `dev-${createHash("sha256").update(url.href).digest("hex").slice(0, 16)}`;
    books.set(id, { id, title: link[1]!.slice(0, 500), authors: [], language,
      description: `${subject}. ${link[3]!.replace(/^\s*-\s*/, "")}`.slice(0, 4000),
      coverUrl: null, source: "Free Programming Books", sourceUrl: url.href,
      format: "SOURCE", subjects: ["technology", subject.slice(0, 200)] });
  }
  return [...books.values()];
}

export class DevelopmentCatalog {
  private cache = new Map<string, { until: number; books: Book[] }>();
  private pending = new Map<string, Promise<Book[]>>();
  constructor(private readonly fetchBytes: BookFetch) {}
  private async language(language: "pt" | "en"): Promise<Book[]> {
    const cached = this.cache.get(language);
    if (cached && cached.until > Date.now()) return cached.books;
    const running = this.pending.get(language);
    if (running) return running;
    const task = (async () => {
      try {
        const suffixes = language === "pt" ? ["pt_BR"] : ["langs", "subjects"];
        const documents = await Promise.all(suffixes.map((suffix) => this.fetchBytes(`https://raw.githubusercontent.com/EbookFoundation/free-programming-books/main/books/free-programming-books-${suffix}.md`, 2_097_152, "text/plain")));
        const books = [...new Map(documents.flatMap((data) => programmingBooks(data.toString("utf8"), language)).map((book) => [book.id, book])).values()];
        if (!books.length) throw new Error("Empty programming catalog");
        this.cache.set(language, { until: Date.now() + 3_600_000, books });
        return books;
      } catch (error) { if (cached) return cached.books; throw error; }
      finally { this.pending.delete(language); }
    })();
    this.pending.set(language, task);
    return task;
  }
  async list(query: BookQuery): Promise<Book[]> {
    const languages: ("pt" | "en")[] = query.language === "all" ? ["pt", "en"] : [query.language];
    const results = await Promise.allSettled(languages.map((language) => this.language(language)));
    const books = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    if (!books.length) throw new Error("Programming catalog unavailable");
    return [...new Map(books.map((book) => [book.id, book])).values()].filter((book) =>
      fold(`${book.title} ${book.description}`).includes(fold(query.search)));
  }
}
