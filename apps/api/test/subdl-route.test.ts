import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { InMemoryAuthProvider } from "../src/auth/index.js";
import { HouseholdService, InMemoryHouseholdRepository } from "../src/households/index.js";
import {
  StremioAddonGateway, StremioApiClient, StremioService, SubtitleRelay, SubdlClient,
  type SaveStremioConnection, type StremioConnectionRepository
} from "../src/stremio/index.js";

test("rota de legendas inclui SubDL e entrega ticket sem chave privada", async () => {
  let addonsUnavailable = false;
  const requestedSubtitleUrls: string[] = [];
  const repository: StremioConnectionRepository = {
    async save(_record: SaveStremioConnection) {},
    async find(householdId) {
      if (addonsUnavailable) throw new Error("addons indisponíveis");
      return { householdId, authKey: "stremio-token", syncedAt: new Date(), addons: [] };
    },
    async status() { return { addonCount: 0, syncedAt: new Date() }; },
    async delete() {}
  };
  const app = await buildApp({
    NODE_ENV: "test", CEBOLA_API_HOST: "127.0.0.1", CEBOLA_API_PORT: 3001,
    CEBOLA_WEB_ORIGIN: "http://localhost:3000", CEBOLA_SESSION_TTL_SECONDS: 3600
  }, {
    authProvider: new InMemoryAuthProvider({
      users: [{ id: "user-a", email: "lucas@example.com", password: "correct-secret" }],
      tokenFactory: () => "subdl-route-session"
    }),
    householdRepository: new InMemoryHouseholdRepository(),
    householdService: new HouseholdService({ repository: new InMemoryHouseholdRepository() }),
    stremioService: new StremioService({ api: new StremioApiClient(), repository }),
    stremioGateway: new StremioAddonGateway({ fetchJson: async (url) => {
      requestedSubtitleUrls.push(url);
      return { subtitles: url.includes("tt0388629%3A21%3A153") ? [{
        id: "one-piece-1044-first", lang: "pob", url: "https://subs5.strem.io/subtitle/1044-first.srt"
      }, {
        id: "one-piece-1044-second", lang: "pob", url: "https://subs5.strem.io/subtitle/1044-second.srt"
      }] : url.includes("tt0388629%3A1%3A1044") ? [{
        id: "one-piece-1044-second", lang: "pob", url: "https://subs5.strem.io/subtitle/1044-second.srt"
      }, {
        id: "one-piece-1044-third", lang: "pob", url: "https://subs5.strem.io/subtitle/1044-third.srt"
      }] : url.includes("tt0388629%3A1%3A1045") ? [{
        id: "one-piece-1045-ja", lang: "jpn", url: "https://subs5.strem.io/subtitle/1045.srt"
      }] : [] };
    } }),
    subdl: new SubdlClient({ apiKey: "private-key", fetchJson: async (url) => ({ status: true, subtitles:
      new URL(url).searchParams.get("episode_number") === "1" ? [{
        language: "PT", name: "Anime.E01.srt", url: "/subtitle/123/file-1?api_key=private-key",
        season: 1, episode: 1
      }] : [] }) }),
    subtitleRelay: new SubtitleRelay({ fetchText: async () => "1\n00:00:01,000 --> 00:00:02,000\nOlá\n" })
  });
  try {
    const login = await app.inject({ method: "POST", url: "/v1/auth/login", headers: { origin: "http://localhost:3000" },
      payload: { email: "lucas@example.com", password: "correct-secret" } });
    assert.equal(login.statusCode, 200);
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
    const response = await app.inject({ method: "GET", url: "/v1/stremio/subtitles/series/tt0388629%3A1%3A1", headers: { cookie } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.includes("private-key"), false);
    const body = JSON.parse(response.body) as { subtitles: { addonName: string; url: string }[] };
    assert.equal(body.subtitles[0]?.addonName, "SubDL");
    assert.equal(requestedSubtitleUrls.length, 0, "legenda PT existente dispensa consulta extra ao OpenSubtitles");
    assert.match(body.subtitles[0]?.url ?? "", /^\/v1\/stremio\/subtitles\/file\//);
    const file = await app.inject({ method: "GET", url: body.subtitles[0]!.url, headers: { cookie } });
    assert.equal(file.statusCode, 200);
    assert.match(file.body, /WEBVTT[\s\S]*Olá/);
    addonsUnavailable = true;
    const fallback = await app.inject({ method: "GET", url: "/v1/stremio/subtitles/series/tt0388629%3A1%3A1", headers: { cookie } });
    assert.equal(fallback.statusCode, 200);
    assert.equal((JSON.parse(fallback.body) as { subtitles: unknown[] }).subtitles.length, 1);
    const episode = await app.inject({ method: "GET", url: "/v1/stremio/subtitles/series/tt0388629%3A21%3A153", headers: { cookie } });
    assert.equal(episode.statusCode, 200);
    assert.ok((JSON.parse(episode.body) as { subtitles: { language: string }[] }).subtitles.some(
      (subtitle) => subtitle.language === "pob"));
    assert.deepEqual((JSON.parse(episode.body) as { subtitles: { label: string }[] }).subtitles.map(
      (subtitle) => subtitle.label), ["Português (Brasil)", "Português (Brasil) 2", "Português (Brasil) 3"]);
    assert.ok(requestedSubtitleUrls.some((url) => url.includes("tt0388629%3A1%3A1044")));
    const nextEpisode = await app.inject({ method: "GET", url: "/v1/stremio/subtitles/series/tt0388629%3A21%3A154", headers: { cookie } });
    assert.equal(nextEpisode.statusCode, 200);
    assert.ok((JSON.parse(nextEpisode.body) as { subtitles: { language: string; label: string }[] }).subtitles.some(
      (subtitle) => subtitle.language === "jpn" && subtitle.label === "Japonês"));
    const movie = await app.inject({ method: "GET", url: "/v1/stremio/subtitles/movie/tt1375666", headers: { cookie } });
    assert.equal(movie.statusCode, 200);
    assert.ok(requestedSubtitleUrls.some((url) => url.startsWith("https://opensubtitles-v3.strem.io/subtitles/movie/tt1375666")));
  } finally {
    await app.close();
  }
});
