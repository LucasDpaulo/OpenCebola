import assert from "node:assert/strict";
import test from "node:test";
import { FakePlayer } from "../app/player/fake-player.js";

const fonte = {
  url: "https://exemplo.test/filme.mkv",
  startAtSeconds: 0,
  subtitles: []
};

test("FakePlayer carrega, toca e informa posição para quem escuta", async () => {
  const player = new FakePlayer();
  const posicoes: number[] = [];
  player.on("position", (segundos) => posicoes.push(segundos));

  await player.load(fonte);
  await player.play();
  player.avancarRelogio(3);

  assert.deepEqual(posicoes, [1, 2, 3]);
  assert.equal(player.state().playing, true);
});

test("FakePlayer começa no segundo pedido, que é como a retomada funciona", async () => {
  const player = new FakePlayer();
  await player.load({ ...fonte, startAtSeconds: 120 });
  assert.equal(player.state().positionSeconds, 120);
});

test("FakePlayer troca a faixa de áudio e lembra a escolha", async () => {
  const player = new FakePlayer({
    audioTracks: [
      { id: "1", label: "Inglês 5.1", language: "en" },
      { id: "2", label: "Português 5.1", language: "pt" }
    ]
  });
  await player.load(fonte);
  assert.equal((await player.audioTracks()).length, 2);
  await player.selectAudioTrack("2");
  assert.equal(player.state().audioTrackId, "2");
});

test("FakePlayer aceita desligar a legenda com null", async () => {
  const player = new FakePlayer({
    subtitleTracks: [{ id: "5", label: "Português", language: "pt" }]
  });
  await player.load(fonte);
  await player.selectSubtitleTrack("5");
  assert.equal(player.state().subtitleTrackId, "5");
  await player.selectSubtitleTrack(null);
  assert.equal(player.state().subtitleTrackId, null);
});

test("FakePlayer respeita a seleção segura de legenda ao carregar", async () => {
  const player = new FakePlayer({
    subtitleTracks: [{ id: "pt-br", label: "Português (Brasil)", language: "pt-BR" }]
  });
  await player.load({ ...fonte, defaultSubtitleId: "pt-br" });
  assert.equal(player.state().subtitleTrackId, "pt-br");
});

test("FakePlayer avisa quem escuta quando o vídeo termina", async () => {
  const player = new FakePlayer({ durationSeconds: 4 });
  let terminou = false;
  player.on("ended", () => { terminou = true; });
  await player.load(fonte);
  await player.play();
  player.avancarRelogio(5);
  assert.equal(terminou, true);
});

test("FakePlayer não deixa buscar posição fora do vídeo", async () => {
  const player = new FakePlayer({ durationSeconds: 100 });
  await player.load(fonte);
  await player.seek(500);
  assert.equal(player.state().positionSeconds, 100);
  await player.seek(-10);
  assert.equal(player.state().positionSeconds, 0);
});

test("FakePlayer limita o brilho ao intervalo seguro do aparelho", async () => {
  const player = new FakePlayer();
  await player.setBrightness?.(0.4);
  assert.equal(player.brightness(), 0.4);
  await player.setBrightness?.(2);
  assert.equal(player.brightness(), 1);
});
