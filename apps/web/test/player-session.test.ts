import assert from "node:assert/strict";
import test from "node:test";
import { PlaybackWakeLock } from "../app/player/playback-wake-lock.js";
import { reducePlayerOverlay, type PlayerOverlayState } from "../app/player/player-overlay-state.js";
import { CapacitorPlayer } from "../app/player/capacitor-player.js";
import { createTauriPlaybackWakeLock } from "../app/player/tauri-playback-inhibit.js";

test("reprodução solicita bloqueio de suspensão e a pausa o libera", async () => {
  let requests = 0;
  let releases = 0;
  const wakeLock = new PlaybackWakeLock(async () => {
    requests += 1;
    return { release: async () => { releases += 1; } };
  });

  await wakeLock.setPlaying(true);
  await wakeLock.setPlaying(false);

  assert.equal(requests, 1);
  assert.equal(releases, 1);
});

test("reprodução recupera o bloqueio quando a página volta a ficar visível", async () => {
  let requests = 0;
  let currentHandle: { release(): Promise<void> } | null = null;
  const wakeLock = new PlaybackWakeLock(async () => {
    requests += 1;
    currentHandle = { release: async () => undefined };
    return currentHandle;
  });

  await wakeLock.setPlaying(true);
  if (currentHandle) wakeLock.markReleased(currentHandle);
  await wakeLock.resumeVisiblePlayback();

  assert.equal(requests, 2);
});

test("pausa durante uma solicitação pendente não deixa a trava de suspensão ativa", async () => {
  let grant: ((handle: { release(): Promise<void> }) => void) | undefined;
  let releases = 0;
  const wakeLock = new PlaybackWakeLock(() => new Promise((resolve) => { grant = resolve; }));

  const acquiring = wakeLock.setPlaying(true);
  await wakeLock.setPlaying(false);
  grant?.({ release: async () => { releases += 1; } });
  await acquiring;

  assert.equal(releases, 1);
});

test("liberação atrasada de uma trava antiga não perde a trava atual", async () => {
  const releases: number[] = [];
  const releaseListeners: Array<() => void> = [];
  let nextId = 0;
  let wakeLock: PlaybackWakeLock;
  wakeLock = new PlaybackWakeLock(async () => {
    const id = ++nextId;
    const handle = { release: async () => { releases.push(id); } };
    releaseListeners.push(() => wakeLock.markReleased(handle));
    return handle;
  });

  await wakeLock.setPlaying(true);
  await wakeLock.setPlaying(false);
  await wakeLock.setPlaying(true);
  releaseListeners[0]?.();
  await wakeLock.setPlaying(false);

  assert.deepEqual(releases, [1, 2]);
});

test("adaptador Tauri liga e desliga o inibidor nativo do PC", async () => {
  const calls: Array<{ command: string; active: boolean }> = [];
  const wakeLock = createTauriPlaybackWakeLock(async (command, args) => {
    calls.push({ command, active: args.active });
  });

  await wakeLock.setPlaying(true);
  await wakeLock.setPlaying(false);

  assert.deepEqual(calls, [
    { command: "set_playback_inhibit", active: true },
    { command: "set_playback_inhibit", active: false }
  ]);
});

test("toque no fundo fecha controles visíveis sem esperar o temporizador", () => {
  const state: PlayerOverlayState = { controlsVisible: true, locked: false, lockVisible: false };
  assert.deepEqual(reducePlayerOverlay(state, { type: "backgroundTap" }), {
    controlsVisible: false,
    locked: false,
    lockVisible: false
  });
});

test("cadeado some por inatividade, reaparece com toque e também fecha com toque fora", () => {
  const locked: PlayerOverlayState = { controlsVisible: false, locked: true, lockVisible: true };
  const hidden = reducePlayerOverlay(locked, { type: "lockIdle" });
  assert.equal(hidden.lockVisible, false);
  const revealed = reducePlayerOverlay(hidden, { type: "backgroundTap" });
  assert.equal(revealed.lockVisible, true);
  const dismissed = reducePlayerOverlay(revealed, { type: "backgroundTap" });
  assert.equal(dismissed.lockVisible, false);
});

