import assert from "node:assert/strict";
import test from "node:test";
import { rankAutomaticSources } from "../app/player/source-ranking.js";

const source = (id: string, extra: Record<string, unknown> = {}) => ({
  id, addonId: "addon", kind: "direct" as const, readyNow: true, quality: "1080p",
  label: "1080p WEB-DL", audioLanguages: [] as string[], dubbed: false, seeders: 10,
  ...extra
});

test("idioma original anunciado vence dublagem mesmo com menos seeders", () => {
  const ranked = rankAutomaticSources([
    source("dub", { audioLanguages: ["pt"], dubbed: true, seeders: 500 }),
    source("original", { audioLanguages: ["ja"], seeders: 12 })
  ], { originalLanguage: "ja", compactScreen: false, compatible: () => true });
  assert.equal(ranked[0]?.id, "original");
});

test("release conhecido vence 4K sem indicação de origem e seeders só desempata", () => {
  const ranked = rankAutomaticSources([
    source("4k", { quality: "4K", label: "2160p", seeders: 300 }),
    source("bluray", { quality: "1080p", label: "1080p BluRay", seeders: 5 })
  ], { originalLanguage: null, compactScreen: false, compatible: () => true });
  assert.equal(ranked[0]?.id, "bluray");
});

test("fonte pronta e compatível permanece à frente da que exige preparação", () => {
  const ranked = rankAutomaticSources([
    source("pending", { readyNow: false, label: "BluRay" }),
    source("ready", { readyNow: true, label: "WEB-DL" })
  ], { originalLanguage: "en", compactScreen: false, compatible: () => true });
  assert.equal(ranked[0]?.id, "ready");
});

test("legenda em português anunciada pela fonte vence quem não anuncia nenhuma", () => {
  const ranked = rankAutomaticSources([
    source("sem-legenda", { seeders: 900 }),
    source("com-legenda-br", { subtitleLanguages: ["pt-BR"], seeders: 1 })
  ], { originalLanguage: null, compactScreen: false, compatible: () => true });
  assert.equal(ranked[0]?.id, "com-legenda-br");
});

test("legenda pt/por/pob são todas reconhecidas como português anunciado", () => {
  for (const code of ["pt", "pt-BR", "por", "pob"]) {
    const ranked = rankAutomaticSources([
      source("sem", { seeders: 900 }),
      source("com", { subtitleLanguages: [code], seeders: 1 })
    ], { originalLanguage: null, compactScreen: false, compatible: () => true });
    assert.equal(ranked[0]?.id, "com", `código ${code} deveria contar como português`);
  }
});

test("4K e 1080p contam como o mesmo patamar de resolução", () => {
  const ranked = rankAutomaticSources([
    source("4k-generico", { quality: "4K", label: "2160p", seeders: 300 }),
    source("1080p-generico", { quality: "1080p", label: "1080p", seeders: 12 })
  ], { originalLanguage: null, compactScreen: false, compatible: () => true });
  // Empate total até seeders: quem tem mais seeders desempata, não a resolução nominal.
  assert.equal(ranked[0]?.id, "4k-generico");
});

test("4K continua penalizado abaixo de 480p em tela compacta", () => {
  const ranked = rankAutomaticSources([
    source("480p", { quality: "480p", seeders: 1 }),
    source("4k", { quality: "4K", seeders: 900 })
  ], { originalLanguage: null, compactScreen: true, compatible: () => true });
  assert.equal(ranked[0]?.id, "480p");
});

test("arquivo maior que 40 GB perde para um menor em qualquer tela", () => {
  const ranked = rankAutomaticSources([
    source("gigante", { sizeLabel: "45.5 GB", seeders: 900 }),
    source("normal", { sizeLabel: "3.2 GB", seeders: 1 })
  ], { originalLanguage: null, compactScreen: false, compatible: () => true });
  assert.equal(ranked[0]?.id, "normal");
});

