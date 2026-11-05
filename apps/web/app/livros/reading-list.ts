import { z } from "zod";
import { bookSchema, bookCategorySchema, type Book, type BookQuery } from "@cebola/contracts";
export const readingStatus = z.enum(["wanted", "reading", "finished"]);
export type ReadingStatus = z.infer<typeof readingStatus>;
const entrySchema = z.object({ book: bookSchema, status: readingStatus, category: bookCategorySchema, updatedAt: z.number().finite() });
export type ReadingEntry = z.infer<typeof entrySchema>;
const key = (profile: string) => `cebola:books:v1:${profile}`;
export function readBooks(profile: string, storage: Pick<Storage, "getItem">): ReadingEntry[] {
  try {
    const parsed = z.array(entrySchema).max(200).safeParse(JSON.parse(storage.getItem(key(profile)) ?? "[]"));
    return parsed.success ? parsed.data : [];
  } catch { return []; }
}
export function updateReading(entries: ReadingEntry[], book: Book, status: ReadingStatus | null, category: BookQuery["category"]): ReadingEntry[] {
  const rest = entries.filter((entry) => entry.book.id !== book.id);
  return status ? [{ book, status, category, updatedAt: Date.now() }, ...rest].slice(0, 200) : rest;
}
export function saveReading(profile: string, entries: ReadingEntry[], storage: Pick<Storage, "setItem">): void {
  storage.setItem(key(profile), JSON.stringify(entries));
}
export function recommendedCategory(entries: ReadingEntry[]): BookQuery["category"] | null {
  const scores = new Map<BookQuery["category"], number>();
  for (const entry of entries) {
    if (entry.status === "finished" || entry.category === "all") continue;
    scores.set(entry.category, (scores.get(entry.category) ?? 0) + (entry.status === "reading" ? 3 : 1));
  }
  return [...scores].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
export function categoryForBook(book: Book, selected: BookQuery["category"]): BookQuery["category"] {
  if (selected !== "all") return selected;
  if (/^(dev-|progit-|eloquent-)/.test(book.id)) return "technology";
  const subjects = (book.subjects ?? []).join(" ").toLowerCase();
  const topics: [RegExp, BookQuery["category"]][] = [[/fantasy|fairy/, "fantasy"], [/detective|mystery/, "mystery"], [/love|romance/, "romance"], [/adventure/, "adventure"], [/poetry/, "poetry"], [/philosophy/, "philosophy"], [/history/, "history"], [/science/, "science"], [/fiction/, "fiction"]];
  return topics.find(([pattern]) => pattern.test(subjects))?.[1] ?? (["gutenberg-67162", "gutenberg-55752", "gutenberg-54829"].includes(book.id) ? "brazil" : "all");
}
