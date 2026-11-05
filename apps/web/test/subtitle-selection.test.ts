import assert from "node:assert/strict";
import test from "node:test";
import {
  bestReleaseMatch,
  type SubtitleCandidate,
  nextSubtitleId,
  normalizeEmbeddedSubtitles,
  originalAudioTrackId,
  orderSubtitleCandidates,
  safeAutomaticSubtitleId,
  subtitleForAudio,
  trackLanguage,
  rankSubtitleCandidates,
  withoutOtherTitleSubtitles,
} from "../app/player/subtitle-selection.js";

const candidate = (id: string, language: string, label: string, details?: string) => ({ id, language, label, details });
const hashCandidate = (id: string, language: string, label: string, details: string, hashMatch: boolean) =>
  ({ id, language, label, details, hashMatch });

test("prioriza português do Brasil, depois português genérico e inglês", () => {
  const ordered = orderSubtitleCandidates([
    candidate("en", "eng", "English"),
    candidate("pt", "por", "Português"),
    candidate("br", "pob", "Português (Brasil)")
  ]);
  assert.deepEqual(ordered.map(({ id }) => id), ["br", "pt", "en"]);
});

test("escolhe automaticamente a melhor legenda em português entre várias", () => {
  assert.equal(safeAutomaticSubtitleId([
    candidate("b", "por", "Português"),
    candidate("a", "pob", "Português (Brasil)")
  ]), "a");
  assert.equal(safeAutomaticSubtitleId([
    candidate("en", "eng", "English"),
    candidate("pt", "pt", "Português")
  ]), "pt", "PT genérico serve quando não há PT-BR");
});

test("escolhe automaticamente a única legenda em português", () => {
  assert.equal(safeAutomaticSubtitleId([
    candidate("en", "eng", "English"),
    candidate("br", "pt-BR", "Português (Brasil)")
  ]), "br");
});

test("testar próxima percorre PT-BR e depois PT genérico em ciclo, sem inglês", () => {
  const candidates = [
    candidate("a", "pob", "PT-BR A"),
    candidate("pt", "por", "Português"),
    candidate("en", "eng", "English"),
    candidate("b", "pt-BR", "Português (Brasil) B")
  ];
  assert.equal(nextSubtitleId(candidates, null), "a");
  assert.equal(nextSubtitleId(candidates, "a"), "b");
  assert.equal(nextSubtitleId(candidates, "b"), "pt");
  assert.equal(nextSubtitleId(candidates, "pt"), "a");
  assert.equal(nextSubtitleId([candidate("en", "eng", "English")], null), null);
});

test("identifica idioma pelo metadado e pelo nome mostrado pelo motor", () => {
  assert.equal(trackLanguage({ language: "pob", label: "Audio 1" }), "pt-BR");
  assert.equal(trackLanguage({ language: null, label: "Português do Brasil - 5.1" }), "pt-BR");
  assert.equal(trackLanguage({ language: "eng", label: "Audio 2" }), "en");
});

test("seleciona faixa no idioma original quando o arquivo inicia em outra língua", () => {
  const tracks = [
    { id: "dub", language: "por", label: "Português" },
    { id: "original", language: "jpn", label: "Japanese" }
  ];
  assert.equal(originalAudioTrackId(tracks, "ja", "dub"), "original");
  assert.equal(originalAudioTrackId(tracks, "fr", "dub"), null);
});

test("áudio português desliga legenda e áudio estrangeiro liga a única legenda portuguesa", () => {
  const subtitles = [candidate("br", "pt-BR", "Português (Brasil)"), candidate("en", "eng", "English")];
  assert.equal(subtitleForAudio({ language: "por", label: "Português" }, subtitles, "br"), null);
  assert.equal(subtitleForAudio({ language: "eng", label: "English" }, subtitles, null), "br");
});

test("sem releaseLabel, escolhe a primeira legenda portuguesa na ordem de sempre", () => {
  assert.equal(safeAutomaticSubtitleId([
    candidate("b", "por", "Português", "Show.S01E01.WEB-DL-Grupo"),
    candidate("a", "pob", "Português (Brasil)", "Show.S01E01.BluRay-Outro")
  ]), "a");
});

test("com releaseLabel, o grupo de release da legenda que bate com a fonte escolhida vence", () => {
  const candidates = [
    candidate("sem-match", "pob", "Português (Brasil)", "Show.S01E01.1080p.WEB-DL-Outro"),
    candidate("com-match", "pob", "Português (Brasil)", "Show.S01E01.1080p.WEB-DL-CtrlHD")
  ];
  assert.equal(safeAutomaticSubtitleId(candidates, "Show.S01E01.1080p.WEB-DL-CtrlHD"), "com-match");
});

