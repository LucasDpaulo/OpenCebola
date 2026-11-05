import { z } from "zod";

export const bookCategorySchema = z.enum(["all", "technology", "philosophy", "brazil", "romance", "hot", "fiction", "fantasy", "mystery", "history", "science", "adventure", "poetry"]);
export const bookQuerySchema = z.object({
  search: z.string().trim().max(120).default(""),
  category: bookCategorySchema.default("all"),
  language: z.enum(["all", "pt", "en"]).default("pt"),
  page: z.coerce.number().int().min(1).max(100).default(1)
}).strict();
export const bookIdSchema = z.string().regex(/^(gutenberg-[1-9]\d{0,6}|eloquent-javascript|progit-pt-br|dev-[a-f0-9]{16}|trend-[a-f0-9]{16}|ol-OL[1-9]\d*W)$/);
export const bookSchema = z.object({
  id: bookIdSchema,
  title: z.string().max(500),
  authors: z.array(z.string().max(200)).max(20),
  language: z.string().max(20),
  description: z.string().max(4000),
  coverUrl: z.string().url().nullable(),
  source: z.string().max(100),
  sourceUrl: z.string().url(),
  format: z.enum(["EPUB", "SOURCE"]),
  subjects: z.array(z.string().max(200)).max(30).optional()
});
export const bookCatalogSchema = z.object({
  items: z.array(bookSchema).max(40),
  nextPage: z.number().int().positive().nullable(),
  notice: z.string().max(500).nullable()
});
export type Book = z.infer<typeof bookSchema>;
export type BookQuery = z.infer<typeof bookQuerySchema>;
export type BookCatalog = z.infer<typeof bookCatalogSchema>;

export const bookTrendsSchema = z.object({
  sections: z.array(z.object({
    id: z.enum(["brazil", "world", "classics-brazil", "classics-northeast"]), title: z.string(), source: z.string(), sourceUrl: z.string().url(),
    period: z.string().nullable(), fetchedAt: z.string().datetime().nullable(), stale: z.boolean(),
    notice: z.string().nullable(), items: z.array(bookSchema).max(20)
  })).max(4)
});
export type BookTrends = z.infer<typeof bookTrendsSchema>;
