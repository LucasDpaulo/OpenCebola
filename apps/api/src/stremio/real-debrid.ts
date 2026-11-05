import { z } from "zod";
import { validatePublicMediaUrl } from "./safe-http.js";
import { RealDebridError } from "./types.js";

const API_BASE = "https://api.real-debrid.com/rest/1.0";
const hashSchema = z.string().regex(/^[a-fA-F0-9]{40}$/);
const torrentListSchema = z.array(z.object({
  id: z.string().min(1).max(200),
  hash: hashSchema
}));
const torrentInfoSchema = z.object({
  id: z.string().min(1).max(200),
  hash: hashSchema,
  status: z.string().min(1).max(80),
  progress: z.number().finite().min(0).max(100).optional(),
  links: z.array(z.string().url().max(4_096)).optional(),
  // `files` nem sempre vem, e por isso é opcional: sem ela, o comportamento antigo continua.
  files: z.array(z.object({
    path: z.string().min(1).max(4_096),
    selected: z.number().int().min(0).max(1)
  })).optional()
});
const addMagnetSchema = z.object({ id: z.string().min(1).max(200) });
const unrestrictedSchema = z.object({ download: z.string().url().max(4_096) });
const apiErrorSchema = z.object({ error_code: z.number().int().optional() }).passthrough();
type TorrentInfo = Omit<z.infer<typeof torrentInfoSchema>, "links" | "progress"> & {
  readonly links: readonly string[];
  readonly progress: number;
};

// O que o player abre. Lançamento "scene" chega empacotado em .rar e o Real-Debrid entrega o
// pacote: o link existe, responde 206 e não é vídeo nenhum. Medido em 26/08/2026 com
// Ted.Lasso.S01E01[rartv].rar, que chegava ao libVLC como fonte pronta e o deixava em
// `evento=parado`, sem faixa e sem mensagem.
const VIDEO_EXTENSION = /\.(mkv|mp4|avi|mov|m4v|ts|m2ts|mts|webm|wmv|flv|mpe?g|ogv|3gp|divx|vob)$/i;

/**
 * Qual link liberar. O índice de `links` acompanha a ordem dos arquivos SELECIONADOS, não a de
 * `files` — arquivo não selecionado não gera link.
 *
 * O `fileIdx` pedido pelo cliente vem do add-on e não conhece o conteúdo real do torrent, então
 * ele é uma preferência, não uma ordem: se apontar para um `.nfo` ou um `.rar`, perde para o
 * primeiro arquivo que seja de fato vídeo. `null` significa que não há vídeo nenhum ali.
 */
function playableLinkIndex(
  files: readonly { readonly path: string; readonly selected: number }[] | undefined,
  fileIdx: number | null
): number | null {
  const selecionados = (files ?? []).filter((file) => file.selected === 1);
  // Sem lista de arquivos não há o que conferir, e recusar aqui quebraria contas cuja resposta
  // não a traz. Mantém o comportamento anterior.
  if (selecionados.length === 0) return fileIdx ?? 0;
  const pedido = fileIdx ?? 0;
  if (selecionados[pedido] !== undefined && VIDEO_EXTENSION.test(selecionados[pedido].path)) return pedido;
  const encontrado = selecionados.findIndex((file) => VIDEO_EXTENSION.test(file.path));
  return encontrado === -1 ? null : encontrado;
}

export type TorrentResolution =
  | { readonly status: "ready"; readonly url: string }
  | { readonly status: "pending"; readonly progress: number };

// "Continuar assistir" e troca de fonte/player resolvem o MESMO infoHash de novo, e cada resolve
// pagava um GET /torrents?limit=100 (lista até 100 torrents da conta) só pra reencontrar um
// torrentId que já tínhamos visto. O torrentId é global da conta Real-Debrid (uma conta só neste
// serviço), então o cache também é global por infoHash — nunca por household/perfil.
//
// Nível de módulo (não campo de instância) de propósito: mesmo que no futuro o RealDebridClient
// passe a ser criado por requisição, o cache precisa sobreviver entre requisições pra cumprir seu
// papel. Hoje o composition.ts cria um único RealDebridClient no boot (server.ts), então isso já
// funcionaria como campo de instância — mas módulo é o que continua correto se isso mudar.
const TORRENT_ID_CACHE_LIMIT = 500;
const torrentIdCache = new Map<string, string>();

