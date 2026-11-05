import assert from "node:assert/strict";
import test from "node:test";
import type { NativePlayer, PlayerState } from "../app/player/native-player";
import { observeSkipData } from "../app/player/pulos/observe-skip-data";

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function fixture() {
  const state: { -readonly [K in keyof PlayerState]: PlayerState[K] } = { loaded: true, playing: true, positionSeconds: 10, durationSeconds: 1400, audioTrackId: null, subtitleTrackId: "external:pt" };
  const listeners = new Map<string, () => void>();
  let tick = () => {};
  let time = 0;
  let cancelled = false;
  let list: { id: string; url: string }[] = [];
  let chapterReads = 0;
  let textReads = 0;
  let text: string | null = 'WEBVTT\n\n00:02:30.000 --> 00:02:35.000\n"O título do episódio"\n';
  let chapters: { name: string; start: number; end: number }[] = [];
  const markers: unknown[] = [];
  const segments: unknown[] = [];
  const player = {
    state: () => state,
    on: (event: string, listener: () => void) => { listeners.set(event, listener); return () => listeners.delete(event); },
    chapters: async () => { chapterReads++; return chapters; }
  } as unknown as NativePlayer;
  const options = {
    now: () => time,
    player, subtitles: () => list,
    fetchText: async () => { textReads++; return text; },
    chapters: (value: unknown) => { segments.push(value); },
    markers: (value: unknown) => { markers.push(value); },
    schedule: (callback: () => void) => { tick = callback; return () => { cancelled = true; }; }
  };
  return {
    options, state, markers, segments, listeners,
    tick: () => { time += 1000; tick(); },
    subtitle: () => { list = [{ id: "pt", url: "https://example.test/subtitle" }]; },
    chapters: () => { chapters = [{ name: "Opening", start: 10, end: 90 }]; },
    text: (value: string | null) => { text = value; },
    counts: () => ({ chapterReads, textReads, cancelled })
  };
}

test("ready já ocorreu: descobre capítulos imediatamente e repete se vierem tarde", async () => {
  const f = fixture();
  const stop = observeSkipData(f.options);
  await settle();
  assert.equal(f.counts().chapterReads, 1);
  f.chapters(); f.tick(); await settle();
  assert.deepEqual(f.segments.at(-1), [{ kind: "intro", start: 10, end: 90, episodeLength: null }]);
  f.tick(); await settle();
  assert.equal(f.counts().chapterReads, 2);
  stop();
  assert.equal(f.listeners.size, 0);
  assert.equal(f.counts().cancelled, true);
});

test("legenda que chega depois da faixa é lida sem esperar outro episódio", async () => {
  const f = fixture();
  const stop = observeSkipData(f.options);
  await settle();
  assert.equal(f.counts().textReads, 0);
  f.subtitle(); f.listeners.get("tracksChanged")?.(); await settle();
  assert.equal(f.counts().textReads, 1);
  assert.ok(f.markers.at(-1));
  for (let i = 0; i < 20; i++) f.tick();
  await settle();
  assert.equal(f.counts().textReads, 1);
  assert.ok(f.counts().chapterReads <= 8);
  stop();
});

test("falha temporária da legenda permite nova tentativa, com limite", async () => {
  const f = fixture(); f.subtitle(); f.text(null);
  const stop = observeSkipData(f.options);
  await settle(); f.tick(); await settle();
  f.text('WEBVTT\n\n00:22:00.000 --> 00:22:03.000\nContinua…\n');
  f.tick(); await settle();
  assert.equal(f.counts().textReads, 3);
  assert.ok(f.markers.at(-1));
  stop();
});

test("resposta antiga não publica marcas após trocar a faixa ou sair do episódio", async () => {
  const f = fixture(); f.subtitle();
  let finish!: (text: string) => void;
  const stop = observeSkipData({ ...f.options, fetchText: () => new Promise((resolve) => { finish = resolve; }) });
  f.state.subtitleTrackId = null;
  f.tick();
  finish('WEBVTT\n\n00:22:00.000 --> 00:22:03.000\nContinua…\n');
  await settle();
  assert.equal(f.markers.at(-1), null);
  stop();
  const count = f.markers.length;
  f.tick(); await settle();
  assert.equal(f.markers.length, count);
});

test("sondagens simultâneas compartilham a leitura e falhas passam a tentativas espaçadas", async () => {
  const f = fixture(); f.subtitle(); f.text(null);
  const stop = observeSkipData(f.options);
  for (let i = 0; i < 20; i++) f.tick();
  await settle();
  assert.equal(f.counts().textReads, 1);
  for (let i = 0; i < 60; i++) { f.tick(); await settle(); }
  assert.ok(f.counts().textReads >= 3 && f.counts().textReads <= 6);
  assert.ok(f.counts().chapterReads <= 8);
  stop();
});

test("identificação aguarda o primeiro play, sem perder dados ao pausar depois", async () => {
  const f = fixture(); f.subtitle(); f.chapters(); f.state.playing = false;
  const stop = observeSkipData(f.options);
  f.tick(); await settle();
  assert.equal(f.counts().chapterReads, 0);
  assert.equal(f.counts().textReads, 0);
  f.state.playing = true;
  f.tick(); await settle();
  assert.equal(f.counts().chapterReads, 1);
  assert.equal(f.counts().textReads, 1);
  f.state.playing = false;
  f.tick(); await settle();
  assert.equal(f.counts().textReads, 1);
  assert.ok(f.markers.at(-1));
  stop();
});

test("marcas indisponíveis no início são recuperadas depois de um minuto", async () => {
  const f = fixture(); f.subtitle(); f.text(null);
  const stop = observeSkipData(f.options);
  for (let i = 0; i < 65; i++) { f.tick(); await settle(); }
  f.text('WEBVTT\n\n00:22:00.000 --> 00:22:03.000\nContinua…\n');
  for (let i = 0; i < 31; i++) { f.tick(); await settle(); }
  assert.ok(f.markers.at(-1));
  stop();
});

test("reabertura com leitura pendente não usa marcas do arquivo anterior", async () => {
  const f = fixture(); f.subtitle();
  const pending: ((text: string) => void)[] = [];
  const stop = observeSkipData({ ...f.options, fetchText: () => new Promise((resolve) => pending.push(resolve)) });
  f.listeners.get("ready")?.();
  assert.equal(pending.length, 2);
  pending[0]!('WEBVTT\n\n00:21:00.000 --> 00:21:03.000\nContinua…\n');
  await settle();
  assert.equal(f.markers.at(-1), null);
  pending[1]!('WEBVTT\n\n00:22:00.000 --> 00:22:03.000\nContinua…\n');
  await settle();
  assert.equal((f.markers.at(-1) as { markers: { storyEnd: number } }).markers.storyEnd, 1320);
  stop();
});
