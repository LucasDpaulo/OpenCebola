// A versão precisa mudar sempre que este arquivo mudar: o "activate" apaga todo cache cujo nome
// seja diferente deste, e é assim que um deploy limpa o que ficou para trás.
const CACHE_NAME = "cebola-static-v2";

// SÓ arquivos imutáveis. HTML e JavaScript NUNCA entram aqui.
//
// A versão anterior guardava "/" — o HTML da aplicação. Três coisas davam errado juntas:
// o Caddy manda "Cache-Control: no-store" para o HTML e o Cache Storage IGNORA esse cabeçalho;
// o nome do cache era fixo, e o "install" só roda de novo quando este arquivo muda, o que nunca
// acontecia; e cada build do Next gera nomes novos para os arquivos de JavaScript. Resultado: o
// navegador servia para sempre o HTML do primeiro acesso, apontando para arquivos que já não
// existiam no servidor. O site "carregava e não fazia nada", e nenhum deploy chegava — só a aba
// anônima funcionava, porque nela não há este cache.
const PRECACHED_PATHS = new Set([
  "/manifest.webmanifest",
  "/icons/cebola-192.png",
  "/icons/cebola-512.png"
]);

self.addEventListener("install", (event) => {
  // Falhar ao pré-carregar um ícone não pode impedir a instalação da versão nova.
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll([...PRECACHED_PATHS]))
      .catch(() => undefined)
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
      .catch(() => undefined)
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  // O service worker só se mete no caminho dos três arquivos que ele guarda. HTML, JavaScript,
  // mídia e API passam direto para a rede, sem intermediário — se ele não pode servir nada
  // melhor, não tem por que estar no meio.
  if (!PRECACHED_PATHS.has(url.pathname)) return;
  event.respondWith(
    caches.match(request, { cacheName: CACHE_NAME })
      .then((cached) => cached ?? fetch(request))
      // Sem este catch, uma falha de rede virava "network error" na página inteira em vez de um
      // erro comum que a aplicação sabe tratar. Era o "TypeError: Failed to fetch at sw.js:20".
      .catch(() => fetch(request))
  );
});
