import { z } from "zod";

export const MAX_PROFILES_PER_HOUSEHOLD = 8;
export const MAX_DEVICES_PER_HOUSEHOLD = 20;

/** Numeração corrida do One Piece para o catálogo Cinemeta e provedores de legenda. */
export function onePieceAbsoluteEpisode(season: number, episode: number): number | null {
  const offsets: Readonly<Record<number, number>> = { 21: 891, 22: 1085, 23: 1155 };
  const offset = offsets[season];
  return offset === undefined ? null : episode > offset ? episode : offset + episode;
}

export const profileSchema = z.object({
  id: z.string().guid(),
  householdId: z.string().guid(),
  name: z.string().trim().min(1).max(80),
  avatarUrl: z.string().max(2_048).nullable(),
  hasPin: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const deviceTypeSchema = z.enum(["web", "mobile", "tv", "desktop"]);

export const deviceSchema = z.object({
  id: z.string().guid(),
  householdId: z.string().guid(),
  displayName: z.string().trim().min(1).max(100),
  type: deviceTypeSchema,
  status: z.enum(["active", "revoked"]),
  lastSeenAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime()
});

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("cebola-api"),
  timestamp: z.string().datetime()
});

export const loginRequestSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(1_024)
}).strict();

export const authSessionResponseSchema = z.object({
  user: z.object({ email: z.string().email() }),
  expiresAt: z.string().datetime(),
  activeProfileId: z.string().guid().nullable()
});

/**
 * Resposta exclusiva de cliente nativo. O token vai no corpo porque a WebView do app roda em
 * origem própria e não recebe o cookie da API — nem o guardaria, por ser cookie de terceiro.
 */
export const deviceSessionResponseSchema = z.object({
  token: z.string().min(1).max(4_096),
  expiresAt: z.string().datetime(),
  session: authSessionResponseSchema
});

export const profileSummarySchema = profileSchema.pick({
  id: true,
  name: true,
  avatarUrl: true,
  hasPin: true
});

export const profilesResponseSchema = z.object({
  profiles: z.array(profileSummarySchema).max(MAX_PROFILES_PER_HOUSEHOLD)
});

export const createProfileRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
  avatarUrl: z.string().max(2_048).nullable().optional(),
  pin: z.string().regex(/^\d{4}$/).optional()
}).strict();

export const updateProfileRequestSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  avatarUrl: z.string().max(2_048).nullable().optional(),
  pin: z.string().regex(/^\d{4}$/).nullable().optional()
}).strict().refine(
  (data) => data.name !== undefined || data.avatarUrl !== undefined || data.pin !== undefined,
  { message: "ao menos um campo deve ser fornecido para atualização" }
);

export const activateProfileRequestSchema = z.object({
  pin: z.string().regex(/^\d{4}$/).optional()
}).strict();

export const mediaTypeSchema = z.enum(["movie", "series"]);

const mediaIdentifierSchema = z.string().trim().min(1).max(255).refine(
  (value) => !/[\u0000-\u001f\u007f]/.test(value),
  "identificador de mídia inválido"
);

// Pôsteres chegam ao navegador: apenas https, mesma política do gateway Stremio.
const httpsUrlSchema = z.string().url().max(2_048).refine((value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}, "apenas URLs https são aceitas");

const libraryItemFields = {
  addonId: z.string().trim().min(1).max(200),
  mediaId: mediaIdentifierSchema,
  mediaType: mediaTypeSchema,
  name: z.string().trim().min(1).max(300),
  posterUrl: httpsUrlSchema.nullable(),
  backgroundUrl: httpsUrlSchema.nullable(),
  description: z.string().max(5_000).nullable(),
  releaseInfo: z.string().max(100).nullable()
};

