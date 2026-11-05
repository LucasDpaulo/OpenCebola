import { loadToken } from "./native/session-store";

const API_URL = (process.env.NEXT_PUBLIC_CEBOLA_API_URL ?? "http://localhost:3001").replace(/\/$/, "");

/**
 * O pacote instalado é uma exportação estática e precisa apontar para o arquivo `index.html` de
 * cada diretório. Já o servidor do Next usado no desenvolvimento atende a rota, não esse
 * arquivo. Centralizar a diferença evita que um card funcione no pacote e dê 404 no desktop
 * local (ou vice-versa).
 */
export function appPagePath(pathname: string): string {
  const normalized = `/${pathname.replace(/^\/+|\/+$/g, "")}`;
  return process.env.NODE_ENV === "development" ? `${normalized}/` : `${normalized}/index.html`;
}

/**
 * Como esta requisição prova quem é.
 *
 * `cookie` é o navegador: o cookie `__Host-` viaja sozinho e a defesa contra CSRF é o
 * cabeçalho `Origin`, checado no servidor. `bearer` é o app: não existe cookie, e o
 * `Authorization` nunca é anexado pelo navegador por conta própria — é por isso que a
 * política de CORS libera as origens nativas SEM credenciais.
 */
export type Credential =
  | { kind: "cookie" }
  | { kind: "native" }
  | { kind: "bearer"; token: string };

let credential: Credential = { kind: "cookie" };

export function setCredential(next: Credential): void {
  credential = next;
}

export function getCredential(): Credential {
  return credential;
}

/**
 * O Capacitor injeta esta ponte antes do bundle da aplicação. A origem sozinha não basta
 * para detectar o app: um servidor de desenvolvimento também pode usar localhost.
 */
export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const bridge = window as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return bridge.__TAURI_INTERNALS__ !== undefined || bridge.__TAURI__ !== undefined;
}

export function isTizenRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const runtime = window as Window & { tizen?: unknown; webapis?: { avplay?: unknown } };
  if (runtime.tizen !== undefined || runtime.webapis?.avplay !== undefined) return true;
  // Dentro do WGT, o Web Runtime NÃO injeta window.tizen/webapis no conteúdo remoto (medido na
  // TV: caía no login por senha e a navegação por controle ficava desligada). Mas o User-Agent
  // do navegador Tizen sempre traz "Tizen" — basta para ligar navegação espacial, teclas de mídia
  // e o login por pareamento. O AVPlay continua checando window.webapis à parte (tizen-player.ts),
  // então isto não liga AVPlay onde ele não existe.
  return typeof navigator !== "undefined" && /\bTizen\b/i.test(navigator.userAgent);
}

export function isNativeRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const capacitor = (window as Window & {
    Capacitor?: { isNativePlatform?: () => boolean };
  }).Capacitor;
  return capacitor?.isNativePlatform?.() === true || isTauriRuntime() || isTizenRuntime();
}

/**
 * Projetor / Android TV: o mesmo APK do celular, mas navegado por controle remoto, não por toque.
 * Distinguimos dele por dois sinais que um celular nunca apresenta juntos: o app é nativo Android
 * (Capacitor) E não há tela de toque (`maxTouchPoints === 0`) — ou o User-Agent da WebView de TV
 * não traz o token "Mobile" que todo WebView de celular carrega. Serve para ligar a navegação
 * espacial e o modo leve SÓ no projetor, sem afetar celular nem desktop.
 */
export function isAndroidTvRuntime(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const capacitor = (window as Window & {
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
  }).Capacitor;
  const nativeAndroid = capacitor?.isNativePlatform?.() === true && capacitor?.getPlatform?.() === "android";
  if (!nativeAndroid) return false;
  const noTouch = (navigator.maxTouchPoints ?? 0) === 0;
  const noMobileUa = !/\bMobile\b/i.test(navigator.userAgent);
  return noTouch || noMobileUa;
}

/** TV de qualquer origem (Samsung Tizen ou projetor/Android TV): ergonomia de controle remoto. */
export function isTvRuntime(): boolean {
  return isTizenRuntime() || isAndroidTvRuntime();
}

/**
 * Resolve a credencial nativa antes da primeira chamada. A implementação anterior dependia
 * de alguém chamar restoreSession() em uma tela, mas a home consulta /auth/session antes de
 * qualquer tela de entrada montar. Isso fazia o app pedir cookie no primeiro request e o
 * navegador embutido descartava a resposta CORS inteira.
 */
function credentialForRequest(): Credential {
  if (credential.kind !== "cookie" || !isNativeRuntime()) return credential;
  const token = loadToken();
  credential = token === null ? { kind: "native" } : { kind: "bearer", token };
  return credential;
}

/**
 * Única porta de saída HTTP do site. Existir em um lugar só é o ponto: com 24 chamadas
 * decidindo transporte por conta própria, bastava uma esquecida para o app falhar naquela
 * tela e em nenhuma outra — o tipo de defeito que só aparece no aparelho de outra pessoa.
 */
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  // `no-store` é o padrão, não uma imposição: estava escrito DEPOIS do spread e apagava o que
  // o chamador tivesse pedido. Com isso, nenhuma resposta da API podia ser reaproveitada, nem
  // as que não têm nada de pessoal — a curadoria editorial é a mesma para todo mundo, o
  // servidor já a guarda 6 h, e ainda assim cada abertura do app pedia tudo de novo.
  const options: RequestInit = { cache: "no-store", ...init, headers };
  const current = credentialForRequest();
  if (current.kind === "bearer") {
    headers.set("Authorization", `Bearer ${current.token}`);
    // `omit` e não `include`: pedir credenciais de uma origem que o CORS liberou sem elas
    // faz o navegador embutido descartar a resposta, mesmo com o Bearer correto.
    options.credentials = "omit";
  } else if (current.kind === "native") {
    // Ainda sem sessão, o app precisa alcançar as rotas públicas de login/pareamento sem
    // transformar a requisição numa tentativa de cookie cross-origin.
    options.credentials = "omit";
  } else {
    options.credentials = "include";
  }
  return fetch(`${API_URL}${path}`, options);
}

/**
 * Para o punhado de lugares em que a URL não é buscada por nós, e sim entregue ao navegador
 * — o `src` de uma faixa de legenda, por exemplo. Ali quem faz a requisição é o próprio
 * elemento, e não há como pendurar cabeçalho nela.
 *
 * No app isso vira problema em aberto: `<track>` manda cookie, nunca Bearer. Fica para a
 * fase 1b, junto do player nativo, que carrega legenda por outro caminho.
 */
export function apiUrl(path: string): string {
  return `${API_URL}${path}`;
}
