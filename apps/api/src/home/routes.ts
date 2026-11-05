import type { FastifyInstance } from "fastify";
import {
  homeBootstrapResponseSchema,
  libraryItemSchema,
  profileSummarySchema,
  watchProgressItemSchema,
  type StremioStatusResponse
} from "@cebola/contracts";
import {
  AuthenticationError,
  isAuthenticationError,
  readRequestSessionToken,
  type AuthProvider
} from "../auth/index.js";
import { ProfileNotFoundError, type HouseholdService, type Profile } from "../households/index.js";
import type { LibraryItem, LibraryService } from "../library/index.js";
import type { WatchProgress, WatchProgressService } from "../progress/index.js";
import type { StremioService } from "../stremio/index.js";

export interface HomeRoutesOptions {
  readonly authProvider: AuthProvider;
  readonly households: HouseholdService;
  readonly progress: WatchProgressService;
  readonly library: LibraryService;
  readonly stremio: StremioService;
}

function publicProfile(profile: Profile) {
  return profileSummarySchema.parse({
    id: profile.id,
    name: profile.name,
    avatarUrl: profile.avatarUrl,
    hasPin: profile.hasPin
  });
}

function publicLibraryItem(item: LibraryItem) {
  return libraryItemSchema.parse({
    id: item.id,
    addonId: item.addonId,
    mediaId: item.mediaId,
    mediaType: item.mediaType,
    name: item.name,
    posterUrl: item.posterUrl,
    backgroundUrl: item.backgroundUrl,
    description: item.description,
    releaseInfo: item.releaseInfo,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString()
  });
}

function publicProgress(item: WatchProgress) {
  return watchProgressItemSchema.parse({
    id: item.id,
    addonId: item.addonId,
    playbackAddonId: item.playbackAddonId,
    mediaId: item.mediaId,
    videoId: item.videoId,
    mediaType: item.mediaType,
    title: item.title,
    episodeTitle: item.episodeTitle,
    season: item.season,
    episode: item.episode,
    posterUrl: item.posterUrl,
    positionSeconds: item.positionSeconds,
    durationSeconds: item.durationSeconds,
    completed: item.completed,
    watched: item.watched ?? item.completed,
    hiddenFromContinue: item.hiddenFromContinue ?? false,
    updatedAt: item.updatedAt.toISOString(),
    playbackScenario: item.playbackScenario
  });
}

const notLinked: StremioStatusResponse = {
  linked: false,
  addonCount: 0,
  syncedAt: null,
  rejected: []
};

export async function registerHomeRoutes(app: FastifyInstance, options: HomeRoutesOptions): Promise<void> {
  app.get("/v1/home/bootstrap", async (request, reply) => {
    try {
      const credential = readRequestSessionToken(request);
      if (credential === null) throw new AuthenticationError();

      // Esta é a única validação de sessão e a única resolução de casa necessárias para abrir
      // a home. profileId e householdId continuam vindo exclusivamente da sessão autenticada.
      const session = await options.authProvider.verifySession(credential.token);
      const household = await options.households.ensureHouseholdForOwner(session.user.id);
      const stremioPromise = options.stremio.status(household.id).catch(() => {
        request.log.warn({ integration: "stremio-status" }, "status Stremio indisponível no bootstrap");
        return notLinked;
      });

      if (session.activeProfileId === null) {
        return reply.send(homeBootstrapResponseSchema.parse({
          activeProfile: null,
          progress: { items: [] },
          library: { items: [] },
          stremio: await stremioPromise
        }));
      }

      try {
        const [profile, progress, library, stremio] = await Promise.all([
          options.households.getProfile(household.id, session.activeProfileId),
          // A home precisa também do histórico concluído para formar recomendações do perfil.
          // "Continuar" filtra concluídos no cliente; descartá-los aqui apagava justamente o
          // sinal mais forte de gosto: aquilo que a pessoa assistiu até o fim.
          options.progress.listRecent(household.id, session.activeProfileId, 30, true),
          options.library.list(household.id, session.activeProfileId),
          stremioPromise
        ]);
        return reply.send(homeBootstrapResponseSchema.parse({
          activeProfile: publicProfile(profile),
          progress: { items: progress.map(publicProgress) },
          library: { items: library.map(publicLibraryItem) },
          stremio
        }));
      } catch (error) {
        // Uma sessão pode apontar por instantes para um perfil removido em outro aparelho. Não
        // transforme isso em 500: a web volta à seleção de perfil e a próxima ativação corrige.
        if (error instanceof ProfileNotFoundError) {
          return reply.send(homeBootstrapResponseSchema.parse({
            activeProfile: null,
            progress: { items: [] },
            library: { items: [] },
            stremio: await stremioPromise
          }));
        }
        throw error;
      }
    } catch (error) {
      if (isAuthenticationError(error)) {
        return reply.code(401).send({
          error: { code: "AUTHENTICATION_FAILED", message: "Não foi possível autenticar." }
        });
      }
      throw error;
    }
  });
}
