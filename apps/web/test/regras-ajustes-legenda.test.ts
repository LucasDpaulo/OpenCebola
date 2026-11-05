import assert from "node:assert/strict";
import test from "node:test";
import { updateWatchProgressRequestSchema } from "@cebola/contracts";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ajustesIniciais, CHAVE_DO_APARELHO, DEFAULT_SUBTITLE_SETTINGS, gravarAjustesDoAparelho, lerAjustesDoAparelho, paraOCenario, soDoAparelho
} from "../app/player/regras/ajustes-legenda.js";

const withoutDeviceOnlySettings = paraOCenario;

/** Armazenamento falso em memória, com a mesma forma mínima do `Storage`. */
function memoria(inicial: Record<string, string> = {}) {
  const dados = new Map(Object.entries(inicial));
  return {
    getItem: (k: string) => dados.get(k) ?? null,
    setItem: (k: string, v: string) => { dados.set(k, v); },
    dados
  };
}

const settings = { offset: 0.5, extraDuration: 0, color: "#fbbf24", size: 100, bg: "transparent" as const, font: "sans" as const };

function progressPayload(subtitleSettings: object) {
  return {
    addonId: "editorial.tmdb", mediaId: "tmdb:1", videoId: "tmdb:1", mediaType: "movie",
    title: "Filme", episodeTitle: null, season: null, episode: null, posterUrl: null,
    positionSeconds: 120, durationSeconds: 6000, completed: false,
    playbackScenario: { source: null, audio: { id: "2", language: "en", name: "Track 2" }, subtitle: null, subtitleSettings }
  };
}

test("altura da legenda (só do aparelho) nunca chega ao servidor", () => {
  assert.deepEqual(withoutDeviceOnlySettings({ ...settings, position: 16 }), settings);
});

test("fonte e contorno da TV (só do aparelho) também não chegam ao servidor", () => {
  const device = { ...settings, position: 8, fontFace: "roboto" as const, edge: "outline" as const };
  assert.deepEqual(withoutDeviceOnlySettings(device), settings);
  const result = updateWatchProgressRequestSchema.safeParse(progressPayload(withoutDeviceOnlySettings(device)));
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
});

test("o salvamento de progresso com ajustes de legenda continua aceito pela API", () => {
  // Regressão de 30/09: `position` ia no cenário e o contrato estrito recusava o salvamento
  // inteiro — áudio, legenda e posição do vídeo deixavam de ser guardados.
  assert.equal(updateWatchProgressRequestSchema.safeParse(progressPayload({ ...settings, position: 16 })).success, false);
  const result = updateWatchProgressRequestSchema.safeParse(progressPayload(withoutDeviceOnlySettings({ ...settings, position: 16 })));
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
});

test("bug do vazamento: offset antigo gravado no aparelho não vale para vídeo sem cenário", () => {
  const aparelho = lerAjustesDoAparelho(memoria({ [CHAVE_DO_APARELHO]: JSON.stringify({ ...settings, offset: 2, extraDuration: 1.5, size: 130 }) }));
  const r = ajustesIniciais({ continuidade: null, salvo: null, aparelho });
  assert.equal(r.offset, 0);
  assert.equal(r.extraDuration, 0);
  assert.equal(r.size, 130, "a aparência do aparelho continua valendo");
});

test("cenário salvo do vídeo manda na sincronia; altura/fonte/contorno vêm do aparelho", () => {
  const aparelho = lerAjustesDoAparelho(memoria({ [CHAVE_DO_APARELHO]: JSON.stringify({ position: 12, fontFace: "roboto", edge: "outline", offset: 9 }) }));
  const r = ajustesIniciais({ continuidade: null, salvo: { ...settings, offset: 1.5 }, aparelho });
  assert.equal(r.offset, 1.5);
  assert.equal(r.position, 12);
  assert.equal(r.fontFace, "roboto");
  assert.equal(r.edge, "outline");
});

