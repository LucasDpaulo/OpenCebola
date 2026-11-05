import assert from "node:assert/strict";
import test from "node:test";
import { SubdlClient } from "../src/stremio/subdl.js";

test("SubDL busca o episódio exato e entrega arquivos de legenda sem expor a chave", async () => {
  const requested: URL[] = [];
  const client = new SubdlClient({
    apiKey: "private-key",
    fetchJson: async (url) => {
      requested.push(new URL(url));
      return { status: true, subtitles: [{
        name: "One.Piece.S21.zip", release_name: "One.Piece.WEB-DL", season: 21, episode: 1094,
        unpack_files: [
          { name: "E1094.pt-BR.srt", language: "PT_BR", format: "srt", url: "/subtitle/123/file-pt?api_key=private-key" },
          { name: "E1095.pt-BR.srt", language: "PT_BR", season: 21, episode: 1095, format: "srt", url: "/subtitle/123/file-other" },
          { name: "E1094.en.srt", language: "EN", season: 21, episode: 1094, format: "srt", url: "/subtitle/123/file-en" },
          { name: "E1094.fr.srt", language: "FR", season: 21, episode: 1094, format: "srt", url: "/subtitle/123/file-fr" }
        ]
      }] };
    }
  });
  const found = await client.subtitles("series", "tt0388629:21:1094");
  assert.deepEqual(requested.map((url) => url.searchParams.get("languages")), ["BR_PT,PT", "EN"]);
  assert.equal(requested[0]?.origin, "https://api.subdl.com");
  assert.equal(requested[0]?.searchParams.get("imdb_id"), "tt0388629");
  assert.equal(requested[0]?.searchParams.get("season_number"), "21");
  assert.equal(requested[0]?.searchParams.get("episode_number"), "1094");
  assert.deepEqual(found.map(({ language, url }) => [language, url]), [
    ["pt-BR", "https://dl.subdl.com/subtitle/123/file-pt"],
    ["en", "https://dl.subdl.com/subtitle/123/file-en"]
  ]);
  assert.equal(JSON.stringify(found).includes("private-key"), false);
  await client.subtitles("series", "tt0388629:21:1094");
  assert.equal(requested.length, 2, "o mesmo episódio usa o cache e preserva a cota SubDL");
});

test("SubDL ignora arquivos compactados e URLs externas", async () => {
  const client = new SubdlClient({
    apiKey: "private-key",
    fetchJson: async () => ({ status: true, subtitles: [
      { language: "PT", name: "Movie.zip", url: "/subtitle/123/archive.zip" },
      { language: "EN", name: "Movie.srt", url: "https://evil.example/subtitle.srt" },
      { language: "EN", name: "Movie.srt", url: "/subtitle/123/file-en" }
    ] })
  });
  assert.deepEqual((await client.subtitles("movie", "tt1375666")).map((item) => item.url), [
    "https://dl.subdl.com/subtitle/123/file-en"
  ]);
});

test("SubDL reconhece BR_PT como português do Brasil e mantém PT genérico", async () => {
  const client = new SubdlClient({
    apiKey: "private-key",
    fetchJson: async () => ({ status: true, subtitles: [
      { language: "BR_PT", name: "Movie.srt", url: "/subtitle/1/file-br" },
      { lang: "brazillian portuguese", name: "Movie.srt", url: "/subtitle/1/file-br2" },
      { language: "PT", name: "Movie.srt", url: "/subtitle/1/file-pt" }
    ] })
  });
  assert.deepEqual((await client.subtitles("movie", "tt1375666")).map((item) => item.language), [
    "pt-BR", "pt-BR", "pt"
  ]);
});

test("SubDL mantém arquivo ASS do episódio exato para conversão no relay", async () => {
  const client = new SubdlClient({
    apiKey: "private-key",
    fetchJson: async () => ({ status: true, subtitles: [{
      language: "EN", season: 21, episode: 83,
      unpack_files: [{ language: "EN", season: 21, episode: 83,
        name: "One.Piece.E974.ass", format: "ass", url: "/subtitle/123/episode-ass" }]
    }] })
  });
  const found = await client.subtitles("series", "tt0388629:21:83");
  assert.equal(found.length, 1);
  assert.equal(found[0]?.url, "https://dl.subdl.com/subtitle/123/episode-ass");
});
