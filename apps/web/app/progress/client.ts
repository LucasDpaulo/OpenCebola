// MÓDULO PROTEGIDO — salvamento de progresso. Não alterar sem pedido explícito do Lucas (ver AGENTS.md).
import type { PlaybackScenario } from "@cebola/contracts";
import { apiFetch } from "../api-client";
import { pendingProgress, rememberProgress, forgetProgress } from "./outbox";
import { reportDiagnostic } from "../diagnostics";

/** Registro de progresso como a API devolve (só o que a web usa; o resto passa sem ser tocado). */
export interface SavedProgressItem {
  readonly id?: string;
  readonly updatedAt?: string;
  readonly addonId?: string | null;
  readonly playbackAddonId?: string | null;
  readonly mediaId: string;
  readonly videoId: string;
  readonly mediaType?: "movie" | "series";
  readonly title?: string;
  readonly episodeTitle?: string | null;
  readonly season?: number | null;
  readonly episode?: number | null;
  readonly posterUrl?: string | null;
  readonly positionSeconds: number;
  readonly durationSeconds: number;
  readonly completed: boolean;
  readonly watched?: boolean;
  readonly hiddenFromContinue?: boolean;
  readonly playbackScenario?: PlaybackScenario | null;
}

export interface SendProgressOptions {
  readonly profileId?: string;
  /** Chamado quando a API responde 401: a sessão expirou e o progresso não será salvo. */
  readonly onUnauthorized?: () => void;
  /** Registro confirmado pelo servidor, incluindo conclusão e histórico permanente. */
  readonly onSaved?: (item: SavedProgressItem) => void;
}

/** Janela em que chamadas seguidas de leitura reaproveitam a mesma resposta. */
const REUSE_WINDOW_MS = 2_000;

interface RecentList {
  readonly at: number;
  readonly promise: Promise<readonly SavedProgressItem[]>;
}

let recentList: RecentList | null = null;

function isSavedProgressItem(value: unknown): value is SavedProgressItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.mediaId === "string" && typeof item.videoId === "string" &&
    typeof item.positionSeconds === "number" && Number.isFinite(item.positionSeconds) &&
    typeof item.durationSeconds === "number" && Number.isFinite(item.durationSeconds) &&
    typeof item.completed === "boolean";
}

/** Contexto do diagnóstico: de qual vídeo era a gravação (o corpo já é texto pronto). */
function diagnosticContext(body: string, status: string): Record<string, string> {
  const context: Record<string, string> = { status };
  try {
    const parsed = JSON.parse(body) as { mediaId?: unknown; videoId?: unknown };
    if (typeof parsed.mediaId === "string") context.mediaId = parsed.mediaId;
    if (typeof parsed.videoId === "string") context.videoId = parsed.videoId;
  } catch {
    // O contexto é só ajuda de depuração.
  }
  return context;
}

/**
 * Único PUT de progresso do app. Devolve se a API aceitou; nunca lança — falha de gravação não
 * pode derrubar o player. Recusa e falha de rede vão para o registro de erros da casa; 401 avisa
 * quem chamou (a sessão expirou) em vez de virar diagnóstico.
 */
export async function sendProgress(body: string, options: SendProgressOptions = {}): Promise<boolean> {
  if (options.profileId) {
    try {
      const value = JSON.parse(body) as Record<string, unknown>;
      if (value.expectedProfileId !== undefined && value.expectedProfileId !== options.profileId) return false;
      body = JSON.stringify({ ...value, expectedProfileId: options.profileId, observedAt: value.observedAt ?? new Date().toISOString() });
      rememberProgress(options.profileId, body);
    } catch { return false; }
  }
  // A lista em cache ficaria velha: quem a pedir depois desta gravação precisa ver o que ela guardou.
  recentList = null;
  try {
    const response = await apiFetch("/v1/progress", {
      method: "PUT",
      keepalive: true,
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body
    });
    recentList = null;
    if (response.ok) {
      if (options.profileId) forgetProgress(options.profileId, body);
      if (options.onSaved) {
        try {
          const item: unknown = await response.json();
          if (isSavedProgressItem(item)) options.onSaved(item);
        } catch { /* Uma resposta sem corpo não desfaz o salvamento confirmado. */ }
      }
      return true;
    }
    if (options.profileId && [400, 404, 422].includes(response.status)) forgetProgress(options.profileId, body);
    if (response.status === 401) {
      try {
        options.onUnauthorized?.();
      } catch {
        // O aviso à tela não pode transformar a gravação numa exceção.
      }
      return false;
    }
    // Sem isto a recusa era silenciosa: o vídeo seguia e a retomada simplesmente sumia.
    reportDiagnostic("PROGRESS_SAVE_FAILED", `PUT /v1/progress respondeu ${response.status}`,
      diagnosticContext(body, String(response.status)));
    return false;
  } catch {
    reportDiagnostic("PROGRESS_SAVE_FAILED", "PUT /v1/progress falhou na rede",
      diagnosticContext(body, "network"));
    return false;
  }
}

