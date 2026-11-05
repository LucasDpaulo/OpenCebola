import assert from "node:assert/strict";
import test from "node:test";
import { DevelopmentCatalog, programmingBooks } from "../src/books/development.js";
import { BookCatalogService } from "../src/books/catalog.js";
const markdown = '### Python\n* [Livro](https://example.org/book) - Autor (PDF)\n* [Índice](#python)\n* [Inseguro](javascript:alert)\n* [Credenciais](https://user:password@example.org/)';
test("curadoria oferece fontes HTTPS sem tratar links como EPUBs", () => {
  const books = programmingBooks(markdown, "pt");
  assert.equal(books.length, 1);
  assert.equal(books[0]?.format, "SOURCE");
  assert.equal(books[0]?.subjects?.[1], "Python");
  assert.equal(books[0]?.id, programmingBooks(markdown, "pt")[0]?.id);
});
test("catálogo técnico compartilha cache e filtra assunto sem acentos", async () => {
  let calls = 0;
  const catalog = new DevelopmentCatalog(async () => { calls++; return Buffer.from(markdown); });
  const query = { category: "technology", language: "pt", search: "python", page: 1 } as const;
  const [a, b] = await Promise.all([catalog.list(query), catalog.list(query)]);
  assert.equal(a.length, 1); assert.deepEqual(a, b); assert.equal(calls, 1);
  await catalog.list(query); assert.equal(calls, 1);
});
test("categorias ampliadas passam assunto ao Gutenberg", async () => {
  const service = new BookCatalogService(async (url) => {
    assert.equal(new URL(url).searchParams.get("topic"), "detective");
    return Buffer.from(JSON.stringify({ results: [], next: null }));
  });
  assert.deepEqual((await service.list({ category: "mystery", language: "pt", search: "", page: 1 })).items, []);
});
