import assert from "node:assert/strict";
import test from "node:test";
import { durationMismatch, sourceMatch, type SourceMatchTarget } from "../app/player/source-match.js";

const osNormais: SourceMatchTarget = {
  type: "series", titles: ["Os Normais", "Os Normais"], year: 2001, season: 1, episode: 2, checkTitle: true
};

test("outra série com nome parecido é outro título (Normal People para Os Normais)", () => {
  for (const label of ["Normal People S01 2160p HULU WEBRip DDP5 1 x265 NTb [rartv]", "Normal.People.S01.1080p.AMZN.WEBRip.DDP5.1.x264-Cinefeel"]) {
    assert.deepEqual(sourceMatch({ label }, osNormais), { verdict: "mismatch", reason: "outro título" });
  }
  assert.equal(sourceMatch({ label: "Os.Normais.S01E02.DVDRip.XviD" }, osNormais).verdict, "match");
});

test("episódio declarado diferente é outro episódio; o arquivo vale mais que o pacote", () => {
  assert.deepEqual(sourceMatch({ label: "Os Normais S01E05 DVDRip" }, osNormais), { verdict: "mismatch", reason: "outro episódio" });
  assert.equal(sourceMatch({ label: "Os Normais S01 Completa", filename: "Os.Normais.S01E02.avi" }, osNormais).verdict, "match");
  assert.equal(sourceMatch({ label: "Os Normais S01 Completa", filename: "Os.Normais.S01E07.avi" }, osNormais).verdict, "mismatch");
  assert.equal(sourceMatch({ label: "Os Normais 1x02" }, osNormais).verdict, "match");
  assert.equal(sourceMatch({ label: "Os Normais S01E01-E03" }, osNormais).verdict, "match");
});

test("pacote de outra temporada é outra temporada; pacote sem episódio fica em dúvida", () => {
  assert.deepEqual(sourceMatch({ label: "Os Normais S02 Completa" }, osNormais), { verdict: "mismatch", reason: "outra temporada" });
  assert.equal(sourceMatch({ label: "Os Normais Temporadas 1 a 3" }, osNormais).verdict, "unknown");
  assert.equal(sourceMatch({ label: "Os Normais S01 Completa" }, osNormais).verdict, "unknown");
});

test("anime não confere o nome (romaji) e lote sem SxxEyy fica em dúvida", () => {
  const frieren: SourceMatchTarget = {
    type: "series", titles: ["Frieren: Beyond Journey's End", "Frieren e a Jornada para o Além", "葬送のフリーレン"],
    year: 2023, season: 1, episode: 1, checkTitle: false
  };
  assert.equal(sourceMatch({ label: "[Erai-raws] Sousou no Frieren - 01 ~ 28 [1080p][BATCH][Multiple Subtitle]" }, frieren).verdict, "unknown");
  assert.equal(sourceMatch({ label: "[ASW] Kimetsu no Yaiba S01E04 [1080p]" }, frieren).verdict, "mismatch");
});

test("filme: episódio de série e ano muito diferente não servem", () => {
  const duna: SourceMatchTarget = { type: "movie", titles: ["Duna", "Dune"], year: 2021, season: null, episode: null, checkTitle: true };
  assert.equal(sourceMatch({ label: "Dune.2021.2160p.WEB-DL.DDP5.1.Atmos.HEVC" }, duna).verdict, "match");
  assert.deepEqual(sourceMatch({ label: "Dune.1984.1080p.BluRay.x264" }, duna), { verdict: "mismatch", reason: "outro ano" });
  assert.deepEqual(sourceMatch({ label: "Dune Prophecy S01E01 1080p" }, duna), { verdict: "mismatch", reason: "um episódio de série" });
});

test("sem nome de lançamento útil, nada é descartado", () => {
  assert.equal(sourceMatch({ label: "1080p" }, osNormais).verdict, "unknown");
  assert.equal(sourceMatch({ label: "" }, { ...osNormais, titles: [] }).verdict, "unknown");
});

// Visto na TV em 31/10: antes do lançamento digital (17/11), todo "The Odyssey (2026) WEB-DL" era
// outro filme de mesmo nome e ano, e a escolha automática abria um documentário.
const odisseia: SourceMatchTarget = {
  type: "movie", titles: ["The Odyssey", "A Odisseia", "The Odyssey"], year: 2026, season: null, episode: null,
  checkTitle: true, runtimeMinutes: 172
};