export const libraryItemSchema = z.object({
  id: z.string().guid(),
  ...libraryItemFields,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

export const upsertLibraryItemRequestSchema = z.object(libraryItemFields).strict();

export const importLibraryRequestSchema = z.object({
  items: z.array(upsertLibraryItemRequestSchema).max(200)
}).strict();

export const libraryResponseSchema = z.object({
  items: z.array(libraryItemSchema).max(500)
}).strict();

// Ajustes de exibição de legenda espelham os presets já usados no player (fundo, fonte, cor e os
// intervalos contínuos que a UI expõe): offset de sincronismo -10..10s, tamanho 50..200% e
// duração extra de exibição 0..10s. `bg`/`font` reaproveitam os mesmos nomes e valores da UI.
export const subtitleBackgroundStyleSchema = z.enum(["transparent", "translucent", "solid"]);
export const subtitleFontFamilySchema = z.enum(["sans", "serif", "mono"]);

const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "cor deve ser hexadecimal de 6 dígitos");

export const subtitleSettingsSchema = z.object({
  offset: z.number().min(-10).max(10),
  extraDuration: z.number().min(0).max(10),
  color: hexColorSchema,
  size: z.number().min(50).max(200),
  bg: subtitleBackgroundStyleSchema,
  font: subtitleFontFamilySchema
}).strict();

// A fonte é identificada por hash/índice/ID do add-on de origem — nunca por `url`, que é
// temporária (mídia direta ou resolução de debrid) e não pode virar identidade persistida.
export const playbackSourceSchema = z.object({
  addonId: z.string().trim().min(1).max(200),
  streamId: z.string().trim().min(1).max(128).nullable(),
  infoHash: z.string().regex(/^[a-fA-F0-9]{40}$/).nullable(),
  fileIdx: z.number().int().min(0).max(100_000).nullable(),
  releaseTitle: z.string().trim().min(1).max(300).nullable()
}).strict();

// Trilha de áudio/legenda identificada por ID dentro do add-on, com idioma e nome como
// evidência auxiliar para reencontrar a trilha quando o ID não estiver mais disponível.
export const playbackTrackSelectionSchema = z.object({
  id: z.string().trim().min(1).max(200).nullable(),
  language: z.string().trim().min(1).max(35).nullable(),
  name: z.string().trim().min(1).max(300).nullable()
}).strict();

// Cenário de reprodução: sempre opcional/nullable para não quebrar progresso legado, que nunca
// teve esses campos. Nenhuma parte guarda `url`.
export const playbackScenarioSchema = z.object({
  source: playbackSourceSchema.nullable().optional(),
  audio: playbackTrackSelectionSchema.nullable().optional(),
  subtitle: playbackTrackSelectionSchema.nullable().optional(),
  subtitleSettings: subtitleSettingsSchema.nullable().optional()
}).strict();

export const updateWatchProgressRequestSchema = z.object({
  // Uma gravação pendente só pode ser reenviada para o perfil que a originou.
  expectedProfileId: z.string().guid().optional(),
  observedAt: z.string().datetime().optional(),
  addonId: z.string().trim().min(1).max(200),
  playbackAddonId: z.string().trim().min(1).max(200).nullable().optional(),
  mediaId: mediaIdentifierSchema,
  videoId: mediaIdentifierSchema,
  mediaType: mediaTypeSchema,
  title: z.string().trim().min(1).max(300),
  episodeTitle: z.string().trim().min(1).max(300).nullable().optional(),
  season: z.number().int().min(0).max(10_000).nullable().optional(),
  episode: z.number().int().min(0).max(10_000).nullable().optional(),
  posterUrl: httpsUrlSchema.nullable().optional(),
  positionSeconds: z.number().int().min(0).max(604_800),
  durationSeconds: z.number().int().positive().max(604_800),
  completed: z.boolean().optional(),
  playbackScenario: playbackScenarioSchema.nullable().optional()
}).strict().refine(
  (value) => value.positionSeconds <= value.durationSeconds,
  { message: "a posição não pode ultrapassar a duração", path: ["positionSeconds"] }
);

export const watchProgressItemSchema = z.object({
  id: z.string().guid(),
  addonId: z.string().min(1).max(200).nullable(),
  playbackAddonId: z.string().min(1).max(200).nullable(),
  mediaId: mediaIdentifierSchema,
  videoId: mediaIdentifierSchema,
  mediaType: mediaTypeSchema,
  title: z.string().min(1).max(300),
  episodeTitle: z.string().min(1).max(300).nullable(),
  season: z.number().int().min(0).nullable(),
  episode: z.number().int().min(0).nullable(),
  posterUrl: httpsUrlSchema.nullable(),
  positionSeconds: z.number().int().min(0),
  durationSeconds: z.number().int().positive(),
  completed: z.boolean(),
  watched: z.boolean().optional(),
  hiddenFromContinue: z.boolean().optional(),
  updatedAt: z.string().datetime(),
  playbackScenario: playbackScenarioSchema.nullable()
});

export const watchProgressResponseSchema = z.object({
  items: z.array(watchProgressItemSchema).max(100)
});

// Consulta paginada de uma obra, independente do recorte recente da home.
export const titleProgressRequestSchema = z.object({
  mediaId: mediaIdentifierSchema,
  mediaType: mediaTypeSchema,
  videoIds: z.array(mediaIdentifierSchema).max(10_000).default([]),
  offset: z.number().int().min(0).max(1_000_000).default(0)
}).strict();

export const hideProgressRequestSchema = z.object({
  mediaId: mediaIdentifierSchema,
  videoId: mediaIdentifierSchema,
  mediaType: mediaTypeSchema
}).strict();

export const watchProgressQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  includeCompleted: z.enum(["true", "false"]).default("false").transform(
    (value) => value === "true"
  )
});

