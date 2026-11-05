import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { timingSafeEqual } from "node:crypto";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { z } from "zod";
import {
  mediaTypeSchema,
  stremioCatalogResponseSchema,
  stremioCatalogsResponseSchema,
  stremioLinkRequestSchema,
  stremioMetaResponseSchema,
  resolveTorrentStreamRequestSchema,
  resolveTorrentStreamResponseSchema,
  skipTimesResponseSchema,
  stremioStatusResponseSchema,
  stremioStreamsResponseSchema
} from "@cebola/contracts";
import type { StremioStreamsResponse } from "@cebola/contracts";
import {
  AuthenticationError,
  isAuthenticationError,
  readRequestSessionToken,
  type AuthProvider,
  type AuthSession,
  type SessionTokenSource
} from "../auth/index.js";
import type { HouseholdService } from "../households/index.js";
import { requireTrustedOrigin } from "../http-origin.js";
import { ipCeilingHook, sessionRateLimitKey } from "../rate-limit-key.js";
import { DiagnosticsLog } from "./diagnostics-log.js";
import { StremioAddonGateway, streamMayNotPlay, subtitleLanguageName, type StremioSearchItem } from "./gateway.js";
import { SearchResultCache } from "./search-cache.js";
import { getSafeText, validatePublicMediaUrl } from "./safe-http.js";
import { OPEN_SUBTITLES_V3, collectWithin, officialSubtitleIds, resolveWithin } from "./official-subtitles.js";
import type { RemoteFileHash } from "./opensubtitles-hash.js";
import { subtitleToVtt } from "./subtitle-format.js";
import type { RealDebridClient } from "./real-debrid.js";
import { MediaRelayError, type RealDebridMediaRelay } from "./media-relay.js";
import { StremioService } from "./service.js";
import { RealDebridError, StremioIntegrationError } from "./types.js";
import type { AddonDescriptor } from "./types.js";
import { SubtitleRelayError, type SubtitleRelay } from "./subtitle-relay.js";
import { EmbeddedSubtitleError, type EmbeddedSubtitleRelay } from "./embedded-subtitle-relay.js";
import type { SubdlClient } from "./subdl.js";
import type { SkipTimesClient } from "./skip-times.js";

const routeIdentifier = z.string().trim().min(1).max(255).refine(
  (value) => !/[\u0000-\u001f\u007f/\\]/.test(value)
);

const catalogParams = z.object({
  addonId: routeIdentifier,
  type: mediaTypeSchema,
  catalogId: routeIdentifier
});

const metaParams = z.object({
  addonId: routeIdentifier,
  type: mediaTypeSchema,
  mediaId: routeIdentifier
});

const streamParams = z.object({
  type: mediaTypeSchema,
  videoId: routeIdentifier
});

const mediaTicketParams = z.object({
  ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
});

const browserStreamImport = z.object({
  addonId: routeIdentifier,
  payload: z.unknown()
});

const diagnosticsContext = z.record(z.string().max(40), z.string().max(200)).refine(
  (value) => Object.keys(value).length <= 10, "no máximo 10 chaves"
);
const diagnosticsReportBody = z.object({
  code: z.string().trim().min(1).max(64),
  message: z.string().max(300),
  context: diagnosticsContext.optional(),
  device: z.string().max(120).optional()
});

const embeddedSubtitlesBody = z.object({ url: z.string().trim().min(1).max(4_096) });
const embeddedSubtitleParams = z.object({
  ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  track: z.string().regex(/^\d{1,5}$/)
});
// Nosso próprio repasse: a mídia já está atrás de um ticket, então o link real vem do relay.
const MEDIA_RELAY_PATH = /^\/v1\/stremio\/streams\/media\/([A-Za-z0-9_-]{43})$/;

const subtitleFileQuery = z.object({ url: z.string().url().max(4_096) });
const searchQuery = z.object({ q: z.string().trim().min(2).max(100) });
// Refinamento por ARQUIVO (não só por título/episódio): quando a página já sabe qual fonte foi
// escolhida, manda estes três dados para achar a legenda sincronizada com o arquivo de verdade.
const subtitleFileHintsQuery = z.object({
  videoHash: z.string().regex(/^[0-9a-f]{16}$/).optional(),
  videoSize: z.coerce.number().int().positive().max(1_000_000_000_000).optional(),
  filename: z.string().trim().min(1).max(255).optional()
});
// Episódio absoluto (numeração sem temporada, ex.: One Piece), só usado quando o mapeamento
// ARM não separa temporadas.
const skipTimesQuery = z.object({
  absolute: z.coerce.number().int().min(1).max(10_000).optional()
});

export interface StremioRoutesOptions {
  readonly authProvider: AuthProvider;
  readonly households: HouseholdService;
  readonly service: StremioService;
  readonly gateway: StremioAddonGateway;
  readonly realDebrid?: RealDebridClient;
  readonly mediaRelay?: RealDebridMediaRelay;
  readonly subtitleRelay?: SubtitleRelay;
  readonly embeddedSubtitles?: EmbeddedSubtitleRelay;
  readonly subdl?: SubdlClient;
  readonly skipTimes?: SkipTimesClient;
  readonly diagnostics?: DiagnosticsLog;
  readonly webOrigin: string;
  readonly adminPassword?: string;
  // Ausente por padrão (inclusive nos testes): calcular o hash de arquivo é uma chamada de rede a
  // mais por resolução, e só faz sentido quando alguém a implementa de propósito (produção usa
  // `computeRemoteFileHash`, de opensubtitles-hash.ts).
  readonly fileHash?: (url: string) => Promise<RemoteFileHash | null>;
}