test("Capacitor usa tela cheia nativa em vez do fullscreen do DOM", async () => {
  const calls: string[] = [];
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: {
          Player: {
            toggleFullscreen: async () => { calls.push("toggle"); },
            exitFullscreen: async () => { calls.push("exit"); }
          }
        }
      }
    }
  });

  try {
    const player = new CapacitorPlayer();
    await player.toggleFullscreen();
    await player.exitFullscreen();
    assert.deepEqual(calls, ["toggle", "exit"]);
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("legenda que chega após o vídeo fica disponível sem recarregar a reprodução", async () => {
  const originalWindow = globalThis.window;
  const added: string[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setInterval: () => 1,
      clearInterval: () => undefined,
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: { Player: {
          load: async () => undefined,
          stop: async () => undefined,
          tracks: async () => ({ audio: [], subtitle: [], audioSelecionada: -1, subtitleSelecionada: -1 }),
          selectTrack: async () => ({ ok: true })
        } }
      }
    }
  });

  try {
    const player = new CapacitorPlayer(async (url) => { added.push(url); return "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nTexto"; });
    await player.load({ url: "https://media.example/video.mkv", startAtSeconds: 0, subtitles: [] });
    await player.addExternalSubtitles?.([
      { id: "pt", label: "Português", language: "pt-BR", url: "https://media.example/subtitle.vtt" }
    ]);
    assert.deepEqual((await player.subtitleTracks()).map((track) => track.id), ["pt"]);
    await player.selectSubtitleTrack("pt");
    assert.deepEqual(added, ["https://media.example/subtitle.vtt"]);
    await player.destroy();
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("restauração automática da legenda embutida atualiza o menu Android", async () => {
  const originalWindow = globalThis.window;
  let selected = -1;
  let tick: (() => void) | undefined;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setInterval: (callback: () => void) => { tick = callback; return 1; },
      clearInterval: () => undefined,
      Capacitor: { isNativePlatform: () => true, Plugins: { Player: {
        load: async () => undefined,
        stop: async () => undefined,
        status: async () => ({ evento: "tocando", tocando: true, posicaoMs: 20_000, duracaoMs: 1_000_000 }),
        tracks: async () => ({
          audio: [], subtitle: [{ id: 4, nome: "Português (Brasil)" }],
          audioSelecionada: -1, subtitleSelecionada: selected
        }),
        selectTrack: async ({ id }: { id: number }) => { selected = id; return { ok: true }; }
      } } }
    }
  });

  try {
    const player = new CapacitorPlayer();
    await player.load({ url: "https://media.example/episode.mkv", startAtSeconds: 0, subtitles: [] });
    let updates = 0;
    player.on("tracksChanged", () => { updates += 1; });
    tick?.();
    await new Promise((resolve) => setImmediate(resolve));
    await player.selectSubtitleTrack("4");
    assert.equal(player.state().subtitleTrackId, "4");
    tick?.();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(updates, 2);
    await player.destroy();
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("faixa portuguesa embutida descoberta depois da abertura atualiza o menu Android", async () => {
  const originalWindow = globalThis.window;
  let tick: (() => void) | undefined;
  let embeddedReady = false;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setInterval: (callback: () => void) => { tick = callback; return 1; },
      clearInterval: () => undefined,
      Capacitor: { isNativePlatform: () => true, Plugins: { Player: {
        load: async () => undefined,
        stop: async () => undefined,
        status: async () => ({ evento: "tocando", tocando: true, posicaoMs: 20_000, duracaoMs: 1_000_000 }),
        tracks: async () => ({
          audio: [{ id: 1, nome: "Japonês" }],
          subtitle: embeddedReady ? [{ id: 4, nome: "Português (Brasil)" }] : [],
          audioSelecionada: 1, subtitleSelecionada: -1
        })
      } } }
    }
  });

  try {
    const player = new CapacitorPlayer();
    const updates: string[][] = [];
    player.on("tracksChanged", () => {
      void player.subtitleTracks().then((tracks) => updates.push(tracks.map((track) => track.label)));
    });
    await player.load({ url: "https://media.example/one-piece.mkv", startAtSeconds: 0, subtitles: [] });
    tick?.();
    await new Promise((resolve) => setImmediate(resolve));
    embeddedReady = true;
    tick?.();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(updates.at(-1), ["Português (Brasil)"]);
    await player.destroy();
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("60 sondagens Android usam status leve sem consultas duplicadas e ainda descobrem legenda tardia", async () => {
  const originalWindow = globalThis.window;
  let tick: (() => void) | undefined;
  let statusCalls = 0;
  let trackCalls = 0;
  let changes = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setInterval: (callback: () => void) => { tick = callback; return 1; },
      clearInterval: () => undefined,
      Capacitor: { isNativePlatform: () => true, Plugins: { Player: {
        load: async () => undefined,
        stop: async () => undefined,
        status: async (options: { lightweight: boolean }) => {
          assert.equal(options.lightweight, true);
          statusCalls += 1;
          return {
            evento: "tocando", tocando: true, posicaoMs: statusCalls * 1000, duracaoMs: 1_000_000,
            tracks: {
              audio: [], subtitle: statusCalls >= 20 ? [{ id: 4, nome: "Português" }] : [],
              audioSelecionada: -1, subtitleSelecionada: -1
            }
          };
        },
        tracks: async () => { trackCalls += 1; throw new Error("consulta duplicada"); }
      } } }
    }
  });
  try {
    const player = new CapacitorPlayer();
    player.on("tracksChanged", () => { changes += 1; });
    await player.load({ url: "https://media.example/video.mkv", startAtSeconds: 0, subtitles: [] });
    for (let i = 0; i < 60; i += 1) {
      tick?.();
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(statusCalls, 60);
    assert.equal(trackCalls, 0);
    assert.equal(changes, 2);
    assert.equal(player.state().positionSeconds, 60);
    await player.destroy();
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("consulta lenta das faixas Android não acumula leituras nem anuncia a sessão anterior", async () => {
  const originalWindow = globalThis.window;
  let tick: (() => void) | undefined;
  let finishTracks: ((tracks: {
    audio: { id: number; nome: string }[];
    subtitle: { id: number; nome: string }[];
    audioSelecionada: number;
    subtitleSelecionada: number;
  }) => void) | undefined;
  let statusCalls = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setInterval: (callback: () => void) => { tick = callback; return 1; },
      clearInterval: () => undefined,
      Capacitor: { isNativePlatform: () => true, Plugins: { Player: {
        load: async () => undefined,
        stop: async () => undefined,
        status: async () => {
          statusCalls += 1;
          return { evento: "tocando", tocando: true, posicaoMs: 20_000, duracaoMs: 1_000_000 };
        },
        tracks: () => new Promise((resolve) => { finishTracks = resolve; })
      } } }
    }
  });

  try {
    const player = new CapacitorPlayer();
    let updates = 0;
    player.on("tracksChanged", () => { updates += 1; });
    await player.load({ url: "https://media.example/old.mkv", startAtSeconds: 0, subtitles: [] });
    tick?.();
    await new Promise((resolve) => setImmediate(resolve));
    tick?.();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(statusCalls, 1, "a segunda sondagem espera a primeira terminar");

    await player.load({ url: "https://media.example/new.mkv", startAtSeconds: 0, subtitles: [] });
    finishTracks?.({ audio: [], subtitle: [{ id: 4, nome: "Português" }], audioSelecionada: -1, subtitleSelecionada: -1 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(updates, 0, "a resposta do vídeo antigo não atualiza o menu novo");
    await player.destroy();
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("falha ao ativar legenda automática ainda deixa a opção visível no menu", async () => {
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setInterval: () => 1,
      clearInterval: () => undefined,
      Capacitor: { isNativePlatform: () => true, Plugins: { Player: {
        load: async () => undefined,
        stop: async () => undefined,
        tracks: async () => ({ audio: [], subtitle: [], audioSelecionada: -1, subtitleSelecionada: -1 }),
        addSubtitle: async () => ({ ok: false, id: -1 })
      } } }
    }
  });

  try {
    const player = new CapacitorPlayer(async () => { throw new Error("legenda indisponível"); });
    let updates = 0;
    player.on("tracksChanged", () => { updates += 1; });
    await player.load({ url: "https://media.example/video.mkv", startAtSeconds: 0, subtitles: [] });
    const candidates = [{ id: "pt", label: "Português", language: "pt-BR", url: "https://media.example/pt.vtt" }];
    await assert.rejects(() => player.addExternalSubtitles(candidates, "pt"));
    assert.equal(updates, 1);
    assert.deepEqual((await player.subtitleTracks()).map((track) => track.id), ["pt"]);
    await player.destroy();
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("novo episódio espera o encerramento nativo do anterior", async () => {
  const originalWindow = globalThis.window;
  const calls: string[] = [];
  let finishStop: (() => void) | undefined;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setInterval: () => 1,
      clearInterval: () => undefined,
      Capacitor: { isNativePlatform: () => true, Plugins: { Player: {
        load: async ({ url }: { url: string }) => { calls.push(`load:${url}`); },
        stop: () => new Promise<void>((resolve) => {
          calls.push("stop");
          finishStop = () => { calls.push("stopped"); resolve(); };
        })
      } } }
    }
  });

  try {
    const previous = new CapacitorPlayer();
    await previous.load({ url: "one", startAtSeconds: 0, subtitles: [] });
    const closing = previous.destroy();
    const next = new CapacitorPlayer();
    const opening = next.load({ url: "two", startAtSeconds: 0, subtitles: [] });
    assert.deepEqual(calls, ["load:one", "stop"]);
    finishStop?.();
    await Promise.all([closing, opening]);
    assert.deepEqual(calls, ["load:one", "stop", "stopped", "load:two"]);
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("abertura antiga que termina após fechar não publica vídeo nem legenda sobre a nova sessão", async () => {
  const originalWindow = globalThis.window;
  let finishLoad: (() => void) | undefined;
  let subtitleAdds = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setInterval: () => 1,
      clearInterval: () => undefined,
      Capacitor: { isNativePlatform: () => true, Plugins: { Player: {
        load: () => new Promise<void>((resolve) => { finishLoad = resolve; }),
        stop: async () => undefined,
        addSubtitle: async () => { subtitleAdds += 1; return { ok: true, id: 7 }; }
      } } }
    }
  });

  try {
    const player = new CapacitorPlayer();
    let ready = 0;
    player.on("ready", () => { ready += 1; });
    const opening = player.load({
      url: "old", startAtSeconds: 0,
      subtitles: [{ id: "pt", label: "Português", language: "pt", url: "https://example.com/pt.vtt" }],
      defaultSubtitleId: "pt"
    });
    await Promise.resolve();
    await player.destroy();
    finishLoad?.();
    await opening;
    assert.equal(ready, 0);
    assert.equal(subtitleAdds, 0);
    assert.equal(player.state().loaded, false);
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});