export const stremioLinkRequestSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(1_024)
}).strict();

export const stremioStatusResponseSchema = z.object({
  linked: z.boolean(),
  addonCount: z.number().int().min(0).max(100),
  syncedAt: z.string().datetime().nullable(),
  // Add-ons que existem na conta Stremio mas o Cebola não conseguiu usar. O descarte já
  // acontecia; o que faltava era contá-lo para o dono, que via só o número final e não tinha
  // como saber que a diferença para o Stremio vinha daqui. O identificador vem do nome do
  // manifesto, nunca da transportUrl, que carrega a chave do debrid.
  rejected: z.array(z.object({
    identifier: z.string().min(1).max(200),
    reason: z.string().min(1).max(300)
  })).max(50).default([])
});

export const homeBootstrapResponseSchema = z.object({
  activeProfile: profileSummarySchema.nullable(),
  progress: watchProgressResponseSchema,
  library: libraryResponseSchema,
  stremio: stremioStatusResponseSchema
});

export const stremioCatalogDescriptorSchema = z.object({
  addonId: z.string().min(1).max(200),
  catalogId: z.string().min(1).max(200),
  type: mediaTypeSchema,
  name: z.string().min(1).max(200)
});

export const stremioCatalogsResponseSchema = z.object({
  catalogs: z.array(stremioCatalogDescriptorSchema).max(100)
});

export const stremioMetaPreviewSchema = z.object({
  id: mediaIdentifierSchema,
  type: mediaTypeSchema,
  name: z.string().min(1).max(300),
  poster: z.string().url().max(2_048).nullable(),
  background: z.string().url().max(2_048).nullable(),
  logo: z.string().url().max(2_048).nullable().optional(),
  description: z.string().max(5_000).nullable(),
  releaseInfo: z.string().max(100).nullable(),
  genres: z.array(z.string().min(1).max(80)).max(30).optional()
});

export const stremioCatalogResponseSchema = z.object({
  addonId: z.string().min(1).max(200),
  catalogId: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  items: z.array(stremioMetaPreviewSchema).max(100)
});

export const stremioVideoSchema = z.object({
  id: mediaIdentifierSchema,
  title: z.string().min(1).max(300),
  season: z.number().int().min(0).max(10_000).nullable(),
  episode: z.number().int().min(0).max(10_000).nullable(),
  released: z.string().datetime().nullable(),
  // Quadro do episódio. O Cinemeta serve por episodes.metahub.space e ele é o que permite a
  // lista de episódios ser visual em vez de uma parede de texto. Nulo quando o add-on não tem.
  thumbnail: httpsUrlSchema.nullable()
});

