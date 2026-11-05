import { pinnedMediaFetch } from "../stremio/safe-http.js";

export class BookError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}

const HOSTS = new Set(["veja.abril.com.br", "openlibrary.org", "raw.githubusercontent.com", "gutendex.com", "www.gutenberg.org", "gutenberg.org", "eloquentjavascript.net", "git-scm.com", "github.com", "release-assets.githubusercontent.com"]);
export function bookSourceUrl(input: string): URL {
  const url = new URL(input);
  if ((url.hostname === "veja.abril.com.br" && url.pathname !== "/vitrine-livros-mais-vendidos/") ||
    (url.hostname === "openlibrary.org" && url.pathname !== "/search.json") || url.protocol !== "https:" || url.username || url.password || url.port || !HOSTS.has(url.hostname) ||
    (url.hostname === "raw.githubusercontent.com" && !/^\/EbookFoundation\/free-programming-books\/main\/books\/free-programming-books-(pt_BR|langs|subjects)\.md$/.test(url.pathname)) ||
    (url.hostname === "github.com" && url.pathname !== "/progit/progit2-pt-br/releases/download/2.1.50/progit.epub")) {
    throw new BookError("BOOK_SOURCE_INVALID", 502, "A fonte deste livro não está disponível.");
  }
  return url;
}

export type BookFetch = (url: string, maxBytes: number, accept: string) => Promise<Buffer>;

// Lista fechada + DNS fixado na conexão. Cookies e tokens nunca chegam às fontes.
export const fetchBookBytes: BookFetch = async (input, maxBytes, accept) => {
  let url = bookSourceUrl(input);
  const signal = AbortSignal.timeout(accept === "application/json" || accept === "text/html" ? 8_000 : 30_000);
  for (let hop = 0; hop <= 3; hop++) {
    const response = await pinnedMediaFetch(url, { signal, headers: { Accept: accept, "Accept-Encoding": "identity", "User-Agent": "OpenCebola/0.1" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location || hop === 3) break;
      url = bookSourceUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new BookError("BOOK_SOURCE_UNAVAILABLE", 502, "A fonte não respondeu. Tente novamente em instantes.");
    }
    const type = response.headers.get("content-type") ?? "";
    if ((accept === "application/json" && !/^application\/json\b/i.test(type)) ||
      Number(response.headers.get("content-length") ?? 0) > maxBytes) {
      await response.body.cancel();
      throw new BookError("BOOK_FILE_INVALID", 422, "O arquivo recebido não pôde ser preparado.");
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) throw new BookError("BOOK_TOO_LARGE", 413, "Este arquivo excede o limite de download de 25 MB.");
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    } finally { await reader.cancel().catch(() => undefined); }
  }
  throw new BookError("BOOK_SOURCE_UNAVAILABLE", 502, "Não foi possível acessar a fonte deste livro.");
};
