import { pinnedMediaFetch, validatePublicMediaUrl } from "./safe-http.js";
import type { ReadRange } from "./mkv-subtitles.js";

// Leitura por Range da mídia remota para a extração de legenda embutida. Mesma política de SSRF
// do hash do OpenSubtitles: valida a URL e CADA destino de redirect (Torrentio "resolve" → 302 →
// link do Real-Debrid). Nenhuma URL entra em mensagem de erro ou log: ela carrega token.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const OPERATION_TIMEOUT_MS = 20_000;
// Cada leitura tem teto próprio dentro do total: uma requisição presa não come o orçamento todo.
const READ_TIMEOUT_MS = 15_000;
const READ_ATTEMPTS = 3;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class RemoteMediaError extends Error {
  constructor() {
    super("Não foi possível ler o arquivo remoto.");
    this.name = "RemoteMediaError";
  }
}

async function followRedirects(
  start: URL,
  init: RequestInit,
  fetchImpl: FetchLike,
  signal: AbortSignal
): Promise<{ response: Response; url: URL }> {
  let current = start;
  for (let hop = 0; ; hop += 1) {
    const response = await fetchImpl(current.href, { ...init, redirect: "manual", signal });
    if (!REDIRECT_STATUSES.has(response.status)) return { response, url: current };
    await response.body?.cancel().catch(() => {});
    const location = response.headers.get("location");
    if (!location || hop >= MAX_REDIRECTS) throw new RemoteMediaError();
    current = await validatePublicMediaUrl(new URL(location, current).href, { allowInsecure: false });
  }
}

async function readBody(response: Response, length: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  // 206 já vem do tamanho pedido: lido até o fim, a conexão volta para o pool e a próxima leitura
  // não paga outro aperto de mão TLS. Cancelar antes do `done` fechava o socket a cada leitura, e
  // centenas de conexões novas por segundo faziam o Real-Debrid responder com ECONNRESET. 200
  // (Range ignorado) é o arquivo inteiro: aí sim para no `length` e cancela.
  const limit = response.status === 206 ? length + 65_536 : length;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      total += value.length;
    }
  } finally {
    // Cancela o resto: num servidor que ignora Range o corpo seria o arquivo inteiro.
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, total).subarray(0, length);
}

export interface RemoteMedia {
  readonly readRange: ReadRange;
  /** Destino final depois dos redirects, para reutilizar sem repetir a cadeia. Segredo: não logar. */
  readonly finalUrl: string;
}

/**
 * Valida a URL, resolve a cadeia de redirects uma única vez e devolve um `readRange` que fala
 * direto com o destino final. `timeoutMs` vale para a operação inteira (listar ou extrair).
 */
export async function openRemoteMedia(
  input: string,
  options: { fetch?: FetchLike; timeoutMs?: number } = {}
): Promise<RemoteMedia> {
  const fetchImpl = options.fetch ?? pinnedMediaFetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? OPERATION_TIMEOUT_MS);
  const start = await validatePublicMediaUrl(input, { allowInsecure: false });
  // Sonda de 1 byte só para descobrir o destino final (e já falhar cedo se não há Range).
  const probe = await followRedirects(start, { method: "GET", headers: { Range: "bytes=0-0" } }, fetchImpl, signal);
  await probe.response.body?.cancel().catch(() => {});
  if (probe.response.status !== 206 && probe.response.status !== 200) throw new RemoteMediaError();
  const finalUrl = probe.url;

  // Conexão derrubada no meio (ECONNRESET, comum com várias leituras simultâneas) não condena a
  // extração inteira: a mesma leitura é refeita até READ_ATTEMPTS vezes. Resposta HTTP inválida
  // (RemoteMediaError) ou fim do prazo total não se resolvem tentando de novo.
  const readRange: ReadRange = async (from, length) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await readOnce(from, length);
      } catch (error) {
        if (error instanceof RemoteMediaError || signal.aborted) throw error;
        if (attempt >= READ_ATTEMPTS) throw new RemoteMediaError();
        await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
      }
    }
  };

  const readOnce = async (from: number, length: number): Promise<Buffer> => {
    // Um sinal novo por leitura (encadeado ao total): dezenas de leituras em paralelo no mesmo
    // sinal estourariam o limite de listeners (MaxListenersExceededWarning).
    const { response } = await followRedirects(
      finalUrl,
      { method: "GET", headers: { Range: `bytes=${from}-${from + length - 1}` } },
      fetchImpl,
      AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)])
    );
    if (response.status === 416) {
      await response.body?.cancel().catch(() => {});
      return Buffer.alloc(0); // pedido além do fim do arquivo
    }
    // 200 só serve para o começo do arquivo (servidor ignorou Range); no meio, os bytes seriam errados.
    if (response.status !== 206 && !(from === 0 && response.status === 200)) {
      await response.body?.cancel().catch(() => {});
      throw new RemoteMediaError();
    }
    return readBody(response, length);
  };
  return { readRange, finalUrl: finalUrl.href };
}