test("em tela compacta, mais de 20 GB já perde para um arquivo menor", () => {
  const ranked = rankAutomaticSources([
    source("grande", { sizeLabel: "25 GB", seeders: 900 }),
    source("pequeno", { sizeLabel: "943.72 MB", seeders: 1 })
  ], { originalLanguage: null, compactScreen: true, compatible: () => true });
  assert.equal(ranked[0]?.id, "pequeno");
});

test("25 GB não é penalizado fora de tela compacta", () => {
  const ranked = rankAutomaticSources([
    source("25gb", { sizeLabel: "25 GB", seeders: 1 }),
    source("1gb", { sizeLabel: "1 GB", seeders: 900 })
  ], { originalLanguage: null, compactScreen: false, compatible: () => true });
  // Nenhum dos dois é penalizado por tamanho (< 40 GB): seeders decide.
  assert.equal(ranked[0]?.id, "1gb");
});

test("tamanho desconhecido é neutro, não penalizado como um arquivo grande demais", () => {
  const ranked = rankAutomaticSources([
    source("sem-tamanho", { sizeLabel: undefined, seeders: 1 }),
    source("gigante", { sizeLabel: "50 GB", seeders: 900 })
  ], { originalLanguage: null, compactScreen: false, compatible: () => true });
  // Se "sem tamanho" fosse tratado como penalizado, o de 900 seeders venceria mesmo assim.
  assert.equal(ranked[0]?.id, "sem-tamanho");
});

test("BluRay e WEB-DL empatam; Remux não ganha bônus extra sobre eles", () => {
  const ranked = rankAutomaticSources([
    source("remux", { label: "1080p Remux", seeders: 1 }),
    source("webdl", { label: "1080p WEB-DL", seeders: 900 })
  ], { originalLanguage: null, compactScreen: false, compatible: () => true });
  assert.equal(ranked[0]?.id, "webdl", "empatados em release, seeders desempata");
});

test("WEBRip perde para WEB-DL/BluRay mesmo com mais seeders", () => {
  const ranked = rankAutomaticSources([
    source("webrip", { label: "1080p WEBRip", seeders: 900 }),
    source("webdl", { label: "1080p WEB-DL", seeders: 1 })
  ], { originalLanguage: null, compactScreen: false, compatible: () => true });
  assert.equal(ranked[0]?.id, "webdl");
});

test("add-on preferido desempata antes de seeders, mas só quando o resto já empatou", () => {
  // Empatados em tudo que vem antes (imagem, tamanho, release): o add-on da última sessão decide,
  // mesmo com menos seeders — o desempate por add-on vem antes do desempate por seeders.
  const ranked = rankAutomaticSources([
    source("outro-addon", { addonId: "outro", seeders: 900 }),
    source("addon-preferido", { addonId: "favorito", seeders: 1 })
  ], { originalLanguage: null, compactScreen: false, compatible: () => true, preferredAddonId: "favorito" });
  assert.equal(ranked[0]?.id, "addon-preferido");
});

test("add-on preferido nunca supera um critério de imagem melhor", () => {
  const ranked = rankAutomaticSources([
    source("melhor-imagem-outro-addon", { addonId: "outro", label: "1080p WEB-DL", seeders: 1 }),
    source("pior-imagem-addon-favorito", { addonId: "favorito", label: "1080p WEBRip", seeders: 900 })
  ], { originalLanguage: null, compactScreen: false, compatible: () => true, preferredAddonId: "favorito" });
  assert.equal(ranked[0]?.id, "melhor-imagem-outro-addon");
});


test("perfil econômico prefere H264 Full HD a 4K e Remux sem perder idioma e legenda", () => {
  const ranked = rankAutomaticSources([
    source("4k", { quality: "4K", label: "2160p HEVC" }),
    source("remux", { label: "1080p Remux" }),
    source("leve", { label: "1080p WEB-DL H264" })
  ], { originalLanguage: null, compactScreen: false, lowPower: true, compatible: () => true });
  assert.equal(ranked[0]?.id, "leve");
  const subtitles = rankAutomaticSources([
    source("leve", { label: "1080p H264" }),
    source("pt", { label: "1080p HEVC", subtitleLanguages: ["pt"] })
  ], { originalLanguage: null, compactScreen: true, lowPower: true, compatible: () => true });
  assert.equal(subtitles[0]?.id, "pt");
});