test("o casamento de release nunca atravessa o nível de idioma: PT-BR ganha de PT mesmo com pior match", () => {
  const candidates = [
    candidate("pt-bom-match", "por", "Português", "Filme.2024.1080p.BluRay-CtrlHD"),
    candidate("ptbr-sem-match", "pob", "Português (Brasil)", "Filme.2024.1080p.WEB-DL-Outro")
  ];
  assert.equal(safeAutomaticSubtitleId(candidates, "Filme.2024.1080p.BluRay-CtrlHD"), "ptbr-sem-match");
});

test("sem nenhuma legenda batendo tokens do release, a ordem de chegada desempata", () => {
  const candidates = [
    candidate("primeira", "pob", "Português (Brasil)", "Sem relação nenhuma"),
    candidate("segunda", "pob", "Português (Brasil)", "Outra coisa qualquer")
  ];
  assert.equal(safeAutomaticSubtitleId(candidates, "Filme.2024.1080p.BluRay-CtrlHD"), "primeira");
});

test("bestReleaseMatch funciona em qualquer idioma, não só português (continuidade de episódio)", () => {
  const candidates = [
    candidate("en-outro", "eng", "English", "Show.S02E02.1080p.WEB-DL-Outro"),
    candidate("en-mesmo-grupo", "eng", "English", "Show.S02E02.1080p.WEB-DL-CtrlHD")
  ];
  const match = bestReleaseMatch(candidates, "Show.S02E01.1080p.WEB-DL-CtrlHD");
  assert.equal(match?.id, "en-mesmo-grupo");
});

test("bestReleaseMatch sem candidatas devolve null; sem releaseLabel devolve a primeira", () => {
  assert.equal(bestReleaseMatch([], "qualquer"), null);
  const candidates = [candidate("a", "eng", "A"), candidate("b", "eng", "B")];
  assert.equal(bestReleaseMatch(candidates)?.id, "a");
});

test("com áudio estrangeiro liga a melhor legenda PT e respeita a que já está ativa", () => {
  const subtitles = [candidate("b", "por", "PT release B"), candidate("a", "pob", "PT-BR release A")];
  assert.equal(subtitleForAudio({ language: "eng", label: "English" }, subtitles, null), "a");
  assert.equal(subtitleForAudio({ language: "eng", label: "English" }, subtitles, "b"), "b");
});

test("hashMatch (OpenSubtitles casou pelo arquivo) vence mesmo com pior pontuação de release", () => {
  const candidates = [
    hashCandidate("bom-token-sem-hash", "pob", "Português (Brasil)", "Filme.2024.1080p.BluRay-CtrlHD", false),
    hashCandidate("hash-mas-sem-token", "pob", "Português (Brasil)", "Sem relação nenhuma", true)
  ];
  assert.equal(safeAutomaticSubtitleId(candidates, "Filme.2024.1080p.BluRay-CtrlHD"), "hash-mas-sem-token");
});

test("hashMatch nunca atravessa o nível de idioma: a regra de tier (PT-BR antes de PT) continua valendo", () => {
  // Mesmo um PT genérico com hash confirmado não pode vencer um PT-BR sem hash: casar pelo
  // arquivo desempata SÓ dentro do mesmo idioma, nunca entre PT-BR e PT.
  const candidates = [
    hashCandidate("pt-com-hash", "por", "Português", "Filme.2024.1080p.BluRay-CtrlHD", true),
    candidate("ptbr-sem-hash", "pob", "Português (Brasil)", "Sem relação nenhuma")
  ];
  assert.equal(safeAutomaticSubtitleId(candidates, "Filme.2024.1080p.BluRay-CtrlHD"), "ptbr-sem-hash");
});

test("OpenSubtitles agora usa subtitleFileName/movieReleaseName como details na pontuação de release", () => {
  // `details` aqui simula o que o gateway agora extrai de subtitleFileName/movieReleaseName do
  // OpenSubtitles v3 (antes ficava sempre vazio, porque o add-on não manda `label`).
  const candidates = [
    candidate("sem-match", "pob", "Português (Brasil)", "Filme.2024.720p.WEB-DL-Outro"),
    candidate("com-match", "pob", "Português (Brasil)", "Filme.2024.1080p.BluRay-CtrlHD")
  ];
  assert.equal(safeAutomaticSubtitleId(candidates, "Filme.2024.1080p.BluRay-CtrlHD"), "com-match");
});

