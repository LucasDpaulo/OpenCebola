// Setor dos pulos (abertura, resumo, encerramento): monta os blocos que os controles mostram.
// REGRA DO SETOR: pulos só LEEM a posição e pedem `seek(…, false)` nos controles. Nunca decidem
// início, retomada nem salvamento — por isso não soltam a guarda do ponto salvo nem tocam em
// `progress/`. Mexer em pulo não deve exigir editar a tela (title-experience.tsx).
import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../../api-client";
import { reportDiagnostic } from "../../diagnostics";
import type { NativePlayer } from "../native-player";
import { playbackSkipBlocks, type SkipBlock, type SkipSegment } from "./skip-segments";
import { withSubtitleMarkers, type SubtitleMarkers } from "./subtitle-markers";

import { loadSkipSegments } from "./load-skip-segments";
import { observeSkipData } from "./observe-skip-data";

const EMPTY_SEGMENTS: readonly SkipSegment[] = [];

export interface EntradaDosBlocosDePulo {
  readonly tipo: string | null;
  readonly videoId: string | undefined;
  /** Só séries têm skip-times: a tela diz se o meta carregado é de série. */
  readonly ehSerie: boolean;
  /** Numeração absoluta enviada à API (ver skipTimesAbsoluteEpisode na tela); null = não envia. */
  readonly episodioAbsoluto: number | null;
  readonly playerNativo: NativePlayer | null;
  /** Só analisa a faixa ativa e libera os pulos após a preparação de áudio/legenda. */
  readonly faixasProntas: boolean;
  readonly fonteId: string | null;
  /** Legendas externas do momento (lidas na hora, sem entrar nas dependências dos efeitos). */
  readonly legendasExternas: () => readonly { id: string; url: string }[];
  readonly buscarTextoDaLegenda: (url: string) => Promise<string | null>;
  readonly idsDoDiagnostico: () => Record<string, string>;
}

export function useBlocosDePulo(entrada: EntradaDosBlocosDePulo): readonly SkipBlock[] {
  const { tipo, videoId, ehSerie, episodioAbsoluto, playerNativo, faixasProntas, legendasExternas, buscarTextoDaLegenda, idsDoDiagnostico } = entrada;
  // Abertura/recapitulação/encerramento (skip-times): busca em paralelo com a legenda, nunca
  // atrasa o play, e falha vira lista vazia — ver o efeito perto da busca de legendas.
  const sessionKey = JSON.stringify([videoId, entrada.fonteId]);
  const apiKey = JSON.stringify([tipo, videoId, episodioAbsoluto]);
  const [apiData, setApiData] = useState<{ key: string; segments: readonly SkipSegment[] } | null>(null);
  const skipSegments = apiData?.key === apiKey ? apiData.segments : EMPTY_SEGMENTS;
  // Capítulos do próprio arquivo têm prioridade sobre os tempos da API. Cada resultado pertence
  // ao vídeo e à instância que o pediu, sem reaproveitar dados durante a troca de episódio.
  const [chapterData, setChapterData] = useState<{
    key: string; player: NativePlayer; segments: readonly SkipSegment[];
  } | null>(null);
  const chapterSkipSegments = chapterData?.key === sessionKey && chapterData?.player === playerNativo
    ? chapterData.segments : EMPTY_SEGMENTS;
  // Marcas da legenda ativa (título do episódio e "Continua…"), quando ela é externa e tem texto
  // acessível. Relidas quando o player fica pronto e quando a pessoa troca de legenda.
  const [markerData, setMarkerData] = useState<{
    key: string; player: NativePlayer; markers: SubtitleMarkers; duration: number;
  } | null>(null);
  const subtitleMarks = markerData?.key === sessionKey && markerData?.player === playerNativo ? markerData : null;

  useEffect(() => {
    setApiData(null);
    if (!videoId || tipo !== "series" || !ehSerie) return;
    const controller = new AbortController();
    const path = [tipo, videoId].map(encodeURIComponent).join("/");
    const query = episodioAbsoluto !== null ? `?absolute=${episodioAbsoluto}` : "";
    void loadSkipSegments(() => apiFetch(`/v1/stremio/skip-times/${path}${query}`, {
      cache: "no-store", headers: { Accept: "application/json" }, signal: controller.signal
    }), controller.signal).then((segments) => {
      if (!controller.signal.aborted && segments !== null) setApiData({ key: apiKey, segments });
    });
    return () => controller.abort();
  }, [apiKey, ehSerie, episodioAbsoluto, tipo, videoId, entrada.fonteId]);

  // Os callbacks leem as listas atuais, sem reinstalar observadores a cada renderização.
  const current = useRef({ legendasExternas, buscarTextoDaLegenda, idsDoDiagnostico });
  current.current = { legendasExternas, buscarTextoDaLegenda, idsDoDiagnostico };
  useEffect(() => {
    setChapterData(null);
    setMarkerData(null);
    if (!playerNativo || !faixasProntas) return;
    return observeSkipData({
      player: playerNativo,
      subtitles: () => current.current.legendasExternas(),
      fetchText: (url) => current.current.buscarTextoDaLegenda(url),
      chapters: (segments) => setChapterData({ key: sessionKey, player: playerNativo, segments }),
      markers: (value) => {
        setMarkerData(value ? { ...value, key: sessionKey, player: playerNativo } : null);
        if (value) reportDiagnostic("SUBTITLE_MARKERS", "Marcas de título e fim pela legenda", {
          ...current.current.idsDoDiagnostico(),
          episodeStart: String(value.markers.episodeStart ?? "-"),
          storyEnd: String(value.markers.storyEnd ?? "-")
        });
      }
    });
  }, [faixasProntas, playerNativo, sessionKey]);

  // Capítulo do arquivo é o tempo exato e vale como está; os trechos da API (AniSkip, com tempos
  // às vezes copiados de episódio para episódio) são acertados pelas marcas da legenda.
  const effectiveSkipSegments = useMemo(() => chapterSkipSegments.length > 0
    ? chapterSkipSegments
    : withSubtitleMarkers(skipSegments, subtitleMarks?.markers ?? null, subtitleMarks?.duration ?? 0),
  [chapterSkipSegments, skipSegments, subtitleMarks]);
  return useMemo(() => faixasProntas ? playbackSkipBlocks(effectiveSkipSegments) : [], [effectiveSkipSegments, faixasProntas]);
}