export const stremioMetaResponseSchema = stremioMetaPreviewSchema.extend({
  videos: z.array(stremioVideoSchema).max(2_000)
});

export const editorialProviderSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(200),
  logoUrl: httpsUrlSchema.nullable()
});

export const editorialCastMemberSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(200),
  character: z.string().min(1).max(300).nullable(),
  profileUrl: httpsUrlSchema.nullable()
});

export const editorialRecommendationSchema = z.object({
  tmdbId: z.number().int().positive(),
  type: mediaTypeSchema,
  title: z.string().min(1).max(300),
  year: z.number().int().min(1870).max(3_000).nullable(),
  overview: z.string().max(5_000).nullable(),
  posterUrl: httpsUrlSchema.nullable(),
  backdropUrl: httpsUrlSchema.nullable(),
  backdropPreviewUrl: httpsUrlSchema.nullable().optional(),
  voteAverage: z.number().min(0).max(10).nullable()
});

export const editorialHomeRailSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(120),
  // Quando a fileira nasce de um catálogo de assinatura, preserva qual serviço a selecionou.
  // `logoUrl` é reconciliada com a disponibilidade do título no detalhe e pode ser nula.
  provider: editorialProviderSchema.nullable().optional(),
  items: z.array(editorialRecommendationSchema).max(20)
});

export const editorialSectionSchema = z.enum(["home", "movies", "series", "documentaries", "anime", "brazil"]);

export const editorialHomeResponseSchema = z.object({
  generatedAt: z.string().datetime(),
  rails: z.array(editorialHomeRailSchema).max(40),
  attribution: z.object({ tmdbNotice: z.string().min(1).max(300) })
});

// Vencedores do Emmy: uma recomendação enriquecida com as categorias que a obra venceu. A curadoria
// vive na API (não no bundle) para que uma nova edição chegue ao app sem republicar o aplicativo.
export const emmyWinnerSchema = editorialRecommendationSchema.extend({
  categories: z.array(z.string().min(1).max(160)).min(1).max(16)
});

export const emmyWinnersResponseSchema = z.object({
  edition: z.number().int().min(2000).max(3_000),
  ceremonyName: z.string().min(1).max(120),
  generatedAt: z.string().datetime(),
  winners: z.array(emmyWinnerSchema).max(30),
  attribution: z.object({ tmdbNotice: z.string().min(1).max(300) })
});

const editorialAvailabilitySchema = z.object({
  subscription: z.array(editorialProviderSchema).max(100),
  free: z.array(editorialProviderSchema).max(100),
  ads: z.array(editorialProviderSchema).max(100),
  rent: z.array(editorialProviderSchema).max(100),
  buy: z.array(editorialProviderSchema).max(100),
  link: httpsUrlSchema.nullable()
});

export const editorialTitleResponseSchema = z.object({
  tmdbId: z.number().int().positive(),
  imdbId: z.string().regex(/^tt\d+$/).nullable(),
  type: mediaTypeSchema,
  title: z.string().min(1).max(300),
  originalTitle: z.string().min(1).max(300).nullable(),
  tagline: z.string().max(1_000).nullable(),
  overview: z.string().max(5_000).nullable(),
  releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  year: z.number().int().min(1870).max(3_000).nullable(),
  runtimeMinutes: z.number().int().positive().max(10_000).nullable(),
  /** Primeira data em casa (digital, disco ou TV) em qualquer país; só filmes. */
  homeReleaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  genres: z.array(z.string().min(1).max(100)).max(30),
  countries: z.array(z.string().min(1).max(150)).max(30),
  originalLanguage: z.string().min(2).max(20).nullable(),
  spokenLanguages: z.array(z.string().min(1).max(150)).max(30),
  directors: z.array(z.string().min(1).max(200)).max(30),
  creators: z.array(z.string().min(1).max(200)).max(30),
  cast: z.array(editorialCastMemberSchema).max(20),
  voteAverage: z.number().min(0).max(10).nullable(),
  voteCount: z.number().int().min(0),
  posterUrl: httpsUrlSchema.nullable(),
  backdropUrl: httpsUrlSchema.nullable(),
  logoUrl: httpsUrlSchema.nullable().optional(),
  trailerUrl: httpsUrlSchema.nullable(),
  tmdbUrl: httpsUrlSchema,
  availability: editorialAvailabilitySchema,
  recommendations: z.array(editorialRecommendationSchema).max(20),
  attribution: z.object({
    tmdbNotice: z.string().min(1).max(300),
    providersSource: z.literal("JustWatch")
  })
});