test("testar próxima (tecla C) cicla na mesma ordem ranqueada: hash primeiro, depois pontuação de release", () => {
  const candidates = [
    hashCandidate("ptbr-token", "pob", "Português (Brasil) A", "Filme.2024.1080p.BluRay-CtrlHD", false),
    hashCandidate("ptbr-hash", "pob", "Português (Brasil) B", "Sem relação nenhuma", true),
    candidate("pt-generico", "por", "Português", "Filme.2024.1080p.BluRay-CtrlHD"),
    candidate("en", "eng", "English")
  ];
  const releaseLabel = "Filme.2024.1080p.BluRay-CtrlHD";
  // Dentro do tier PT-BR, hash vence o token; só depois vem o tier PT; inglês nunca entra no ciclo.
  assert.equal(nextSubtitleId(candidates, null, releaseLabel), "ptbr-hash");
  assert.equal(nextSubtitleId(candidates, "ptbr-hash", releaseLabel), "ptbr-token");
  assert.equal(nextSubtitleId(candidates, "ptbr-token", releaseLabel), "pt-generico");
  assert.equal(nextSubtitleId(candidates, "pt-generico", releaseLabel), "ptbr-hash");
});

test("lista para o player nativo sai ranqueada: idioma, depois hash, depois release", () => {
  const ranked = rankSubtitleCandidates([
    { id: "en", language: "eng", label: "Inglês" },
    { id: "pt-release", language: "pob", label: "Português (Brasil)", details: "Show.S01E01.1080p.WEB-DL-GRP" },
    { id: "pt-hash", language: "pob", label: "Português (Brasil) 2", hashMatch: true },
    { id: "pt-generic", language: "por", label: "Português" },
    { id: "pt-plain", language: "pob", label: "Português (Brasil) 3" }
  ], "Show.S01E01.1080p.WEB-DL-GRP.mkv");
  assert.deepEqual(ranked.map((candidate) => candidate.id), ["pt-hash", "pt-release", "pt-plain", "pt-generic", "en"]);
});

test("timingVerdicts (camada 3): candidata já flagrada com timing ruim vai para o fim do MESMO idioma", () => {
  const candidates = [
    candidate("ptbr-ruim", "pob", "Português (Brasil) A"),
    candidate("ptbr-nao-testada", "pob", "Português (Brasil) B")
  ];
  const timingVerdicts = new Map([["ptbr-ruim", "too-short" as const]]);
  assert.equal(safeAutomaticSubtitleId(candidates, null, timingVerdicts), "ptbr-nao-testada");
  assert.deepEqual(
    rankSubtitleCandidates(candidates, null, timingVerdicts).map((c) => c.id),
    ["ptbr-nao-testada", "ptbr-ruim"]
  );
});

test("timingVerdicts: veredito 'ok' não perde para uma candidata nunca testada", () => {
  const candidates = [
    candidate("ptbr-ok", "pob", "Português (Brasil) A"),
    candidate("ptbr-nao-testada", "pob", "Português (Brasil) B")
  ];
  const timingVerdicts = new Map([["ptbr-ok", "ok" as const]]);
  // Ambas ficam com timingRank 0 (ok/desconhecida); a ordem de chegada decide, como sem o mapa.
  assert.equal(safeAutomaticSubtitleId(candidates, null, timingVerdicts), "ptbr-ok");
});

test("timingVerdicts nunca atravessa o nível de idioma: PT-BR com timing ruim continua antes de PT", () => {
  const candidates = [
    candidate("ptbr-ruim", "pob", "Português (Brasil)"),
    candidate("pt-generico", "por", "Português")
  ];
  const timingVerdicts = new Map([["ptbr-ruim", "fps-drift" as const]]);
  assert.equal(safeAutomaticSubtitleId(candidates, null, timingVerdicts), "ptbr-ruim");
});

test("timingVerdicts vence a pontuação de release E o hashMatch dentro do mesmo idioma (verificação > dedução)", () => {
  const candidates = [
    hashCandidate("bom-release-ruim", "pob", "Português (Brasil) A", "Filme.2024.1080p.BluRay-CtrlHD", false),
    candidate("sem-match-ok", "pob", "Português (Brasil) B", "Sem relação nenhuma")
  ];
  const timingVerdicts = new Map([["bom-release-ruim", "too-long" as const]]);
  assert.equal(safeAutomaticSubtitleId(candidates, "Filme.2024.1080p.BluRay-CtrlHD", timingVerdicts), "sem-match-ok",
    "mesmo com melhor pontuação de release, perde por timing já confirmado ruim");

  const comHash = [
    hashCandidate("hash-mas-ruim", "pob", "Português (Brasil) A", "Sem relação nenhuma", true),
    candidate("sem-hash-ok", "pob", "Português (Brasil) B", "Sem relação nenhuma")
  ];
  const timingVerdicts2 = new Map([["hash-mas-ruim", "too-long" as const]]);
  assert.equal(safeAutomaticSubtitleId(comHash, null, timingVerdicts2), "sem-hash-ok",
    "timing ruim já verificado vence até hashMatch: é verificação direta do arquivo, não dedução");
});

