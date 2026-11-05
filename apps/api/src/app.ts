import { STATUS_CODES } from "node:http";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, {
  LogController,
  type FastifyError,
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions
} from "fastify";
import { healthResponseSchema } from "@cebola/contracts";
import type { Environment } from "./env.js";
import { DevicePairingStore, registerAuthRoutes, type AuthProvider } from "./auth/index.js";
import type { HouseholdRepository, HouseholdService } from "./households/index.js";
import { registerProfileRoutes, type ProfilePinService } from "./profiles/index.js";
import { registerProgressRoutes, type WatchProgressService } from "./progress/index.js";
import { registerLibraryRoutes, type LibraryService } from "./library/index.js";
import {
  registerStremioRoutes,
  DiagnosticsLog,
  type RealDebridClient,
  type RealDebridMediaRelay,
  type RemoteFileHash,
  type SubtitleRelay,
  type EmbeddedSubtitleRelay,
  type SubdlClient,
  type SkipTimesClient,
  type StremioAddonGateway,
  type StremioService
} from "./stremio/index.js";
import { corsPolicy } from "./cors-policy.js";
import { clientIpRateLimitKey } from "./rate-limit-key.js";
import { registerEditorialRoutes, type TmdbClient } from "./editorial/index.js";
import { registerHomeRoutes } from "./home/routes.js";
import { registerBookRoutes, type BookRoutesOptions } from "./books/routes.js";

/**
 * Política de cache declarada pela rota. Ver o hook `onSend` mais abaixo: é a ÚNICA forma de
 * uma resposta escapar do `no-store` padrão. Escrever o cabeçalho no reply não basta, de
 * propósito — foi assim que duas rotas de legenda quase entraram em cache sem ninguém pedir.
 */
declare module "fastify" {
  interface FastifyContextConfig {
    cacheControl?: string;
  }
}

export interface AppDependencies {
  readonly books?: Omit<BookRoutesOptions, "authProvider">;
  readonly authProvider?: AuthProvider;
  readonly householdRepository?: HouseholdRepository;
  readonly householdService?: HouseholdService;
  readonly pinService?: ProfilePinService;
  readonly progressService?: WatchProgressService;
  readonly libraryService?: LibraryService;
  readonly stremioService?: StremioService;
  readonly stremioGateway?: StremioAddonGateway;
  readonly realDebrid?: RealDebridClient;
  readonly realDebridMediaRelay?: RealDebridMediaRelay;
  // Ausente por padrão (inclusive em toda a suíte de testes hoje): sem isto, o resolve nunca
  // calcula hash de arquivo — nenhum teste existente ganha uma chamada de rede de surpresa.
  readonly fileHash?: (url: string) => Promise<RemoteFileHash | null>;
  readonly subtitleRelay?: SubtitleRelay;
  readonly embeddedSubtitles?: EmbeddedSubtitleRelay;
  readonly subdl?: SubdlClient;
  readonly skipTimes?: SkipTimesClient;
  readonly tmdb?: TmdbClient;
  // Opções do logger, para testes injetarem um stream e inspecionarem os logs.
  // Ausente, vale o default: logger ligado fora de NODE_ENV=test.
  readonly loggerOptions?: FastifyServerOptions["logger"];
  readonly now?: () => Date;
}

// Marcador logado quando a request não casa com rota registrada (404); a URL
// pedida nunca entra no log.
const UNMATCHED_ROUTE_LABEL = "(rota não registrada)";

function routePattern(request: FastifyRequest): string {
  return request.routeOptions.url ?? UNMATCHED_ROUTE_LABEL;
}

