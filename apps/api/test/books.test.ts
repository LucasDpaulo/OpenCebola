import assert from "node:assert/strict";
import test from "node:test";
import { zipSync, strToU8, strFromU8 } from "fflate";
import { DOMParser } from "@xmldom/xmldom";
import { prepareEpub, readEpub, epubFilename } from "../src/books/epub.js";
import { BookCatalogService } from "../src/books/catalog.js";
import { bookSourceUrl } from "../src/books/remote.js";
import { buildApp } from "../src/app.js";
import { InMemoryAuthProvider } from "../src/auth/index.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=", "base64");
const chapter = '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Um capítulo</title></head><body><p>Texto &amp; código: a &lt; b.</p></body></html>';
function epub(cover = true, version = "3.0", maliciousPath = false) {
  return zipSync({
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(`<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="${maliciousPath ? "../../secret" : "EPUB/book.opf"}" /></rootfiles></container>`),
    "EPUB/book.opf": strToU8(`<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="${version}"><metadata><dc:title>Livro</dc:title><dc:creator>Autor</dc:creator>${cover ? '<meta name="cover" content="img" />' : ""}</metadata><manifest><item id="text" href="chapter.xhtml" media-type="application/xhtml+xml" />${cover ? '<item id="img" href="image.png" media-type="image/png" />' : ""}</manifest><spine><itemref idref="text" /></spine></package>`),
    "EPUB/chapter.xhtml": strToU8(chapter),
    ...(cover ? { "EPUB/image.png": png } : {})
  });
}

test("EPUB3 preserva texto, incorpora identificação de capa e mantém mimetype primeiro sem compressão", async () => {
  const result = await prepareEpub(epub(), async () => { throw new Error("Não deve buscar capa externa"); });
  assert.equal(result.readUInt16LE(8), 0);
  assert.equal(result.subarray(30, 38).toString(), "mimetype");
  const files = await readEpub(result);
  assert.equal(strFromU8(files["EPUB/chapter.xhtml"]!), chapter);
  assert.deepEqual(Buffer.from(files["EPUB/image.png"]!), png);
  const doc = new DOMParser().parseFromString(strFromU8(files["EPUB/book.opf"]!), "application/xml");
  const items = Array.from(doc.getElementsByTagName("item"));
  assert.equal(items.filter((item) => item.getAttribute("properties") === "cover-image").length, 1);
  assert.equal(items.find((item) => item.getAttribute("properties") === "cover-image")?.getAttribute("id"), "img");
  assert.equal(doc.getElementsByTagName("meta").item(0)?.getAttribute("content"), "img");
  assert.ok(files["EPUB/cebola-cover.xhtml"]);
  assert.match(strFromU8(files["EPUB/cebola-cover.xhtml"]!), /src="image.png"/);
});

test("EPUB2 recebe capa raster real e metadado sem propriedades exclusivas do EPUB3", async () => {
  const files = await readEpub(await prepareEpub(epub(false, "2.0"), async () => png));
  assert.deepEqual(Buffer.from(files["EPUB/cebola-cover.png"]!), png);
  const opf = strFromU8(files["EPUB/book.opf"]!);
  assert.match(opf, /name="cover" content="cebola-cover-image"/);
  assert.doesNotMatch(opf, /properties="cover-image"/);
});

test("preparação repetida não duplica capa, página ou metadados", async () => {
  const first = await prepareEpub(epub(), async () => png);
  const a = await readEpub(first);
  const b = await readEpub(await prepareEpub(first, async () => png));
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  assert.equal(strFromU8(a["EPUB/book.opf"]!), strFromU8(b["EPUB/book.opf"]!));
});

test("recusa HTML disfarçado, caminhos externos, capa inválida e ZIP com tamanho expandido excessivo", async () => {
  await assert.rejects(prepareEpub(strToU8("<html>erro</html>"), async () => png));
  await assert.rejects(prepareEpub(epub(true, "3.0", true), async () => png));
  await assert.rejects(prepareEpub(epub(false), async () => strToU8("não é uma imagem")));
  const huge = Buffer.from(epub());
  const central = huge.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  huge.writeUInt32LE(100 * 1024 * 1024, central + 24);
  await assert.rejects(readEpub(huge));
});

test("fontes fechadas recusam URL arbitrária, credenciais, esquema e subdomínio forjado", () => {
  for (const url of ["http://www.gutenberg.org/a", "https://www.gutenberg.org.evil.test/a", "https://user:secret@gutendex.com/", "https://localhost/a", "https://eloquentjavascript.net:444/a"]) {
    assert.throws(() => bookSourceUrl(url));
  }
  assert.equal(bookSourceUrl("https://www.gutenberg.org/cache/epub/55752/book.epub").hostname, "www.gutenberg.org");
  assert.equal(epubFilename('Dom Casmurro\r\n"/../'), "Dom-Casmurro.epub");
});