export const stremioStreamQualitySchema = z.enum(["4K", "1080p", "720p", "480p", "SD"]);

const stremioStreamBaseSchema = z.object({
  id: z.string().min(1).max(128),
  addonId: z.string().min(1).max(200),
  addonName: z.string().min(1).max(200),
  label: z.string().min(1).max(300),
  // Mantém a propriedade em ambas as variantes para consumidores antigos; fontes torrent
  // não têm URL até serem resolvidas pelo Real-Debrid.
  url: z.string().url().max(4_096).nullable(),
  // Campos de apoio à seleção (estilo Netflix): todos opcionais na origem, nunca quebram o
  // parsing quando o add-on não segue o formato do Torrentio.
  quality: stremioStreamQualitySchema.nullable(),
  sizeLabel: z.string().min(1).max(40).nullable(),
  seeders: z.number().int().min(0).max(10_000_000).nullable(),
  source: z.string().min(1).max(60).nullable(),
  mayNotPlay: z.boolean(),
  // O add-on de debrid avisa, na etiqueta do nome, se o arquivo JÁ está no cache. O Torrentio
  // manda "[RD+]" para pronto e "[RD download]" para o que ainda precisa baixar. Três estados
  // porque "não avisa" (ThePirateBay+, Brazuca, Orion) não é o mesmo que "avisou que falta":
  // true = abre agora, false = vai fazer esperar, null = o add-on não informa.
  readyNow: z.boolean().nullable(),
  // Idiomas de ÁUDIO presentes no release, em códigos ISO 639-1 ("en", "pt", "fr"). Lista vazia
  // é o caso mais comum e NÃO significa "sem áudio": significa que o add-on não marcou idioma,
  // e na prática esse release traz o áudio original do conteúdo.
  audioLanguages: z.array(z.string().min(2).max(8)).max(20),
  // Idiomas de legenda ANUNCIADOS pelo add-on. Vazio significa desconhecido, não ausência.
  subtitleLanguages: z.array(z.string().min(2).max(8)).max(20).optional(),
  // O release anuncia dublagem ("Dual Audio", "Multi Audio", "Dual-Lat", "Dublado"). Diferente de
  // audioLanguages, que só diz QUAIS idiomas existem: isto diz que a faixa padrão provavelmente
  // NÃO é o áudio original — que é justamente o que se quer evitar por padrão.
  dubbed: z.boolean(),
  // Nome/tamanho do ARQUIVO real (behaviorHints do add-on), quando informado. Diferente de
  // `label`/`source` (texto livre do add-on): isto é o nome do release de verdade, usado para
  // achar a legenda sincronizada com este exato arquivo — não com o título anunciado.
  filename: z.string().min(1).max(255).optional(),
  videoSize: z.number().int().positive().max(1_000_000_000_000).optional()
});

// Uma fonte pode já trazer um URL de mídia ou apenas a referência BitTorrent que o
// Real-Debrid resolve no servidor. O hash não é uma URL nem credencial; o token do
// Real-Debrid nunca atravessa este contrato.
export const stremioDirectStreamSchema = stremioStreamBaseSchema.extend({
  kind: z.literal("direct"),
  url: z.string().url().max(4_096)
});