test("com o motor local, torrent vence link direto mesmo pronto", () => {
  const sources = [
    source("direto", { readyNow: true, label: "1080p WEB-DL" }),
    source("torrent", { kind: "torrent", readyNow: null, label: "1080p WEB-DL" })
  ];
  const context = { originalLanguage: null, compactScreen: false, compatible: () => true };
  assert.equal(rankAutomaticSources(sources, context)[0]?.id, "direto");
  assert.equal(rankAutomaticSources(sources, { ...context, preferTorrents: true })[0]?.id, "torrent");
});

test("Fenixflix nunca entra na escolha automática, mesmo sendo a única fonte", () => {
  const context = { originalLanguage: null, compactScreen: false, compatible: () => true };
  const fenix = source("fenix", { addonId: "org.fenixflix.addon", addonName: "FenixFlix" });
  assert.deepEqual(rankAutomaticSources([fenix], context), []);
  assert.equal(rankAutomaticSources([fenix, source("outro")], context)[0]?.id, "outro");
});

test("com o motor local, torrent com seeders vence 4K sem gente compartilhando", () => {
  const context = { originalLanguage: null, compactScreen: false, compatible: () => true, preferTorrents: true };
  const ranked = rankAutomaticSources([
    source("4k-morto", { kind: "torrent", quality: "4K", label: "2160p BluRay", seeders: 1 }),
    source("1080p-vivo", { kind: "torrent", quality: "1080p", label: "1080p WEBRip", seeders: 40 })
  ], context);
  assert.equal(ranked[0]?.id, "1080p-vivo");
  // Sem o motor local (RD) a saúde do enxame não pesa: o release decide.
  assert.equal(rankAutomaticSources(ranked, { ...context, preferTorrents: false })[0]?.id, "4k-morto");
});

test("TV 4K: 4K saudável vem antes do 1080p; sem prefer4k, continua o mesmo patamar", () => {
  const fontes = [
    source("1080", { kind: "torrent", quality: "1080p", label: "1080p BluRay x264", seeders: 80 }),
    source("4k", { kind: "torrent", quality: "4K", label: "2160p WEB-DL HEVC 10bit", seeders: 40 }),
    source("4k-morto", { kind: "torrent", quality: "4K", label: "2160p BluRay", seeders: 1 })
  ];
  const tv = { originalLanguage: null, compactScreen: false, compatible: () => true, preferTorrents: true, lowPower: true };
  assert.equal(rankAutomaticSources(fontes, { ...tv, prefer4k: true })[0]?.id, "4k");
  assert.equal(rankAutomaticSources(fontes, tv)[0]?.id, "1080");
});

test("idiomas do cenário salvo valem mais que o áudio original e a legenda PT padrão", () => {
  const fontes = [
    source("original", { audioLanguages: ["jpn"], subtitleLanguages: ["pob"] }),
    source("dublado", { audioLanguages: ["pt"], dubbed: true, subtitleLanguages: ["eng"] })
  ];
  const base = { originalLanguage: "ja", compactScreen: false, compatible: () => true };
  assert.equal(rankAutomaticSources(fontes, base)[0]?.id, "original");
  assert.equal(rankAutomaticSources(fontes, { ...base, audioLanguage: "por" })[0]?.id, "dublado");
  const legendas = [source("pt", { subtitleLanguages: ["pt-BR"] }), source("en", { subtitleLanguages: ["en"] })];
  assert.equal(rankAutomaticSources(legendas, { ...base, subtitleLanguage: "eng" })[0]?.id, "en");
  assert.equal(rankAutomaticSources(legendas, base)[0]?.id, "pt");
});
