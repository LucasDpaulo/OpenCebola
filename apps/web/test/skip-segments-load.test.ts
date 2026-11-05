import assert from "node:assert/strict";
import test from "node:test";
import { loadSkipSegments } from "../app/player/pulos/load-skip-segments";
const opening = { kind: "intro", start: 10, end: 90, episodeLength: 1400 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("terceiro episódio recupera falha temporária sem reutilizar identificação anterior", async () => {
  for (let episode = 1; episode <= 3; episode++) {
    let calls = 0;
    const result = await loadSkipSegments(async () => {
      calls++;
      return episode === 3 && calls === 1 ? json({}, 503) : json({ segments: [{ ...opening, end: 90 + episode }] });
    }, new AbortController().signal, async () => {});
    assert.equal(result?.[0]?.end, 90 + episode);
    assert.equal(calls, episode === 3 ? 2 : 1);
  }
});

test("trocar episódio cancela as tentativas da identificação antiga", async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await loadSkipSegments(async () => { calls++; throw new Error("offline"); }, controller.signal,
    async () => { controller.abort(); });
  assert.equal(result, null);
  assert.equal(calls, 1);
});

test("resposta vazia válida não inventa tempos nem insiste no servidor", async () => {
  let calls = 0;
  const result = await loadSkipSegments(async () => { calls++; return json({ segments: [] }); }, new AbortController().signal);
  assert.deepEqual(result, []);
  assert.equal(calls, 1);
});
