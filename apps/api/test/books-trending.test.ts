import assert from "node:assert/strict";
import test from "node:test";
import { BookTrendingService, parseBrazilRanking, parseWorldRanking } from "../src/books/trending.js";
import { bookTrendsSchema } from "@cebola/contracts";
const card = (n: number) => `<div class="card"><a href="https://veja.abril.com.br/vitrine-livros-mais-vendidos/book-${n}/"><div class="classificacao">${n}</div><img src="https://veja.abril.com.br/cover.jpg?x=1&#038;y=2"></a><h3>Livro ${n} &amp; teste</h3><div class="autor">Autora</div>`;
const html = `<section class="vitrine-livros"><p>Os livros mais vendidos no Brasil até 23/10/2026</p>${[1,2,3].map(card).join("")}<div class="card"><h3>Livro fora do ranking</h3></section>`;
const world = { docs: [{ key: "/works/OL123W", title: "A book", author_name: ["Author"], cover_i: 123 }] };
test("Brasil exige ranking, data e links da fonte; mantém metadados sem prometer EPUB", () => {
  const data = parseBrazilRanking(html);
  assert.equal(data.period, "23/10/2026");
  assert.equal(data.items.length, 3);
  assert.equal(data.items[0]?.title, "Livro 1 & teste");
  assert.equal(data.items[0]?.coverUrl, "https://veja.abril.com.br/cover.jpg?x=1&y=2");
  assert.equal(data.items[0]?.format, "SOURCE");
  assert.throws(() => parseBrazilRanking("<html>challenge</html>"));
  assert.throws(() => parseBrazilRanking(html.replaceAll('class="classificacao"', 'class="other"')));
});
test("internacional usa identidade da obra e não afirma idioma da edição", () => {
  const [book] = parseWorldRanking(world);
  assert.equal(book?.id, "ol-OL123W");
  assert.equal(book?.language, "");
  assert.equal(book?.format, "SOURCE");
  assert.throws(() => parseWorldRanking({ docs: [{ ...world.docs[0], key: "https://evil.example" }] }));
});
test("cache compartilha consultas, identifica falha e expira dados antigos", async () => {
  let now = Date.parse("2026-10-23T12:00:00Z"), calls = 0, fail = false;
  const service = new BookTrendingService(async (url) => {
    calls++;
    if (fail) throw new Error("offline");
    return Buffer.from(url.includes("veja.") ? html : JSON.stringify(world));
  }, () => now);
  const [first, second] = await Promise.all([service.list(), service.list()]);
  bookTrendsSchema.parse(first);
  assert.deepEqual(first, second); assert.equal(calls, 2);
  fail = true; now += 3_600_001;
  const stale = await service.list();
  assert.equal(stale.sections[0]?.stale, true);
  assert.equal(stale.sections[0]?.fetchedAt, first.sections[0]?.fetchedAt);
  now += 86_400_000;
  const expired = await service.list();
  assert.equal(expired.sections[0]?.items.length, 0);
  assert.match(expired.sections[0]?.notice ?? "", /indisponível/);
});
test("falha de uma fonte não esconde a outra", async () => {
  const service = new BookTrendingService(async (url) => {
    if (url.includes("veja.")) throw new Error("offline");
    return Buffer.from(JSON.stringify(world));
  });
  const result = await service.list();
  assert.equal(result.sections[0]?.items.length, 0);
  assert.equal(result.sections[1]?.items.length, 1);
});

test("clássicos aparecem depois das tendências e preservam disponibilidade real", async () => {
  const service = new BookTrendingService(async (url) => Buffer.from(url.includes("veja.") ? html : JSON.stringify(world)));
  const { sections } = await service.list();
  assert.deepEqual(sections.map((section) => section.id), ["brazil", "world", "classics-brazil", "classics-northeast"]);
  const northeast = sections[3]!;
  assert.ok(northeast.items.some((book) => book.authors.includes("Ariano Suassuna")));
  assert.ok(northeast.items.some((book) => book.authors.includes("Rachel de Queiroz")));
  assert.ok(northeast.items.some((book) => book.authors.includes("Graciliano Ramos")));
  assert.equal(northeast.items.find((book) => book.title === "O Cortiço")?.format, "EPUB");
  assert.equal(northeast.items.find((book) => book.title === "Auto da Compadecida")?.format, "SOURCE");
  assert.ok(sections[2]!.items.some((book) => book.authors.includes("Machado de Assis")));
});
