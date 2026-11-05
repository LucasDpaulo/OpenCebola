import { pinnedMediaFetch, validatePublicMediaUrl } from "./safe-http.js";

// "moviehash" do OpenSubtitles: soma o tamanho do arquivo com os blocos de 8 bytes (little-endian,
// como inteiro sem sinal de 64 bits) dos primeiros e últimos 64 KiB. Só esses dois trechos —
// nunca o arquivo inteiro — bastam para casar exatamente com a legenda feita para este arquivo,
// e evitam que o servidor baixe um vídeo inteiro só para calcular um hash.
const HASH_CHUNK_BYTES = 65_536;
// Orçamento total (HEAD + duas leituras em paralelo): a resolução do Real-Debrid não pode esperar
// por isto além de um resultado "instantâneo" para quem está assistindo — por isso o chamador
// (rota de resolve) ainda aplica um teto próprio, mais curto, por cima deste.
const HASH_TIMEOUT_MS = 4_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 2;

export interface RemoteFileHash {
  readonly hash: string;
  readonly size: number;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Núcleo puro do algoritmo, separado da rede para poder ser testado com um vetor conhecido:
 * `size` inteiro (BigInt evita perder precisão acima de 2^53) mais a soma, módulo 2^64, de cada
 * bloco de 8 bytes lido como little-endian sem sinal dos dois trechos.
 */
export function openSubtitlesMovieHash(size: bigint, first: Buffer, last: Buffer): string {
  const mask = (1n << 64n) - 1n;
  let sum = size & mask;
  for (const chunk of [first, last]) {
    for (let offset = 0; offset + 8 <= chunk.length; offset += 8) {
      sum = (sum + chunk.readBigUInt64LE(offset)) & mask;
    }
  }
  return sum.toString(16).padStart(16, "0");
}

async function withRedirects(
  url: URL,
  init: RequestInit,
  fetchImpl: FetchLike,
  signal: AbortSignal
): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop += 1) {
    const response = await fetchImpl(current.href, { ...init, redirect: "manual", signal });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    await response.body?.cancel().catch(() => {});
    const location = response.headers.get("location");
    if (!location || hop >= MAX_REDIRECTS) throw new Error("redirect demais para calcular o hash");
    // Revalida o destino com a mesma política de SSRF de qualquer outra URL de mídia — um
    // redirect não é atalho para escapar dela.
    current = await validatePublicMediaUrl(new URL(location, current).href, { allowInsecure: false });
  }
}

async function remoteContentLength(url: URL, fetchImpl: FetchLike, signal: AbortSignal): Promise<number | null> {
  const response = await withRedirects(url, { method: "HEAD" }, fetchImpl, signal);
  await response.body?.cancel().catch(() => {});
  if (!response.ok) return null;
  const length = Number(response.headers.get("content-length") ?? "");
  return Number.isFinite(length) && length > 0 ? Math.floor(length) : null;
}

async function rangedChunk(
  url: URL,
  fetchImpl: FetchLike,
  signal: AbortSignal,
  start: number,
  end: number
): Promise<Buffer | null> {
  const wanted = end - start + 1;
  const response = await withRedirects(
    url, { method: "GET", headers: { Range: `bytes=${start}-${end}` } }, fetchImpl, signal
  );
  // O início aceita um servidor sem suporte a Range (devolve o arquivo inteiro com 200): os
  // primeiros bytes continuam sendo os primeiros bytes. O TRECHO FINAL não pode aceitar isso —
  // sem 206 não há garantia nenhuma de que os bytes recebidos são o fim do arquivo, e usar o
  // começo duas vezes nunca bateria com o hash que o OpenSubtitles calculou.
  if (response.status !== 206 && !(start === 0 && response.status === 200)) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < wanted) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      total += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const buffer = Buffer.concat(chunks, total);
  return buffer.length >= wanted ? buffer.subarray(0, wanted) : null;
}

/**
 * Calcula o hash de arquivo do OpenSubtitles para uma URL remota (o link já liberado pelo
 * Real-Debrid), sem baixar o arquivo inteiro. Nunca lança: qualquer falha — tamanho
 * indisponível, timeout, servidor sem suporte a `Range` — devolve `null`, e quem chama trata como
 * "sem hash desta vez" em vez de derrubar a resposta de resolução.
 */
export async function computeRemoteFileHash(
  url: string,
  fetchImpl: FetchLike = pinnedMediaFetch
): Promise<RemoteFileHash | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HASH_TIMEOUT_MS);
  try {
    const validated = await validatePublicMediaUrl(url, { allowInsecure: false });
    const size = await remoteContentLength(validated, fetchImpl, controller.signal);
    if (size === null || size < HASH_CHUNK_BYTES) return null;
    const [first, last] = await Promise.all([
      rangedChunk(validated, fetchImpl, controller.signal, 0, HASH_CHUNK_BYTES - 1),
      rangedChunk(validated, fetchImpl, controller.signal, size - HASH_CHUNK_BYTES, size - 1)
    ]);
    if (first === null || last === null) return null;
    return { hash: openSubtitlesMovieHash(BigInt(size), first, last), size };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
