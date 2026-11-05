import test from "node:test";
import assert from "node:assert/strict";
import { isRealDebridSource, sourcesForLocalEngine } from "../app/streaming/local-sources.js";
test("fluxo local conserva torrent original e remove variantes RD sem deduzir hash de URL", () => {
  const torrent = { kind: "torrent", url: null, infoHash: "a".repeat(40), fileIdx: 2, trackers: ["udp://tracker.example:80/a"], readyNow: true };
  const rd = { kind: "direct", url: "https://torrentio.strem.fun/realdebrid/token/video", label: "Filme" };
  const direct = { kind: "direct", url: "https://video.example/movie.mp4" };
  const result = sourcesForLocalEngine([rd, direct, torrent]);
  assert.deepEqual(result, [{ ...torrent, readyNow: null }, direct]);
  assert.equal(torrent.readyNow, true);
});
test("identifica RD por marcador e pelo cache Torrentio, sem bloquear torrent ou HTTP comum", () => {
  assert.equal(isRealDebridSource({ kind: "direct", url: "https://example/video", label: "1080p RD+" }), true);
  assert.equal(isRealDebridSource({ kind: "direct", url: "https://example/video", addonName: "Torrentio", readyNow: true }), true);
  assert.equal(isRealDebridSource({ kind: "torrent", url: null, label: "RD+" }), false);
  assert.equal(isRealDebridSource({ kind: "direct", url: "https://example/video", readyNow: true }), false);
});
