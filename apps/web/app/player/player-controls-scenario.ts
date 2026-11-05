import type { PlaybackScenarioPatch } from "./playback-scenario.js";
import { subtitleForAudio, type LanguageTrack } from "./subtitle-selection";

/**
 * Trocas reais de áudio/legenda dentro dos controles do player — extraídas do componente para
 * serem testadas sem depender de React nem de CSS Modules. Cada função só devolve o patch de
 * cenário depois que a promessa do player resolve: uma rejeição propaga e quem chama nunca
 * atualiza estado nem persiste nada para uma troca que não aconteceu de verdade.
 */

/** Forma mínima de trilha usada nas trocas de áudio/legenda. */
export interface ScenarioTrack extends LanguageTrack {
  readonly id: string;
}

export interface AudioSelectionPlayer {
  selectAudioTrack(id: string): Promise<void>;
  selectSubtitleTrack(id: string | null): Promise<void>;
}

export interface AudioSelectionResult {
  readonly audioTrackId: string;
  readonly subtitleTrackId: string | null;
  readonly patch: PlaybackScenarioPatch;
}

export interface SubtitleSelectionPlayer {
  selectSubtitleTrack(id: string | null): Promise<void>;
}

export interface SubtitleSelectionResult {
  readonly subtitleTrackId: string | null;
  readonly patch: PlaybackScenarioPatch;
}

function trackSelection(tracks: readonly ScenarioTrack[], id: string | null) {
  if (id === null) return null;
  const track = tracks.find((candidate) => candidate.id === id);
  return track ? { id: track.id, language: track.language, name: track.label } : null;
}

/**
 * Troca a trilha de áudio e, quando a legenda atual deixa de ser adequada para o novo idioma,
 * troca-a também. Cada `select*Track` é aguardado antes do próximo passo — se qualquer um deles
 * rejeitar, a função inteira rejeita sem devolver resultado parcial.
 */
export async function applyAudioTrackSelection(
  player: AudioSelectionPlayer,
  selected: ScenarioTrack,
  subtitles: readonly ScenarioTrack[],
  currentSubtitleTrack: string | null
): Promise<AudioSelectionResult> {
  await player.selectAudioTrack(selected.id);

  const suitableSubtitle = subtitleForAudio(
    selected,
    subtitles.map((track) => ({ id: track.id, language: track.language ?? "", label: track.label })),
    currentSubtitleTrack
  );

  let subtitleTrackId = currentSubtitleTrack;
  const patch: { -readonly [K in keyof PlaybackScenarioPatch]?: PlaybackScenarioPatch[K] } = {
    audio: { id: selected.id, language: selected.language, name: selected.label }
  };

  if (suitableSubtitle !== currentSubtitleTrack) {
    await player.selectSubtitleTrack(suitableSubtitle);
    subtitleTrackId = suitableSubtitle;
    patch.subtitle = trackSelection(subtitles, suitableSubtitle);
  }

  return { audioTrackId: selected.id, subtitleTrackId, patch };
}

/** Troca a legenda e só devolve o patch depois que o player confirma. `null` desliga. */
export async function applySubtitleTrackSelection(
  player: SubtitleSelectionPlayer,
  subtitles: readonly ScenarioTrack[],
  id: string | null
): Promise<SubtitleSelectionResult> {
  await player.selectSubtitleTrack(id);
  return { subtitleTrackId: id, patch: { subtitle: trackSelection(subtitles, id) } };
}
