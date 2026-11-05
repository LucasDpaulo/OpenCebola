import { type MediaType, type PlaybackScenario, playbackScenarioSchema } from "@cebola/contracts";
import type { DatabaseValues, PostgresGateway } from "../households/index.js";
import { SupabasePostgresGatewayError } from "../households/supabase-postgres-gateway.js";
import type { WatchProgress } from "./domain.js";
import type {
  ProgressTitleTarget,
  UpsertWatchProgressRecord,
  WatchProgressRepository
} from "./repository.js";

interface WatchProgressRow {
  id: string;
  household_id: string;
  profile_id: string;
  addon_id: string | null;
  playback_addon_id?: string | null;
  media_id: string;
  video_id: string;
  media_type: MediaType;
  title: string;
  episode_title: string | null;
  season: number | null;
  episode: number | null;
  poster_url: string | null;
  position_seconds: number;
  duration_seconds: number;
  completed: boolean;
  watched?: boolean;
  hidden_from_continue?: boolean;
  updated_at: string;
  // Bancos ainda na migration 0008 não têm essa coluna: fica `undefined`, nunca um objeto forjado.
  playback_scenario?: unknown;
}

// Ausência de coluna (undefined, bancos pré-0009) e valor nulo viram `null` do mesmo jeito. Um
// valor presente mas fora do formato esperado também vira `null` em vez de derrubar a listagem
// inteira por causa de uma única linha corrompida ou de um formato futuro desconhecido.
function parsePlaybackScenario(value: unknown): PlaybackScenario | null {
  if (value === null || value === undefined) return null;
  const parsed = playbackScenarioSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function fromRow(row: WatchProgressRow): WatchProgress {
  return {
    id: row.id,
    householdId: row.household_id,
    profileId: row.profile_id,
    // Bancos ainda na migration 0005 não devolvem a coluna. Tratar ausência como legado evita
    // derrubar toda a home enquanto a 0006 ainda não foi aplicada.
    addonId: row.addon_id ?? null,
    playbackAddonId: row.playback_addon_id ?? null,
    mediaId: row.media_id,
    videoId: row.video_id,
    mediaType: row.media_type,
    title: row.title,
    episodeTitle: row.episode_title,
    season: row.season,
    episode: row.episode,
    posterUrl: row.poster_url,
    positionSeconds: row.position_seconds,
    durationSeconds: row.duration_seconds,
    completed: row.completed,
    watched: row.watched ?? row.completed,
    hiddenFromContinue: row.hidden_from_continue ?? false,
    updatedAt: new Date(row.updated_at),
    playbackScenario: parsePlaybackScenario(row.playback_scenario)
  };
}

export class PostgresWatchProgressRepository implements WatchProgressRepository {
  readonly #gateway: PostgresGateway;

  constructor(gateway: PostgresGateway) {
    this.#gateway = gateway;
  }

  async upsert(record: UpsertWatchProgressRecord): Promise<WatchProgress> {
    const currentParameters = {
      p_id: record.id,
      p_household_id: record.householdId,
      p_profile_id: record.profileId,
      p_addon_id: record.addonId,
      p_playback_addon_id: record.playbackAddonId,
      p_media_id: record.mediaId,
      p_video_id: record.videoId,
      p_media_type: record.mediaType,
      p_title: record.title,
      p_episode_title: record.episodeTitle,
      p_season: record.season,
      p_episode: record.episode,
      p_poster_url: record.posterUrl,
      p_position_seconds: record.positionSeconds,
      p_duration_seconds: record.durationSeconds,
      p_completed: record.completed,
      p_updated_at: record.updatedAt.toISOString(),
      // jsonb: não cabe em DatabaseScalar (escalares apenas). Ver #rpcUpsert.
      p_playback_scenario: record.playbackScenario
    };
    let row: WatchProgressRow;
    try {
      row = await this.#rpcUpsert(currentParameters);
    } catch (error) {
      // Durante atualização gradual, a API pode reiniciar antes de uma migration mais nova ter
      // sido aplicada no banco remoto. O PostgREST responde PGRST202 porque ainda conhece apenas
      // a assinatura antiga da RPC. Cada passo abaixo derruba o parâmetro mais recente primeiro
      // e tenta de novo, em vez de derrubar reprodução e home.
      if (!(error instanceof SupabasePostgresGatewayError) || error.code !== "PGRST202") throw error;
      // Migration 0009 (cenário de reprodução) pode não ter chegado ainda.
      const { p_playback_scenario: _ignoredScenario, ...withoutScenario } = currentParameters;
      try {
        row = await this.#rpcUpsert(withoutScenario);
      } catch (scenarioError) {
        if (!(scenarioError instanceof SupabasePostgresGatewayError) || scenarioError.code !== "PGRST202") {
          throw scenarioError;
        }
        // Migration 0007 (playback_addon_id) pode não ter chegado ainda.
        const { p_playback_addon_id: _ignored, ...withoutPlaybackAddon } = withoutScenario;
        try {
          row = await this.#rpcUpsert(withoutPlaybackAddon);
        } catch (legacyError) {
          if (!(legacyError instanceof SupabasePostgresGatewayError) || legacyError.code !== "PGRST202") {
            throw legacyError;
          }
          // Migration 0006 (addon_id) pode não ter chegado ainda.
          const { p_addon_id: _legacyAddon, ...legacyParameters } = withoutPlaybackAddon;
          row = await this.#rpcUpsert(legacyParameters);
        }
      }
    }
    return fromRow(row);
  }

  async #rpcUpsert(parameters: Record<string, unknown>): Promise<WatchProgressRow> {
    // O gateway compartilhado tipa parâmetros de RPC como escalares (DatabaseScalar); o cenário é
    // um objeto/nulo (jsonb), então o cast fica só nesta borda com o Postgres.
    return this.#gateway.rpcOne<WatchProgressRow>(
      "cebola_upsert_watch_progress",
      parameters as unknown as DatabaseValues
    );
  }

  async listForTitle(householdId: string, profileId: string, target: ProgressTitleTarget, offset: number): Promise<readonly WatchProgress[]> {
    const rows = await this.#gateway.rpcMany<WatchProgressRow>("cebola_title_watch_progress", {
      p_household_id: householdId, p_profile_id: profileId, p_media_id: target.mediaId,
      p_media_type: target.mediaType, p_video_ids: JSON.stringify(target.videoIds), p_offset: offset
    });
    return rows.map(fromRow);
  }

  async hideTitle(householdId: string, profileId: string, target: ProgressTitleTarget, at: Date): Promise<void> {
    await this.#gateway.rpcMany("cebola_hide_watch_progress", {
      p_household_id: householdId, p_profile_id: profileId, p_media_id: target.mediaId,
      p_media_type: target.mediaType, p_video_id: target.videoIds[0] ?? target.mediaId, p_hidden_at: at.toISOString()
    });
  }

  async listRecent(
    householdId: string,
    profileId: string,
    limit: number,
    includeCompleted: boolean
  ): Promise<readonly WatchProgress[]> {
    const rows = await this.#gateway.rpcMany<WatchProgressRow>("cebola_list_watch_progress", {
      p_household_id: householdId,
      p_profile_id: profileId,
      p_limit: limit,
      p_include_completed: includeCompleted
    });
    return rows.map(fromRow);
  }
}
