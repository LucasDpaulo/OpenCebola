import assert from "node:assert/strict";
import test from "node:test";
import { updateWatchProgressRequestSchema } from "@cebola/contracts";
import { buildProgressBody, type ProgressBodyInput } from "../app/progress/body.js";

const settings = { offset: 0.5, extraDuration: 0, color: "#fbbf24", size: 100, bg: "transparent", font: "sans" };
const source = {
  addonId: "torrentio", streamId: "abc", infoHash: "a".repeat(40), fileIdx: 3, releaseTitle: "Filme.2160p"
};
const track = { id: "2", language: "pt-BR", name: "Português" };

function movieInput(overrides: Partial<ProgressBodyInput> = {}): ProgressBodyInput {
  return {
    addonId: "editorial.tmdb", playbackAddonId: "torrentio", mediaId: "tmdb:240", videoId: "tt0071562",
    mediaType: "movie", title: "O Poderoso Chefão II", episodeTitle: null, season: null, episode: null,
    posterUrl: "https://image.tmdb.org/t/p/w500/x.jpg", positionSeconds: 1234.7, durationSeconds: 12000.2,
    completed: false, scenario: null, fallbackScenario: null,
    ...overrides
  };
}

/** Corpo ok, já lido como objeto. */
function ok(input: ProgressBodyInput): Record<string, unknown> {
  const result = buildProgressBody(input);
  if (!result.ok) assert.fail(`corpo recusado: ${result.reason}`);
  return JSON.parse(result.body) as Record<string, unknown>;
}

function scenarioOf(body: Record<string, unknown>): Record<string, unknown> | undefined {
  return body.playbackScenario as Record<string, unknown> | undefined;
}

test("corpo básico de filme: números inteiros e identidade canônica", () => {
  const body = ok(movieInput());
  assert.equal(body.positionSeconds, 1234);
  assert.equal(body.durationSeconds, 12000);
  assert.equal(body.mediaId, "tmdb:240");
  assert.equal(body.videoId, "tt0071562");
  assert.equal(body.completed, false);
  assert.equal(body.playbackScenario, undefined);
});

test("faixa sem idioma/nome (Track 2, vazio, só espaços) vira null e o corpo é válido", () => {
  const body = ok(movieInput({
    scenario: {
      audio: { id: "2", language: "", name: "Track 2" },
      subtitle: { id: "  ", language: "   ", name: "" }
    }
  }));
  assert.deepEqual(scenarioOf(body), {
    audio: { id: "2", language: null, name: "Track 2" },
    subtitle: { id: null, language: null, name: null }
  });
});

test("faixa vem aparada e cortada no máximo do contrato", () => {
  const body = ok(movieInput({
    scenario: { audio: { id: " 7 ", language: "x".repeat(80), name: ` ${"n".repeat(500)} ` } }
  }));
  const audio = scenarioOf(body)?.audio as { id: string; language: string; name: string };
  assert.equal(audio.id, "7");
  assert.equal(audio.language.length, 35);
  assert.equal(audio.name.length, 300);
});

test("ajustes de legenda com position e chave desconhecida: só as chaves do contrato seguem", () => {
  const body = ok(movieInput({ scenario: { subtitleSettings: { ...settings, position: 16, qualquerCoisa: true } } }));
  assert.deepEqual(scenarioOf(body)?.subtitleSettings, settings);
});

test("ajustes inválidos (size 500) usam os do fallback; a posição é salva", () => {
  const body = ok(movieInput({
    scenario: { source, audio: track, subtitleSettings: { ...settings, size: 500 } },
    fallbackScenario: { subtitleSettings: { ...settings, size: 120, position: 9 } }
  }));
  assert.deepEqual(scenarioOf(body)?.subtitleSettings, { ...settings, size: 120 });
  assert.deepEqual(scenarioOf(body)?.audio, track);
  assert.equal(body.positionSeconds, 1234);
});

