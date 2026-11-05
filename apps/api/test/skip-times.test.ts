import assert from "node:assert/strict";
import test from "node:test";
import { SkipTimesClient } from "../src/stremio/skip-times.js";

function aniSkipBody(results: readonly Record<string, unknown>[]) {
  return { found: results.length > 0, results };
}

test("resolve por temporada (ex.: anime com um MAL por temporada) e consulta o episódio relativo", async () => {
  const requested: string[] = [];
  const client = new SkipTimesClient({
    fetchJson: async (url) => {
      requested.push(url);
      if (url.includes("arm.haglund.dev")) {
        return [
          { myanimelist: 111, "thetvdb-season": 1, "themoviedb-season": 1 },
          { myanimelist: 222, "thetvdb-season": 2, "themoviedb-season": 2 }
        ];
      }
      return aniSkipBody([
        { skipType: "op", interval: { startTime: 3, endTime: 93 }, episodeLength: 1430 },
        { skipType: "ed", interval: { startTime: 1300, endTime: 1400 }, episodeLength: 1430 }
      ]);
    }
  });
  const segments = await client.skipTimes("series", "tt5626028:2:5");
  assert.deepEqual(segments, [
    { kind: "intro", start: 3, end: 93, episodeLength: 1430 },
    { kind: "outro", start: 1300, end: 1400, episodeLength: 1430 }
  ]);
  assert.ok(requested[0]?.includes("arm.haglund.dev/api/v2/imdb?id=tt5626028"));
  assert.ok(requested[1]?.includes("api.aniskip.com/v2/skip-times/222/5"));
});

test("numeração absoluta (ex.: One Piece): usa o parâmetro absolute quando a única entrada não tem temporada", async () => {
  const requested: string[] = [];
  const client = new SkipTimesClient({
    fetchJson: async (url) => {
      requested.push(url);
      if (url.includes("arm.haglund.dev")) {
        return [{ myanimelist: 21, "thetvdb-season": null, "themoviedb-season": null }];
      }
      return aniSkipBody([{ skipType: "op", interval: { startTime: 3.08, endTime: 93.08 }, episodeLength: 1430.7 }]);
    }
  });
  const withAbsolute = await client.skipTimes("series", "tt0388629:21:1043", 1043);
  assert.deepEqual(withAbsolute, [{ kind: "intro", start: 3.08, end: 93.08, episodeLength: 1430.7 }]);
  assert.ok(requested.some((url) => url.includes("api.aniskip.com/v2/skip-times/21/1043")));

  const withoutAbsolute = await client.skipTimes("series", "tt1234567:22:1044");
  assert.deepEqual(withoutAbsolute, []);
});

test("sem mapeamento reconhecível devolve lista vazia sem consultar o AniSkip", async () => {
  let aniSkipCalled = false;
  const client = new SkipTimesClient({
    fetchJson: async (url) => {
      if (url.includes("aniskip.com")) aniSkipCalled = true;
      if (url.includes("arm.haglund.dev")) {
        return [
          { myanimelist: 111, "thetvdb-season": 1, "themoviedb-season": 1 },
          { myanimelist: 222, "thetvdb-season": 2, "themoviedb-season": 2 }
        ];
      }
      return aniSkipBody([]);
    }
  });
  assert.deepEqual(await client.skipTimes("series", "tt5626028:9:1"), []);
  assert.equal(aniSkipCalled, false);
});

test("filme nunca consulta as fontes externas", async () => {
  let calls = 0;
  const client = new SkipTimesClient({ fetchJson: async () => { calls += 1; return []; } });
  assert.deepEqual(await client.skipTimes("movie", "tt1375666"), []);
  assert.equal(calls, 0);
});

test("mapeamento e segmentos ficam em cache: a segunda consulta não repete as chamadas externas", async () => {
  let armCalls = 0;
  let aniSkipCalls = 0;
  const client = new SkipTimesClient({
    fetchJson: async (url) => {
      if (url.includes("arm.haglund.dev")) {
        armCalls += 1;
        return [{ myanimelist: 21, "thetvdb-season": null, "themoviedb-season": null }];
      }
      aniSkipCalls += 1;
      return aniSkipBody([{ skipType: "recap", interval: { startTime: 0, endTime: 60 }, episodeLength: 1400 }]);
    }
  });
  await client.skipTimes("series", "tt0388629:21:1043", 1043);
  await client.skipTimes("series", "tt0388629:21:1043", 1043);
  assert.equal(armCalls, 1);
  assert.equal(aniSkipCalls, 1);
});

test("falha externa (ARM ou AniSkip fora do ar) nunca lança: devolve lista vazia", async () => {
  const armDown = new SkipTimesClient({
    fetchJson: async () => { throw new Error("upstream indisponível"); }
  });
  assert.deepEqual(await client_result(armDown, "tt0388629:21:1043", 1043), []);

  const aniSkipDown = new SkipTimesClient({
    fetchJson: async (url) => {
      if (url.includes("arm.haglund.dev")) return [{ myanimelist: 21, "thetvdb-season": null, "themoviedb-season": null }];
      throw new Error("upstream indisponível");
    }
  });
  assert.deepEqual(await client_result(aniSkipDown, "tt0388629:21:1043", 1043), []);

  async function client_result(client: SkipTimesClient, videoId: string, absolute: number) {
    return client.skipTimes("series", videoId, absolute);
  }
});

test("descarta segmentos inválidos e não converte mixed-op/mixed-ed em trechos para pulo automático", async () => {
  const client = new SkipTimesClient({
    fetchJson: async (url) => {
      if (url.includes("arm.haglund.dev")) {
        return [{ myanimelist: 21, "thetvdb-season": null, "themoviedb-season": null }];
      }
      return aniSkipBody([
        { skipType: "mixed-op", interval: { startTime: 0, endTime: 90 }, episodeLength: 1400 },
        { skipType: "mixed-ed", interval: { startTime: 1300, endTime: 1400 }, episodeLength: 1400 },
        { skipType: "op", interval: { startTime: 10, endTime: 100 }, episodeLength: 1400 },
        { skipType: "op", interval: { startTime: 100, endTime: 50 }, episodeLength: 1400 },
        { skipType: "op", interval: { startTime: -1, endTime: 30 }, episodeLength: 1400 },
        { skipType: "unknown", interval: { startTime: 0, endTime: 10 }, episodeLength: 1400 }
      ]);
    }
  });
  const segments = await client.skipTimes("series", "tt0388629:21:1043", 1043);
  assert.deepEqual(segments, [
    { kind: "intro", start: 10, end: 100, episodeLength: 1400 }
  ]);
});

test("One Piece: clientes sem absolute consultam o mesmo episódio nos catálogos relativo e absoluto", async () => {
  for (const id of ["tt0388629:21:191", "tt0388629:21:1082", "tmdb:37854:21:191", "tmdb:37854:21:1082"]) {
    const requests: string[] = [];
    const client = new SkipTimesClient({ fetchJson: async (url) => {
      requests.push(url);
      if (url.includes("arm.haglund.dev")) return [{ myanimelist: 21, "thetvdb-season": null, "themoviedb-season": null }];
      return aniSkipBody([{ skipType: "op", interval: { startTime: 10, endTime: 131 }, episodeLength: 1430 }]);
    }});
    assert.equal((await client.skipTimes("series", id)).length, 1);
    assert.ok(requests.some((url) => url.includes("/skip-times/21/1082?")), id);
  }
});