export const stremioTorrentStreamSchema = stremioStreamBaseSchema.extend({
  kind: z.literal("torrent"),
  url: z.null(),
  infoHash: z.string().regex(/^[a-fA-F0-9]{40}$/),
  fileIdx: z.number().int().min(0).max(100_000).nullable(),
  // Dados de descoberta, nunca uma autorização de conexão. O adaptador nativo deve
  // validar DNS/destino no aparelho antes de conectar, inclusive redirects HTTP.
  trackers: z.array(z.string().url().max(2_048)).max(32).optional()
});

export const stremioStreamSchema = z.discriminatedUnion("kind", [
  stremioDirectStreamSchema,
  stremioTorrentStreamSchema
]);

export const stremioStreamsResponseSchema = z.object({
  // O Torrentio RD real chegou a 233 fontes em um filme. O teto de 300 preserva esse retorno e
  // ainda mantém uma fronteira explícita contra payloads ilimitados de add-ons externos.
  streams: z.array(stremioStreamSchema).max(300)
});

export const resolveTorrentStreamRequestSchema = z.object({
  infoHash: z.string().regex(/^[a-fA-F0-9]{40}$/),
  fileIdx: z.number().int().min(0).max(100_000).nullable()
});

export const resolveTorrentStreamResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    url: z.string().url().max(4_096),
    mayNotPlay: z.boolean(),
    // Dados do arquivo que o Real-Debrid devolveu, nunca a URL em si: usados só para achar a
    // legenda que bate exatamente com este arquivo (hash do OpenSubtitles / nome do release).
    file: z.object({
      name: z.string().min(1).max(255).optional(),
      size: z.number().int().positive().max(1_000_000_000_000).optional(),
      hash: z.string().regex(/^[0-9a-f]{16}$/).optional()
    }).optional()
  }),
  z.object({
    status: z.literal("pending"),
    progress: z.number().int().min(0).max(100)
  })
]);

export const skipSegmentKindSchema = z.enum(["intro", "recap", "outro"]);

export const skipSegmentSchema = z.object({
  kind: skipSegmentKindSchema,
  start: z.number().min(0),
  end: z.number().min(0),
  // null quando a fonte (AniSkip) não informou a duração do episódio usado no cálculo.
  episodeLength: z.number().min(0).nullable()
});

export const skipTimesResponseSchema = z.object({
  segments: z.array(skipSegmentSchema).max(10)
});

export const dailyFeaturedResponseSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(300),
  subtitle: z.string().min(1).max(5_000),
  // httpsUrlSchema como o resto do contrato: a arte vai para o CSS de uma página pública, e
  // aceitar `http://` aqui seria a única porta do arquivo que ainda deixaria conteúdo misto passar.
  backdropUrl: httpsUrlSchema,
  backdropPreviewUrl: httpsUrlSchema.optional(),
  posterUrl: httpsUrlSchema.nullable(),
  // Identificador de vídeo do YouTube, usado para montar a URL do embed. Restringir ao alfabeto
  // real evita que qualquer texto vindo do TMDB entre em uma URL montada por concatenação.
  trailerKey: z.string().regex(/^[A-Za-z0-9_-]{5,20}$/).nullable()
});

export type Profile = z.infer<typeof profileSchema>;
export type Device = z.infer<typeof deviceSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;
export type DeviceSessionResponse = z.infer<typeof deviceSessionResponseSchema>;

/** Alfabeto sem O, 0, I e 1: o código é lido de longe, na tela da TV. */
export const devicePairingCodeSchema = z.string().regex(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);

export const devicePairingTicketResponseSchema = z.object({
  code: devicePairingCodeSchema,
  deviceId: z.string().min(16).max(128),
  expiresInSeconds: z.number().int().positive().max(3_600)
});

export const devicePairingApproveRequestSchema = z.object({ code: devicePairingCodeSchema });

export const devicePairingClaimRequestSchema = z.object({
  code: devicePairingCodeSchema,
  deviceId: z.string().min(16).max(128)
});