test("ajustes inválidos sem fallback (ou com fallback também inválido) são omitidos; o resto fica", () => {
  for (const fallbackScenario of [undefined, null, { subtitleSettings: { ...settings, size: 999 } }, "lixo"]) {
    const body = ok(movieInput({
      scenario: { audio: track, subtitleSettings: { ...settings, size: 500 } }, fallbackScenario
    }));
    assert.deepEqual(scenarioOf(body), { audio: track });
    assert.equal(body.positionSeconds, 1234);
  }
});

test("fonte inválida (hash ruim): cai para a do fallback, ou é omitida; posição salva", () => {
  const ruim = { ...source, infoHash: "nao-e-um-hash" };
  const comFallback = ok(movieInput({ scenario: { source: ruim, audio: track }, fallbackScenario: { source } }));
  assert.deepEqual(scenarioOf(comFallback)?.source, source);
  assert.deepEqual(scenarioOf(comFallback)?.audio, track);

  const semFallback = ok(movieInput({ scenario: { source: ruim, audio: track } }));
  assert.deepEqual(scenarioOf(semFallback), { audio: track });
  assert.equal(semFallback.positionSeconds, 1234);
});

test("fonte nunca leva a url, que é temporária", () => {
  const body = ok(movieInput({ scenario: { source: { ...source, url: "https://debrid.example/arquivo.mkv" } } }));
  assert.deepEqual(scenarioOf(body)?.source, source);
});

test("cenário lixo (string, número, objeto com chave extra) vira corpo sem cenário, com a posição", () => {
  for (const scenario of ["lixo", 42, true, [], { foo: "bar" }, { extra: 1 }]) {
    const body = ok(movieInput({ scenario }));
    assert.equal(body.playbackScenario, undefined, JSON.stringify(scenario));
    assert.equal(body.positionSeconds, 1234);
  }
});

test("cenário que não é objeto cai inteiro para o fallback", () => {
  const body = ok(movieInput({ scenario: "lixo", fallbackScenario: { source, audio: track } }));
  assert.deepEqual(scenarioOf(body), { source, audio: track });
});

test("chave desconhecida no cenário é ignorada; as partes boas ficam", () => {
  const body = ok(movieInput({ scenario: { audio: track, foo: "bar" } }));
  assert.deepEqual(scenarioOf(body), { audio: track });
});

test("legenda desligada (subtitle: null) é preservada; parte ausente continua ausente", () => {
  const body = ok(movieInput({ scenario: { audio: track, subtitle: null, subtitleSettings: null } }));
  assert.deepEqual(scenarioOf(body), { audio: track, subtitle: null, subtitleSettings: null });
  assert.equal("source" in (scenarioOf(body) ?? {}), false);
});

test("parte ausente não é preenchida pelo fallback", () => {
  const body = ok(movieInput({ scenario: { audio: track }, fallbackScenario: { source, subtitle: track } }));
  assert.deepEqual(scenarioOf(body), { audio: track });
});

test("uma parte inválida não derruba as outras (áudio que nem é objeto)", () => {
  const body = ok(movieInput({
    scenario: { source, audio: "Português", subtitle: track },
    fallbackScenario: { audio: { id: "9", language: "en", name: "English" } }
  }));
  assert.deepEqual(scenarioOf(body), { source, audio: { id: "9", language: "en", name: "English" }, subtitle: track });
});

test("campo de faixa que não é texto vira null, sem perder a faixa", () => {
  const body = ok(movieInput({ scenario: { audio: { id: 2, language: "pt", name: "x" } } }));
  assert.deepEqual(scenarioOf(body), { audio: { id: null, language: "pt", name: "x" } });
});

