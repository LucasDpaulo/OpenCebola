import { resolve4, resolve6 } from "node:dns/promises";
import { request } from "node:https";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import ipaddr from "ipaddr.js";
import { StremioIntegrationError } from "./types.js";
import { decodeMixedUtf8, repairDoubleEncodedUtf8 } from "./subtitle-encoding.js";

const MAX_JSON_BYTES = 2_097_152;
const MAX_TEXT_BYTES = 5_242_880;
const REQUEST_TIMEOUT_MS = 8_000;
// Add-ons oficiais (ex.: Cinemeta) respondem com redirect antes do JSON real; bloquear todo
// redirect (comportamento antigo) derrubava o catálogo inteiro em produção.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

function publicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

// Credenciais na URL e tamanho: mesma régua para qualquer URL validada aqui (JSON de add-on
// ou stream de mídia), não depende do esquema liberado por quem chama.
function assertSafeUrlShape(url: URL): void {
  if (url.username !== "" || url.password !== "" || url.href.length > 4_096) {
    throw new StremioIntegrationError("UNSAFE_ADDON");
  }
}

// Host/IP: recusa localhost/.local e qualquer IP (literal ou resolvido por DNS) fora da faixa
// unicast (privado, loopback, link-local, CGNAT, unspecified). É o que impede um add-on hostil
// de usar o servidor/navegador para varrer a rede doméstica, então fica isolado da checagem de
// esquema/porta abaixo, que é a única coisa que varia entre os chamadores.
async function assertPublicHost(url: URL): Promise<void> {
  const hostname = normalizedHostname(url);
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new StremioIntegrationError("UNSAFE_ADDON");
  }
  if (ipaddr.isValid(hostname)) {
    if (!publicAddress(hostname)) throw new StremioIntegrationError("UNSAFE_ADDON");
    return;
  }

  const [ipv4, ipv6] = await Promise.all([
    resolve4(hostname).catch(() => []),
    resolve6(hostname).catch(() => [])
  ]);
  const addresses = [...ipv4, ...ipv6];
  if (addresses.length === 0 || addresses.some((address) => !publicAddress(address))) {
    throw new StremioIntegrationError("UNSAFE_ADDON");
  }
}

// Usada pelo servidor para falar com add-ons (manifest/catalog/meta/stream JSON, inclusive
// redirects): sempre HTTPS na 443, sem exceção — não depende de nenhuma flag de configuração.
export async function validatePublicHttpsUrl(input: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new StremioIntegrationError("UNSAFE_ADDON");
  }
  assertSafeUrlShape(url);
  if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443")) {
    throw new StremioIntegrationError("UNSAFE_ADDON");
  }
  await assertPublicHost(url);
  return url;
}

// URL de stream entregue ao navegador (gateway.streams). Com allowInsecure: false, o
// resultado é idêntico a validatePublicHttpsUrl. Com allowInsecure: true (flag
// CEBOLA_ALLOW_INSECURE_STREAMS, decisão explícita do dono para uso local), aceita também
// http: na porta 80 — em produção o navegador bloqueia vídeo http: dentro de página https:
// (mixed content), mas isso é opção de quem liga a flag. Host/IP, credenciais e tamanho
// seguem a mesma régua de sempre: só o esquema/porta aceitos mudam.
export async function validatePublicMediaUrl(
  input: string,
  options: { allowInsecure: boolean }
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new StremioIntegrationError("UNSAFE_ADDON");
  }
  assertSafeUrlShape(url);
  const validScheme =
    (url.protocol === "https:" && (url.port === "" || url.port === "443")) ||
    (options.allowInsecure && url.protocol === "http:" && (url.port === "" || url.port === "80"));
  if (!validScheme) {
    throw new StremioIntegrationError("UNSAFE_ADDON");
  }
  await assertPublicHost(url);
  return url;
}

// Endereço já validado como público e fixado para a conexão inteira: entre validar e
// conectar, o hostname nunca é re-resolvido (é essa fixação que barra DNS rebinding).
type PinnedAddress = { address: string; family: 4 | 6 };