// Extrai só o NOME do arquivo do link do Real-Debrid — nunca a URL em si, que carrega o token de
// acesso do relay/host. Último segmento do caminho, decodificado; qualquer formato inesperado
// (URL sem caminho, nome vazio) vira `undefined` em vez de lançar.
function filenameFromRealDebridUrl(url: string): string | undefined {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    const last = segments.at(-1);
    if (!last) return undefined;
    const decoded = decodeURIComponent(last).replace(/[\u0000-\u001f\u007f]/g, "").trim();
    return decoded.length > 0 && decoded.length <= 255 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

// Módulo, não uma propriedade em `Scope`: `knownError` já recebe só `(error, reply)`, sem a
// casa, e reabrir a assinatura de toda rota só para anotar diagnóstico seria a cauda balançando
// o cachorro. `WeakMap` some sozinho quando a requisição termina — nenhuma entrada persiste
// além do ciclo de vida do `FastifyRequest`.
const requestHousehold = new WeakMap<FastifyRequest, string>();
const requestKnownError = new WeakMap<FastifyRequest, {
  readonly code: string;
  readonly message: string;
  readonly detail?: string;
}>();

interface Scope {
  readonly householdId: string;
  readonly session: AuthSession;
  /** Decide se as defesas de navegador valem para esta requisição. Ver tarefas 4 e 8. */
  readonly source: SessionTokenSource;
}

/**
 * O repasse existe para o navegador, onde a URL da fonte apareceria nas ferramentas de
 * desenvolvedor. Cliente nativo guarda o link dentro do próprio app, e mandá-lo pelo repasse
 * faria a VM de 1 OCPU retransmitir vídeo sem ganho nenhum. É a mesma decisão que o
 * `/streams/resolve` já tomava; aqui ela estava faltando.
 *
 * Alcance real desta função, medido no código: o Torrentio RD e o Orion são
 * `isBrowserOnlyAddon`, então o servidor nunca os consulta e as fontes `[RD+]` não chegam
 * aqui — elas entram por `/browser-streams/import`, que deliberadamente não repassa. E o
 * ThePirateBay+ só devolve `infoHash`, ou seja `kind: "torrent"`, que esta função não toca.
 * Com a lista de add-ons de hoje isto é quase um no-op; vale pela correção e pelo add-on
 * seguinte que devolver `direct`.
 */
function relayDirectStreams(
  response: StremioStreamsResponse,
  householdId: string,
  options: StremioRoutesOptions,
  source: SessionTokenSource
): StremioStreamsResponse {
  if (source === "bearer") return response;
  if (!options.mediaRelay) return response;
  return {
    streams: response.streams.map((stream) => stream.kind === "direct"
      ? {
          ...stream,
          url: new URL(
            `/v1/stremio/streams/media/${options.mediaRelay!.issue(householdId, stream.url)}`,
            options.webOrigin
          ).href
        }
      : stream)
  };
}

async function scope(request: FastifyRequest, options: StremioRoutesOptions): Promise<Scope> {
  const credential = readRequestSessionToken(request);
  if (credential === null) throw new AuthenticationError();
  const session = await options.authProvider.verifySession(credential.token);
  // A casa é garantida em qualquer rota autenticada; NOT_LINKED passa a
  // significar apenas "sem conta Stremio vinculada", nunca "casa inexistente".
  const household = await options.households.ensureHouseholdForOwner(session.user.id);
  requestHousehold.set(request, household.id);
  return { householdId: household.id, session, source: credential.source };
}

function knownError(error: unknown, reply: FastifyReply): FastifyReply {
  if (isAuthenticationError(error)) {
    return reply.code(401).send({
      error: { code: "AUTHENTICATION_FAILED", message: "Não foi possível autenticar." }
    });
  }
  if (error instanceof RealDebridError) {
    // Este módulo não tinha UMA linha de log, e por isso um 503 no navegador não dizia nada:
    // não dava para saber se o Real-Debrid recusou, demorou, ou devolveu algo inesperado. Sem
    // isso, investigar problema de reprodução vira aposta. O detail traz endpoint e status; o
    // token e o link liberado ficam fora por construção.
    reply.log.warn(
      { realDebrid: error.code, detail: error.detail, rota: reply.request.routeOptions.url },
      "Real-Debrid recusou a operação"
    );
    const message = error.code === "NOT_CONFIGURED"
      ? "O Real-Debrid ainda não foi configurado no servidor."
      : error.code === "AUTHENTICATION_FAILED"
        ? "O Real-Debrid recusou a credencial configurada."
        : error.code === "TRAFFIC_EXHAUSTED"
          ? "O tráfego remoto do Real-Debrid está esgotado. Ative o serviço ou abra no Stremio Desktop."
        : error.code === "INFRINGING_FILE"
          ? "O Real-Debrid bloqueou este arquivo. Tente outra opção ou use uma fonte RD+ pronta."
        : error.code === "NOT_PLAYABLE_FILE"
          ? "Esta fonte veio compactada, não é um vídeo que dê para abrir. Escolha outra opção."
        : "O Real-Debrid não respondeu como esperado.";
    // 409 para as três condições permanentes DESTA fonte: repetir não muda, e o cliente deve
    // oferecer outra opção em vez de tentar de novo.
    const responseCode = error.code === "TRAFFIC_EXHAUSTED" || error.code === "INFRINGING_FILE" ||
      error.code === "NOT_PLAYABLE_FILE"
      ? 409 : error.code === "AUTHENTICATION_FAILED" ? 502 : 503;
    const code = error.code === "TRAFFIC_EXHAUSTED"
      ? "REAL_DEBRID_TRAFFIC_EXHAUSTED"
      : error.code === "INFRINGING_FILE" ? "REAL_DEBRID_FILE_BLOCKED"
      : error.code === "NOT_PLAYABLE_FILE" ? "SOURCE_NOT_PLAYABLE" : "REAL_DEBRID_UNAVAILABLE";
    requestKnownError.set(reply.request, { code, message, detail: error.detail });
    return reply.code(responseCode).send({ error: { code, message } });
  }
  if (error instanceof MediaRelayError) {
    reply.log.warn(
      { relay: error.code, rota: reply.request.routeOptions.url },
      "Relay de mídia não entregou a fonte"
    );
    const message = "Esta opção expirou ou não está mais disponível.";
    requestKnownError.set(reply.request, { code: "MEDIA_UNAVAILABLE", message });
    return reply.code(error.code === "NOT_FOUND" ? 404 : 502).send({
      error: { code: "MEDIA_UNAVAILABLE", message }
    });
  }
  if (error instanceof StremioIntegrationError) {
    if (error.code === "NOT_LINKED") {
      const message = "Vincule sua conta Stremio para continuar.";
      requestKnownError.set(reply.request, { code: "STREMIO_NOT_LINKED", message });
      return reply.code(409).send({
        error: { code: "STREMIO_NOT_LINKED", message }
      });
    }
    if (error.code === "ADDON_NOT_FOUND") {
      const message = "Conteúdo não encontrado.";
      requestKnownError.set(reply.request, { code: "STREMIO_RESOURCE_NOT_FOUND", message });
      return reply.code(404).send({
        error: { code: "STREMIO_RESOURCE_NOT_FOUND", message }
      });
    }
    if (error.code === "AUTHENTICATION_FAILED") {
      const message = "O Stremio não aceitou as credenciais informadas.";
      requestKnownError.set(reply.request, { code: "STREMIO_LINK_FAILED", message });
      // 422 (e não 401): o web trata 401 como sessão Cebola expirada.
      return reply.code(422).send({
        error: { code: "STREMIO_LINK_FAILED", message }
      });
    }
    if (error.code === "INVALID_RESPONSE") {
      const message = "O Stremio ou um addon respondeu em um formato inesperado.";
      requestKnownError.set(reply.request, { code: "STREMIO_UPSTREAM_INVALID", message });
      return reply.code(502).send({
        error: { code: "STREMIO_UPSTREAM_INVALID", message }
      });
    }
    const message = "O Stremio ou um addon não respondeu com segurança.";
    requestKnownError.set(reply.request, { code: "STREMIO_UNAVAILABLE", message });
    return reply.code(502).send({
      error: { code: "STREMIO_UNAVAILABLE", message }
    });
  }
  throw error;
}

export async function registerStremioRoutes(
  app: FastifyInstance,
  options: StremioRoutesOptions
): Promise<void> {
  // Somado ao limite por sessão de cada rota, não no lugar dele. Cabe uma casa inteira: são
  // ~4 sessões gastando import + resolve ao mesmo tempo, sem chegar perto do teto.
  const playbackIpCeiling = ipCeilingHook(app, { max: 400, timeWindow: "5 minutes" });
  // O relay entrega o vídeo em pedaços, então o volume normal é outra ordem de grandeza.
  const mediaIpCeiling = ipCeilingHook(app, { max: 3_000, timeWindow: "15 minutes" });
  const adminUnlocks = new Map<string, number>();
  // Busca em tempo real na tela dedicada repete a mesma pergunta a cada digitação corrigida ou
  // prefixo retomado; este cache evita reabrir os add-ons da casa por isso (ver search-cache.ts).
  const searchCache = new SearchResultCache<readonly StremioSearchItem[]>();
  const adminBody = z.object({ password: z.string().min(1).max(128) });
  const adminKey = (request: FastifyRequest): string | null => readRequestSessionToken(request)?.token ?? null;
  const adminIsUnlocked = (request: FastifyRequest): boolean => {
    if (!options.adminPassword) return true;
    const key = adminKey(request);
    const expiresAt = key ? adminUnlocks.get(key) : undefined;
    if (!key || !expiresAt || expiresAt <= Date.now()) {
      if (key) adminUnlocks.delete(key);
      return false;
    }
    return true;
  };

  const DIAGNOSTICS_ROUTE = "/v1/stremio/diagnostics";

  // Alimenta o próprio "Registro de erros" (ver diagnostics-log.ts): qualquer resposta de erro
  // de uma rota autenticada desta casa vira uma entrada "servidor", sem precisar de uma chamada
  // a mais em cada rota. 401 fica fora de propósito — sessão expirada não é o tipo de problema
  // que o dono precisa ver reportado da TV, e aconteceria a cada abertura de app depois do
  // logout. As rotas de diagnóstico ficam de fora também, para uma delas falhando (ex.: 403
  // trancada) não virar um registro sobre si mesma.
  app.addHook("onResponse", async (request, reply) => {
    if (!options.diagnostics) return;
    if (reply.statusCode < 400 || reply.statusCode === 401) return;
    if (request.routeOptions.url === DIAGNOSTICS_ROUTE) return;
    const householdId = requestHousehold.get(request);
    if (!householdId) return;
    const known = requestKnownError.get(request);
    options.diagnostics.record(householdId, {
      origin: "servidor",
      code: known?.code ?? `HTTP_${reply.statusCode}`,
      message: known?.message ?? "",
      route: request.routeOptions.url,
      status: reply.statusCode,
      detail: known?.detail
    });
  });

  app.get("/v1/stremio/admin", async (request, reply) => {
    try {
      await scope(request, options);
      return reply.send({ unlocked: adminIsUnlocked(request) });
    } catch (error) {
      return knownError(error, reply);
    }
  });

  app.post("/v1/stremio/admin", {
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } }
  }, async (request, reply) => {
    const credential = readRequestSessionToken(request);
    if (!requireTrustedOrigin(request, reply, options.webOrigin, credential?.source ?? null)) return reply;
    const body = adminBody.safeParse(request.body);
    if (!body.success || !credential) return reply.code(400).send({ error: { code: "INVALID_REQUEST" } });
    try {
      await scope(request, options);
      const expected = Buffer.from(options.adminPassword ?? "");
      const received = Buffer.from(body.data.password);
      const valid = expected.length === received.length && timingSafeEqual(expected, received);
      if (!valid) return reply.code(403).send({ error: { code: "ADMIN_PASSWORD_INVALID", message: "Senha incorreta." } });
      adminUnlocks.set(credential.token, Date.now() + 30 * 60_000);
      return reply.send({ unlocked: true });
    } catch (error) {
      return knownError(error, reply);
    }
  });

  app.get("/v1/stremio/status", async (request, reply) => {
    try {
      const current = await scope(request, options);
      return reply.send(stremioStatusResponseSchema.parse(
        await options.service.status(current.householdId)
      ));
    } catch (error) {
      return knownError(error, reply);
    }
  });

  app.post("/v1/stremio/link", {
    config: { rateLimit: { max: 3, timeWindow: "15 minutes" } }
  }, async (request, reply) => {
    if (!adminIsUnlocked(request)) return reply.code(403).send({ error: { code: "STREMIO_ADMIN_LOCKED", message: "Área administrativa bloqueada." } });
    const credential = readRequestSessionToken(request);
    if (!requireTrustedOrigin(request, reply, options.webOrigin, credential?.source ?? null)) return reply;
    const body = stremioLinkRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: { code: "INVALID_REQUEST", message: "Credenciais Stremio inválidas." }
      });
    }
    try {
      const current = await scope(request, options);
      const status = await options.service.link(
        current.householdId,
        body.data.email,
        body.data.password
      );
      return reply.send(stremioStatusResponseSchema.parse(status));
    } catch (error) {
      return knownError(error, reply);
    }
  });

  app.post("/v1/stremio/sync", {
    config: { rateLimit: { max: 5, timeWindow: "5 minutes" } }
  }, async (request, reply) => {
    if (!adminIsUnlocked(request)) return reply.code(403).send({ error: { code: "STREMIO_ADMIN_LOCKED", message: "Área administrativa bloqueada." } });
    const credential = readRequestSessionToken(request);
    if (!requireTrustedOrigin(request, reply, options.webOrigin, credential?.source ?? null)) return reply;
    try {
      const current = await scope(request, options);
      return reply.send(stremioStatusResponseSchema.parse(
        await options.service.sync(current.householdId)
      ));
    } catch (error) {
      return knownError(error, reply);
    }
  });

  app.delete("/v1/stremio/link", async (request, reply) => {
    if (!adminIsUnlocked(request)) return reply.code(403).send({ error: { code: "STREMIO_ADMIN_LOCKED", message: "Área administrativa bloqueada." } });
    const credential = readRequestSessionToken(request);
    if (!requireTrustedOrigin(request, reply, options.webOrigin, credential?.source ?? null)) return reply;
    try {
      const current = await scope(request, options);
      await options.service.disconnect(current.householdId);
      return reply.code(204).send();
    } catch (error) {
      return knownError(error, reply);
    }
  });

  app.get("/v1/stremio/catalogs", async (request, reply) => {
    try {
      const current = await scope(request, options);
      const addons = await options.service.addons(current.householdId);
      return reply.send(stremioCatalogsResponseSchema.parse({
        catalogs: options.gateway.listCatalogs(addons)
      }));
    } catch (error) {
      return knownError(error, reply);
    }
  });

  app.get("/v1/stremio/catalog/:addonId/:type/:catalogId", async (request, reply) => {
    const params = catalogParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST" } });
    try {
      const current = await scope(request, options);
      const addons = await options.service.addons(current.householdId);
      return reply.send(stremioCatalogResponseSchema.parse(await options.gateway.catalog(
        addons,
        params.data.addonId,
        params.data.type,
        params.data.catalogId
      )));
    } catch (error) {
      return knownError(error, reply);
    }
  });

  app.get("/v1/stremio/search", {
    // A tela dedicada de busca consulta a cada poucas letras digitadas (debounce de ~350ms no
    // cliente); 30 a cada 5 minutos era o teto do antigo popover ocasional, não de filtragem ao
    // vivo. O cache acima absorve boa parte da repetição antes mesmo de chegar aqui.
    config: { rateLimit: { max: 150, timeWindow: "5 minutes", keyGenerator: sessionRateLimitKey } }
  }, async (request, reply) => {
    const query = searchQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST" } });
    try {
      const current = await scope(request, options);
      const cached = searchCache.get(current.householdId, query.data.q);
      if (cached) return reply.send({ items: cached });
      const addons = await options.service.addons(current.householdId);
      const { items, complete } = await options.gateway.search(addons, query.data.q);
      // Resultado parcial (algum catálogo passou do prazo) não fica no cache: a próxima busca
      // igual precisa ter a chance de trazer o que chegou atrasado.
      if (complete) searchCache.set(current.householdId, query.data.q, items);
      return reply.send({ items });
    } catch (error) { return knownError(error, reply); }
  });

  app.get("/v1/stremio/meta/:addonId/:type/:mediaId", async (request, reply) => {
    const params = metaParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST" } });
    try {
      const current = await scope(request, options);
      const addons = await options.service.addons(current.householdId);
      return reply.send(stremioMetaResponseSchema.parse(await options.gateway.meta(
        addons,
        params.data.addonId,
        params.data.type,
        params.data.mediaId
      )));
    } catch (error) {
      return knownError(error, reply);
    }
  });

  app.get("/v1/stremio/streams/:type/:videoId", async (request, reply) => {
    const params = streamParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST" } });
    try {
      const current = await scope(request, options);
      const addons = await options.service.addons(current.householdId);
      const response = await options.gateway.streams(
        addons,
        params.data.type,
        params.data.videoId
      );
      return reply.send(stremioStreamsResponseSchema.parse(
        relayDirectStreams(response, current.householdId, options, current.source)
      ));
    } catch (error) {
      return knownError(error, reply);
    }
  });

  app.get("/v1/stremio/subtitles/:type/:videoId", async (request, reply) => {
    const params = streamParams.safeParse(request.params);
    const fileHints = subtitleFileHintsQuery.safeParse(request.query);
    if (!params.success || !fileHints.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST" } });
    try {
      const current = await scope(request, options);
      // Extra do protocolo Stremio (videoHash/videoSize/filename): só existe quando a página já
      // escolheu uma fonte e sabe o arquivo de verdade. Vai para TODO add-on consultado — um que
      // não reconheça o extra apenas devolve 404 para aquela chamada específica (allSettled já
      // trata isso como lista vazia), nunca quebra a busca inteira.
      const extra = fileHints.data.videoHash || fileHints.data.videoSize || fileHints.data.filename
        ? {
            ...(fileHints.data.videoHash ? { videoHash: fileHints.data.videoHash } : {}),
            ...(fileHints.data.videoSize ? { videoSize: String(fileHints.data.videoSize) } : {}),
            ...(fileHints.data.filename ? { filename: fileHints.data.filename } : {})
          }
        : undefined;
      const [addonResult, subdlResult] = await Promise.allSettled([
        options.service.addons(current.householdId).then((addons) =>
          options.gateway.subtitles(addons.filter((addon) =>
            addon.manifest.id !== OPEN_SUBTITLES_V3.manifest.id), params.data.type, params.data.videoId, extra)),
        options.subdl?.subtitles(params.data.type, params.data.videoId, fileHints.data.filename) ?? Promise.resolve([])
      ]);
      const existing = [
        ...(addonResult.status === "fulfilled" ? addonResult.value : []),
        ...(subdlResult.status === "fulfilled" ? subdlResult.value : [])
      ];
      // Consulta a fonte pública quando as fontes da conta não trouxeram português, OU quando já
      // temos um arquivo escolhido: o OpenSubtitles é a única fonte que casa por HASH de arquivo,
      // então vale a pena tentar achar a sincronizada mesmo havendo PT de outro release.
      const hasPortuguese = existing.some((subtitle) => /^(?:pt|por|pob|pb)(?:[-_].*)?$/i.test(subtitle.language));
      const official = (extra || !hasPortuguese) ? await collectWithin(
        officialSubtitleIds(params.data.type, params.data.videoId).map((id) =>
          options.gateway.subtitles([OPEN_SUBTITLES_V3], params.data.type, id, extra)), 3_000) : [];
      if (addonResult.status === "rejected" && subdlResult.status === "rejected" && official.length === 0) {
        throw addonResult.reason;
      }
      const seenUrls = new Set<string>();
      const distinct = [...existing, ...official].filter((subtitle) => {
        if (seenUrls.has(subtitle.url)) return false;
        seenUrls.add(subtitle.url);
        return true;
      });
      const usedLabels = new Map<string, Set<string>>();
      const subtitles = distinct.map((subtitle) => {
        const labels = usedLabels.get(subtitle.addonName) ?? new Set<string>();
        let label = subtitle.label;
        if (labels.has(label)) {
          const base = label.replace(/ \d+$/, "");
          let number = 2;
          while (labels.has(`${base} ${number}`)) number += 1;
          label = `${base} ${number}`;
        }
        labels.add(label);
        usedLabels.set(subtitle.addonName, labels);
        return label === subtitle.label ? subtitle : { ...subtitle, label };
      });
      return reply.send({
        subtitles: subtitles.map((subtitle) => ({
          ...subtitle,
          url: options.subtitleRelay
            ? `/v1/stremio/subtitles/file/${options.subtitleRelay.issue(subtitle.url)}/subtitle.vtt`
            : subtitle.url
        }))
      });
    } catch (error) { return knownError(error, reply); }
  });

  // Abertura/recapitulação/encerramento de anime (ARM + AniSkip). Só séries têm dado; filme e
  // qualquer falha externa devolvem lista vazia, nunca erro — quem chama decide o fallback.
  app.get("/v1/stremio/skip-times/:type/:videoId", async (request, reply) => {
    const params = streamParams.safeParse(request.params);
    const query = skipTimesQuery.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST" } });
    try {
      await scope(request, options);
      const segments = options.skipTimes
        ? await options.skipTimes.skipTimes(params.data.type, params.data.videoId, query.data.absolute)
        : [];
      return reply.send(skipTimesResponseSchema.parse({ segments }));
    } catch (error) {
      return knownError(error, reply);
    }
  });

  app.get("/v1/stremio/subtitles/file", {
    config: { rateLimit: { max: 30, timeWindow: "5 minutes" } }
  }, async (request, reply) => {
    const query = subtitleFileQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST" } });
    try {
      await scope(request, options);
      const source = await getSafeText(query.data.url);
      reply.header("content-type", "text/vtt; charset=utf-8");
      reply.header("cache-control", "private, max-age=3600");
      return reply.send(subtitleToVtt(source));
    } catch (error) { return knownError(error, reply); }
  });

  app.get("/v1/stremio/subtitles/file/:ticket/subtitle.vtt", {
    config: { rateLimit: { max: 60, timeWindow: "5 minutes" } }
  }, async (request, reply) => {
    const params = mediaTicketParams.safeParse(request.params);
    if (!params.success || !options.subtitleRelay) return reply.code(404).send();
    try {
      const source = await options.subtitleRelay.open(params.data.ticket);
      reply.header("content-type", "text/vtt; charset=utf-8");
      reply.header("cache-control", "private, max-age=3600");
      return reply.send(subtitleToVtt(source));
    } catch (error) {
      if (error instanceof SubtitleRelayError) return reply.code(404).send();
      return knownError(error, reply);
    }
  });

  // Legendas embutidas no MKV (a TV Samsung toca o arquivo mas não expõe as faixas). POST porque a
  // URL da mídia carrega token e o corpo não vai para log. Falha de leitura/formato nunca é erro:
  // sem faixas indexadas a resposta é só a lista vazia, e o player segue sem esta fonte.
  app.post("/v1/stremio/subtitles/embedded", {
    onRequest: playbackIpCeiling,
    config: { rateLimit: { max: 30, timeWindow: "5 minutes", keyGenerator: sessionRateLimitKey } }
  }, async (request, reply) => {
    const credential = readRequestSessionToken(request);
    if (!requireTrustedOrigin(request, reply, options.webOrigin, credential?.source ?? null)) return reply;
    const body = embeddedSubtitlesBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST" } });
    try {
      const currentScope = await scope(request, options);
      const relay = options.embeddedSubtitles;
      if (!relay) return reply.send({ subtitles: [] });
      let mediaUrl: string;
      let parsed: URL;
      try { parsed = new URL(body.data.url, options.webOrigin); }
      catch { return reply.code(400).send({ error: { code: "INVALID_REQUEST" } }); }
      const own = MEDIA_RELAY_PATH.exec(parsed.pathname);
      if (own) {
        if (!options.mediaRelay) return reply.send({ subtitles: [] });
        // Só o caminho importa: o host da URL recebida nunca é contatado, o link vem do ticket.
        mediaUrl = options.mediaRelay.resolveUrl(own[1]!, currentScope.householdId);
      } else {
        mediaUrl = parsed.href;
      }
      try {
        await validatePublicMediaUrl(mediaUrl, { allowInsecure: false });
      } catch {
        return reply.code(400).send({ error: { code: "INVALID_REQUEST" } });
      }
      let listed: Awaited<ReturnType<EmbeddedSubtitleRelay["list"]>>;
      try {
        listed = await relay.list(mediaUrl);
      } catch {
        // Não é MKV, sem índice, servidor sem Range, timeout: tudo vira "sem legendas embutidas".
        return reply.send({ subtitles: [] });
      }
      // Pré-aquecimento: o player só pede o VTT depois, e a extração demora. Em segundo plano,
      // sem await; o relay junta esta chamada com a do player na mesma Promise.
      for (const track of listed.tracks) {
        if (/^(?:pt|por|pob|pb)(?:[-_].*)?$/i.test(track.language)) {
          void relay.open(listed.ticket, track.number).catch(() => {});
        }
      }
      const used = new Map<string, number>();
      return reply.send({
        subtitles: listed.tracks.map((track) => {
          const named = subtitleLanguageName(track.language);
          const base = named ?? (track.name || track.language);
          const count = (used.get(base) ?? 0) + 1;
          used.set(base, count);
          const trackName = track.name.trim();
          const details = trackName && trackName.toLocaleLowerCase() !== base.toLocaleLowerCase()
            ? trackName.slice(0, 200) : undefined;
          return {
            id: `embedded:${track.number}`,
            addonName: "Arquivo",
            label: count === 1 ? base : `${base} ${count}`,
            ...(details ? { details } : {}),
            language: track.language,
            url: `/v1/stremio/subtitles/embedded/${listed.ticket}/${track.number}/subtitle.vtt`
          };
        })
      });
    } catch (error) {
      return knownError(error, reply);
    }
  });

  app.get("/v1/stremio/subtitles/embedded/:ticket/:track/subtitle.vtt", {
    // Declarado na config porque o hook onSend ignora Cache-Control escrito no reply. Extrair custa
    // dezenas de Range, então vale deixar o aparelho reutilizar por uma hora (o ticket é o segredo).
    config: {
      rateLimit: { max: 60, timeWindow: "5 minutes" },
      cacheControl: "private, max-age=3600"
    }
  }, async (request, reply) => {
    const params = embeddedSubtitleParams.safeParse(request.params);
    if (!params.success || !options.embeddedSubtitles) return reply.code(404).send();
    try {
      const vtt = await options.embeddedSubtitles.open(params.data.ticket, Number(params.data.track));
      reply.header("content-type", "text/vtt; charset=utf-8");
      reply.header("cache-control", "private, max-age=3600");
      return reply.send(vtt);
    } catch (error) {
      if (error instanceof EmbeddedSubtitleError) return reply.code(404).send();
      // Falha na extração (arquivo mudou, link expirou): 404 sem detalhes, e nada da URL em log.
      return reply.code(404).send();
    }
  });

  // Alguns add-ons bloqueiam IPs de datacenter. O Stremio Web funciona porque também consulta
  // a partir do navegador do próprio usuário. Esta rota entrega os alvos HTTPS validados da
  // conta; a resposta é privada e nunca entra nos logs.
  app.get("/v1/stremio/browser-stream-targets/:type/:videoId", async (request, reply) => {
    const params = streamParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST" } });
    try {
      const current = await scope(request, options);
      const addons = await options.service.addons(current.householdId);
      reply.header("cache-control", "private, no-store");
      return reply.send({
        targets: await options.gateway.browserStreamTargets(addons, params.data.type, params.data.videoId)
      });
    } catch (error) {
      return knownError(error, reply);
    }
  });

  app.post("/v1/stremio/browser-streams/import", {
    // Uma chamada por add-on consultado pelo navegador, a cada episódio aberto. Com vários
    // add-ons, 30 acabava em poucos episódios e a lista passava a chegar incompleta em silêncio.
    onRequest: playbackIpCeiling,
    config: { rateLimit: {
      max: 90,
      timeWindow: "5 minutes",
      keyGenerator: sessionRateLimitKey
    } }
  }, async (request, reply) => {
    const credential = readRequestSessionToken(request);
    if (!requireTrustedOrigin(request, reply, options.webOrigin, credential?.source ?? null)) return reply;
    const body = browserStreamImport.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST" } });
    try {
      const current = await scope(request, options);
      const addons = await options.service.addons(current.householdId);
      // Estas fontes NÃO passam pelo relay, e a razão é a mesma que faz esta rota existir: o
      // navegador só importa payload de add-on porque o IP da VM é bloqueado por eles (ver
      // browser-stream-targets acima). O Torrentio devolve a mídia no mesmo host que bloqueia o
      // servidor — torrentio.strem.fun/resolve/... —, então retransmitir daqui manda a VM buscar
      // exatamente onde ela não é aceita, e nenhuma opção toca. O sigilo que o relay dá também
      // não se aplica aqui: o navegador já buscou o add-on com o token dele na URL, então a
      // credencial já está do lado do cliente e esconder o destino não protege mais nada.
      const response = await options.gateway.normalizeBrowserStreamPayload(
        addons, body.data.addonId, body.data.payload
      );
      return reply.send(stremioStreamsResponseSchema.parse(response));
    } catch (error) {
      return knownError(error, reply);
    }
  });

  app.post("/v1/stremio/streams/resolve", {
    // Era 12 por 5 minutos, e uma única tentativa de assistir pode gastar 4 (MAX_AUTOMATIC_
    // FALLBACKS no cliente, quando a fonte não abre). Três tentativas e a reprodução parava de
    // funcionar por cinco minutos, sem explicação na tela: só 429 no console.
    // 40 dá dez tentativas com troca completa de fonte, ou quarenta episódios abrindo de
    // primeira. Cada resolve custa ~4 chamadas ao Real-Debrid, então 40 por 5 minutos são ~32
    // chamadas por minuto — bem abaixo do que a conta aguenta.
    onRequest: playbackIpCeiling,
    config: { rateLimit: {
      max: 40,
      timeWindow: "5 minutes",
      keyGenerator: sessionRateLimitKey
    } }
  }, async (request, reply) => {
    const credential = readRequestSessionToken(request);
    if (!requireTrustedOrigin(request, reply, options.webOrigin, credential?.source ?? null)) return reply;
    const body = resolveTorrentStreamRequestSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST" } });
    try {
      const currentScope = await scope(request, options);
      if (!options.realDebrid) throw new RealDebridError("NOT_CONFIGURED");
      // O repasse existe só para o navegador, onde o link apareceria nas ferramentas de
      // desenvolvedor. Cliente nativo guarda o link dentro do próprio app — e a VM de 1 OCPU
      // não aguenta repassar 4K para vários aparelhos, nem entrega avanço rápido decente.
      const nativo = currentScope.source === "bearer";
      if (!nativo && !options.mediaRelay) throw new RealDebridError("NOT_CONFIGURED");
      const result = await options.realDebrid.resolveTorrent(body.data.infoHash, body.data.fileIdx);
      // Dispara o hash JÁ, em paralelo com o resto desta função — não faz sentido esperar montar
      // a URL de reprodução (síncrono) antes de começar a única parte lenta. 2.5s é bem menor que
      // o teto interno do próprio cálculo (4s): a resposta de reprodução nunca deve atrasar por
      // causa de um dado que é só um bônus para a legenda.
      const fileHashPromise = result.status === "ready" && options.fileHash
        ? resolveWithin(options.fileHash(result.url).catch(() => null), 2_500, null)
        : null;
      const playbackUrl = result.status !== "ready"
        ? undefined
        : nativo
          ? result.url
          : new URL(
              `/v1/stremio/streams/media/${options.mediaRelay!.issue(currentScope.householdId, result.url)}`,
              options.webOrigin
            ).href;
      const fileHash = fileHashPromise ? await fileHashPromise : null;
      const filename = result.status === "ready" ? filenameFromRealDebridUrl(result.url) : undefined;
      return reply.code(result.status === "ready" ? 200 : 202).send(
        resolveTorrentStreamResponseSchema.parse({
          ...result,
          ...(result.status === "ready" ? {
            url: playbackUrl,
            // Terceira cópia desta heurística vivia aqui, com .mkv dentro e livre para divergir
            // das outras duas. Agora é a mesma função do gateway, sobre o nome do arquivo que o
            // Real-Debrid devolveu — que às vezes diz mais que o título anunciado pelo add-on.
            mayNotPlay: streamMayNotPlay(decodeURIComponent(result.url)),
            ...(filename || fileHash ? {
              file: {
                ...(filename ? { name: filename } : {}),
                ...(fileHash ? { size: fileHash.size, hash: fileHash.hash } : {})
              }
            } : {})
          } : {})
        })
      );
    } catch (error) {
      return knownError(error, reply);
    }
  });

  app.get("/v1/stremio/streams/media/:ticket", {
    onRequest: mediaIpCeiling,
    config: { rateLimit: {
      max: 600,
      timeWindow: "15 minutes",
      keyGenerator: sessionRateLimitKey
    } }
  }, async (request, reply) => {
    const params = mediaTicketParams.safeParse(request.params);
    if (!params.success || !options.mediaRelay) return reply.code(404).send();
    try {
      const currentScope = await scope(request, options);
      const rangeHeader = request.headers.range;
      const range = Array.isArray(rangeHeader) ? rangeHeader[0] : rangeHeader;
      const method = request.method === "HEAD" ? "HEAD" : "GET";
      const upstream = await options.mediaRelay.open(params.data.ticket, currentScope.householdId, range, method);
      for (const header of ["accept-ranges", "content-length", "content-range", "content-type"] as const) {
        const value = upstream.headers.get(header);
        if (value !== null) reply.header(header, value);
      }
      reply.header("cache-control", "private, no-store");
      if (method === "HEAD") return reply.code(upstream.status).send();
      return reply.code(upstream.status).send(
        Readable.fromWeb(upstream.body as unknown as NodeReadableStream)
      );
    } catch (error) {
      return knownError(error, reply);
    }
  });

  // Só o dono (admin destrancado) lê e limpa o registro: ele carrega mensagem de todo aparelho
  // da casa, e às vezes um detalhe de rota/host que não precisa aparecer para quem só usa perfil.
  app.get(DIAGNOSTICS_ROUTE, {
    // Sem isto, o hook global de cache (app.ts) sobrescreve para "no-store" liso: ele só honra
    // um `Cache-Control` mais específico quando a rota declara a intenção aqui.
    config: { cacheControl: "private, no-store" }
  }, async (request, reply) => {
    if (!adminIsUnlocked(request)) {
      return reply.code(403).send({ error: { code: "STREMIO_ADMIN_LOCKED", message: "Área administrativa bloqueada." } });
    }
    try {
      const current = await scope(request, options);
      return reply.send({ entries: options.diagnostics?.list(current.householdId) ?? [] });
    } catch (error) {
      return knownError(error, reply);
    }
  });

  app.delete(DIAGNOSTICS_ROUTE, async (request, reply) => {
    if (!adminIsUnlocked(request)) {
      return reply.code(403).send({ error: { code: "STREMIO_ADMIN_LOCKED", message: "Área administrativa bloqueada." } });
    }
    const credential = readRequestSessionToken(request);
    if (!requireTrustedOrigin(request, reply, options.webOrigin, credential?.source ?? null)) return reply;
    try {
      const current = await scope(request, options);
      options.diagnostics?.clear(current.householdId);
      return reply.code(204).send();
    } catch (error) {
      return knownError(error, reply);
    }
  });

  // Sem trava de admin, de propósito: quem reporta é o aparelho que acabou de falhar, e é
  // exatamente ele — a TV, o projetor — que nunca vai ter a senha administrativa digitada. A
  // casa vem sempre da sessão validada por `scope`; o corpo nunca escolhe de quem é o erro.
  app.post(DIAGNOSTICS_ROUTE, {
    config: { rateLimit: {
      max: 60,
      timeWindow: "5 minutes",
      keyGenerator: sessionRateLimitKey
    } }
  }, async (request, reply) => {
    const credential = readRequestSessionToken(request);
    if (!requireTrustedOrigin(request, reply, options.webOrigin, credential?.source ?? null)) return reply;
    const body = diagnosticsReportBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST" } });
    try {
      const current = await scope(request, options);
      options.diagnostics?.record(current.householdId, {
        origin: "aparelho",
        code: body.data.code,
        message: body.data.message,
        context: body.data.context,
        device: body.data.device
      });
      return reply.code(204).send();
    } catch (error) {
      return knownError(error, reply);
    }
  });
}