test("posição zero não grava: nunca apaga a retomada", () => {
  for (const positionSeconds of [0, 0.4, -3, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
    const result = buildProgressBody(movieInput({ positionSeconds }));
    assert.equal(result.ok, false, String(positionSeconds));
    if (!result.ok) assert.ok(result.reason.length > 0);
  }
});

test("posição acima da duração é limitada à duração", () => {
  const body = ok(movieInput({ positionSeconds: 99999, durationSeconds: 3600 }));
  assert.equal(body.positionSeconds, 3600);
});

test("duração inválida recusa o corpo", () => {
  for (const durationSeconds of [0, 0.9, -5, Number.NaN, Number.POSITIVE_INFINITY, 604_801, null, undefined]) {
    assert.equal(buildProgressBody(movieInput({ durationSeconds })).ok, false, String(durationSeconds));
  }
  assert.equal(ok(movieInput({ durationSeconds: 604_800, positionSeconds: 10 })).durationSeconds, 604_800);
});

test("concluído grava a posição igual à duração, mesmo sem leitura de posição", () => {
  const body = ok(movieInput({ completed: true, positionSeconds: 10, durationSeconds: 5400.9 }));
  assert.equal(body.completed, true);
  assert.equal(body.positionSeconds, 5400);
  assert.equal(body.durationSeconds, 5400);
  const semPosicao = ok(movieInput({ completed: true, positionSeconds: Number.NaN, durationSeconds: 5400 }));
  assert.equal(semPosicao.positionSeconds, 5400);
});

test("pôster http: vira null; https segue; lixo vira null", () => {
  assert.equal(ok(movieInput({ posterUrl: "http://exemplo.com/p.jpg" })).posterUrl, null);
  assert.equal(ok(movieInput({ posterUrl: "javascript:alert(1)" })).posterUrl, null);
  assert.equal(ok(movieInput({ posterUrl: "não é url" })).posterUrl, null);
  assert.equal(ok(movieInput({ posterUrl: "" })).posterUrl, null);
  assert.equal(ok(movieInput({ posterUrl: "https://exemplo.com/" + "a".repeat(2100) })).posterUrl, null);
  assert.equal(ok(movieInput({ posterUrl: " https://exemplo.com/p.jpg " })).posterUrl, "https://exemplo.com/p.jpg");
});

test("episodeTitle: vazio vira null, só existe em série", () => {
  const serie = movieInput({ mediaType: "series", mediaId: "tt1", videoId: "tt1:1:2", season: 1, episode: 2 });
  assert.equal(ok({ ...serie, episodeTitle: "" }).episodeTitle, null);
  assert.equal(ok({ ...serie, episodeTitle: "   " }).episodeTitle, null);
  assert.equal(ok({ ...serie, episodeTitle: null }).episodeTitle, null);
  assert.equal(ok({ ...serie, episodeTitle: " Piloto " }).episodeTitle, "Piloto");
  assert.equal(ok(movieInput({ episodeTitle: "Não é de série" })).episodeTitle, null);
});

test("temporada e episódio: inteiros a partir de zero, senão null", () => {
  const serie = movieInput({ mediaType: "series", mediaId: "tt1", videoId: "tt1:0:0" });
  const zero = ok({ ...serie, season: 0, episode: 0 });
  assert.equal(zero.season, 0);
  assert.equal(zero.episode, 0);
  for (const valor of [-1, 1.5, Number.NaN, 10_001, null, undefined]) {
    const body = ok({ ...serie, season: valor, episode: valor });
    assert.equal(body.season, null, String(valor));
    assert.equal(body.episode, null, String(valor));
  }
});

test("título vazio usa o mediaId; título longo é cortado em 300", () => {
  assert.equal(ok(movieInput({ title: "" })).title, "tmdb:240");
  assert.equal(ok(movieInput({ title: "   ", mediaId: "tt0071562" })).title, "tt0071562");
  assert.equal(ok(movieInput({ title: null })).title, "tmdb:240");
  assert.equal((ok(movieInput({ title: "t".repeat(400) })).title as string).length, 300);
});

test("videoId vazio usa o mediaId", () => {
  assert.equal(ok(movieInput({ videoId: "", mediaId: "tt0071562" })).videoId, "tt0071562");
  assert.equal(ok(movieInput({ videoId: undefined, mediaId: "tt0071562" })).videoId, "tt0071562");
});

test("playbackAddonId vazio vira null", () => {
  assert.equal(ok(movieInput({ playbackAddonId: "  " })).playbackAddonId, null);
  assert.equal(ok(movieInput({ playbackAddonId: undefined })).playbackAddonId, null);
});

test("sem identidade mínima não há corpo (e há um motivo)", () => {
  for (const overrides of [
    { mediaId: "" }, { mediaId: undefined }, { addonId: "" }, { addonId: null }, { mediaType: "tv" }, { mediaType: null }
  ] as const) {
    const result = buildProgressBody(movieInput(overrides));
    assert.equal(result.ok, false, JSON.stringify(overrides));
    if (!result.ok) assert.ok(result.reason.length > 0);
  }
});

test("a razão da recusa aponta o campo que o contrato recusou", () => {
  const result = buildProgressBody(movieInput({ addonId: "" }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /addonId/);
});

test("nunca lança, mesmo com entradas que explodem", () => {
  const armadilha = new Proxy({}, { get() { throw new Error("explodiu"); }, has() { throw new Error("explodiu"); } });
  assert.doesNotThrow(() => buildProgressBody(movieInput({ scenario: armadilha, fallbackScenario: armadilha })));
  // Cenário ilegível só tira o cenário: a posição continua sendo gravada.
  const body = ok(movieInput({ scenario: armadilha, fallbackScenario: armadilha }));
  assert.equal(body.playbackScenario, undefined);
  assert.equal(body.positionSeconds, 1234);
  assert.doesNotThrow(() => buildProgressBody(armadilha as ProgressBodyInput));
  const lixo = buildProgressBody(armadilha as ProgressBodyInput);
  assert.equal(lixo.ok, false);
  assert.doesNotThrow(() => buildProgressBody(null as unknown as ProgressBodyInput));
});

test("todo corpo ok passa em updateWatchProgressRequestSchema", () => {
  const cenarios: unknown[] = [
    null, undefined, "lixo", 7, { foo: 1 }, { source }, { audio: track }, { audio: { id: "", language: "", name: "" } },
    { subtitle: null }, { subtitleSettings: { ...settings, position: 20 } }, { subtitleSettings: { ...settings, size: 500 } },
    { source: { ...source, infoHash: "zz" }, audio: track, subtitle: null, subtitleSettings: settings },
    { source, audio: { id: 1 }, subtitle: { id: "x".repeat(900), language: "y".repeat(90), name: "z".repeat(900) } }
  ];
  const bases: Partial<ProgressBodyInput>[] = [
    {},
    { completed: true },
    { positionSeconds: 1, durationSeconds: 1 },
    { mediaType: "series", mediaId: "tt1", videoId: "tt1:2:5", season: 2, episode: 5, episodeTitle: "Ep" },
    { title: "", posterUrl: "http://x", episodeTitle: "x" },
    { mediaId: "tt0071562", videoId: "" },
    { title: "t".repeat(1000), addonId: "a".repeat(500) }
  ];
  let corposOk = 0;
  for (const base of bases) {
    for (const scenario of cenarios) {
      for (const fallbackScenario of cenarios) {
        const result = buildProgressBody(movieInput({ ...base, scenario, fallbackScenario }));
        if (!result.ok) continue;
        corposOk += 1;
        const parsed = updateWatchProgressRequestSchema.safeParse(JSON.parse(result.body));
        assert.equal(parsed.success, true, `${result.body} → ${JSON.stringify(parsed.error?.issues)}`);
      }
    }
  }
  assert.ok(corposOk > 400, `só ${corposOk} corpos ok: o laço não está exercitando o módulo`);
});
