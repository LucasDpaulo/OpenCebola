import assert from "node:assert/strict";
import test from "node:test";
import type { PlaybackScenario } from "@cebola/contracts";
import { FakePlayer } from "../app/player/fake-player.js";
import type { PlayerTrack } from "../app/player/native-player.js";
import {
  aplicarFaixas, decidirAudio, decidirLegenda, legendaNaAbertura, type EntradaFaixas
} from "../app/player/regras/faixas.js";

const jaAudio: PlayerTrack = { id: "a-ja", label: "Japonês", language: "ja" };
const ptAudio: PlayerTrack = { id: "a-pt", label: "Português", language: "pt-BR" };
const enAudio: PlayerTrack = { id: "a-en", label: "English", language: "en" };
const semIdioma: PlayerTrack = { id: "a-x", label: "Faixa 3", language: null };
const legPtBr: PlayerTrack = { id: "s-ptbr", label: "Português (Brasil)", language: "pt-BR" };
const legEn: PlayerTrack = { id: "s-en", label: "English", language: "en" };
const legEs: PlayerTrack = { id: "s-es", label: "Español", language: "es" };

function entrada(parcial: Partial<EntradaFaixas> = {}): EntradaFaixas {
  return {
    escolhaDaPessoa: null, continuidade: null, salvo: null, idiomaOriginal: null,
    idsExternos: new Set(), legendaPreferidaExterna: null, ...parcial
  };
}
const salvoCom = (parcial: Partial<PlaybackScenario>): PlaybackScenario => parcial as PlaybackScenario;
const faixaSalva = (track: PlayerTrack) => ({ id: track.id, language: track.language, name: track.label });

const legendas = [legEn, legPtBr, legEs];

test("legenda: a escolha da pessoa vence continuidade, salvo e automática", () => {
  const r = decidirLegenda(legendas, jaAudio, "s-en", entrada({
    escolhaDaPessoa: "s-en",
    continuidade: { audioLanguage: null, subtitle: { language: "pt-BR" } },
    salvo: salvoCom({ subtitle: faixaSalva(legEs) })
  }));
  assert.deepEqual(r, { tipo: "manter" });
  // "off" escolhido pela pessoa também vale: nada é religado.
  assert.deepEqual(decidirLegenda(legendas, jaAudio, null, entrada({ escolhaDaPessoa: "off" })), { tipo: "manter" });
});

test("legenda: a continuidade vence o salvo", () => {
  const r = decidirLegenda(legendas, jaAudio, null, entrada({
    continuidade: { audioLanguage: null, subtitle: { language: "en" } },
    salvo: salvoCom({ subtitle: faixaSalva(legEs) })
  }));
  assert.deepEqual(r, { tipo: "faixa", id: "s-en" });
});

test("legenda: o salvo vence a automática", () => {
  const r = decidirLegenda(legendas, jaAudio, null, entrada({ salvo: salvoCom({ subtitle: faixaSalva(legEs) }) }));
  assert.deepEqual(r, { tipo: "faixa", id: "s-es" });
});

test("legenda: continuidade 'off' desliga mesmo com salvo apontando legenda", () => {
  const r = decidirLegenda(legendas, jaAudio, "s-ptbr", entrada({
    continuidade: { audioLanguage: null, subtitle: "off" },
    salvo: salvoCom({ subtitle: faixaSalva(legPtBr) })
  }));
  assert.deepEqual(r, { tipo: "desligar" });
});

test("legenda: salvo 'subtitle: null' desliga mesmo com PT disponível", () => {
  const r = decidirLegenda(legendas, jaAudio, "s-ptbr", entrada({ salvo: salvoCom({ subtitle: null }) }));
  assert.deepEqual(r, { tipo: "desligar" });
});

test("legenda: continuidade sem faixa do idioma desliga em vez de cair na automática", () => {
  const r = decidirLegenda([legEn], jaAudio, "s-en", entrada({
    continuidade: { audioLanguage: null, subtitle: { language: "fr" } }
  }));
  assert.deepEqual(r, { tipo: "desligar" });
});

