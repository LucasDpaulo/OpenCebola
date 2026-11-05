import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { InMemoryAuthProvider } from "../src/auth/index.js";
import { HouseholdService, InMemoryHouseholdRepository } from "../src/households/index.js";
import {
  RealDebridClient,
  RealDebridMediaRelay,
  StremioAddonGateway, StremioApiClient, StremioService, SubdlClient,
  type SaveStremioConnection, type StremioConnectionRepository
} from "../src/stremio/index.js";

const webOrigin = "http://localhost:3000";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

test("query videoHash/videoSize/filename chega às fontes e força consulta ao OpenSubtitles mesmo com PT já achado", async () => {
  const requestedUrls: string[] = [];
  const requestedSubdlFileNames: (string | null)[] = [];
  const repository: StremioConnectionRepository = {
    async save(_record: SaveStremioConnection) {},
    async find(householdId) {
      return {
        householdId, authKey: "stremio-token", syncedAt: new Date(),
        addons: [{
          manifest: {
            id: "org.example.legendas", version: "1.0.0", name: "Legendas de teste",
            resources: ["subtitles"], types: ["movie", "series"], idPrefixes: ["tt"], catalogs: []
          },
          transportUrl: "https://legendas.example/manifest.json"
        }]
      };
    },
    async status() { return { addonCount: 1, syncedAt: new Date() }; },
    async delete() {}
  };
  const app = await buildApp({
    NODE_ENV: "test", CEBOLA_API_HOST: "127.0.0.1", CEBOLA_API_PORT: 3001,
    CEBOLA_WEB_ORIGIN: webOrigin, CEBOLA_SESSION_TTL_SECONDS: 3600
  }, {
    authProvider: new InMemoryAuthProvider({
      users: [{ id: "user-a", email: "lucas@example.com", password: "correct-secret" }],
      tokenFactory: () => "hints-route-session"
    }),
    householdRepository: new InMemoryHouseholdRepository(),
    householdService: new HouseholdService({ repository: new InMemoryHouseholdRepository() }),
    stremioService: new StremioService({ api: new StremioApiClient(), repository }),
    stremioGateway: new StremioAddonGateway({ fetchJson: async (url) => {
      requestedUrls.push(url);
      // A fonte da casa já traz português: sem o hint de arquivo, o código antigo dispensaria o
      // OpenSubtitles por causa disso.
      return { subtitles: [{ id: "1", lang: "pob", url: "https://1.1.1.1/existente.srt" }] };
    } }),
    subdl: new SubdlClient({ apiKey: "private-key", fetchJson: async (url) => {
      requestedSubdlFileNames.push(new URL(url).searchParams.get("file_name"));
      return { status: true, subtitles: [] };
    } })
  });
  try {
    const login = await app.inject({
      method: "POST", url: "/v1/auth/login", headers: { origin: webOrigin },
      payload: { email: "lucas@example.com", password: "correct-secret" }
    });
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
    const response = await app.inject({
      method: "GET",
      url: "/v1/stremio/subtitles/movie/tt1375666" +
        "?videoHash=abcdef0123456789&videoSize=123456&filename=Filme.2024.1080p-Grupo.mkv",
      headers: { cookie }
    });
    assert.equal(response.statusCode, 200);
    // A fonte da casa recebeu o extra no CAMINHO (protocolo do Stremio).
    assert.ok(requestedUrls.some((url) =>
      url.includes("/videoHash=abcdef0123456789&videoSize=123456&filename=Filme.2024.1080p-Grupo.mkv.json")));
    // O OpenSubtitles foi consultado mesmo já havendo PT — só ele casa por hash de arquivo.
    assert.ok(requestedUrls.some((url) => url.startsWith("https://opensubtitles-v3.strem.io/")));
    // A SubDL recebeu o nome do arquivo para procurar a legenda do MESMO release.
    assert.ok(requestedSubdlFileNames.includes("Filme.2024.1080p-Grupo.mkv"));
  } finally {
    await app.close();
  }
});

test("resolve devolve file.name/size/hash quando um hasher é configurado, sem incluir a URL", async () => {
  const authProvider = new InMemoryAuthProvider({
    users: [{ id: "user-a", email: "lucas@example.com", password: "correct-secret" }],
    tokenFactory: () => "resolve-hash-session"
  });
  const households = new HouseholdService({ repository: new InMemoryHouseholdRepository() });
  const hashValue = "1".repeat(40);
  const repository: StremioConnectionRepository = {
    async save(_record: SaveStremioConnection) {},
    async find(householdId) {
      return {
        householdId, authKey: "stremio-token", syncedAt: new Date(),
        addons: [{
          manifest: {
            id: "com.stremio.torrentio.addon", version: "1.0.0", name: "Torrentio RD",
            resources: ["stream"], types: ["movie", "series"], catalogs: []
          },
          transportUrl: "https://torrentio.strem.fun/realdebrid=private-test-token/manifest.json"
        }]
      };
    },
    async status() { return { addonCount: 1, syncedAt: new Date() }; },
    async delete() {}
  };
  const realDebrid = new RealDebridClient({
    token: "private-token-with-enough-characters",
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/torrents?limit=100")) return json([{ id: "torrent-1", hash: hashValue }]);
      if (url.endsWith("/torrents/info/torrent-1")) {
        return json({
          id: "torrent-1", hash: hashValue, status: "downloaded", progress: 100,
          links: ["https://1.1.1.1/restricted"]
        });
      }
      if (url.endsWith("/unrestrict/link")) {
        return json({ download: "https://1.0.0.1/Filme.2024.1080p-Grupo.mkv" });
      }
      throw new Error("unexpected Real-Debrid request");
    }
  });
  const app = await buildApp({
    NODE_ENV: "test", CEBOLA_API_HOST: "127.0.0.1", CEBOLA_API_PORT: 3001,
    CEBOLA_WEB_ORIGIN: webOrigin, CEBOLA_SESSION_TTL_SECONDS: 3600
  }, {
    authProvider,
    householdRepository: new InMemoryHouseholdRepository(),
    householdService: households,
    stremioService: new StremioService({ api: new StremioApiClient(), repository }),
    stremioGateway: new StremioAddonGateway(),
    realDebrid,
    realDebridMediaRelay: new RealDebridMediaRelay({
      fetch: async () => { throw new Error("mediaRelay não deveria ser buscado neste teste"); }
    }),
    // Dublê determinístico: nenhuma chamada de rede real, só prova que o campo chega à resposta.
    fileHash: async (url) => {
      assert.equal(url, "https://1.0.0.1/Filme.2024.1080p-Grupo.mkv");
      return { hash: "abcdef0123456789", size: 999 };
    }
  });
  try {
    const login = await app.inject({
      method: "POST", url: "/v1/auth/login", headers: { origin: webOrigin },
      payload: { email: "lucas@example.com", password: "correct-secret" }
    });
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
    const resolved = await app.inject({
      method: "POST", url: "/v1/stremio/streams/resolve",
      headers: { origin: webOrigin, cookie },
      payload: { infoHash: hashValue, fileIdx: 0 }
    });
    assert.equal(resolved.statusCode, 200);
    const body = JSON.parse(resolved.body) as {
      status: string; file?: { name?: string; size?: number; hash?: string };
    };
    assert.equal(body.status, "ready");
    assert.deepEqual(body.file, { name: "Filme.2024.1080p-Grupo.mkv", size: 999, hash: "abcdef0123456789" });
    // A URL do Real-Debrid nunca aparece na resposta, nem escondida dentro de `file`.
    assert.equal(resolved.body.includes("1.0.0.1"), false);
  } finally {
    await app.close();
  }
});