test("com base presente, cor e tamanho do aparelho não sobrescrevem; altura, fonte da TV e contorno sim", () => {
  const aparelho = { color: "#ff0000", size: 150, bg: "solid" as const, position: 10, fontFace: "mono" as const, edge: "none" as const };
  const r = ajustesIniciais({ continuidade: null, salvo: { ...settings, offset: 1 }, aparelho });
  assert.equal(r.color, settings.color);
  assert.equal(r.size, settings.size);
  assert.equal(r.bg, settings.bg);
  assert.equal(r.position, 10);
  assert.equal(r.fontFace, "mono");
  assert.equal(r.edge, "none");
  assert.deepEqual(soDoAparelho(aparelho), { position: 10, fontFace: "mono", edge: "none" });
  assert.deepEqual(soDoAparelho({ color: "#000" }), {});
});

test("a continuidade do episódio anterior vence o cenário salvo", () => {
  const r = ajustesIniciais({ continuidade: { ...settings, offset: -0.5 }, salvo: { ...settings, offset: 1.5 }, aparelho: {} });
  assert.equal(r.offset, -0.5);
});

test("sem entradas, o resultado é o padrão", () => {
  assert.deepEqual(ajustesIniciais({ continuidade: null, salvo: null, aparelho: {} }), DEFAULT_SUBTITLE_SETTINGS);
});

test("gravar nunca escreve offset nem extraDuration na chave do aparelho", () => {
  const m = memoria();
  gravarAjustesDoAparelho(m, { ...settings, offset: 3, extraDuration: 2, position: 8 });
  const gravado = JSON.parse(m.dados.get(CHAVE_DO_APARELHO) ?? "{}") as Record<string, unknown>;
  assert.equal("offset" in gravado, false);
  assert.equal("extraDuration" in gravado, false);
  assert.equal(gravado.position, 8);
  assert.equal(gravado.color, "#fbbf24");
});

test("gravar ignora erro do armazenamento e armazenamento ausente", () => {
  gravarAjustesDoAparelho({ setItem: () => { throw new Error("cheio"); } }, settings);
  gravarAjustesDoAparelho(null, settings);
});

test("ler ignora JSON inválido, erro e campos de tipo errado", () => {
  assert.deepEqual(lerAjustesDoAparelho(null), {});
  assert.deepEqual(lerAjustesDoAparelho(memoria()), {});
  assert.deepEqual(lerAjustesDoAparelho(memoria({ [CHAVE_DO_APARELHO]: "{quebrado" })), {});
  assert.deepEqual(lerAjustesDoAparelho(memoria({ [CHAVE_DO_APARELHO]: "[1]" })), {});
  assert.deepEqual(lerAjustesDoAparelho({ getItem: () => { throw new Error("bloqueado"); } }), {});
  const r = lerAjustesDoAparelho(memoria({ [CHAVE_DO_APARELHO]: JSON.stringify({
    color: 5, size: "grande", bg: "rosa", font: 1, position: "alto", fontFace: "comic", edge: null, offset: 2, extraDuration: 1
  }) }));
  assert.deepEqual(r, {});
});

test("paraOCenario tira só position, fontFace e edge", () => {
  const completo = { ...settings, offset: 1, extraDuration: 2, position: 4, fontFace: "arial" as const, edge: "shadow" as const };
  assert.deepEqual(paraOCenario(completo), { ...settings, offset: 1, extraDuration: 2 });
});

test("guarda: só regras/ajustes-legenda.ts contém a chave do aparelho", () => {
  const appDir = fileURLToPath(new URL("../app", import.meta.url));
  const arquivos = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const caminho = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : arquivos(caminho);
    return /\.(ts|tsx)$/.test(e.name) ? [caminho] : [];
  });
  const todos = arquivos(appDir);
  assert.ok(todos.length > 50);
  const donos = todos.filter((f) => readFileSync(f, "utf8").includes("cebola:player:subtitle_settings")).map((f) => relative(appDir, f));
  assert.deepEqual(donos, [join("player", "regras", "ajustes-legenda.ts")]);
});