async function loadItems(): Promise<{ readonly items: readonly SavedProgressItem[]; readonly ok: boolean }> {
  try {
    const response = await apiFetch("/v1/progress?limit=100&includeCompleted=true", {
      cache: "no-store",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) return { items: [], ok: false };
    const body = await response.json() as { items?: unknown };
    if (!Array.isArray(body.items)) return { items: [], ok: false };
    return { items: body.items.filter(isSavedProgressItem), ok: true };
  } catch {
    return { items: [], ok: false };
  }
}

/**
 * Lê o progresso salvo do perfil (até 100 registros, concluídos inclusive). Chamadas seguidas
 * (tela, player e próximo episódio pedem a mesma lista) dividem a mesma resposta por 2 s. Falha
 * vira lista vazia — a retomada é um extra, nunca motivo para a tela não abrir.
 */
export function fetchProgressItems(): Promise<readonly SavedProgressItem[]> {
  const at = Date.now();
  if (recentList !== null && at - recentList.at < REUSE_WINDOW_MS) return recentList.promise;
  const entry: RecentList = {
    at,
    promise: loadItems().then((result) => {
      // Uma falha não fica em cache: a próxima chamada tenta de novo.
      if (!result.ok && recentList === entry) recentList = null;
      return result.items;
    })
  };
  recentList = entry;
  return entry.promise;
}

export interface TitleProgressTarget {
  readonly mediaId: string;
  readonly mediaType: "movie" | "series";
  readonly videoIds: readonly string[];
}

/** Busca a obra inteira em páginas, inclusive itens antigos e ocultos da home. */
export async function fetchTitleProgress(target: TitleProgressTarget): Promise<readonly SavedProgressItem[]> {
  const items: SavedProgressItem[] = [];
  try {
    for (let offset = 0; ; offset += 100) {
      const response = await apiFetch("/v1/progress/title", {
        method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ ...target, videoIds: [...new Set(target.videoIds)], offset })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { items?: unknown };
      if (!Array.isArray(body.items)) throw new Error("Resposta inválida");
      items.push(...body.items.filter(isSavedProgressItem));
      if (body.items.length < 100) return items;
    }
  } catch {
    reportDiagnostic("PROGRESS_LOAD_FAILED", "Não foi possível consultar o histórico da obra", { mediaId: target.mediaId });
    // Não apresentar histórico parcial como se fosse uma leitura completa.
    return [];
  }
}

export async function hideProgress(target: { mediaId: string; videoId: string; mediaType: "movie" | "series" }): Promise<boolean> {
  recentList = null;
  try {
    const response = await apiFetch("/v1/progress/hidden", {
      method: "PUT", cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(target)
    });
    recentList = null;
    return response.ok;
  } catch { return false; }
}

/** Atualiza a interface com a resposta confirmada, sem perder gravações mais recentes. */
export function mergeSavedProgress(items: readonly SavedProgressItem[], saved: SavedProgressItem): readonly SavedProgressItem[] {
  const previous = items.find((item) => item.mediaId === saved.mediaId && item.videoId === saved.videoId);
  const watched = (saved.watched ?? saved.completed) || (previous?.watched ?? previous?.completed ?? false);
  const latest = previous && Date.parse(previous.updatedAt ?? "") > Date.parse(saved.updatedAt ?? "") ? previous : saved;
  const merged = { ...latest, watched };
  return [merged, ...items.filter((item) => item.mediaId !== saved.mediaId || item.videoId !== saved.videoId)]
    .sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""));
}

/** Reenvia em ordem, apenas para o perfil atual; a API também confere esse vínculo. */
export async function retryPendingProgress(profileId: string, options: SendProgressOptions = {}): Promise<void> {
  for (const body of pendingProgress(profileId)) {
    if (!await sendProgress(body, { ...options, profileId })) break;
  }
}
