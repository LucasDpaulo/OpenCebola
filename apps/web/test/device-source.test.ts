import assert from "node:assert/strict";
import test from "node:test";
import { readDeviceSource, rememberDeviceSource, forgetDeviceSource } from "../app/player/device-source.js";
const key = { profileId: "alice", mediaType: "series", mediaId: "show", videoId: "episode-1" };
const stream = { kind: "direct", url: "http://127.0.0.1:9000/private-session", localSessionId: "private",
  id: "torrent-1", addonId: "addon", addonName: "Addon", label: "Episode 1080p", infoHash: "a".repeat(40), fileIdx: 1, quality: "1080p" };
function storage() {
  let value: string | null = null;
  return { getItem: () => value, setItem: (_key: string, data: string) => { value = data; } };
}
test("retoma descriptor estável sem persistir URL ou sessão temporária", () => {
  const store = storage(); rememberDeviceSource(key, stream, store);
  const saved = readDeviceSource(key, store);
  assert.equal(saved?.kind, "torrent"); assert.equal(saved?.url, null);
  assert.equal(saved?.infoHash, stream.infoHash); assert.equal(saved?.fileIdx, 1);
  assert.ok(!store.getItem()?.includes("private"));
});
test("fonte do celular não força TV, outro perfil ou outro episódio", () => {
  const phone = storage(), tv = storage(); rememberDeviceSource(key, stream, phone);
  assert.equal(readDeviceSource(key, tv), null);
  assert.equal(readDeviceSource({ ...key, profileId: "bob" }, phone), null);
  assert.equal(readDeviceSource({ ...key, videoId: "episode-2" }, phone), null);
  rememberDeviceSource(key, { ...stream, quality: "4K", infoHash: "b".repeat(40) }, tv);
  assert.equal(readDeviceSource(key, phone)?.quality, "1080p");
  assert.equal(readDeviceSource(key, tv)?.quality, "4K");
});
test("fonte recusada pode ser esquecida e fontes inválidas não são lembradas", () => {
  const store = storage(); rememberDeviceSource(key, stream, store);
  forgetDeviceSource(key, store); assert.equal(readDeviceSource(key, store), null);
  rememberDeviceSource(key, { ...stream, infoHash: "invalid" }, store);
  assert.equal(readDeviceSource(key, store), null);
});
test("cache limita quantidade e expira escolhas antigas", () => {
  const store = storage(); const now = Date.now();
  for (let i = 0; i < 80; i++) rememberDeviceSource({ ...key, videoId: String(i) }, stream, store, now);
  assert.equal(JSON.parse(store.getItem()!).length, 64);
  assert.equal(readDeviceSource({ ...key, videoId: "0" }, store, now), null);
  assert.equal(readDeviceSource({ ...key, videoId: "79" }, store, now + 31 * 86400000), null);
});
test("armazenamento corrompido ou bloqueado não impede reprodução", () => {
  assert.equal(readDeviceSource(key, { getItem: () => "{", setItem: () => {} }), null);
  const blocked = { getItem: () => { throw new Error(); }, setItem: () => { throw new Error(); } };
  assert.doesNotThrow(() => rememberDeviceSource(key, stream, blocked));
  assert.equal(readDeviceSource(key, blocked), null);
});
