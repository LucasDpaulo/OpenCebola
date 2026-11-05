import { BookTrendingService } from "./trending.js";
import { convertPdf } from "./conversion.js";
import { requireTrustedOrigin } from "../http-origin.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bookCatalogSchema, bookIdSchema, bookQuerySchema } from "@cebola/contracts";
import { AuthenticationError, isAuthenticationError, readRequestSessionToken, type AuthProvider } from "../auth/index.js";
import { BookCatalogService } from "./catalog.js";
import { BookError, fetchBookBytes, type BookFetch } from "./remote.js";
import { epubFilename, MAX_EPUB_BYTES, prepareEpub } from "./epub.js";

export type BookRoutesOptions = { authProvider: AuthProvider; webOrigin?: string; convert?: typeof convertPdf; catalog?: BookCatalogService; fetchBytes?: BookFetch };
export async function registerBookRoutes(app: FastifyInstance, options: BookRoutesOptions): Promise<void> {
  const fetchBytes = options.fetchBytes ?? fetchBookBytes;
  const catalog = options.catalog ?? new BookCatalogService(fetchBytes);
  const trending = new BookTrendingService(fetchBytes);
  let downloading = 0;
  let converting = false;
  await app.register(async (scope) => {
    scope.addHook("preHandler", async (request, reply) => {
      try {
        const credential = readRequestSessionToken(request);
        if (!credential) throw new AuthenticationError();
        await options.authProvider.verifySession(credential.token);
      } catch (error) {
        if (!isAuthenticationError(error)) throw error;
        return reply.code(401).send({ error: { code: "AUTHENTICATION_FAILED", message: "Entre novamente para acessar os livros." } });
      }
    });
    scope.addContentTypeParser("application/pdf", { parseAs: "buffer", bodyLimit: MAX_EPUB_BYTES }, (_request, body, done) => done(null, body));
    scope.post("/v1/books/convert", { bodyLimit: MAX_EPUB_BYTES, config: { rateLimit: { max: 3, timeWindow: "1 minute" } } }, async (request, reply) => {
      if (!requireTrustedOrigin(request, reply, options.webOrigin ?? "", readRequestSessionToken(request)?.source ?? null)) return reply;
      if (!Buffer.isBuffer(request.body)) throw new BookError("BOOK_PDF_INVALID", 400, "Envie um arquivo PDF.");
      if (converting) throw new BookError("BOOK_BUSY", 503, "Há outro PDF sendo preparado. Tente novamente em instantes.");
      converting = true;
      try {
        const epub = await (options.convert ?? convertPdf)(request.body);
        return reply.type("application/epub+zip").header("Content-Disposition", 'attachment; filename="livro.epub"')
          .header("X-Content-Type-Options", "nosniff").send(epub);
      } finally { converting = false; }
    });
    scope.setErrorHandler((error, _request, reply) => {
      if (error && typeof error === "object" && "statusCode" in error && error.statusCode === 413) return reply.code(413).send({ error: { code: "BOOK_TOO_LARGE", message: "O limite é de 25 MB por arquivo." } });
      if (error && typeof error === "object" && "statusCode" in error && error.statusCode === 429) return reply.code(429).send({ error: { code: "BOOK_RATE_LIMIT", message: "Aguarde um minuto antes de tentar novamente." } });
      if (error instanceof BookError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
      return reply.code(502).send({ error: { code: "BOOK_SOURCE_UNAVAILABLE", message: "Não foi possível acessar os livros agora. Tente novamente." } });
    });
    scope.get("/v1/books/trending", async () => trending.list());
    scope.get("/v1/books", async (request, reply) => {
      const query = bookQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "Filtros de livros inválidos." } });
      return bookCatalogSchema.parse(await catalog.list(query.data));
    });
    scope.get("/v1/books/:id/epub", { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (request, reply) => {
      const params = z.object({ id: bookIdSchema }).safeParse(request.params);
      if (!params.success || !z.object({}).strict().safeParse(request.query).success) return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "Livro inválido." } });
      if (downloading >= 2) throw new BookError("BOOK_BUSY", 503, "Estamos preparando outros livros. Tente novamente em instantes.");
      downloading++;
      try {
        const { book, epubUrl } = await catalog.resolve(params.data.id);
        const original = await fetchBytes(epubUrl, MAX_EPUB_BYTES, "application/epub+zip,application/octet-stream");
        const epub = await prepareEpub(original, async () => {
          if (!book.coverUrl) throw new BookError("BOOK_COVER_MISSING", 422, "Este livro ainda não tem uma capa disponível para download.");
          return fetchBytes(book.coverUrl, 5 * 1024 * 1024, "image/jpeg,image/png");
        });
        return reply.type("application/epub+zip")
          .header("Content-Disposition", `attachment; filename="${epubFilename(book.title)}"`)
          .header("X-Content-Type-Options", "nosniff").send(epub);
      } finally { downloading--; }
    });
  });
}
