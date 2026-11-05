import assert from "node:assert/strict";
import test from "node:test";
import { PlaybackPreparation, PlaybackStartupTiming, playbackPreparationKey } from "../app/player/playback-preparation.js";

test("leitura começa durante a preparação da fonte e a abertura aguarda o mesmo resultado", async () => {
  const prep = new PlaybackPreparation<{ position: number; subtitle: string }>();
  let calls = 0;
  let resolve!: (value: { position: number; subtitle: string }) => void;
  const response = new Promise<{ position: number; subtitle: string }>((done) => { resolve = done; });
  prep.start("video/source", () => { calls++; return response; });
  await Promise.resolve();
  assert.equal(calls, 1); // Já consultou, mesmo antes de o player consumir a resposta.
  const opening = prep.take("video/source");
  assert.ok(opening);
  resolve({ position: 800, subtitle: "embedded-pt" });
  assert.deepEqual(await opening, { position: 800, subtitle: "embedded-pt" });
  assert.equal(prep.take("video/source"), null);
});

test("resposta de outra fonte/episódio nunca é usada e conclusão tardia não substitui a atual", async () => {
  const prep = new PlaybackPreparation<number>();
  let oldResolve!: (position: number) => void;
  prep.start(playbackPreparationKey("ep1", "a"), () => new Promise<number>((done) => { oldResolve = done; }));
  await Promise.resolve();
  prep.start(playbackPreparationKey("ep2", "b"), async () => 900);
  assert.equal(prep.take(playbackPreparationKey("ep1", "a")), null);
  assert.equal(prep.take(playbackPreparationKey("ep2", "a")), null);
  oldResolve(50);
  assert.equal(await prep.take(playbackPreparationKey("ep2", "b")), 900);
});

test("resposta vencida e preparação cancelada exigem uma consulta normal", async () => {
  let now = 0;
  const prep = new PlaybackPreparation<number>(() => now);
  prep.start("key", async () => 42);
  await new Promise<void>((resolve) => setImmediate(resolve));
  now = 2_000;
  assert.equal(prep.take("key"), null);
  prep.start("key", async () => 80);
  prep.clear();
  assert.equal(prep.take("key"), null);
});

test("leitura ainda pendente é compartilhada mesmo depois da janela de cache", async () => {
  let now = 0;
  const prep = new PlaybackPreparation<number>(() => now);
  let resolve!: (position: number) => void;
  prep.start("key", () => new Promise<number>((done) => { resolve = done; }));
  await Promise.resolve();
  now = 10_000;
  const pending = prep.take("key");
  assert.ok(pending);
  resolve(321);
  assert.equal(await pending, 321);
});

test("falha na antecipação não fica guardada como progresso válido", async () => {
  const prep = new PlaybackPreparation<number>();
  prep.start("key", async () => { throw new Error("offline"); });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(prep.take("key"), null);
});

test("medição mantém o primeiro instante de cada etapa e publica apenas uma vez", () => {
  let now = 100;
  const timing = new PlaybackStartupTiming(() => now);
  now = 250;
  timing.mark("urlReadyMs");
  now = 900;
  timing.mark("urlReadyMs");
  timing.mark("subtitlesReadyMs");
  now = 1_300;
  assert.deepEqual(timing.finish(), { urlReadyMs: "150", subtitlesReadyMs: "800", playerVisibleMs: "1200" });
  assert.equal(timing.finish(), null);
});

test("progresso consumido ao montar o player não vence enquanto a legenda é preparada", async () => {
  let now = 0;
  let reads = 0;
  const progress = new PlaybackPreparation<number>(() => now);
  const subtitles = new PlaybackPreparation<void>(() => now);
  let finishSubtitles!: () => void;
  progress.start("episode/source", async () => { reads++; return 800; });
  subtitles.start("episode/source", () => new Promise((resolve) => { finishSubtitles = resolve; }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const preparedProgress = progress.take("episode/source");
  const preparedSubtitles = subtitles.take("episode/source");
  let loaded = false;
  const ready = Promise.all([preparedProgress, preparedSubtitles]).then(([position]) => {
    loaded = true;
    return position;
  });
  now = 2_500;
  await Promise.resolve();
  assert.equal(loaded, false);
  finishSubtitles();
  assert.equal(await ready, 800);
  assert.equal(reads, 1);
});
