import assert from "node:assert/strict";
import test from "node:test";
import { createSubtitleTextCache } from "../app/player/subtitle-text-cache";

test("sincronia e pulos compartilham a mesma leitura da legenda", async () => {
  let reads = 0;
  const read = createSubtitleTextCache(async () => { reads++; return "WEBVTT"; });
  const [a, b] = await Promise.all([read("a"), read("a")]);
  assert.equal(a, b);
  assert.equal(await read("a"), "WEBVTT");
  assert.equal(reads, 1);
});

test("falhas não ficam no cache e URLs de episódios diferentes não se misturam", async () => {
  let reads = 0;
  const read = createSubtitleTextCache(async (url) => ++reads === 1 ? null : url);
  assert.equal(await read("ep1"), null);
  assert.equal(await read("ep1"), "ep1");
  assert.equal(await read("ep2"), "ep2");
});
