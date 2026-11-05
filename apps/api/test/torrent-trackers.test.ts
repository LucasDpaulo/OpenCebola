import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTorrentTrackers, torrentTrackers } from "../src/stremio/torrent-trackers.js";

test("preserva trackers HTTP/UDP, deduplica e ignora fontes não tracker", () => {
  assert.deepEqual(normalizeTorrentTrackers([
    "tracker:udp://tracker.example.org:6969/announce",
    "tracker:https://tracker.example.org/announce",
    "tracker:https://tracker.example.org/announce", "dht:abcdef", null,
  ]), ["udp://tracker.example.org:6969/announce", "https://tracker.example.org/announce"]);
});

test("descarta protocolos, credenciais e destinos locais sem fazer chamadas DNS", () => {
  const unsafe = ["http://127.0.0.1/a", "http://2130706433/a", "http://10.0.0.1/a", "http://[::1]/a",
    "udp://127.1:80/a", "udp://tracker.local:80/a", "https://localhost./a", "http://host/a",
    "https://user:secret@tracker.example.org/a", "file:///a", "javascript:alert(1)",
    "udp://tracker.example.org/a", "https://tracker.example.org/a#fragment", "https://tracker.example.org/\na"];
  assert.deepEqual(normalizeTorrentTrackers(unsafe.map(value => `tracker:${value}`)), []);
});

test("limita quantidade e tamanho dos trackers", () => {
  assert.equal(normalizeTorrentTrackers(Array.from({ length: 200 }, (_, i) => `tracker:https://tracker${i}.example.org/a`)).length, 32);
  assert.deepEqual(normalizeTorrentTrackers([`tracker:https://tracker.example.org/${"x".repeat(2048)}`]), []);
});

test("fonte sem tracker do add-on recebe a lista pública; com tracker, fica só com os dela", () => {
  const publicos = torrentTrackers(undefined);
  assert.ok(publicos.length >= 5 && publicos.every((url) => /^udp:\/\/[a-z0-9.-]+:\d+\/announce$/.test(url)));
  assert.deepEqual(torrentTrackers(["dht:abcdef"]), publicos);
  assert.deepEqual(normalizeTorrentTrackers(publicos.map((url) => `tracker:${url}`)), publicos);
  assert.deepEqual(torrentTrackers(["tracker:udp://tracker.example.org:6969/announce"]), ["udp://tracker.example.org:6969/announce"]);
});