/**
 * Só para os testes: cada teste espera partir de um cache vazio, e o cache é global de módulo
 * (sobrevive entre instâncias de RealDebridClient de propósito — ver comentário acima).
 */
export function clearTorrentIdCache(): void {
  torrentIdCache.clear();
}

function rememberTorrentId(infoHash: string, torrentId: string): void {
  // Descarte simples por tamanho: reinserir move pro fim (mais recente), e ao estourar o teto
  // sai a entrada mais antiga. Não precisa ser LRU sofisticado — só não crescer sem limite.
  torrentIdCache.delete(infoHash);
  if (torrentIdCache.size >= TORRENT_ID_CACHE_LIMIT) {
    const oldest = torrentIdCache.keys().next().value;
    if (oldest !== undefined) torrentIdCache.delete(oldest);
  }
  torrentIdCache.set(infoHash, torrentId);
}

// O Real-Debrid não tem um error_code estável pra "torrent sumiu"; o que ele devolve é HTTP 404
// (ver #request). Só esse caso conta como "id velho": qualquer outro erro (autenticação, rede,
// tráfego esgotado) é um problema real e precisa continuar subindo, não virar mais uma tentativa.
function isStaleTorrentIdError(error: unknown): boolean {
  return error instanceof RealDebridError && error.code === "UNAVAILABLE" &&
    /\bHTTP 404\b/.test(error.detail ?? "");
}