async function pinnedAddress(url: URL): Promise<PinnedAddress> {
  const hostname = normalizedHostname(url);
  if (ipaddr.isValid(hostname)) {
    // Defesa própria, não herdada: todo chamador hoje já validou a URL antes, mas quem fixa o
    // endereço é esta função — deixá-la aceitar um literal privado faria dela o elo que devolve
    // 127.0.0.1 ou 169.254.169.254 para a conexão.
    if (!publicAddress(hostname)) throw new StremioIntegrationError("UNSAFE_ADDON");
    return { address: hostname, family: ipaddr.parse(hostname).kind() === "ipv4" ? 4 : 6 };
  }
  const [ipv4, ipv6] = await Promise.all([
    resolve4(hostname).catch(() => []),
    resolve6(hostname).catch(() => [])
  ]);
  const addresses = [...ipv4, ...ipv6];
  if (addresses.length === 0 || addresses.some((address) => !publicAddress(address))) {
    throw new StremioIntegrationError("UNSAFE_ADDON");
  }
  return ipv4.length > 0
    ? { address: ipv4[0], family: 4 }
    : { address: ipv6[0], family: 6 };
}

// Decide o destino de um redirect sem tocar rede: devolve null quando o status não é redirect
// (a resposta final fica por conta de quem chamou). Exportada para testar isolada, sem socket,
// os 5 status aceitos e Location relativo, absoluto, ausente ou inválido.
export function redirectTarget(status: number, location: string | undefined, currentUrl: URL): URL | null {
  if (!REDIRECT_STATUSES.has(status)) return null;
  if (location === undefined) throw new StremioIntegrationError("UPSTREAM_UNAVAILABLE");
  try {
    // new URL com base resolve Location relativo (ex.: "/top/catalog/...") contra a URL atual.
    return new URL(location, currentUrl);
  } catch {
    throw new StremioIntegrationError("UPSTREAM_UNAVAILABLE");
  }
}

type HopResult =
  | { kind: "json"; value: unknown }
  | { kind: "text"; value: string }
  | { kind: "redirect"; location: URL };

// Formato do callback que o "lookup" do https.request espera do Node: com autoSelectFamily
// (Happy Eyeballs, padrão desde o Node 20) o Node chama com options.all=true e quer um ARRAY
// no callback; fora desse modo, quer (endereço, family) como argumentos separados. O tipo
// LookupFunction do Node aceita as duas formas na mesma assinatura de callback, então o
// TypeScript não acusa erro se só uma delas for implementada — foi assim que a forma antiga
// (sempre 3 argumentos) passou batido do typecheck e só quebrou em produção: com
// autoSelectFamily o Node chamava o callback esperando a lista e recebia undefined no lugar,
// e a conexão morria com ERR_INVALID_IP_ADDRESS (virava UPSTREAM_UNAVAILABLE pro chamador).
// Nunca reconsulta o hostname pedido (parâmetro ignorado): sempre devolve pinned.address, o
// endereço já validado — isso é o próprio ponto do pinning, a defesa contra DNS rebinding.
export function pinnedLookup(pinned: PinnedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: pinned.address, family: pinned.family }]);
    } else {
      callback(null, pinned.address, pinned.family);
    }
  };
}

// Status em que o Response do WHATWG proíbe corpo: passar um stream neles lança TypeError.
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