// Chave de rate limit por cliente real quando a API roda atrás do proxy.
// Topologia de produção: cliente → Cloudflare edge → cloudflared → Caddy → API,
// sem nenhum caminho até a API que não passe pelo edge, e o edge sempre
// sobrescreve CF-Connecting-IP com o IP real — por isso o header é confiável
// aqui. X-Forwarded-For não serve de chave: proxies apenas fazem append, então
// o primeiro elemento é forjável pelo cliente. Sem o header (tráfego interno),
// cai no IP do socket.
export async function buildApp(
  environment: Environment,
  dependencies: AppDependencies = {}
): Promise<FastifyInstance> {
  const trustProxy = environment.CEBOLA_TRUST_PROXY === true;
  const app = Fastify({
    logger: dependencies.loggerOptions ?? (environment.NODE_ENV !== "test"),
    // IDs de mídia aceitos pelos contratos precisam caber também nos paths de remoção.
    routerOptions: { maxParamLength: 255 },
    // Os logs padrão por request registram a URL concreta, e os paths do
    // Stremio carregam o que a casa assiste (addonId/mediaId/videoId). Aqui
    // eles são desligados por inteiro (incluindo o "Route not found" do 404)
    // e os hooks onResponse/onError abaixo repõem método, padrão da rota,
    // status e tempo — logs sem histórico de visualização.
    logController: new LogController({ disableRequestLogging: true }),
    // Só confie em headers de proxy quando existe proxy: em produção a API é
    // alcançável apenas via Cloudflare edge → cloudflared → Caddy. Em dev
    // (false) vale o comportamento atual, IP direto do socket.
    trustProxy
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "same-site" }
  });

  await app.register(cors, corsPolicy(environment.CEBOLA_WEB_ORIGIN));

  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
    hook: "onRequest",
    // Rotas públicas, principalmente login, precisam continuar presas ao IP mesmo quando o
    // cliente envia um cookie: o valor do cookie ainda não foi autenticado neste hook. As rotas
    // caras de reprodução sobrescrevem a chave por sessão em sua própria configuração.
    keyGenerator: trustProxy ? clientIpRateLimitKey : undefined
  });

  // Nada é guardado, a menos que a rota DECLARE a intenção em `config.cacheControl`.
  //
  // A primeira tentativa foi respeitar qualquer `Cache-Control` que a rota tivesse escrito no
  // reply. Parecia equivalente e não era: duas rotas de legenda já escreviam
  // `private, max-age=3600` havia tempo, e este hook vinha apagando isso silenciosamente.
  // Afrouxar aqui as ligou de uma vez — legenda de sessão autenticada passaria a descansar uma
  // hora no aparelho, servida a um `<track>` que não reautentica e sobrevivendo ao logout.
  //
  // Declarar na configuração é o que separa intenção de acidente: o cabeçalho escrito à mão
  // continua sendo sobrescrito, e só sai do `no-store` quem pediu, por escrito, na rota.
  app.addHook("onSend", async (request, reply) => {
    const declared = (request.routeOptions.config as { cacheControl?: string } | undefined)?.cacheControl;
    // Erro nunca é guardado: um 401 ou um 502 em cache é defeito grudado na tela.
    if (typeof declared === "string" && reply.statusCode < 400) {
      reply.header("Cache-Control", declared);
      reply.removeHeader("Pragma");
      return;
    }
    reply.header("Cache-Control", "no-store");
    reply.header("Pragma", "no-cache");
  });

  app.addHook("onResponse", async (request, reply) => {
    request.log.info({
      method: request.method,
      route: routePattern(request),
      statusCode: reply.statusCode,
      responseTime: reply.elapsedTime
    }, "requisição concluída");
  });

  app.addHook("onError", async (request, _reply, error) => {
    // O logController desliga também o error log padrão do Fastify; este hook
    // o repõe sem URL, com o mesmo critério de nível (5xx error, 4xx info).
    const details = { err: error, method: request.method, route: routePattern(request) };
    if ((error.statusCode ?? 500) >= 500) {
      request.log.error(details, "erro na requisição");
    } else {
      request.log.info(details, "erro na requisição");
    }
  });

  // Sem tratador global, QUALQUER exceção não tratada devolvia `err.message` verbatim ao
  // cliente — em rota pública inclusive, e inclusive mensagem vinda do driver do banco. O
  // `onError` acima já registra o erro de verdade no log; aqui só se decide o que sai na
  // resposta. Pendência 3 da spec do app nativo.
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const status = typeof error.statusCode === "number" ? error.statusCode : 500;
    // Abaixo de 500 o erro é deliberado: alguém escolheu aquele status e aquele texto, e o
    // cliente depende dele — o "retry in 1 minute" do rate limit é o caso vivo. Reproduz o
    // mesmo corpo que o Fastify já entregava, para nenhuma tela do site mudar de comportamento.
    if (status < 500) {
      return reply.code(status).send({
        statusCode: status,
        error: STATUS_CODES[status] ?? "Error",
        message: error.message
      });
    }
    return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "Erro interno." } });
  });

  app.get("/v1/health", {
    // Publicada na internet pelo Caddy: limite próprio generoso em vez de
    // isenção, para não deixar flood grátis contra a VM.
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async () => {
    return healthResponseSchema.parse({
      status: "ok",
      service: "cebola-api",
      timestamp: new Date().toISOString()
    });
  });

  // Não existe fallback com credenciais fictícias. As rotas só são
  // habilitadas quando o processo recebe explicitamente um provider seguro.
  if (dependencies.authProvider) {
    await registerBookRoutes(app, { webOrigin: environment.CEBOLA_WEB_ORIGIN, authProvider: dependencies.authProvider, ...dependencies.books });
    await registerAuthRoutes(app, {
      provider: dependencies.authProvider,
      webOrigin: environment.CEBOLA_WEB_ORIGIN,
      now: dependencies.now,
      devicePairing: new DevicePairingStore()
    });
  }

  if (
    dependencies.authProvider &&
    dependencies.householdRepository &&
    dependencies.householdService &&
    dependencies.pinService
  ) {
    await registerProfileRoutes(app, {
      authProvider: dependencies.authProvider,
      repository: dependencies.householdRepository,
      households: dependencies.householdService,
      pinService: dependencies.pinService,
      webOrigin: environment.CEBOLA_WEB_ORIGIN
    });
  }

  if (
    dependencies.authProvider &&
    dependencies.householdService &&
    dependencies.progressService
  ) {
    await registerProgressRoutes(app, {
      authProvider: dependencies.authProvider,
      households: dependencies.householdService,
      progress: dependencies.progressService,
      webOrigin: environment.CEBOLA_WEB_ORIGIN
    });
  }

  if (
    dependencies.authProvider &&
    dependencies.householdService &&
    dependencies.libraryService
  ) {
    await registerLibraryRoutes(app, {
      authProvider: dependencies.authProvider,
      households: dependencies.householdService,
      library: dependencies.libraryService,
      webOrigin: environment.CEBOLA_WEB_ORIGIN
    });
  }

  if (
    dependencies.authProvider &&
    dependencies.householdService &&
    dependencies.progressService &&
    dependencies.libraryService &&
    dependencies.stremioService
  ) {
    await registerHomeRoutes(app, {
      authProvider: dependencies.authProvider,
      households: dependencies.householdService,
      progress: dependencies.progressService,
      library: dependencies.libraryService,
      stremio: dependencies.stremioService
    });
  }

  if (
    dependencies.authProvider &&
    dependencies.householdService &&
    dependencies.stremioService &&
    dependencies.stremioGateway
  ) {
    await registerStremioRoutes(app, {
      authProvider: dependencies.authProvider,
      households: dependencies.householdService,
      service: dependencies.stremioService,
      gateway: dependencies.stremioGateway,
      realDebrid: dependencies.realDebrid,
      mediaRelay: dependencies.realDebridMediaRelay,
      fileHash: dependencies.fileHash,
      subtitleRelay: dependencies.subtitleRelay,
      embeddedSubtitles: dependencies.embeddedSubtitles,
      subdl: dependencies.subdl,
      skipTimes: dependencies.skipTimes,
      // Sempre uma instância nova por app: é só memória do processo, e cada `buildApp` de teste
      // precisa do próprio quadro em branco, sem herdar entrada de um teste anterior.
      diagnostics: new DiagnosticsLog(),
      webOrigin: environment.CEBOLA_WEB_ORIGIN,
      adminPassword: environment.CEBOLA_STREMIO_ADMIN_PASSWORD
    });
  }

  if (
    dependencies.authProvider &&
    dependencies.householdService &&
    dependencies.tmdb
  ) {
    await registerEditorialRoutes(app, {
      authProvider: dependencies.authProvider,
      households: dependencies.householdService,
      tmdb: dependencies.tmdb
    });
  }

  return app;
}