// Cliente intencionalmente pequeno: o token fica somente no processo da API e nunca é enviado
// para o navegador, log ou identificador de stream.
export class RealDebridClient {
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: { token: string; fetch?: typeof fetch }) {
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
  }

  async resolveTorrent(infoHash: string, fileIdx: number | null): Promise<TorrentResolution> {
    const normalizedHash = hashSchema.parse(infoHash).toLowerCase();
    const { torrentId, info } = await this.#resolveTorrentId(normalizedHash);

    if (info.status === "waiting_files_selection") {
      await this.#request(`/torrents/selectFiles/${encodeURIComponent(torrentId)}`, {
        method: "POST",
        form: { files: "all" }
      });
      return { status: "pending", progress: 0 };
    }
    if (info.status !== "downloaded" || info.links.length === 0) {
      return { status: "pending", progress: Math.round(info.progress) };
    }

    const indice = playableLinkIndex(info.files, fileIdx);
    if (indice === null) {
      // Só a extensão entra no detail. Nome de arquivo continua fora do log, como o resto da
      // classe já garante; extensão é tipo, não identificação.
      const tipos = [...new Set((info.files ?? []).filter((f) => f.selected === 1)
        .map((f) => (f.path.match(/\.[A-Za-z0-9]{1,5}$/) ?? ["sem extensão"])[0].toLowerCase()))];
      throw new RealDebridError("NOT_PLAYABLE_FILE", `torrent sem arquivo de vídeo (${tipos.join(", ")})`);
    }
    const link = info.links[indice] ?? info.links[0];
    if (link === undefined) throw new RealDebridError("INVALID_RESPONSE");
    const unrestricted = unrestrictedSchema.safeParse(await this.#request("/unrestrict/link", {
      method: "POST",
      // O arquivo será transmitido pela mesma VM que libera o link. Assim o Real-Debrid
      // aplica o tráfego normal da conta, sem consumir a cota separada de tráfego remoto.
      form: { link }
    }));
    if (!unrestricted.success) throw new RealDebridError("INVALID_RESPONSE");
    const url = await validatePublicMediaUrl(unrestricted.data.download, { allowInsecure: false });
    return { status: "ready", url: url.href };
  }

  /**
   * Acha o torrentId de `infoHash`, evitando a listagem quando já sabemos o id de uma resolução
   * anterior. Se o id em cache sumiu/expirou (404) ou aponta pra outro hash (conta trocada,
   * colisão de reaproveitamento de id no Real-Debrid), invalida o cache e cai no caminho de
   * sempre — listar e achar por hash, senão `#addMagnet` — sem propagar erro por causa disso.
   */
  async #resolveTorrentId(normalizedHash: string): Promise<{ torrentId: string; info: TorrentInfo }> {
    const cachedId = torrentIdCache.get(normalizedHash);
    if (cachedId !== undefined) {
      let cachedInfo: TorrentInfo | undefined;
      try {
        cachedInfo = await this.#info(cachedId);
      } catch (error) {
        if (!isStaleTorrentIdError(error)) throw error;
      }
      if (cachedInfo !== undefined && cachedInfo.hash.toLowerCase() === normalizedHash) {
        return { torrentId: cachedId, info: cachedInfo };
      }
      torrentIdCache.delete(normalizedHash);
    }

    const existing = await this.#request("/torrents?limit=100", { method: "GET" });
    const torrents = torrentListSchema.safeParse(existing);
    if (!torrents.success) throw new RealDebridError("INVALID_RESPONSE");
    const found = torrents.data.find((torrent) => torrent.hash.toLowerCase() === normalizedHash);
    const torrentId = found?.id ?? await this.#addMagnet(normalizedHash);
    const info = await this.#info(torrentId);
    rememberTorrentId(normalizedHash, torrentId);
    return { torrentId, info };
  }

  async #addMagnet(infoHash: string): Promise<string> {
    const response = addMagnetSchema.safeParse(await this.#request("/torrents/addMagnet", {
      method: "POST",
      form: { magnet: `magnet:?xt=urn:btih:${infoHash}` }
    }));
    if (!response.success) throw new RealDebridError("INVALID_RESPONSE");
    return response.data.id;
  }

  async #info(id: string): Promise<TorrentInfo> {
    const response = torrentInfoSchema.safeParse(await this.#request(`/torrents/info/${encodeURIComponent(id)}`, {
      method: "GET"
    }));
    if (!response.success) throw new RealDebridError("INVALID_RESPONSE");
    return { ...response.data, links: response.data.links ?? [], progress: response.data.progress ?? 0 };
  }

  async #request(path: string, options: { method: "GET" | "POST"; form?: Record<string, string> }): Promise<unknown> {
    // Só o caminho, sem query string: id de torrent e link liberado não entram em log.
    const rota = path.split("?")[0];
    let response: Response;
    try {
      response = await this.#fetch(`${API_BASE}${path}`, {
        method: options.method,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          ...(options.form ? { "Content-Type": "application/x-www-form-urlencoded" } : {})
        },
        body: options.form ? new URLSearchParams(options.form).toString() : undefined,
        signal: AbortSignal.timeout(15_000)
      });
    } catch {
      // Timeout e DNS chegam aqui. Distinguir isso de "o Real-Debrid respondeu mal" é o que
      // permite saber se o problema é nosso link com eles ou o serviço deles.
      throw new RealDebridError("UNAVAILABLE", `${rota} falha de rede ou timeout`);
    }
    if (!response.ok) {
      // O código 23 é estável na API do Real-Debrid e não revela token, link ou título.
      // Precisamos lê-lo antes de tratar 403 genericamente, pois 403 também é usado para
      // tráfego remoto esgotado.
      const error = apiErrorSchema.safeParse(await response.json().catch(() => null));
      if (error.success && error.data.error_code === 23) {
        throw new RealDebridError("TRAFFIC_EXHAUSTED", `${rota} HTTP ${response.status} error_code 23`);
      }
      // O Real-Debrid usa 451/error_code 35 quando se recusa a adicionar especificamente este
      // hash por reivindicação de direitos. Repetir, trocar de arquivo ou culpar a credencial
      // não muda o resultado; o player deve tentar uma fonte RD+ já resolvida ou outro hash.
      if (error.success && error.data.error_code === 35) {
        throw new RealDebridError("INFRINGING_FILE", `${rota} HTTP ${response.status} error_code 35`);
      }
      if (response.status === 401 || response.status === 403) {
        throw new RealDebridError("AUTHENTICATION_FAILED", `${rota} HTTP ${response.status}`);
      }
      const codigo = error.success ? ` error_code ${error.data.error_code}` : "";
      throw new RealDebridError("UNAVAILABLE", `${rota} HTTP ${response.status}${codigo}`);
    }
    // O endpoint selectFiles confirma a seleção com 204 No Content. Isso é
    // sucesso, embora não haja JSON para decodificar.
    if (response.status === 204) return null;
    try {
      return await response.json() as unknown;
    } catch {
      throw new RealDebridError("INVALID_RESPONSE", `${rota} resposta não era JSON`);
    }
  }
}
