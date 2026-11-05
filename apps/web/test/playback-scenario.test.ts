import assert from "node:assert/strict";
import test from "node:test";
import type { PlaybackScenario, PlaybackSource, PlaybackTrackSelection } from "@cebola/contracts";
import {
  commitScenarioChange,
  matchPreviousEpisodeStream,
  matchSavedStream,
  matchSavedTrack,
  matchSavedAudioTrack,
  audioContinuityFromTracks,
  matchSubtitleContinuityTrack,
  matchTrackByLanguage,
  mergeScenario,
  resolveContinuitySource,
  resolveContinuityTrack,
  scenarioForStream,
  subtitleContinuityFromTracks
} from "../app/player/playback-scenario.js";

const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);

const torrentStream = {
  id: "torrentio-4k", addonId: "com.stremio.torrentio.addon", addonName: "Torrentio RD",
  label: "Filme 2160p Dublado", kind: "torrent" as const, url: null,
  infoHash: HASH_A, fileIdx: 2
};

const directStream = {
  id: "editorial-direct", addonId: "editorial.tmdb", addonName: "TMDB",
  label: "Filme Direto", kind: "direct" as const, url: "https://example.com/video.mp4"
};

test("scenarioForStream deriva a identidade da fonte sem incluir url", () => {
  const scenario = scenarioForStream(torrentStream);
  assert.deepEqual(scenario, {
    addonId: "com.stremio.torrentio.addon",
    streamId: "torrentio-4k",
    infoHash: HASH_A,
    fileIdx: 2,
    releaseTitle: "Filme 2160p Dublado"
  });
  assert.equal("url" in scenario, false);
});

test("scenarioForStream marca infoHash/fileIdx como null para fontes diretas", () => {
  const scenario = scenarioForStream(directStream);
  assert.deepEqual(scenario, {
    addonId: "editorial.tmdb",
    streamId: "editorial-direct",
    infoHash: null,
    fileIdx: null,
    releaseTitle: "Filme Direto"
  });
});

test("matchSavedStream prioriza infoHash+fileIdx mesmo vindo de outro addon", () => {
  const streams = [
    { id: "orion-1", addonId: "org.community.orion", addonName: "Orion", label: "Filme 1080p", kind: "torrent" as const, infoHash: HASH_A, fileIdx: 2 },
    { id: "torrentio-1", addonId: "com.stremio.torrentio.addon", addonName: "Torrentio RD", label: "Filme 2160p Dublado", kind: "torrent" as const, infoHash: HASH_B, fileIdx: 0 }
  ];
  const saved: PlaybackSource = {
    addonId: "com.stremio.torrentio.addon", streamId: "outro-id", infoHash: HASH_A, fileIdx: 2, releaseTitle: null
  };
  const match = matchSavedStream(streams, saved);
  assert.equal(match?.id, "orion-1");
});

test("matchSavedStream aceita infoHash em maiúsculas e ignora fileIdx divergente ambíguo", () => {
  const streams = [
    { id: "s1", addonId: "a", addonName: "A", label: "Filme parte 1", kind: "torrent" as const, infoHash: HASH_A, fileIdx: 0 },
    { id: "s2", addonId: "a", addonName: "A", label: "Filme parte 2", kind: "torrent" as const, infoHash: HASH_A, fileIdx: 1 }
  ];
  const saved: PlaybackSource = {
    addonId: "a", streamId: null, infoHash: HASH_A.toUpperCase(), fileIdx: 1, releaseTitle: null
  };
  const match = matchSavedStream(streams, saved);
  assert.equal(match?.id, "s2");
});

test("matchSavedStream sem fileIdx salvo e múltiplos arquivos com o mesmo hash é ambíguo nesse critério e cai para o próximo", () => {
  const streams = [
    { id: "s1", addonId: "a", addonName: "A", label: "Filme salvo", kind: "torrent" as const, infoHash: HASH_A, fileIdx: 0 },
    { id: "s2", addonId: "a", addonName: "A", label: "Outro arquivo", kind: "torrent" as const, infoHash: HASH_A, fileIdx: 1 }
  ];
  const saved: PlaybackSource = {
    addonId: "a", streamId: "s1", infoHash: HASH_A, fileIdx: null, releaseTitle: null
  };
  // infoHash sozinho é ambíguo (dois arquivos), então cai para o critério de ID no mesmo addon.
  const match = matchSavedStream(streams, saved);
  assert.equal(match?.id, "s1");
});

