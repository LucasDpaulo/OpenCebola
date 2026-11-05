import type { AppDependencies } from "./app.js";
import {
  CachingAuthProvider,
  SupabaseAuthProvider,
  SupabaseServerAuthGateway,
  SupabaseSessionRepository
} from "./auth/index.js";
import { getSupabaseEnvironment, type Environment } from "./env.js";
import {
  HouseholdService,
  PostgresHouseholdRepository,
  SupabasePostgresGateway
} from "./households/index.js";
import { PinService } from "./profiles/index.js";
import {
  PostgresWatchProgressRepository,
  WatchProgressService
} from "./progress/index.js";
import {
  PostgresStremioConnectionRepository,
  StremioAddonGateway,
  StremioApiClient,
  StremioService,
  StremioVault,
  RealDebridClient,
  RealDebridMediaRelay,
  SubtitleRelay,
  EmbeddedSubtitleRelay,
  SubdlClient,
  SkipTimesClient,
  computeRemoteFileHash
} from "./stremio/index.js";
import { TmdbClient } from "./editorial/index.js";
import { LibraryService, PostgresLibraryRepository } from "./library/index.js";

/** Composition root: a service-role key enters only server-side constructors. */
export function createApplicationDependencies(
  environment: Environment
): AppDependencies {
  const supabase = getSupabaseEnvironment(environment);
  if (!supabase) return {};

  // O invólucro de cache só entra em produção: os testes montam o provedor que querem medir,
  // e um cache no meio esconderia justamente o que eles verificam.
  const authProvider = new CachingAuthProvider({
    inner: new SupabaseAuthProvider({
      gateway: new SupabaseServerAuthGateway({
        url: supabase.url,
        publishableKey: supabase.publishableKey,
        serviceRoleKey: supabase.serviceRoleKey
      }),
      sessions: new SupabaseSessionRepository({
        url: supabase.url,
        serviceRoleKey: supabase.serviceRoleKey
      }),
      sessionTtlMs: environment.CEBOLA_SESSION_TTL_SECONDS * 1_000
    })
  });
  const databaseGateway = new SupabasePostgresGateway({
    url: supabase.url,
    serviceRoleKey: supabase.serviceRoleKey
  });
  const householdRepository = new PostgresHouseholdRepository(databaseGateway);
  const householdService = new HouseholdService({ repository: householdRepository });
  const stremioService = new StremioService({
    api: new StremioApiClient(),
    repository: new PostgresStremioConnectionRepository(
      databaseGateway,
      new StremioVault(supabase.stremioVaultKey)
    )
  });

  return {
    authProvider,
    householdRepository,
    householdService,
    pinService: new PinService({ pepper: supabase.pinPepper }),
    progressService: new WatchProgressService({
      repository: new PostgresWatchProgressRepository(databaseGateway),
      households: householdRepository
    }),
    libraryService: new LibraryService({
      repository: new PostgresLibraryRepository(databaseGateway),
      households: householdRepository
    }),
    stremioService,
    stremioGateway: new StremioAddonGateway({
      allowInsecureStreams: environment.CEBOLA_ALLOW_INSECURE_STREAMS === true
    }),
    subtitleRelay: new SubtitleRelay(),
    embeddedSubtitles: new EmbeddedSubtitleRelay(),
    // ARM e AniSkip não exigem chave, então fica sempre ativo (como o SubtitleRelay acima).
    skipTimes: new SkipTimesClient(),
    ...(environment.CEBOLA_SUBDL_API_KEY ? {
      subdl: new SubdlClient({ apiKey: environment.CEBOLA_SUBDL_API_KEY })
    } : {}),
    ...(environment.CEBOLA_REAL_DEBRID_TOKEN ? {
      realDebrid: new RealDebridClient({ token: environment.CEBOLA_REAL_DEBRID_TOKEN }),
      realDebridMediaRelay: new RealDebridMediaRelay(),
      // Só faz sentido calcular hash de arquivo quando existe fonte para resolver.
      fileHash: computeRemoteFileHash
    } : {}),
    ...(environment.CEBOLA_TMDB_READ_TOKEN ? {
      tmdb: new TmdbClient({ token: environment.CEBOLA_TMDB_READ_TOKEN })
    } : {})
  };
}