// Busca de MÍDIA com o mesmo pinning das chamadas a add-on. Existe porque validar a URL e depois
// entregá-la ao fetch global não protege nada: o fetch resolve o DNS outra vez, e entre as duas
// resoluções o host pode passar a responder um IP privado (DNS rebinding). Nesta topologia o alvo
// natural seria 169.254.169.254, o serviço de metadados da instância Oracle, com a resposta
// voltando pelo relay até o navegador. Aqui a conexão é fixada no IP já validado, como em
// getSafeJson. A assinatura imita typeof fetch para o relay poder injetar um duplo nos testes.
export async function pinnedMediaFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  // Revalida que TODO endereço resolvido é público e devolve o que será fixado na conexão.
  const pinned = await pinnedAddress(url);
  const method = init?.method === "HEAD" ? "HEAD" : "GET";
  const headers: Record<string, string> = { "User-Agent": "Cebola/0.1" };
  new Headers(init?.headers).forEach((value, name) => { headers[name] = value; });
  return new Promise<Response>((resolve, reject) => {
    const outgoing = request(url, {
      method,
      headers,
      servername: normalizedHostname(url),
      lookup: pinnedLookup(pinned),
      ...(init?.signal ? { signal: init.signal } : {})
    }, (response) => {
      const status = response.statusCode ?? 0;
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined) continue;
        responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      // Redirect nunca é seguido aqui: quem decide é o laço do relay, que revalida cada destino.
      if (method === "HEAD" || NULL_BODY_STATUSES.has(status)) {
        response.resume();
        resolve(new Response(null, { status, headers: responseHeaders }));
        return;
      }
      resolve(new Response(
        Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>,
        { status, headers: responseHeaders }
      ));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

// Um salto só, com o IP já fixado (pinned). Não decide se deve seguir o redirect: apenas relata
// o que a resposta trouxe para o laço em followRedirects.
function requestOnce(
  url: URL,
  pinned: PinnedAddress,
  signal: AbortSignal
): Promise<HopResult> {
  return new Promise<HopResult>((resolve, reject) => {
    const req = request(url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "Cebola/0.1" },
      signal,
      servername: normalizedHostname(url),
      lookup: pinnedLookup(pinned)
    }, (response) => {
      const status = response.statusCode ?? 0;
      let target: URL | null;
      try {
        target = redirectTarget(status, response.headers.location, url);
      } catch (error) {
        response.resume();
        reject(error);
        return;
      }
      if (target !== null) {
        response.resume(); // corpo do redirect não interessa, só o Location já resolvido acima
        resolve({ kind: "redirect", location: target });
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new StremioIntegrationError("UPSTREAM_UNAVAILABLE"));
        return;
      }
      const contentType = response.headers["content-type"] ?? "";
      const contentLength = Number(response.headers["content-length"] ?? "0");
      if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(contentType) ||
          (Number.isFinite(contentLength) && contentLength > MAX_JSON_BYTES)) {
        response.resume();
        reject(new StremioIntegrationError("INVALID_RESPONSE"));
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > MAX_JSON_BYTES) {
          response.destroy(new StremioIntegrationError("INVALID_RESPONSE"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          resolve({ kind: "json", value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown });
        } catch {
          reject(new StremioIntegrationError("INVALID_RESPONSE"));
        }
      });
      response.on("error", reject);
    });
    req.on("error", (error) => {
      if (error instanceof StremioIntegrationError) reject(error);
      else reject(new StremioIntegrationError("UPSTREAM_UNAVAILABLE"));
    });
    req.end();
  });
}

// Laço de saltos separado do transporte real: fetchHop executa um salto e revalidate reaplica a
// política de segurança no destino. Injetáveis para testar limite de saltos e a garantia de que
// todo redirect passa pela mesma política, sem depender de rede. Sem recursão: só o for/await.
export async function followRedirects(
  start: URL,
  fetchHop: (url: URL) => Promise<HopResult>,
  revalidate: (url: URL) => Promise<URL>
): Promise<unknown> {
  let url = start;
  for (let hop = 0; ; hop++) {
    const result = await fetchHop(url);
    if (result.kind === "json" || result.kind === "text") return result.value;
    if (hop >= MAX_REDIRECTS) throw new StremioIntegrationError("UPSTREAM_UNAVAILABLE");
    // Redirect não pode virar atalho de SSRF: mesmo destino, mesma validação do primeiro salto.
    url = await revalidate(result.location);
  }
}