test("matchSavedStream casa por ID somente dentro do mesmo addon", () => {
  const streams = [
    { id: "shared-id", addonId: "org.community.orion", addonName: "Orion", label: "Filme Orion", kind: "direct" as const },
    { id: "other", addonId: "com.stremio.torrentio.addon", addonName: "Torrentio RD", label: "Filme Torrentio", kind: "direct" as const }
  ];
  const saved: PlaybackSource = {
    addonId: "com.stremio.torrentio.addon", streamId: "shared-id", infoHash: null, fileIdx: null, releaseTitle: null
  };
  // Existe "shared-id" na lista, mas em outro addon — não pode casar por ID.
  assert.equal(matchSavedStream(streams, saved), null);
});

test("matchSavedStream cai para chave normalizada de release quando ID não é encontrado", () => {
  const streams = [
    { id: "novo-id", addonId: "com.stremio.torrentio.addon", addonName: "Torrentio RD", label: "Filme: 2160p (Dublado)!!", kind: "direct" as const }
  ];
  const saved: PlaybackSource = {
    addonId: "com.stremio.torrentio.addon", streamId: "id-antigo", infoHash: null, fileIdx: null,
    releaseTitle: "filme 2160p dublado"
  };
  const match = matchSavedStream(streams, saved);
  assert.equal(match?.id, "novo-id");
});

test("matchSavedStream retorna null quando a chave normalizada de release é ambígua", () => {
  const streams = [
    { id: "a1", addonId: "x", addonName: "X", label: "Filme 1080p", kind: "direct" as const },
    { id: "a2", addonId: "y", addonName: "Y", label: "Filme 1080p", kind: "direct" as const }
  ];
  const saved: PlaybackSource = {
    addonId: "z", streamId: null, infoHash: null, fileIdx: null, releaseTitle: "Filme 1080p"
  };
  assert.equal(matchSavedStream(streams, saved), null);
});

test("matchSavedStream retorna null sem nenhuma evidência aproveitável", () => {
  const streams = [{ id: "a1", addonId: "x", addonName: "X", label: "Filme", kind: "direct" as const }];
  const saved: PlaybackSource = { addonId: "outro", streamId: null, infoHash: null, fileIdx: null, releaseTitle: null };
  assert.equal(matchSavedStream(streams, saved), null);
});

test("matchSavedStream retorna null quando não há cenário salvo", () => {
  const streams = [{ id: "a1", addonId: "x", addonName: "X", label: "Filme", kind: "direct" as const }];
  assert.equal(matchSavedStream(streams, null), null);
  assert.equal(matchSavedStream(streams, undefined), null);
});

test("matchSavedTrack casa por ID antes de considerar idioma/nome", () => {
  const tracks = [
    { id: "t1", label: "Português", language: "pt" },
    { id: "t2", label: "Inglês", language: "en" }
  ];
  const saved: PlaybackTrackSelection = { id: "t2", language: "pt", name: "Português" };
  const match = matchSavedTrack(tracks, saved);
  assert.equal(match?.id, "t2");
});

test("matchSavedTrack cai para idioma+nome quando o ID salvo não existe mais", () => {
  const tracks = [
    { id: "novo-1", label: "Português", language: "pt" },
    { id: "novo-2", label: "Inglês", language: "en" }
  ];
  const saved: PlaybackTrackSelection = { id: "id-antigo", language: "pt", name: "Português" };
  const match = matchSavedTrack(tracks, saved);
  assert.equal(match?.id, "novo-1");
});

test("matchSavedTrack retorna null quando idioma+nome não identifica uma trilha única", () => {
  const tracks = [
    { id: "n1", label: "Português", language: "pt" },
    { id: "n2", label: "Português", language: "pt" }
  ];
  const saved: PlaybackTrackSelection = { id: "id-antigo", language: "pt", name: "Português" };
  assert.equal(matchSavedTrack(tracks, saved), null);
});

test("matchSavedTrack retorna null sem trilha salva", () => {
  const tracks = [{ id: "n1", label: "Português", language: "pt" }];
  assert.equal(matchSavedTrack(tracks, null), null);
});

test("mergeScenario combina o patch parcial preservando o restante do cenário", () => {
  const current: PlaybackScenario = {
    source: { addonId: "a", streamId: "s1", infoHash: null, fileIdx: null, releaseTitle: "Filme" },
    audio: { id: "au1", language: "pt", name: "Português" },
    subtitle: null,
    subtitleSettings: null
  };
  const merged = mergeScenario(current, { subtitle: { id: "sub1", language: "en", name: "English" } });
  assert.deepEqual(merged, {
    source: { addonId: "a", streamId: "s1", infoHash: null, fileIdx: null, releaseTitle: "Filme" },
    audio: { id: "au1", language: "pt", name: "Português" },
    subtitle: { id: "sub1", language: "en", name: "English" },
    subtitleSettings: null
  });
});

