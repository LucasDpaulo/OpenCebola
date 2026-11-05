import type { FastifyCorsOptions, FastifyCorsOptionsDelegate } from "@fastify/cors";
import type { FastifyRequest } from "fastify";

/**
 * Módulo próprio pelo mesmo motivo que `http-origin.ts` é um: ali a pergunta é "esta
 * requisição pode mudar estado"; aqui é "o navegador pode LER a resposta". São camadas
 * diferentes e independentes — o CORS acontece antes de qualquer rota existir, e por isso
 * uma política errada aqui derruba o app inteiro sem nenhuma rota ser executada.
 *
 * A configuração anterior era `{ origin: webOrigin, credentials: true }`, o que devolvia
 * `Access-Control-Allow-Origin: <site>` para QUALQUER origem que perguntasse, sempre com
 * `Allow-Credentials: true`. O navegador do site funcionava por coincidência de valor; a
 * WebView do app (`https://localhost`) e o app de TV (`Origin: null`) eram recusados no
 * preflight, antes de o Bearer chegar a ser lido.
 */

/**
 * As origens que um cliente nativo apresenta. Elas NUNCA recebem credenciais — ver
 * `nativeOptions` abaixo.
 *
 * `https://localhost` e `http://localhost` são o que a WebView do Capacitor envia no
 * Android. `null` é o que um app empacotado como arquivo local envia, que é o caso de
 * Tizen e webOS.
 *
 * Tauri 2 pode usar `tauri://localhost` nos hosts com protocolo customizado e
 * `http://tauri.localhost` onde o WebView exige HTTP. Ambas continuam sem cookies e só
 * podem agir com um Bearer emitido pelo login de aparelho.
 */
const NATIVE_ORIGINS: ReadonlySet<string> = new Set([
  "https://localhost",
  "http://localhost",
  "capacitor://localhost",
  "tauri://localhost",
  "http://tauri.localhost",
  "file://",
  "null"
]);

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/**
 * Sem credenciais, e é o ponto inteiro desta separação.
 *
 * Abrir a lista de origens mantendo `credentials: true` abriria também as rotas que
 * autenticam por **cookie** para essas origens — inclusive `null`, que qualquer iframe em
 * sandbox consegue apresentar. Cliente nativo autentica por `Authorization`, que o navegador
 * jamais anexa sozinho, então ele não perde nada ficando sem credenciais.
 *
 * O que um `Origin: null` hostil consegue com isso é ler resposta de rota que não exige
 * autenticação nenhuma. As rotas que mudam estado continuam protegidas por
 * `requireTrustedOrigin` / `requireWebOrigin`, que são checagem própria e independente
 * desta.
 */
const nativeOptions = (origin: string): FastifyCorsOptions => ({
  origin,
  credentials: false,
  methods: METHODS
});

const webOptions = (origin: string): FastifyCorsOptions => ({
  origin,
  credentials: true,
  methods: METHODS
});

/** `origin: false` não emite `Access-Control-Allow-Origin` nenhum. */
const deniedOptions: FastifyCorsOptions = {
  origin: false,
  credentials: false,
  methods: METHODS
};

export function corsPolicy(webOrigin: string): () => FastifyCorsOptionsDelegate {
  return () => (request: FastifyRequest, callback) => {
    const origin = request.headers.origin;
    if (origin === webOrigin) return callback(null, webOptions(webOrigin));
    if (typeof origin === "string" && NATIVE_ORIGINS.has(origin)) {
      return callback(null, nativeOptions(origin));
    }
    return callback(null, deniedOptions);
  };
}