test("legenda: continuidade embutida só casa com faixa que não é externa", () => {
  const r = decidirLegenda([legPtBr, { ...legPtBr, id: "emb-pt" }], jaAudio, null, entrada({
    continuidade: { audioLanguage: null, subtitle: { language: "pt-BR", origin: "embedded" } },
    idsExternos: new Set(["s-ptbr"])
  }));
  assert.deepEqual(r, { tipo: "faixa", id: "emb-pt" });
});

test("legenda automática: áudio japonês liga PT-BR; áudio PT desliga; sem idioma mantém", () => {
  assert.deepEqual(decidirLegenda(legendas, jaAudio, null, entrada()), { tipo: "faixa", id: "s-ptbr" });
  assert.deepEqual(decidirLegenda(legendas, ptAudio, "s-ptbr", entrada()), { tipo: "desligar" });
  assert.deepEqual(decidirLegenda(legendas, semIdioma, "s-en", entrada()), { tipo: "manter" });
  assert.deepEqual(decidirLegenda(legendas, semIdioma, null, entrada()), { tipo: "manter" });
});

test("legenda: devolve 'manter' quando o resultado já é o estado atual", () => {
  assert.deepEqual(decidirLegenda(legendas, jaAudio, "s-ptbr", entrada()), { tipo: "manter" });
  assert.deepEqual(decidirLegenda(legendas, ptAudio, null, entrada()), { tipo: "manter" });
});

test("áudio: a continuidade de idioma vence o salvo", () => {
  const r = decidirAudio([jaAudio, enAudio], "a-ja", entrada({
    continuidade: { audioLanguage: "en", subtitle: null },
    salvo: salvoCom({ audio: faixaSalva(jaAudio) })
  }));
  assert.equal(r, "a-en");
});

test("áudio: sem nada, liga o original; sem original, mantém", () => {
  assert.equal(decidirAudio([ptAudio, jaAudio], "a-pt", entrada({ idiomaOriginal: "ja" })), "a-ja");
  assert.equal(decidirAudio([ptAudio, jaAudio], "a-pt", entrada()), null);
});

test("áudio: faixa já ativa não é reselecionada", () => {
  assert.equal(decidirAudio([ptAudio, jaAudio], "a-ja", entrada({ idiomaOriginal: "ja" })), null);
  assert.equal(decidirAudio([ptAudio, jaAudio], "a-ja", entrada({ salvo: salvoCom({ audio: faixaSalva(jaAudio) }) })), null);
});

async function carregado(audios: PlayerTrack[], subs: PlayerTrack[]) {
  const player = new FakePlayer({ audioTracks: audios, subtitleTracks: subs });
  await player.load({ url: "x", startAtSeconds: 0, subtitles: [] });
  return player;
}

test("aplicarFaixas: aplica o áudio e depois a legenda coerente com ele", async () => {
  const player = await carregado([ptAudio, jaAudio], legendas);
  const r = await aplicarFaixas(player, entrada({ idiomaOriginal: "ja" }), { audio: true });
  assert.deepEqual(r, { audioFalhou: false, legendaFalhou: false, audioAvaliado: true });
  assert.equal(player.state().audioTrackId, "a-ja");
  assert.equal(player.state().subtitleTrackId, "s-ptbr");
});

test("aplicarFaixas: sem 'audio' não mexe no áudio mas ajusta a legenda", async () => {
  const player = await carregado([ptAudio, jaAudio], legendas);
  await aplicarFaixas(player, entrada({ idiomaOriginal: "ja" }), { audio: false });
  assert.equal(player.state().audioTrackId, "a-pt");
  assert.equal(player.state().subtitleTrackId, null);
});

test("aplicarFaixas: chamado duas vezes não troca nada na segunda", async () => {
  const player = await carregado([ptAudio, jaAudio], legendas);
  const e = entrada({ idiomaOriginal: "ja" });
  await aplicarFaixas(player, e, { audio: true });
  const chamadas: string[] = [];
  const selA = player.selectAudioTrack.bind(player);
  const selS = player.selectSubtitleTrack.bind(player);
  player.selectAudioTrack = async (id) => { chamadas.push(`a:${id}`); return selA(id); };
  player.selectSubtitleTrack = async (id) => { chamadas.push(`s:${id}`); return selS(id); };
  await aplicarFaixas(player, e, { audio: true });
  assert.deepEqual(chamadas, []);
});

