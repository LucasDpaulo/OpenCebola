"use client";

// Extraído de `title-experience.tsx`: este componente só é montado no navegador de PC (quando
// nenhum player nativo/Tauri/Tizen está disponível). Isolá-lo permite que o `title-experience`
// importe só o TIPO do Vidstack e carregue este componente via `next/dynamic`, deixando o pacote
// (~350 KB) fora do bundle de celular/TV/Tauri/Tizen, onde ele nunca é usado.

import { useEffect, type RefObject } from "react";
import { Captions, MediaPlayer, MediaProvider, Track, type MediaPlayerInstance } from "@vidstack/react";
import type { SubtitleSettings } from "../player/player-controls";
import type { Subtitle } from "./title-experience";
import { activateDefaultSubtitle, watchBrowserSubtitleChanges } from "../player/browser-subtitle-activation";
import { resolveTvSubtitleStyle, tvSubtitleFontSize } from "../player/tv-subtitle-style";
import styles from "./title.module.css";

export interface TitleBrowserPlayerProps {
  readonly player: RefObject<MediaPlayerInstance | null>;
  readonly src: string;
  readonly title: string;
  readonly subtitleSettings: SubtitleSettings;
  /** Layout de TV: legenda no estilo Netflix (fonte embutida, tamanho por altura). PC/celular não mudam. */
  readonly tvCaptions?: boolean;
  readonly subtitles: readonly Subtitle[];
  readonly defaultSubtitleId: string | null;
  readonly autoSubtitleEnabled: boolean;
  readonly onTracksChanged: () => void;
  readonly onLoadedMetadata: () => void;
  readonly onTimeUpdate: () => void;
  readonly onPause: () => void;
  readonly onEnded: () => void;
  readonly onError: (detail?: { readonly code?: number; readonly message?: string }) => void;
}

export default function TitleBrowserPlayer({
  player,
  src,
  title,
  subtitleSettings,
  tvCaptions = false,
  subtitles,
  defaultSubtitleId,
  autoSubtitleEnabled,
  onTracksChanged,
  onLoadedMetadata,
  onTimeUpdate,
  onPause,
  onEnded,
  onError
}: TitleBrowserPlayerProps) {
  useEffect(() => {
    const tracks = player.current?.textTracks;
    if (!tracks) return;
    const update = () => {
      if (autoSubtitleEnabled && defaultSubtitleId && subtitles.length > 0) {
        activateDefaultSubtitle({
          selected: tracks.selected,
          values: Array.from(tracks).filter((track) => track !== undefined)
        }, defaultSubtitleId, autoSubtitleEnabled);
      }
      onTracksChanged();
    };
    update();
    return watchBrowserSubtitleChanges(tracks, update);
  }, [autoSubtitleEnabled, defaultSubtitleId, onTracksChanged, player, src, subtitles]);

  const tvStyle = resolveTvSubtitleStyle(subtitleSettings.fontFace, subtitleSettings.edge);

  return (
    <MediaPlayer
      ref={player}
      // NÃO troque por `src={selectedStream.url}`. Sem o type, o Vidstack faz um fetch HEAD
      // na URL para descobrir o formato, e a mídia do Torrentio/Real-Debrid não manda
      // Access-Control-Allow-Origin: o HEAD morre no CORS e cria uma falsa falha de reprodução. O <video>
      // em si não precisa de CORS — só a sondagem precisava. O type dispensa a sondagem e
      // seleciona o provider HTML5, que segue o redirect sozinho. Já regrediu três vezes
      // (c77fb94, d695092, 34494a0); o valor certo é video/mp4, porque video/object é para
      // MediaStream, não para URL.
      src={{ src, type: "video/mp4" }}
      autoPlay
      playsInline
      load="eager"
      title={title}
      className={styles.vidstack}
      data-tv-captions={tvCaptions ? "" : undefined}
      style={{
        "--media-cue-color": subtitleSettings.color,
        "--media-cue-font-size": `clamp(1rem, ${2.2 * (subtitleSettings.size / 100)}vw, ${2.8 * (subtitleSettings.size / 100)}rem)`,
        "--media-cue-bg": subtitleSettings.bg === "solid" ? "#000000" : subtitleSettings.bg === "translucent" ? "rgba(0, 0, 0, 0.72)" : "transparent",
        "--media-cue-font": subtitleSettings.font === "serif" ? "Georgia, Cambria, serif" : subtitleSettings.font === "mono" ? "ui-monospace, monospace" : "Inter, ui-sans-serif, system-ui, sans-serif",
        "--media-user-font-size": subtitleSettings.size / 100,
        ...(tvCaptions ? {
          "--media-cue-font-size": tvSubtitleFontSize(subtitleSettings.size),
          // O CSS do Vidstack multiplica o tamanho por `--media-user-font-size`; aqui o tamanho já
          // vem com o "Tamanho" escolhido — sem zerar, o Grande saía 125% × 125% (77 px na TV).
          "--media-user-font-size": 1,
          "--media-cue-font": tvStyle.fontFamily,
          "--tv-cue-lift": `${subtitleSettings.position ?? 0}vh`,
          "--tv-cue-weight": tvStyle.fontWeight,
          "--tv-cue-shadow": tvStyle.textShadow,
          "--media-cue-stroke": tvStyle.textStroke
        } : {})
      }}
      onLoadedMetadata={onLoadedMetadata}
      onTimeUpdate={onTimeUpdate}
      onPause={onPause}
      onEnded={onEnded}
      onError={onError}
    >
      <MediaProvider>
        {subtitles.map((subtitle) => (
          <Track
            key={subtitle.id}
            id={subtitle.id}
            src={subtitle.url}
            kind="subtitles"
            label={`${subtitle.label}${subtitle.details ? ` · ${subtitle.details}` : ""} · ${subtitle.addonName}`}
            lang={subtitle.language}
            type="vtt"
            // A seleção inicial é feita pelo efeito acima, inclusive quando a API responde
            // depois do vídeo. O Vidstack não pode reativar uma legenda desligada pela pessoa.
            default={false}
          />
        ))}
      </MediaProvider>
      {/* `vds-captions` é a classe que o CSS do Vidstack (e o nosso, title.module.css) espera; com
          `styles.captions` (que não existe) a caixa da legenda ficava 0×0 na borda direita e a
          frase saía cortada na lateral (TV Samsung). */}
      <Captions className="vds-captions" />
    </MediaPlayer>
  );
}
