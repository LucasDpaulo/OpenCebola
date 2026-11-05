import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  dailyFeaturedResponseSchema,
  editorialHomeResponseSchema,
  editorialSectionSchema,
  editorialTitleResponseSchema,
  emmyWinnersResponseSchema,
  mediaTypeSchema
} from "@cebola/contracts";
import {
  AuthenticationError,
  isAuthenticationError,
  readRequestSessionToken,
  type AuthProvider
} from "../auth/index.js";
import type { HouseholdService } from "../households/index.js";
import { ipCeilingHook, sessionRateLimitKey } from "../rate-limit-key.js";
import { TmdbClient, TmdbError } from "./client.js";

const paramsSchema = z.object({
  type: mediaTypeSchema,
  mediaId: z.string().trim().min(1).max(255).refine(
    (value) => !/[\u0000-\u001f\u007f/\\]/.test(value),
    "identificador inválido"
  )
});
const querySchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  year: z.coerce.number().int().min(1870).max(3_000).optional()
});
/**
 * `page` existe para o "+ Ver mais" das fileiras: a home abre com a página 1 e só busca a
 * seguinte quando alguém clica. O teto de 4 é a decisão do produto — 20 itens de entrada mais
 * três cliques de 20 — e também impede que a rota vire um raspador do TMDB via querystring.
 */
const MAX_PAGINAS_DA_HOME = 4;
const homeQuerySchema = z.object({
  section: editorialSectionSchema.default("home"),
  group: z.enum(["all", "primary", "providers"]).default("all"),
  page: z.coerce.number().int().min(1).max(MAX_PAGINAS_DA_HOME).default(1)
});

/**
 * Estas três rotas devolvem curadoria do TMDB, não dados da casa: o corpo é idêntico para
 * todo mundo e o servidor já o guardava 6 h em memória. Faltava dizer isso ao aparelho, que
 * refazia a pergunta a cada abertura para receber byte por byte a mesma resposta — e no
 * Android e no PC "cada abertura" é todo boot frio.
 *
 * `private` e não `public` porque a rota é autenticada: o corpo pode descansar no aparelho de
 * quem pediu, nunca num cache compartilhado no meio do caminho. E só em resposta de sucesso:
 * um 401 ou um 502 guardado seria um defeito grudado na tela.
 */
const CACHE_DAILY_FEATURED = "private, max-age=1800";
const CACHE_HOME = "private, max-age=300";
const CACHE_TITLE = "private, max-age=3600";

export interface EditorialRoutesOptions {
  readonly authProvider: AuthProvider;
  readonly households: HouseholdService;
  readonly tmdb: TmdbClient;
}

async function requireHousehold(request: FastifyRequest, options: EditorialRoutesOptions): Promise<void> {
  const credential = readRequestSessionToken(request);
  if (credential === null) throw new AuthenticationError();
  const session = await options.authProvider.verifySession(credential.token);
  await options.households.ensureHouseholdForOwner(session.user.id);
}

