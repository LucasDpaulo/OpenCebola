import assert from "node:assert/strict";
import test from "node:test";
import { buildPlayerSourceOptions, filterSourceOptionsBySubtitle } from "../app/player/player-source-options.js";

const streams = [
  {
    id: "torrentio-4k", addonId: "torrentio", addonName: "Torrentio", label: "Filme 2160p Dublado",
    quality: "4K", audioLanguages: ["pt-BR", "en"], readyNow: true, sizeLabel: "18 GB", seeders: 80
  },
  {
    id: "orion-fhd", addonId: "orion", addonName: "Orion", label: "Filme 1080p English",
    quality: "1080p", audioLanguages: ["en"], readyNow: false, sizeLabel: "6 GB", seeders: 20
  }
] as const;

test("fontes do player expõem add-on, idioma e qualidade para escolha", () => {
  assert.deepEqual(buildPlayerSourceOptions(streams), [
    {
      id: "torrentio-4k", addon: "Torrentio", label: "Filme 2160p Dublado", quality: "4K",
      audioLanguages: ["pt-BR", "en"], subtitleLanguages: [], readyNow: true, details: "18 GB · 80 seeders"
    },
    {
      id: "orion-fhd", addon: "Orion", label: "Filme 1080p English", quality: "1080p",
      audioLanguages: ["en"], subtitleLanguages: [], readyNow: false, details: "6 GB · 20 seeders"
    }
  ]);
});

test("fontes anunciam idioma de legenda separadamente do áudio", () => {
  const options = buildPlayerSourceOptions([{
    id: "com-legenda", addonId: "addon", addonName: "Addon", label: "1080p",
    audioLanguages: ["en"], subtitleLanguages: ["pt-BR"]
  }]);
  assert.deepEqual(options[0]?.subtitleLanguages, ["pt-BR"]);
});

test("filtro português mostra só fontes que anunciam legenda portuguesa", () => {
  const options = buildPlayerSourceOptions([
    { id: "br", addonId: "addon", addonName: "Addon", label: "BR", subtitleLanguages: ["pt-BR"] },
    { id: "en", addonId: "addon", addonName: "Addon", label: "EN", subtitleLanguages: ["en"] },
    { id: "unknown", addonId: "addon", addonName: "Addon", label: "sem informação" }
  ]);
  assert.deepEqual(filterSourceOptionsBySubtitle(options, "pt").map((option) => option.id), ["br"]);
  assert.equal(filterSourceOptionsBySubtitle(options, "all").length, 3);
});