test("aplicarFaixas: falha no áudio ainda aplica a legenda e reporta audioFalhou", async () => {
  const player = await carregado([ptAudio, jaAudio], legendas);
  player.selectAudioTrack = async () => { throw new Error("motor recusou"); };
  const r = await aplicarFaixas(player, entrada({ idiomaOriginal: "ja" }), { audio: true });
  assert.deepEqual(r, { audioFalhou: true, legendaFalhou: false, audioAvaliado: true });
  // O áudio ficou PT, então a legenda automática acompanha o que de fato está tocando: desligada.
  assert.equal(player.state().audioTrackId, "a-pt");
  assert.equal(player.state().subtitleTrackId, null);
});

test("aplicarFaixas: falha na legenda é reportada sem derrubar o áudio", async () => {
  const player = await carregado([ptAudio, jaAudio], legendas);
  player.selectSubtitleTrack = async () => { throw new Error("motor recusou"); };
  const r = await aplicarFaixas(player, entrada({ idiomaOriginal: "ja" }), { audio: true });
  assert.deepEqual(r, { audioFalhou: false, legendaFalhou: true, audioAvaliado: true });
  assert.equal(player.state().audioTrackId, "a-ja");
});

test("aplicarFaixas: escolha da pessoa na legenda é respeitada", async () => {
  const player = await carregado([jaAudio], legendas);
  await player.selectSubtitleTrack("s-es");
  await aplicarFaixas(player, entrada({ escolhaDaPessoa: "s-es" }), { audio: true });
  assert.equal(player.state().subtitleTrackId, "s-es");
});

// legendaNaAbertura: externas com release em `details`.
const externas = [
  { id: "e-en", language: "en", label: "English" },
  { id: "e-pt-a", language: "pt-BR", label: "Português (Brasil)", details: "Show.S01E01.720p.WEB-DL.GRP" },
  { id: "e-pt-b", language: "pt-BR", label: "Português (Brasil)", details: "Show.S01E01.1080p.BluRay.OTHER" },
  { id: "e-pt", language: "pt", label: "Português" }
];

test("legendaNaAbertura: continuidade embutida ou 'off' não liga externa", () => {
  assert.equal(legendaNaAbertura(externas, entrada({
    continuidade: { audioLanguage: null, subtitle: { language: "pt-BR", origin: "embedded" } }
  }), null), null);
  assert.equal(legendaNaAbertura(externas, entrada({
    continuidade: { audioLanguage: null, subtitle: "off" }
  }), null), null);
});

test("legendaNaAbertura: continuidade por idioma casa pelo release e usa a família PT", () => {
  const cont = (language: string, details?: string) => entrada({
    continuidade: { audioLanguage: null, subtitle: { language, details, origin: "external" } }
  });
  assert.equal(legendaNaAbertura(externas, cont("pt-BR", "Show.S01E01.1080p.BluRay.OTHER"), null), "e-pt-b");
  assert.equal(legendaNaAbertura(externas, cont("pt-BR"), "Show.S01E01.1080p.BluRay.OTHER"), "e-pt-b");
  // Só PT genérico disponível para um pedido PT-BR: a família substitui.
  assert.equal(legendaNaAbertura([externas[0]!, externas[3]!], cont("pt-BR"), null), "e-pt");
  // Idioma indisponível: não cai na automática de outro idioma.
  assert.equal(legendaNaAbertura(externas, cont("fr"), null), null);
});

test("legendaNaAbertura: o salvo vale, inclusive 'nenhuma'", () => {
  assert.equal(legendaNaAbertura(externas, entrada({ salvo: salvoCom({ subtitle: faixaSalva(externas[0] as PlayerTrack) }) }), null), "e-en");
  assert.equal(legendaNaAbertura(externas, entrada({ salvo: salvoCom({ subtitle: null }) }), null), null);
});

test("legendaNaAbertura: sem nada, automática pelo release", () => {
  assert.equal(legendaNaAbertura(externas, entrada(), "Show.S01E01.1080p.BluRay.OTHER"), "e-pt-b");
  assert.equal(legendaNaAbertura(externas, entrada(), "Show.S01E01.720p.WEB-DL.GRP"), "e-pt-a");
  assert.equal(legendaNaAbertura([externas[0]!], entrada(), null), null);
});

