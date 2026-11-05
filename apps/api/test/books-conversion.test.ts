import assert from "node:assert/strict";
import test from "node:test";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { convertPdf } from "../src/books/conversion.js";
import { BookError } from "../src/books/remote.js";
import { buildApp } from "../src/app.js";
import { InMemoryAuthProvider } from "../src/auth/index.js";

test("conversor recusa HTML e PDF escaneado; limpa temporários no erro", async () => {
  let directory = "";
  await assert.rejects(convertPdf(Buffer.from("<html>fake pdf</html>")), (error) => error instanceof BookError && error.code === "BOOK_PDF_INVALID");
  await assert.rejects(convertPdf(Buffer.from("%PDF-1.4\nscan"), async (command, args, cwd) => {
    directory = cwd;
    assert.equal(command, "pdftotext");
    await writeFile(args.at(-1)!, "");
  }), (error) => error instanceof BookError && error.code === "BOOK_PDF_NEEDS_OCR");
  await assert.rejects(access(directory));
});
test("falha do Calibre limpa arquivos e não expõe erro interno", async () => {
  let directory = "";
  await assert.rejects(convertPdf(Buffer.from("%PDF-1.4\ntext"), async (command, args, cwd) => {
    directory = cwd;
    if (command === "pdftotext") await writeFile(args.at(-1)!, "Texto de um livro. ".repeat(50));
    else {
      assert.ok(args.includes("--base-font-size"));
      throw new Error("internal path secret");
    }
  }), (error) => error instanceof BookError && error.code === "BOOK_CONVERSION_FAILED" && !error.message.includes("secret"));
  await assert.rejects(access(join(directory, "input.pdf")));
});
test("rota de conversão exige login, origem confiável, PDF e libera a fila", async (t) => {
  const authProvider = new InMemoryAuthProvider({ users: [{ id: "26bd6155-a16d-445c-84de-20db3b0cd65f", email: "reader@example.com", password: "reader-password" }], tokenFactory: () => "conversion-session" });
  let calls = 0;
  const app = await buildApp({ NODE_ENV: "test", CEBOLA_API_HOST: "127.0.0.1", CEBOLA_API_PORT: 3001, CEBOLA_WEB_ORIGIN: "http://localhost:3000", CEBOLA_SESSION_TTL_SECONDS: 3600 }, {
    authProvider, books: { convert: async () => { calls++; return Buffer.from("epub fixture"); } }
  });
  t.after(() => app.close());
  const request = { method: "POST" as const, url: "/v1/books/convert", payload: Buffer.from("%PDF-1.4\ntext") };
  assert.equal((await app.inject({ ...request, headers: { "content-type": "application/pdf" } })).statusCode, 401);
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", headers: { origin: "http://localhost:3000" }, payload: { email: "reader@example.com", password: "reader-password" } });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const headers = { cookie, "content-type": "application/pdf" };
  assert.equal((await app.inject({ ...request, headers: { ...headers, origin: "https://evil.example" } })).statusCode, 403);
  assert.equal(calls, 0);
  const response = await app.inject({ ...request, headers: { ...headers, origin: "http://localhost:3000" } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "application/epub+zip");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(calls, 1);
});
