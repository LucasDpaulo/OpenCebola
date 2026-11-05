import assert from "node:assert/strict";
import test from "node:test";
import { SubtitleRelay, SubtitleRelayError } from "../src/stremio/subtitle-relay.js";

test("ticket de legenda é opaco e reutilizável sem reter o conteúdo na VM", async () => {
  let calls = 0;
  const relay = new SubtitleRelay({
    fetchText: async (url) => { calls += 1; assert.equal(url, "https://1.1.1.1/sub.srt"); return "legenda"; }
  });
  const ticket = relay.issue("https://1.1.1.1/sub.srt");
  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(ticket.includes("sub.srt"), false);
  assert.equal(await relay.open(ticket), "legenda");
  assert.equal(await relay.open(ticket), "legenda");
  assert.equal(calls, 2);
});

test("ticket expirado não abre a legenda", async () => {
  let now = 1_000;
  const relay = new SubtitleRelay({ now: () => now, ttlMs: 100, fetchText: async () => "legenda" });
  const ticket = relay.issue("https://1.1.1.1/sub.srt");
  now += 101;
  await assert.rejects(() => relay.open(ticket), SubtitleRelayError);
});