test("aplicarFaixas: lista de áudio vazia não é avaliada e não seleciona nada", async () => {
  const player = await carregado([], legendas);
  const r = await aplicarFaixas(player, entrada({ idiomaOriginal: "ja" }), { audio: true });
  assert.equal(r.audioAvaliado, false);
  assert.equal(player.state().audioTrackId, null);
  const sem = await aplicarFaixas(await carregado([ptAudio, jaAudio], legendas), entrada({ idiomaOriginal: "ja" }), { audio: false });
  assert.equal(sem.audioAvaliado, false);
});

test("filme reaberto não restaura outro idioma quando o arquivo reutiliza o ID salvo", () => {
  const saved = salvoCom({ audio: { id: "1", language: "pt-BR", name: "Português" } });
  const tracks = [
    { id: "1", language: "eng", label: "English" },
    { id: "7", language: "pob", label: "Português Brasil" }
  ];
  assert.equal(decidirAudio(tracks, "1", entrada({ salvo: saved })), "7");
  assert.equal(decidirAudio([tracks[0]!], "1", entrada({ salvo: saved })), null);
});

test("restauração de filme preserva versão de áudio pelo nome quando o ID mudou", () => {
  const saved = salvoCom({ audio: { id: "1", language: "en", name: "Original" } });
  const tracks = [
    { id: "1", language: "en", label: "Commentary" },
    { id: "7", language: "en", label: "Original" }
  ];
  assert.equal(decidirAudio(tracks, "1", entrada({ salvo: saved })), "7");
});

test("três episódios com IDs diferentes preservam legenda mesmo após trocar de fonte", async () => {
  for (let episode = 1; episode <= 3; episode++) {
    const track = { ...legPtBr, id: `episode-${episode}-subtitle` };
    const player = await carregado([jaAudio], [track]);
    const input = entrada({
      escolhaDaPessoa: episode === 3 ? "id-da-fonte-anterior" : null,
      continuidade: { audioLanguage: "ja", subtitle: { language: "pt-BR", origin: "embedded" } },
      salvo: salvoCom({ subtitle: { ...faixaSalva(legPtBr), id: episode === 3 ? "id-da-fonte-anterior" : legPtBr.id } })
    });
    await aplicarFaixas(player, input, { audio: true });
    assert.equal(player.state().subtitleTrackId, track.id, `episódio ${episode}`);
    await aplicarFaixas(player, input, { audio: false });
    assert.equal(player.state().subtitleTrackId, track.id);
  }
});

test("resposta tardia das faixas não seleciona nada no player que já mudou", async () => {
  const player = await carregado([ptAudio, jaAudio], legendas);
  let finish!: (value: readonly PlayerTrack[]) => void;
  player.subtitleTracks = () => new Promise((resolve) => { finish = resolve; });
  let current = true;
  const result = aplicarFaixas(player, entrada({ idiomaOriginal: "ja" }), { audio: true, isCurrent: () => current });
  current = false;
  finish(legendas);
  await result;
  assert.equal(player.state().audioTrackId, "a-pt");
  assert.equal(player.state().subtitleTrackId, null);
});

test("troca de sessão durante seleção de áudio não aplica a legenda antiga", async () => {
  const player = await carregado([ptAudio, jaAudio], legendas);
  let current = true;
  const select = player.selectAudioTrack.bind(player);
  player.selectAudioTrack = async (id) => { await select(id); current = false; };
  await aplicarFaixas(player, entrada({ idiomaOriginal: "ja" }), { audio: true, isCurrent: () => current });
  assert.equal(player.state().subtitleTrackId, null);
});

test("troca de fonte restaura idioma manual mesmo com ID reaproveitado por outro idioma", () => {
  const result = decidirLegenda([{ ...legEn, id: "id-antigo" }, legPtBr], jaAudio, null, entrada({
    escolhaDaPessoa: "id-antigo",
    salvo: salvoCom({ subtitle: { id: "id-antigo", language: "pt-BR", name: "Português" } }),
    continuidade: { audioLanguage: "ja", subtitle: { language: "en" } }
  }));
  assert.deepEqual(result, { tipo: "faixa", id: "s-ptbr" });
});
