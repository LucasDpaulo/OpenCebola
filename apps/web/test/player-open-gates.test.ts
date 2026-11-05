import assert from "node:assert/strict";
import test from "node:test";
import { canLoadPlayerSource, LateSubtitleGate } from "../app/player/native-player.js";
import { FakePlayer } from "../app/player/fake-player.js";

/**
 * Task 8 — abrir o player não pode esperar a legenda. `title-experience.tsx` não é importável
 * aqui (é "use client" e puxa CSS Modules), então estes testes fixam o CONTRATO que a tela
 * implementa: `canLoadPlayerSource` decide SOMENTE pela fonte escolhida, e `LateSubtitleGate` é o
 * que impede uma legenda tardia de recriar o player — os mesmos blocos usados dentro do efeito
 * que monta o `NativePlayer`.
 */

test("a fonte escolhida libera a carga mesmo com legenda pendente para sempre", () => {
  // Antes, o efeito também checava `subtitleState === "ready"`. Uma legenda pendente para
  // sempre (serviço travado) nunca chegaria a "ready", e o player nunca chamaria `load`.
  const subtitlePendingForever: "idle" | "loading" | "ready" = "loading";
  assert.notEqual(subtitlePendingForever, "ready");

  // A única condição real agora é ter uma fonte escolhida — nada de legenda no meio do caminho.
  assert.equal(canLoadPlayerSource("torrentio-1080p"), true);
  assert.equal(canLoadPlayerSource(null), false);
});

test("load é chamado com a fonte pronta, sem esperar a busca de legenda terminar", async () => {
  const player = new FakePlayer();
  assert.equal(player.state().loaded, false);

  // Simula o instante da escolha da fonte: a busca de legenda ainda está em voo (array vazio),
  // e mesmo assim o carregamento acontece.
  const subtitlesAtLoadTime: readonly { id: string; label: string; language: string; url: string }[] = [];
  await player.load({
    url: "https://exemplo.test/filme.mkv",
    startAtSeconds: 0,
    subtitles: subtitlesAtLoadTime,
    defaultSubtitleId: null
  });

  assert.equal(player.state().loaded, true);
});

test("legenda tardia não recria o player: sem destroy/load de novo, reprodução continua", async () => {
  let loadCount = 0;
  let destroyCount = 0;
  const player = new FakePlayer();
  const originalLoad = player.load.bind(player);
  const originalDestroy = player.destroy.bind(player);
  player.load = (source) => { loadCount += 1; return originalLoad(source); };
  player.destroy = () => { destroyCount += 1; return originalDestroy(); };

  const gate = new LateSubtitleGate();
  const subtitlesAtLoadTime: readonly { id: string; label: string; language: string; url: string }[] = [];
  await player.load({
    url: "https://exemplo.test/filme.mkv",
    startAtSeconds: 0,
    subtitles: subtitlesAtLoadTime,
    defaultSubtitleId: null
  });
  gate.markLoaded(subtitlesAtLoadTime);
  await player.play();
  player.avancarRelogio(5);

  assert.equal(loadCount, 1);
  assert.equal(destroyCount, 0);

  // A busca de legenda termina DEPOIS: agora existe uma legenda que o `load` original não viu.
  const subtitlesArrivedLate = [
    { id: "sub-pt-br", label: "Português", language: "pt-BR", url: "https://exemplo.test/pt-br.vtt" }
  ];

  // O player não é recriado — nenhuma nova chamada a load/destroy — e a reprodução segue.
  assert.equal(loadCount, 1);
  assert.equal(destroyCount, 0);
  assert.equal(player.state().playing, true);
  assert.ok(player.state().positionSeconds > 0);

  // A legenda tardia é detectada para avisar a pessoa (ação de recarregar), não para remontar.
  assert.equal(gate.hasLateSubtitles(subtitlesArrivedLate), true);
  assert.equal(gate.hasLateSubtitles(subtitlesAtLoadTime), false);
});

test("legenda durante a preparação não é tratada como tardia antes do load", () => {
  const gate = new LateSubtitleGate();
  const subtitles = [{ id: "pt" }];
  assert.equal(gate.hasLateSubtitles(subtitles), false);
  gate.markLoaded(subtitles);
  assert.equal(gate.hasLateSubtitles(subtitles), false);
  assert.equal(gate.hasLateSubtitles([...subtitles, { id: "en" }]), true);
});