const rawBook = { id: 123, title: "Filosofia", authors: [{ name: "Autor" }], languages: ["pt"],
  copyright: false, media_type: "Text", formats: { "application/epub+zip": "https://www.gutenberg.org/book.epub" } };
test("catálogo filtra arquivo pago, sem EPUB e host não autorizado; paginação não segue URL remota", async () => {
  const service = new BookCatalogService(async (url) => {
    assert.equal(new URL(url).searchParams.get("topic"), "philosophy");
    return Buffer.from(JSON.stringify({ next: "https://evil.test/next", results: [rawBook,
      { ...rawBook, id: 124, copyright: true }, { ...rawBook, id: 125, formats: {} },
      { ...rawBook, id: 126, formats: { "application/epub+zip": "https://evil.test/file" } }] }));
  });
  const result = await service.list({ category: "philosophy", language: "pt", search: "", page: 1 });
  assert.deepEqual(result.items.map((book) => book.id), ["gutenberg-123"]);
  assert.equal(result.nextPage, 2);
});

test("queda do catálogo mantém clássicos reais e respeita busca/idioma; categoria hot não inventa livros", async () => {
  const service = new BookCatalogService(async () => { throw new Error("offline"); });
  const result = await service.list({ category: "brazil", language: "pt", search: "memorias", page: 1 });
  assert.deepEqual(result.items.map((book) => book.id), ["gutenberg-54829"]);
  assert.match(result.notice!, /indisponível/);
  const empty = await service.list({ category: "hot", language: "pt", search: "", page: 1 });
  assert.equal(empty.items.length, 0);
  await assert.rejects(service.list({ category: "all", language: "en", search: "Machado", page: 1 }));
});

test("tecnologia oferece Pro Git brasileiro e JavaScript em inglês, respeitando filtros", async () => {
  const service = new BookCatalogService(async () => { throw new Error("Não deve consultar catálogo para seleção técnica"); });
  const pt = await service.list({ category: "technology", language: "pt", search: "", page: 1 });
  assert.deepEqual(pt.items.map((book) => book.id), ["progit-pt-br"]);
  const english = await service.list({ category: "technology", language: "en", search: "JavaScript", page: 1 });
  assert.deepEqual(english.items.map((book) => book.id), ["eloquent-javascript"]);
  const book = await service.resolve("progit-pt-br");
  assert.equal(bookSourceUrl(book.epubUrl).hostname, "github.com");
  assert.throws(() => bookSourceUrl("https://github.com/another/project/releases/download/a/file.epub"));
});

test("rotas exigem sessão, rejeitam URL do cliente e entregam EPUB com capa como attachment sem cache", async (t) => {
  let downloads = 0;
  const authProvider = new InMemoryAuthProvider({ users: [{ id: "26bd6155-a16d-445c-84de-20db3b0cd65f", email: "reader@example.com", password: "reader-password" }], tokenFactory: () => "book-session" });
  const app = await buildApp({ NODE_ENV: "test", CEBOLA_API_HOST: "127.0.0.1", CEBOLA_API_PORT: 3001, CEBOLA_WEB_ORIGIN: "http://localhost:3000", CEBOLA_SESSION_TTL_SECONDS: 3600 }, {
    authProvider, books: { fetchBytes: async () => { downloads++; return Buffer.from(epub()); } }
  });
  t.after(() => app.close());
  for (const url of ["/v1/books", "/v1/books/eloquent-javascript/epub"]) {
    assert.equal((await app.inject({ url })).statusCode, 401);
    assert.equal((await app.inject({ url, headers: { authorization: "Bearer forged" } })).statusCode, 401);
  }
  assert.equal(downloads, 0);
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", headers: { origin: "http://localhost:3000" }, payload: { email: "reader@example.com", password: "reader-password" } });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const headers = { cookie };
  assert.equal((await app.inject({ url: "/v1/books?url=https://evil.test", headers })).statusCode, 400);
  assert.equal((await app.inject({ url: "/v1/books/eloquent-javascript/epub?url=https://evil.test", headers })).statusCode, 400);
  const response = await app.inject({ url: "/v1/books/eloquent-javascript/epub", headers });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "application/epub+zip");
  assert.match(String(response.headers["content-disposition"]), /attachment; filename="Eloquent-JavaScript.epub"/);
  assert.equal(response.headers["cache-control"], "no-store");
  await readEpub(response.rawPayload);
  assert.equal(downloads, 1);
});