test("remove legendas de outro filme da franquia (ano ou parte diferente)", () => {
  const godfather = { type: "movie", year: 1972, name: "O Poderoso Chefão", originalName: "The Godfather" };
  const subs = [
    candidate("p2", "pob", "Português", "The Godfather Part 2 1974"),
    candidate("p3", "pob", "Português", "The.Godfather.Part.III.1990.720p.BluRay"),
    candidate("d1", "pob", "Português", "The Godfather Part II - Disc 1 (1974)"),
    candidate("mnm", "pob", "Português", "The Godfather Part II Disk 1 DVDRip H264 [MnM-RG]"),
    candidate("yify", "pob", "Português", "The.Godfather.Part.I.1972.720p.BrRip.x264.YIFY"),
    candidate("uhd", "pob", "Português", "The Godfather.1972.REPACK.UHD.BluRay.2160p.x265")
  ];
  assert.deepEqual(withoutOtherTitleSubtitles(subs, godfather).map(({ id }) => id), ["yify", "uhd"]);
});

test("filtro de outro filme: parte 1 em título sem parte fica; série nunca filtra; nunca esvazia", () => {
  const movie = { type: "movie", year: 1972, name: "The Godfather" };
  assert.equal(withoutOtherTitleSubtitles([candidate("a", "pob", "x", "Godfather Part 1")], movie).length, 1);
  const subs = [candidate("p2", "pob", "x", "The Godfather Part 2 1974")];
  assert.equal(withoutOtherTitleSubtitles(subs, { ...movie, type: "series" }), subs);
  assert.equal(withoutOtherTitleSubtitles(subs, movie), subs);
});

test("título 'The Godfather Part II' (1974) mantém Part II e remove Part I/1972", () => {
  const part2 = { type: "movie", year: 1974, name: "The Godfather Part II" };
  const result = withoutOtherTitleSubtitles([
    candidate("one", "pob", "x", "The.Godfather.Part.I.1972.720p"),
    candidate("two", "pob", "x", "The Godfather Part II 1974 1080p")
  ], part2);
  assert.deepEqual(result.map(({ id }) => id), ["two"]);
});

test("ano que faz parte do nome do filme não conta como ano de lançamento", () => {
  const subtitles = [
    { id: "a", language: "pt-BR", label: "PT", details: "Blade.Runner.2049.2017.1080p.BluRay" },
    { id: "b", language: "pt-BR", label: "PT 2", details: "Blade.Runner.1982.Final.Cut" },
    { id: "c", language: "pt-BR", label: "PT 3", details: "legenda.srt" }
  ];
  const kept = withoutOtherTitleSubtitles(subtitles, { type: "movie", year: 2017, name: "Blade Runner 2049" });
  assert.deepEqual(kept.map((subtitle) => subtitle.id), ["a", "c"]);
});

test("legendas embutidas do MKV: PT-BR normalizada, hashMatch e preferida sobre externas", () => {
  const raw: Array<SubtitleCandidate & { addonName: string }> = [
    { id: "embedded:0", addonName: "Arquivo", label: "Inglês", language: "en", details: "English" },
    { id: "embedded:1", addonName: "Arquivo", label: "Português", language: "pt", details: "Portuguese(Brazil)" },
    { id: "embedded:2", addonName: "Arquivo", label: "Espanhol", language: "es", details: "Spanish(Latin_America)" },
    { id: "embedded:3", addonName: "Arquivo", label: "Português 2", language: "por", details: "Signs" }
  ];
  const [en, ptBr, es, ptSigns] = normalizeEmbeddedSubtitles(raw);
  assert.equal(ptBr!.language, "pt-BR");
  assert.equal(ptBr!.label, "Português (Brasil)");
  assert.equal(ptBr!.addonName, "Embutida");
  assert.equal(ptBr!.hashMatch, true);
  assert.equal(ptBr!.details, undefined);
  assert.equal(en!.details, undefined);
  assert.equal(es!.details, undefined);
  assert.equal(ptSigns!.language, "pt");
  assert.equal(ptSigns!.label, "Português");
  assert.equal(ptSigns!.details, "Signs");

  const external = [
    { id: "ext-1", language: "pt-BR", label: "Português (Brasil)", details: "One.Piece.1068-Erai-raws" },
    { id: "ext-2", language: "pt-BR", label: "Português (Brasil)" }
  ];
  assert.equal(safeAutomaticSubtitleId([...external, ...normalizeEmbeddedSubtitles(raw)]), "embedded:1");
});