test("trailer e amostra com o nome e o ano do filme não entram na escolha", () => {
  for (const source of [
    { label: "The Odyssey (2026) Official Teaser Trailer 4K.mkv" },
    { label: "MediaFusion | Midnight 🧲 ⏳ 2160p", addonName: "MediaFusion | Midnight", filename: "the-odyssey-2026-trailer-3-4k-uhd-lossless" },
    { label: "The.Odyssey.2026.1080p.WEB-DL", filename: "The.Odyssey.2026.Sample.mkv" },
    { label: "The_Odyssey_2026_Official_Trailer_4K" }
  ]) assert.deepEqual(sourceMatch(source, odisseia), { verdict: "mismatch", reason: "um trailer" });
  const serie: SourceMatchTarget = { type: "series", titles: ["Trailer Park Boys"], year: 2001, season: 1, episode: 1, checkTitle: true };
  assert.equal(sourceMatch({ label: "Trailer Park Boys S01E01 DVDRip" }, serie).verdict, "match");
});

test("rótulo com o nome do add-on (MediaFusion): quem nomeia o lançamento é o arquivo", () => {
  const mediafusion = (filename: string) => ({ label: "MediaFusion | Midnight 🧲 ⏳ 1080p", addonName: "MediaFusion | Midnight", filename });
  assert.equal(sourceMatch(mediafusion("The.Odyssey.2026.iNTERNAL.1080p.WEB-DL.AAC.x264-LuCY"), odisseia).verdict, "match");
  assert.deepEqual(sourceMatch(mediafusion("The Odyssey (1998) DVDRip-Upscale 4K AI Remaster"), odisseia), { verdict: "mismatch", reason: "outro ano" });
  assert.deepEqual(sourceMatch(mediafusion("Normal.People.S01E02.1080p"), osNormais), { verdict: "mismatch", reason: "outro título" });
  assert.equal(sourceMatch({ label: "MediaFusion | Midnight 🧲 ⏳ 1080p", addonName: "MediaFusion | Midnight" }, odisseia).verdict, "match");
});

test("lançamento que se declara outro filme é outro título", () => {
  for (const label of [
    "The Odyssey 2026 (NOT The Chris Nolan FILM) 1080p WEB-DL HEVC x265 5.1 BONE",
    "The.Odyssey.2026.720p.TUBI.WEB-DL.AAC2.0-NOtLAN (NOT The Chris Nolan FILM)",
    "The Odyssey 2026 NOT The Chris Nolan FILM 1080p WEB-DL HEVC x265 5 1-BONE"
  ]) assert.deepEqual(sourceMatch({ label }, odisseia), { verdict: "mismatch", reason: "outro título" });
  assert.equal(sourceMatch({ label: "The.Odyssey.2026.1080p.TELESYNC.HEVC.AAC2.0-SPLiCE" }, odisseia).verdict, "match");
});

test("filme aberto bem mais curto que a duração conhecida é outro vídeo", () => {
  assert.equal(durationMismatch(odisseia, 95 * 60), true);
  assert.equal(durationMismatch(odisseia, 165 * 60), false);
  // Corte de cinema de uma edição estendida (LOTR: 178 de 228 min) ainda passa.
  assert.equal(durationMismatch({ ...odisseia, runtimeMinutes: 228 }, 178 * 60), false);
  assert.equal(durationMismatch({ ...odisseia, runtimeMinutes: null }, 60 * 60), false);
  assert.equal(durationMismatch({ ...osNormais, runtimeMinutes: 30 }, 5 * 60), false);
  assert.equal(durationMismatch(null, 60), false);
});

test("filme ainda só no cinema: WEB-DL, WEBRip e BluRay com o nome dele são outro filme", () => {
  const antes = Date.parse("2026-10-31T12:00:00Z");
  const nosCinemas = { ...odisseia, homeReleaseDate: "2026-11-17" };
  for (const label of [
    "The Odyssey 2026 1080p AMZN WEB-DL DDP5 1 H 264-Kitsune",
    "The Odyssey (2026) [1080p] [WEBRip] [5.1]",
    "The.Odyssey.2026.1080p.BluRay.x264"
  ]) assert.deepEqual(sourceMatch({ label }, nosCinemas, antes), { verdict: "mismatch", reason: "outro título" });
  assert.deepEqual(sourceMatch({ label: "The Odyssey - Prologue (2025) IMAX DCPrip 4K" }, nosCinemas, antes), { verdict: "mismatch", reason: "um trailer" });
  assert.equal(sourceMatch({ label: "The.Odyssey.2026.1080p.TELESYNC.HEVC.AAC2.0-SPLiCE" }, nosCinemas, antes).verdict, "match");
  // Saiu em casa (ou sai em menos de 3 dias): o WEB-DL volta a valer.
  assert.equal(sourceMatch({ label: "The Odyssey 2026 1080p AMZN WEB-DL" }, nosCinemas, Date.parse("2026-11-15T12:00:00Z")).verdict, "match");
  assert.equal(sourceMatch({ label: "The Odyssey 2026 1080p AMZN WEB-DL" }, odisseia, antes).verdict, "match");
});