export type DevicePairingTicketResponse = z.infer<typeof devicePairingTicketResponseSchema>;
export type ProfileSummary = z.infer<typeof profileSummarySchema>;
export type ProfilesResponse = z.infer<typeof profilesResponseSchema>;
export type CreateProfileRequest = z.infer<typeof createProfileRequestSchema>;
export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;
export type ActivateProfileRequest = z.infer<typeof activateProfileRequestSchema>;
export type MediaType = z.infer<typeof mediaTypeSchema>;
export type SubtitleBackgroundStyle = z.infer<typeof subtitleBackgroundStyleSchema>;
export type SubtitleFontFamily = z.infer<typeof subtitleFontFamilySchema>;
export type SubtitleSettings = z.infer<typeof subtitleSettingsSchema>;
export type PlaybackSource = z.infer<typeof playbackSourceSchema>;
export type PlaybackTrackSelection = z.infer<typeof playbackTrackSelectionSchema>;
export type PlaybackScenario = z.infer<typeof playbackScenarioSchema>;
export type LibraryItem = z.infer<typeof libraryItemSchema>;
export type UpsertLibraryItemRequest = z.infer<typeof upsertLibraryItemRequestSchema>;
export type ImportLibraryRequest = z.infer<typeof importLibraryRequestSchema>;
export type LibraryResponse = z.infer<typeof libraryResponseSchema>;
export type UpdateWatchProgressRequest = z.infer<typeof updateWatchProgressRequestSchema>;
export type WatchProgressItem = z.infer<typeof watchProgressItemSchema>;
export type WatchProgressResponse = z.infer<typeof watchProgressResponseSchema>;
export type StremioLinkRequest = z.infer<typeof stremioLinkRequestSchema>;
export type StremioStatusResponse = z.infer<typeof stremioStatusResponseSchema>;
export type HomeBootstrapResponse = z.infer<typeof homeBootstrapResponseSchema>;
export type StremioCatalogDescriptor = z.infer<typeof stremioCatalogDescriptorSchema>;
export type StremioCatalogsResponse = z.infer<typeof stremioCatalogsResponseSchema>;
export type StremioMetaPreview = z.infer<typeof stremioMetaPreviewSchema>;
export type StremioCatalogResponse = z.infer<typeof stremioCatalogResponseSchema>;
export type StremioVideo = z.infer<typeof stremioVideoSchema>;
export type StremioMetaResponse = z.infer<typeof stremioMetaResponseSchema>;
export type EditorialProvider = z.infer<typeof editorialProviderSchema>;
export type EditorialCastMember = z.infer<typeof editorialCastMemberSchema>;
export type EditorialRecommendation = z.infer<typeof editorialRecommendationSchema>;
export type EditorialSection = z.infer<typeof editorialSectionSchema>;
export type EditorialHomeRail = z.infer<typeof editorialHomeRailSchema>;
export type EditorialHomeResponse = z.infer<typeof editorialHomeResponseSchema>;
export type EmmyWinner = z.infer<typeof emmyWinnerSchema>;
export type EmmyWinnersResponse = z.infer<typeof emmyWinnersResponseSchema>;
export type EditorialTitleResponse = z.infer<typeof editorialTitleResponseSchema>;
export type DailyFeaturedResponse = z.infer<typeof dailyFeaturedResponseSchema>;
export type StremioStreamQuality = z.infer<typeof stremioStreamQualitySchema>;
export type StremioStream = z.infer<typeof stremioStreamSchema>;
export type StremioStreamsResponse = z.infer<typeof stremioStreamsResponseSchema>;
export type ResolveTorrentStreamRequest = z.infer<typeof resolveTorrentStreamRequestSchema>;
export type ResolveTorrentStreamResponse = z.infer<typeof resolveTorrentStreamResponseSchema>;
export type SkipSegmentKind = z.infer<typeof skipSegmentKindSchema>;
export type SkipSegment = z.infer<typeof skipSegmentSchema>;
export type SkipTimesResponse = z.infer<typeof skipTimesResponseSchema>;

// Os padrões de codec moram em ./codecs.ts, um módulo sem NENHUMA dependência — nem zod. O
// navegador importa "@cebola/contracts/codecs" direto, e nada deste arquivo entra no bundle.
export * from "./codecs.js";
export * from "./books.js";
