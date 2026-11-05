import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { InMemoryAuthProvider } from "../src/auth/index.js";
import { HouseholdService, InMemoryHouseholdRepository } from "../src/households/index.js";
import {
  RealDebridClient,
  RealDebridMediaRelay,
  StremioAddonGateway,
  StremioApiClient,
  StremioService,
  type SaveStremioConnection,
  type StremioConnectionRepository
} from "../src/stremio/index.js";

const webOrigin = "http://localhost:3000";
const hash = "0123456789abcdef0123456789abcdef01234567";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("HTTP completo resolve, oculta link Real-Debrid e retransmite Range 206", async () => {
  const authProvider = new InMemoryAuthProvider({
    users: [{ id: "user-a", email: "lucas@example.com", password: "correct-secret" }],
    tokenFactory: () => "media-route-session"
  });
  const households = new HouseholdService({ repository: new InMemoryHouseholdRepository() });
  const emptyRepository: StremioConnectionRepository = {
    async save(_record: SaveStremioConnection) {},
    async find(householdId) {
      return {
        householdId,
        authKey: "stremio-auth-key",
        syncedAt: new Date("2026-08-19T00:00:00.000Z"),
        addons: [{
          manifest: {
            id: "com.stremio.torrentio.addon",
            version: "1.0.0",
            name: "Torrentio RD",
            resources: ["stream"],
            types: ["movie", "series"],
            catalogs: []
          },
          transportUrl: "https://torrentio.strem.fun/realdebrid=private-test-token/manifest.json"
        }]
      };
    },
    async status() { return { addonCount: 1, syncedAt: new Date("2026-08-19T00:00:00.000Z") }; },
    async delete() {}
  };
  const realDebrid = new RealDebridClient({
    token: "private-token-with-enough-characters",
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/torrents?limit=100")) return json([{ id: "torrent-1", hash }]);
      if (url.endsWith("/torrents/info/torrent-1")) {
        return json({
          id: "torrent-1",
          hash,
          status: "downloaded",
          progress: 100,
          links: ["https://1.1.1.1/restricted"]
        });
      }
      if (url.endsWith("/unrestrict/link")) {
        return json({ download: "https://1.0.0.1/private-arquivo-do-relay.mp4" });
      }
      throw new Error("unexpected Real-Debrid request");
    }
  });
  let relayRange: string | null = null;
  const mediaRelay = new RealDebridMediaRelay({
    fetch: async (input, init) => {
      assert.equal(String(input), "https://1.0.0.1/private-arquivo-do-relay.mp4");
      relayRange = new Headers(init?.headers).get("range");
      return new Response(new Uint8Array([10, 20]), {
        status: 206,
        headers: {
          "accept-ranges": "bytes",
          "content-length": "2",
          "content-range": "bytes 0-1/1000",
          "content-type": "video/mp4"
        }
      });
    }
  });
  const app = await buildApp({
    NODE_ENV: "test",
    CEBOLA_API_HOST: "127.0.0.1",
    CEBOLA_API_PORT: 3001,
    CEBOLA_WEB_ORIGIN: webOrigin,
    CEBOLA_SESSION_TTL_SECONDS: 3_600
  }, {
    authProvider,
    householdRepository: new InMemoryHouseholdRepository(),
    householdService: households,
    stremioService: new StremioService({ api: new StremioApiClient(), repository: emptyRepository }),
    stremioGateway: new StremioAddonGateway(),
    realDebrid,
    realDebridMediaRelay: mediaRelay
  });

  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: { origin: webOrigin },
    payload: { email: "lucas@example.com", password: "correct-secret" }
  });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;

  const targets = await app.inject({
    method: "GET",
    url: "/v1/stremio/browser-stream-targets/series/tt10986410%3A1%3A1",
    headers: { cookie }
  });
  assert.equal(targets.statusCode, 200);
  const targetBody = JSON.parse(targets.body) as { targets: { addonId: string; url: string }[] };
  assert.equal(targetBody.targets.length, 1);
  assert.match(targetBody.targets[0]?.url ?? "", /torrentio\.strem\.fun/);

  const imported = await app.inject({
    method: "POST",
    url: "/v1/stremio/browser-streams/import",
    headers: { origin: webOrigin, cookie },
    payload: {
      addonId: "com.stremio.torrentio.addon",
      payload: { streams: [{ url: "https://1.1.1.1/ted-lasso.mp4", name: "Torrentio RD\n1080p" }] }
    }
  });
  assert.equal(imported.statusCode, 200);
  const importedBody = JSON.parse(imported.body) as { streams: { url?: string }[] };
  assert.equal(importedBody.streams.length, 1);
  // Fonte importada pelo navegador sai intacta, sem ticket de relay: ela existe justamente
  // porque o IP do servidor é bloqueado pelo add-on, então retransmitir daqui não reproduz nada.
  assert.equal(importedBody.streams[0]?.url, "https://1.1.1.1/ted-lasso.mp4");

  const resolved = await app.inject({
    method: "POST",
    url: "/v1/stremio/streams/resolve",
    headers: { origin: webOrigin, cookie },
    payload: { infoHash: hash, fileIdx: 0 }
  });
  assert.equal(resolved.statusCode, 200);
  const resolvedBody = JSON.parse(resolved.body) as { status: string; url: string };
  assert.equal(resolvedBody.status, "ready");
  assert.match(resolvedBody.url, /^http:\/\/localhost:3000\/v1\/stremio\/streams\/media\/[A-Za-z0-9_-]{43}$/);
  assert.equal(resolved.body.includes("real-debrid"), false);
  assert.equal(resolved.body.includes("1.0.0.1"), false);

  const media = await app.inject({
    method: "GET",
    url: new URL(resolvedBody.url).pathname,
    headers: { cookie, range: "bytes=0-1" }
  });
  assert.equal(media.statusCode, 206);
  assert.equal(media.headers["content-range"], "bytes 0-1/1000");
  assert.equal(media.headers["content-type"], "video/mp4");
  assert.equal(relayRange, "bytes=0-1");
  assert.deepEqual(media.rawPayload, Buffer.from([10, 20]));
  await app.close();
});