function requestTextOnce(url: URL, pinned: PinnedAddress, signal: AbortSignal): Promise<HopResult> {
  return new Promise<HopResult>((resolve, reject) => {
    const req = request(url, {
      method: "GET",
      headers: { Accept: "text/vtt,text/plain,application/x-subrip,*/*;q=.1", "User-Agent": "Cebola/0.1" },
      signal,
      servername: normalizedHostname(url),
      lookup: pinnedLookup(pinned)
    }, (response) => {
      const status = response.statusCode ?? 0;
      let target: URL | null;
      try { target = redirectTarget(status, response.headers.location, url); }
      catch (error) { response.resume(); reject(error); return; }
      if (target !== null) { response.resume(); resolve({ kind: "redirect", location: target }); return; }
      if (status !== 200) { response.resume(); reject(new StremioIntegrationError("UPSTREAM_UNAVAILABLE")); return; }
      const contentLength = Number(response.headers["content-length"] ?? "0");
      if (Number.isFinite(contentLength) && contentLength > MAX_TEXT_BYTES) {
        response.resume(); reject(new StremioIntegrationError("INVALID_RESPONSE")); return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > MAX_TEXT_BYTES) response.destroy(new StremioIntegrationError("INVALID_RESPONSE"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          resolve({ kind: "text", value: decodeSubtitleText(Buffer.concat(chunks)) });
        } catch {
          reject(new StremioIntegrationError("INVALID_RESPONSE"));
        }
      });
      response.on("error", reject);
    });
    req.on("error", (error) => reject(error instanceof StremioIntegrationError
      ? error : new StremioIntegrationError("UPSTREAM_UNAVAILABLE")));
    req.end();
  });
}

export function decodeSubtitleText(source: Buffer): string {
  // OpenSubtitles e add-ons compatíveis frequentemente entregam o SRT como arquivo gzip,
  // mesmo sem Content-Encoding. Detectar a assinatura evita mandar bytes compactados como VTT.
  const decoded = source[0] === 0x1f && source[1] === 0x8b
    ? gunzipSync(source, { maxOutputLength: MAX_TEXT_BYTES })
    : source;
  if (decoded.length > MAX_TEXT_BYTES) throw new StremioIntegrationError("INVALID_RESPONSE");
  // UTF-16 tem bytes zero por natureza; só com a marca (BOM) dá para afirmar que é texto.
  if (decoded[0] === 0xff && decoded[1] === 0xfe) return new TextDecoder("utf-16le").decode(decoded.subarray(2));
  if (decoded[0] === 0xfe && decoded[1] === 0xff) return new TextDecoder("utf-16be").decode(decoded.subarray(2));
  if (decoded.includes(0)) throw new StremioIntegrationError("INVALID_RESPONSE");
  // Muita legenda brasileira ainda é Windows-1252 (o OpenSubtitles até informa "CP1252"). Lida
  // como UTF-8, cada acento virava "�" ("Leve-me � Am�rica"). UTF-8 estrito primeiro; se o
  // arquivo não for UTF-8 válido, os bytes soltos são 1252 — que também cobre o Latin-1.
  try {
    return repairDoubleEncodedUtf8(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(decoded));
  } catch {
    return decodeMixedUtf8(decoded);
  }
}

export async function getSafeText(input: string): Promise<string> {
  const start = await validatePublicHttpsUrl(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const result = await followRedirects(
      start,
      async (url) => requestTextOnce(url, await pinnedAddress(url), controller.signal),
      (url) => validatePublicHttpsUrl(url.href)
    );
    if (typeof result !== "string") throw new StremioIntegrationError("INVALID_RESPONSE");
    return result;
  } finally { clearTimeout(timeout); }
}

export async function getSafeJson(input: string): Promise<unknown> {
  const start = await validatePublicHttpsUrl(input);
  const controller = new AbortController();
  // Um timeout só para a operação inteira (todos os saltos somados) — não reinicia por salto.
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await followRedirects(
      start,
      async (url) => requestOnce(url, await pinnedAddress(url), controller.signal),
      (url) => validatePublicHttpsUrl(url.href)
    );
  } finally {
    clearTimeout(timeout);
  }
}