export async function registerEditorialRoutes(
  app: FastifyInstance,
  options: EditorialRoutesOptions
): Promise<void> {
  app.get("/v1/editorial/daily-featured", {
    config: { rateLimit: { max: 120, timeWindow: "1 minute" }, cacheControl: CACHE_DAILY_FEATURED }
  }, async (request, reply) => {
    try {
      return reply.send(dailyFeaturedResponseSchema.parse(await options.tmdb.dailyFeatured()));
    } catch (error) {
      if (error instanceof TmdbError) {
        return reply.code(error.code === "NOT_FOUND" ? 404 : 502).send({
          error: {
            code: error.code === "NOT_FOUND" ? "EDITORIAL_NOT_FOUND" : "EDITORIAL_UNAVAILABLE",
            message: "Destaque diário temporariamente indisponível."
          }
        });
      }
      throw error;
    }
  });

  app.get("/v1/editorial/home", {
    onRequest: ipCeilingHook(app, { max: 300, timeWindow: "5 minutes" }),
    config: {
      rateLimit: { max: 120, timeWindow: "5 minutes", keyGenerator: sessionRateLimitKey },
      cacheControl: CACHE_HOME
    }
  }, async (request, reply) => {
    const query = homeQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "Seção editorial inválida." } });
    }
    try {
      await requireHousehold(request, options);
      return reply.send(editorialHomeResponseSchema.parse(await options.tmdb.home(query.data.section, query.data.page, query.data.group)));
    } catch (error) {
      if (isAuthenticationError(error)) return reply.code(401).send({ error: { code: "AUTHENTICATION_FAILED", message: "Não foi possível autenticar." } });
      if (error instanceof TmdbError) return reply.code(502).send({ error: { code: "EDITORIAL_UNAVAILABLE", message: "A seleção editorial está temporariamente indisponível." } });
      throw error;
    }
  });

  // Vencedores do Emmy: curadoria fixa (igual para toda a casa), servida como as demais rotas
  // editoriais. A lista mora na API justamente para uma nova edição chegar ao app sem republicá-lo.
  app.get("/v1/editorial/emmy", {
    onRequest: ipCeilingHook(app, { max: 300, timeWindow: "5 minutes" }),
    config: {
      rateLimit: { max: 120, timeWindow: "5 minutes", keyGenerator: sessionRateLimitKey },
      cacheControl: CACHE_HOME
    }
  }, async (request, reply) => {
    try {
      await requireHousehold(request, options);
      return reply.send(emmyWinnersResponseSchema.parse(await options.tmdb.emmy()));
    } catch (error) {
      if (isAuthenticationError(error)) return reply.code(401).send({ error: { code: "AUTHENTICATION_FAILED", message: "Não foi possível autenticar." } });
      if (error instanceof TmdbError) return reply.code(502).send({ error: { code: "EDITORIAL_UNAVAILABLE", message: "Os vencedores do Emmy estão temporariamente indisponíveis." } });
      throw error;
    }
  });

  // 60 por IP era o limite de uma casa inteira, e o catálogo consulta esta rota a cada card
  // que recebe o ponteiro: bastava passear pela home para começar a receber 429 em silêncio —
  // o enriquecimento sumia sem aviso. Agora o balde é por sessão, com teto por IP por cima, e
  // o navegador guarda o resultado em memória para não perguntar duas vezes pelo mesmo título.
  app.get("/v1/editorial/:type/:mediaId", {
    onRequest: ipCeilingHook(app, { max: 1_200, timeWindow: "5 minutes" }),
    config: {
      rateLimit: { max: 400, timeWindow: "5 minutes", keyGenerator: sessionRateLimitKey },
      cacheControl: CACHE_TITLE
    }
  }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const query = querySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "Título inválido." } });
    }
    try {
      await requireHousehold(request, options);
      return reply.send(editorialTitleResponseSchema.parse(await options.tmdb.title({
        type: params.data.type,
        mediaId: params.data.mediaId,
        ...query.data
      })));
    } catch (error) {
      if (isAuthenticationError(error)) {
        return reply.code(401).send({ error: { code: "AUTHENTICATION_FAILED", message: "Não foi possível autenticar." } });
      }
      if (error instanceof TmdbError) {
        if (error.code !== "NOT_FOUND") {
          request.log.warn({ tmdb: error.code }, "TMDB não respondeu com dados utilizáveis");
        }
        return reply.code(error.code === "NOT_FOUND" ? 404 : 502).send({
          error: {
            code: error.code === "NOT_FOUND" ? "EDITORIAL_NOT_FOUND" : "EDITORIAL_UNAVAILABLE",
            message: error.code === "NOT_FOUND"
              ? "Este título ainda não foi localizado no catálogo editorial."
              : "Os detalhes editoriais estão temporariamente indisponíveis."
          }
        });
      }
      throw error;
    }
  });
}