test("mergeScenario aceita null explícito no patch para limpar um campo", () => {
  const current: PlaybackScenario = {
    source: { addonId: "a", streamId: "s1", infoHash: null, fileIdx: null, releaseTitle: "Filme" },
    audio: { id: "au1", language: "pt", name: "Português" }
  };
  const merged = mergeScenario(current, { audio: null });
  assert.equal(merged.audio, null);
  assert.deepEqual(merged.source, current.source);
});

test("mergeScenario funciona sem cenário atual", () => {
  const merged = mergeScenario(null, { source: { addonId: "a", streamId: "s1", infoHash: null, fileIdx: null, releaseTitle: null } });
  assert.deepEqual(merged, { source: { addonId: "a", streamId: "s1", infoHash: null, fileIdx: null, releaseTitle: null } });
});

// Task 7 — continuidade entre episódios: a fonte, a trilha e os ajustes do episódio que a pessoa
// está deixando alimentam o episódio novo quando ele não tem (ou perde para) retomada própria.

test("matchPreviousEpisodeStream reencontra o pacote de temporada pelo infoHash, com fileIdx diferente", () => {
  const streams = [
    { id: "ep2-arquivo", addonId: "com.stremio.torrentio.addon", addonName: "Torrentio RD", label: "Show S01 COMPLETE 1080p WEB-DL-Grupo", kind: "torrent" as const, infoHash: HASH_A, fileIdx: 5 }
  ];
  const previous: PlaybackSource = {
    addonId: "com.stremio.torrentio.addon", streamId: "ep1-arquivo", infoHash: HASH_A, fileIdx: 2, releaseTitle: "Show S01 COMPLETE 1080p WEB-DL-Grupo"
  };
  const match = matchPreviousEpisodeStream(streams, previous);
  assert.equal(match?.id, "ep2-arquivo");
});

test("matchPreviousEpisodeStream com hash ambíguo entre add-ons desempata pelo add-on do episódio anterior", () => {
  const streams = [
    { id: "outro-addon", addonId: "org.community.orion", addonName: "Orion", label: "Show S01 1080p WEB-DL-Grupo", kind: "torrent" as const, infoHash: HASH_A, fileIdx: 5 },
    { id: "mesmo-addon", addonId: "com.stremio.torrentio.addon", addonName: "Torrentio RD", label: "Show S01 1080p WEB-DL-Grupo", kind: "torrent" as const, infoHash: HASH_A, fileIdx: 5 }
  ];
  const previous: PlaybackSource = {
    addonId: "com.stremio.torrentio.addon", streamId: "x", infoHash: HASH_A, fileIdx: 2, releaseTitle: null
  };
  const match = matchPreviousEpisodeStream(streams, previous);
  assert.equal(match?.id, "mesmo-addon");
});

test("matchPreviousEpisodeStream casa pelo grupo de release no mesmo add-on quando não há infoHash", () => {
  const streams = [
    { id: "outro-grupo", addonId: "com.stremio.torrentio.addon", addonName: "Torrentio RD", label: "Show.S01E02.1080p.WEB-DL-Outro", kind: "direct" as const },
    { id: "mesmo-grupo", addonId: "com.stremio.torrentio.addon", addonName: "Torrentio RD", label: "Show.S01E02.1080p.WEB-DL-CtrlHD", kind: "direct" as const }
  ];
  const previous: PlaybackSource = {
    addonId: "com.stremio.torrentio.addon", streamId: "x", infoHash: null, fileIdx: null,
    releaseTitle: "Show.S01E01.1080p.WEB-DL-CtrlHD"
  };
  const match = matchPreviousEpisodeStream(streams, previous);
  assert.equal(match?.id, "mesmo-grupo");
});

test("matchPreviousEpisodeStream não casa entre add-ons diferentes nem sem nenhuma evidência", () => {
  const streams = [
    { id: "s1", addonId: "outro.addon", addonName: "Outro", label: "Show.S01E02.1080p.WEB-DL-CtrlHD", kind: "direct" as const }
  ];
  const previous: PlaybackSource = {
    addonId: "com.stremio.torrentio.addon", streamId: "x", infoHash: null, fileIdx: null,
    releaseTitle: "Show.S01E01.1080p.WEB-DL-CtrlHD"
  };
  assert.equal(matchPreviousEpisodeStream(streams, previous), null);
  assert.equal(matchPreviousEpisodeStream(streams, null), null);
});

test("resolveContinuitySource: o lançamento do episódio anterior vence a retomada salva do episódio novo", () => {
  const streams = [
    { id: "release-anterior", addonId: "a", addonName: "A", label: "Show.S01E02.1080p.WEB-DL-CtrlHD", kind: "direct" as const },
    { id: "salvo-proprio", addonId: "a", addonName: "A", label: "Show.S01E02.720p.WEB-DL-Outro", kind: "direct" as const }
  ];
  const chosen = resolveContinuitySource(streams, {
    ownSaved: { addonId: "a", streamId: "salvo-proprio", infoHash: null, fileIdx: null, releaseTitle: null },
    previousEpisode: { addonId: "a", streamId: "x", infoHash: null, fileIdx: null, releaseTitle: "Show.S01E01.1080p.WEB-DL-CtrlHD" }
  });
  assert.equal(chosen?.id, "release-anterior");
});

test("resolveContinuitySource cai para a retomada salva quando o lançamento anterior não é encontrado", () => {
  const streams = [
    { id: "salvo-proprio", addonId: "a", addonName: "A", label: "Show.S01E02.720p.WEB-DL-Outro", kind: "direct" as const }
  ];
  const chosen = resolveContinuitySource(streams, {
    ownSaved: { addonId: "a", streamId: "salvo-proprio", infoHash: null, fileIdx: null, releaseTitle: null },
    previousEpisode: { addonId: "a", streamId: "x", infoHash: null, fileIdx: null, releaseTitle: "Nada.A.Ver.Aqui" }
  });
  assert.equal(chosen?.id, "salvo-proprio");
});

test("resolveContinuitySource sem episódio anterior (abertura do zero) só usa a retomada salva", () => {
  const streams = [{ id: "salvo-proprio", addonId: "a", addonName: "A", label: "Filme", kind: "direct" as const }];
  const chosen = resolveContinuitySource(streams, {
    ownSaved: { addonId: "a", streamId: "salvo-proprio", infoHash: null, fileIdx: null, releaseTitle: null },
    previousEpisode: null
  });
  assert.equal(chosen?.id, "salvo-proprio");
  assert.equal(resolveContinuitySource(streams, { ownSaved: null, previousEpisode: null }), null);
});

test("matchTrackByLanguage normaliza o código (pt==por), ignora ID/nome e é insensível a maiúsculas", () => {
  const tracks = [
    { id: "novo-id-1", label: "Audio Track 1", language: "ENG" },
    { id: "novo-id-2", label: "Audio Track 2", language: "por" }
  ];
  assert.equal(matchTrackByLanguage(tracks, "pt")?.id, "novo-id-2", "pt e por são o mesmo idioma normalizado");
  assert.equal(matchTrackByLanguage(tracks, "por")?.id, "novo-id-2");
  assert.equal(matchTrackByLanguage(tracks, "eng")?.id, "novo-id-1");
  assert.equal(matchTrackByLanguage(tracks, "en")?.id, "novo-id-1");
  assert.equal(matchTrackByLanguage(tracks, null), null);
  assert.equal(matchTrackByLanguage(tracks, ""), null);
});

test("matchTrackByLanguage casa PT-BR (pob) e idiomas ISO 639-2, como o áudio original (jpn vs ja)", () => {
  const tracks = [
    { id: "pt-br", label: "Português", language: "pob" },
    { id: "japones", label: "Japanese", language: "jpn" }
  ];
  assert.equal(matchTrackByLanguage(tracks, "pt-BR")?.id, "pt-br");
  assert.equal(matchTrackByLanguage(tracks, "ja")?.id, "japones");
  // PT-BR e PT genérico continuam idiomas distintos para trilha (a substituição é só de legenda).
  assert.equal(matchTrackByLanguage(tracks, "pt"), null);
});

test("resolveContinuityTrack: o idioma do episódio anterior vence o ID salvo do episódio novo", () => {
  const tracks = [
    { id: "t1", label: "Português", language: "por" },
    { id: "t2", label: "English", language: "eng" }
  ];
  const chosen = resolveContinuityTrack(tracks, {
    ownSaved: { id: "t2", language: "eng", name: "English" },
    previousEpisodeLanguage: "por"
  });
  assert.equal(chosen?.id, "t1");
});

test("resolveContinuityTrack sem idioma do episódio anterior cai para a retomada salva", () => {
  const tracks = [{ id: "t1", label: "Português", language: "por" }];
  const chosen = resolveContinuityTrack(tracks, {
    ownSaved: { id: "t1", language: "por", name: "Português" },
    previousEpisodeLanguage: null
  });
  assert.equal(chosen?.id, "t1");
});

test("continuidade usa a legenda embutida ativa, mesmo fora da lista externa", () => {
  const tracks = [{ id: "4", label: "Português (Brasil)", language: null }];
  assert.deepEqual(subtitleContinuityFromTracks(tracks, "4", null), { language: "pt-BR" });
  assert.equal(subtitleContinuityFromTracks(tracks, null, null), null);
  assert.equal(subtitleContinuityFromTracks(tracks, null, null, true), "off");
  assert.deepEqual(subtitleContinuityFromTracks([], null, { id: "old", language: "pt-BR", name: "Português" }), { language: "pt-BR" });
  assert.deepEqual(subtitleContinuityFromTracks([], "7", { id: "7", language: "por", name: "Português" }), { language: "pt" });
  assert.equal(subtitleContinuityFromTracks([], "7", null), null);
});

test("episódio seguinte preserva a origem embutida e espera a faixa aparecer", () => {
  const externalIds = new Set(["opensubtitles-pt"]);
  const external = { id: "opensubtitles-pt", label: "Português externo", language: "pt-BR" };
  const embedded = { id: "12", label: "Português embutido", language: "pob" };
  assert.equal(matchSubtitleContinuityTrack([external], "pt-BR", "embedded", externalIds)?.id, external.id);
  assert.equal(matchSubtitleContinuityTrack([external, embedded], "pt-BR", "embedded", externalIds)?.id, embedded.id);
  assert.equal(matchSubtitleContinuityTrack([external, embedded], "pt-BR", "external", externalIds)?.id, external.id);
  const releaseMatched = { id: "release-pt", label: "Português do release", language: "pt-BR" };
  assert.equal(matchSubtitleContinuityTrack([external, releaseMatched], "pt-BR", "external",
    new Set([...externalIds, releaseMatched.id]), releaseMatched.id)?.id, releaseMatched.id);
  assert.equal(matchSubtitleContinuityTrack([], "pt-BR", "embedded", externalIds), null);
});

test("alterar áudio atualiza o cenário antes de pedir persistência imediata", () => {
  const events: string[] = [];
  let current: PlaybackScenario | null = {
    source: { addonId: "a", streamId: "s1", infoHash: null, fileIdx: null, releaseTitle: "Filme" }
  };

  commitScenarioChange({
    current,
    patch: { audio: { id: "pt-1", language: "pt", name: "Português 5.1" } },
    reading: { positionSeconds: 42, durationSeconds: 120 },
    update(next) {
      current = next;
      events.push(`update:${current.audio?.id}`);
    },
    persist(reading) {
      events.push(`persist:${current?.audio?.id}:${reading.positionSeconds}`);
    }
  });

  assert.deepEqual(events, ["update:pt-1", "persist:pt-1:42"]);
});

test("alteração no segundo zero fica no cenário sem gravar progresso inválido", () => {
  let current: PlaybackScenario = {};
  let persistCalls = 0;

  commitScenarioChange({
    current,
    patch: {
      subtitleSettings: {
        offset: -1.5, extraDuration: 0, color: "#ffffff", size: 100,
        bg: "translucent", font: "sans"
      }
    },
    reading: { positionSeconds: 0, durationSeconds: 120 },
    update(next) { current = next; },
    persist() { persistCalls += 1; }
  });

  assert.equal(current?.subtitleSettings?.offset, -1.5);
  assert.equal(persistCalls, 0);
});

test("continuidade captura áudio ativo automático, sem reutilizar ID de outro episódio", () => {
  const tracks = [{ id: "2", label: "Japonês", language: "jpn" }];
  const language = audioContinuityFromTracks(tracks, "2", null);
  assert.equal(language, "ja");
  const next = [{ id: "2", label: "English", language: "en" }, { id: "9", label: "Japanese", language: "ja" }];
  assert.equal(resolveContinuityTrack(next, { previousEpisodeLanguage: language, ownSaved: null })?.id, "9");
  assert.equal(audioContinuityFromTracks([], "2", { id: "3", language: "pt", name: "Português" }), null);
});

test("áudio salvo não adivinha entre duas faixas do mesmo idioma sem identificação", () => {
  const tracks = [{ id: "4", label: "Stereo", language: "en" }, { id: "9", label: "Surround", language: "eng" }];
  assert.equal(matchSavedAudioTrack(tracks, { id: "old", language: "en", name: "English" }), null);
});
